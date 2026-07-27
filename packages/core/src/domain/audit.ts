/**
 * 审计事件模型 —— 见 IMPLEMENTATION_SPEC §7.3。
 *
 * 审计事件仅追加。Orchestrator 把它和对应的状态迁移写在同一个数据库
 * 事务里（§5.2）。敏感值绝不记录 —— 仅记录变量名。
 */

import type { TaskStatus } from "./task.js";
import type { EvidencePackId, EvidencePackVersion } from "./evidence.js";

export type AuditEventType =
  | "task_created"
  | "task_transitioned"
  | "task_cancelled"
  | "task_interrupted"
  | "evidence_pack_versioned"
  | "plan_recorded"
  | "execution_approval_requested"
  | "execution_approval_granted"
  | "execution_approval_invalidated"
  | "human_approval_granted"
  | "human_approval_rejected"
  | "command_executed"
  | "worktree_created"
  | "worktree_removed"
  | "diff_recorded"
  | "repair_record_transitioned"
  | "evidence_request_submitted"
  | "evidence_request_granted"
  | "evidence_router_request"
  | "policy_denied";

export interface AuditEvent {
  readonly id: string;
  readonly taskId: string;
  readonly type: AuditEventType;
  readonly fromStatus?: TaskStatus;
  readonly toStatus?: TaskStatus;
  readonly evidencePackId?: EvidencePackId;
  readonly evidencePackVersion?: EvidencePackVersion;
  /** 本事件引用的 Evidence Pack 哈希（若有）。 */
  readonly evidencePackHash?: string;
  readonly planId?: string;
  /** 实际执行的 argv —— 永不来自模型输出（§5.1、§7.2）。 */
  readonly executedArgv?: readonly string[];
  readonly executedCwd?: string;
  readonly exitCode?: number;
  readonly outputTruncation?: OutputTruncation;
  readonly diffHash?: string;
  readonly approver?: string;
  readonly scopeHash?: string;
  /** 事件原因（例如为什么发生迁移）。 */
  readonly reason?: string;
  /** policy_denied 事件：被拒绝的操作。 */
  readonly deniedAction?: string;
  readonly deniedReason?: string;
  readonly recordedAt: string;
}

/**
 * 命令输出截断信息（P2-02）。
 *
 * `originalBytes` 表示进程实际产生的总字节数（即使被丢弃也计入）；
 * `retainedBytes` 表示审计中实际保留的字节数。两者分开统计，避免
 * 截断时把保留字节数误报为原始大小。
 */
export interface OutputTruncation {
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly truncated: boolean;
  /** 仅变量名 —— 永不记录值（§7.3）。 */
  readonly redactedVariableNames?: readonly string[];
}

/**
 * 仅追加不变量的辅助工厂。审计事件都通过本工厂创建，避免临时拼装，
 * 并确保 `recordedAt` 一定被设置。
 */
export function createAuditEvent(
  input: Omit<AuditEvent, "id" | "recordedAt"> & { id?: string; recordedAt?: string }
): AuditEvent {
  return {
    ...input,
    id: input.id ?? randomId(),
    recordedAt: input.recordedAt ?? new Date().toISOString()
  } satisfies AuditEvent;
}

/**
 * 极简 ID 生成器。真实 ID 由适配器生成（可用 UUID）；领域层只需要一个
 * 不透明唯一字符串以支撑内存测试。
 */
export function randomId(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
