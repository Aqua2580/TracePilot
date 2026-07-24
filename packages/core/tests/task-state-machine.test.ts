import { describe, expect, it } from "vitest";
import {
  transition,
  IllegalTransitionError,
  isTerminalStatus,
  TERMINAL_STATUSES,
  canComplete,
  type TaskStatus
} from "../src/domain/task.js";

describe("Task 状态机 — 纯迁移函数", () => {
  describe("正向 Happy Path 迁移（§5.2）", () => {
    it("状态迁移 CREATED → INTAKING", () => {
      expect(transition("CREATED", "INTAKING")).toBe("INTAKING");
    });

    it("完整 Happy Path 状态迁移", () => {
      const path: TaskStatus[] = [
        "CREATED",
        "INTAKING",
        "GATHERING_EVIDENCE",
        "PLANNED",
        "AWAITING_EXECUTION_APPROVAL",
        "EXECUTING",
        "VALIDATING",
        "REVIEWING",
        "AWAITING_HUMAN_APPROVAL",
        "COMPLETED"
      ];
      for (let i = 0; i < path.length - 1; i++) {
        expect(transition(path[i]!, path[i + 1]!)).toBe(path[i + 1]!);
      }
    });

    it("状态迁移 AWAITING_HUMAN_APPROVAL → REJECTED", () => {
      expect(transition("AWAITING_HUMAN_APPROVAL", "REJECTED")).toBe("REJECTED");
    });

    it("支持 EVIDENCE_GAP 循环：EXECUTING → EVIDENCE_GAP → GATHERING_EVIDENCE → PLANNED", () => {
      expect(transition("EXECUTING", "EVIDENCE_GAP")).toBe("EVIDENCE_GAP");
      expect(transition("EVIDENCE_GAP", "GATHERING_EVIDENCE")).toBe(
        "GATHERING_EVIDENCE"
      );
      expect(transition("GATHERING_EVIDENCE", "PLANNED")).toBe("PLANNED");
      expect(transition("PLANNED", "AWAITING_EXECUTION_APPROVAL")).toBe(
        "AWAITING_EXECUTION_APPROVAL"
      );
    });

    it("P2-R03：非终态同状态 no-op 抛 IllegalTransitionError", () => {
      expect(() => transition("EXECUTING", "EXECUTING")).toThrow(IllegalTransitionError);
      expect(() => transition("CREATED", "CREATED")).toThrow(IllegalTransitionError);
      expect(() => transition("PLANNED", "PLANNED")).toThrow(IllegalTransitionError);
    });
  });

  describe("任意非终态 → FAILED / CANCELLED / INTERRUPTED", () => {
    const nonTerminal: TaskStatus[] = [
      "CREATED",
      "INTAKING",
      "GATHERING_EVIDENCE",
      "PLANNED",
      "AWAITING_EXECUTION_APPROVAL",
      "EXECUTING",
      "EVIDENCE_GAP",
      "VALIDATING",
      "REVIEWING",
      "AWAITING_HUMAN_APPROVAL"
    ];

    for (const from of nonTerminal) {
      it(`允许 ${from} → CANCELLED`, () => {
        expect(transition(from, "CANCELLED")).toBe("CANCELLED");
      });
    }

    // FAILED 并非从所有状态都合法 — 仅可从那些能执行真实工作的状态迁移而来。
    // 见 LEGAL_TRANSITIONS 表。
    it("允许 INTAKING → FAILED", () => {
      expect(transition("INTAKING", "FAILED")).toBe("FAILED");
    });
    it("允许 EXECUTING → FAILED", () => {
      expect(transition("EXECUTING", "FAILED")).toBe("FAILED");
    });
    it("允许 VALIDATING → FAILED", () => {
      expect(transition("VALIDATING", "FAILED")).toBe("FAILED");
    });
    it("允许 REVIEWING → FAILED", () => {
      expect(transition("REVIEWING", "FAILED")).toBe("FAILED");
    });
  });

  describe("非法迁移抛出 IllegalTransitionError", () => {
    it("AWAITING_HUMAN_APPROVAL → EXECUTING 抛错（跳过门控）", () => {
      expect(() => transition("AWAITING_HUMAN_APPROVAL", "EXECUTING")).toThrow(
        IllegalTransitionError
      );
    });

    it("CREATED → EXECUTING 抛错（跳过 intake/evidence/plan/approval）", () => {
      expect(() => transition("CREATED", "EXECUTING")).toThrow(
        IllegalTransitionError
      );
    });

    it("PLANNED → COMPLETED 抛错（跳过 exec/validate/review/approval）", () => {
      expect(() => transition("PLANNED", "COMPLETED")).toThrow(
        IllegalTransitionError
      );
    });

    it("AWAITING_EXECUTION_APPROVAL → COMPLETED 抛错", () => {
      expect(() =>
        transition("AWAITING_EXECUTION_APPROVAL", "COMPLETED")
      ).toThrow(IllegalTransitionError);
    });
  });

  describe("终态处理", () => {
    it("将 COMPLETED、REJECTED、FAILED、CANCELLED、INTERRUPTED 标记为终态", () => {
      for (const s of TERMINAL_STATUSES) {
        expect(isTerminalStatus(s)).toBe(true);
      }
    });

    it("从终态向外迁移时抛错（INTERRUPTED 恢复除外）", () => {
      expect(() => transition("COMPLETED", "REVIEWING")).toThrow(
        IllegalTransitionError
      );
      expect(() => transition("REJECTED", "AWAITING_HUMAN_APPROVAL")).toThrow(
        IllegalTransitionError
      );
      expect(() => transition("FAILED", "EXECUTING")).toThrow(
        IllegalTransitionError
      );
      expect(() => transition("CANCELLED", "INTAKING")).toThrow(
        IllegalTransitionError
      );
    });

    it("P2-R03：终态同状态 no-op 抛 IllegalTransitionError（不短路放行）", () => {
      // 关键：终态检查必须在 from===to 短路之前，否则会被放行。
      expect(() => transition("COMPLETED", "COMPLETED")).toThrow(
        IllegalTransitionError
      );
      expect(() => transition("CANCELLED", "CANCELLED")).toThrow(
        IllegalTransitionError
      );
      expect(() => transition("FAILED", "FAILED")).toThrow(
        IllegalTransitionError
      );
      expect(() => transition("REJECTED", "REJECTED")).toThrow(
        IllegalTransitionError
      );
      // INTERRUPTED → INTERRUPTED 不是 resume 目标，也应拒绝。
      expect(() => transition("INTERRUPTED", "INTERRUPTED")).toThrow(
        IllegalTransitionError
      );
    });
  });

  describe("INTERRUPTED 恢复（§5.2）", () => {
    it("允许从 INTERRUPTED 恢复到更早的安全非终态", () => {
      const safeTargets: TaskStatus[] = [
        "GATHERING_EVIDENCE",
        "PLANNED",
        "AWAITING_EXECUTION_APPROVAL",
        "EXECUTING",
        "VALIDATING",
        "FAILED",
        "CANCELLED"
      ];
      for (const to of safeTargets) {
        expect(transition("INTERRUPTED", to)).toBe(to);
      }
    });

    it("禁止从 INTERRUPTED 直接恢复到 COMPLETED", () => {
      expect(() => transition("INTERRUPTED", "COMPLETED")).toThrow(
        IllegalTransitionError
      );
    });

    it("禁止从 INTERRUPTED 恢复到 REVIEWING 或 AWAITING_HUMAN_APPROVAL", () => {
      // 这些状态意味着 validation+review 已经发生，若不重新执行就
      // 直接声称其结果。
      expect(() => transition("INTERRUPTED", "REVIEWING")).toThrow(
        IllegalTransitionError
      );
      expect(() =>
        transition("INTERRUPTED", "AWAITING_HUMAN_APPROVAL")
      ).toThrow(IllegalTransitionError);
    });
  });

  describe("canComplete 前置条件（§5.2, §12.1）", () => {
    it("仅当校验通过 + 无 P0/P1 + 人工审批时返回 true", () => {
      expect(
        canComplete({
          validationPassed: true,
          hasP0OrP1ReviewFindings: false,
          hasHumanApproval: true
        })
      ).toBe(true);
    });

    it("校验失败时返回 false", () => {
      expect(
        canComplete({
          validationPassed: false,
          hasP0OrP1ReviewFindings: false,
          hasHumanApproval: true
        })
      ).toBe(false);
    });

    it("Review 含 P0/P1 时返回 false", () => {
      expect(
        canComplete({
          validationPassed: true,
          hasP0OrP1ReviewFindings: true,
          hasHumanApproval: true
        })
      ).toBe(false);
    });

    it("无人工审批时返回 false", () => {
      expect(
        canComplete({
          validationPassed: true,
          hasP0OrP1ReviewFindings: false,
          hasHumanApproval: false
        })
      ).toBe(false);
    });
  });
});
