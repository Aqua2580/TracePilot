/** Phase 7 发布级三组评测：缺少真实原始数据时拒绝形成发布结论。 */

import { describe, expect, it } from "vitest";
import {
  PHASE7_RELEASE_GROUPS,
  PHASE7_RELEASE_SCENARIOS,
  summarizePhase7ReleaseEvaluation,
  type Phase7ReleaseEvaluationSample
} from "../src/phase7-release-evaluation.js";

function samples(): Phase7ReleaseEvaluationSample[] {
  return PHASE7_RELEASE_GROUPS.flatMap((group, groupIndex) =>
    PHASE7_RELEASE_SCENARIOS.map((scenario, scenarioIndex) => ({
      group,
      scenario,
      repositoryBaseline: "synthetic-git-fixtures@sha256-example",
      taskClosed: true,
      patchAccepted: scenarioIndex === 0,
      unsupportedChange: false,
      keyEvidenceRecallAt5: groupIndex / 2,
      humanInterventionCount: scenarioIndex,
      elapsedMs: 1_000 + groupIndex,
      tokenCost: 0.1 + groupIndex,
      taskId: `${group}-${scenario}-task`,
      evidencePackId: `${group}-${scenario}-pack`,
      approvalAuditId: `${group}-${scenario}-approval`
    }))
  );
}

describe("Phase 7 发布级三组评测汇总", () => {
  it("完整六个真实原始样本计算所有发布指标并保留审计索引", () => {
    const result = summarizePhase7ReleaseEvaluation(samples());
    expect(result.groups).toEqual([
      expect.objectContaining({ name: "no_memory", sampleCount: 2, taskClosureRate: 1, patchAcceptanceRate: 0.5, unsupportedChangeRate: 0, keyEvidenceRecallAt5: 0, humanInterventions: 1, elapsedMs: 2_000, tokenCost: 0.2 }),
      expect.objectContaining({ name: "sqlite_memory", sampleCount: 2, keyEvidenceRecallAt5: 0.5 }),
      expect.objectContaining({ name: "sag_enhanced", sampleCount: 2, keyEvidenceRecallAt5: 1 })
    ]);
    expect(result.samples).toHaveLength(6);
  });

  it("缺少任一场景、不同仓库基线或缺少审计索引时拒绝生成发布结果", () => {
    expect(() => summarizePhase7ReleaseEvaluation(samples().slice(0, 5))).toThrow("6 个原始样本");
    const mismatched = samples();
    mismatched[5] = { ...mismatched[5]!, repositoryBaseline: "other" };
    expect(() => summarizePhase7ReleaseEvaluation(mismatched)).toThrow("同一个非空 repositoryBaseline");
    const missingAudit = samples();
    missingAudit[0] = { ...missingAudit[0]!, approvalAuditId: "" };
    expect(() => summarizePhase7ReleaseEvaluation(missingAudit)).toThrow("缺少任务、Evidence Pack 或人工批准审计索引");
  });
});
