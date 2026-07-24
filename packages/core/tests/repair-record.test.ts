import { describe, expect, it } from "vitest";
import {
  transitionRepairRecord,
  canVerify,
  hasP0OrP1,
  RepairRecordTransitionError,
  type ReviewFinding
} from "../src/domain/repair-record.js";

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
