/**
 * ApprovalPolicy — §7.2 风险表。
 *
 * 将 (action, riskClass, hasExecutionApproval, hasHumanApproval,
 * projectPreauthorized) 元组映射到一个决策：是否需要审批，以及需要
 * 何种审批？高风险动作默认 DENY，除非显式批准。
 */

import type { ApprovalPolicy, ApprovalDecision } from "@tracepilot/core";

export class DefaultApprovalPolicy implements ApprovalPolicy {
  decide(args: {
    readonly action: string;
    readonly riskClass: "auto_allowed" | "needs_execution_approval" | "needs_human_approval" | "denied";
    readonly hasExecutionApproval: boolean;
    readonly hasHumanApproval: boolean;
    readonly projectPreauthorized: boolean;
  }): ApprovalDecision {
    switch (args.riskClass) {
      case "auto_allowed":
        // 读/搜索/LSP/diff/已配置测试：自动允许 + 审计（§7.2）。
        return {
          required: false,
          riskClass: "auto_allowed",
          reason: `${args.action} is auto-allowed; audit only`
        };

      case "needs_execution_approval":
        // 修改 worktree / build：需要执行审批或项目
        // 预授权。两者都没有则拒绝。
        if (args.hasExecutionApproval || args.projectPreauthorized) {
          return {
            required: false,
            riskClass: "needs_execution_approval",
            reason: `${args.action} covered by execution approval / preauthorization`
          };
        }
        return {
          required: true,
          riskClass: "needs_execution_approval",
          reason: `${args.action} requires execution approval`
        };

      case "needs_human_approval":
        // 删除 / 依赖安装 / 网络 / db migrate：按次人工审批。
        if (args.hasHumanApproval) {
          return {
            required: false,
            riskClass: "needs_human_approval",
            reason: `${args.action} covered by per-call human approval`
          };
        }
        return {
          required: true,
          riskClass: "needs_human_approval",
          reason: `${args.action} requires per-call human approval`
        };

      case "denied":
        // Push / PR / remote / credentials / prod：默认拒绝，不可覆盖。
        return {
          required: true,
          riskClass: "denied",
          reason: `${args.action} is denied by default (§7.2) — no override available`
        };
    }
  }
}
