import { describe, expect, it } from "vitest";
import {
  nextPackVersion,
  computePackContentHash,
  type EvidencePack,
  type EvidenceItem
} from "../src/domain/evidence.js";

function makeItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "ev-1",
    kind: "code",
    source: "code-search",
    locator: "src/foo.ts:12",
    capturedAt: "2026-07-23T00:00:00.000Z",
    contentHash: "sha256-abc",
    summary: "function foo() returns -1 on empty input",
    relevance: 0.8,
    trustLevel: "PRIMARY",
    ...overrides
  };
}

function makePack(overrides: Partial<EvidencePack> = {}): EvidencePack {
  const base: EvidencePack = {
    id: "pack-1",
    taskId: "task-1",
    version: 1,
    taskSnapshot: {
      objective: "fix foo",
      constraints: [],
      acceptanceCriteria: ["foo returns 0"],
      riskLevel: "low",
      rawSource: "FAILED foo",
      origin: "failed_test_log"
    },
    evidence: [makeItem()],
    hypotheses: [
      { text: "foo mishandles empty input", confidence: 0.7, evidenceIds: ["ev-1"] }
    ],
    constraints: [],
    acceptanceCriteria: ["foo returns 0"],
    createdAt: "2026-07-23T00:00:00.000Z",
    contentHash: "placeholder"
  };
  return { ...base, ...overrides, contentHash: computePackContentHash(base) };
}

describe("Evidence Pack 版本管理（§5.3）", () => {
  it("对相同 payload 计算确定性内容哈希", () => {
    const pack = makePack();
    const h1 = computePackContentHash({
      id: pack.id,
      taskId: pack.taskId,
      version: pack.version,
      taskSnapshot: pack.taskSnapshot,
      evidence: pack.evidence,
      hypotheses: pack.hypotheses,
      constraints: pack.constraints,
      acceptanceCriteria: pack.acceptanceCriteria
    });
    const h2 = computePackContentHash({
      id: pack.id,
      taskId: pack.taskId,
      version: pack.version,
      taskSnapshot: pack.taskSnapshot,
      evidence: pack.evidence,
      hypotheses: pack.hypotheses,
      constraints: pack.constraints,
      acceptanceCriteria: pack.acceptanceCriteria
    });
    expect(h1).toBe(h2);
    expect(h1.startsWith("fnv1a32-")).toBe(true);
  });

  it("当 version 变化时产生不同的哈希", () => {
    const pack = makePack();
    const h1 = computePackContentHash({
      id: pack.id,
      taskId: pack.taskId,
      version: 1,
      taskSnapshot: pack.taskSnapshot,
      evidence: pack.evidence,
      hypotheses: pack.hypotheses,
      constraints: pack.constraints,
      acceptanceCriteria: pack.acceptanceCriteria
    });
    const h2 = computePackContentHash({
      id: pack.id,
      taskId: pack.taskId,
      version: 2,
      taskSnapshot: pack.taskSnapshot,
      evidence: pack.evidence,
      hypotheses: pack.hypotheses,
      constraints: pack.constraints,
      acceptanceCriteria: pack.acceptanceCriteria
    });
    expect(h1).not.toBe(h2);
  });

  it("nextPackVersion 递增 version，保留旧 evidence，追加新 evidence", () => {
    const v1 = makePack();
    const newItem = makeItem({ id: "ev-2", locator: "src/bar.ts:5" });
    const v2 = nextPackVersion(v1, { evidence: [newItem] });

    expect(v2.version).toBe(2);
    expect(v2.id).toBe(v1.id);
    expect(v2.evidence).toHaveLength(2);
    expect(v2.evidence.map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
    // v1 不变 — Pack 按版本不可变。
    expect(v1.evidence).toHaveLength(1);
    expect(v1.version).toBe(1);
  });

  it("nextPackVersion 产生与 v1 不同的内容哈希", () => {
    const v1 = makePack();
    const v2 = nextPackVersion(v1, {
      evidence: [makeItem({ id: "ev-2" })]
    });
    expect(v1.contentHash).not.toBe(v2.contentHash);
  });

  it("nextPackVersion 在未覆盖时保留既有 hypotheses/constraints", () => {
    const v1 = makePack({
      hypotheses: [
        { text: "h1", confidence: 0.5, evidenceIds: ["ev-1"] }
      ],
      constraints: [
        { text: "c1", evidenceIds: ["ev-1"], required: true }
      ]
    });
    const v2 = nextPackVersion(v1, { evidence: [] });
    expect(v2.hypotheses).toEqual(v1.hypotheses);
    expect(v2.constraints).toEqual(v1.constraints);
  });
});
