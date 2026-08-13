/** Phase 7 debugpy 运行时证据适配器：本机 loopback、堆栈范围和脱敏边界。 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { DefaultPathPolicy } from "@tracepilot/governance";
import {
  DebugpyRuntimeEvidenceAdapter,
  RuntimeDebugEvidenceError
} from "../src/index.js";

const directories: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const processes: ChildProcess[] = [];
const silentSockets: Socket[] = [];
const phase7Python = process.env.TRACEPILOT_PHASE7_PYTHON;
const hasPhase7Python = typeof phase7Python === "string" && existsSync(phase7Python);
const debugpyRunAuthorized = process.env.TRACEPILOT_PHASE7_DEBUGPY_ACK === "1";

// 严格门禁显式要求真实用例时，配置缺失必须失败，不能被 skipIf 掩盖。
if (debugpyRunAuthorized && !hasPhase7Python) {
  throw new Error("TRACEPILOT_PHASE7_DEBUGPY_ACK=1 时必须提供存在的 TRACEPILOT_PHASE7_PYTHON");
}

afterEach(async () => {
  for (const child of processes.splice(0)) {
    await stopChild(child);
  }
  for (const socket of silentSockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** Windows 必须等 Python 释放文件句柄后才能删除临时 worktree。 */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32" && child.pid) {
    // debugpy 在 Windows 可能再启动 pytest 子进程；只结束启动器会留下
    // 持有临时 worktree 的后代。taskkill /T 只作用于本测试创建的 PID 树。
    const terminator = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    await new Promise<void>((resolve) => terminator.once("exit", () => resolve()));
  } else {
    child.kill();
  }
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000))
  ]);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("临时端口不可用");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForDebugpyStartup(child: ChildProcess): Promise<void> {
  // debugpy 每个监听端口只接受一个 DAP 客户端。不能以裸 TCP 探测端口，
  // 否则探测连接会抢占正式握手；由 Adapter 自身发起第一条 DAP 连接。
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (child.exitCode !== null) {
    throw new Error(`真实 debugpy 提前退出（exitCode=${child.exitCode}）`);
  }
}

function createWorktree(): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), "tracepilot-phase7-debugpy-"));
  directories.push(root);
  const source = join(root, "src", "users.py");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(source, "def create_user():\n    return 400\n", "utf8");
  return { root, source };
}

function stackTrace(source: string): string {
  return [
    "Traceback (most recent call last):",
    `  File "${source}", line 2, in create_user`,
    "    return 400",
    "AssertionError: expected 201, got 400"
  ].join("\n");
}

async function startDapServer(source: string): Promise<number> {
  const server = createServer((socket) => serveDap(socket, source));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试 DAP 端口不可用");
  return address.port;
}

/** 接受连接但不回 DAP 消息，用于验证请求超时会失败关闭。 */
async function startSilentDapServer(): Promise<{ port: number; accepted: Promise<void> }> {
  let resolveAccepted: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => { resolveAccepted = resolve; });
  const server = createServer((socket) => {
    silentSockets.push(socket);
    resolveAccepted?.();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试 DAP 端口不可用");
  return { port: address.port, accepted };
}

function serveDap(socket: Socket, source: string): void {
  let buffer = Buffer.alloc(0);
  let outboundSequence = 1;
  const send = (message: Record<string, unknown>) => {
    const payload = Buffer.from(JSON.stringify({ seq: outboundSequence++, ...message }), "utf8");
    socket.write(Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"), payload]));
  };
  const respond = (request: Record<string, unknown>, body: unknown = {}) => {
    send({ type: "response", request_seq: request.seq, success: true, command: request.command, body });
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const divider = buffer.indexOf("\r\n\r\n");
      if (divider < 0) return;
      const header = buffer.subarray(0, divider).toString("ascii");
      const length = Number(/^Content-Length:\s*(\d+)$/im.exec(header)?.[1]);
      if (!Number.isInteger(length) || buffer.length < divider + 4 + length) return;
      const request = JSON.parse(buffer.subarray(divider + 4, divider + 4 + length).toString("utf8")) as Record<string, unknown>;
      buffer = buffer.subarray(divider + 4 + length);
      switch (request.command) {
        case "initialize":
          respond(request, {});
          break;
        case "attach":
          send({ type: "event", event: "initialized", body: {} });
          respond(request, {});
          break;
        case "configurationDone":
          respond(request, {});
          send({ type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 11 } });
          break;
        case "stackTrace":
          respond(request, { stackFrames: [{ id: 21, name: "create_user", line: 2, source: { path: source } }] });
          break;
        case "scopes":
          respond(request, { scopes: [{ name: "Locals", variablesReference: 31 }] });
          break;
        case "variables":
          respond(request, { variables: [
            { name: "expected_status", value: "201" },
            { name: "failed_value", value: "400" },
            { name: "api_token", value: "should-not-appear" },
            { name: "long_value", value: "x".repeat(400) }
          ] });
          break;
        case "continue":
        case "disconnect":
          respond(request, {});
          break;
        default:
          respond(request, {});
      }
    }
  });
}

describe("DebugpyRuntimeEvidenceAdapter", () => {
  it("从工作树内 pytest 堆栈定位暂停帧、读取局部变量并脱敏", async () => {
    const worktree = createWorktree();
    const port = await startDapServer(worktree.source);
    const adapter = new DebugpyRuntimeEvidenceAdapter({ pathPolicy: new DefaultPathPolicy() });

    const evidence = await adapter.capturePythonRuntimeEvidence({
      worktreePath: worktree.root,
      pytestStackTrace: stackTrace(worktree.source),
      dapPort: port,
      sourceCommand: ["python", "-m", "pytest", "-q"],
      testLocator: "tests/test_users.py::test_create_user"
    });

    expect(evidence).toMatchObject({
      kind: "runtime",
      source: "debugpy-dap-loopback",
      locator: expect.stringContaining("src/users.py:2"),
      trustLevel: "PRIMARY"
    });
    expect(evidence.summary).toContain("expected_status=201");
    expect(evidence.summary).toContain("failed_value=400");
    expect(evidence.summary).toContain("api_token=[redacted]");
    expect(evidence.summary).not.toContain("should-not-appear");
    expect(evidence.summary).toContain("…[truncated]");
    expect(evidence.summary).toContain('来源命令=["python","-m","pytest","-q"]');
    expect(evidence.summary).toContain("测试定位=tests/test_users.py::test_create_user");
    expect(evidence.summary).toContain("工作目录=已登记 worktree");
    expect(evidence.summary).toContain("局部变量列表截断=否");
    expect(evidence.contentHash).toMatch(/^sha256-[a-f0-9]{64}$/);
  });

  it("拒绝 pytest 堆栈中的工作树外路径，且不会连接 DAP", async () => {
    const worktree = createWorktree();
    const adapter = new DebugpyRuntimeEvidenceAdapter({ pathPolicy: new DefaultPathPolicy() });

    await expect(adapter.capturePythonRuntimeEvidence({
      worktreePath: worktree.root,
      pytestStackTrace: stackTrace("C:/outside/users.py"),
      dapPort: 5678
    })).rejects.toThrow("工作树外");
  });

  it("拒绝特权端口和无效 DAP 输入", async () => {
    const worktree = createWorktree();
    const adapter = new DebugpyRuntimeEvidenceAdapter({ pathPolicy: new DefaultPathPolicy() });

    await expect(adapter.capturePythonRuntimeEvidence({
      worktreePath: worktree.root,
      pytestStackTrace: stackTrace(worktree.source),
      dapPort: 80
    })).rejects.toBeInstanceOf(RuntimeDebugEvidenceError);
  });

  it("DAP 已连接但不响应时在受限超时内失败关闭", async () => {
    const worktree = createWorktree();
    const dap = await startSilentDapServer();
    const adapter = new DebugpyRuntimeEvidenceAdapter({
      pathPolicy: new DefaultPathPolicy(),
      timeoutMs: 1_000
    });

    await expect(adapter.capturePythonRuntimeEvidence({
      worktreePath: worktree.root,
      pytestStackTrace: stackTrace(worktree.source),
      dapPort: dap.port
    })).rejects.toThrow("DAP 请求 initialize 超时");
  }, 3_000);

  it("操作者取消时立即关闭 DAP 连接且不产出运行时证据", async () => {
    const worktree = createWorktree();
    const dap = await startSilentDapServer();
    const controller = new AbortController();
    const adapter = new DebugpyRuntimeEvidenceAdapter({
      pathPolicy: new DefaultPathPolicy(),
      timeoutMs: 3_000
    });
    const capture = adapter.capturePythonRuntimeEvidence({
      worktreePath: worktree.root,
      pytestStackTrace: stackTrace(worktree.source),
      dapPort: dap.port,
      abortSignal: controller.signal
    });

    await dap.accepted;
    const startedAt = Date.now();
    controller.abort();
    await expect(capture).rejects.toThrow("操作者已取消本机 debugpy 证据采集");
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it.skipIf(!hasPhase7Python || !debugpyRunAuthorized)("真实 debugpy 在 pytest 用例暂停时读取局部变量", async () => {
    const worktree = createWorktree();
    const port = await reserveLoopbackPort();
    const testDirectory = join(worktree.root, "tests");
    mkdirSync(testDirectory, { recursive: true });
    const script = join(testDirectory, "test_runtime_fixture.py");
    writeFileSync(script, [
      "import debugpy",
      "def test_create_user_runtime_evidence():",
      "    expected_status = 201",
      "    failed_value = 400",
      "    debugpy.breakpoint()",
      "    assert failed_value == expected_status"
    ].join("\n"), "utf8");
    const child = spawn(phase7Python!, [
      "-Xfrozen_modules=off",
      "-m", "debugpy",
      "--listen", `127.0.0.1:${port}`,
      "--wait-for-client",
      "-m", "pytest", "-q", "-s", "tests/test_runtime_fixture.py"
    ], { cwd: worktree.root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    processes.push(child);
    await waitForDebugpyStartup(child);

    const adapter = new DebugpyRuntimeEvidenceAdapter({ pathPolicy: new DefaultPathPolicy() });
    const evidence = await adapter.capturePythonRuntimeEvidence({
      worktreePath: worktree.root,
      pytestStackTrace: stackTrace(script).replace("line 2", "line 5"),
      dapPort: port,
      sourceCommand: ["python", "-m", "pytest", "-q", "-s", "tests/test_runtime_fixture.py"],
      testLocator: "tests/test_runtime_fixture.py::test_create_user_runtime_evidence"
    });

    expect(evidence.summary).toContain("expected_status=201");
    expect(evidence.summary).toContain("failed_value=400");
    expect(evidence.summary).toContain("测试定位=tests/test_runtime_fixture.py::test_create_user_runtime_evidence");
  }, 15_000);
});
