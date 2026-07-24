import { describe, expect, it } from "vitest";
import { DefaultApprovalPolicy } from "../src/approval-policy.js";

describe("DefaultApprovalPolicy（§7.2 风险表）", () => {
  const policy = new DefaultApprovalPolicy();

  it("auto_allowed 动作无需审批", () => {
    const d = policy.decide({
      action: "git diff",
      riskClass: "auto_allowed",
      hasExecutionApproval: false,
      hasHumanApproval: false,
      projectPreauthorized: false
    });
    expect(d.required).toBe(false);
    expect(d.riskClass).toBe("auto_allowed");
  });

  it("needs_execution_approval：未持有任何审批时需要审批", () => {
    const d = policy.decide({
      action: "modify worktree",
      riskClass: "needs_execution_approval",
      hasExecutionApproval: false,
      hasHumanApproval: false,
      projectPreauthorized: false
    });
    expect(d.required).toBe(true);
    expect(d.riskClass).toBe("needs_execution_approval");
  });

  it("needs_execution_approval：被执行审批覆盖", () => {
    const d = policy.decide({
      action: "modify worktree",
      riskClass: "needs_execution_approval",
      hasExecutionApproval: true,
      hasHumanApproval: false,
      projectPreauthorized: false
    });
    expect(d.required).toBe(false);
  });

  it("needs_execution_approval：被项目预授权覆盖", () => {
    const d = policy.decide({
      action: "modify worktree",
      riskClass: "needs_execution_approval",
      hasExecutionApproval: false,
      hasHumanApproval: false,
      projectPreauthorized: true
    });
    expect(d.required).toBe(false);
  });

  it("needs_human_approval：需要逐次人工审批", () => {
    const d = policy.decide({
      action: "delete file",
      riskClass: "needs_human_approval",
      hasExecutionApproval: true, // 即使持有 exec 审批，仍需人工审批
      hasHumanApproval: false,
      projectPreauthorized: true  // 预授权不能满足人工审批
    });
    expect(d.required).toBe(true);
    expect(d.riskClass).toBe("needs_human_approval");
  });

  it("needs_human_approval：由逐次人工审批满足", () => {
    const d = policy.decide({
      action: "delete file",
      riskClass: "needs_human_approval",
      hasExecutionApproval: false,
      hasHumanApproval: true,
      projectPreauthorized: false
    });
    expect(d.required).toBe(false);
  });

  it("denied：始终需要审批（无覆盖）— §12.4 默认拒绝", () => {
    const d = policy.decide({
      action: "git push",
      riskClass: "denied",
      hasExecutionApproval: true,
      hasHumanApproval: true,
      projectPreauthorized: true
    });
    expect(d.required).toBe(true);
    expect(d.riskClass).toBe("denied");
    expect(d.reason).toMatch(/no override/i);
  });
});
