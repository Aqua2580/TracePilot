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
  CommandResult,
  ProcessTerminationResult
} from "@tracepilot/core";

export class LocalProcessRunner implements ProcessRunner {
  async run(
    spec: CommandSpec,
    cwd: string,
    policy: ProcessPolicy,
    abortSignal?: AbortSignal
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
    //    P4：当 inheritEnv=false 但 allowedEnvVarNames 提供时，仅透传白名单
    //    变量（用于 OmpAdapter 把 ANTHROPIC_API_KEY 等 LLM 凭据传给 omp 子进程，
    //    不泄漏其他敏感变量）。白名单只声明名称，值从 process.env 读取。
    const argv = [...spec.argv];
    const startedAt = new Date().toISOString();
    const childEnv = buildChildEnv(policy);
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: resolvedCwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    // 3. 流式读取 stdout/stderr 到缓冲区，按 maxOutputBytes 截断并保留尾部。
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
      stdoutTruncated = stdoutTruncated || stdoutOriginalBytes > max;
      stdout = retainOutputTail(stdout, chunk, max);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrOriginalBytes += chunk.length;
      stderrTruncated = stderrTruncated || stderrOriginalBytes > max;
      stderr = retainOutputTail(stderr, chunk, max);
    });

    let terminationPromise: Promise<ProcessTerminationResult> | undefined;
    function requestTermination(): void {
      if (!terminationPromise) {
        terminationPromise = killProcessTree(child);
      }
    }

    // 4. 硬超时。超时后用平台专用的进程树终止策略杀死子进程（P2-03）。
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, spec.timeoutMs);

    // P1-05：取消信号。当 abortSignal 被 abort 时，终止整个进程树。
    // 与超时不同，取消是调用方主动发起（如 OmpAdapter.cancel），
    // 返回结果中 timedOut=false 但 exitCode 非 0。
    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      requestTermination();
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        // 已取消：在 spawn 后立即终止
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const exitCode: number = await new Promise((resolveP, rejectP) => {
      child.on("error", (err) => {
        clearTimeout(timer);
        if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
        rejectP(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
        resolveP(code ?? (timedOut ? 124 : aborted ? 130 : 0));
      });
    });

    // 终止命令自身也必须结束后才返回，避免调用方在 taskkill 仍未完成时
    // 把取消请求误认为已经完成。
    const termination = terminationPromise ? await terminationPromise : undefined;

    // 截断可能从一行 NDJSON 或 UTF-8 字符中间开始。丢弃保留尾部的首个
    // 不完整行，保证后续事件解析不会把半行误判为完整事件。此操作只在已
    // 截断时执行，仍保持严格的 maxOutputBytes 上限。
    if (stdoutTruncated) stdout = discardLeadingPartialLine(stdout);
    if (stderrTruncated) stderr = discardLeadingPartialLine(stderr);

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
      ...(termination ? { termination } : {}),
      startedAt,
      endedAt
    };
  }
}

/**
 * 把新输出追加到受限缓冲区，并保留最后 maxBytes 字节。
 *
 * Omp 的最终 assistant message 位于 JSON 事件流尾部；保留尾部既符合
 * ProcessRunner 的文档承诺，也避免大段 thinking/tool 事件挤掉最终结果。
 */
function retainOutputTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  const merged = current.length === 0 ? chunk : Buffer.concat([current, chunk]);
  return merged.length > maxBytes ? merged.subarray(merged.length - maxBytes) : merged;
}

/**
 * 截断尾部的开头不一定正好落在换行边界；删除第一个换行前的残片，防止
 * NDJSON 解析器把不完整 JSON 当作坏事件。若没有完整行，返回空缓冲区。
 */
function discardLeadingPartialLine(buffer: Buffer): Buffer {
  const newlineIndex = buffer.indexOf(0x0a);
  return newlineIndex === -1 ? Buffer.alloc(0) : buffer.subarray(newlineIndex + 1);
}

/**
 * 跨平台进程树终止（P2-03）。
 *
 * Windows 上 `child.kill("SIGKILL")` 仅终止直接子进程，子进程派生的
 * 孙进程会存活。改用 `taskkill /T /F /PID` 终止整棵树。非 Windows 仍用
 * 进程组信号（spawn 时已 detached 不适用，这里通过 taskkill 兜底）。
 */
async function killProcessTree(child: ChildProcess): Promise<ProcessTerminationResult> {
  if (!child.pid) {
    return { requested: false, method: "child", completed: false, failure: "spawn_error" };
  }
  if (os.platform() === "win32") {
    // /T 终止指定进程及其子进程；/F 强制。等待 taskkill 的 close/error，
    // 并在失败时记录固定类别后尝试直接终止主进程，避免取消请求悬挂。
    const taskkillResult = await runTaskkill(child.pid);
    if (taskkillResult.completed) return taskkillResult;
    let fallbackAttempted = false;
    try {
      fallbackAttempted = child.kill("SIGKILL");
    } catch {
      fallbackAttempted = false;
    }
    return { ...taskkillResult, fallbackAttempted };
  }

  // POSIX：优先终止进程组；失败时兜底终止主进程，并把结果返回给调用方。
  try {
    process.kill(-child.pid, "SIGKILL");
    return { requested: true, method: "process_group", completed: true };
  } catch {
    try {
      const completed = child.kill("SIGKILL");
      return {
        requested: true,
        method: "child",
        completed,
        ...(completed ? {} : { failure: "spawn_error" as const })
      };
    } catch {
      return { requested: true, method: "child", completed: false, failure: "spawn_error" };
    }
  }
}

const TASKKILL_TIMEOUT_MS = 5000;

function runTaskkill(pid: number): Promise<ProcessTerminationResult> {
  return new Promise((resolveP) => {
    let settled = false;
    const timerState: { handle?: NodeJS.Timeout } = {};
    const finish = (result: ProcessTerminationResult): void => {
      if (settled) return;
      settled = true;
      if (timerState.handle) clearTimeout(timerState.handle);
      resolveP(result);
    };

    let killer: ChildProcess;
    try {
      killer = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
        shell: false
      });
    } catch {
      finish({ requested: true, method: "taskkill", completed: false, failure: "spawn_error" });
      return;
    }

    killer.once("error", () => {
      finish({ requested: true, method: "taskkill", completed: false, failure: "spawn_error" });
    });
    killer.once("close", (code) => {
      if (code === 0) {
        finish({ requested: true, method: "taskkill", completed: true, exitCode: 0 });
      } else {
        finish({
          requested: true,
          method: "taskkill",
          completed: false,
          ...(code !== null ? { exitCode: code } : {}),
          failure: "nonzero_exit"
        });
      }
    });
    timerState.handle = setTimeout(() => {
      try {
        killer.kill("SIGKILL");
      } catch {
        // taskkill 自身可能已退出；固定记录 timeout 即可。
      }
      finish({ requested: true, method: "taskkill", completed: false, failure: "timeout" });
    }, TASKKILL_TIMEOUT_MS);
  });
}

function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 构造子进程环境变量（P4：白名单透传；P1-02：凭据防护）。
 *
 * - `inheritEnv=true`：全量透传 `process.env`（向后兼容 Phase 1-3 行为，
 *   仅用于不含凭据的场景）。
 * - `inheritEnv=false` + `allowedEnvVarNames`：仅透传白名单变量 + `PATH`。
 *   用于 OmpAdapter 把 LLM 凭据（如 `ANTHROPIC_API_KEY`）传给 omp 子进程，
 *   不泄漏其他敏感变量。白名单变量不存在时静默跳过。
 * - `inheritEnv=false` 且无白名单：仅 `PATH`（Phase 1-3 默认行为）。
 *
 * P1-02 纵深防御：当 `disallowCredentialVars=true` 时，即使白名单含凭据
 * 变量名（匹配 `API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PRIVATE_KEY`
 * 模式）也拒绝透传。用于验证命令场景（pnpm test / pytest 等）：Developer
 * 可修改 worktree 中的测试脚本，若验证子进程能读到 LLM API key，恶意测试
 * 可外传凭据。
 *
 * omp 子进程的 processPolicy 必须设 `disallowCredentialVars=false`（或不设），
 * 否则 omp 拿不到 LLM 凭据无法调用模型。这与验证命令的纵深防御互不冲突。
 */
function buildChildEnv(policy: ProcessPolicy): NodeJS.ProcessEnv {
  if (policy.inheritEnv) {
    return { ...process.env };
  }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
  const allowList = policy.allowedEnvVarNames;
  // P1-02：验证命令场景下，凭据变量名即使在白名单中也拒绝透传
  const blockCredentials = policy.disallowCredentialVars === true;
  if (allowList && allowList.length > 0) {
    for (const name of allowList) {
      if (blockCredentials && CREDENTIAL_PATTERN.test(name)) {
        continue;
      }
      const value = process.env[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
  }
  return env;
}

/** 凭据变量名模式（P1-02 纵深防御）。 */
const CREDENTIAL_PATTERN = /(?:API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PRIVATE_KEY)/i;
