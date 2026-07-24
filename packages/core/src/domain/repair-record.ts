/**
 * Repair Record 领域模型 —— 详见 IMPLEMENTATION_SPEC §5.4。
 *
 * 状态机：DRAFT → VERIFIED → APPROVED → DEPRECATED。
 * - VERIFIED：测试通过 + Review 无 P0/P1，但尚未被人工接受。
 * - APPROVED：人工明确接受；具备高信任召回资格。
 * - DRAFT / DEPRECATED：默认从不进入主 prompt 上下文。
 *
 * §5.4：不得跳过 VERIFIED。每条失败方法记录其失败原因和适用条件，
 * 以避免一次性的失败被误用为通用规则。
 */

import type { EvidencePackId, EvidencePackVersion } from "./evidence.js";

export type RepairRecordStatus =
  | "DRAFT"
  | "VERIFIED"
  | "APPROVED"
  | "DEPRECATED";

export interface RepairRecord {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly status: RepairRecordStatus;
  readonly symptom: string;
  readonly rootCause: string;
  readonly fixSummary: string;
  readonly applicabilityConditions: readonly string[];
  readonly failureReasons: readonly string[];
  readonly inputEvidencePackId: EvidencePackId;
  readonly inputEvidencePackVersion: EvidencePackVersion;
  readonly diffHash?: string;
  readonly verificationResult?: VerificationSummary;
  readonly reviewResult?: ReviewSummary;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VerificationSummary {
  readonly passed: boolean;
  readonly ranCommands: readonly string[];
  readonly exitCodes: ReadonlyMap<string, number>;
  readonly truncatedOutputTail?: string;
}

export interface ReviewSummary {
  readonly verdict: "ship" | "ship_with_fixes" | "block";
  readonly findings: readonly ReviewFinding[];
}

export interface ReviewFinding {
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly confidence: number;
  readonly message: string;
  readonly locator?: string;
}

export class RepairRecordTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairRecordTransitionError";
  }
}

const LEGAL_REPAIR_TRANSITIONS: Record<
  RepairRecordStatus,
  readonly RepairRecordStatus[]
> = {
  DRAFT: ["VERIFIED", "DEPRECATED"],
  VERIFIED: ["APPROVED", "DEPRECATED"],
  APPROVED: ["DEPRECATED"],
  DEPRECATED: []
};

export function transitionRepairRecord(
  from: RepairRecordStatus,
  to: RepairRecordStatus
): RepairRecordStatus {
  if (from === to) return from;
  const allowed = LEGAL_REPAIR_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new RepairRecordTransitionError(
      `非法 Repair Record 迁移 ${from} → ${to}`
    );
  }
  // §5.4 不变式：在通往 APPROVED 的路径上不得跳过 VERIFIED。
  if (to === "APPROVED" && from !== "VERIFIED") {
    throw new RepairRecordTransitionError(
      "未经过 VERIFIED 不得到达 APPROVED"
    );
  }
  return to;
}

/**
 * 纯辅助函数：根据 §5.4，只有当测试通过且 Review 无 P0/P1 问题时，
 * 记录才能变为 VERIFIED。由 orchestrator 在发起 DRAFT → VERIFIED
 * 状态流转前使用。
 */
export function canVerify(args: {
  validationPassed: boolean;
  hasP0OrP1ReviewFindings: boolean;
}): boolean {
  return args.validationPassed && !args.hasP0OrP1ReviewFindings;
}

export function hasP0OrP1(findings: readonly ReviewFinding[]): boolean {
  return findings.some((f) => f.priority === "P0" || f.priority === "P1");
}
