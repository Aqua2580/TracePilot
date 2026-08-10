import { describe, expect, it } from "vitest";
import {
  transitionRepairRecord,
  canVerify,
  hasP0OrP1,
  validateTrustedRepairRecordProvenance,
  RepairRecordTransitionError,
  type RepairRecord,
  type ReviewFinding
} from "../src/domain/repair-record.js";
import { computePackContentHash, type EvidencePack } from "../src/domain/evidence.js";
import type { ExecutionResult } from "../src/domain/execution-result.js";

describe("Repair Record 状态机（§5.4）", () => {
  describe("合法迁移", () => {
    it("状态迁移 DRAFT → VERIFIED", () => {
      expect(transitionRepairRecord("DRAFT", "VERIFIED")).toBe("VERIFIED");
    });

    it("状态迁移 VERIFIED → APPROVED", () => {
      expect(transitionRepairRecord("VERIFIED", "APPROVED")).toBe("APPROVED");
    });

    it("状态迁移 APPROVED → DEPRECATED", () => {
      expect(transitionRepairRecord("APPROVED", "DEPRECATED")).toBe("DEPRECATED");
    });

    it("状态迁移 DRAFT → DEPRECATED（无需经过 VERIFIED）", () => {
      expect(transitionRepairRecord("DRAFT", "DEPRECATED")).toBe("DEPRECATED");
    });

    it("状态迁移 VERIFIED → DEPRECATED", () => {
      expect(transitionRepairRecord("VERIFIED", "DEPRECATED")).toBe("DEPRECATED");
    });

    it("no-op 返回相同状态", () => {
      expect(transitionRepairRecord("VERIFIED", "VERIFIED")).toBe("VERIFIED");
    });
  });

  describe("非法迁移", () => {
    it("DRAFT → APPROVED 抛错（不能跳过 VERIFIED）", () => {
      expect(() => transitionRepairRecord("DRAFT", "APPROVED")).toThrow(
        RepairRecordTransitionError
      );
    });

    it("DEPRECATED → APPROVED 抛错（DEPRECATED 为终态）", () => {
      expect(() => transitionRepairRecord("DEPRECATED", "APPROVED")).toThrow(
        RepairRecordTransitionError
      );
    });

    it("APPROVED → DRAFT 抛错（无反向迁移）", () => {
      expect(() => transitionRepairRecord("APPROVED", "DRAFT")).toThrow(
        RepairRecordTransitionError
      );
    });
  });

  describe("canVerify 前置条件", () => {
    it("仅当校验通过且无 P0/P1 时返回 true", () => {
      expect(
        canVerify({ validationPassed: true, hasP0OrP1ReviewFindings: false })
      ).toBe(true);
    });

    it("校验失败时返回 false", () => {
      expect(
        canVerify({ validationPassed: false, hasP0OrP1ReviewFindings: false })
      ).toBe(false);
    });

    it("Review 含 P0/P1 时返回 false", () => {
      expect(
        canVerify({ validationPassed: true, hasP0OrP1ReviewFindings: true })
      ).toBe(false);
    });
  });

  describe("hasP0OrP1 finding 辅助函数", () => {
    const findings: ReviewFinding[] = [
      { priority: "P2", confidence: 0.5, message: "minor" },
      { priority: "P3", confidence: 0.5, message: "nit" }
    ];

    it("仅 P2/P3 时返回 false", () => {
      expect(hasP0OrP1(findings)).toBe(false);
    });

    it("存在 P0 时返回 true", () => {
      expect(
        hasP0OrP1([
          ...findings,
          { priority: "P0", confidence: 0.9, message: "blocker" }
        ])
      ).toBe(true);
    });

    it("存在 P1 时返回 true", () => {
      expect(
        hasP0OrP1([
          ...findings,
          { priority: "P1", confidence: 0.8, message: "important" }
        ])
      ).toBe(true);
    });
  });
});

describe("高可信 Repair Record 来源链", () => {
  const taskSnapshot = {
    objective: "修复来源链测试",
    constraints: ["保持接口兼容"],
    acceptanceCriteria: ["测试通过"],
    riskLevel: "low" as const,
    rawSource: "测试输入",
    origin: "failed_test_log" as const
  };
  const packPayload = {
    id: "pack-trusted",
    taskId: "task-trusted",
    version: 1,
    taskSnapshot,
    evidence: [
      {
        id: "evidence-trusted",
        kind: "code" as const,
        source: "test-fixture",
        locator: "fixture:trusted",
        capturedAt: "2026-08-03T00:00:00.000Z",
        contentHash: "sha256-evidence",
        summary: "根因证据",
        relevance: 1,
        trustLevel: "PRIMARY" as const
      }
    ],
    hypotheses: [
      {
        text: "边界条件遗漏",
        confidence: 0.9,
        evidenceIds: ["evidence-trusted"]
      }
    ],
    constraints: [
      {
        text: "仅适用于当前接口",
        evidenceIds: ["evidence-trusted"],
        required: true
      }
    ],
    acceptanceCriteria: taskSnapshot.acceptanceCriteria,
    createdAt: "2026-08-03T00:00:00.000Z"
  };
  const pack: EvidencePack = {
    ...packPayload,
    contentHash: computePackContentHash(packPayload)
  };
  const execution: ExecutionResult = {
    id: "execution-trusted",
    taskId: "task-trusted",
    runId: "run-trusted",
    diffHash: "sha256-diff",
    diffPatch: "diff --git a/source.ts b/source.ts",
    diffChangedFiles: ["source.ts"],
    diffBytes: 42,
    verificationExitCode: 0,
    verificationPassed: true,
    verificationStdout: "通过",
    verificationStderr: "",
    createdAt: "2026-08-03T00:00:00.000Z"
  };
  const sourceTask = {
    id: "task-trusted",
    projectId: "project-trusted"
  } as const;
  const record: RepairRecord = {
    id: "record-trusted",
    projectId: "project-trusted",
    taskId: "task-trusted",
    status: "APPROVED",
    symptom: "测试失败",
    rootCause: "边界条件遗漏",
    rootCauseConfidence: 0.9,
    rootCauseEvidenceIds: ["evidence-trusted"],
    fixSummary: "补齐边界处理",
    applicabilityConditions: ["仅适用于当前接口"],
    applicabilityConditionEvidence: pack.constraints,
    failureReasons: [],
    inputEvidencePackId: pack.id,
    inputEvidencePackVersion: pack.version,
    inputEvidencePackContentHash: pack.contentHash,
    diffHash: execution.diffHash,
    verificationResult: {
      passed: true,
      ranCommands: ["pnpm test"],
      exitCodes: { "pnpm test": 0 }
    },
    reviewResult: { verdict: "ship", findings: [] },
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z"
  };

  it("完整 Pack、根因、Diff 与验证来源通过校验", () => {
    expect(
      validateTrustedRepairRecordProvenance(record, {
        task: sourceTask,
        evidencePack: pack,
        executionResult: execution
      })
    ).toEqual([]);
  });

  it("缺少 Pack 或根因绑定被篡改时失败关闭", () => {
    expect(
      validateTrustedRepairRecordProvenance(record, {
        task: sourceTask,
        executionResult: execution
      })
    ).toContain("缺少对应 Evidence Pack");
    expect(
      validateTrustedRepairRecordProvenance(
        { ...record, rootCauseEvidenceIds: ["evidence-spoofed"] },
        { task: sourceTask, evidencePack: pack, executionResult: execution }
      )
    ).toContain("根因、置信度或 Evidence ID 未精确绑定 Pack hypothesis");
  });

  it("阻断 finding 或失败验证不能成为高可信记忆", () => {
    const errors = validateTrustedRepairRecordProvenance(
      {
        ...record,
        reviewResult: {
          verdict: "ship",
          findings: [
            {
              priority: "P1",
              confidence: 0.9,
              category: "correctness",
              message: "仍有阻断问题"
            }
          ]
        }
      },
      {
        task: sourceTask,
        evidencePack: pack,
        executionResult: { ...execution, verificationPassed: false }
      }
    );
    expect(errors).toContain("受控 ExecutionResult 的验证未通过");
    expect(errors).toContain("Review finding 0 属于阻断项");
  });

  it("任务属于其他项目时拒绝成为当前项目的高可信记忆", () => {
    expect(
      validateTrustedRepairRecordProvenance(record, {
        task: { ...sourceTask, projectId: "project-other" },
        evidencePack: pack,
        executionResult: execution
      })
    ).toContain("Task 的项目归属与 Repair Record 的 projectId 不匹配");
  });
});
