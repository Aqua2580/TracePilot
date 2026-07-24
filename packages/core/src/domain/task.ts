/**
 * Task 领域模型 + 状态机 —— 见 IMPLEMENTATION_SPEC §5.2。
 *
 * 状态迁移只能由 TaskOrchestrator 触发，且必须与对应 AuditEvent 在同
 * 一个数据库事务内写入。状态机本身是纯函数，可在无 I/O 的环境下做
 * 单元测试。
 */

import type { EvidencePackId, EvidencePackVersion } from "./evidence.js";

export type TaskStatus =
  | "CREATED"
  | "INTAKING"
  | "GATHERING_EVIDENCE"
  | "PLANNED"
  | "AWAITING_EXECUTION_APPROVAL"
  | "EXECUTING"
  | "EVIDENCE_GAP"
  | "VALIDATING"
  | "REVIEWING"
  | "AWAITING_HUMAN_APPROVAL"
  | "COMPLETED"
  | "REJECTED"
  | "FAILED"
  | "CANCELLED"
  | "INTERRUPTED";

/**
 * 终态集合。终态任务不会再迁移，除非通过显式恢复 / 重启操作产生新
 * 任务（INTERRUPTED 的 resume 是允许的例外，见 `canResumeFromInterrupted`）。
 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "COMPLETED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED"
] as const;

export function isTerminalStatus(s: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/** 任务来源 —— 驱动 intake 解析。 */
export type TaskOrigin = "failed_test_log" | "issue";

/**
 * 规则抽取后的结构化任务输入（§8.1 步骤 1、§8.2）。自由格式 issue 文本
 * 不会作为权威再次传给下游 —— 仅结构化字段生效。
 */
export interface TaskInput {
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly riskLevel: RiskLevel;
  /** 原始来源，仅用于审计，永不作为权威再次解析。 */
  readonly rawSource: string;
  readonly origin: TaskOrigin;
  /** 当 origin 为 `failed_test_log` 时：抽取的失败元数据。 */
  readonly failure?: FailureExtraction;
}

export type RiskLevel = "low" | "medium" | "high";

export interface FailureExtraction {
  readonly testNames: readonly string[];
  readonly errorTypes: readonly string[];
  readonly stackSummary: string;
}

/**
 * Planner 角色产出的 Plan 节点。MVP 中是线性结构，无 DAG。
 */
export interface PlanNode {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly evidencePackId: EvidencePackId;
  readonly evidencePackVersion: EvidencePackVersion;
}

export interface Plan {
  readonly id: string;
  readonly taskId: string;
  readonly nodes: readonly PlanNode[];
  readonly inputEvidencePackId: EvidencePackId;
  readonly inputEvidencePackVersion: EvidencePackVersion;
  readonly createdAt: string;
}

/**
 * 审批闸门。每条审批记录谁批准并写入审计。
 * 见 §5.2：当新计划扩大允许路径 / 命令 / 风险等级时，已有的执行批准
 * 失效，必须重新申请。
 *
 * `invalidatedAt` 字段（P1-02）记录失效时间戳。已失效的执行审批不可
 * 作为 `hasExecutionApproval=true` 的依据。失效操作由 Orchestrator 在
 * 同一 UnitOfWork 事务内执行：读取当前审批 → 写回带 `invalidatedAt`
 * 的新版本 → 追加 `execution_approval_invalidated` 审计事件。
 */
export interface ApprovalRecord {
  readonly id: string;
  readonly taskId: string;
  readonly kind: "execution" | "human";
  readonly approver: string;
  readonly decision: "approved" | "rejected";
  readonly reason?: string;
  readonly approvedAt: string;
  /** 批准时所依据的计划 / 范围快照。 */
  readonly scopeHash: string;
  /** 失效时间戳。undefined 表示未失效。见 P1-02。 */
  readonly invalidatedAt?: string;
  /** 失效原因。与 `invalidatedAt` 同时写入。 */
  readonly invalidationReason?: string;
}

/** 判定审批是否已失效（P1-02）。 */
export function isApprovalInvalidated(approval: ApprovalRecord): boolean {
  return approval.invalidatedAt !== undefined;
}

export interface Task {
  readonly id: string;
  readonly projectId: string;
  readonly status: TaskStatus;
  readonly input: TaskInput;
  readonly currentEvidencePackId?: EvidencePackId;
  readonly currentEvidencePackVersion?: EvidencePackVersion;
  readonly currentPlanId?: string;
  readonly worktreeId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 最近一次终态 / 失败迁移的原因，供审计使用。 */
  readonly lastTransitionReason?: string;
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/**
 * 纯迁移函数。返回下一个状态，非法迁移抛错。Orchestrator 会把它包在
 * 同一个事务里，并写入对应的 AuditEvent；本函数对持久化一无所知。
 *
 * 合法迁移由 §5.2 定义，未列出的边一律拒绝。
 *
 * P2-01 / P2-R03：终态拒绝所有迁移，包括同状态 no-op。必须先检查终态，
 * 再处理非终态 no-op，否则 `transition("COMPLETED","COMPLETED")` 会被
 * `from === to` 短路放行，违反“终态不可再迁移”语义。INTERRUPTED 的
 * resume 是唯一例外（由显式 resume 操作触发）。
 */
export function transition(
  from: TaskStatus,
  to: TaskStatus,
  opts?: { widenScope?: boolean }
): TaskStatus {
  // P2-R03：先检查终态。终态上的任何迁移（含同状态 no-op）一律拒绝，
  // 仅 INTERRUPTED 可通过显式 resume 恢复到 canResumeFromInterrupted
  // 列出的状态。
  if (isTerminalStatus(from)) {
    if (from === "INTERRUPTED" && canResumeFromInterrupted(to)) return to;
    throw new IllegalTransitionError(
      `终态 ${from} 不可迁移到 ${to}`
    );
  }

  // 非终态同状态迁移同样拒绝 —— 无意义的 no-op 不应更新时间戳或写
  // 审计噪声（与 Orchestrator 的 P2-01 实现一致）。
  if (from === to) {
    throw new IllegalTransitionError(
      `非终态 ${from} 拒绝同状态 no-op 迁移`
    );
  }

  const allowed = LEGAL_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new IllegalTransitionError(
      `非法迁移 ${from} → ${to}`
    );
  }

  // §5.2：EVIDENCE_GAP 期间扩大范围会使既有执行审批失效。本函数只返回
  // 目标状态，调用方（Orchestrator）负责在事务内清除已存储的执行审批
  // （写回带 invalidatedAt 的版本并追加审计事件）。
  if (to === "GATHERING_EVIDENCE" && opts?.widenScope) {
    // 由 Orchestrator 负责失效旧执行审批。
  }

  return to;
}

/**
 * 各状态允许的出边。未列出的边均为非法。终态在本表中没有出边 ——
 * INTERRUPTED 的 resume 目标由 `canResumeFromInterrupted` 单独处理。
 */
const LEGAL_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  CREATED: ["INTAKING", "CANCELLED", "FAILED"],
  INTAKING: ["GATHERING_EVIDENCE", "FAILED", "CANCELLED"],
  GATHERING_EVIDENCE: ["PLANNED", "FAILED", "CANCELLED"],
  PLANNED: ["AWAITING_EXECUTION_APPROVAL", "FAILED", "CANCELLED"],
  AWAITING_EXECUTION_APPROVAL: ["EXECUTING", "REJECTED", "CANCELLED"],
  EXECUTING: ["VALIDATING", "EVIDENCE_GAP", "FAILED", "CANCELLED", "INTERRUPTED"],
  EVIDENCE_GAP: ["GATHERING_EVIDENCE", "FAILED", "CANCELLED"],
  VALIDATING: ["REVIEWING", "FAILED", "CANCELLED", "INTERRUPTED"],
  REVIEWING: ["AWAITING_HUMAN_APPROVAL", "FAILED", "CANCELLED"],
  AWAITING_HUMAN_APPROVAL: ["COMPLETED", "REJECTED", "CANCELLED"],
  // 终态 —— 本表中无出边。
  COMPLETED: [],
  REJECTED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: []
};

function canResumeFromInterrupted(to: TaskStatus): boolean {
  // resume 可以重新进入一个安全的早期非终态状态，以重跑被中断的步骤。
  // 见 §5.2：永不允许直接声明 COMPLETED。
  return (
    to === "GATHERING_EVIDENCE" ||
    to === "PLANNED" ||
    to === "AWAITING_EXECUTION_APPROVAL" ||
    to === "EXECUTING" ||
    to === "VALIDATING" ||
    to === "FAILED" ||
    to === "CANCELLED"
  );
}

export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalTransitionError";
  }
}

/**
 * §5.2 COMPLETED 前置条件：验证通过 + Review 无 P0/P1 + 人类审批已记录。
 * 这是个纯辅助函数，由 Orchestrator 在签发最终 COMPLETED 迁移前调用。
 */
export function canComplete(args: {
  validationPassed: boolean;
  hasP0OrP1ReviewFindings: boolean;
  hasHumanApproval: boolean;
}): boolean {
  return (
    args.validationPassed &&
    !args.hasP0OrP1ReviewFindings &&
    args.hasHumanApproval
  );
}
