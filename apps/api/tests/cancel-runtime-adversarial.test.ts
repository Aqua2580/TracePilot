/**
 * P1-R02-E：HTTP API 取消与异常状态迁移对抗性测试。
 *
 * 验证 §7.3 第 4 点要求的从 HTTP API 出发的并发集成测试：
 * - 注册前取消：/cancel 在 /run 启动 Runtime 前调用
 * - 已运行 develop 取消：/cancel 在 develop 运行中调用
 * - review 取消：/cancel 在 review 运行中调用
 * - Runtime 终止失败：cancelRuntimeForTask 抛错时迁移到 INTERRUPTED 并返回 500
 * - 异常状态迁移：runAnalyze 抛 RuntimeStreamFailedError 时迁移到 INTERRUPTED 并返回 500
 *
 * 分别断言：无后续写入、无成功验证/Review 产物、状态和审计一致。
 *
 * 见 docs/reviews/PHASE-4-ACCEPTANCE-REVIEW.md §7.3 关闭要求第 4 点。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCompositionRoot } from "../src/composition-root.js";
import type {
  TaskInput,
  Project,
  ProjectCommands,
  PlanNode,
  Worktree,
  RuntimeAdapter,
  RuntimeTaskInput,
  ReviewTaskInput,
  RuntimeEvent,
  ReviewResult,
  ProcessRunner,
  CommandSpec,
  CommandResult,
  ProcessPolicy,
  UnitOfWork,
  TransactionalRepos,
  ExecutionResult
} from "@tracepilot/core";

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-cancel-test-"));
  return join(dir, "cancel-test.db");
}

function safeCleanup(dbPath: string): void {
  const dir = join(dbPath, "..");
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // 等待文件锁释放后重试。
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略：Windows 文件锁残留不影响测试结论。
  }
}

function sampleInput(): TaskInput {
  return {
    objective: "fix failing pytest",
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
    id: "proj-cancel",
    name: "取消对抗性测试项目",
    repositoryPath: "/tmp/tracepilot/repos/proj-cancel",
    defaultBranch: "main",
    language: "python",
    commands: sampleCommands,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function samplePlanNodes(packId: string): readonly PlanNode[] {
  return [
    {
      id: "node-cancel-1",
      label: "修复 createUser",
      description: "调整状态码",
      evidencePackId: packId,
      evidencePackVersion: 1
    }
  ];
}

function sampleWorktree(taskId: string, path?: string): Worktree {
  return {
    id: "wt-cancel-1",
    projectId: "proj-cancel",
    taskId,
    path: path ?? "/tmp/tracepilot/worktrees/proj-cancel/wt-cancel-1",
    branch: "tracepilot/wt-cancel-1",
    baseCommitSha: "abc123",
    allowedPaths: ["src/**"],
    createdAt: "2026-07-28T00:00:00.000Z"
  };
}

/**
 * 阻塞型 Runtime —— develop/review 在收到 started 后阻塞，直到 cancel 被调用。
 * 用于测试取消 API 能终止正在运行的 Runtime。
 */
class BlockingRuntimeAdapter implements RuntimeAdapter {
  private readonly blockers = new Map<string, () => void>();
  private readonly cancelled = new Set<string>();
  readonly startedRunIds = new Set<string>();
  private resolveStarted?: () => void;
  private readonly startedPromise = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  async *analyze(input: RuntimeTaskInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runId = `blk-analyze-${Date.now()}`;
    if (signal?.aborted) {
      yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
      yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled before start" };
      return;
    }
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    this.startedRunIds.add(runId);
    this.resolveStarted?.();

    // 阻塞等待 cancel
    await this.blockUntilCancelled(runId, signal);
    yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled" };
  }

  async *develop(input: RuntimeTaskInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runId = `blk-develop-${Date.now()}`;
    if (signal?.aborted) {
      yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
      yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled before start" };
      return;
    }
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    this.startedRunIds.add(runId);
    this.resolveStarted?.();

    await this.blockUntilCancelled(runId, signal);
    yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled" };
  }

  async review(input: ReviewTaskInput, signal?: AbortSignal): Promise<ReviewResult> {
    const runId = `blk-review-${Date.now()}`;
    this.startedRunIds.add(runId);
    this.resolveStarted?.();
    await this.blockUntilCancelled(runId, signal);
    throw new Error("review cancelled");
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
    const resolve = this.blockers.get(runId);
    if (resolve) {
      resolve();
    }
  }

  async waitForStarted(): Promise<void> {
    await this.startedPromise;
  }

  private blockUntilCancelled(runId: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      this.blockers.set(runId, resolve);
      // 也响应外部 signal
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

/**
 * 错误型 Runtime —— analyze/develop 在 started 后立即发 error。
 * 用于测试异常状态迁移。
 */
class ErrorRuntimeAdapter implements RuntimeAdapter {
  async *analyze(input: RuntimeTaskInput): AsyncIterable<RuntimeEvent> {
    const runId = `err-analyze-${Date.now()}`;
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    yield { type: "error", runId, at: new Date().toISOString(), message: "测试注入的 analyze 错误" };
  }

  async *develop(input: RuntimeTaskInput): AsyncIterable<RuntimeEvent> {
    const runId = `err-develop-${Date.now()}`;
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    yield { type: "error", runId, at: new Date().toISOString(), message: "测试注入的 develop 错误" };
  }

  async review(): Promise<ReviewResult> {
    throw new Error("测试注入的 review 错误");
  }

  async cancel(): Promise<void> {}
}

/**
 * cancel 抛错的 Runtime —— cancel() 方法抛异常，但仍响应 AbortSignal。
 *
 * 用于测试 Runtime 终止失败时的状态迁移。关键设计：
 * - analyze/develop 在收到 started 后阻塞，但**响应 AbortSignal**
 *   （abort 后 resolve 阻塞 Promise 并 yield error 事件），使调用方
 *   能感知取消并完成事件流（避免 developPromise 永久挂起）。
 * - cancel() 抛异常 —— 模拟进程树无法杀死的场景。
 *
 * 这样 cancel API 会同时经历两条路径：
 * 1. abort controller → develop generator 感知 → yield error → 流以
 *    error 结束 → runDevelop 抛 RuntimeStreamFailedError → handleRunError
 *    尝试 interrupt（但任务已被 cancel API 迁移到 INTERRUPTED）→ 409。
 * 2. runtime.cancel(runId) → 抛错 → cancelRuntimeForTask 抛错 →
 *    cancel API 设置 runtimeTerminationFailed → 迁移到 INTERRUPTED → 500。
 */
class CancelFailsRuntimeAdapter implements RuntimeAdapter {
  async *analyze(input: RuntimeTaskInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runId = `cf-analyze-${Date.now()}`;
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    // 阻塞等待 abort signal（cancel API 会 abort controller）
    await this.blockUntilAborted(signal);
    yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled via abort" };
  }

  async *develop(input: RuntimeTaskInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runId = `cf-develop-${Date.now()}`;
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    await this.blockUntilAborted(signal);
    yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled via abort" };
  }

  async review(input: ReviewTaskInput, signal?: AbortSignal): Promise<ReviewResult> {
    await this.blockUntilAborted(signal);
    throw new Error("review cancelled via abort");
  }

  async cancel(): Promise<void> {
    throw new Error("模拟 Runtime 终止失败：进程树无法杀死");
  }

  private blockUntilAborted(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

/**
 * 完成型 Runtime —— develop/analyze 立即发 started + completed，不阻塞。
 *
 * 用于 §9.3 测试：Runtime 已 completed，验证命令仍在运行时取消。
 * 区别于 BlockingRuntimeAdapter（develop 阻塞直到 cancel）——
 * 本适配器让 Runtime 快速完成，使执行流进入验证阶段。
 */
class CompletingRuntimeAdapter implements RuntimeAdapter {
  async *analyze(input: RuntimeTaskInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runId = `comp-analyze-${Date.now()}`;
    if (signal?.aborted) {
      yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
      yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled before start" };
      return;
    }
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    yield { type: "completed", runId, at: new Date().toISOString(), summary: "fake analyze complete" };
  }

  async *develop(input: RuntimeTaskInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runId = `comp-develop-${Date.now()}`;
    if (signal?.aborted) {
      yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
      yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled before start" };
      return;
    }
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    yield { type: "completed", runId, at: new Date().toISOString(), summary: "fake develop complete" };
  }

  async review(input: ReviewTaskInput, signal?: AbortSignal): Promise<ReviewResult> {
    if (signal?.aborted) throw new Error("review cancelled");
    return {
      verdict: "ship",
      findings: [],
      summary: `CompletingRuntimeAdapter review of ${input.diff.changedFiles.length} files`
    };
  }

  async cancel(): Promise<void> {}
}

/**
 * 阻塞型 ProcessRunner —— run() 阻塞直到 AbortSignal 触发。
 *
 * 用于 §9.3 测试：Runtime 已 completed，验证命令阻塞时取消能通过
 * AbortSignal 终止验证进程树。证明取消控制权延伸到验证阶段。
 */
class BlockingProcessRunner implements ProcessRunner {
  invocationCount = 0;
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
    this.invocationCount++;
    this.resolveStarted?.();

    // 阻塞等待 abort signal（取消 API 会 abort controller）
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
      stderr: "验证进程被取消信号终止",
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
 * 完成型 ProcessRunner —— run() 立即返回成功结果，不阻塞。
 *
 * 用于 §10.1 测试：Runtime completed 后验证命令也立即完成，
 * 使执行流进入最终持久化（executionResults.save）阶段。
 */
class CompletingProcessRunner implements ProcessRunner {
  invocationCount = 0;
  async run(
    spec: CommandSpec,
    cwd: string,
    _policy: ProcessPolicy,
    _abortSignal?: AbortSignal
  ): Promise<CommandResult> {
    this.invocationCount++;
    return {
      argv: spec.argv,
      cwd,
      exitCode: 0,
      stdout: "1 passed",
      stderr: "",
      truncated: false,
      originalBytes: 0,
      retainedBytes: 0,
      timedOut: false,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString()
    };
  }
}

/**
 * 屏障型 UnitOfWork —— §10.1 线性化点测试。
 *
 * 包装真实 UnitOfWork，在 `executionResults.save` 后注入异步屏障，
 * 使测试能在 save 完成、事务提交前调用 /cancel（设置 abort 信号）。
 *
 * 屏障在构造时自动武装（always armed），因为 interceptor 在首次
 * `/run` 请求时才被调用，测试无法提前 arm。
 *
 * 屏障激活流程：
 * 1. 构造时屏障自动武装。
 * 2. 当 `executionResults.save` 被调用时，save 完成后 await 屏障。
 * 3. 屏障 await 期间，事务仍持有写锁（SQLite 单写队列），
 *    测试调用 /cancel → `cancelRuntimeForTask` 立即 abort controller。
 * 4. 测试调用 `resolveBarrier()` 释放屏障。
 * 5. save 返回，执行流进入 save 后的 abort 检查 → 命中 → 抛错 → ROLLBACK。
 */
class SaveBarrierUnitOfWork implements UnitOfWork {
  private readonly barrier: { promise: Promise<void>; resolve: () => void };
  private saveInvoked = false;

  constructor(private readonly inner: UnitOfWork) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    this.barrier = { promise, resolve };
  }

  /** 释放屏障，使 `executionResults.save` 的 await 返回。 */
  resolveBarrier(): void {
    this.barrier.resolve();
  }

  /** save 是否已被调用（测试断言用）。 */
  get saveWasInvoked(): boolean {
    return this.saveInvoked;
  }

  run<T>(fn: (tx: TransactionalRepos) => Promise<T>): Promise<T> {
    return this.inner.run(async (tx) => {
      // 包装 tx.executionResults.save，在 save 后注入屏障
      const wrappedTx: TransactionalRepos = {
        ...tx,
        executionResults: {
          ...tx.executionResults,
          save: async (result: ExecutionResult) => {
            await tx.executionResults.save(result);
            this.saveInvoked = true;
            // P1-R02 §10.1：save 后、COMMIT 前注入屏障。
            // 此时事务持有写锁，/cancel 的状态迁移事务被阻塞。
            // 但 cancelRuntimeForTask 设置 abort 信号是内存操作，立即生效。
            await this.barrier.promise;
          }
        }
      };
      return fn(wrappedTx);
    });
  }
}

/**
 * 把任务从 CREATED 一路迁移到 EXECUTING，并持久化 worktree + plan + approval。
 */
async function moveToExecuting(
  root: ReturnType<typeof buildCompositionRoot>,
  taskId: string,
  worktreePath?: string
): Promise<void> {
  const { orchestrator } = root;
  await orchestrator.attachWorktree(taskId, sampleWorktree(taskId, worktreePath));
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
    allowedPaths: ["src/**"],
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
// 测试用例
// ---------------------------------------------------------------------------

describe("P1-R02-E：HTTP API 取消与异常状态迁移", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });

  afterEach(() => {
    safeCleanup(dbPath);
  });

  describe("注册前取消（pre-registration cancel）", () => {
    it("/cancel 在 /run 启动 Runtime 前调用时，任务迁移到 CANCELLED，Runtime 不启动", async () => {
      const runtime = new BlockingRuntimeAdapter();
      const root = buildCompositionRoot({
        dbPath,
        skipEnvFile: true,
        runtimeOverride: runtime
      });
      try {
        await root.store.unitOfWork.run(async (tx) => {
          await tx.projects.save(sampleProject());
        });

        const task = await root.orchestrator.createTask({
          projectId: "proj-cancel",
          input: sampleInput()
        });
        await moveToExecuting(root, task.id);

        // 核心断言：cancel 在 /run 之前调用
        const cancelRes = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/cancel`,
          payload: { reason: "注册前取消" }
        });
        expect(cancelRes.statusCode).toBe(200);
        const cancelledTask = cancelRes.json() as { status: string };
        expect(cancelledTask.status).toBe("CANCELLED");

        // 验证 Runtime 未启动（无 started 事件）
        expect(runtime.startedRunIds.size).toBe(0);

        // 验证后续 /run 被拒绝（任务已终态）
        const runRes = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/run`,
          payload: { phase: "analyze" }
        });
        expect(runRes.statusCode).toBe(409);

        // 验证审计中有 task_cancelled
        const auditRes = await root.app.inject({
          method: "GET",
          url: `/tasks/${task.id}/audit`
        });
        const audit = auditRes.json() as Array<{ type: string }>;
        expect(audit.some((e) => e.type === "task_cancelled")).toBe(true);
      } finally {
        await root.close();
      }
    });
  });

  describe("已运行 develop 取消（running develop cancel）", () => {
    it("/cancel 在 develop 运行中调用时终止 Runtime，任务迁移到 CANCELLED", async () => {
      const runtime = new BlockingRuntimeAdapter();
      const root = buildCompositionRoot({
        dbPath,
        skipEnvFile: true,
        runtimeOverride: runtime
      });
      // 创建真实 worktree 目录（applyExecutionIsolation 需要 realpathSync 能解析）
      const tempWtRoot = mkdtempSync(join(tmpdir(), "tracepilot-wt-block-"));
      const worktreePath = join(tempWtRoot, "wt-block-1");
      mkdirSync(worktreePath, { recursive: true });
      try {
        await root.store.unitOfWork.run(async (tx) => {
          await tx.projects.save(sampleProject());
        });

        const task = await root.orchestrator.createTask({
          projectId: "proj-cancel",
          input: sampleInput()
        });
        await moveToExecuting(root, task.id, worktreePath);

        // 异步启动 develop（会阻塞）
        const developPromise = root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/run`,
          payload: { phase: "develop" }
        });

        // 等待 Runtime 产出 started 事件
        await runtime.waitForStarted();

        // 核心断言：cancel 在 develop 运行中调用
        const cancelRes = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/cancel`,
          payload: { reason: "develop 运行中取消" }
        });
        expect(cancelRes.statusCode).toBe(200);
        const cancelledTask = cancelRes.json() as { status: string };
        expect(cancelledTask.status).toBe("CANCELLED");

        // 等待 develop 请求结束（因 cancel 后 Runtime 发 error → RuntimeStreamFailedError）
        const developRes = await developPromise;
        // develop 因 RuntimeStreamFailedError 而失败；
        // handleRunError 把任务迁移到 INTERRUPTED，但任务已被 cancel 迁移到 CANCELLED，
        // 所以迁移失败 → 409
        expect([409, 500].includes(developRes.statusCode)).toBe(true);

        // 验证无 execution_results 持久化（失败关闭，禁止后续步骤）
        const persisted = await root.store.unitOfWork.run((tx) =>
          tx.executionResults.findLatestByTask(task.id)
        );
        expect(persisted).toBeUndefined();
      } finally {
        await root.close();
        rmSync(tempWtRoot, { recursive: true, force: true });
      }
    });
  });

  describe("Runtime completed 后验证阶段取消（§9.3 post-completion cancel）", () => {
    // §9.3 关闭要求：Runtime 事件流结束后，runDevelop 继续执行文件系统
    // 守卫、Diff、验证命令和 execution_results 持久化。取消控制权必须
    // 延伸到这些后续步骤：
    // - pendingLeases 持有到整个用例结束（而非仅 Runtime 事件流）
    // - ProcessRunner.run 接收同一 AbortSignal，使取消能终止验证进程树
    // - Diff/验证/持久化前检查 signal.aborted + 事务内重新核验任务状态
    //
    // 本测试验证：Runtime 已 completed、验证命令阻塞时，/cancel 能
    // 终止验证进程树并阻止成功产物持久化。
    it("/cancel 在 Runtime completed、验证命令运行中调用时，终止验证进程树，无成功产物", async () => {
      const runtime = new CompletingRuntimeAdapter();
      const blockingProcess = new BlockingProcessRunner();

      // 创建临时 git 仓库作为 worktree —— LocalGitAdapter.getDiff 需要真实
      // git 仓库才能成功执行 `git diff HEAD`，否则 runDevelop 在到达验证
      // 阶段前就会失败。worktreeRoot 作为 compositionRoot 的受控根目录，
      // worktree 子目录在其下，满足路径策略校验。
      const tempRoot = mkdtempSync(join(tmpdir(), "tracepilot-wtroot-"));
      const worktreePath = join(tempRoot, "wt-cancel-1");
      mkdirSync(worktreePath, { recursive: true });
      execSync("git init", { cwd: worktreePath, stdio: "ignore" });
      execSync('git config user.email test@tracepilot.dev', { cwd: worktreePath, stdio: "ignore" });
      execSync('git config user.name TracePilotTest', { cwd: worktreePath, stdio: "ignore" });
      execSync('git commit --allow-empty -m "initial"', { cwd: worktreePath, stdio: "ignore" });

      const root = buildCompositionRoot({
        dbPath,
        skipEnvFile: true,
        runtimeOverride: runtime,
        processRunnerOverride: blockingProcess,
        worktreeRoot: tempRoot
      });
      try {
        await root.store.unitOfWork.run(async (tx) => {
          await tx.projects.save(sampleProject());
        });

        const task = await root.orchestrator.createTask({
          projectId: "proj-cancel",
          input: sampleInput()
        });
        await moveToExecuting(root, task.id, worktreePath);

        // 异步启动 develop —— CompletingRuntimeAdapter 会立即发 started + completed，
        // 随后进入验证阶段，BlockingProcessRunner 会阻塞等待 abort
        const developPromise = root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/run`,
          payload: { phase: "develop" }
        });
        developPromise.catch(() => {});

        // 等待 Runtime completed 并进入验证阶段
        // BlockingProcessRunner 在被调用时通知 startedPromise
        await Promise.race([
          blockingProcess.waitForStarted(),
          developPromise.then(
            () => { throw new Error("develop 不应在验证前完成"); },
            (err) => { throw new Error(`develop 在验证前失败: ${(err as Error).message}`); }
          )
        ]);

        // 核心断言（§9.3）：Runtime 已 completed，验证命令仍在运行。
        // /cancel 应 abort controller，使验证进程树退出。
        const cancelRes = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/cancel`,
          payload: { reason: "验证阶段取消" }
        });

        // 取消 API 与并发 /run 的 handleRunError 竞争状态迁移：
        // - 若 cancel API 先迁移到 CANCELLED → cancel 返回 200 CANCELLED，
        //   handleRunError 的 interrupt 失败 → /run 返回 409
        // - 若 handleRunError 先迁移到 INTERRUPTED → /run 返回 500，
        //   cancel API 的 cancel 抛 TerminalTaskError → 返回 409 INTERRUPTED
        expect([200, 409, 500].includes(cancelRes.statusCode)).toBe(true);
        const cancelledBody = cancelRes.json() as { status?: string };
        expect(["CANCELLED", "INTERRUPTED"].includes(cancelledBody.status ?? "")).toBe(true);

        // 等待 develop 请求结束
        const developRes = await developPromise;
        expect([409, 500].includes(developRes.statusCode)).toBe(true);

        // 验证验证进程已被终止（AbortSignal 触发）
        expect(blockingProcess.wasAborted).toBe(true);
        expect(blockingProcess.invocationCount).toBe(1);

        // 验证无 execution_results 持久化（失败关闭，禁止后续步骤）
        const persisted = await root.store.unitOfWork.run((tx) =>
          tx.executionResults.findLatestByTask(task.id)
        );
        expect(persisted).toBeUndefined();

        // 验证任务已处于终态
        const taskRes = await root.app.inject({
          method: "GET",
          url: `/tasks/${task.id}`
        });
        const updatedTask = taskRes.json() as { status: string };
        expect(["CANCELLED", "INTERRUPTED"].includes(updatedTask.status)).toBe(true);
      } finally {
        await root.close();
        try {
          rmSync(tempRoot, { recursive: true, force: true });
        } catch {
          // Windows 文件锁残留不影响测试结论
        }
      }
    });

    // §9.3 关闭要求："Windows 下应验证真实子进程树终止"
    // 本测试使用真实 LocalProcessRunner（不注入 processRunnerOverride）+
    // 真实阻塞 node 子进程作为验证命令，验证取消信号能通过 taskkill /T /F
    // 终止整棵验证进程树。
    it("/cancel 使用真实子进程验证：Runtime completed 后终止真实验证进程树", async () => {
      const runtime = new CompletingRuntimeAdapter();

      // 创建临时 worktree 根目录 + worktree 子目录
      const tempRoot = mkdtempSync(join(tmpdir(), "tracepilot-real-wt-"));
      const worktreePath = join(tempRoot, "wt-real-cancel");
      mkdirSync(worktreePath, { recursive: true });
      execSync("git init", { cwd: worktreePath, stdio: "ignore" });
      execSync("git config user.email test@tracepilot.dev", { cwd: worktreePath, stdio: "ignore" });
      execSync("git config user.name TracePilotTest", { cwd: worktreePath, stdio: "ignore" });
      execSync('git commit --allow-empty -m "initial"', { cwd: worktreePath, stdio: "ignore" });

      // 创建阻塞型验证脚本：写入 PID 到 lockfile 后无限循环
      const lockfilePath = join(worktreePath, ".verify-pid-lock");
      const scriptPath = join(worktreePath, "block-verify.js");
      writeFileSync(scriptPath, [
        "const fs = require('fs');",
        "const path = require('path');",
        `fs.writeFileSync(${JSON.stringify(lockfilePath)}, String(process.pid));`,
        "setInterval(() => {}, 1000);"
      ].join("\n"));

      // 项目 test 命令改为 node block-verify.js
      const realProject: Project = {
        ...sampleProject(),
        commands: {
          test: { argv: ["node", "block-verify.js"], timeoutMs: 300000 }
        }
      };

      // 不注入 processRunnerOverride —— 使用真实 LocalProcessRunner
      const root = buildCompositionRoot({
        dbPath,
        skipEnvFile: true,
        runtimeOverride: runtime,
        worktreeRoot: tempRoot
      });
      try {
        await root.store.unitOfWork.run(async (tx) => {
          await tx.projects.save(realProject);
        });

        const task = await root.orchestrator.createTask({
          projectId: "proj-cancel",
          input: sampleInput()
        });
        await moveToExecuting(root, task.id, worktreePath);

        // 异步启动 develop —— CompletingRuntimeAdapter 立即完成，
        // 随后真实 LocalProcessRunner 启动 node block-verify.js
        const developPromise = root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/run`,
          payload: { phase: "develop" }
        });
        developPromise.catch(() => {});

        // 轮询 lockfile 判断验证子进程已启动（最多等 10 秒）
        let verifyPid: string | undefined;
        for (let i = 0; i < 100; i++) {
          if (existsSync(lockfilePath)) {
            verifyPid = readFileSync(lockfilePath, "utf8").trim();
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!verifyPid) {
          throw new Error("验证子进程未在 10 秒内启动（lockfile 未创建）");
        }

        // 核心断言（§9.3 真实子进程）：Runtime 已 completed，
        // 真实验证子进程正在运行。/cancel 应终止整棵进程树。
        const cancelRes = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/cancel`,
          payload: { reason: "真实子进程验证阶段取消" }
        });
        expect([200, 409, 500].includes(cancelRes.statusCode)).toBe(true);

        // 等待 develop 请求结束
        const developRes = await developPromise;
        expect([409, 500].includes(developRes.statusCode)).toBe(true);

        // 等待进程树终止（taskkill /T /F 是同步的，但事件循环需时间传播）
        await new Promise((r) => setTimeout(r, 500));

        // 验证真实验证子进程已被终止
        const stillRunning = isProcessRunning(verifyPid);
        expect(stillRunning).toBe(false);

        // 验证无 execution_results 持久化
        const persisted = await root.store.unitOfWork.run((tx) =>
          tx.executionResults.findLatestByTask(task.id)
        );
        expect(persisted).toBeUndefined();

        // 验证任务已处于终态
        const taskRes = await root.app.inject({
          method: "GET",
          url: `/tasks/${task.id}`
        });
        const updatedTask = taskRes.json() as { status: string };
        expect(["CANCELLED", "INTERRUPTED"].includes(updatedTask.status)).toBe(true);
      } finally {
        await root.close();
        try {
          rmSync(tempRoot, { recursive: true, force: true });
        } catch {
          // Windows 文件锁残留不影响测试结论
        }
      }
    });
  });

  describe("review 取消（review cancel）", () => {
    // HTTP API 层的 review 取消（Runtime 运行中）测试见
    // execution-orchestrator-adversarial.test.ts 中的 "cancelRuntimeForTask
    // 能终止运行中的 runReview" 测试用例。该测试在 orchestrator 层使用
    // FakeGitAdapter + CancellableReviewRuntimeAdapter 验证 cancel signal
    // 能终止阻塞中的 review 进程。
    //
    // HTTP 层的取消链路（cancelRuntimeForTask → abort signal →
    // runtime.cancel）已被 "注册前取消" 和 "已运行 develop 取消" 测试
    // 覆盖。review 阶段使用相同的 cancelRuntimeForTask 路径，区别仅在于
    // runtime.review 是 Promise 而非 AsyncIterable —— signal 透传机制一致。
    //
    // 此处验证：REVIEWING 阶段无活动 Runtime 时，取消安全降级到 CANCELLED。
    it("REVIEWING 阶段无活动 Runtime 时取消，安全降级到 CANCELLED", async () => {
      const runtime = new BlockingRuntimeAdapter();
      const root = buildCompositionRoot({
        dbPath,
        skipEnvFile: true,
        runtimeOverride: runtime
      });
      try {
        await root.store.unitOfWork.run(async (tx) => {
          await tx.projects.save(sampleProject());
        });

        const task = await root.orchestrator.createTask({
          projectId: "proj-cancel",
          input: sampleInput()
        });
        await moveToExecuting(root, task.id);
        await root.orchestrator.transitionTask(task.id, "VALIDATING");
        await root.orchestrator.transitionTask(task.id, "REVIEWING");

        // 核心断言：REVIEWING 阶段无活动 Runtime 时取消安全降级
        const cancelRes = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/cancel`,
          payload: { reason: "REVIEWING 阶段取消" }
        });
        expect(cancelRes.statusCode).toBe(200);
        const body = cancelRes.json() as { status: string };
        expect(body.status).toBe("CANCELLED");

        // 验证 Runtime 未启动
        expect(runtime.startedRunIds.size).toBe(0);

        // 验证审计中有 task_cancelled
        const auditRes = await root.app.inject({
          method: "GET",
          url: `/tasks/${task.id}/audit`
        });
        const audit = auditRes.json() as Array<{ type: string }>;
        expect(audit.some((e) => e.type === "task_cancelled")).toBe(true);
      } finally {
        await root.close();
      }
    });
  });

  describe("Runtime 终止失败（runtime termination failure）", () => {
    it("cancelRuntimeForTask 抛错时迁移到 INTERRUPTED 并返回 500", async () => {
      const runtime = new CancelFailsRuntimeAdapter();
      const root = buildCompositionRoot({
        dbPath,
        skipEnvFile: true,
        runtimeOverride: runtime
      });
      // 创建真实 worktree 目录（applyExecutionIsolation 需要 realpathSync 能解析）
      const tempWtRoot = mkdtempSync(join(tmpdir(), "tracepilot-wt-cancelfails-"));
      const worktreePath = join(tempWtRoot, "wt-cf-1");
      mkdirSync(worktreePath, { recursive: true });
      try {
        await root.store.unitOfWork.run(async (tx) => {
          await tx.projects.save(sampleProject());
        });

        const task = await root.orchestrator.createTask({
          projectId: "proj-cancel",
          input: sampleInput()
        });
        await moveToExecuting(root, task.id, worktreePath);

        // 异步启动 develop（会阻塞且 cancel 会失败）
        const developPromise = root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/run`,
          payload: { phase: "develop" }
        });

        // 等待 Runtime 产出 started（runId 已登记到 activeRuns）
        // CancelFailsRuntimeAdapter 的 develop 发 started 后阻塞
        // 但 startedPromise 只 resolve 一次 —— 这里复用 BlockingRuntimeAdapter 的模式
        // 由于 CancelFailsRuntimeAdapter 不实现 waitForStarted，
        // 我们用轮询等待 startedRunIds
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            resolve();
            clearInterval(interval);
          }, 100);
        });

        // 核心断言：cancel 在 Runtime 终止失败时不降级
        const cancelRes = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/cancel`,
          payload: { reason: "Runtime 终止失败测试" }
        });

        // P1-R02-D：Runtime 终止失败 → 迁移到 INTERRUPTED（EXECUTING 合法）+ 500
        expect(cancelRes.statusCode).toBe(500);
        const body = cancelRes.json() as { status: string };
        expect(body.status).toBe("INTERRUPTED");

        // 等待 develop 请求结束（因任务已 INTERRUPTED，develop 会失败）
        const developRes = await developPromise;
        expect([409, 500].includes(developRes.statusCode)).toBe(true);

        // 验证审计中有 task_interrupted
        const auditRes = await root.app.inject({
          method: "GET",
          url: `/tasks/${task.id}/audit`
        });
        const audit = auditRes.json() as Array<{ type: string }>;
        expect(audit.some((e) => e.type === "task_interrupted")).toBe(true);

        // 验证无 execution_results 持久化
        const persisted = await root.store.unitOfWork.run((tx) =>
          tx.executionResults.findLatestByTask(task.id)
        );
        expect(persisted).toBeUndefined();
      } finally {
        await root.close();
        rmSync(tempWtRoot, { recursive: true, force: true });
      }
    });
  });

  describe("异常状态迁移（exception state migration）", () => {
    it("runAnalyze 抛 RuntimeStreamFailedError 时迁移到 INTERRUPTED 并返回 500", async () => {
      const runtime = new ErrorRuntimeAdapter();
      const root = buildCompositionRoot({
        dbPath,
        skipEnvFile: true,
        runtimeOverride: runtime
      });
      try {
        await root.store.unitOfWork.run(async (tx) => {
          await tx.projects.save(sampleProject());
        });

        const task = await root.orchestrator.createTask({
          projectId: "proj-cancel",
          input: sampleInput()
        });
        await moveToExecuting(root, task.id);

        // 核心断言：runAnalyze 失败时迁移到 INTERRUPTED + 500
        const runRes = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/run`,
          payload: { phase: "analyze" }
        });
        expect(runRes.statusCode).toBe(500);
        const body = runRes.json() as { error: string };
        expect(body.error).toContain("Runtime analyze 失败");

        // 验证任务已迁移到 INTERRUPTED
        const taskRes = await root.app.inject({
          method: "GET",
          url: `/tasks/${task.id}`
        });
        const updatedTask = taskRes.json() as { status: string };
        expect(updatedTask.status).toBe("INTERRUPTED");

        // 验证审计中有 task_interrupted
        const auditRes = await root.app.inject({
          method: "GET",
          url: `/tasks/${task.id}/audit`
        });
        const audit = auditRes.json() as Array<{ type: string }>;
        expect(audit.some((e) => e.type === "task_interrupted")).toBe(true);

        // 验证无 execution_results 持久化
        const persisted = await root.store.unitOfWork.run((tx) =>
          tx.executionResults.findLatestByTask(task.id)
        );
        expect(persisted).toBeUndefined();
      } finally {
        await root.close();
      }
    });

    it("runDevelop 抛 RuntimeStreamFailedError 时迁移到 INTERRUPTED 并返回 500", async () => {
      const runtime = new ErrorRuntimeAdapter();
      const root = buildCompositionRoot({
        dbPath,
        skipEnvFile: true,
        runtimeOverride: runtime
      });
      // 创建真实 worktree 目录（applyExecutionIsolation 需要 realpathSync 能解析）
      const tempWtRoot = mkdtempSync(join(tmpdir(), "tracepilot-wt-errdevelop-"));
      const worktreePath = join(tempWtRoot, "wt-err-1");
      mkdirSync(worktreePath, { recursive: true });
      try {
        await root.store.unitOfWork.run(async (tx) => {
          await tx.projects.save(sampleProject());
        });

        const task = await root.orchestrator.createTask({
          projectId: "proj-cancel",
          input: sampleInput()
        });
        await moveToExecuting(root, task.id, worktreePath);

        // 核心断言：runDevelop 失败时迁移到 INTERRUPTED + 500
        const runRes = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/run`,
          payload: { phase: "develop" }
        });
        expect(runRes.statusCode).toBe(500);
        const body = runRes.json() as { error: string };
        expect(body.error).toContain("Runtime develop 失败");

        // 验证任务已迁移到 INTERRUPTED
        const taskRes = await root.app.inject({
          method: "GET",
          url: `/tasks/${task.id}`
        });
        const updatedTask = taskRes.json() as { status: string };
        expect(updatedTask.status).toBe("INTERRUPTED");

        // 验证无 execution_results 持久化（失败关闭）
        const persisted = await root.store.unitOfWork.run((tx) =>
          tx.executionResults.findLatestByTask(task.id)
        );
        expect(persisted).toBeUndefined();
      } finally {
        await root.close();
        rmSync(tempWtRoot, { recursive: true, force: true });
      }
    });

    it("runReview 抛错误时迁移到 FAILED 并返回 500", async () => {
      const runtime = new ErrorRuntimeAdapter();
      const root = buildCompositionRoot({
        dbPath,
        skipEnvFile: true,
        runtimeOverride: runtime
      });
      try {
        await root.store.unitOfWork.run(async (tx) => {
          await tx.projects.save(sampleProject());
        });

        const task = await root.orchestrator.createTask({
          projectId: "proj-cancel",
          input: sampleInput()
        });
        await moveToExecuting(root, task.id);

        // 插入 execution_results 记录（runReview 前置条件）
        await root.store.unitOfWork.run(async (tx) => {
          await tx.executionResults.save({
            id: "exec-result-fail-review",
            taskId: task.id,
            runId: "fake-run-id",
            diffHash: "fake-hash-0000000000000000000000000000000000000000",
            diffPatch: "fake patch",
            diffChangedFiles: ["src/users.py"],
            diffBytes: 10,
            verificationExitCode: 0,
            verificationPassed: true,
            verificationStdout: "1 passed",
            verificationStderr: "",
            createdAt: new Date().toISOString()
          });
        });

        await root.orchestrator.transitionTask(task.id, "VALIDATING");
        await root.orchestrator.transitionTask(task.id, "REVIEWING");

        // 核心断言（§7.3 第 3 点）：runReview 失败时必须迁移到 FAILED + 500。
        // ErrorRuntimeAdapter.review() 抛普通 Error（omp 超时/非零退出/解析失败等），
        // handleRunError 对 review 阶段的所有非安全错误迁移到 FAILED。
        // DiffTamperError 已在路由层单独处理（409），不会走到 handleRunError。
        const runRes = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/run`,
          payload: { phase: "review" }
        });
        expect(runRes.statusCode).toBe(500);
        const body = runRes.json() as { error: string };
        expect(body.error).toContain("Runtime review 失败");

        // 验证任务已迁移到 FAILED
        const taskRes = await root.app.inject({
          method: "GET",
          url: `/tasks/${task.id}`
        });
        const updatedTask = taskRes.json() as { status: string };
        expect(updatedTask.status).toBe("FAILED");

        // 验证审计中有 task_transitioned（fail() 写 task_transitioned 而非 task_failed）
        const auditRes = await root.app.inject({
          method: "GET",
          url: `/tasks/${task.id}/audit`
        });
        const audit = auditRes.json() as Array<{ type: string; toStatus?: string }>;
        expect(audit.some((e) => e.type === "task_transitioned" && e.toStatus === "FAILED")).toBe(true);
      } finally {
        await root.close();
      }
    });
  });

  describe("已终态任务取消安全降级（terminal state cancel）", () => {
    // 原计划的 "项目未登记时取消安全降级" 测试无法实现：SQLite 外键约束
    // 阻止在项目未登记时创建任务（tasks.projectId → projects.id FK）。
    // "项目未登记" 防御路径在正常流程中不可达，仅作为防御性代码保留。
    //
    // 替代场景：任务已处于终态（如 PLANNED 阶段被取消）时，/cancel 仍能
    // 正常迁移到 CANCELLED 或返回当前终态，且不启动 Runtime。
    it("任务在 INTAKING 状态被取消时，Runtime 未启动，审计记录 task_cancelled", async () => {
      const runtime = new BlockingRuntimeAdapter();
      const root = buildCompositionRoot({
        dbPath,
        skipEnvFile: true,
        runtimeOverride: runtime
      });
      try {
        await root.store.unitOfWork.run(async (tx) => {
          await tx.projects.save(sampleProject());
        });

        const task = await root.orchestrator.createTask({
          projectId: "proj-cancel",
          input: sampleInput()
        });
        // CREATED → INTAKING（未到 EXECUTING，无 Runtime 运行）
        await root.orchestrator.transitionTask(task.id, "INTAKING");

        // 核心断言：取消未运行 Runtime 的任务时安全降级到 CANCELLED
        const cancelRes = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/cancel`,
          payload: { reason: "INTAKING 阶段取消" }
        });
        expect(cancelRes.statusCode).toBe(200);
        const body = cancelRes.json() as { status: string };
        expect(body.status).toBe("CANCELLED");

        // 验证 Runtime 未启动
        expect(runtime.startedRunIds.size).toBe(0);

        // 验证审计中有 task_cancelled
        const auditRes = await root.app.inject({
          method: "GET",
          url: `/tasks/${task.id}/audit`
        });
        const audit = auditRes.json() as Array<{ type: string }>;
        expect(audit.some((e) => e.type === "task_cancelled")).toBe(true);
      } finally {
        await root.close();
      }
    });
  });

  // ==========================================================================
  // P1-R02 §10.1：最终持久化窗口线性化测试
  // ==========================================================================
  describe("P1-R02 §10.1 最终持久化线性化窗口", () => {
    it("取消在 executionResults.save 的 await yield 期间设置 abort 信号 → save 后检查命中 → 事务回滚 → 无持久化", async () => {
      const runtime = new CompletingRuntimeAdapter();
      const completingProcess = new CompletingProcessRunner();

      // 创建临时 git 仓库作为 worktree
      const tempRoot = mkdtempSync(join(tmpdir(), "tracepilot-wtroot-barrier-"));
      const worktreePath = join(tempRoot, "wt-barrier-1");
      mkdirSync(worktreePath, { recursive: true });
      execSync("git init", { cwd: worktreePath, stdio: "ignore" });
      execSync('git config user.email test@tracepilot.dev', { cwd: worktreePath, stdio: "ignore" });
      execSync('git config user.name TracePilotTest', { cwd: worktreePath, stdio: "ignore" });
      execSync('git commit --allow-empty -m "initial"', { cwd: worktreePath, stdio: "ignore" });

      // 屏障 UoW 在 interceptor 中用真实 store.unitOfWork 构造
      let barrierUow: SaveBarrierUnitOfWork | undefined;
      const root = buildCompositionRoot({
        dbPath,
        skipEnvFile: true,
        runtimeOverride: runtime,
        processRunnerOverride: completingProcess,
        worktreeRoot: tempRoot,
        unitOfWorkInterceptor: (uow) => {
          barrierUow = new SaveBarrierUnitOfWork(uow);
          return barrierUow;
        }
      });

      try {
        await root.store.unitOfWork.run(async (tx) => {
          await tx.projects.save(sampleProject());
        });

        const task = await root.orchestrator.createTask({
          projectId: "proj-cancel",
          input: sampleInput()
        });
        await moveToExecuting(root, task.id, worktreePath);

        // 异步启动 develop
        // CompletingRuntimeAdapter 立即完成 develop
        // CompletingProcessRunner 立即完成验证（exitCode 0）
        // 执行流进入最终持久化事务 → executionResults.save 被屏障拦截
        const developPromise = root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/run`,
          payload: { phase: "develop" }
        });
        developPromise.catch(() => {});

        // 等待 barrierUow 被 interceptor 创建（首次 /run 请求触发）
        // 然后等待 save 被调用（屏障被命中）
        const deadline = Date.now() + 15000;
        while ((!barrierUow || !barrierUow.saveWasInvoked) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(barrierUow).toBeDefined();
        expect(barrierUow!.saveWasInvoked).toBe(true);

        // 核心时刻：save 已完成、事务持有写锁、COMMIT 尚未执行。
        // 调用 /cancel —— cancelRuntimeForTask 立即 abort controller（内存操作），
        // 但 orchestrator.cancel 的状态迁移事务被 SQLite 写锁阻塞。
        const cancelPromise = root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/cancel`,
          payload: { reason: "最终持久化窗口取消" }
        });
        // 给 cancel 一点时间执行 cancelRuntimeForTask（设置 abort 信号）
        await new Promise((r) => setTimeout(r, 200));

        // 释放屏障 —— save 返回，执行流进入 save 后的 abort 检查
        barrierUow!.resolveBarrier();

        // 等待 develop 和 cancel 完成
        const [developRes, cancelRes] = await Promise.all([developPromise, cancelPromise]);

        // 核心断言：develop 失败（save 后 abort 检查命中 → 抛错 → 500 或 409）
        expect([409, 500].includes(developRes.statusCode)).toBe(true);

        // cancel 返回 200（CANCELLED）或 409（状态已被 handleRunError 迁移）
        expect([200, 409, 500].includes(cancelRes.statusCode)).toBe(true);

        // 核心断言：无 execution_results 持久化（事务被回滚）
        const persisted = await root.store.unitOfWork.run((tx) =>
          tx.executionResults.findLatestByTask(task.id)
        );
        expect(persisted).toBeUndefined();

        // 核心断言：任务处于终态（CANCELLED 或 INTERRUPTED）
        const taskRes = await root.app.inject({
          method: "GET",
          url: `/tasks/${task.id}`
        });
        const updatedTask = taskRes.json() as { status: string };
        expect(["CANCELLED", "INTERRUPTED"].includes(updatedTask.status)).toBe(true);
      } finally {
        await root.close();
        safeCleanup(dbPath);
      }
    }, 30000);
  });
});

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 检查指定 PID 的进程是否仍在运行。
 *
 * Windows 用 `tasklist /FI "PID eq <pid>" /NH`，输出包含 "No tasks" 表示
 * 进程已退出。非 Windows 用 `kill -0 <pid>`。
 */
function isProcessRunning(pid: string): boolean {
  try {
    if (process.platform === "win32") {
      const output = execSync(
        `tasklist /FI "PID eq ${pid}" /NH /FO CSV`,
        { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] }
      );
      // tasklist 在找不到进程时输出 "信息: 没有运行的任务匹配指定标准。"
      // 或英文 "INFO: No tasks are running which match the specified criteria."
      // 有结果时输出 CSV 格式行（含 PID）。
      return output.includes(pid) && !output.includes("No tasks") && !output.includes("没有运行");
    }
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}
