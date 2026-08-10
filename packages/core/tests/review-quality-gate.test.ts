import { describe, expect, it } from "vitest";
import {
  evaluateReviewQuality,
  type ReviewResult
} from "../src/index.js";

function review(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: "ship",
    findings: [],
    summary: "可以进入人工审批",
    rootCause: {
      text: "已登记根因",
      confidence: 0.9,
      evidenceIds: ["evidence-1"]
    },
    ...overrides
  };
}

describe("Phase 5 Review 质量门", () => {
  it("验证失败时阻断，即使 Reviewer 给出 ship", () => {
    const result = evaluateReviewQuality({
      review: review(),
      validationPassed: false
    });

    expect(result.passed).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toContain("validation_failed");
  });

  it("P1 兼容性问题会阻断人工审批", () => {
    const result = evaluateReviewQuality({
      review: review({
        findings: [
          {
            priority: "P1",
            confidence: 0.95,
            category: "compatibility",
            message: "旧版调用方仍依赖原有返回结构"
          }
        ]
      }),
      validationPassed: true
    });

    expect(result.passed).toBe(false);
    expect(result.blockingFindings).toHaveLength(1);
    expect(result.reasons.map((reason) => reason.code)).toContain("p0_or_p1_finding");
  });

  it("明确标记缺少回归测试时阻断，即使 finding 是 P2", () => {
    const result = evaluateReviewQuality({
      review: review({
        findings: [
          {
            priority: "P2",
            confidence: 0.9,
            category: "regression_test",
            message: "修复路径没有新增回归测试"
          }
        ]
      }),
      validationPassed: true
    });

    expect(result.passed).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toContain("missing_regression_test");
  });

  it("普通 P2 建议允许进入人工审批", () => {
    const result = evaluateReviewQuality({
      review: review({
        verdict: "ship_with_fixes",
        findings: [
          {
            priority: "P2",
            confidence: 0.7,
            category: "maintainability",
            message: "可以进一步拆分辅助函数"
          }
        ]
      }),
      validationPassed: true
    });

    expect(result.passed).toBe(true);
    expect(result.blockingFindings).toHaveLength(0);
  });

  it("自然语言命中兼容性问题但缺少 category 时失败关闭", () => {
    const result = evaluateReviewQuality({
      review: review({
        findings: [{
          priority: "P2",
          confidence: 0.8,
          message: "修复会破坏旧版 API，且没有新增回归测试"
        }]
      }),
      validationPassed: true
    });

    expect(result.passed).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toContain("invalid_finding_schema");
  });

  it("非法 category 和合法 finding 混合时仍整体失败关闭", () => {
    const result = evaluateReviewQuality({
      review: review({
        findings: [
          {
            priority: "P3",
            confidence: 0.4,
            category: "maintainability",
            message: "普通建议"
          },
          {
            priority: "P2",
            confidence: 0.7,
            category: "compatibility_typo",
            message: "旧客户端不兼容"
          } as unknown as ReviewResult["findings"][number]
        ]
      }),
      validationPassed: true
    });

    expect(result.passed).toBe(false);
    expect(result.blockingFindings).toHaveLength(1);
    expect(result.reasons.map((reason) => reason.code)).toContain("invalid_finding_schema");
  });

  it("block 裁决会阻断，即使没有结构化 finding", () => {
    const result = evaluateReviewQuality({
      review: review({ verdict: "block" }),
      validationPassed: true
    });

    expect(result.passed).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toContain("review_verdict_block");
  });

  it.each([
    ["非法 verdict", { verdict: "allow" }],
    ["非法 priority", { findings: [{ priority: "P9", confidence: 0.8, category: "other", message: "非法优先级" }] }],
    ["负 confidence", { findings: [{ priority: "P2", confidence: -1, category: "other", message: "非法置信度" }] }],
    ["空 message", { findings: [{ priority: "P2", confidence: 0.8, category: "other", message: "" }] }],
    ["findings 非数组", { findings: {} }]
  ])("Core 对%s失败关闭", (_label, invalid) => {
    const result = evaluateReviewQuality({
      review: { ...review(), ...invalid } as unknown as ReviewResult,
      validationPassed: true
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toContain("invalid_review_schema");
  });
});
