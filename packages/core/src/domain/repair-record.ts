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

import {
  computePackContentHash,
  type EvidencePack,
  type EvidencePackId,
  type EvidencePackVersion,
  type EvidenceConstraint
} from "./evidence.js";
import type { ExecutionResult } from "./execution-result.js";
import type { Task } from "./task.js";

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
  /** 当前 Evidence Pack 中已登记 hypothesis 的置信度。 */
  readonly rootCauseConfidence?: number;
  /** 支撑正式根因的当前 Pack Evidence ID；APPROVED 记录不得为空。 */
  readonly rootCauseEvidenceIds: readonly string[];
  readonly fixSummary: string;
  readonly applicabilityConditions: readonly string[];
  /** 适用条件到当前 Pack Evidence ID 的可回溯绑定。 */
  readonly applicabilityConditionEvidence: readonly EvidenceConstraint[];
  readonly failureReasons: readonly string[];
  readonly inputEvidencePackId: EvidencePackId;
  readonly inputEvidencePackVersion: EvidencePackVersion;
  /** Review 与 Repair Memory 绑定的 Evidence Pack 内容哈希。 */
  readonly inputEvidencePackContentHash?: string;
  readonly diffHash?: string;
  readonly verificationResult?: VerificationSummary;
  readonly reviewResult?: ReviewSummary;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RepairMemoryWriteErrorCode =
  | "invalid_record"
  | "missing_reference"
  | "project_mismatch"
  | "identity_mismatch"
  | "write_failed";

/** KnowledgeAdapter 写入失败的跨实现稳定错误。 */
export class RepairMemoryWriteError extends Error {
  readonly code: RepairMemoryWriteErrorCode;

  constructor(code: RepairMemoryWriteErrorCode, message: string) {
    super(`Repair Memory 写入失败 [${code}]：${message}`);
    this.name = "RepairMemoryWriteError";
    this.code = code;
  }
}

/**
 * KnowledgeAdapter 的共享运行时写入边界。
 *
 * TypeScript 类型在 API、测试替身或反序列化边界可能被绕过，因此 Fake 与
 * SQLite 实现都必须在真正写入前调用本函数，并返回相同的结构化错误。
 */
export function assertRepairRecordForKnowledgeWrite(
  record: unknown
): asserts record is RepairRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new RepairMemoryWriteError("invalid_record", "record 必须是对象");
  }

  const value = record as Record<string, unknown>;
  for (const field of [
    "id",
    "projectId",
    "taskId",
    "symptom",
    "rootCause",
    "fixSummary",
    "inputEvidencePackId",
    "createdAt",
    "updatedAt"
  ] as const) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) {
      throw new RepairMemoryWriteError(
        "invalid_record",
        `${field} 必须是非空字符串`
      );
    }
  }

  if (
    value.status !== "DRAFT" &&
    value.status !== "VERIFIED" &&
    value.status !== "APPROVED" &&
    value.status !== "DEPRECATED"
  ) {
    throw new RepairMemoryWriteError("invalid_record", "status 非法");
  }
  if (
    typeof value.inputEvidencePackVersion !== "number" ||
    !Number.isInteger(value.inputEvidencePackVersion) ||
    value.inputEvidencePackVersion < 1
  ) {
    throw new RepairMemoryWriteError(
      "invalid_record",
      "inputEvidencePackVersion 必须是正整数"
    );
  }
  if (
    value.rootCauseConfidence !== undefined &&
    (typeof value.rootCauseConfidence !== "number" ||
      !Number.isFinite(value.rootCauseConfidence) ||
      value.rootCauseConfidence < 0 ||
      value.rootCauseConfidence > 1)
  ) {
    throw new RepairMemoryWriteError(
      "invalid_record",
      "rootCauseConfidence 必须位于 0 到 1"
    );
  }

  assertStringArray(value, "rootCauseEvidenceIds");
  assertStringArray(value, "applicabilityConditions");
  assertStringArray(value, "failureReasons");
  assertEvidenceConstraintArray(value.applicabilityConditionEvidence);

  if (
    (value.status === "VERIFIED" || value.status === "APPROVED") &&
    (value.rootCauseConfidence === undefined ||
      (value.rootCauseEvidenceIds as readonly string[]).length === 0)
  ) {
    throw new RepairMemoryWriteError(
      "invalid_record",
      `${value.status} 记录必须绑定根因置信度和 Evidence ID`
    );
  }
}

/**
 * 高可信 Repair Record 的受控来源。
 *
 * VERIFIED / APPROVED 只是状态标签，不能单独证明记录可信。召回前还必须
 * 重新绑定不可变 Evidence Pack 与受控 ExecutionResult，避免旧库、手工
 * 导入或内部误用把无来源记录提升为 VERIFIED_MEMORY。
 */
export interface TrustedRepairRecordSources {
  /** Repair Record 所声明 taskId 对应的真实任务归属。 */
  readonly task?: Pick<Task, "id" | "projectId">;
  readonly evidencePack?: EvidencePack;
  readonly executionResult?: ExecutionResult;
}

/**
 * 重新验证高可信 Repair Record 的完整来源链。
 *
 * 本函数只返回错误，不抛出异常，便于迁移和召回层统一失败关闭：
 * - Pack 必须属于同一任务、版本与内容哈希必须精确匹配并可重算；
 * - 正式根因和适用条件必须精确对应 Pack 中已登记的 hypothesis/constraint；
 * - Diff 与验证摘要必须能回溯到同一任务的受控 ExecutionResult；
 * - Review 必须是非阻断结果，且不得包含 P0/P1、兼容性或回归测试问题。
 */
export function validateTrustedRepairRecordProvenance(
  record: unknown,
  sources: TrustedRepairRecordSources
): readonly string[] {
  try {
    return validateTrustedRepairRecordProvenanceUnsafe(record, sources);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`来源链无法解析：${message}`];
  }
}

function validateTrustedRepairRecordProvenanceUnsafe(
  record: unknown,
  sources: TrustedRepairRecordSources
): readonly string[] {
  try {
    assertRepairRecordForKnowledgeWrite(record);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  const errors: string[] = [];
  if (record.status !== "VERIFIED" && record.status !== "APPROVED") {
    errors.push("只有 VERIFIED 或 APPROVED 记录可作为高可信记忆");
  }

  const task = sources.task;
  if (!task) {
    errors.push("缺少对应 Task 来源");
  } else if (task.id !== record.taskId) {
    errors.push("Task ID 与 Repair Record 的 taskId 不匹配");
  } else if (task.projectId !== record.projectId) {
    errors.push("Task 的项目归属与 Repair Record 的 projectId 不匹配");
  }

  const pack = sources.evidencePack;
  if (!pack) {
    errors.push("缺少对应 Evidence Pack");
  } else {
    if (
      pack.id !== record.inputEvidencePackId ||
      pack.version !== record.inputEvidencePackVersion ||
      pack.taskId !== record.taskId
    ) {
      errors.push("Evidence Pack 的 ID、版本或任务归属不匹配");
    }
    if (
      typeof record.inputEvidencePackContentHash !== "string" ||
      record.inputEvidencePackContentHash.trim().length === 0 ||
      record.inputEvidencePackContentHash !== pack.contentHash
    ) {
      errors.push("Repair Record 未绑定匹配的 Evidence Pack 内容哈希");
    }
    if (pack.contentHash !== computePackContentHash(pack)) {
      errors.push("Evidence Pack 内容哈希无法通过重算");
    }

    const evidenceIds = new Set(pack.evidence.map((item) => item.id));
    if (
      !pack.hypotheses.some(
        (hypothesis) =>
          hypothesis.text === record.rootCause &&
          hypothesis.confidence === record.rootCauseConfidence &&
          sameStringSet(hypothesis.evidenceIds, record.rootCauseEvidenceIds)
      )
    ) {
      errors.push("根因、置信度或 Evidence ID 未精确绑定 Pack hypothesis");
    }
    if (record.rootCauseEvidenceIds.some((id) => !evidenceIds.has(id))) {
      errors.push("根因引用了当前 Evidence Pack 不存在的 Evidence ID");
    }

    if (
      record.applicabilityConditions.length !==
      record.applicabilityConditionEvidence.length
    ) {
      errors.push("适用条件文本与证据绑定数量不一致");
    }
    record.applicabilityConditionEvidence.forEach((condition, index) => {
      if (record.applicabilityConditions[index] !== condition.text) {
        errors.push(`适用条件 ${index} 的文本与证据绑定不一致`);
      }
      if (
        !pack.constraints.some(
          (candidate) =>
            candidate.text === condition.text &&
            candidate.required === condition.required &&
            sameStringSet(candidate.evidenceIds, condition.evidenceIds)
        )
      ) {
        errors.push(`适用条件 ${index} 未精确绑定 Pack constraint`);
      }
      if (condition.evidenceIds.some((id) => !evidenceIds.has(id))) {
        errors.push(`适用条件 ${index} 引用了当前 Pack 不存在的 Evidence ID`);
      }
    });
  }

  const execution = sources.executionResult;
  if (!execution) {
    errors.push("缺少对应受控 ExecutionResult");
  } else {
    if (
      execution.taskId !== record.taskId ||
      typeof record.diffHash !== "string" ||
      record.diffHash.trim().length === 0 ||
      execution.diffHash !== record.diffHash
    ) {
      errors.push("Diff 哈希无法回溯到同一任务的 ExecutionResult");
    }
    if (!execution.verificationPassed || execution.verificationExitCode !== 0) {
      errors.push("受控 ExecutionResult 的验证未通过");
    }
  }

  const verification = record.verificationResult;
  if (!verification || verification.passed !== true) {
    errors.push("Repair Record 缺少通过的验证摘要");
  } else {
    if (
      !Array.isArray(verification.ranCommands) ||
      verification.ranCommands.length === 0 ||
      verification.ranCommands.some(
        (command) => typeof command !== "string" || command.trim().length === 0
      )
    ) {
      errors.push("验证摘要缺少已运行命令");
    }
    const exitCodes = Object.values(verification.exitCodes);
    if (exitCodes.some((exitCode) => !Number.isFinite(exitCode) || exitCode !== 0)) {
      errors.push("验证摘要包含失败或非法退出码");
    }
    if (
      execution &&
      exitCodes.length > 0 &&
      !exitCodes.some((exitCode) => exitCode === execution.verificationExitCode)
    ) {
      errors.push("验证摘要退出码与 ExecutionResult 不一致");
    }
  }

  const review = record.reviewResult;
  if (!review || (review.verdict !== "ship" && review.verdict !== "ship_with_fixes")) {
    errors.push("Repair Record 缺少非阻断 Review 结论");
  } else if (!Array.isArray(review.findings)) {
    errors.push("Review findings 不是数组");
  } else {
    for (const [index, finding] of review.findings.entries()) {
      if (!isTrustedReviewFinding(finding)) {
        errors.push(`Review finding ${index} 的结构非法`);
        continue;
      }
      if (
        finding.priority === "P0" ||
        finding.priority === "P1" ||
        finding.category === "compatibility" ||
        finding.category === "regression_test"
      ) {
        errors.push(`Review finding ${index} 属于阻断项`);
      }
    }
  }

  return errors;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function isTrustedReviewFinding(value: unknown): value is ReviewFinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  return (
    (finding.priority === "P0" ||
      finding.priority === "P1" ||
      finding.priority === "P2" ||
      finding.priority === "P3") &&
    typeof finding.confidence === "number" &&
    Number.isFinite(finding.confidence) &&
    finding.confidence >= 0 &&
    finding.confidence <= 1 &&
    typeof finding.message === "string" &&
    finding.message.trim().length > 0 &&
    (finding.category === "compatibility" ||
      finding.category === "regression_test" ||
      finding.category === "correctness" ||
      finding.category === "security" ||
      finding.category === "maintainability" ||
      finding.category === "other") &&
    (finding.locator === undefined || typeof finding.locator === "string")
  );
}

function assertStringArray(
  value: Record<string, unknown>,
  field: string
): void {
  const candidate = value[field];
  if (
    !Array.isArray(candidate) ||
    candidate.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new RepairMemoryWriteError(
      "invalid_record",
      `${field} 必须是非空字符串数组`
    );
  }
}

function assertEvidenceConstraintArray(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new RepairMemoryWriteError(
      "invalid_record",
      "applicabilityConditionEvidence 必须是数组"
    );
  }
  for (const constraint of value) {
    if (!constraint || typeof constraint !== "object" || Array.isArray(constraint)) {
      throw new RepairMemoryWriteError(
        "invalid_record",
        "适用条件证据项必须是对象"
      );
    }
    const item = constraint as Record<string, unknown>;
    if (typeof item.text !== "string" || item.text.trim().length === 0) {
      throw new RepairMemoryWriteError(
        "invalid_record",
        "适用条件证据项 text 必须是非空字符串"
      );
    }
    if (typeof item.required !== "boolean") {
      throw new RepairMemoryWriteError(
        "invalid_record",
        "适用条件证据项 required 必须是布尔值"
      );
    }
    assertStringArray(item, "evidenceIds");
  }
}

export interface VerificationSummary {
  readonly passed: boolean;
  readonly ranCommands: readonly string[];
  /** JSON 安全的命令名到退出码映射，禁止使用 Map 以避免 SQLite 往返丢失。 */
  readonly exitCodes: Readonly<Record<string, number>>;
  readonly truncatedOutputTail?: string;
}

export interface ReviewSummary {
  readonly verdict: "ship" | "ship_with_fixes" | "block";
  readonly findings: readonly ReviewFinding[];
}

export type ReviewFindingCategory =
  | "compatibility"
  | "regression_test"
  | "correctness"
  | "security"
  | "maintainability"
  | "other";

export interface ReviewFinding {
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly confidence: number;
  readonly message: string;
  readonly locator?: string;
  /** 用于 Phase 5 质量门识别兼容性与回归测试问题。 */
  readonly category?: ReviewFindingCategory;
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
