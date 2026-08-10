/**
 * ExecutionOrchestrator —— Phase 4 真实修复闭环接线层。
 *
 * TaskOrchestrator 只管状态机迁移与审计；本服务把 RuntimeAdapter 的
 * analyze / develop / review 与任务状态机、worktree、证据缓冲、验证
 * 命令串成完整闭环。它是系统中唯一调用 RuntimeAdapter 方法的组件
 * （测试中的 FakeRuntimeAdapter 除外）。
 *
 * 三条编排链路（对应规格 Phase 4 退出条件）：
 * - runAnalyze：在 GATHERING_EVIDENCE 调用 runtime.analyze，流式事件
 *   经 RuntimeEventSink 缓冲并落库到 agent_runs。
 * - runDevelop：在 EXECUTING 调用 runtime.develop 修改 worktree 文件，
 *   随后 captureDiffForTask 获取 Patch，再跑项目 test 命令做验证。
 * - runReview：在 REVIEWING 调用 runtime.review，基于 diff + 验证结果
 *   产出 ReviewResult。
 *
 * 依赖方向：本文件位于 core，只依赖 ports（RuntimeAdapter / ProcessRunner
 * / UnitOfWork）与同层的 WorktreeManager + RuntimeEventSink 接口，不依赖
 * Fastify / Drizzle / omp / React。
 *
 * **P1-R01（Phase 4 第二轮验收 §6.2）**：`runDevelop` 在取得 Diff 后
 * 必须校验 `diff.changedFiles` 全部落在 `Plan.allowedPaths` 内；任何
 * 越界变更必须失败关闭，禁止验证、持久化与 Review，并写 `policy_denied`
 * 审计事件。此为核心层强制边界，与 OmpAdapter 在执行期的写入隔离互补。
 *
 * **P1-R02（Phase 4 第三轮验收 §7.3）**：
 * - `runAnalyze`/`runDevelop` 必须检查事件流是否出现 `error` 或未以
 *   `completed` 结束；任一条件命中均失败关闭，禁止后续步骤继续执行。
 * - 引入 `pendingLeases: Map<taskId, AbortController>` 解决注册前竞态：
 *   在 Runtime 产出 `started` 事件前，取消 API 就能通过 abort signal
 *   阻止 Runtime 启动。`activeRuns` 仍用于 `started` 事件后的 runId 登记。
 * - `runReview` 也接受 signal，使取消 API 能终止 REVIEWING 阶段的 review
 *   进程（§7.3 第 2 点）。
 * - `cancelRuntimeForTask` 同时检查 `pendingLeases` 和 `activeRuns`，
 *   先 abort pendingLeases 中的 controller，再调用 `runtime.cancel(runId)`
 *   终止已启动的 Runtime。
 */

import type { RuntimeEvent, RuntimeAdapter, RuntimeTaskInput, ReviewTaskInput, ReviewResult, ProcessRunner, ProcessPolicy, DiffArtifact } from "../ports/adapters.js";
import type { WorktreeFilesystemGuard, FilesystemSnapshot, FilesystemChange, ExecutionIsolationLease, SymlinkEscapeWatcher } from "../ports/worktree-filesystem-guard.js";
import type { WorktreeManager } from "./worktree-manager.js";
import type { UnitOfWork } from "../ports/repositories.js";
import type { Task, Plan, TaskStatus } from "../domain/task.js";
import type { Project } from "../domain/project.js";
import type { EvidencePack } from "../domain/evidence.js";
import { computePackContentHash } from "../domain/evidence.js";
import type { AgentRunRecord } from "../domain/agent-run.js";
import type { ExecutionResult } from "../domain/execution-result.js";
import type { Worktree } from "../ports/adapters.js";
import { createAuditEvent, randomId } from "../domain/audit.js";
import type {
  HumanDecisionFinalizationGuard,
  HumanDecisionFinalizationInput
} from "../ports/human-decision-finalization.js";

/**
 * RuntimeEventSink —— core 层定义的事件缓冲接口。
 *
 * store 层的 RuntimeEventBuffer 实现此接口。ExecutionOrchestrator
 * 依赖此接口而非具体实现，保持依赖方向（core 不依赖 store）。
 */
export interface RuntimeEventSink {
  append(taskId: string, runId: string, role: string, event: RuntimeEvent): void;
  flush(taskId: string, runId: string): Promise<AgentRunRecord | undefined>;
}

export interface ExecutionOrchestratorDeps {
  readonly unitOfWork: UnitOfWork;
  readonly runtime: RuntimeAdapter;
  readonly worktreeManager: WorktreeManager;
  readonly eventSink: RuntimeEventSink;
  readonly processRunner: ProcessRunner;
  readonly processPolicy: ProcessPolicy;
  /**
   * P1-R01（Phase 4 第三轮验收 §7.2）：worktree 文件系统守卫。
   *
   * `runDevelop` 在调用 `runtime.develop` 前创建快照，develop 完成后
   * 重新快照并检测变更。对越界变更（不在 `Plan.allowedPaths` 内的
   * 新增/修改/删除/类型变化）必须：
   * 1. 调用 `rollback` 将 worktree 恢复到 develop 前状态；
   * 2. 写 `policy_denied` 审计事件（独立事务，不被上层 ROLLBACK 回滚）；
   * 3. 抛 `PathScopeViolationError`，禁止验证、持久化与 Review。
   *
   * 这是 §7.2 第 2 点要求的"隔离/恢复策略"：越权改动在进入后续操作前
   * 被检测并回滚。与 §7.2 第 1 点的执行期写入隔离互补。
   *
   * 可选：若未提供，`runDevelop` 不做文件系统快照，仅依赖 Diff 后置
   * 校验（§7.2 第 2 点的 fallback）。生产环境必须注入此依赖。
   */
  readonly filesystemGuard?: WorktreeFilesystemGuard;
  /**
   * 仅用于确定性竞态测试：在最后一次提交前 Diff 捕获后暂停或注入改动。
   * 生产装配必须留空。
   */
  readonly approvalFinalizationHook?: (input: {
    readonly taskId: string;
    readonly diffHash: string;
  }) => Promise<void>;
}

/** runAnalyze 返回值。 */
export interface AnalyzeRunResult {
  readonly runId: string;
  readonly eventCount: number;
  readonly summary: string | undefined;
  readonly agentRun: AgentRunRecord | undefined;
}

/** runDevelop 返回值。 */
export interface DevelopRunResult {
  readonly runId: string;
  readonly eventCount: number;
  readonly summary: string | undefined;
  readonly agentRun: AgentRunRecord | undefined;
  readonly diff: DiffArtifact;
  /** 验证命令的退出码；0 表示测试通过。 */
  readonly verificationExitCode: number;
  readonly verificationStdout: string;
  readonly verificationStderr: string;
  readonly verificationPassed: boolean;
}

/** 从 unitOfWork 加载 task + worktree + plan + project 的辅助结构。 */
interface TaskContext {
  readonly task: Task;
  readonly worktree: Worktree;
  readonly plan: Plan;
  readonly project: Project;
  readonly evidencePack: EvidencePack;
}

/**
 * 加载任务上下文：task → worktree（task.worktreeId）→ plan（task.currentPlanId）
 * → project（task.projectId）。任一缺失则抛错。
 */
async function loadTaskContext(tx: import("../ports/repositories.js").TransactionalRepos, taskId: string): Promise<TaskContext> {
  const task = await tx.tasks.findById(taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  if (!task.worktreeId) throw new Error(`任务 ${taskId} 未绑定 worktree`);
  const worktree = await tx.worktrees.findById(task.worktreeId);
  if (!worktree) throw new Error(`worktree 不存在: ${task.worktreeId}`);
  if (!task.currentPlanId) throw new Error(`任务 ${taskId} 未持久化 Plan`);
  const plan = await tx.plans.findById(task.currentPlanId);
  if (!plan) throw new Error(`Plan 不存在: ${task.currentPlanId}`);
  const project = await tx.projects.findById(task.projectId);
  if (!project) throw new Error(`项目不存在: ${task.projectId}`);
  if (!task.currentEvidencePackId || task.currentEvidencePackVersion === undefined) {
    throw new Error(`任务 ${taskId} 未绑定当前 Evidence Pack`);
  }
  const evidencePack = await tx.evidencePacks.findById(task.currentEvidencePackId);
  if (
    !evidencePack ||
    evidencePack.taskId !== task.id ||
    evidencePack.version !== task.currentEvidencePackVersion ||
    evidencePack.contentHash !== computePackContentHash(evidencePack)
  ) {
    throw new Error(`任务 ${taskId} 的当前 Evidence Pack 不存在、归属不一致或内容哈希无效`);
  }
  return { task, worktree, plan, project, evidencePack };
}

/** 构造 RuntimeTaskInput。 */
function buildRuntimeTaskInput(ctx: TaskContext): RuntimeTaskInput {
  return {
    taskId: ctx.task.id,
    worktreePath: ctx.worktree.path,
    allowedPaths: ctx.plan.allowedPaths,
    evidencePackId: ctx.evidencePack.id,
    evidencePackVersion: ctx.evidencePack.version,
    taskInput: ctx.task.input,
    projectCommands: ctx.project.commands
  };
}

/**
 * 流式消费 runtime.analyze/develop 事件，缓冲到 eventSink 并 flush 落库。
 * 返回 runId、事件数、summary 和落库的 AgentRunRecord。
 *
 * **P1-R02（Phase 4 第二轮验收 §6.3）**：同时追踪事件流是否出现 `error`
 * 或未以 `completed` 结束。调用方必须检查 `errorEvent` 与 `completed`
 * 字段；任一条件命中均失败关闭，禁止后续步骤继续执行。
 */
async function consumeRuntimeStream(
  iterable: AsyncIterable<RuntimeEvent>,
  taskId: string,
  role: string,
  sink: RuntimeEventSink
): Promise<{
  runId: string;
  eventCount: number;
  summary: string | undefined;
  agentRun: AgentRunRecord | undefined;
  /** P1-R02：事件流中是否出现 error 事件。 */
  errorEvent: RuntimeEvent | undefined;
  /** P1-R02：事件流是否以 completed 结束。 */
  completed: boolean;
}> {
  let runId = "unknown";
  let eventCount = 0;
  let summary: string | undefined;
  let errorEvent: RuntimeEvent | undefined;
  let completed = false;
  for await (const ev of iterable) {
    eventCount++;
    if ("runId" in ev && typeof ev.runId === "string") {
      runId = ev.runId;
    }
    sink.append(taskId, runId, role, ev);
    if (ev.type === "error") {
      errorEvent = ev;
    }
    if (ev.type === "completed") {
      completed = true;
      if ("summary" in ev && typeof ev.summary === "string") {
        summary = ev.summary;
      }
    }
  }
  const agentRun = await sink.flush(taskId, runId);
  return { runId, eventCount, summary, agentRun, errorEvent, completed };
}

export class ExecutionOrchestrator implements HumanDecisionFinalizationGuard {
  /**
   * P1-R02（§7.3 第 1 点）：执行租约登记 —— `taskId → AbortController`。
   *
   * `runAnalyze`/`runDevelop`/`runReview` 在**启动 Runtime 前**就登记
   * 此映射（创建 AbortController 并存入）。取消 API 通过
   * `cancelRuntimeForTask` abort 对应的 controller，即使 Runtime 还没
   * 产出 `started` 事件（注册前竞态窗口），OmpAdapter 也能感知
   * `signal.aborted` 并拒绝启动 omp。
   *
   * 收到 `started` 事件后，runId 被登记到 `activeRuns`，但
   * `pendingLeases` 中的 controller 仍保留（signal 仍可用于运行中取消）。
   * 事件流结束后从两个映射中移除。
   *
   * 不持久化：仅运行期有效。重启后所有运行视为已结束。
   */
  private readonly pendingLeases = new Map<string, AbortController>();

  /**
   * P1-R02：活动运行登记 —— `taskId → runId` 的内存映射。
   *
   * `runAnalyze`/`runDevelop` 在收到 Runtime `started` 事件时登记，
   * 在事件流结束（completed/error/异常）时清除。`cancelRuntimeForTask`
   * 通过此映射找到当前任务的 runId，调用 `runtime.cancel(runId)` 终止
   * 子进程。
   */
  private readonly activeRuns = new Map<string, string>();

  /** 同一任务的内部写入、Review 与最终审批共享一个进程内独占队列。 */
  private readonly taskOperationTails = new Map<string, Promise<void>>();

  constructor(private readonly deps: ExecutionOrchestratorDeps) {}

  /**
   * 在 EXECUTING 阶段调用 runtime.analyze 收集证据。
   *
   * 前置条件：任务已绑定 worktree 且已持久化 Plan。
   * 不做状态迁移 —— 调用方负责在调用前后用 TaskOrchestrator 迁移状态。
   *
   * **P1-R02（§7.3 第 1 点 注册前竞态）**：
   * - **先**创建 AbortController 并登记到 `pendingLeases`，再在事务内
   *   加载任务上下文并校验 `task.status === "EXECUTING"`。这关闭了
   *   API 层状态检查与 orchestrator 调用之间的竞态：若取消 API 在此
   *   事务前已完成状态迁移，status re-check 会抛
   *   `TaskNotInExpectedStatusError`；若取消 API 在此事务后但 runtime
   *   启动前 abort signal，runtime 会感知 `signal.aborted` 并拒绝启动。
   * - signal 透传给 `runtime.analyze`。
   * - 若事件流出现 `error` 或未以 `completed` 结束，必须抛
   *   `RuntimeStreamFailedError`，禁止调用方把异常停止当作成功。
   */
  async runAnalyze(taskId: string): Promise<AnalyzeRunResult> {
    // P1-R02：先创建 lease，再加载任务上下文 + 校验状态。
    // 取消 API 可能在 API 层状态检查后、本方法调用前完成状态迁移；
    // 此处的事务内 re-check 关闭该竞态。
    const controller = new AbortController();
    this.pendingLeases.set(taskId, controller);

    try {
      const ctx = await this.deps.unitOfWork.run(async (tx) => {
        const base = await loadTaskContext(tx, taskId);
        if (base.task.status !== "EXECUTING") {
          throw new TaskNotInExpectedStatusError(taskId, "EXECUTING", base.task.status);
        }
        return base;
      });
      const input = buildRuntimeTaskInput(ctx);

      const result = await this.consumeStreamWithRegistration(
        this.deps.runtime.analyze(input, controller.signal),
        taskId,
        "analyze"
      );
      this.assertStreamHealthy(taskId, "analyze", result);
      return result;
    } finally {
      this.pendingLeases.delete(taskId);
    }
  }

  /**
   * 在 EXECUTING 阶段调用 runtime.develop 修改 worktree，随后获取 Diff
   * 并跑项目 test 命令做验证。
   *
   * 前置条件：任务已绑定 worktree 且已持久化 Plan。
   * 不做状态迁移 —— 调用方负责状态迁移。
   *
   * **P1-03**：完成后把受控 Diff 哈希、patch、changedFiles、验证退出码、
   * 验证 stdout/stderr 持久化到 `execution_results` 表，供 `runReview`
   * 受控读取。返回值中的 `diff` 与验证产物与本表记录一致。
   *
   * **P1-R01**：在取得 Diff 后、跑验证前，校验 `diff.changedFiles` 全部
   * 落在 `Plan.allowedPaths` 内。任何越界变更抛 `PathScopeViolationError`，
   * 写 `policy_denied` 审计，禁止验证、持久化与后续 Review。
   *
   * **P1-R02**：
   * - 在启动 Runtime 前创建 AbortController 并登记到 `pendingLeases`。
   * - 若事件流出现 `error` 或未以 `completed` 结束，必须抛
   *   `RuntimeStreamFailedError`，禁止把失败运行后的 Diff/验证当作成功。
   * - **§9.3（第五次复验）**：租约持有到**整个用例结束**（含 Diff、验证、
   *   持久化），而非仅 Runtime 事件流结束。在 Diff 前、验证前检查
   *   `controller.signal.aborted` 并在事务内重新核验任务状态仍为
   *   `EXECUTING`。向验证命令的 `ProcessRunner.run` 传递同一 `AbortSignal`，
   *   使取消 API 能终止验证进程树。这关闭了"Runtime 完成后取消无法终止
   *   验证"的窗口。
   * - **§10.1（第六次复验 线性化点）**：最终状态检查 + `executionResults.save`
   *   + save 后 abort 检查在同一写事务内原子完成。SQLite 单写队列保证
   *   取消 API 的状态迁移事务无法与此事务并发；save 后的同步 abort 检查
   *   与 COMMIT 之间无 yield，构成不可分割的线性化边界。
   */
  async runDevelop(taskId: string): Promise<DevelopRunResult> {
    return this.runTaskExclusive(taskId, () => this.runDevelopExclusive(taskId));
  }

  private async runDevelopExclusive(taskId: string): Promise<DevelopRunResult> {
    // P1-R02：先创建 lease，再加载任务上下文 + 校验状态（关闭注册前竞态）。
    // §9.3：lease 持有到整个用例结束（最外层 finally 清理），覆盖 Diff/
    // 验证/持久化全程，使取消 API 在任何阶段都能通过 abort signal 终止。
    const controller = new AbortController();
    this.pendingLeases.set(taskId, controller);

    let ctx: TaskContext;
    let streamResult;
    let beforeSnapshot: FilesystemSnapshot | undefined;
    try {
      ctx = await this.deps.unitOfWork.run(async (tx) => {
        const base = await loadTaskContext(tx, taskId);
        if (base.task.status !== "EXECUTING") {
          throw new TaskNotInExpectedStatusError(taskId, "EXECUTING", base.task.status);
        }
        return base;
      });
      const input = buildRuntimeTaskInput(ctx);

      // P1-R01（§14.2 执行期隔离）：在启动 Runtime 前对 worktree 做全量快照
      // 并将非 allowedPaths 路径设为只读。执行期隔离是三层防御的第一层：
      // 使 Omp 的 edit/write 工具在执行期遇到 EACCES，实现"实际操作前"的
      // 路径校验。快照检测（第二层）和回滚恢复（第三层）在 Runtime 结束后执行。
      //
      // §14.2 失败关闭：applyExecutionIsolation 在无法读取目录、无法设置
      // 权限或检测到符号链接逃逸时抛 ExecutionIsolationError。此错误传播
      // 到调用方（composition-root handleRunError），任务迁移到 INTERRUPTED
      // 并返回 500。Runtime 不会被启动。
      let isolationLease: ExecutionIsolationLease | undefined;
      let symlinkWatcher: SymlinkEscapeWatcher | undefined;
      if (this.deps.filesystemGuard) {
        beforeSnapshot = await this.deps.filesystemGuard.createSnapshot(ctx.worktree.path);
        try {
          isolationLease = await this.deps.filesystemGuard.applyExecutionIsolation(
            ctx.worktree.path,
            ctx.plan.allowedPaths
          );
          // P1-R01（§16 运行期符号链接逃逸监听）：启动 fs.watch 递归监听，
          // 在 Runtime 执行期间近实时检测新增的符号链接逃逸。检测到越界
          // 符号链接时立即 abort Runtime，将攻击窗口从事后检测缩小到毫秒级。
          // 这填补 applyExecutionIsolation（仅检测 develop 前已有符号链接）
          // 与 enforceFilesystemScope（develop 后检测）之间的窗口。
          symlinkWatcher = this.deps.filesystemGuard.watchForSymlinkEscapes(
            ctx.worktree.path,
            ctx.plan.allowedPaths,
            () => {
              if (!controller.signal.aborted) {
                controller.abort();
              }
            }
          );
        } catch (err) {
          // §14.2 失败关闭：隔离失败时清理快照并重新抛错，拒绝启动 Runtime
          await this.deps.filesystemGuard.dispose(beforeSnapshot);
          beforeSnapshot = undefined;
          throw err;
        }
      }

      try {
        streamResult = await this.consumeStreamWithRegistration(
          this.deps.runtime.develop(input, controller.signal),
          taskId,
          "develop"
        );
      } finally {
        // §11.2：先停止 watcher，再恢复原始权限。
        // 必须在快照检测/回滚前释放，以便回滚操作能修改越界文件。
        symlinkWatcher?.stop();
        if (isolationLease) {
          await isolationLease.release();
        }
      }

      // ===== P1-R02（§9.3）：阶段 2 —— Diff / 验证 / 持久化 =====
      // 租约仍持有，取消 API 可通过 abort signal 终止验证进程树。
      // 每个关键步骤前检查 signal.aborted + 事务内重新核验任务状态。

      this.assertStreamHealthy(taskId, "develop", streamResult);
      this.assertNotAborted(taskId, "develop", controller);

      // P1-R01：文件系统守卫检测越界变更并回滚
      if (this.deps.filesystemGuard && beforeSnapshot) {
        await this.enforceFilesystemScope(
          taskId,
          beforeSnapshot,
          ctx.worktree.path,
          ctx.plan.allowedPaths
        );
      }

      // P1-R02（§9.3）：Diff 前重新核验任务状态 + 检查取消信号
      this.assertNotAborted(taskId, "develop", controller);
      await this.assertTaskStillInStatus(taskId, "EXECUTING");

      // 获取 Diff（经 WorktreeManager 受控路径，含 diff_recorded 审计）
      const diff = await this.deps.worktreeManager.captureDiffForTask({
        taskId,
        worktreeId: ctx.worktree.id,
        reason: "ExecutionOrchestrator.runDevelop：develop 完成后捕获 Diff"
      });

      // P1-R01（§6.2 第二层防御）：核心层校验 diff.changedFiles ⊆ Plan.allowedPaths。
      // P1-R01（§9.2）：.git 等受保护路径无条件视为越界，即使匹配 allowedPaths。
      const violators = diff.changedFiles.filter(
        (p) => isProtectedPath(p) || findPathScopeViolations([p], ctx.plan.allowedPaths).length > 0
      );
      if (violators.length > 0) {
        await this.deps.unitOfWork.run(async (tx) => {
          await tx.audit.append(
            createAuditEvent({
              taskId,
              type: "policy_denied",
              deniedAction: "runDevelop.pathScopeViolation",
              deniedReason: `Diff 包含越界变更路径，不在 Plan.allowedPaths 内：${violators.join(", ")}`
            })
          );
        });
        throw new PathScopeViolationError(taskId, violators, ctx.plan.allowedPaths);
      }

      // P1-R02（§9.3）：验证前重新核验任务状态 + 检查取消信号
      this.assertNotAborted(taskId, "develop", controller);
      await this.assertTaskStillInStatus(taskId, "EXECUTING");

      // 跑项目 test 命令验证修改是否修复了失败测试
      // P1-R02（§9.3）：向 ProcessRunner.run 传递 controller.signal，
      // 使取消 API 能终止验证进程树（含孙进程）。
      const testCommand = ctx.project.commands.test;
      const verifyResult = await this.deps.processRunner.run(
        testCommand,
        ctx.worktree.path,
        this.deps.processPolicy,
        controller.signal
      );

      // P1-03：持久化受控 Diff 与验证产物到 execution_results 表。
      const verificationPassed = verifyResult.exitCode === 0;
      const persistedAt = new Date().toISOString();
      const executionResult: ExecutionResult = {
        id: randomId("exec-result"),
        taskId,
        runId: streamResult.runId,
        diffHash: diff.hash,
        diffPatch: diff.patch,
        diffChangedFiles: diff.changedFiles,
        diffBytes: diff.bytes,
        verificationExitCode: verifyResult.exitCode,
        verificationPassed,
        verificationStdout: verifyResult.stdout,
        verificationStderr: verifyResult.stderr,
        createdAt: persistedAt
      };
      // P1-R02（§10.1 线性化点）：状态检查 + executionResults.save +
      // save 后 abort 检查必须在同一写事务内原子完成。
      //
      // SQLite 单写队列（SqliteUnitOfWork.tail Promise 链 + BEGIN IMMEDIATE）
      // 保证取消 API 的状态迁移事务无法与此事务并发执行。因此线性化规则为：
      //
      // 1. 若取消 API 的迁移事务先获得写锁 → 任务变为 INTERRUPTED/CANCELLED
      //    → 本事务内 tx.tasks.findById 读到终态 → 抛
      //    TaskNotInExpectedStatusError → 无 save。
      // 2. 若本事务先获得写锁 → findById 读到 EXECUTING → save →
      //    save 后同步检查 controller.signal.aborted：
      //    a. 若 abort 在 save 的 await yield 期间被设置 → 此检查命中 →
      //       抛 RuntimeStreamFailedError → 事务 ROLLBACK → 无 save。
      //    b. 若 abort 未被设置 → COMMIT → 取消 API随后获得写锁，
      //       读到 EXECUTING → 迁移到 INTERRUPTED。
      //       但此时 executionResults 已提交，Review 可从表中读取。
      //       这是"develop 先于 cancel 完成"的合法排序，不算 TOCTOU。
      //
      // 关键：save 后的 abort 检查是同步操作，与 COMMIT 之间无 yield
      //（better-sqlite3 COMMIT 同步执行，JS 单线程无 macrotask 插入），
      // 构成不可分割的线性化边界。
      await this.deps.unitOfWork.run(async (tx) => {
        const task = await tx.tasks.findById(taskId);
        if (!task || task.status !== "EXECUTING") {
          throw new TaskNotInExpectedStatusError(
            taskId,
            "EXECUTING",
            task?.status ?? "INTERRUPTED"
          );
        }
        await tx.executionResults.save(executionResult);
        // save 后、COMMIT 前同步检查 abort 信号。
        // 若取消在 save 的 await 期间设置了 abort，此检查命中并回滚事务。
        if (controller.signal.aborted) {
          throw new RuntimeStreamFailedError(
            taskId,
            "develop",
            "最终持久化事务内检测到 abort 信号（取消在 save 期间并发）—— 事务回滚，拒绝保存 executionResults"
          );
        }
      });

      return {
        runId: streamResult.runId,
        eventCount: streamResult.eventCount,
        summary: streamResult.summary,
        agentRun: streamResult.agentRun,
        diff,
        verificationExitCode: verifyResult.exitCode,
        verificationStdout: verifyResult.stdout,
        verificationStderr: verifyResult.stderr,
        verificationPassed
      };
    } finally {
      // P1-R02（§9.3）：lease 持有到整个用例结束 —— 覆盖 Diff/验证/持久化。
      this.pendingLeases.delete(taskId);
      // P1-R01：清理 beforeSnapshot 的备份目录（幂等）。
      if (beforeSnapshot && this.deps.filesystemGuard) {
        try {
          await this.deps.filesystemGuard.dispose(beforeSnapshot);
        } catch {
          // dispose 失败不影响主流程 —— 临时目录残留由系统清理
        }
      }
    }
  }

  /**
   * P1-R01（§7.2 第 2 点 + §10.2 失败关闭）：强制 worktree 文件系统变更
   * 落在 Plan.allowedPaths 内。
   *
   * 流程：
   * 1. 用守卫重新快照当前 worktree 状态（afterSnapshot）。
   * 2. 对比 `beforeSnapshot` 与 `afterSnapshot`，得到所有文件系统变更
   *    （含未跟踪文件的新增、符号链接创建、删除、类型变化）。
   * 3. 调用 `findPathScopeViolations` 找出不在 `allowedPaths` 内的越界变更。
   * 4. 若存在越界变更：
   *    a. 调用 `guard.rollback` 把 worktree 恢复到 `beforeSnapshot` 状态
   *       （仅恢复越界文件，不触碰合法变更）；
   *    b. **§10.2 回滚后完整性校验**：新建 `verifySnapshot` 对比
   *       `beforeSnapshot`，若越界路径仍有变更则回滚不完整，失败关闭；
   *    c. 写 `policy_denied` 审计事件（独立事务，不被上层 ROLLBACK 回滚），
   *       记录所有越界路径与变更类型；
   *    d. 抛 `PathScopeViolationError`，禁止后续验证与 Review。
   * 5. 无论是否越界，最后调用 `guard.dispose(afterSnapshot)` 清理 afterSnapshot
   *    的备份目录。`beforeSnapshot` 由调用方（runDevelop 的 finally）负责清理。
   *
   * §10.2 失败关闭规则：快照、备份、回滚及回滚后完整性验证任一失败都必须
   * 失败关闭 —— 写 `policy_denied` 审计并抛 `PathScopeViolationError`。
   *
   * 该方法捕获 Omp 的所有文件系统层副作用，包括：
   * - 写入 worktree 内但不在 allowedPaths 的文件（如 package.json、测试文件）；
   * - 通过符号链接逃逸到 worktree 外（type-changed 检测）；
   * - 删除 worktree 内的非 allowedPaths 文件；
   * - 创建新的未跟踪文件（git diff 不会捕获，但快照会捕获）。
   *
   * @throws {PathScopeViolationError} 存在越界变更，或回滚/完整性校验失败时
   */
  private async enforceFilesystemScope(
    taskId: string,
    beforeSnapshot: FilesystemSnapshot,
    worktreePath: string,
    allowedPaths: readonly string[]
  ): Promise<void> {
    const guard = this.deps.filesystemGuard;
    if (!guard) return;

    let afterSnapshot: FilesystemSnapshot | undefined;
    try {
      afterSnapshot = await guard.createSnapshot(worktreePath);
      const changes = guard.detectChanges(beforeSnapshot, afterSnapshot);

      // 收集所有越界变更的相对路径。
      // P1-R01（§9.2）：.git 路径无条件视为越界 —— 即使 allowedPaths 含 **，
      // 也不允许 omp 修改 git 元数据（防止重定向 gitdir、篡改 refs 等）。
      const violationRelativePaths: string[] = [];
      const violationChanges: FilesystemChange[] = [];
      for (const change of changes) {
        if (isProtectedPath(change.relativePath)) {
          violationRelativePaths.push(change.relativePath);
          violationChanges.push(change);
          continue;
        }
        const violators = findPathScopeViolations([change.relativePath], allowedPaths);
        if (violators.length > 0) {
          violationRelativePaths.push(change.relativePath);
          violationChanges.push(change);
          continue;
        }
        // P1-R01（§7.2 符号链接逃逸）：即使 change.relativePath 落在
        // allowedPaths 内，若变更为符号链接（added / type-changed /
        // modified）且其目标指向 worktree 外部，也视为越界。
        // 这关闭了"在白名单内创建指向外部的符号链接"逃逸路径 ——
        // applyExecutionIsolation 仅检查 develop 前已存在的符号链接，
        // develop 期间新建/改指向的符号链接由本检测兜底。
        const afterEntry = change.after;
        if (
          afterEntry?.isSymlink === true &&
          typeof afterEntry.symlinkTarget === "string" &&
          isSymlinkTargetOutsideWorktree(
            worktreePath,
            change.relativePath,
            afterEntry.symlinkTarget
          )
        ) {
          violationRelativePaths.push(change.relativePath);
          violationChanges.push(change);
        }
      }

      if (violationChanges.length > 0) {
        // 越界变更：回滚到 develop 前状态，写 policy_denied 审计，抛错。
        const violationSummary = violationChanges
          .map((c) => `${c.type}:${c.relativePath}`)
          .join(", ");

        try {
          await guard.rollback(beforeSnapshot, violationChanges);
        } catch (rollbackErr) {
          // P1-R01 §10.2：回滚失败 —— 失败关闭。写 policy_denied 审计
          // （含回滚错误详情）并抛 PathScopeViolationError，拒绝后续验证与 Review。
          await this.deps.unitOfWork.run(async (tx) => {
            await tx.audit.append(
              createAuditEvent({
                taskId,
                type: "policy_denied",
                deniedAction: "runDevelop.filesystemScopeViolation.rollbackFailed",
                deniedReason: `文件系统越界变更且回滚失败：${violationSummary}（回滚错误：${(rollbackErr as Error).message}）`
              })
            );
          });
          throw new PathScopeViolationError(
            taskId,
            violationRelativePaths,
            allowedPaths
          );
        }

        // P1-R01 §10.2：回滚后完整性校验 —— 新建快照对比 beforeSnapshot，
        // 若越界路径仍有变更则回滚不完整，失败关闭。
        //
        // 这是 §10.2 关闭要求：「快照、备份、回滚及回滚后完整性验证任一失败
        // 都必须失败关闭。」回滚可能因备份损坏、文件锁定、符号链接创建失败
        // 等原因静默不完整（旧版 restoreFromBackup 会吞错），完整性校验是
        // 最终防线：创建 verifySnapshot，对比 beforeSnapshot，若越界路径
        // 仍存在差异则拒绝继续。
        const violationPathSet = new Set(
          violationChanges.map((c) => c.relativePath)
        );
        let verifySnapshot: FilesystemSnapshot | undefined;
        try {
          verifySnapshot = await guard.createSnapshot(worktreePath);
          const remainingChanges = guard.detectChanges(
            beforeSnapshot,
            verifySnapshot
          );
          const incompleteChanges = remainingChanges.filter((c) =>
            violationPathSet.has(c.relativePath)
          );
          if (incompleteChanges.length > 0) {
            const incompleteSummary = incompleteChanges
              .map((c) => `${c.type}:${c.relativePath}`)
              .join(", ");
            await this.deps.unitOfWork.run(async (tx) => {
              await tx.audit.append(
                createAuditEvent({
                  taskId,
                  type: "policy_denied",
                  deniedAction:
                    "runDevelop.filesystemScopeViolation.rollbackIncomplete",
                  deniedReason: `回滚后完整性校验失败，仍存在越界变更：${incompleteSummary}`
                })
              );
            });
            throw new PathScopeViolationError(
              taskId,
              violationRelativePaths,
              allowedPaths
            );
          }
        } catch (verifyErr) {
          // 完整性校验自身失败（createSnapshot 或 detectChanges 抛错）——
          // 失败关闭。若 verifyErr 已是 PathScopeViolationError 则直接向上抛。
          if (verifyErr instanceof PathScopeViolationError) {
            throw verifyErr;
          }
          await this.deps.unitOfWork.run(async (tx) => {
            await tx.audit.append(
              createAuditEvent({
                taskId,
                type: "policy_denied",
                deniedAction:
                  "runDevelop.filesystemScopeViolation.integrityCheckFailed",
                deniedReason: `回滚后完整性校验失败：${(verifyErr as Error).message}`
              })
            );
          });
          throw new PathScopeViolationError(
            taskId,
            violationRelativePaths,
            allowedPaths
          );
        } finally {
          if (verifySnapshot) {
            try {
              await guard.dispose(verifySnapshot);
            } catch {
              // dispose 失败不影响主流程（仅资源泄漏，非安全问题）
            }
          }
        }

        // 回滚成功且完整性校验通过 —— 写 policy_denied 审计并抛错
        await this.deps.unitOfWork.run(async (tx) => {
          await tx.audit.append(
            createAuditEvent({
              taskId,
              type: "policy_denied",
              deniedAction: "runDevelop.filesystemScopeViolation",
              deniedReason: `文件系统越界变更已回滚：${violationSummary}`
            })
          );
        });
        throw new PathScopeViolationError(
          taskId,
          violationRelativePaths,
          allowedPaths
        );
      }
    } finally {
      // 清理 afterSnapshot 的备份目录。beforeSnapshot 由调用方清理。
      if (afterSnapshot) {
        try {
          await guard.dispose(afterSnapshot);
        } catch {
          // dispose 失败不影响主流程
        }
      }
    }
  }

  /**
   * P1-R02（§7.3 第 1 点 + 第 3 点）：取消任务的当前 Runtime 运行。
   *
   * 由取消 API 在迁移任务状态前调用。流程：
   * 1. 从 `pendingLeases` 读取 taskId 对应的 AbortController，调用
   *    `controller.abort()`。这使 OmpAdapter 在 omp 启动前或运行中
   *    感知 signal aborted 并终止。解决注册前竞态。
   * 2. 从 `activeRuns` 读取 taskId 对应的 runId，调用
   *    `runtime.cancel(runId)` 终止已启动的 omp 子进程树。
   * 3. 从两个映射中移除。
   *
   * 对未知 taskId 或已结束的运行安全：`runtime.cancel` 必须对未知 runId
   * 仍是 no-op；`controller.abort()` 对已结束的运行也无副作用。
   *
   * @returns 被取消的 runId（若 activeRuns 有登记），否则返回 undefined。
   *          注意：即使返回 undefined，pendingLeases 中的 controller 也
   *          已被 abort（若存在）。
   */
  async cancelRuntimeForTask(taskId: string): Promise<string | undefined> {
    // 1. 先 abort pendingLeases 中的 controller（注册前竞态解决）
    const controller = this.pendingLeases.get(taskId);
    if (controller) {
      controller.abort();
      this.pendingLeases.delete(taskId);
    }

    // 2. 再调用 runtime.cancel(runId) 终止已启动的 Runtime
    const runId = this.activeRuns.get(taskId);
    if (runId) {
      try {
        await this.deps.runtime.cancel(runId);
      } finally {
        this.activeRuns.delete(taskId);
      }
      return runId;
    }
    return undefined;
  }

  /**
   * P1-R02：包装 `consumeRuntimeStream`，在收到 `started` 事件时登记
   * `taskId → runId`，在结束时清除。
   *
   * 注意：`consumeRuntimeStream` 已经在内部跟踪 error/completed，这里
   * 只负责活动运行登记。pendingLeases 的清理由调用方（runAnalyze/
   * runDevelop）的 finally 块负责。
   */
  private async consumeStreamWithRegistration(
    iterable: AsyncIterable<RuntimeEvent>,
    taskId: string,
    role: string
  ): Promise<{
    runId: string;
    eventCount: number;
    summary: string | undefined;
    agentRun: AgentRunRecord | undefined;
    errorEvent: RuntimeEvent | undefined;
    completed: boolean;
  }> {
    // 包装 iterable，在收到 started 事件时登记 runId。
    // 使用箭头函数捕获 this，避免 no-this-alias。
    const activeRuns = this.activeRuns;
    const wrapped: AsyncIterable<RuntimeEvent> = {
      async *[Symbol.asyncIterator]() {
        for await (const ev of iterable) {
          if (ev.type === "started" && "runId" in ev && typeof ev.runId === "string") {
            activeRuns.set(taskId, ev.runId);
          }
          yield ev;
        }
      }
    };
    try {
      return await consumeRuntimeStream(wrapped, taskId, role, this.deps.eventSink);
    } finally {
      // 无论成功/失败/取消，事件流结束后都从活动登记中移除。
      this.activeRuns.delete(taskId);
    }
  }

  /**
   * P1-R02：检查事件流健康度，失败时抛 `RuntimeStreamFailedError`。
   *
   * - 若出现 `error` 事件 → 抛错（含 error.message）。
   * - 若未以 `completed` 结束 → 抛错（流被中断或异常停止）。
   */
  private assertStreamHealthy(
    taskId: string,
    role: string,
    result: { errorEvent: RuntimeEvent | undefined; completed: boolean }
  ): void {
    if (result.errorEvent) {
      const message =
        (result.errorEvent as { message?: string }).message ?? "未知错误";
      throw new RuntimeStreamFailedError(
        taskId,
        role,
        `Runtime 事件流出现 error 事件：${message}`
      );
    }
    if (!result.completed) {
      throw new RuntimeStreamFailedError(
        taskId,
        role,
        "Runtime 事件流未以 completed 结束（可能被取消或异常停止）"
      );
    }
  }

  /**
   * P1-R02（§9.3）：检查 AbortSignal 是否已被 abort。
   *
   * 取消 API 通过 `cancelRuntimeForTask` 调用 `controller.abort()`。
   * `runDevelop` 在 Diff/验证/持久化等关键步骤前调用本方法，若 signal
   * 已被 abort 则抛 `RuntimeStreamFailedError`（语义：Runtime 被取消），
   * 由 `handleRunError` 迁移到 `INTERRUPTED` 或降级为 409（若取消 API
   * 已抢先迁移到 `CANCELLED`）。
   */
  private assertNotAborted(
    taskId: string,
    role: string,
    controller: AbortController
  ): void {
    if (controller.signal.aborted) {
      throw new RuntimeStreamFailedError(
        taskId,
        role,
        "AbortSignal 已被 abort（任务被并发取消 API 终止）"
      );
    }
  }

  /**
   * P1-R02（§9.3）：在事务内重新核验任务状态仍为预期状态。
   *
   * 取消 API 可能在 `runDevelop` 的 Diff/验证/持久化阶段并发把任务
   * 迁移到 `CANCELLED`。本方法在每个关键步骤前事务内 re-check：
   * - 若状态已被迁移（如 `CANCELLED`），抛 `TaskNotInExpectedStatusError`，
   *   `handleRunError` 返回 409 不再迁移（任务已处于安全终态）。
   * - 若状态仍为 `EXECUTING`，继续执行（但 `assertNotAborted` 可能
   *   先行检测到取消信号）。
   */
  private async assertTaskStillInStatus(
    taskId: string,
    expected: TaskStatus
  ): Promise<void> {
    const task = await this.deps.unitOfWork.run(async (tx) =>
      tx.tasks.findById(taskId)
    );
    if (!task) {
      throw new Error(
        `任务 ${taskId} 不存在 —— 无法在 ${expected} 阶段重新核验状态`
      );
    }
    if (task.status !== expected) {
      throw new TaskNotInExpectedStatusError(taskId, expected, task.status);
    }
  }

  /**
   * 在 REVIEWING 阶段调用 runtime.review 做独立审查。
   *
   * 前置条件：任务已绑定 worktree、已持久化 Plan，且已通过 runDevelop
   * 产出 Diff 与验证结果（持久化在 `execution_results` 表）。
   * 不做状态迁移 —— 调用方负责状态迁移。
   *
   * **P1-03 安全约束（不可绕过）**：
   * - **不接受**调用方提交的 `diff` 或 `verificationResult`。
   *   Reviewer 输入必须来自受控来源（§8.1 第 8 步）。
   * - 从 `execution_results` 表读取最新一条受控记录，提取 Diff 哈希、
   *   patch、changedFiles、验证退出码、验证 stdout/stderr。
   * - 调用 `WorktreeManager.captureDiffForTask` 重新获取当前工作树 Diff，
   *   校验其哈希与持久化哈希一致；不一致则抛 `DiffTamperError`，拒绝
   *   Review，要求重新验证。
   * - 仅校验通过的受控 Diff 与验证产物传给 `runtime.review`。
   *
   * **P1-R02（§7.3 第 2 点 Review 无法取消）**：
   * - 先创建 lease 并登记到 `pendingLeases`，再在事务内校验
   *   `task.status === "REVIEWING"`。取消 API 可通过 abort signal 终止
   *   review 进程（与 analyze/develop 一致）。
   * - signal 透传给 `runtime.review`，使 omp 子进程在 cancel 时被终止。
   *
   * @throws {DiffTamperError} 工作树 Diff 哈希与持久化哈希不一致
   * @throws {TaskNotInExpectedStatusError} 任务状态不在 REVIEWING
   * @throws {Error} 任务无对应的 execution_results 记录
   */
  async runReview(taskId: string): Promise<ReviewResult> {
    return this.runTaskExclusive(taskId, () => this.runReviewExclusive(taskId));
  }

  private async runReviewExclusive(taskId: string): Promise<ReviewResult> {
    // P1-R02：先创建 lease，再加载任务上下文 + 校验状态（关闭注册前竞态）。
    const controller = new AbortController();
    this.pendingLeases.set(taskId, controller);

    try {
      // 1. 事务内加载任务上下文 + 持久化执行结果（受控来源）
      //    P1-R02：同时校验 task.status === "REVIEWING"
      const ctx = await this.deps.unitOfWork.run(async (tx) => {
        const base = await loadTaskContext(tx, taskId);
        if (base.task.status !== "REVIEWING") {
          throw new TaskNotInExpectedStatusError(taskId, "REVIEWING", base.task.status);
        }
        const persisted = await tx.executionResults.findLatestByTask(taskId);
        if (!persisted) {
          throw new Error(
            `任务 ${taskId} 无对应的 execution_results 记录 —— 必须先经 runDevelop 持久化受控 Diff 与验证产物`
          );
        }
        return { ...base, persisted };
      });

      // 2. 重新捕获当前工作树 Diff，校验哈希一致性（防篡改）
      const currentDiff = await this.deps.worktreeManager.captureDiffForTask({
        taskId,
        worktreeId: ctx.worktree.id,
        reason: "ExecutionOrchestrator.runReview：审查前重新捕获 Diff 校验哈希一致性"
      });
      if (currentDiff.hash !== ctx.persisted.diffHash) {
        throw new DiffTamperError(
          taskId,
          ctx.persisted.diffHash,
          currentDiff.hash
        );
      }

      // 3. 重建受控 DiffArtifact（从持久化记录，不使用调用方输入）
      const diff: DiffArtifact = {
        worktreePath: ctx.worktree.path,
        patch: ctx.persisted.diffPatch,
        hash: ctx.persisted.diffHash,
        changedFiles: [...ctx.persisted.diffChangedFiles],
        bytes: ctx.persisted.diffBytes
      };

      // 4. 重建受控验证产物（从持久化记录）
      const verificationResult = {
        exitCode: ctx.persisted.verificationExitCode,
        passed: ctx.persisted.verificationPassed,
        stdout: ctx.persisted.verificationStdout,
        stderr: ctx.persisted.verificationStderr
      };

      // 5. 调用 runtime.review，仅传入受控来源数据
      //    P1-R02：透传 controller.signal，使取消 API 能终止 review 进程
      const input: ReviewTaskInput = {
        taskId: ctx.task.id,
        worktreePath: ctx.worktree.path,
        evidencePackId: ctx.evidencePack.id,
        evidencePackVersion: ctx.evidencePack.version,
        evidencePack: ctx.evidencePack,
        taskInput: ctx.task.input,
        diff,
        verificationResult,
        acceptanceCriteria: ctx.task.input.acceptanceCriteria
      };
      return await this.deps.runtime.review(input, controller.signal);
    } finally {
      this.pendingLeases.delete(taskId);
    }
  }

  /**
   * 在同一任务级独占关键区内完成最终 Diff 捕获、领域提交和提交后复核。
   *
   * 进程内所有 develop/review/审批路径共享同一互斥队列；同时把整个
   * worktree 临时设为只读并拍摄文件系统快照。外部进程若仍能在 Windows
   * 只读目录中新建文件，提交后 Diff + 快照复核会检测并调用补偿事务，
   * 删除人工审批、恢复 VERIFIED/等待审批状态后失败关闭。
   */
  async finalize<T>(input: HumanDecisionFinalizationInput<T>): Promise<T> {
    return this.runTaskExclusive(input.taskId, async () => {
      const filesystemGuard = this.deps.filesystemGuard;
      if (!filesystemGuard) {
        throw new HumanDecisionFinalizationError(
          input.taskId,
          "生产审批未配置 WorktreeFilesystemGuard"
        );
      }

      const ctx = await this.loadApprovalDiffContext(input.taskId);
      let isolationLease: ExecutionIsolationLease | undefined;
      let beforeSnapshot: FilesystemSnapshot | undefined;
      let afterSnapshot: FilesystemSnapshot | undefined;
      let committed = false;
      let committedValue: T | undefined;

      try {
        // 空 allowlist 表示审批期间禁止 TracePilot 内部和普通外部写入。
        isolationLease = await filesystemGuard.applyExecutionIsolation(
          ctx.worktree.path,
          []
        );
        beforeSnapshot = await filesystemGuard.createSnapshot(ctx.worktree.path);

        const beforeDiff = await this.captureAndAssertApprovalDiff(
          ctx,
          input.expectedDiffHash,
          "人工审批关键区：提交前最终 Diff 捕获"
        );

        // 确定性测试在此处注入“Diff 已返回、SQLite 提交前”的竞态。
        await this.deps.approvalFinalizationHook?.({
          taskId: input.taskId,
          diffHash: beforeDiff.hash
        });

        committedValue = await input.commit();
        committed = true;

        const afterDiff = await this.captureAndAssertApprovalDiff(
          ctx,
          input.expectedDiffHash,
          "人工审批关键区：提交后 Diff 复核"
        );
        afterSnapshot = await filesystemGuard.createSnapshot(ctx.worktree.path);
        const filesystemChanges = filesystemGuard.detectChanges(
          beforeSnapshot,
          afterSnapshot
        );
        if (filesystemChanges.length > 0) {
          throw new DiffTamperError(
            input.taskId,
            input.expectedDiffHash,
            `${afterDiff.hash}; filesystem=${filesystemChanges
              .map((change) => change.relativePath)
              .join(",")}`
          );
        }

        return committedValue;
      } catch (error) {
        if (committed) {
          try {
            await input.compensate(committedValue as T);
          } catch (compensationError) {
            throw new HumanDecisionFinalizationError(
              input.taskId,
              `检测到审批竞态，但补偿失败：${(compensationError as Error).message}`,
              { cause: error as Error }
            );
          }
        }
        throw error;
      } finally {
        if (afterSnapshot) await filesystemGuard.dispose(afterSnapshot);
        if (beforeSnapshot) await filesystemGuard.dispose(beforeSnapshot);
        await isolationLease?.release();
      }
    });
  }

  /**
   * 在人工挑战签发或消费前重新读取登记 worktree 的当前 Diff。
   *
   * Review 结果和 execution_results 只代表 Review 时刻的快照；人工决定
   * 不能只比较两份旧哈希。API 必须在挑战签发前和最终消费前调用本方法，
   * 若 Review 后允许文件、新文件或原文件被改动，当前哈希不一致就失败关闭。
   */
  async assertReviewDiffStillCurrent(taskId: string): Promise<string> {
    return this.runTaskExclusive(taskId, () =>
      this.assertReviewDiffStillCurrentExclusive(taskId)
    );
  }

  private async assertReviewDiffStillCurrentExclusive(taskId: string): Promise<string> {
    const ctx = await this.loadApprovalDiffContext(taskId);
    const currentDiff = await this.captureAndAssertApprovalDiff(
      ctx,
      ctx.persisted.diffHash,
      "ExecutionOrchestrator.assertReviewDiffStillCurrent：人工审批前重新核验 Diff"
    );
    return currentDiff.hash;
  }

  private async loadApprovalDiffContext(taskId: string): Promise<{
    readonly worktree: Worktree;
    readonly persisted: ExecutionResult;
  }> {
    return this.deps.unitOfWork.run(async (tx) => {
      const base = await loadTaskContext(tx, taskId);
      if (base.task.status !== "AWAITING_HUMAN_APPROVAL") {
        throw new TaskNotInExpectedStatusError(
          taskId,
          "AWAITING_HUMAN_APPROVAL",
          base.task.status
        );
      }
      const persisted = await tx.executionResults.findLatestByTask(taskId);
      if (!persisted) {
        throw new Error(`任务 ${taskId} 无受控 execution_results，拒绝人工审批`);
      }
      return { ...base, persisted };
    });
  }

  private async captureAndAssertApprovalDiff(
    ctx: { readonly worktree: Worktree; readonly persisted: ExecutionResult },
    expectedDiffHash: string,
    reason: string
  ): Promise<DiffArtifact> {
    const currentDiff = await this.deps.worktreeManager.captureDiffForTask({
      taskId: ctx.persisted.taskId,
      worktreeId: ctx.worktree.id,
      reason
    });
    if (
      ctx.persisted.diffHash !== expectedDiffHash ||
      currentDiff.hash !== expectedDiffHash
    ) {
      throw new DiffTamperError(
        ctx.persisted.taskId,
        expectedDiffHash,
        currentDiff.hash
      );
    }
    return currentDiff;
  }

  private async runTaskExclusive<T>(
    taskId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.taskOperationTails.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.taskOperationTails.set(taskId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.taskOperationTails.get(taskId) === tail) {
        this.taskOperationTails.delete(taskId);
      }
    }
  }
}

/**
 * Diff 篡改错误 —— P1-03（Phase 4 验收）。
 *
 * 当 `runReview` 重新捕获的工作树 Diff 哈希与 `execution_results` 表中
 * 持久化的受控哈希不一致时抛出。此错误表示 runDevelop 与 runReview
 * 之间工作树被外部修改，必须拒绝 Review 并要求重新验证。
 */
export class DiffTamperError extends Error {
  constructor(
    taskId: string,
    readonly persistedHash: string,
    readonly currentHash: string
  ) {
    super(
      `任务 ${taskId} 的工作树 Diff 哈希 (${currentHash}) 与持久化哈希 (${persistedHash}) 不一致 —— 拒绝 Review，要求重新验证`
    );
    this.name = "DiffTamperError";
  }
}

/** 人工审批关键区无法建立或竞态补偿失败。 */
export class HumanDecisionFinalizationError extends Error {
  constructor(taskId: string, message: string, options?: ErrorOptions) {
    super(`任务 ${taskId} 的人工审批最终提交失败：${message}`, options);
    this.name = "HumanDecisionFinalizationError";
  }
}

/**
 * 路径范围越界错误 —— P1-R01（Phase 4 第二轮验收 §6.2）。
 *
 * 当 `runDevelop` 校验 `diff.changedFiles` 与 `Plan.allowedPaths` 时
 * 发现越界变更路径抛出。此错误表示 Omp 子进程或外部修改写入了 Plan
 * 批准范围之外的文件，必须失败关闭，禁止验证、持久化与 Review。
 */
export class PathScopeViolationError extends Error {
  constructor(
    readonly taskId: string,
    readonly violators: readonly string[],
    readonly allowedPaths: readonly string[]
  ) {
    super(
      `任务 ${taskId} 的 Diff 包含越界变更路径 (${violators.join(", ")})，不在 Plan.allowedPaths (${allowedPaths.join(", ")}) 内 —— 拒绝验证与 Review`
    );
    this.name = "PathScopeViolationError";
  }
}

/**
 * Runtime 事件流失败错误 —— P1-R02（Phase 4 第二轮验收 §6.3）。
 *
 * 当 `runAnalyze`/`runDevelop` 检测到事件流出现 `error` 事件或未以
 * `completed` 结束时抛出。此错误表示 Runtime 运行被取消、超时或异常
 * 停止，必须失败关闭，禁止后续步骤继续执行。
 */
export class RuntimeStreamFailedError extends Error {
  constructor(
    taskId: string,
    readonly role: string,
    message: string
  ) {
    super(`任务 ${taskId} 的 ${role} 运行失败：${message}`);
    this.name = "RuntimeStreamFailedError";
  }
}

/**
 * 任务状态不在预期状态错误 —— P1-R02（Phase 4 第三轮验收 §7.3 第 1 点）。
 *
 * 当 `runAnalyze`/`runDevelop`/`runReview` 在事务内 re-check 任务状态
 * 发现与预期不符时抛出。这关闭了注册前竞态：取消 API 在 API 层状态
 * 检查后、orchestrator 调用前完成状态迁移，orchestrator 在事务内
 * re-check 时发现状态已变（如 CANCELLED），立即失败关闭，不启动 Runtime。
 *
 * 调用方（API 层）应捕获此错误并返回 409 Conflict，指示客户端重新
 * 读取任务状态。
 */
export class TaskNotInExpectedStatusError extends Error {
  constructor(
    taskId: string,
    readonly expected: TaskStatus,
    readonly actual: TaskStatus
  ) {
    super(
      `任务 ${taskId} 状态不在预期 ${expected}（当前 ${actual}）—— 可能被并发取消或迁移`
    );
    this.name = "TaskNotInExpectedStatusError";
  }
}

/**
 * P1-R01（§9.2）：受保护路径检查 —— 这些路径无条件视为越界，即使
 * `allowedPaths` 包含 `**`。防止 omp 篡改 git 元数据、git 配置或 omp 配置。
 *
 * 受保护路径：
 * - `.git`（文件或目录）及其所有子路径 —— 防止重定向 gitdir、篡改 refs
 * - `.gitignore`、`.gitattributes` —— 防止篡改 git 忽略/属性规则绕过 Diff
 * - `.omp` 目录 —— 防止篡改 omp 配置覆盖工具限制
 */
export function isProtectedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/^\.\//, "").replace(/\\/g, "/");
  if (normalized === ".git" || normalized.startsWith(".git/")) return true;
  if (normalized === ".gitignore" || normalized === ".gitattributes") return true;
  if (normalized === ".omp" || normalized.startsWith(".omp/")) return true;
  return false;
}

/**
 * P1-R01：校验 changedFiles 是否全部落在 allowedPaths 内。
 *
 * allowedPaths 支持 glob 模式（与 Plan.allowedPaths 一致）：
 * - 双星号匹配任意层级目录（含 0 层）
 * - 单星号匹配单层目录或文件名（不含斜杠）
 * - 其他字符按字面匹配
 *
 * changedFiles 中的路径必须是相对 worktree 根的 POSIX 风格路径
 * （如 src/users.py），由 GitAdapter.getDiff 保证。
 *
 * 注意：此函数不检查受保护路径（`.git` 等）。调用方应先用
 * `isProtectedPath` 过滤，再调用本函数。
 *
 * @returns 越界路径列表（空数组表示全部通过）
 */
export function findPathScopeViolations(
  changedFiles: readonly string[],
  allowedPaths: readonly string[]
): readonly string[] {
  if (allowedPaths.length === 0) {
    // 未声明 allowedPaths 时拒绝所有变更（fail-closed）。
    return [...changedFiles];
  }
  const violators: string[] = [];
  for (const file of changedFiles) {
    if (!matchesAnyGlob(file, allowedPaths)) {
      violators.push(file);
    }
  }
  return violators;
}

/**
 * P1-R01（§7.2 符号链接逃逸）：检查符号链接目标是否指向 worktree 外部。
 *
 * `enforceFilesystemScope` 在遍历 `detectChanges` 产出的变更时，对
 * `after.isSymlink === true` 的变更（added / type-changed / modified）
 * 调用本函数。若返回 `true`，即使 `change.relativePath` 落在
 * `allowedPaths` 内，也视为越界 —— 这关闭了"在白名单内创建指向外部的
 * 符号链接"逃逸路径（§7.2「实际操作前解析路径」要求）。
 *
 * `symlinkTarget` 是 `readlinkSync` 的返回值，可能是相对路径（相对于
 * 符号链接所在目录）或绝对路径。本函数用纯字符串解析（core 层不导入
 * `node:fs`/`node:path`），采用 **fail-closed** 策略：解析后路径不在
 * worktree 内即视为越界。
 *
 * 注意：本函数不解析符号链接链（即目标本身又是符号链接的情况）。
 * 对安全边界采用保守策略 —— 只要目标字符串解析后在 worktree 外就拒绝。
 * 这覆盖了最常见的逃逸场景（绝对路径指向外部、相对路径 `..` 穿越到
 * 外部）。`applyExecutionIsolation` 已对 develop 前存在的符号链接做
 * `realpathSync` 解析；本函数针对 develop 期间**新建/修改**的符号链接。
 *
 * @param worktreePath worktree 根目录的绝对路径
 * @param symlinkRelativePath 符号链接本身相对 worktree 根的 POSIX 路径
 *   （如 `src/escape-link`）
 * @param symlinkTarget `readlinkSync` 返回的符号链接目标字符串
 * @returns true 表示目标指向 worktree 外部（越界）
 */
export function isSymlinkTargetOutsideWorktree(
  worktreePath: string,
  symlinkRelativePath: string,
  symlinkTarget: string
): boolean {
  // 统一分隔符为 /，折叠重复分隔符，去除尾部分隔符。
  // Windows 盘符统一小写（C: 与 c: 等价），其余部分保持原样
  // （worktreePath 与 symlinkTarget 均来自同一系统调用，大小写一致）。
  const normalize = (p: string): string =>
    p
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/")
      .replace(/\/$/, "")
      .replace(/^([a-zA-Z]:)/, (m) => m.toLowerCase());

  const normalizedWorktree = normalize(worktreePath);

  // 判断绝对路径：
  // - POSIX: 以 / 开头
  // - Windows 盘符: 形如 C:/ 或 C:\
  // - UNC: 以 \\ 开头（规范化后为 //）
  const isAbsolute =
    symlinkTarget.startsWith("/") ||
    /^[a-zA-Z]:[/\\]/.test(symlinkTarget) ||
    symlinkTarget.startsWith("\\\\");

  let resolvedTarget: string;
  if (isAbsolute) {
    resolvedTarget = normalize(symlinkTarget);
  } else {
    // 相对路径：相对于符号链接所在目录解析。
    // symlinkRelativePath 形如 `src/sub/link`，其所在目录为 `src/sub`。
    const lastSlash = symlinkRelativePath.lastIndexOf("/");
    const symlinkDir = lastSlash >= 0 ? symlinkRelativePath.slice(0, lastSlash) : "";
    const base = symlinkDir ? `${normalizedWorktree}/${symlinkDir}` : normalizedWorktree;
    resolvedTarget = resolveSymlinkTargetPath(base, symlinkTarget);
  }

  // fail-closed：解析后路径为空视为越界（不应发生，防御性处理）。
  if (resolvedTarget.length === 0) return true;

  // 比较：resolvedTarget 必须等于 worktree 或以 `worktree/` 开头。
  // 不用 `startsWith(normalizedWorktree)` 是为了避免 `C:/wt-evil` 误匹配
  // `C:/wt`。
  return !(
    resolvedTarget === normalizedWorktree ||
    resolvedTarget.startsWith(normalizedWorktree + "/")
  );
}

/**
 * 解析相对路径目标到绝对路径（纯字符串处理，不访问文件系统）。
 *
 * 把 `base`（绝对路径，已规范化为 POSIX 分隔符）与 `relative`（可能含
 * `..` / `.` / 普通分量的相对路径）拼接，逐段处理 `..`（弹出上一段）
 * 与 `.`（跳过），返回规范化后的绝对路径。
 *
 * 保留 Windows 盘符前缀（如 `C:/`）与 UNC 前缀（`//`）。`..` 越过根时
 * 停止弹出（保守处理，结果仍可能落到 worktree 外被判定为越界）。
 */
function resolveSymlinkTargetPath(base: string, relative: string): string {
  const normalizedBase = base.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  const normalizedRel = relative.replace(/\\/g, "/");

  // 提取前缀：Windows 盘符（C:）或 UNC（//）或 POSIX 根（/）。
  let prefix = "";
  let body = normalizedBase;
  const driveMatch = /^([a-zA-Z]:)(\/.*)?$/.exec(normalizedBase);
  if (driveMatch) {
    prefix = driveMatch[1]!.toLowerCase() + "/";
    body = (driveMatch[2] ?? "").replace(/^\/+/, "");
  } else if (normalizedBase.startsWith("//")) {
    prefix = "//";
    body = normalizedBase.slice(2).replace(/^\/+/, "");
  } else if (normalizedBase.startsWith("/")) {
    prefix = "/";
    body = normalizedBase.slice(1).replace(/^\/+/, "");
  }

  const parts = body.length > 0 ? body.split("/").filter((s) => s.length > 0) : [];
  for (const part of normalizedRel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  return prefix + parts.join("/");
}

/**
 * 检查 path 是否匹配 patterns 中的任一 glob 模式。
 *
 * 支持的 glob 语法（最小集，覆盖 Plan.allowedPaths 已有用法）：
 * - 双星号匹配任意层级（含 0 层）的目录段
 * - 单星号匹配单层非斜杠字符
 * - 问号匹配单个非斜杠字符
 * - 其他字符按字面匹配
 *
 * 实现把 glob 转换为正则：双星号加斜杠转为可选前缀段，单星号转为
 * 非斜杠字符类，问号转为单字符类。模式以斜杠结尾时视为目录前缀
 * （匹配其下所有文件）。
 */
function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  // 规范化路径：去除前导 `./`，统一使用 POSIX 分隔符。
  const normalized = path.replace(/^\.\//, "").replace(/\\/g, "/");
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * 把 glob 模式转换为正则表达式。
 *
 * 转换规则：
 * 1. 以斜杠结尾的目录模式（如 src/）匹配其下所有文件
 * 2. 以 /** 结尾的模式（如 src/**）匹配目录及其所有后代（兼容 0 层）
 * 3. 包含 ** 的中间模式按段转换
 * 4. 无 ** 的简单模式中，单星号转为非斜杠字符类，问号转为单字符类
 *
 * 转换后用首尾锚定整条路径，避免部分匹配。
 */
function globToRegExp(pattern: string): RegExp {
  // 规范化模式：统一 POSIX 分隔符，去除前导 ./
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");

  // 以 `/` 结尾的目录模式：匹配其下所有文件
  if (p.endsWith("/")) {
    return new RegExp(`^${escapeRegExp(p)}.*$`);
  }

  // 以 `/**` 结尾：匹配目录及其所有后代（含目录本身下的文件）
  if (p.endsWith("/**")) {
    const prefix = p.slice(0, -3); // 去除 `/**`
    // 兼容 0 层：prefix 自身或 prefix/任意后代
    return new RegExp(`^${escapeRegExp(prefix)}(/.*)?$`);
  }

  // 一般情况：逐字符转换
  let regex = "^";
  let i = 0;
  while (i < p.length) {
    const c = p[i]!;
    if (c === "*" && p[i + 1] === "*") {
      // `**` 跨层级
      // 跳过 `**`，若后面跟 `/`，则 `/` 也可省略（0 层）
      i += 2;
      if (p[i] === "/") {
        i++; // 消费 `/`
        regex += "(.*/)?";
      } else {
        regex += ".*";
      }
    } else if (c === "*") {
      // `*` 单层
      i++;
      regex += "[^/]*";
    } else if (c === "?") {
      i++;
      regex += "[^/]";
    } else {
      regex += escapeRegExpChar(c);
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

function escapeRegExp(s: string): string {
  let out = "";
  for (const c of s) {
    out += escapeRegExpChar(c);
  }
  return out;
}

function escapeRegExpChar(c: string): string {
  if (".+^$()|[]{}".includes(c)) {
    return `\\${c}`;
  }
  if (c === "/") return "/";
  return c;
}
