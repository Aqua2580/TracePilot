/**
 * Review 质量门 —— 见实施规格 §5.4、§8.1、Phase 5。
 *
 * Runtime 可以给出任意文字或结构化裁决，但只有通过这里的确定性检查，
 * 才能进入人工审批和 Repair Memory。模型输出不是事实，验证结果、Diff
 * 和结构化 Review finding 才是质量门的输入。
 */

import type { ReviewResult } from "../ports/adapters.js";
import type { ReviewFinding } from "./repair-record.js";
import type {
  EvidenceConstraint,
  EvidencePack,
  Hypothesis
} from "./evidence.js";

export type ReviewBlockReasonCode =
  | "validation_failed"
  | "review_verdict_block"
  | "p0_or_p1_finding"
  | "compatibility_finding"
  | "missing_regression_test"
  | "invalid_finding_schema"
  | "invalid_review_schema"
  | "invalid_evidence_binding";

export interface ReviewBlockReason {
  readonly code: ReviewBlockReasonCode;
  readonly message: string;
}

export interface ReviewQualityGateResult {
  readonly passed: boolean;
  readonly reasons: readonly ReviewBlockReason[];
  readonly blockingFindings: readonly ReviewFinding[];
}

/**
 * 对 Review 结果执行确定性质量检查。
 *
 * - 验证失败或 verdict=block：直接阻断；
 * - 任意 P0/P1：阻断；
 * - Reviewer 明确标记兼容性问题或缺少回归测试：阻断；
 * - P2/P3 的普通建议允许进入人工审批，由人工决定是否接受。
 */
export function evaluateReviewQuality(args: {
  readonly review: ReviewResult;
  readonly validationPassed: boolean;
  /** 提供当前 Pack 时，同时强制根因与适用条件的具体 Evidence ID 绑定。 */
  readonly evidencePack?: EvidencePack;
}): ReviewQualityGateResult {
  const reasons: ReviewBlockReason[] = [];
  const blockingFindings: ReviewFinding[] = [];

  const schemaErrors = validateReviewResultSchema(args.review);
  for (const error of schemaErrors) {
    reasons.push({
      code: "invalid_review_schema",
      message: `Review 结果 schema 无效，已失败关闭：${error}`
    });
  }

  if (args.evidencePack) {
    for (const error of validateReviewEvidenceBindings(args.review, args.evidencePack)) {
      reasons.push({
        code: "invalid_evidence_binding",
        message: `Review 证据绑定无效，已失败关闭：${error}`
      });
    }
  }

  if (!args.validationPassed) {
    reasons.push({
      code: "validation_failed",
      message: "受控验证未通过，禁止进入人工批准"
    });
  }

  if (args.review.verdict === "block") {
    reasons.push({
      code: "review_verdict_block",
      message: "Reviewer 给出 block 裁决，禁止进入人工批准"
    });
  }

  const findings = Array.isArray((args.review as { findings?: unknown }).findings)
    ? args.review.findings
    : [];
  for (const finding of findings) {
    if (!finding || typeof finding !== "object") continue;
    if (!isReviewFindingCategory(finding.category)) {
      blockingFindings.push(finding);
      reasons.push({
        code: "invalid_finding_schema",
        message: `Review finding 缺少或包含非法 category，已失败关闭：${finding.message}`
      });
      continue;
    }

    if (finding.priority === "P0" || finding.priority === "P1") {
      blockingFindings.push(finding);
      const categoryLabel =
        finding.category === "compatibility"
          ? "兼容性"
          : finding.category === "regression_test"
            ? "回归测试"
            : undefined;
      reasons.push({
        code: "p0_or_p1_finding",
        message: `${finding.priority}${categoryLabel ? ` ${categoryLabel}问题` : " 问题"}必须先处理：${finding.message}`
      });
      continue;
    }

    if (finding.category === "compatibility") {
      blockingFindings.push(finding);
      reasons.push({
        code: "compatibility_finding",
        message: `兼容性问题必须先处理：${finding.message}`
      });
    } else if (finding.category === "regression_test") {
      blockingFindings.push(finding);
      reasons.push({
        code: "missing_regression_test",
        message: `缺少或不足的回归测试：${finding.message}`
      });
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
    blockingFindings
  };
}

/**
 * Core 层完整运行时 schema 校验。
 *
 * 不能假设所有 RuntimeAdapter 都复用 OmpAdapter 的解析器；任何内部误用、
 * 旧 Adapter 或手工构造对象都必须在确定性质量门再次失败关闭。
 */
export function validateReviewResultSchema(review: unknown): readonly string[] {
  const errors: string[] = [];
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return ["ReviewResult 必须是对象"];
  }
  const value = review as Record<string, unknown>;
  if (!isReviewVerdict(value.verdict)) {
    errors.push("verdict 缺失或非法");
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
    errors.push("summary 必须是非空字符串");
  }
  if (!Array.isArray(value.findings)) {
    errors.push("findings 必须是数组");
  } else {
    value.findings.forEach((finding, index) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
        errors.push(`findings[${index}] 必须是对象`);
        return;
      }
      const item = finding as Record<string, unknown>;
      if (!isReviewPriority(item.priority)) {
        errors.push(`findings[${index}].priority 缺失或非法`);
      }
      if (
        typeof item.confidence !== "number" ||
        !Number.isFinite(item.confidence) ||
        item.confidence < 0 ||
        item.confidence > 1
      ) {
        errors.push(`findings[${index}].confidence 必须是 0 到 1 之间的数字`);
      }
      if (!isReviewFindingCategory(item.category)) {
        errors.push(`findings[${index}].category 缺失或非法`);
      }
      if (typeof item.message !== "string" || item.message.trim().length === 0) {
        errors.push(`findings[${index}].message 必须是非空字符串`);
      }
      if (item.locator !== undefined && typeof item.locator !== "string") {
        errors.push(`findings[${index}].locator 必须是字符串`);
      }
    });
  }

  if (value.verdict !== "block" || value.rootCause !== undefined) {
    errors.push(...validateHypothesisShape(value.rootCause, "rootCause"));
  }

  if (value.fixSummary !== undefined) {
    if (typeof value.fixSummary !== "string" || value.fixSummary.trim().length === 0) {
      errors.push("fixSummary 必须是非空字符串");
    }
  }

  if (value.applicabilityConditions !== undefined) {
    if (!Array.isArray(value.applicabilityConditions)) {
      errors.push("applicabilityConditions 必须是数组");
    } else {
      value.applicabilityConditions.forEach((condition, index) => {
        errors.push(
          ...validateEvidenceConstraintShape(
            condition,
            `applicabilityConditions[${index}]`
          )
        );
      });
    }
  }
  return errors;
}

/** 当前 Pack 内的证据引用与 hypothesis/constraint 归属校验。 */
export function validateReviewEvidenceBindings(
  review: ReviewResult,
  pack: EvidencePack
): readonly string[] {
  const errors: string[] = [];
  const evidenceIds = new Set(pack.evidence.map((item) => item.id));
  const rootCause = review.rootCause;
  if (!isHypothesis(rootCause)) {
    errors.push("rootCause 必须引用当前 Pack 中已登记的 hypothesis");
  } else {
    for (const id of rootCause.evidenceIds) {
      if (!evidenceIds.has(id)) {
        errors.push(`rootCause 引用了当前 Pack 不存在的 Evidence ID：${id}`);
      }
    }
    const registered = pack.hypotheses.some((candidate) =>
      sameHypothesis(candidate, rootCause)
    );
    if (!registered) {
      errors.push("rootCause 不是当前 Pack 中已登记的 hypothesis；必须先走 Evidence Request 生成新 Pack");
    }
  }

  for (const [index, condition] of (review.applicabilityConditions ?? []).entries()) {
    if (!isEvidenceConstraint(condition)) continue;
    for (const id of condition.evidenceIds) {
      if (!evidenceIds.has(id)) {
        errors.push(`applicabilityConditions[${index}] 引用了当前 Pack 不存在的 Evidence ID：${id}`);
      }
    }
    const registered = pack.constraints.some((candidate) =>
      sameEvidenceConstraint(candidate, condition)
    );
    if (!registered) {
      errors.push(`applicabilityConditions[${index}] 不是当前 Pack 中已登记的约束`);
    }
  }
  return errors;
}

/** Review finding 的运行时分类校验，防止旧 schema 或模型漏字段失败开放。 */
export function isReviewFindingCategory(
  category: unknown
): category is NonNullable<ReviewFinding["category"]> {
  return (
    category === "compatibility" ||
    category === "regression_test" ||
    category === "correctness" ||
    category === "security" ||
    category === "maintainability" ||
    category === "other"
  );
}

function isReviewVerdict(value: unknown): value is ReviewResult["verdict"] {
  return value === "ship" || value === "ship_with_fixes" || value === "block";
}

function isReviewPriority(value: unknown): value is ReviewFinding["priority"] {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

function validateHypothesisShape(value: unknown, field: string): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${field} 必须是包含 text、confidence、evidenceIds 的对象`];
  }
  const item = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof item.text !== "string" || item.text.trim().length === 0) {
    errors.push(`${field}.text 必须是非空字符串`);
  }
  if (
    typeof item.confidence !== "number" ||
    !Number.isFinite(item.confidence) ||
    item.confidence < 0 ||
    item.confidence > 1
  ) {
    errors.push(`${field}.confidence 必须是 0 到 1 之间的数字`);
  }
  errors.push(...validateEvidenceIds(item.evidenceIds, `${field}.evidenceIds`));
  return errors;
}

function validateEvidenceConstraintShape(value: unknown, field: string): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${field} 必须是包含 text、evidenceIds、required 的对象`];
  }
  const item = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof item.text !== "string" || item.text.trim().length === 0) {
    errors.push(`${field}.text 必须是非空字符串`);
  }
  errors.push(...validateEvidenceIds(item.evidenceIds, `${field}.evidenceIds`));
  if (typeof item.required !== "boolean") {
    errors.push(`${field}.required 必须是 boolean`);
  }
  return errors;
}

function validateEvidenceIds(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [`${field} 必须是非空字符串数组`];
  }
  const ids = value.filter((id): id is string =>
    typeof id === "string" && id.trim().length > 0
  );
  if (ids.length !== value.length) return [`${field} 只能包含非空字符串`];
  if (new Set(ids).size !== ids.length) return [`${field} 不得包含重复 ID`];
  return [];
}

function isHypothesis(value: unknown): value is Hypothesis {
  return validateHypothesisShape(value, "rootCause").length === 0;
}

function isEvidenceConstraint(value: unknown): value is EvidenceConstraint {
  return validateEvidenceConstraintShape(value, "condition").length === 0;
}

function sameHypothesis(left: Hypothesis, right: Hypothesis): boolean {
  return (
    left.text === right.text &&
    left.confidence === right.confidence &&
    sameStringSet(left.evidenceIds, right.evidenceIds)
  );
}

function sameEvidenceConstraint(
  left: EvidenceConstraint,
  right: EvidenceConstraint
): boolean {
  return (
    left.text === right.text &&
    left.required === right.required &&
    sameStringSet(left.evidenceIds, right.evidenceIds)
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
