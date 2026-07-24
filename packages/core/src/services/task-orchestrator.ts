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

import type { Task, TaskInput, TaskStatus, ApprovalRecord } from "../domain/task.js";
import {
  transition,
  isTerminalStatus,
  IllegalTransitionError,
  canComplete,
  isApprovalInvalidated
} from "../domain/task.js";
import type { Project } from "../domain/project.js";
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
   * 进入 EXECUTING 前的 scopeHash 校验闸门（P1-02）。
   *
   * 调用方传入当前 Plan 的 scopeHash，Orchestrator 在事务内读取当前
   * 有效执行审批，比对两者。不一致则抛 ScopeMismatchError，阻止迁移。
   *
   * 用法：
   * ```ts
   * await orchestrator.beginExecutionIfApproved(taskId, planScopeHash);
   * ```
   */
  async beginExecutionIfApproved(taskId: string, planScopeHash: string): Promise<Task> {
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
        throw new ScopeMismatchError(taskId, planScopeHash, undefined);
      }
      if (approval.scopeHash !== planScopeHash) {
        throw new ScopeMismatchError(taskId, planScopeHash, approval.scopeHash);
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
}

/**
 * 适配器 / API 用的辅助函数：根据 Plan + worktree 允许路径 + 风险等级
 * 计算 scope 哈希，供 Orchestrator 检测范围扩大。
 */
export function computeScopeHash(args: {
  allowedPaths: readonly string[];
  commandWhitelist: readonly string[];
  riskLevel: string;
}): string {
  // 确定性规范化序列化；与 Pack 相同的 FNV-1a 方法。
  const canonical = JSON.stringify({
    allowedPaths: [...args.allowedPaths].sort(),
    commandWhitelist: [...args.commandWhitelist].sort(),
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
