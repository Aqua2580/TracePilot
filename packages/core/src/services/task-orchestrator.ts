/**
 * TaskOrchestrator —— 见规格 §5.2、§8。
 *
 * 这是系统中唯一允许触发 Task 状态迁移的组件。每次迁移都在同一个
 * UnitOfWork 事务内写入对应的 AuditEvent。Orchestrator 只依赖 ports，
 * 永不直接依赖具体适配器或 Drizzle/SQLite。
 *
 * 本 Phase 1 实现覆盖：任务创建、状态迁移、取消、失败、中断与恢复、
 * 审批记录与失效、范围扩大自动失效旧执行审批（P1-02）、执行前 scopeHash
 * 校验（P1-02）。完整闭环（证据采集、规划、开发、验证、评审）在
 * Phase 2–5 落地，本文件提供它们构建的骨架。
 *
 * 重要不变量：
 * - 状态迁移 + 审计事件同事务（§5.2，P1-01）。
 * - 终态任务不可再迁移，包括同状态 no-op（P2-01）。
 * - 范围扩大时旧执行审批在同一事务内失效（P1-02）。
 * - 进入 EXECUTING 前必须校验当前 Plan 的 scopeHash 与有效执行审批
 *   的 scopeHash 一致（P1-02）。
 */

import type { Task, TaskInput, TaskStatus, ApprovalRecord, Plan, PlanNode } from "../domain/task.js";
import {
  transition,
  isTerminalStatus,
  IllegalTransitionError,
  canComplete,
  isApprovalInvalidated
} from "../domain/task.js";
import type { Project, ProjectCommands } from "../domain/project.js";
import type {
  EvidenceItem,
  Hypothesis,
  EvidenceConstraint,
  EvidencePack,
  EvidenceRequest,
  EvidenceKind
} from "../domain/evidence.js";
import { computePackContentHash, nextPackVersion } from "../domain/evidence.js";
import type { Worktree } from "../ports/adapters.js";
import type {
  AuditEvent,
  AuditEventType
} from "../domain/audit.js";
import { createAuditEvent, randomId } from "../domain/audit.js";
import type { UnitOfWork, TransactionalRepos } from "../ports/repositories.js";

export interface OrchestratorDeps {
  readonly unitOfWork: UnitOfWork;
}

/** 任务不存在时抛出。 */
export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`任务不存在：${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

/** 任务已处于终态时抛出（P2-01）。 */
export class TerminalTaskError extends Error {
  constructor(taskId: string, status: TaskStatus) {
    super(`任务 ${taskId} 已处于终态 ${status}，不可再迁移（含同状态 no-op）`);
    this.name = "TerminalTaskError";
  }
}

/** 执行审批与当前 Plan 范围不一致时抛出（P1-02）。 */
export class ScopeMismatchError extends Error {
  constructor(taskId: string, expected: string, actual: string | undefined) {
    super(
      `任务 ${taskId} 的执行审批 scopeHash (${actual ?? "无"}) 与当前 Plan (${expected}) 不一致；范围扩大后必须重新取得执行审批`
    );
    this.name = "ScopeMismatchError";
  }
}

/** 当前任务状态不接受该类型审批时抛出（P2-05）。 */
export class InvalidApprovalStateError extends Error {
  constructor(taskId: string, status: TaskStatus, kind: "execution" | "human") {
    super(`任务 ${taskId} 当前状态 ${status} 不接受 ${kind} 审批`);
    this.name = "InvalidApprovalStateError";
  }
}

export class TaskOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * 创建一个 CREATED 状态的任务。任务输入必须已经过规则抽取
   * （§8.1 步骤 1）；原始 issue 文本仅保存在 `rawSource` 供审计，
   * 永不作为权威再次解析。
   */
  async createTask(args: {
    projectId: string;
    input: TaskInput;
    taskId?: string;
  }): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      id: args.taskId ?? randomId("task"),
      projectId: args.projectId,
      status: "CREATED",
      input: args.input,
      createdAt: now,
      updatedAt: now
    };

    await this.deps.unitOfWork.run(async (tx) => {
      await tx.tasks.save(task);
      await tx.audit.append(
        createAuditEvent({
          taskId: task.id,
          type: "task_created",
          toStatus: "CREATED",
          reason: `任务创建来源：${args.input.origin}`
        })
      );
    });

    return task;
  }

  /**
   * 把任务迁移到 `to`，在同一事务内写入审计事件。非法迁移抛
   * IllegalTransitionError。
   *
   * P2-01：终态任务（含同状态 no-op）一律拒绝，避免更新时间和审计
   * 噪声，与“终态不可再迁移”一致。
   *
   * P1-02：当 `widenScope=true` 且目标为 GATHERING_EVIDENCE 时，在同一
   * 事务内自动使旧的执行审批失效并写审计事件，保证扩大范围后旧批准
   * 不可复用。
   *
   * `eventFactory` 仅供调用方附加迁移特有的审计字段（证据包哈希、
   * 审批人、scope 哈希、执行的 argv 等），这些字段在事务内合并到审计
   * 事件。
   */
  async transitionTask(
    taskId: string,
    to: TaskStatus,
    options?: {
      widenScope?: boolean;
      reason?: string;
      audit?: Partial<
        Omit<AuditEvent, "id" | "taskId" | "type" | "recordedAt" | "fromStatus" | "toStatus">
      >;
      auditEventType?: AuditEventType;
    }
  ): Promise<Task> {
    return this.deps.unitOfWork.run(async (tx) => {
      const current = await tx.tasks.findById(taskId);
      if (!current) throw new TaskNotFoundError(taskId);

      // P1-R02：通用迁移接口不得用于进入 EXECUTING。进入 EXECUTING 只能
      // 经 beginExecutionIfApproved，由它在事务内校验有效执行审批与
      // scopeHash 一致（§5.2、§7.2）。否则调用方可完全不创建审批记录
      // 而进入执行态，违反执行审批安全边界。
      if (to === "EXECUTING") {
        throw new IllegalTransitionError(
          `禁止通过 transitionTask 迁移到 EXECUTING —— 必须经 beginExecutionIfApproved 并校验有效执行审批与 scopeHash`
        );
      }

      const from = current.status;

      // P2-01：终态拒绝所有迁移，包括同状态 no-op。
      if (isTerminalStatus(from)) {
        throw new TerminalTaskError(taskId, from);
      }

      // 非终态同状态迁移同样拒绝 —— 无意义的 no-op 不应更新时间戳或写
      // 审计噪声，且让并发请求中“迟到的那一个”基于最新状态被拒绝
      // （P1-01 串行化契约）。INTERRUPTED 的 resume 走独立 resume() 方法。
      if (from === to) {
        throw new IllegalTransitionError(
          `任务 ${taskId} 已处于 ${from}，拒绝同状态 no-op 迁移`
        );
      }

      // 纯状态机校验，非法边抛错。
      transition(from, to, { widenScope: options?.widenScope });

      // P1-02：范围扩大时在同一事务内失效旧执行审批。
      if (options?.widenScope && to === "GATHERING_EVIDENCE") {
        await this.invalidateExecutionApprovalInternal(tx, taskId, options.reason ?? "新计划扩大范围，旧执行审批失效");
      }

      const updated: Task = {
        ...current,
        status: to,
        updatedAt: new Date().toISOString(),
        lastTransitionReason: options?.reason ?? current.lastTransitionReason
      };
      await tx.tasks.save(updated);

      await tx.audit.append(
        createAuditEvent({
          taskId,
          type: options?.auditEventType ?? "task_transitioned",
          fromStatus: from,
          toStatus: to,
          reason: options?.reason,
          ...options?.audit
        })
      );

      return updated;
    });
  }

  /** 便利方法：取消非终态任务。 */
  async cancel(taskId: string, reason: string): Promise<Task> {
    const current = await this.deps.unitOfWork.run((tx) => tx.tasks.findById(taskId));
    if (!current) throw new TaskNotFoundError(taskId);
    if (isTerminalStatus(current.status)) {
      throw new TerminalTaskError(taskId, current.status);
    }
    return this.transitionTask(taskId, "CANCELLED", {
      reason,
      auditEventType: "task_cancelled"
    });
  }

  /** 把非终态任务标记为 FAILED。 */
  async fail(taskId: string, reason: string): Promise<Task> {
    return this.transitionTask(taskId, "FAILED", {
      reason,
      auditEventType: "task_transitioned"
    });
  }

  /**
   * 把非终态任务标记为 INTERRUPTED —— 服务启动时对仍处于非终态的任务
   * 调用。见 §5.2：永不为中途死亡的进程声称成功。
   */
  async interrupt(taskId: string, reason: string): Promise<Task> {
    return this.transitionTask(taskId, "INTERRUPTED", {
      reason,
      auditEventType: "task_interrupted"
    });
  }

  /**
   * 恢复启动时发现的非终态任务。每个仍处于 EXECUTING / VALIDATING 的
   * 任务被迁移到 INTERRUPTED（永不静默完成）。返回被恢复的任务，供
   * API 向操作者展示。
   *
   * 这是 §3.1 / §5.2 的“服务重启”恢复例程。
   */
  async recoverInterruptedTasks(): Promise<Task[]> {
    const stalled = await this.deps.unitOfWork.run((tx) =>
      tx.tasks.findInNonTerminalStatuses()
    );
    const recovered: Task[] = [];
    for (const t of stalled) {
      // 仅 EXECUTING 和 VALIDATING 表示“进程中途死亡”，必须迁移到
      // INTERRUPTED。其他非终态状态可以保留 —— 它们本就在等待外部
      // 事件（审批、证据请求等）。
      if (t.status === "EXECUTING" || t.status === "VALIDATING") {
        const updated = await this.interrupt(
          t.id,
          `服务重启：任务启动时处于 ${t.status}`
        );
        recovered.push(updated);
      }
    }
    return recovered;
  }

  /**
   * 恢复 INTERRUPTED 任务。重新进入一个安全的早期非终态状态以重跑被
   * 中断的步骤。见 §5.2：永不直接恢复到 COMPLETED。
   */
  async resume(taskId: string, target: TaskStatus): Promise<Task> {
    if (target === "COMPLETED") {
      throw new IllegalTransitionError(
        "不可直接恢复到 COMPLETED —— 必须重跑验证 + 评审 + 审批"
      );
    }
    // INTERRUPTED 是终态，但允许通过显式 resume 操作恢复，绕过 P2-01
    // 的终态拒绝。这里直接走 UnitOfWork，不经过 transitionTask 的终态
    // 守卫。
    return this.deps.unitOfWork.run(async (tx) => {
      const current = await tx.tasks.findById(taskId);
      if (!current) throw new TaskNotFoundError(taskId);
      if (current.status !== "INTERRUPTED") {
        throw new IllegalTransitionError(
          `仅 INTERRUPTED 任务可调用 resume，当前状态：${current.status}`
        );
      }
      // 纯状态机校验：INTERRUPTED → target 必须合法。
      transition("INTERRUPTED", target);

      const updated: Task = {
        ...current,
        status: target,
        updatedAt: new Date().toISOString(),
        lastTransitionReason: `从 INTERRUPTED 恢复到 ${target}`
      };
      await tx.tasks.save(updated);
      await tx.audit.append(
        createAuditEvent({
          taskId,
          type: "task_transitioned",
          fromStatus: "INTERRUPTED",
          toStatus: target,
          reason: updated.lastTransitionReason
        })
      );
      return updated;
    });
  }

  /**
   * 记录审批闸门决定。`execution` 与 `human` 审批都持久化 scope 哈希，
   * 以便后续检测范围扩大并使旧执行审批失效（§5.2）。
   *
   * P2-05：验证任务存在且当前状态允许该类审批。
   * - execution 审批：仅 AWAITING_EXECUTION_APPROVAL 接受。
   * - human 审批：仅 AWAITING_HUMAN_APPROVAL 接受。
   */
  async recordApproval(args: {
    taskId: string;
    kind: "execution" | "human";
    approver: string;
    decision: "approved" | "rejected";
    scopeHash: string;
    reason?: string;
  }): Promise<ApprovalRecord> {
    const approval: ApprovalRecord = {
      id: randomId("approval"),
      taskId: args.taskId,
      kind: args.kind,
      approver: args.approver,
      decision: args.decision,
      reason: args.reason,
      approvedAt: new Date().toISOString(),
      scopeHash: args.scopeHash
    };

    await this.deps.unitOfWork.run(async (tx) => {
      // P2-05：验证任务存在与状态。
      const task = await tx.tasks.findById(args.taskId);
      if (!task) throw new TaskNotFoundError(args.taskId);
      const allowedStatus: Record<typeof args.kind, TaskStatus> = {
        execution: "AWAITING_EXECUTION_APPROVAL",
        human: "AWAITING_HUMAN_APPROVAL"
      };
      if (task.status !== allowedStatus[args.kind]) {
        throw new InvalidApprovalStateError(args.taskId, task.status, args.kind);
      }

      await tx.approvals.save(approval);
      await tx.audit.append(
        createAuditEvent({
          taskId: args.taskId,
          type:
            args.kind === "execution"
              ? args.decision === "approved"
                ? "execution_approval_granted"
                : "execution_approval_requested"
              : args.decision === "approved"
                ? "human_approval_granted"
                : "human_approval_rejected",
          approver: args.approver,
          scopeHash: args.scopeHash,
          reason: args.reason
        })
      );
    });

    return approval;
  }

  /**
   * §5.2 范围扩大：新计划扩大允许路径 / 命令 / 风险等级时，旧执行审批
   * 失效。我们不在审批表删除旧记录（审计仅追加），而是在同一事务内把
   * 旧 ApprovalRecord 写回带 `invalidatedAt` 的新版本，并追加
   * `execution_approval_invalidated` 审计事件。此后
   * `findLatestExecutionApproval` 不再返回该记录（见 P1-02）。
   */
  async invalidateExecutionApproval(taskId: string, reason: string): Promise<void> {
    await this.deps.unitOfWork.run(async (tx) => {
      await this.invalidateExecutionApprovalInternal(tx, taskId, reason);
    });
  }

  /** 内部：在已开启的事务内失效旧执行审批。 */
  private async invalidateExecutionApprovalInternal(
    tx: TransactionalRepos,
    taskId: string,
    reason: string
  ): Promise<void> {
    const latest = await tx.approvals.findLatestExecutionApproval(taskId);
    if (!latest || isApprovalInvalidated(latest)) return;

    const invalidated: ApprovalRecord = {
      ...latest,
      invalidatedAt: new Date().toISOString(),
      invalidationReason: reason
    };
    await tx.approvals.save(invalidated);
    await tx.audit.append(
      createAuditEvent({
        taskId,
        type: "execution_approval_invalidated",
        reason,
        approver: invalidated.approver,
        scopeHash: invalidated.scopeHash
      })
    );
  }

  /**
   * 进入 EXECUTING 前的 scopeHash 校验闸门（P1-02 / P1-R04）。
   *
   * **P1-R04 修正**：不再接受调用方传入的 `planScopeHash`。调用方可
   * 持有陈旧或伪造的 hash，在同名命令 argv 替换后仍能通过校验。现在
   * Orchestrator 在事务内通过 `computeCurrentScopeHashFromTx` 从
   * `task.currentPlanId`、当前项目命令与风险等级重新计算权威 scopeHash，
   * 再与 approval.scopeHash 比对。不一致则抛 ScopeMismatchError。
   *
   * 用法：
   * ```ts
   * await orchestrator.beginExecutionIfApproved(taskId);
   * ```
   */
  async beginExecutionIfApproved(taskId: string): Promise<Task> {
    return this.deps.unitOfWork.run(async (tx) => {
      const current = await tx.tasks.findById(taskId);
      if (!current) throw new TaskNotFoundError(taskId);
      if (current.status !== "AWAITING_EXECUTION_APPROVAL") {
        throw new IllegalTransitionError(
          `仅 AWAITING_EXECUTION_APPROVAL 可进入 EXECUTING，当前：${current.status}`
        );
      }
      const approval = await tx.approvals.findLatestExecutionApproval(taskId);
      if (!approval) {
        throw new ScopeMismatchError(taskId, "<none>", undefined);
      }

      // P1-R04：事务内重算权威 scopeHash，不信任调用方传入的值。
      const currentScopeHash = await computeCurrentScopeHashFromTx(tx, taskId);

      if (approval.scopeHash !== currentScopeHash) {
        throw new ScopeMismatchError(
          taskId,
          currentScopeHash,
          approval.scopeHash
        );
      }

      // 校验通过，迁移到 EXECUTING 并写审计。
      transition(current.status, "EXECUTING");
      const updated: Task = {
        ...current,
        status: "EXECUTING",
        updatedAt: new Date().toISOString(),
        lastTransitionReason: "执行审批通过，scopeHash 一致"
      };
      await tx.tasks.save(updated);
      await tx.audit.append(
        createAuditEvent({
          taskId,
          type: "task_transitioned",
          fromStatus: current.status,
          toStatus: "EXECUTING",
          reason: updated.lastTransitionReason,
          approver: approval.approver,
          scopeHash: approval.scopeHash
        })
      );
      return updated;
    });
  }

  /**
   * 最终完成闸门。见 §5.2 / §12.1：COMPLETED 要求验证通过 + 无 P0/P1 +
   * 人类审批。Orchestrator 在签发最终迁移前检查这三项。
   *
   * 注意：本 Phase 1 实现仍接受调用方布尔参数（P2-05 标记为部分实现）。
   * Phase 5 前必须改为从持久化的验证结果 / Review 结果 / Approval 记录
   * 中计算，而不是信任调用方传入的布尔值。
   */
  async completeIfEligible(args: {
    taskId: string;
    validationPassed: boolean;
    hasP0OrP1ReviewFindings: boolean;
    hasHumanApproval: boolean;
  }): Promise<Task> {
    if (
      !canComplete({
        validationPassed: args.validationPassed,
        hasP0OrP1ReviewFindings: args.hasP0OrP1ReviewFindings,
        hasHumanApproval: args.hasHumanApproval
      })
    ) {
      throw new IllegalTransitionError(
        "任务不满足 COMPLETED 条件：缺少验证 / 评审洁净 / 人类审批"
      );
    }
    return this.transitionTask(args.taskId, "COMPLETED", {
      reason: "验证通过、评审无 P0/P1、人类审批已记录",
      auditEventType: "task_transitioned"
    });
  }

  // -----------------------------------------------------------------------
  // Phase 3：证据 / Pack / worktree 编排方法（§5.3、§8.1 步骤 3-5）
  // -----------------------------------------------------------------------

  /**
   * P1-R03：在 PLANNED 状态下持久化 Plan（含 allowedPaths）。
   *
   * 见规格 §8.1 步骤 4：Planner 输出线性计划，确定 allowedPaths。
   * allowedPaths 是执行审批范围快照的组成部分，后续
   * `WorktreeManager.createAndAttachWorktree` 必须从 Plan 读取
   * allowedPaths，不得信任请求体提供的任意值。
   *
   * 在同一 UnitOfWork 事务内：
   * - 校验任务处于 PLANNED 状态
   * - 持久化 Plan（含 allowedPaths）
   * - 更新 task.currentPlanId
   * - 追加 plan_recorded 审计事件
   *
   * 本方法不迁移状态。PLANNED → AWAITING_EXECUTION_APPROVAL 仍由
   * `transitionTask` 处理，确保状态机单入口。
   */
  async planTask(args: {
    readonly taskId: string;
    readonly planId?: string;
    readonly nodes: readonly PlanNode[];
    readonly allowedPaths: readonly string[];
    readonly inputEvidencePackId: string;
    readonly inputEvidencePackVersion: number;
  }): Promise<Plan> {
    return this.deps.unitOfWork.run(async (tx) => {
      const task = await tx.tasks.findById(args.taskId);
      if (!task) throw new TaskNotFoundError(args.taskId);
      if (task.status !== "PLANNED") {
        throw new IllegalTransitionError(
          `仅 PLANNED 状态可记录 Plan，当前：${task.status}`
        );
      }

      const createdAt = new Date().toISOString();
      const plan: Plan = {
        id: args.planId ?? randomId("plan"),
        taskId: args.taskId,
        nodes: [...args.nodes],
        inputEvidencePackId: args.inputEvidencePackId,
        inputEvidencePackVersion: args.inputEvidencePackVersion,
        createdAt,
        allowedPaths: [...args.allowedPaths]
      };

      await tx.plans.save(plan);

      const updatedTask: Task = {
        ...task,
        currentPlanId: plan.id,
        updatedAt: createdAt
      };
      await tx.tasks.save(updatedTask);

      await tx.audit.append(
        createAuditEvent({
          taskId: args.taskId,
          type: "plan_recorded",
          planId: plan.id,
          reason: `记录 Plan ${plan.id}：${plan.nodes.length} 个节点，allowedPaths=${plan.allowedPaths.join(",")}`
        })
      );

      return plan;
    });
  }

  /**
   * P1-R03 / P1-R04：计算任务当前的 scopeHash。
   *
   * 从持久化的 Plan.allowedPaths + Project.commands 完整契约 +
   * TaskInput.riskLevel 计算 scopeHash。这是执行审批范围快照的权威来源。
   *
   * **P1-R04 修正**：
   * - scopeHash 必须包含每条命令的完整 argv + timeoutMs，不得仅哈希命令 key。
   *   否则审批后保留同一 key 但替换 argv（例如把 `pytest` 改成 `rm -rf /`）
   *   不会改变 scopeHash，违反规格 §7.2。
   * - 必须使用 `task.currentPlanId` 读取权威 Plan，不得以按时间排序的
   *   "最后一条 Plan"代替。否则旧 Plan 仍可被用于通过校验。
   *
   * 调用方：
   * - `recordApproval` 调用前先调用本方法获取 scopeHash
   * - `WorktreeManager.createAndAttachWorktree` 在事务内调用本方法
   *   比对 approval.scopeHash
   * - `beginExecutionIfApproved` 在事务内调用本方法重算权威 scopeHash
   */
  async computeCurrentScopeHash(taskId: string): Promise<string> {
    return this.deps.unitOfWork.run(async (tx) => {
      const task = await tx.tasks.findById(taskId);
      if (!task) throw new TaskNotFoundError(taskId);

      const project = await tx.projects.findById(task.projectId);
      if (!project) {
        throw new Error(`项目 ${task.projectId} 不存在（任务 ${taskId}）`);
      }

      // P1-R04：使用 task.currentPlanId 读取权威 Plan，而非按时间排序的最后一条。
      if (!task.currentPlanId) {
        throw new Error(
          `任务 ${taskId} 尚未记录 Plan（currentPlanId 为空），无法计算 scopeHash`
        );
      }
      const plan = await tx.plans.findById(task.currentPlanId);
      if (!plan) {
        throw new Error(
          `任务 ${taskId} 的 currentPlanId=${task.currentPlanId} 在 Plan 仓储中不存在`
        );
      }

      return computeScopeHash({
        allowedPaths: plan.allowedPaths,
        commands: project.commands,
        riskLevel: task.input.riskLevel
      });
    });
  }

  /**
   * 在 GATHERING_EVIDENCE 状态下收集证据并生成 Evidence Pack v1。
   *
   * 在同一 UnitOfWork 事务内：
   * - 校验任务处于 GATHERING_EVIDENCE 状态，否则抛 IllegalTransitionError
   * - P1-05：验证每条证据的可回溯字段（source、locator、contentHash）非空
   * - 构造 Pack v1（version=1），计算 contentHash
   * - 持久化 Pack，更新 task.currentEvidencePackId / Version
   * - 追加 evidence_pack_versioned 审计事件
   */
  async gatherEvidenceAndCreatePack(args: {
    taskId: string;
    packId: string;
    evidence: readonly EvidenceItem[];
    hypotheses?: readonly Hypothesis[];
    constraints?: readonly EvidenceConstraint[];
    acceptanceCriteria?: readonly string[];
  }): Promise<EvidencePack> {
    return this.deps.unitOfWork.run(async (tx) => {
      const task = await tx.tasks.findById(args.taskId);
      if (!task) throw new TaskNotFoundError(args.taskId);
      if (task.status !== "GATHERING_EVIDENCE") {
        throw new IllegalTransitionError(
          `仅 GATHERING_EVIDENCE 状态可生成 Evidence Pack v1，当前：${task.status}`
        );
      }

      // P1-05：验证每条证据的可回溯字段非空。
      // 所有 Pack 证据必须可回溯来源（§5.3、Phase 3 退出条件）。
      for (const item of args.evidence) {
        if (!item.source || item.source.length === 0) {
          throw new Error(
            `EvidenceItem ${item.id} 缺少 source 字段，所有 Pack 证据必须可回溯来源`
          );
        }
        if (!item.locator || item.locator.length === 0) {
          throw new Error(
            `EvidenceItem ${item.id} 缺少 locator 字段，所有 Pack 证据必须可回溯来源`
          );
        }
        if (!item.contentHash || item.contentHash.length === 0) {
          throw new Error(
            `EvidenceItem ${item.id} 缺少 contentHash 字段，所有 Pack 证据必须可回溯来源`
          );
        }
      }

      const evidence = [...args.evidence];
      const hypotheses = args.hypotheses ? [...args.hypotheses] : [];
      const constraints = args.constraints ? [...args.constraints] : [];
      const acceptanceCriteria = args.acceptanceCriteria ?? [];

      const createdAt = new Date().toISOString();
      const contentHash = computePackContentHash({
        id: args.packId,
        taskId: args.taskId,
        version: 1,
        taskSnapshot: task.input,
        evidence,
        hypotheses,
        constraints,
        acceptanceCriteria
      });

      const pack: EvidencePack = {
        id: args.packId,
        taskId: args.taskId,
        version: 1,
        taskSnapshot: task.input,
        evidence,
        hypotheses,
        constraints,
        acceptanceCriteria,
        createdAt,
        contentHash
      };

      await tx.evidencePacks.save(pack);

      const updatedTask: Task = {
        ...task,
        currentEvidencePackId: pack.id,
        currentEvidencePackVersion: 1,
        updatedAt: createdAt
      };
      await tx.tasks.save(updatedTask);

      await tx.audit.append(
        createAuditEvent({
          taskId: args.taskId,
          type: "evidence_pack_versioned",
          evidencePackId: pack.id,
          evidencePackVersion: pack.version,
          evidencePackHash: pack.contentHash,
          reason: "生成 Evidence Pack v1"
        })
      );

      return pack;
    });
  }

  /**
   * 提交 EvidenceRequest —— Agent 发现证据不足时的结构化请求。
   *
   * 在同一 UnitOfWork 事务内：
   * - 校验任务存在
   * - 持久化 EvidenceRequest
   * - 若任务处于 EXECUTING：迁移到 EVIDENCE_GAP（经纯状态机校验）
   * - 否则保持当前状态
   * - 追加 evidence_request_submitted 审计事件
   */
  async submitEvidenceRequest(args: {
    taskId: string;
    requestId?: string;
    requesterRole: "planner" | "developer" | "reviewer";
    gapReason: string;
    neededKinds: readonly EvidenceKind[];
    allowedScope: string;
    expectedPlanImpact: string;
  }): Promise<EvidenceRequest> {
    return this.deps.unitOfWork.run(async (tx) => {
      const task = await tx.tasks.findById(args.taskId);
      if (!task) throw new TaskNotFoundError(args.taskId);

      const requestedAt = new Date().toISOString();
      const req: EvidenceRequest = {
        id: args.requestId ?? randomId("ereq"),
        taskId: args.taskId,
        requesterRole: args.requesterRole,
        gapReason: args.gapReason,
        neededKinds: [...args.neededKinds],
        allowedScope: args.allowedScope,
        expectedPlanImpact: args.expectedPlanImpact,
        requestedAt
      };

      await tx.evidenceRequests.save(req);

      let updatedTask = task;
      if (task.status === "EXECUTING") {
        // 纯状态机校验：EXECUTING → EVIDENCE_GAP 必须合法。
        transition(task.status, "EVIDENCE_GAP");
        updatedTask = {
          ...task,
          status: "EVIDENCE_GAP",
          updatedAt: requestedAt
        };
        await tx.tasks.save(updatedTask);
      }

      await tx.audit.append(
        createAuditEvent({
          taskId: args.taskId,
          type: "evidence_request_submitted",
          fromStatus: task.status,
          toStatus: updatedTask.status,
          reason: args.gapReason
        })
      );

      return req;
    });
  }

  /**
   * 基于 EvidenceRequest 升级 Pack 版本（v(n+1)）。
   *
   * 在同一 UnitOfWork 事务内：
   * - 校验任务与 EvidenceRequest 存在
   * - P1-04：校验 EvidenceRequest.taskId === args.taskId，拒绝跨任务 Request
   * - 读取当前 Pack 最新版本
   * - 调用 nextPackVersion 生成新版本
   * - 持久化新 Pack，更新 task.currentEvidencePackVersion
   * - 追加 evidence_pack_versioned 审计事件
   *
   * 旧版本永久保留以供审计（§5.3）。
   */
  async evolvePackWithNewEvidence(args: {
    taskId: string;
    requestId: string;
    additions: {
      evidence: readonly EvidenceItem[];
      hypotheses?: readonly Hypothesis[];
      constraints?: readonly EvidenceConstraint[];
      acceptanceCriteria?: readonly string[];
    };
  }): Promise<EvidencePack> {
    return this.deps.unitOfWork.run(async (tx) => {
      const task = await tx.tasks.findById(args.taskId);
      if (!task) throw new TaskNotFoundError(args.taskId);

      const req = await tx.evidenceRequests.findById(args.requestId);
      if (!req) {
        throw new Error(`EvidenceRequest 不存在：${args.requestId}`);
      }

      // P1-04：拒绝跨任务 Evidence Request。
      // 一个任务的 Request 不可用于升级另一个任务的 Pack，
      // 保证 Pack 与证据请求的任务隔离。
      if (req.taskId !== args.taskId) {
        throw new Error(
          `EvidenceRequest ${args.requestId} 属于任务 ${req.taskId}，不可用于升级任务 ${args.taskId} 的 Pack`
        );
      }

      if (!task.currentEvidencePackId) {
        throw new Error(
          `任务 ${args.taskId} 尚未关联 Evidence Pack，无法升级版本`
        );
      }
      const previous = await tx.evidencePacks.findLatestVersion(
        task.currentEvidencePackId
      );
      if (!previous) {
        throw new Error(
          `Evidence Pack ${task.currentEvidencePackId} 不存在最新版本`
        );
      }

      const newPack = nextPackVersion(previous, args.additions);
      await tx.evidencePacks.save(newPack);

      const updatedTask: Task = {
        ...task,
        currentEvidencePackVersion: newPack.version,
        updatedAt: newPack.createdAt
      };
      await tx.tasks.save(updatedTask);

      await tx.audit.append(
        createAuditEvent({
          taskId: args.taskId,
          type: "evidence_pack_versioned",
          evidencePackId: newPack.id,
          evidencePackVersion: newPack.version,
          evidencePackHash: newPack.contentHash,
          reason: "基于 EvidenceRequest 升级 Pack 版本"
        })
      );

      return newPack;
    });
  }

  /**
   * 将 worktree 登记并关联到任务（P1-01 修复）。
   *
   * 在同一 UnitOfWork 事务内：
   * - 校验任务存在
   * - 调用 tx.worktrees.save(worktree) 持久化登记记录（避免数据库外键
   *   式引用指向不存在的 worktree）
   * - 更新 task.worktreeId
   * - 追加 worktree_created 审计事件，reason 携带 worktreeId / path /
   *   branch 用于审计回溯
   *
   * 失败时由 UnitOfWork 回滚整个事务，保证 task 与 worktree 登记一致。
   * Adapter 层（LocalGitAdapter.createWorktree）的真实 git 操作在本方法
   * 之外执行；调用方（WorktreeManager）负责在 git 操作成功后再调用本方法，
   * 并在失败时调用 removeRegisteredWorktree 进行受控清理。
   */
  async attachWorktree(taskId: string, worktree: Worktree): Promise<Task> {
    return this.deps.unitOfWork.run(async (tx) => {
      const task = await tx.tasks.findById(taskId);
      if (!task) throw new TaskNotFoundError(taskId);

      // P1-01：在同一事务内保存 worktree 登记记录。
      await tx.worktrees.save(worktree);

      const updatedAt = new Date().toISOString();
      const updatedTask: Task = {
        ...task,
        worktreeId: worktree.id,
        updatedAt
      };
      await tx.tasks.save(updatedTask);

      await tx.audit.append(
        createAuditEvent({
          taskId,
          type: "worktree_created",
          reason: `登记 worktree ${worktree.id} (path=${worktree.path}, branch=${worktree.branch}, baseCommit=${worktree.baseCommitSha})`
        })
      );

      return updatedTask;
    });
  }

  /**
   * 在同一 UnitOfWork 事务内删除 worktree 登记并追加 worktree_removed
   * 审计事件（P1-01 修复）。
   *
   * 调用方（WorktreeManager）必须先校验：
   * - worktree 在数据库中已登记（findById 命中）
   * - 关联任务已处于终态（COMPLETED / FAILED / CANCELLED / INTERRUPTED /
   *   REJECTED）
   * - worktree.path 经 PathPolicy 校验位于受控 worktree 根目录内
   * 之后才能调用 Adapter.removeRegisteredWorktree 执行真实 git 清理，
   * 清理成功后调用本方法删除登记记录并写审计。
   */
  async detachWorktree(taskId: string, worktreeId: string, reason: string): Promise<void> {
    return this.deps.unitOfWork.run(async (tx) => {
      const task = await tx.tasks.findById(taskId);
      if (!task) throw new TaskNotFoundError(taskId);

      const registered = await tx.worktrees.findById(worktreeId);
      if (!registered) {
        throw new Error(`worktree ${worktreeId} 未在数据库登记，无法 detach`);
      }
      if (registered.taskId !== taskId) {
        throw new Error(
          `worktree ${worktreeId} 属于任务 ${registered.taskId}，不可从任务 ${taskId} detach`
        );
      }

      await tx.worktrees.delete(worktreeId);

      // 解除 task.worktreeId 引用，保持 task 与登记一致。
      if (task.worktreeId === worktreeId) {
        const updatedTask: Task = {
          ...task,
          worktreeId: undefined,
          updatedAt: new Date().toISOString()
        };
        await tx.tasks.save(updatedTask);
      }

      await tx.audit.append(
        createAuditEvent({
          taskId,
          type: "worktree_removed",
          reason: `回收 worktree ${worktreeId} (path=${registered.path}): ${reason}`
        })
      );
    });
  }
}

/**
 * P1-R04：在已开启的事务内计算任务当前的 scopeHash。
 *
 * 与 `computeCurrentScopeHash` 方法等价，但避免在 `beginExecutionIfApproved`
 * 事务回调内再调用 `unitOfWork.run` 导致嵌套事务（SQLite 串行队列会死锁）。
 *
 * 必须传入当前事务的 `tx`，从 `task.currentPlanId` 读取权威 Plan，
 * 并使用 Project.commands 完整契约（argv + timeoutMs）计算 scopeHash。
 */
async function computeCurrentScopeHashFromTx(
  tx: TransactionalRepos,
  taskId: string
): Promise<string> {
  const task = await tx.tasks.findById(taskId);
  if (!task) throw new TaskNotFoundError(taskId);

  const project = await tx.projects.findById(task.projectId);
  if (!project) {
    throw new Error(`项目 ${task.projectId} 不存在（任务 ${taskId}）`);
  }

  if (!task.currentPlanId) {
    throw new Error(
      `任务 ${taskId} 尚未记录 Plan（currentPlanId 为空），无法计算 scopeHash`
    );
  }
  const plan = await tx.plans.findById(task.currentPlanId);
  if (!plan) {
    throw new Error(
      `任务 ${taskId} 的 currentPlanId=${task.currentPlanId} 在 Plan 仓储中不存在`
    );
  }

  return computeScopeHash({
    allowedPaths: plan.allowedPaths,
    commands: project.commands,
    riskLevel: task.input.riskLevel
  });
}

/**
 * 适配器 / API 用的辅助函数：根据 Plan + worktree 允许路径 + 风险等级
 * 计算 scope 哈希，供 Orchestrator 检测范围扩大。
 *
 * P1-R04：commandWhitelist 必须包含每条命令的完整契约（argv + timeoutMs），
 * 不得仅哈希命令 key。否则审批后保留同一 key 但替换 argv 不会改变
 * scopeHash，违反规格 §7.2「命令只能匹配项目注册时固定 argv 白名单」。
 *
 * 规范化规则：
 * - 命令按 key 排序（lint / typecheck / test / build）
 * - 每条命令的 argv 数组按原序保留（argv 顺序影响执行语义）
 * - timeoutMs 直接参与哈希
 * - allowedPaths 按字典序排序
 * - riskLevel 原样参与
 */
export function computeScopeHash(args: {
  allowedPaths: readonly string[];
  /** 完整命令契约（argv + timeoutMs），按 key 排序后参与哈希。 */
  commands: ProjectCommands;
  riskLevel: string;
}): string {
  // 确定性规范化序列化；与 Pack 相同的 FNV-1a 方法。
  // 命令按 key 排序，每条命令的 argv 按原序保留。
  const commandKeys = Object.keys(args.commands).sort();
  const commandsCanonical = commandKeys.map((key) => {
    const spec = args.commands[key as keyof ProjectCommands];
    return {
      key,
      argv: spec ? [...spec.argv] : null,
      timeoutMs: spec ? spec.timeoutMs : null
    };
  });

  const canonical = JSON.stringify({
    allowedPaths: [...args.allowedPaths].sort(),
    commands: commandsCanonical,
    riskLevel: args.riskLevel
  } as const);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `scope-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** 重新导出，供 apps/api composition root 使用。 */
export type { TransactionalRepos, Project };
