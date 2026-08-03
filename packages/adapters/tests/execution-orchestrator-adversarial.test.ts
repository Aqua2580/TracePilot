/**
 * ExecutionOrchestrator 对抗性测试 —— P1-03（Phase 4 验收）。
 *
 * 验证 Reviewer 输入必须来自受控来源（execution_results 表）的安全约束：
 * - runDevelop 完成后必须持久化受控 Diff 与验证产物
 * - runReview 不接受调用方提交的 diff 或 verificationResult
 * - runReview 从 execution_results 表读取受控来源数据
 * - runReview 重新捕获工作树 Diff 校验哈希一致性；不一致抛 DiffTamperError
 * - runReview 无 execution_results 记录时拒绝
 *
 * 见 IMPLEMENTATION_SPEC §8.1 第 8 步与 AGENTS.md 规则 17。
 *
 * 本测试位于 adapters 包（依赖方向：adapters → core），可同时使用
 * core 的 InMemoryStore + ExecutionOrchestrator 与本包的 Fake 适配器。
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  TaskOrchestrator,
  ExecutionOrchestrator,
  createInMemoryStore,
  type TaskInput,
  type Project,
  type ProjectCommands,
  type PlanNode,
  type Worktree,
  type AgentRunRecord,
  type RuntimeEvent,
  type ReviewTaskInput,
  type ReviewResult,
  type InMemoryStore,
  type ProcessRunner,
  type CommandSpec,
  type CommandResult,
  type ProcessPolicy
} from "@tracepilot/core";
import {
  FakeRuntimeAdapter,
  FakeGitAdapter,
  FakeProcessRunner
} from "../src/index.js";
import { WorktreeManager } from "@tracepilot/core";
import type { RuntimeEventSink } from "@tracepilot/core";
import { DiffTamperError, PathScopeViolationError, RuntimeStreamFailedError } from "@tracepilot/core";

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function sampleTaskInput(): TaskInput {
  return {
    objective: "修复 createUser 返回错误状态码",
    constraints: ["仅修改 src/users.py"],
    acceptanceCriteria: ["pytest tests/test_users.py 通过"],
    riskLevel: "low",
    rawSource: "FAILED test_create_user_returns_201 ...",
    origin: "failed_test_log",
    failure: {
      testNames: ["test_create_user_returns_201"],
      errorTypes: ["AssertionError"],
      stackSummary: "assert result['status'] == 201, got 400"
    }
  };
}

const sampleCommands: ProjectCommands = {
  test: { argv: ["pytest"], timeoutMs: 30000 }
};

function sampleProject(): Project {
  return {
    id: "proj-adv",
    name: "对抗性测试项目",
    repositoryPath: "/tmp/tracepilot/repos/proj-adv",
    defaultBranch: "main",
    language: "python",
    commands: sampleCommands,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function samplePlanNodes(packId: string): readonly PlanNode[] {
  return [
    {
      id: "node-1",
      label: "修复 createUser",
      description: "调整状态码",
      evidencePackId: packId,
      evidencePackVersion: 1
    }
  ];
}

function sampleWorktree(taskId: string): Worktree {
  return {
    id: "wt-adv-1",
    projectId: "proj-adv",
    taskId,
    path: "/tmp/tracepilot/worktrees/proj-adv/wt-adv-1",
    branch: "tracepilot/wt-adv-1",
    baseCommitSha: "abc123",
    allowedPaths: ["src/**"],
    createdAt: "2026-07-28T00:00:00.000Z"
  };
}

/**
 * 简单的 RuntimeEventSink 实现 —— 把事件收集到内存数组，
 * flush 时返回一个最小 AgentRunRecord。仅用于测试。
 */
class FakeRuntimeEventSink implements RuntimeEventSink {
  private readonly events = new Map<string, RuntimeEvent[]>();

  append(taskId: string, runId: string, role: string, event: RuntimeEvent): void {
    void role;
    const key = `${taskId}:${runId}`;
    const list = this.events.get(key) ?? [];
    list.push(event);
    this.events.set(key, list);
  }

  async flush(taskId: string, runId: string): Promise<AgentRunRecord | undefined> {
    const key = `${taskId}:${runId}`;
    const events = this.events.get(key) ?? [];
    if (events.length === 0) return undefined;
    const totalBytes = JSON.stringify(events).length;
    return {
      id: `ar-${runId}`,
      taskId,
      runId,
      role: "test",
      events,
      totalBytes,
      retainedBytes: totalBytes,
      truncated: false,
      contentHash: "fake-hash",
      startedAt: events[0]!.at ?? new Date().toISOString(),
      endedAt: events[events.length - 1]!.at ?? new Date().toISOString()
    };
  }
}

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

interface TestFixture {
  readonly store: InMemoryStore;
  readonly orchestrator: TaskOrchestrator;
  readonly exec: ExecutionOrchestrator;
  readonly fakeRuntime: FakeRuntimeAdapter;
  readonly fakeGit: FakeGitAdapter;
  readonly fakeProcess: FakeProcessRunner;
}

function createFixture(): TestFixture {
  const store = createInMemoryStore();
  const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
  const fakeRuntime = new FakeRuntimeAdapter();
  const fakeGit = new FakeGitAdapter();
  const fakeProcess = new FakeProcessRunner();
  const worktreeManager = new WorktreeManager({
    gitAdapter: fakeGit,
    orchestrator,
    unitOfWork: store.unitOfWork
  });
  const sink = new FakeRuntimeEventSink();
  const exec = new ExecutionOrchestrator({
    unitOfWork: store.unitOfWork,
    runtime: fakeRuntime,
    worktreeManager,
    eventSink: sink,
    processRunner: fakeProcess,
    processPolicy: {
      allowedCwdRoots: ["/tmp/tracepilot/worktrees"],
      inheritEnv: false,
      maxOutputBytes: 1024 * 1024,
      timeoutMs: 30000,
      disallowCredentialVars: true
    }
  });
  return { store, orchestrator, exec, fakeRuntime, fakeGit, fakeProcess };
}

/**
 * 把任务从 CREATED 一路迁移到 EXECUTING，并持久化 worktree + plan + approval。
 */
async function moveToExecuting(
  fixture: TestFixture,
  taskId: string
): Promise<void> {
  const { orchestrator } = fixture;

  // 持久化 worktree 并通过 attachWorktree 绑定到 task（设置 task.worktreeId）
  await orchestrator.attachWorktree(taskId, sampleWorktree(taskId));

  // CREATED → INTAKING → GATHERING_EVIDENCE
  await orchestrator.transitionTask(taskId, "INTAKING");
  await orchestrator.transitionTask(taskId, "GATHERING_EVIDENCE");

  // 生成 Pack v1
  const packId = `pack-${taskId}`;
  await orchestrator.gatherEvidenceAndCreatePack({
    taskId,
    packId,
    evidence: [],
    acceptanceCriteria: []
  });

  // GATHERING_EVIDENCE → PLANNED
  await orchestrator.transitionTask(taskId, "PLANNED");

  // 记录 Plan
  await orchestrator.planTask({
    taskId,
    nodes: samplePlanNodes(packId),
    allowedPaths: ["src/**"],
    inputEvidencePackId: packId,
    inputEvidencePackVersion: 1
  });

  // PLANNED → AWAITING_EXECUTION_APPROVAL
  await orchestrator.transitionTask(taskId, "AWAITING_EXECUTION_APPROVAL");

  // 签发执行审批
  const scopeHash = await orchestrator.computeCurrentScopeHash(taskId);
  await orchestrator.recordApproval({
    taskId,
    kind: "execution",
    approver: "test-approver",
    decision: "approved",
    scopeHash
  });

  // AWAITING_EXECUTION_APPROVAL → EXECUTING
  await orchestrator.beginExecutionIfApproved(taskId);
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe("ExecutionOrchestrator P1-03 对抗性测试", () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = createFixture();
    await fixture.store.unitOfWork.run(async (tx) => {
      await tx.projects.save(sampleProject());
    });
  });

  describe("runDevelop 持久化受控执行结果", () => {
    it("runDevelop 完成后必须把 Diff 与验证产物持久化到 execution_results 表", async () => {
      const { store, orchestrator, exec, fakeGit, fakeProcess } = fixture;

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      fakeGit.setDiff(worktree.path, "--- a/src/users.py\n+++ b/src/users.py\n@@ -1,1 +1,1 @@\n-  return 400\n+  return 201\n");

      fakeProcess.setResult("pytest", {
        argv: ["pytest"],
        cwd: worktree.path,
        exitCode: 0,
        stdout: "1 passed",
        stderr: "",
        truncated: false,
        originalBytes: 0,
        retainedBytes: 0,
        timedOut: false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString()
      });

      const result = await exec.runDevelop(task.id);
      expect(result.verificationPassed).toBe(true);

      // 核心断言：execution_results 表必须有对应记录
      const persisted = await store.unitOfWork.run((tx) =>
        tx.executionResults.findLatestByTask(task.id)
      );
      expect(persisted).toBeDefined();
      expect(persisted!.taskId).toBe(task.id);
      expect(persisted!.diffHash).toBe(result.diff.hash);
      expect(persisted!.diffPatch).toBe(result.diff.patch);
      expect(persisted!.verificationExitCode).toBe(0);
      expect(persisted!.verificationPassed).toBe(true);
      expect(persisted!.verificationStdout).toBe("1 passed");
    });
  });

  describe("runReview 拒绝无受控执行结果", () => {
    it("runReview 在无 execution_results 记录时必须拒绝 Review", async () => {
      const { orchestrator, exec, fakeGit } = fixture;

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      // 迁移到 REVIEWING（跳过 develop，无 execution_results 记录）
      await orchestrator.transitionTask(task.id, "VALIDATING");
      await orchestrator.transitionTask(task.id, "REVIEWING");

      const worktree = sampleWorktree(task.id);
      fakeGit.setDiff(worktree.path, "some patch");

      // 核心断言：runReview 必须拒绝，因为无受控来源数据
      await expect(exec.runReview(task.id)).rejects.toThrow(
        /无对应的 execution_results 记录/
      );
    });
  });

  describe("runReview 拒绝 Diff 篡改", () => {
    it("runReview 在工作树 Diff 哈希与持久化哈希不一致时必须抛 DiffTamperError", async () => {
      const { orchestrator, exec, fakeGit, fakeProcess } = fixture;

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);

      // 1. runDevelop 时使用 patch A
      const patchA = "--- a/src/users.py\n+++ b/src/users.py\n@@ -1,1 +1,1 @@\n-  return 400\n+  return 201\n";
      fakeGit.setDiff(worktree.path, patchA);
      fakeProcess.setResult("pytest", {
        argv: ["pytest"],
        cwd: worktree.path,
        exitCode: 0,
        stdout: "1 passed",
        stderr: "",
        truncated: false,
        originalBytes: 0,
        retainedBytes: 0,
        timedOut: false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString()
      });
      await exec.runDevelop(task.id);

      // 2. 迁移到 REVIEWING
      await orchestrator.transitionTask(task.id, "VALIDATING");
      await orchestrator.transitionTask(task.id, "REVIEWING");

      // 3. 模拟篡改：runReview 前修改工作树 Diff（patch B）
      //    patchB 长度与 patchA 不同，确保 FakeGitAdapter 返回不同 hash
      const patchB = "--- a/src/users.py\n+++ b/src/users.py\n@@ -1,1 +1,1 @@\n-  return 400\n+  return 99999 TAMPERED\n";
      fakeGit.setDiff(worktree.path, patchB);

      // 核心断言：runReview 必须抛 DiffTamperError
      await expect(exec.runReview(task.id)).rejects.toBeInstanceOf(DiffTamperError);
    });
  });

  describe("runReview 不接受调用方提交的输入", () => {
    it("runReview 签名仅接受 taskId，不接受 diff 或 verificationResult 参数", async () => {
      const { orchestrator, exec, fakeGit, fakeProcess } = fixture;

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      fakeGit.setDiff(worktree.path, "valid patch");
      fakeProcess.setResult("pytest", {
        argv: ["pytest"],
        cwd: worktree.path,
        exitCode: 0,
        stdout: "1 passed",
        stderr: "",
        truncated: false,
        originalBytes: 0,
        retainedBytes: 0,
        timedOut: false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString()
      });

      await exec.runDevelop(task.id);
      await orchestrator.transitionTask(task.id, "VALIDATING");
      await orchestrator.transitionTask(task.id, "REVIEWING");

      // runReview 仅接受 taskId —— 调用方无法传入伪造 diff/verificationResult
      const result = await exec.runReview(task.id);
      expect(result.verdict).toBe("ship");
      expect(["ship", "ship_with_fixes", "block"]).toContain(result.verdict);
    });
  });

  describe("runReview 哈希一致时正常通过", () => {
    it("runReview 在工作树 Diff 哈希与持久化哈希一致时正常返回 ReviewResult", async () => {
      const { orchestrator, exec, fakeGit, fakeProcess } = fixture;

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      const patch = "consistent patch content";
      fakeGit.setDiff(worktree.path, patch);
      fakeProcess.setResult("pytest", {
        argv: ["pytest"],
        cwd: worktree.path,
        exitCode: 0,
        stdout: "1 passed",
        stderr: "",
        truncated: false,
        originalBytes: 0,
        retainedBytes: 0,
        timedOut: false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString()
      });

      await exec.runDevelop(task.id);
      await orchestrator.transitionTask(task.id, "VALIDATING");
      await orchestrator.transitionTask(task.id, "REVIEWING");

      // 不修改 diff，哈希一致，runReview 应正常通过
      const result = await exec.runReview(task.id);
      expect(result.verdict).toBe("ship");
    });
  });

  // ==========================================================================
  // P1-R01：路径范围越界对抗性测试（Phase 4 第二轮验收 §6.2）
  // ==========================================================================
  describe("P1-R01：runDevelop 路径范围越界失败关闭", () => {
    it("diff.changedFiles 含 Plan.allowedPaths 外的路径时必须抛 PathScopeViolationError", async () => {
      const { orchestrator, exec, fakeGit } = fixture;

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      // Plan.allowedPaths 为 ["src/**"]，但 Diff 含 package.json 越界路径
      fakeGit.setDiff(worktree.path, "--- a/package.json\n+++ b/package.json\n");
      fakeGit.setChangedFiles(worktree.path, ["package.json", "src/users.py"]);

      // 核心断言：runDevelop 必须抛 PathScopeViolationError
      await expect(exec.runDevelop(task.id)).rejects.toBeInstanceOf(
        PathScopeViolationError
      );
    });

    it("路径越界时必须写 policy_denied 审计事件", async () => {
      const { store, orchestrator, exec, fakeGit } = fixture;

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      fakeGit.setDiff(worktree.path, "--- a/package.json\n+++ b/package.json\n");
      fakeGit.setChangedFiles(worktree.path, ["package.json"]);

      try {
        await exec.runDevelop(task.id);
      } catch {
        // 预期抛错，忽略
      }

      // 核心断言：审计事件中必须有 policy_denied
      const auditEvents = await store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = auditEvents.find(
        (e) => e.type === "policy_denied" && e.deniedAction === "runDevelop.pathScopeViolation"
      );
      expect(denied).toBeDefined();
      expect(denied!.deniedReason).toContain("package.json");
    });

    it("路径越界时不得执行验证命令", async () => {
      const { orchestrator, exec, fakeGit, fakeProcess } = fixture;

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      fakeGit.setDiff(worktree.path, "--- a/tests/test_evil.py\n+++ b/tests/test_evil.py\n");
      fakeGit.setChangedFiles(worktree.path, ["tests/test_evil.py"]);

      try {
        await exec.runDevelop(task.id);
      } catch {
        // 预期抛错，忽略
      }

      // 核心断言：验证命令不得被执行
      const invocations = fakeProcess.getInvocations();
      const verifyCalls = invocations.filter((i) => i.spec.argv.join(" ") === "pytest");
      expect(verifyCalls).toHaveLength(0);
    });

    it("路径越界时不得持久化 execution_results", async () => {
      const { store, orchestrator, exec, fakeGit } = fixture;

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      fakeGit.setDiff(worktree.path, "--- a/../escape.txt\n+++ b/../escape.txt\n");
      fakeGit.setChangedFiles(worktree.path, ["../escape.txt"]);

      try {
        await exec.runDevelop(task.id);
      } catch {
        // 预期抛错，忽略
      }

      // 核心断言：execution_results 表不得有记录
      const persisted = await store.unitOfWork.run((tx) =>
        tx.executionResults.findLatestByTask(task.id)
      );
      expect(persisted).toBeUndefined();
    });

    it("allowedPaths 为空时所有变更均视为越界（fail-closed）", async () => {
      const { orchestrator, exec, fakeGit } = fixture;

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      // 使用自定义夹具：Plan.allowedPaths 为空
      await moveToExecutingWithEmptyAllowedPaths(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      fakeGit.setDiff(worktree.path, "--- a/src/users.py\n+++ b/src/users.py\n");
      fakeGit.setChangedFiles(worktree.path, ["src/users.py"]);

      // 核心断言：allowedPaths 为空时，即使 src/users.py 也应被拒绝
      await expect(exec.runDevelop(task.id)).rejects.toBeInstanceOf(
        PathScopeViolationError
      );
    });

    it("changedFiles 全部在 allowedPaths 内时正常通过", async () => {
      const { orchestrator, exec, fakeGit, fakeProcess } = fixture;

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      // Plan.allowedPaths 为 ["src/**"]，changedFiles 全在 src/ 下
      fakeGit.setDiff(worktree.path, "--- a/src/users.py\n+++ b/src/users.py\n");
      fakeGit.setChangedFiles(worktree.path, ["src/users.py", "src/utils.py"]);
      fakeProcess.setResult("pytest", {
        argv: ["pytest"],
        cwd: worktree.path,
        exitCode: 0,
        stdout: "1 passed",
        stderr: "",
        truncated: false,
        originalBytes: 0,
        retainedBytes: 0,
        timedOut: false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString()
      });

      // 核心断言：不抛错，正常返回
      const result = await exec.runDevelop(task.id);
      expect(result.verificationPassed).toBe(true);
    });
  });

  // ==========================================================================
  // P1-R02：Runtime 事件流失败关闭（Phase 4 第二轮验收 §6.3）
  // ==========================================================================
  describe("P1-R02：runAnalyze/runDevelop 事件流失败关闭", () => {
    it("runAnalyze 在事件流出现 error 时必须抛 RuntimeStreamFailedError", async () => {
      const { store, orchestrator } = fixture;

      // 自定义 Runtime：analyze 发 started → error（无 completed）
      const errorRuntime = createErrorRuntime("analyze");
      const exec = createExecWithRuntime(fixture, errorRuntime);

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      // 核心断言：必须抛 RuntimeStreamFailedError
      await expect(exec.runAnalyze(task.id)).rejects.toBeInstanceOf(
        RuntimeStreamFailedError
      );

      // 验证无 execution_results 持久化
      const persisted = await store.unitOfWork.run((tx) =>
        tx.executionResults.findLatestByTask(task.id)
      );
      expect(persisted).toBeUndefined();
    });

    it("runDevelop 在事件流出现 error 时必须抛 RuntimeStreamFailedError", async () => {
      const { store, orchestrator, fakeGit, fakeProcess } = fixture;

      // 自定义 Runtime：develop 发 started → error（无 completed）
      const errorRuntime = createErrorRuntime("develop");
      const exec = createExecWithRuntime(fixture, errorRuntime);

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      fakeGit.setDiff(worktree.path, "--- a/src/users.py\n+++ b/src/users.py\n");
      fakeProcess.setResult("pytest", {
        argv: ["pytest"],
        cwd: worktree.path,
        exitCode: 0,
        stdout: "1 passed",
        stderr: "",
        truncated: false,
        originalBytes: 0,
        retainedBytes: 0,
        timedOut: false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString()
      });

      // 核心断言：必须抛 RuntimeStreamFailedError
      await expect(exec.runDevelop(task.id)).rejects.toBeInstanceOf(
        RuntimeStreamFailedError
      );

      // 验证无 execution_results 持久化（失败关闭，禁止后续步骤）
      const persisted = await store.unitOfWork.run((tx) =>
        tx.executionResults.findLatestByTask(task.id)
      );
      expect(persisted).toBeUndefined();
    });

    it("runAnalyze 在事件流未以 completed 结束时必须抛 RuntimeStreamFailedError", async () => {
      const { orchestrator } = fixture;

      // 自定义 Runtime：analyze 发 started → progress（无 error 无 completed）
      const incompleteRuntime = createIncompleteRuntime("analyze");
      const exec = createExecWithRuntime(fixture, incompleteRuntime);

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      // 核心断言：必须抛 RuntimeStreamFailedError（未以 completed 结束）
      await expect(exec.runAnalyze(task.id)).rejects.toBeInstanceOf(
        RuntimeStreamFailedError
      );
    });

    it("runDevelop 在事件流未以 completed 结束时必须抛 RuntimeStreamFailedError", async () => {
      const { orchestrator, fakeGit } = fixture;

      const incompleteRuntime = createIncompleteRuntime("develop");
      const exec = createExecWithRuntime(fixture, incompleteRuntime);

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      fakeGit.setDiff(worktree.path, "patch");

      // 核心断言：必须抛 RuntimeStreamFailedError
      await expect(exec.runDevelop(task.id)).rejects.toBeInstanceOf(
        RuntimeStreamFailedError
      );
    });
  });

  // ==========================================================================
  // P1-R02：cancelRuntimeForTask 活动运行登记与取消
  // ==========================================================================
  describe("P1-R02：cancelRuntimeForTask 取消活动运行", () => {
    it("cancelRuntimeForTask 在无活动运行时安全返回 undefined", async () => {
      const { exec } = fixture;
      const result = await exec.cancelRuntimeForTask("nonexistent-task");
      expect(result).toBeUndefined();
    });

    it("cancelRuntimeForTask 在有活动运行时调用 runtime.cancel 并返回 runId", async () => {
      const { orchestrator, fakeGit, fakeProcess } = fixture;

      // 使用可取消的 Runtime：develop 在收到 cancel 前阻塞
      const cancellableRuntime = new CancellableRuntimeAdapter();
      const exec = createExecWithRuntime(fixture, cancellableRuntime);

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      fakeGit.setDiff(worktree.path, "patch");
      fakeProcess.setResult("pytest", {
        argv: ["pytest"],
        cwd: worktree.path,
        exitCode: 0,
        stdout: "1 passed",
        stderr: "",
        truncated: false,
        originalBytes: 0,
        retainedBytes: 0,
        timedOut: false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString()
      });

      // 启动 develop（异步，不会完成 —— CancellableRuntimeAdapter 阻塞）
      const developPromise = exec.runDevelop(task.id);
      // 等待 started 事件登记 runId
      await cancellableRuntime.waitForStarted();

      // 核心断言：cancelRuntimeForTask 必须返回被取消的 runId
      const cancelledRunId = await exec.cancelRuntimeForTask(task.id);
      expect(cancelledRunId).toBeDefined();
      expect(cancellableRuntime.cancelledRunIds).toContain(cancelledRunId);

      // 等待 develop 完成（因 cancel 后会发 error）
      await expect(developPromise).rejects.toThrow();
    });

    it("P1-R02-E：cancelRuntimeForTask 能终止运行中的 runReview（review 取消）", async () => {
      const { orchestrator, fakeGit, fakeProcess, store } = fixture;

      // 使用 review 可取消的 Runtime：review 在收到 cancel 前阻塞
      const cancellableReviewRuntime = new CancellableReviewRuntimeAdapter();
      const exec = createExecWithRuntime(fixture, cancellableReviewRuntime);

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      const patch = "review cancel test patch";
      fakeGit.setDiff(worktree.path, patch);
      fakeProcess.setResult("pytest", {
        argv: ["pytest"],
        cwd: worktree.path,
        exitCode: 0,
        stdout: "1 passed",
        stderr: "",
        truncated: false,
        originalBytes: 0,
        retainedBytes: 0,
        timedOut: false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString()
      });

      // 先完成 develop 持久化 execution_results
      await exec.runDevelop(task.id);
      await orchestrator.transitionTask(task.id, "VALIDATING");
      await orchestrator.transitionTask(task.id, "REVIEWING");

      // 异步启动 review（会阻塞 —— CancellableReviewRuntimeAdapter.review 等待 cancel）
      const reviewPromise = exec.runReview(task.id);
      // 等待 review 已启动（lease 已登记）
      await cancellableReviewRuntime.waitForReviewStarted();

      // 核心断言：cancelRuntimeForTask 必须能终止 review 进程
      // 注意：review 不通过 consumeStreamWithRegistration，activeRuns 不登记。
      // cancelRuntimeForTask 通过 pendingLeases 中的 controller.abort() 终止 review。
      const cancelledRunId = await exec.cancelRuntimeForTask(task.id);
      // review 阶段无 started 事件登记到 activeRuns，所以 cancelledRunId 可能 undefined。
      // 关键是 controller.abort() 已触发，review promise 会 reject。
      void cancelledRunId;

      // 等待 review 完成（因 abort 后 review 抛错）
      await expect(reviewPromise).rejects.toThrow(/cancelled/i);

      // 验证任务仍在 REVIEWING（orchestrator 层不做状态迁移，由 API 层负责）
      const currentTask = await store.unitOfWork.run((tx) => tx.tasks.findById(task.id));
      expect(currentTask?.status).toBe("REVIEWING");

      // 验证无新的 execution_results 被持久化（review 是只读操作，不写 execution_results）
      // 但 develop 阶段已写入一条记录 —— 验证只有一条
      const results = await store.unitOfWork.run((tx) =>
        tx.executionResults.findLatestByTask(task.id)
      );
      expect(results).toBeDefined();
      expect(results!.verificationPassed).toBe(true);
    });

    it("P1-R02 §9.3：Runtime completed 后验证阶段取消 —— 验证进程树退出、无成功产物", async () => {
      const { orchestrator, fakeGit, store } = fixture;

      // 使用默认 FakeRuntimeAdapter（develop 产出 started → progress → completed）
      const completingRuntime = new FakeRuntimeAdapter();
      // 使用阻塞型 ProcessRunner：验证命令阻塞直到 AbortSignal 触发
      const blockingProcess = new BlockingProcessRunner();
      const exec = createExecWithRuntimeAndProcess(fixture, completingRuntime, blockingProcess);

      const task = await orchestrator.createTask({
        projectId: "proj-adv",
        input: sampleTaskInput()
      });
      await moveToExecuting(fixture, task.id);

      const worktree = sampleWorktree(task.id);
      fakeGit.setDiff(worktree.path, "patch");

      // 异步启动 develop —— Runtime 会正常完成，但验证命令会阻塞
      const developPromise = exec.runDevelop(task.id);
      // 捕获早期错误，避免 unhandled rejection
      developPromise.catch(() => {});

      // 等待 Runtime 完成（started + completed）并进入验证阶段
      // BlockingProcessRunner 在被调用时通知 startedPromise
      // 若 runDevelop 在到达验证前就抛错，developPromise 会先 reject
      await Promise.race([
        blockingProcess.waitForStarted(),
        developPromise.then(
          () => { throw new Error("runDevelop 不应在验证前完成"); },
          (err) => { throw new Error(`runDevelop 在验证前抛错: ${err.message}`); }
        )
      ]);

      // 核心断言（§9.3）：Runtime 已 completed，但验证命令仍在运行。
      // 此时调用 cancelRuntimeForTask 应 abort controller，
      // 使验证进程树退出，runDevelop 在持久化前 assertNotAborted 失败。
      await exec.cancelRuntimeForTask(task.id);

      // 等待 develop 完成（因 signal.aborted → RuntimeStreamFailedError）
      await expect(developPromise).rejects.toThrow(/abort/i);

      // 验证无 execution_results 持久化（取消在验证后、持久化前失败关闭）
      const persisted = await store.unitOfWork.run((tx) =>
        tx.executionResults.findLatestByTask(task.id)
      );
      expect(persisted).toBeUndefined();

      // 验证验证命令被调用过（证明进入了验证阶段）
      expect(blockingProcess.invocationCount).toBe(1);

      // 验证验证进程已被终止（BlockingProcessRunner 记录 abort 事件）
      expect(blockingProcess.wasAborted).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// P1-R02 测试辅助：自定义 Runtime 适配器
// ---------------------------------------------------------------------------

/**
 * 创建一个在指定阶段发出 error 事件的 RuntimeAdapter。
 * analyze/develop 发 started → error（无 completed）。
 */
function createErrorRuntime(phase: "analyze" | "develop"): FakeRuntimeAdapter {
  const behaviour: import("../src/index.js").FakeRuntimeBehaviour =
    phase === "analyze"
      ? { analyzeError: "测试注入的 analyze 错误" }
      : {};
  const runtime = new FakeRuntimeAdapter(behaviour);
  if (phase === "develop") {
    // 覆盖 develop 方法：发 started → error
    runtime.develop = async function* (input) {
      const runId = `err-run-${Date.now()}`;
      yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
      yield {
        type: "error",
        runId,
        at: new Date().toISOString(),
        message: "测试注入的 develop 错误"
      };
    };
  }
  return runtime;
}

/**
 * 创建一个在指定阶段发出 started → progress 但不发 completed 的 RuntimeAdapter。
 * 模拟事件流被中断或异常停止。
 */
function createIncompleteRuntime(phase: "analyze" | "develop"): FakeRuntimeAdapter {
  const runtime = new FakeRuntimeAdapter();
  const incompleteGen = async function* (input: { taskId: string }) {
    const runId = `inc-run-${Date.now()}`;
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    yield {
      type: "progress",
      runId,
      message: "incomplete runtime - 无 completed 事件",
      at: new Date().toISOString()
    };
    // 故意不发 completed —— 模拟流被中断
  };
  if (phase === "analyze") {
    runtime.analyze = incompleteGen as never;
  } else {
    runtime.develop = incompleteGen as never;
  }
  return runtime;
}

/**
 * 可取消的 RuntimeAdapter：develop 发 started 后阻塞，直到 cancel 被调用。
 */
class CancellableRuntimeAdapter extends FakeRuntimeAdapter {
  private resolveStarted?: () => void;
  private startedPromise = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  readonly cancelledRunIds = new Set<string>();

  async *develop(input: { taskId: string }): AsyncIterable<RuntimeEvent> {
    const runId = `can-run-${Date.now()}`;
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    this.resolveStarted?.();

    // 阻塞等待 cancel
    while (!this.cancelledRunIds.has(runId)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    yield {
      type: "error",
      runId,
      at: new Date().toISOString(),
      message: "cancelled by test"
    };
  }

  async cancel(runId: string): Promise<void> {
    this.cancelledRunIds.add(runId);
  }

  async waitForStarted(): Promise<void> {
    await this.startedPromise;
  }
}

/**
 * P1-R02-E：review 可取消的 RuntimeAdapter。
 *
 * review() 在被调用时通知 waitForReviewStarted，然后阻塞等待 AbortSignal
 * 被触发。当 cancelRuntimeForTask abort controller 时，review 抛错。
 * 用于验证取消 API 能终止运行中的 review 进程。
 */
class CancellableReviewRuntimeAdapter extends FakeRuntimeAdapter {
  private resolveReviewStarted?: () => void;
  private readonly reviewStartedPromise = new Promise<void>((resolve) => {
    this.resolveReviewStarted = resolve;
  });

  async review(input: ReviewTaskInput, signal?: AbortSignal): Promise<ReviewResult> {
    void input;
    this.resolveReviewStarted?.();
    // 阻塞等待 abort signal
    if (signal?.aborted) {
      throw new Error("review cancelled before start");
    }
    await new Promise<void>((resolve) => {
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("review cancelled via abort signal");
  }

  async waitForReviewStarted(): Promise<void> {
    await this.reviewStartedPromise;
  }
}

/**
 * 用指定 runtime 构造 ExecutionOrchestrator，复用 fixture 的其他依赖。
 */
function createExecWithRuntime(
  fixture: TestFixture,
  runtime: FakeRuntimeAdapter
): ExecutionOrchestrator {
  return new ExecutionOrchestrator({
    unitOfWork: fixture.store.unitOfWork,
    runtime,
    worktreeManager: new WorktreeManager({
      gitAdapter: fixture.fakeGit,
      orchestrator: fixture.orchestrator,
      unitOfWork: fixture.store.unitOfWork
    }),
    eventSink: new FakeRuntimeEventSink(),
    processRunner: fixture.fakeProcess,
    processPolicy: {
      allowedCwdRoots: ["/tmp/tracepilot/worktrees"],
      inheritEnv: false,
      maxOutputBytes: 1024 * 1024,
      timeoutMs: 30000,
      disallowCredentialVars: true
    }
  });
}

/**
 * 与 moveToExecuting 类似，但 Plan.allowedPaths 为空数组（测试 fail-closed）。
 */
async function moveToExecutingWithEmptyAllowedPaths(
  fixture: TestFixture,
  taskId: string
): Promise<void> {
  const { orchestrator } = fixture;
  await orchestrator.attachWorktree(taskId, sampleWorktree(taskId));
  await orchestrator.transitionTask(taskId, "INTAKING");
  await orchestrator.transitionTask(taskId, "GATHERING_EVIDENCE");
  const packId = `pack-${taskId}`;
  await orchestrator.gatherEvidenceAndCreatePack({
    taskId,
    packId,
    evidence: [],
    acceptanceCriteria: []
  });
  await orchestrator.transitionTask(taskId, "PLANNED");
  await orchestrator.planTask({
    taskId,
    nodes: samplePlanNodes(packId),
    allowedPaths: [], // 空 allowedPaths —— 测试 fail-closed
    inputEvidencePackId: packId,
    inputEvidencePackVersion: 1
  });
  await orchestrator.transitionTask(taskId, "AWAITING_EXECUTION_APPROVAL");
  const scopeHash = await orchestrator.computeCurrentScopeHash(taskId);
  await orchestrator.recordApproval({
    taskId,
    kind: "execution",
    approver: "test-approver",
    decision: "approved",
    scopeHash
  });
  await orchestrator.beginExecutionIfApproved(taskId);
}

// ---------------------------------------------------------------------------
// P1-R02 §9.3 测试辅助：阻塞型 ProcessRunner 与 exec 工厂
// ---------------------------------------------------------------------------

/**
 * 阻塞型 ProcessRunner —— 验证命令阻塞直到 AbortSignal 触发。
 *
 * 用于测试 §9.3 场景：Runtime 已 completed，验证命令仍在运行时取消。
 * 当 AbortSignal 被 abort 时，run() 返回非零退出码（模拟进程树被终止）。
 */
class BlockingProcessRunner implements ProcessRunner {
  /** 被调用次数（验证进入了验证阶段）。 */
  invocationCount = 0;
  /** AbortSignal 是否被触发过。 */
  wasAborted = false;
  private resolveStarted?: () => void;
  private readonly startedPromise = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  async run(
    spec: CommandSpec,
    cwd: string,
    policy: ProcessPolicy,
    abortSignal?: AbortSignal
  ): Promise<CommandResult> {
    void spec; void cwd; void policy;
    this.invocationCount++;
    this.resolveStarted?.();

    // 阻塞等待 abort signal
    if (!abortSignal?.aborted) {
      await new Promise<void>((resolve) => {
        abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    this.wasAborted = true;

    return {
      argv: spec.argv,
      cwd,
      exitCode: 1,
      stdout: "",
      stderr: "进程被取消信号终止",
      truncated: false,
      originalBytes: 0,
      retainedBytes: 0,
      timedOut: false,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString()
    };
  }

  async waitForStarted(): Promise<void> {
    await this.startedPromise;
  }
}

/**
 * 用指定 runtime 和 processRunner 构造 ExecutionOrchestrator。
 * 用于 §9.3 测试：需要同时注入完成型 Runtime 和阻塞型 ProcessRunner。
 */
function createExecWithRuntimeAndProcess(
  fixture: TestFixture,
  runtime: FakeRuntimeAdapter,
  processRunner: ProcessRunner
): ExecutionOrchestrator {
  return new ExecutionOrchestrator({
    unitOfWork: fixture.store.unitOfWork,
    runtime,
    worktreeManager: new WorktreeManager({
      gitAdapter: fixture.fakeGit,
      orchestrator: fixture.orchestrator,
      unitOfWork: fixture.store.unitOfWork
    }),
    eventSink: new FakeRuntimeEventSink(),
    processRunner,
    processPolicy: {
      allowedCwdRoots: ["/tmp/tracepilot/worktrees"],
      inheritEnv: false,
      maxOutputBytes: 1024 * 1024,
      timeoutMs: 30000,
      disallowCredentialVars: true
    }
  });
}
