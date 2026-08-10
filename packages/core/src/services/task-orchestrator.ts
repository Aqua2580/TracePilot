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
import type { ReviewResult, Worktree } from "../ports/adapters.js";
import type {
  RepairRecord,
  ReviewFinding,
  ReviewSummary,
  VerificationSummary
} from "../domain/repair-record.js";
import { transitionRepairRecord } from "../domain/repair-record.js";
import {
  evaluateReviewQuality,
  isReviewFindingCategory,
  type ReviewQualityGateResult
} from "../domain/review.js";
import type {
  AuditEvent,
  AuditEventType
} from "../domain/audit.js";
import { createAuditEvent, randomId } from "../domain/audit.js";
import type { UnitOfWork, TransactionalRepos } from "../ports/repositories.js";
import type { HumanDecisionFinalizationGuard } from "../ports/human-decision-finalization.js";

export interface OrchestratorDeps {
  readonly unitOfWork: UnitOfWork;
  /** 只供可信人工通道使用的身份与挑战凭证配置。 */
  readonly humanApproval?: HumanApprovalConfig;
  /** 最终 Diff、任务级互斥、提交后复核与失败补偿的强制守卫。 */
  readonly humanDecisionFinalizationGuard?: HumanDecisionFinalizationGuard;
}

export interface HumanApprovalConfig {
  /** 服务端配置的人工身份，不从 HTTP 请求体读取。 */
  readonly identity?: string;
  /** 仅在人类 UI/CLI 通道中提供的共享凭证；绝不注入 Runtime 进程。 */
  readonly channelSecret?: string;
  /** 一次性挑战有效期，默认 5 分钟。 */
  readonly challengeTtlMs?: number;
}

export interface HumanApprovalChallenge {
  readonly challengeId: string;
  /** 一次性随机凭证；只在签发响应中返回，服务端只保存其摘要。 */
  readonly challengeToken: string;
  readonly taskId: string;
  readonly repairRecordId: string;
  readonly evidencePackId: string;
  readonly evidencePackVersion: number;
  readonly evidencePackContentHash: string;
  readonly diffHash: string;
  readonly decision: "approved" | "rejected";
  readonly approver: string;
  readonly expiresAt: string;
}

interface PendingHumanApprovalChallenge {
  readonly challengeId: string;
  readonly taskId: string;
  readonly repairRecordId: string;
  readonly evidencePackId: string;
  readonly evidencePackVersion: number;
  readonly evidencePackContentHash: string;
  readonly diffHash: string;
  readonly decision: "approved" | "rejected";
  readonly approver: string;
  readonly expiresAt: string;
  readonly tokenHash: string;
  consumed: boolean;
}

export class HumanApprovalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanApprovalConfigurationError";
  }
}

export class HumanApprovalCredentialError extends Error {
  constructor(message = "人工审批通道凭证无效") {
    super(message);
    this.name = "HumanApprovalCredentialError";
  }
}

export class HumanApprovalChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanApprovalChallengeError";
  }
}

export class HumanApprovalPathError extends Error {
  constructor() {
    super("人工审批不得通过通用 recordApproval 入口，必须使用一次性挑战并走 recordHumanDecision");
    this.name = "HumanApprovalPathError";
  }
}

/** 安全敏感状态只能由对应领域闭环进入，通用迁移入口一律拒绝。 */
export class SensitiveTransitionPathError extends IllegalTransitionError {
  constructor(to: TaskStatus) {
    super(
      `禁止通过 transitionTask 迁移到 ${to} —— 必须使用对应的 Review、审批或终态领域服务`
    );
    this.name = "SensitiveTransitionPathError";
  }
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

/** Phase 5：任务尚未生成可审计的 Review / Repair Record。 */
export class ReviewNotReadyError extends Error {
  constructor(taskId: string, message: string) {
    super(`任务 ${taskId} 尚未满足 Phase 5 Review 条件：${message}`);
    this.name = "ReviewNotReadyError";
  }
}

export interface ReviewGateAndMemoryResult {
  readonly task: Task;
  readonly repairRecord: RepairRecord;
  readonly qualityGate: ReviewQualityGateResult;
}

export interface HumanDecisionResult {
  readonly task: Task;
  readonly approval: ApprovalRecord;
  readonly repairRecord: RepairRecord;
}

interface CommittedHumanDecision {
  readonly result: HumanDecisionResult;
  readonly previousTask: Task;
  readonly previousRepairRecord: RepairRecord;
}

export class TaskOrchestrator {
  private readonly pendingHumanApprovalChallenges = new Map<
    string,
    PendingHumanApprovalChallenge
  >();

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

      // 通用迁移接口不得进入任何安全敏感状态：
      // - EXECUTING 只能经 beginExecutionIfApproved；
      // - AWAITING_HUMAN_APPROVAL 只能经 recordReviewAndGate；
      // - COMPLETED / REJECTED 只能经 recordHumanDecision。
      // 这在 Core 层封闭 HTTP、测试辅助代码和未来 Adapter 的所有旁路。
      if (
        to === "EXECUTING" ||
        to === "AWAITING_HUMAN_APPROVAL" ||
        to === "COMPLETED" ||
        to === "REJECTED"
      ) {
        throw new SensitiveTransitionPathError(to);
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
   * 记录执行审批闸门决定。
   *
   * 人工审批已从这个通用入口移除。人工决定必须经过
   * `issueHumanApprovalChallenge` 和 `recordHumanDecision`，以保证身份、
   * 决定、Pack、Diff 与 Repair Record 在同一条受控链路中绑定。
   */
  async recordApproval(args: {
    taskId: string;
    kind: "execution";
    approver: string;
    decision: "approved" | "rejected";
    scopeHash: string;
    reason?: string;
  }): Promise<ApprovalRecord> {
    // 运行时仍检查 kind，防止未经 TypeScript 编译的调用方传入 human。
    if ((args as { kind?: unknown }).kind !== "execution") {
      throw new HumanApprovalPathError();
    }

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
      if (task.status !== "AWAITING_EXECUTION_APPROVAL") {
        throw new InvalidApprovalStateError(args.taskId, task.status, "execution");
      }

      await tx.approvals.save(approval);
      await tx.audit.append(
        createAuditEvent({
          taskId: args.taskId,
          type:
            args.decision === "approved"
              ? "execution_approval_granted"
              : "execution_approval_requested",
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
   * Phase 5：记录独立 Reviewer 结果并执行质量门。
   *
   * Review 结果与执行结果在同一短事务内形成 Repair Record：通过质量门的
   * 记录进入 VERIFIED 并等待人工审批；存在兼容性问题、缺少回归测试、
   * P0/P1 或验证失败时进入 DRAFT，任务进入 FAILED，不得进入人工批准。
   */
  async recordReviewAndGate(args: {
    readonly taskId: string;
    readonly review: ReviewResult;
  }): Promise<ReviewGateAndMemoryResult> {
    return this.deps.unitOfWork.run(async (tx) => {
      const task = await tx.tasks.findById(args.taskId);
      if (!task) throw new TaskNotFoundError(args.taskId);
      if (task.status !== "REVIEWING") {
        throw new ReviewNotReadyError(
          args.taskId,
          `当前状态为 ${task.status}，Review 只允许在 REVIEWING 状态收口`
        );
      }

      const execution = await tx.executionResults.findLatestByTask(args.taskId);
      if (!execution) {
        throw new ReviewNotReadyError(args.taskId, "不存在受控 execution_results 记录");
      }
      if (!task.currentEvidencePackId || task.currentEvidencePackVersion === undefined) {
        throw new ReviewNotReadyError(args.taskId, "不存在可回溯的当前 Evidence Pack");
      }
      const evidencePack = await tx.evidencePacks.findById(task.currentEvidencePackId);
      if (
        !evidencePack ||
        evidencePack.taskId !== task.id ||
        evidencePack.version !== task.currentEvidencePackVersion
      ) {
        throw new ReviewNotReadyError(
          args.taskId,
          "当前 Evidence Pack 不存在、任务归属不一致或版本已变化"
        );
      }
      const computedPackHash = computePackContentHash(evidencePack);
      if (evidencePack.contentHash !== computedPackHash) {
        throw new ReviewNotReadyError(
          args.taskId,
          "当前 Evidence Pack 内容哈希不一致，拒绝使用未经验证的证据快照"
        );
      }

      const qualityGate = evaluateReviewQuality({
        review: args.review,
        validationPassed: execution.verificationPassed,
        evidencePack
      });
      const now = new Date().toISOString();
      const reviewSummary: ReviewSummary = {
        verdict: args.review.verdict,
        findings: [...args.review.findings]
      };
      const failureReasons = qualityGate.reasons.map((reason) => reason.message);
      const boundRootCause = qualityGate.passed ? args.review.rootCause : undefined;
      const applicabilityConditionEvidence = qualityGate.passed
        ? [...(args.review.applicabilityConditions ?? [])]
        : [];
      const applicabilityConditions = applicabilityConditionEvidence.map(
        (condition) => condition.text
      );
      const repairRecord: RepairRecord = {
        id: randomId("repair"),
        projectId: task.projectId,
        taskId: task.id,
        status: qualityGate.passed ? "VERIFIED" : "DRAFT",
        symptom: task.input.failure?.stackSummary ?? task.input.objective,
        rootCause:
          boundRootCause?.text ??
          `Review 未提供可验证的 Pack hypothesis：${args.review.summary || task.input.objective}`,
        ...(boundRootCause ? { rootCauseConfidence: boundRootCause.confidence } : {}),
        rootCauseEvidenceIds: boundRootCause ? [...boundRootCause.evidenceIds] : [],
        fixSummary:
          normalizeText(args.review.fixSummary) ??
          (args.review.summary || "Reviewer 未提供修复摘要"),
        applicabilityConditions,
        applicabilityConditionEvidence,
        failureReasons,
        inputEvidencePackId: task.currentEvidencePackId,
        inputEvidencePackVersion: task.currentEvidencePackVersion,
        inputEvidencePackContentHash: evidencePack.contentHash,
        diffHash: execution.diffHash,
        verificationResult: toVerificationSummary(execution),
        reviewResult: reviewSummary,
        createdAt: now,
        updatedAt: now
      };

      await tx.repairRecords.save(repairRecord);
      await tx.audit.append(
        createAuditEvent({
          taskId: task.id,
          type: "repair_record_transitioned",
          evidencePackId: evidencePack.id,
          evidencePackVersion: evidencePack.version,
          evidencePackHash: evidencePack.contentHash,
          diffHash: execution.diffHash,
          reason: `记录 Review ${args.review.verdict}：Repair Record ${repairRecord.id} 状态=${repairRecord.status}` +
            (failureReasons.length > 0 ? `；阻断原因=${failureReasons.join(" | ")}` : "")
        })
      );

      const targetStatus: TaskStatus = qualityGate.passed ? "AWAITING_HUMAN_APPROVAL" : "FAILED";
      transition(task.status, targetStatus);
      const updatedTask: Task = {
        ...task,
        status: targetStatus,
        updatedAt: now,
        lastTransitionReason: qualityGate.passed
          ? "Review 质量门通过，等待人类审批"
          : `Review 质量门阻断：${failureReasons.join("；") || "Reviewer 未批准"}`
      };
      await tx.tasks.save(updatedTask);
      await tx.audit.append(
        createAuditEvent({
          taskId: task.id,
          type: "task_transitioned",
          fromStatus: task.status,
          toStatus: targetStatus,
          evidencePackId: evidencePack.id,
          evidencePackVersion: evidencePack.version,
          evidencePackHash: evidencePack.contentHash,
          diffHash: execution.diffHash,
          reason: updatedTask.lastTransitionReason
        })
      );

      return { task: updatedTask, repairRecord, qualityGate };
    });
  }

  /**
   * 签发一次性人工审批挑战。
   *
   * 挑战由服务端可信身份签发，绑定当前 VERIFIED Repair Record、Evidence
   * Pack 内容哈希、Review Diff 和决定。原始 token 只返回给可信人工通道，
   * 内存中只保存摘要；Runtime、验证进程和 Agent 从不接触该凭证。
   */
  async issueHumanApprovalChallenge(args: {
    readonly taskId: string;
    readonly decision: "approved" | "rejected";
    readonly channelSecret: string;
  }): Promise<HumanApprovalChallenge> {
    const config = requireHumanApprovalConfig(this.deps.humanApproval);
    assertHumanApprovalSecret(config.channelSecret, args.channelSecret);
    if (args.decision !== "approved" && args.decision !== "rejected") {
      throw new HumanApprovalChallengeError("人工审批决定必须是 approved 或 rejected");
    }

    const binding = await this.deps.unitOfWork.run(async (tx) => {
      const task = await tx.tasks.findById(args.taskId);
      if (!task) throw new TaskNotFoundError(args.taskId);
      if (task.status !== "AWAITING_HUMAN_APPROVAL") {
        throw new InvalidApprovalStateError(args.taskId, task.status, "human");
      }
      const repairRecord = await findLatestRepairRecord(tx, args.taskId);
      if (!repairRecord || repairRecord.status !== "VERIFIED") {
        throw new ReviewNotReadyError(args.taskId, "没有可供人工批准的 VERIFIED Repair Record");
      }
      const execution = await tx.executionResults.findLatestByTask(args.taskId);
      if (!execution || !execution.verificationPassed || !repairRecord.reviewResult) {
        throw new ReviewNotReadyError(args.taskId, "缺少通过验证的受控执行结果或 Review 结果");
      }
      if (
        repairRecord.reviewResult.verdict === "block" ||
        hasBlockingReviewFindings(repairRecord.reviewResult.findings) ||
        repairRecord.diffHash !== execution.diffHash ||
        !repairRecord.inputEvidencePackContentHash
      ) {
        throw new ReviewNotReadyError(
          args.taskId,
          "Repair Record 与最新受控验证结果不一致、Review 含阻断问题或缺少 Pack 哈希"
        );
      }
      const pack = await tx.evidencePacks.findById(repairRecord.inputEvidencePackId);
      if (
        !pack ||
        pack.taskId !== task.id ||
        pack.version !== repairRecord.inputEvidencePackVersion ||
        pack.contentHash !== repairRecord.inputEvidencePackContentHash ||
        pack.contentHash !== computePackContentHash(pack)
      ) {
        throw new ReviewNotReadyError(args.taskId, "审批绑定的 Evidence Pack 不存在或内容哈希不一致");
      }
      return {
        repairRecord,
        pack,
        diffHash: execution.diffHash
      };
    });

    const challengeToken = createHumanApprovalNonce();
    const challenge: HumanApprovalChallenge = {
      challengeId: randomId("human-challenge"),
      challengeToken,
      taskId: args.taskId,
      repairRecordId: binding.repairRecord.id,
      evidencePackId: binding.pack.id,
      evidencePackVersion: binding.pack.version,
      evidencePackContentHash: binding.pack.contentHash,
      diffHash: binding.diffHash,
      decision: args.decision,
      approver: config.identity,
      expiresAt: new Date(Date.now() + resolveChallengeTtlMs(this.deps.humanApproval)).toISOString()
    };
    this.pendingHumanApprovalChallenges.set(challenge.challengeId, {
      challengeId: challenge.challengeId,
      taskId: challenge.taskId,
      repairRecordId: challenge.repairRecordId,
      evidencePackId: challenge.evidencePackId,
      evidencePackVersion: challenge.evidencePackVersion,
      evidencePackContentHash: challenge.evidencePackContentHash,
      diffHash: challenge.diffHash,
      decision: challenge.decision,
      approver: challenge.approver,
      expiresAt: challenge.expiresAt,
      tokenHash: await hashHumanApprovalToken(challengeToken),
      consumed: false
    });
    return challenge;
  }

  /**
   * 使用一次性人工审批挑战完成最终决定。
   *
   * 该方法是人工审批唯一领域入口：审批记录、Repair Record 状态、任务
   * 终态和审计事件在同一 UnitOfWork 事务内提交。挑战消费失败或事务失败
   * 都不会留下可重放的凭证。
   */
  async recordHumanDecision(args: {
    readonly taskId: string;
    readonly challengeToken: string;
    readonly channelSecret: string;
    readonly reason?: string;
  }): Promise<HumanDecisionResult> {
    const config = requireHumanApprovalConfig(this.deps.humanApproval);
    assertHumanApprovalSecret(config.channelSecret, args.channelSecret);
    const finalizationGuard = this.deps.humanDecisionFinalizationGuard;
    if (!finalizationGuard) {
      throw new HumanApprovalConfigurationError(
        "未配置人工决定最终 Diff 提交守卫，拒绝完成审批"
      );
    }
    const pending = await this.takeHumanApprovalChallenge(args.taskId, args.challengeToken);
    const challenge = pending;

    try {
      const committed = await finalizationGuard.finalize<CommittedHumanDecision>({
        taskId: args.taskId,
        expectedDiffHash: challenge.diffHash,
        commit: () => this.commitHumanDecision(args, challenge),
        compensate: (decision) => this.compensateHumanDecision(decision, challenge)
      });
      return committed.result;
    } finally {
      this.pendingHumanApprovalChallenges.delete(challenge.challengeId);
    }
  }

  /** 在最终 Diff 守卫持有任务级关键区时提交领域原子事务。 */
  private async commitHumanDecision(
    args: {
      readonly taskId: string;
      readonly reason?: string;
    },
    challenge: PendingHumanApprovalChallenge
  ): Promise<CommittedHumanDecision> {
    return this.deps.unitOfWork.run(async (tx) => {
        const task = await tx.tasks.findById(args.taskId);
        if (!task) throw new TaskNotFoundError(args.taskId);
        if (task.status !== "AWAITING_HUMAN_APPROVAL") {
          throw new InvalidApprovalStateError(args.taskId, task.status, "human");
        }

        const repairRecord = await findLatestRepairRecord(tx, args.taskId);
        if (!repairRecord || repairRecord.status !== "VERIFIED") {
          throw new ReviewNotReadyError(args.taskId, "没有可供人工批准的 VERIFIED Repair Record");
        }
        const execution = await tx.executionResults.findLatestByTask(args.taskId);
        const pack = await tx.evidencePacks.findById(challenge.evidencePackId);
        if (
          !execution ||
          !execution.verificationPassed ||
          !repairRecord.reviewResult ||
          repairRecord.reviewResult.verdict === "block" ||
          hasBlockingReviewFindings(repairRecord.reviewResult.findings) ||
          repairRecord.id !== challenge.repairRecordId ||
          repairRecord.diffHash !== challenge.diffHash ||
          execution.diffHash !== challenge.diffHash ||
          repairRecord.inputEvidencePackId !== challenge.evidencePackId ||
          repairRecord.inputEvidencePackVersion !== challenge.evidencePackVersion ||
          repairRecord.inputEvidencePackContentHash !== challenge.evidencePackContentHash ||
          !pack ||
          pack.taskId !== task.id ||
          pack.version !== challenge.evidencePackVersion ||
          pack.contentHash !== challenge.evidencePackContentHash ||
          pack.contentHash !== computePackContentHash(pack)
        ) {
          throw new ReviewNotReadyError(
            args.taskId,
            "人工挑战绑定的 Repair Record、Evidence Pack 或受控 Diff 已变化"
          );
        }

        const scopeHash = await computeCurrentScopeHashFromTx(tx, args.taskId);
        const now = new Date().toISOString();
        const approval: ApprovalRecord = {
          id: randomId("approval"),
          taskId: args.taskId,
          kind: "human",
          approver: challenge.approver,
          decision: challenge.decision,
          reason: args.reason,
          approvedAt: now,
          scopeHash
        };
        await tx.approvals.save(approval);
        await tx.audit.append(
          createAuditEvent({
            taskId: args.taskId,
            type: challenge.decision === "approved" ? "human_approval_granted" : "human_approval_rejected",
            evidencePackId: challenge.evidencePackId,
            evidencePackVersion: challenge.evidencePackVersion,
            evidencePackHash: challenge.evidencePackContentHash,
            approver: challenge.approver,
            scopeHash,
            diffHash: challenge.diffHash,
            reason: args.reason
          })
        );

        const nextRecordStatus = challenge.decision === "approved" ? "APPROVED" : "DEPRECATED";
        const updatedRecord: RepairRecord = {
          ...repairRecord,
          status: transitionRepairRecord(repairRecord.status, nextRecordStatus),
          updatedAt: now,
          failureReasons:
            challenge.decision === "rejected" && args.reason
              ? [...repairRecord.failureReasons, `人工拒绝：${args.reason}`]
              : repairRecord.failureReasons
        };
        await tx.repairRecords.save(updatedRecord);
        await tx.audit.append(
          createAuditEvent({
            taskId: args.taskId,
            type: "repair_record_transitioned",
            evidencePackId: challenge.evidencePackId,
            evidencePackVersion: challenge.evidencePackVersion,
            evidencePackHash: challenge.evidencePackContentHash,
            diffHash: updatedRecord.diffHash,
            reason: `Repair Record ${updatedRecord.id}：${repairRecord.status} → ${updatedRecord.status}`
          })
        );

        const targetStatus: TaskStatus = challenge.decision === "approved" ? "COMPLETED" : "REJECTED";
        transition(task.status, targetStatus);
        const updatedTask: Task = {
          ...task,
          status: targetStatus,
          updatedAt: now,
          lastTransitionReason:
            challenge.decision === "approved"
              ? "人类审批通过，Repair Record 已批准"
              : `人类审批拒绝：${args.reason ?? "未提供原因"}`
        };
        await tx.tasks.save(updatedTask);
        await tx.audit.append(
          createAuditEvent({
            taskId: args.taskId,
            type: "task_transitioned",
            fromStatus: task.status,
            toStatus: targetStatus,
            evidencePackId: challenge.evidencePackId,
            evidencePackVersion: challenge.evidencePackVersion,
            evidencePackHash: challenge.evidencePackContentHash,
            approver: challenge.approver,
            diffHash: updatedRecord.diffHash,
            reason: updatedTask.lastTransitionReason
          })
        );

        return {
          result: { task: updatedTask, approval, repairRecord: updatedRecord },
          previousTask: task,
          previousRepairRecord: repairRecord
        };
      });
  }

  /**
   * 外部进程在审批提交关键区内改动 worktree 时执行失败补偿。
   *
   * 人工审批记录被删除，任务与 Repair Record 恢复到审批前状态；既有审计
   * 事件保持仅追加，并补充明确的失效/回退事件，避免掩盖曾发生的竞态。
   */
  private async compensateHumanDecision(
    committed: CommittedHumanDecision,
    challenge: PendingHumanApprovalChallenge
  ): Promise<void> {
    await this.deps.unitOfWork.run(async (tx) => {
      const currentTask = await tx.tasks.findById(challenge.taskId);
      const currentRecord = await tx.repairRecords.findById(challenge.repairRecordId);
      if (
        !currentTask ||
        !currentRecord ||
        currentRecord.id !== committed.result.repairRecord.id
      ) {
        throw new ReviewNotReadyError(
          challenge.taskId,
          "审批竞态补偿时任务或 Repair Record 已再次变化"
        );
      }

      await tx.approvals.delete(committed.result.approval.id);
      const now = new Date().toISOString();
      const restoredRecord: RepairRecord = {
        ...committed.previousRepairRecord,
        updatedAt: now
      };
      await tx.repairRecords.save(restoredRecord);
      await tx.audit.append(
        createAuditEvent({
          taskId: challenge.taskId,
          type: "human_approval_invalidated",
          evidencePackId: challenge.evidencePackId,
          evidencePackVersion: challenge.evidencePackVersion,
          evidencePackHash: challenge.evidencePackContentHash,
          approver: challenge.approver,
          diffHash: challenge.diffHash,
          reason: "审批提交关键区检测到 worktree Diff 竞态，人工决定已撤销"
        })
      );
      await tx.audit.append(
        createAuditEvent({
          taskId: challenge.taskId,
          type: "repair_record_transitioned",
          evidencePackId: challenge.evidencePackId,
          evidencePackVersion: challenge.evidencePackVersion,
          evidencePackHash: challenge.evidencePackContentHash,
          diffHash: challenge.diffHash,
          reason: `竞态补偿：Repair Record ${currentRecord.id} ${currentRecord.status} → ${restoredRecord.status}`
        })
      );

      const restoredTask: Task = {
        ...committed.previousTask,
        updatedAt: now,
        lastTransitionReason: "审批提交关键区检测到 Diff 竞态，已恢复等待重新审批"
      };
      await tx.tasks.save(restoredTask);
      await tx.audit.append(
        createAuditEvent({
          taskId: challenge.taskId,
          type: "task_transitioned",
          fromStatus: currentTask.status,
          toStatus: restoredTask.status,
          evidencePackId: challenge.evidencePackId,
          evidencePackVersion: challenge.evidencePackVersion,
          evidencePackHash: challenge.evidencePackContentHash,
          diffHash: challenge.diffHash,
          reason: restoredTask.lastTransitionReason
        })
      );
    });
  }

  private async takeHumanApprovalChallenge(
    taskId: string,
    challengeToken: string
  ): Promise<PendingHumanApprovalChallenge> {
    if (typeof challengeToken !== "string" || challengeToken.length === 0) {
      throw new HumanApprovalChallengeError("人工审批挑战凭证格式无效");
    }
    const tokenHash = await hashHumanApprovalToken(challengeToken);
    const pending = [...this.pendingHumanApprovalChallenges.values()].find(
      (candidate) => candidate.tokenHash === tokenHash
    );
    if (!pending) throw new HumanApprovalChallengeError("人工审批挑战不存在或已失效");
    if (pending.taskId !== taskId) {
      throw new HumanApprovalChallengeError("人工审批挑战不能跨任务使用");
    }
    if (pending.consumed) throw new HumanApprovalChallengeError("人工审批挑战已被消费，不能重放");
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      this.pendingHumanApprovalChallenges.delete(pending.challengeId);
      throw new HumanApprovalChallengeError("人工审批挑战已过期");
    }
    pending.consumed = true;
    return pending;
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

function normalizeText(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toVerificationSummary(execution: {
  readonly verificationExitCode: number;
  readonly verificationPassed: boolean;
  readonly verificationStdout: string;
  readonly verificationStderr: string;
}): VerificationSummary {
  const outputTail = `${execution.verificationStdout}\n${execution.verificationStderr}`
    .trim()
    .slice(-4096);
  return {
    passed: execution.verificationPassed,
    ranCommands: ["project.commands.test"],
    exitCodes: { "project.commands.test": execution.verificationExitCode },
    ...(outputTail.length > 0 ? { truncatedOutputTail: outputTail } : {})
  };
}

function hasBlockingReviewFindings(findings: readonly ReviewFinding[]): boolean {
  return findings.some(
    (finding) =>
      finding.priority === "P0" ||
      finding.priority === "P1" ||
      !isReviewFindingCategory(finding.category) ||
      finding.category === "compatibility" ||
      finding.category === "regression_test"
  );
}

async function findLatestRepairRecord(
  tx: TransactionalRepos,
  taskId: string
): Promise<RepairRecord | undefined> {
  const records = await tx.repairRecords.findByTask(taskId);
  return [...records].sort((a, b) => {
    const timeDelta = b.updatedAt.localeCompare(a.updatedAt);
    return timeDelta !== 0 ? timeDelta : b.id.localeCompare(a.id);
  })[0];
}

function requireHumanApprovalConfig(
  config: HumanApprovalConfig | undefined
): { identity: string; channelSecret: string } {
  const identity = config?.identity?.trim();
  const channelSecret = config?.channelSecret;
  if (!identity || !channelSecret) {
    throw new HumanApprovalConfigurationError(
      "未配置可信人工审批身份或通道凭证，拒绝签发/消费人工审批挑战"
    );
  }
  if (channelSecret.length < 32) {
    throw new HumanApprovalConfigurationError(
      "人工审批通道凭证至少需要 32 个字符；请使用密码学安全随机数生成"
    );
  }
  return { identity, channelSecret };
}

function resolveChallengeTtlMs(config: HumanApprovalConfig | undefined): number {
  const ttl = config?.challengeTtlMs ?? 5 * 60 * 1000;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 24 * 60 * 60 * 1000) {
    throw new HumanApprovalConfigurationError("人工审批挑战有效期配置必须在 1 毫秒至 24 小时之间");
  }
  return ttl;
}

function assertHumanApprovalSecret(expected: string, actual: unknown): void {
  if (typeof actual !== "string" || !constantTimeEqual(expected, actual)) {
    throw new HumanApprovalCredentialError();
  }
}

function createHumanApprovalNonce(): string {
  const cryptoApi = (globalThis as {
    crypto?: { randomUUID?: () => string };
  }).crypto;
  if (!cryptoApi?.randomUUID) {
    throw new HumanApprovalConfigurationError("当前运行时不提供安全随机数，拒绝签发人工审批挑战");
  }
  return cryptoApi.randomUUID();
}

async function hashHumanApprovalToken(token: string): Promise<string> {
  const cryptoApi = (globalThis as {
    crypto?: {
      subtle?: {
        digest: (algorithm: "SHA-256", data: ArrayBuffer) => Promise<ArrayBuffer>;
      };
    };
  }).crypto;
  if (!cryptoApi?.subtle?.digest) {
    throw new HumanApprovalConfigurationError("当前运行时不提供安全摘要，拒绝处理人工审批挑战");
  }
  const bytes = new TextEncoder().encode(token);
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
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
