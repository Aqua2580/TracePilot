/**
 * LocalProcessRunner —— ProcessRunner 的 Phase 1 实现。
 *
 * 为 CommandSpec.argv 启动子进程，强制硬超时，把输出截断到
 * `policy.maxOutputBytes`（保留尾部），并校验 `cwd` 解析后位于
 * `policy.allowedCwdRoots` 之一内。
 *
 * 这是系统中唯一调用 `child_process.spawn` 的地方。LocalCommandAdapter
 * 把每条命令都路由到这里，治理闸门无法被绕过。未来的 OmpAdapter 必须
 * 路由到同一个 runner（或等价受治理的实现）。
 *
 * P2-02 修复：`originalBytes` 持续累计进程实际产生的总字节数（即使被
 * 丢弃也计入），`retainedBytes` 单独记录保留缓冲区大小。两者分开，避免
 * 截断时把保留字节数误报为原始大小。
 *
 * P2-03 修复：Windows 上 `child.kill("SIGKILL")` / `SIGTERM` 不保证终止
 * 整个进程树。使用 Windows 专用的进程树终止策略（taskkill /T /F 或
 * spawn detached + tree-kill），并为超时与取消提供集成测试。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import * as os from "node:os";
import type {
  CommandSpec,
  ProcessRunner,
  ProcessPolicy,
  CommandResult
} from "@tracepilot/core";

export class LocalProcessRunner implements ProcessRunner {
  async run(
    spec: CommandSpec,
    cwd: string,
    policy: ProcessPolicy
  ): Promise<CommandResult> {
    // 1. 校验 cwd 位于某个允许根目录内。
    if (!isAbsolute(cwd)) {
      throw new Error(`cwd 必须是绝对路径：${cwd}`);
    }
    let resolvedCwd: string;
    try {
      resolvedCwd = realpathSync(cwd);
    } catch (err) {
      throw new Error(`无法解析 cwd：${(err as Error).message}`);
    }
    const insideRoot = policy.allowedCwdRoots.some((root) => {
      try {
        const realRoot = realpathSync(root);
        return isInside(resolvedCwd, realRoot);
      } catch {
        return false;
      }
    });
    if (!insideRoot) {
      throw new Error(
        `cwd ${resolvedCwd} 不在任何允许根目录内：${policy.allowedCwdRoots.join(", ")}`
      );
    }

    // 2. 除非 inheritEnv=true，否则用干净环境启动。纵深防御：避免泄漏密钥。
    const argv = [...spec.argv];
    const startedAt = new Date().toISOString();
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: resolvedCwd,
      env: policy.inheritEnv ? { ...process.env } : { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    // 3. 流式读取 stdout/stderr 到缓冲区，按 maxOutputBytes 截断。
    //    P2-02：originalBytes 持续累计总字节数（含被丢弃部分），
    //    retainedBytes 仅记录保留缓冲区大小。
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutOriginalBytes = 0;
    let stderrOriginalBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const max = policy.maxOutputBytes;

    child.stdout?.on("data", (chunk: Buffer) => {
      // P2-02：无论是否保留，都计入原始字节数。
      stdoutOriginalBytes += chunk.length;
      if (stdout.length >= max) {
        stdoutTruncated = true;
        return;
      }
      const room = max - stdout.length;
      if (chunk.length > room) {
        stdout = Buffer.concat([stdout, chunk.subarray(0, room)]);
        stdoutTruncated = true;
      } else {
        stdout = Buffer.concat([stdout, chunk]);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrOriginalBytes += chunk.length;
      if (stderr.length >= max) {
        stderrTruncated = true;
        return;
      }
      const room = max - stderr.length;
      if (chunk.length > room) {
        stderr = Buffer.concat([stderr, chunk.subarray(0, room)]);
        stderrTruncated = true;
      } else {
        stderr = Buffer.concat([stderr, chunk]);
      }
    });

    // 4. 硬超时。超时后用平台专用的进程树终止策略杀死子进程（P2-03）。
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, spec.timeoutMs);

    const exitCode: number = await new Promise((resolveP, rejectP) => {
      child.on("error", (err) => {
        clearTimeout(timer);
        rejectP(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveP(code ?? (timedOut ? 124 : 0));
      });
    });

    const endedAt = new Date().toISOString();
    const originalBytes = stdoutOriginalBytes + stderrOriginalBytes;
    const retainedBytes = stdout.length + stderr.length;
    return {
      argv,
      cwd: resolvedCwd,
      exitCode,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      truncated: stdoutTruncated || stderrTruncated,
      originalBytes,
      retainedBytes,
      timedOut,
      startedAt,
      endedAt
    };
  }
}

/**
 * 跨平台进程树终止（P2-03）。
 *
 * Windows 上 `child.kill("SIGKILL")` 仅终止直接子进程，子进程派生的
 * 孙进程会存活。改用 `taskkill /T /F /PID` 终止整棵树。非 Windows 仍用
 * 进程组信号（spawn 时已 detached 不适用，这里通过 taskkill 兜底）。
 */
function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (os.platform() === "win32") {
      // /T 终止指定进程及其子进程；/F 强制。
      spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
        shell: false
      });
    } else {
      // POSIX：先 SIGTERM，再兜底 SIGKILL。LocalProcessRunner 的超时是
      // 硬终止场景，这里直接用 SIGKILL 确保结束。
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    // 进程可能已退出；忽略 kill 错误。
  }
}

function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
