/**
 * @tracepilot/governance — §7.2 / §7.3 策略的默认实现。
 *
 * Core 定义了策略接口；本包提供具体的
 * 默认实现。orchestrator 和适配器依赖
 * （来自 Core 的）接口，并注入 Default* 实现。
 */

export { DefaultCommandPolicy } from "./command-policy.js";
export { DefaultPathPolicy } from "./path-policy.js";
export { DefaultApprovalPolicy } from "./approval-policy.js";
export { DefaultAuditPolicy } from "./audit-policy.js";

import { DefaultCommandPolicy } from "./command-policy.js";
import { DefaultPathPolicy } from "./path-policy.js";
import { DefaultApprovalPolicy } from "./approval-policy.js";
import { DefaultAuditPolicy } from "./audit-policy.js";
import type { GovernancePolicies } from "@tracepilot/core";

/**
 * 便利聚合：构建一个包含所有默认
 * 实现的 GovernancePolicies。测试和 API 组合根使用它；
 * 如有需要，具体测试可覆盖个别策略。
 */
export function defaultGovernancePolicies(): GovernancePolicies {
  return {
    command: new DefaultCommandPolicy(),
    path: new DefaultPathPolicy(),
    approval: new DefaultApprovalPolicy(),
    audit: new DefaultAuditPolicy()
  };
}
