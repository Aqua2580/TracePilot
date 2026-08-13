/** Phase 7 三组评测：同输入实际经过三种 KnowledgeAdapter 配置。 */

import { describe, expect, it } from "vitest";
import {
  PHASE7_EVALUATION_CONFIGURATION,
  PHASE7_EVALUATION_INPUT_HASH,
  runPhase7MemoryModeEvaluation
} from "../src/phase7-evaluation.js";

describe("Phase 7 三组本地检索评测", () => {
  it("同一版本化输入实际经过空记忆、SQLite 和记忆增强 Adapter，结果可复算", async () => {
    const first = await runPhase7MemoryModeEvaluation();
    const second = await runPhase7MemoryModeEvaluation();
    expect(first).toEqual(second);
    expect(first.groups).toEqual([
      expect.objectContaining({ name: "no_memory", sampleCount: 8, keyEvidenceRecallAt5: 0 }),
      expect.objectContaining({ name: "sqlite_memory", sampleCount: 8, keyEvidenceRecallAt5: 0.625 }),
      expect.objectContaining({ name: "sag_enhanced", sampleCount: 8, keyEvidenceRecallAt5: 1 })
    ]);
    expect(first.samples.every((sample) => sample.noMemory.length === 0)).toBe(true);
    expect(first.samples.every((sample) => sample.sagEnhanced[0] === sample.expectedLocator)).toBe(true);
    expect(first.groups.every((group) => group.tokenCost === null && group.patchAcceptanceRate === null)).toBe(true);
    expect(first.samples.map((sample) => sample.id)).toEqual([
      "bench-01-pytest-assertion",
      "bench-02-pytest-import",
      "bench-03-vitest-assertion",
      "bench-04-jest-mock-missing",
      "bench-05-pytest-timeout",
      "bench-06-issue-structured",
      "bench-07-pytest-multi-file",
      "bench-08-vitest-snapshot"
    ]);
    expect(PHASE7_EVALUATION_INPUT_HASH).toMatch(/^sha256-[a-f0-9]{64}$/);
    expect(PHASE7_EVALUATION_CONFIGURATION.adapterByGroup.sqlite_memory).toContain("SqliteRepairMemoryAdapter");
    expect(PHASE7_EVALUATION_CONFIGURATION.adapterByGroup.sag_enhanced).toContain("SagKnowledgeAdapter");
  });

  it("机器可读结果标明替身与未授权限制，不把本地夹具伪装成真实发布结果", async () => {
    const result = await runPhase7MemoryModeEvaluation();
    expect(result.configuration).toEqual(PHASE7_EVALUATION_CONFIGURATION);
    expect(result.limitations.join("\n")).toContain("内存传输契约替身");
    expect(result.limitations.join("\n")).toContain("不调用真实 SAG、Omp、模型或人工审批");
  });
});
