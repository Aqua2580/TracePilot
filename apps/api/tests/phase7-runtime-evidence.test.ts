/** Phase 7 运行时调试证据 API：Evidence Request、Pack 升版与 worktree 边界。 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { buildCompositionRoot } from "../src/composition-root.js";
import type {
  EvidenceItem,
  Project,
  RuntimeDebugEvidenceAdapter,
  TaskInput,
  Worktree
} from "@tracepilot/core";

const directories: string[] = [];
const processes: ChildProcess[] = [];
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
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** Windows 必须等 Python 释放文件句柄后才能删除临时 worktree。 */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32" && child.pid) {
    // debugpy 在 Windows 会再启动 pytest；清理时结束本测试创建的完整 PID 树，
    // 防止后代进程继续占用临时 worktree。
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

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
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
  // debugpy 监听端口只应由正式 Adapter 连接，裸 TCP 探测会抢占单客户端握手。
  // 不等待监听完成：由 Adapter 仅对 ECONNREFUSED 的受限重试完成同步，
  // 以覆盖并行测试或较慢机器上的实际启动竞态。
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (child.exitCode !== null) {
    throw new Error(`真实 debugpy 提前退出（exitCode=${child.exitCode}）`);
  }
}

function project(repositoryPath: string): Project {
  return {
    id: "phase7-runtime-project",
    name: "Phase 7 运行时证据合成项目",
    repositoryPath,
    defaultBranch: "main",
    language: "python",
    commands: { test: { argv: ["python", "-m", "pytest"], timeoutMs: 30_000 } },
    createdAt: "2026-08-12T00:00:00.000Z"
  };
}

function taskInput(): TaskInput {
  return {
    objective: "修复 pytest 返回状态码错误",
    constraints: ["不得修改 tests/"],
    acceptanceCriteria: ["pytest 通过"],
    riskLevel: "low",
    rawSource: "FAILED tests/test_users.py::test_create_user",
    origin: "failed_test_log",
    failure: {
      testNames: ["tests/test_users.py::test_create_user"],
      errorTypes: ["AssertionError"],
      stackSummary: "expected 201, got 400"
    }
  };
}

function runtimeEvidence(): EvidenceItem {
  return {
    id: "runtime-debug-evidence-1",
    kind: "runtime",
    source: "debugpy-dap-loopback",
    locator: "pytest:src/users.py:4;dap:src/users.py:4",
    capturedAt: "2026-08-12T00:00:00.000Z",
    contentHash: "sha256-runtime-debug-evidence-1",
    summary: "pytest 堆栈定位 src/users.py:4；局部变量：expected_status=201, failed_value=400",
    relevance: 0.95,
    trustLevel: "PRIMARY"
  };
}

async function createTaskWithPackAndWorktree(
  root: Awaited<ReturnType<typeof buildCompositionRoot>>,
  repositoryPath: string,
  worktreePath: string
): Promise<{ taskId: string; worktree: Worktree }> {
  await root.store.unitOfWork.run((tx) => tx.projects.save(project(repositoryPath)));
  const task = await root.orchestrator.createTask({
    projectId: "phase7-runtime-project",
    input: taskInput()
  });
  await root.orchestrator.transitionTask(task.id, "INTAKING");
  await root.orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE");
  await root.orchestrator.gatherEvidenceAndCreatePack({
    taskId: task.id,
    packId: "phase7-runtime-pack",
    evidence: [{
      id: "initial-code-evidence",
      kind: "code",
      source: "synthetic-fixture",
      locator: "src/users.py:1",
      capturedAt: "2026-08-12T00:00:00.000Z",
      contentHash: "sha256-initial-code-evidence",
      summary: "初始代码证据",
      relevance: 0.8,
      trustLevel: "PRIMARY"
    }]
  });
  const worktree: Worktree = {
    id: "phase7-runtime-worktree",
    projectId: "phase7-runtime-project",
    taskId: task.id,
    path: worktreePath,
    branch: "tp/phase7-runtime",
    baseCommitSha: "synthetic-base",
    allowedPaths: ["src/"],
    createdAt: "2026-08-12T00:00:00.000Z"
  };
  await root.orchestrator.attachWorktree(task.id, worktree);
  return { taskId: task.id, worktree };
}

describe("Phase 7 Python 运行时证据 API", () => {
  it("先持久化 runtime Evidence Request，再把受限 DAP 证据写入 Pack v2", async () => {
    const repositoryPath = temporaryDirectory("tracepilot-phase7-runtime-repo-");
    const worktreePath = temporaryDirectory("tracepilot-phase7-runtime-worktree-");
    const dbPath = join(temporaryDirectory("tracepilot-phase7-runtime-db-"), "tracepilot.db");
    const capture = vi.fn<RuntimeDebugEvidenceAdapter["capturePythonRuntimeEvidence"]>()
      .mockResolvedValue(runtimeEvidence());
    const root = buildCompositionRoot({
      dbPath,
      skipEnvFile: true,
      runtimeDebugEvidenceAdapterOverride: { capturePythonRuntimeEvidence: capture }
    });
    try {
      const { taskId, worktree } = await createTaskWithPackAndWorktree(root, repositoryPath, worktreePath);
      const response = await root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/runtime-evidence/python`,
        payload: {
          pytestStackTrace: `File "${join(worktreePath, "src", "users.py")}", line 4, in create_user`,
          dapPort: 5678,
          host: "example.invalid",
          evidence: { kind: "policy" }
        }
      });

      expect(response.statusCode).toBe(201);
      expect(capture).toHaveBeenCalledWith({
        worktreePath: worktree.path,
        pytestStackTrace: expect.stringContaining("src\\users.py"),
        dapPort: 5678,
        sourceCommand: ["python", "-m", "pytest"],
        testLocator: "tests/test_users.py::test_create_user",
        abortSignal: expect.any(AbortSignal)
      });
      const body = response.json() as {
        request: { neededKinds: string[]; allowedScope: string };
        pack: { version: number; evidence: EvidenceItem[] };
      };
      expect(body.request.neededKinds).toEqual(["runtime"]);
      expect(body.request.allowedScope).toContain("127.0.0.1:5678");
      expect(body.pack.version).toBe(2);
      expect(body.pack.evidence).toContainEqual(expect.objectContaining({
        id: "runtime-debug-evidence-1",
        source: "debugpy-dap-loopback"
      }));

      const versions = await root.store.unitOfWork.run((tx) =>
        tx.evidencePacks.findVersions("phase7-runtime-pack")
      );
      expect(versions.map((pack) => pack.version)).toEqual([1, 2]);
      expect(versions[0]!.evidence).toHaveLength(1);
      const requests = await root.store.unitOfWork.run((tx) => tx.evidenceRequests.findByTask(taskId));
      expect(requests).toHaveLength(1);
      expect(requests[0]!.neededKinds).toEqual(["runtime"]);
    } finally {
      await root.close();
    }
  });

  it("未登记 worktree 时拒绝采集，且不会调用 DAP Adapter", async () => {
    const repositoryPath = temporaryDirectory("tracepilot-phase7-runtime-repo-");
    const dbPath = join(temporaryDirectory("tracepilot-phase7-runtime-db-"), "tracepilot.db");
    const capture = vi.fn<RuntimeDebugEvidenceAdapter["capturePythonRuntimeEvidence"]>();
    const root = buildCompositionRoot({
      dbPath,
      skipEnvFile: true,
      runtimeDebugEvidenceAdapterOverride: { capturePythonRuntimeEvidence: capture }
    });
    try {
      await root.store.unitOfWork.run((tx) => tx.projects.save(project(repositoryPath)));
      const task = await root.orchestrator.createTask({ projectId: "phase7-runtime-project", input: taskInput() });
      await root.orchestrator.transitionTask(task.id, "INTAKING");
      await root.orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE");
      await root.orchestrator.gatherEvidenceAndCreatePack({ taskId: task.id, packId: "phase7-runtime-no-worktree", evidence: [] });

      const response = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/runtime-evidence/python`,
        payload: { pytestStackTrace: "File \"src/users.py\", line 4", dapPort: 5678 }
      });
      expect(response.statusCode).toBe(409);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      await root.close();
    }
  });

  it("DAP 采集失败时不生成新的 Evidence Pack 版本", async () => {
    const repositoryPath = temporaryDirectory("tracepilot-phase7-runtime-repo-");
    const worktreePath = temporaryDirectory("tracepilot-phase7-runtime-worktree-");
    const dbPath = join(temporaryDirectory("tracepilot-phase7-runtime-db-"), "tracepilot.db");
    const root = buildCompositionRoot({
      dbPath,
      skipEnvFile: true,
      runtimeDebugEvidenceAdapterOverride: {
        capturePythonRuntimeEvidence: async () => { throw new Error("本机 debugpy 未暂停"); }
      }
    });
    try {
      const { taskId } = await createTaskWithPackAndWorktree(root, repositoryPath, worktreePath);
      const response = await root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/runtime-evidence/python`,
        payload: { pytestStackTrace: "File \"src/users.py\", line 4", dapPort: 5678 }
      });
      expect(response.statusCode).toBe(400);
      const versions = await root.store.unitOfWork.run((tx) =>
        tx.evidencePacks.findVersions("phase7-runtime-pack")
      );
      expect(versions.map((pack) => pack.version)).toEqual([1]);
    } finally {
      await root.close();
    }
  });

  it("拒绝浏览器提交的取消控制对象，防止伪造 DAP 调试会话控制权", async () => {
    const repositoryPath = temporaryDirectory("tracepilot-phase7-runtime-repo-");
    const worktreePath = temporaryDirectory("tracepilot-phase7-runtime-worktree-");
    const dbPath = join(temporaryDirectory("tracepilot-phase7-runtime-db-"), "tracepilot.db");
    const capture = vi.fn<RuntimeDebugEvidenceAdapter["capturePythonRuntimeEvidence"]>();
    const root = buildCompositionRoot({
      dbPath,
      skipEnvFile: true,
      runtimeDebugEvidenceAdapterOverride: { capturePythonRuntimeEvidence: capture }
    });
    try {
      const { taskId } = await createTaskWithPackAndWorktree(root, repositoryPath, worktreePath);
      const response = await root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/runtime-evidence/python`,
        payload: {
          pytestStackTrace: "File \"src/users.py\", line 4",
          dapPort: 5678,
          abortSignal: { aborted: false }
        }
      });
      expect(response.statusCode).toBe(400);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      await root.close();
    }
  });

  it("非 GATHERING_EVIDENCE 状态拒绝采集，避免绕过执行中的 Evidence Gap 回环", async () => {
    const repositoryPath = temporaryDirectory("tracepilot-phase7-runtime-repo-");
    const worktreePath = temporaryDirectory("tracepilot-phase7-runtime-worktree-");
    const dbPath = join(temporaryDirectory("tracepilot-phase7-runtime-db-"), "tracepilot.db");
    const capture = vi.fn<RuntimeDebugEvidenceAdapter["capturePythonRuntimeEvidence"]>();
    const root = buildCompositionRoot({
      dbPath,
      skipEnvFile: true,
      runtimeDebugEvidenceAdapterOverride: { capturePythonRuntimeEvidence: capture }
    });
    try {
      const { taskId } = await createTaskWithPackAndWorktree(root, repositoryPath, worktreePath);
      await root.orchestrator.transitionTask(taskId, "PLANNED");
      const response = await root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/runtime-evidence/python`,
        payload: { pytestStackTrace: "File \"src/users.py\", line 4", dapPort: 5678 }
      });
      expect(response.statusCode).toBe(409);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      await root.close();
    }
  });

  it("Evidence Gap 通过 API 扩大范围时会使旧执行审批失效", async () => {
    const repositoryPath = temporaryDirectory("tracepilot-phase7-runtime-repo-");
    const worktreePath = temporaryDirectory("tracepilot-phase7-runtime-worktree-");
    const dbPath = join(temporaryDirectory("tracepilot-phase7-runtime-db-"), "tracepilot.db");
    const root = buildCompositionRoot({ dbPath, skipEnvFile: true });
    try {
      const { taskId } = await createTaskWithPackAndWorktree(root, repositoryPath, worktreePath);
      await root.orchestrator.transitionTask(taskId, "PLANNED");
      await root.orchestrator.planTask({
        taskId,
        nodes: [{
          id: "phase7-runtime-plan-node",
          label: "定位返回值",
          description: "读取运行时证据后修复状态码",
          evidencePackId: "phase7-runtime-pack",
          evidencePackVersion: 1
        }],
        allowedPaths: ["src/"],
        inputEvidencePackId: "phase7-runtime-pack",
        inputEvidencePackVersion: 1
      });
      await root.orchestrator.transitionTask(taskId, "AWAITING_EXECUTION_APPROVAL");
      const scopeHash = await root.orchestrator.computeCurrentScopeHash(taskId);
      await root.orchestrator.recordApproval({
        taskId,
        kind: "execution",
        approver: "phase7-runtime-approver",
        decision: "approved",
        scopeHash
      });
      await root.orchestrator.beginExecutionIfApproved(taskId);

      const gap = await root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/transition`,
        payload: { to: "EVIDENCE_GAP", reason: "需要补充运行时证据" }
      });
      expect(gap.statusCode).toBe(200);
      const gathering = await root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/transition`,
        payload: {
          to: "GATHERING_EVIDENCE",
          widenScope: true,
          reason: "运行时定位后需要重新审批"
        }
      });
      expect(gathering.statusCode).toBe(200);
      expect((gathering.json() as { status: string }).status).toBe("GATHERING_EVIDENCE");
      const activeApproval = await root.store.unitOfWork.run((tx) =>
        tx.approvals.findLatestExecutionApproval(taskId)
      );
      expect(activeApproval).toBeUndefined();

      const invalidTarget = await root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/transition`,
        payload: { to: "PLANNED", widenScope: true }
      });
      expect(invalidTarget.statusCode).toBe(400);
    } finally {
      await root.close();
    }
  });

  it.skipIf(!hasPhase7Python || !debugpyRunAuthorized)("真实 debugpy 暂停帧经 API 写入可追溯的 Pack v2", async () => {
    const repositoryPath = temporaryDirectory("tracepilot-phase7-runtime-repo-");
    const worktreePath = temporaryDirectory("tracepilot-phase7-runtime-worktree-");
    const dbPath = join(temporaryDirectory("tracepilot-phase7-runtime-db-"), "tracepilot.db");
    const root = buildCompositionRoot({ dbPath, skipEnvFile: true });
    try {
      const { taskId } = await createTaskWithPackAndWorktree(root, repositoryPath, worktreePath);
      const testDirectory = join(worktreePath, "tests");
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
      const port = await reserveLoopbackPort();
      const child = spawn(phase7Python!, [
        "-Xfrozen_modules=off",
        "-m", "debugpy",
        "--listen", `127.0.0.1:${port}`,
        "--wait-for-client",
        "-m", "pytest", "-q", "-s", "tests/test_runtime_fixture.py"
      ], { cwd: worktreePath, stdio: "ignore", windowsHide: true });
      processes.push(child);
      await waitForDebugpyStartup(child);

      const response = await root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/runtime-evidence/python`,
        payload: {
          pytestStackTrace: `File "${script}", line 5, in test_create_user_runtime_evidence`,
          dapPort: port
        }
      });
      expect(response.statusCode).toBe(201);
      const body = response.json() as { pack: { version: number; evidence: EvidenceItem[] } };
      expect(body.pack.version).toBe(2);
      expect(body.pack.evidence).toContainEqual(expect.objectContaining({
        source: "debugpy-dap-loopback",
        summary: expect.stringContaining("expected_status=201")
      }));
      expect(body.pack.evidence).toContainEqual(expect.objectContaining({
        summary: expect.stringContaining("测试定位=tests/test_users.py::test_create_user")
      }));
    } finally {
      await root.close();
    }
  }, 15_000);
});
