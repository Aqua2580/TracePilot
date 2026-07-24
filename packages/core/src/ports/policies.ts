/**
 * 治理策略端口 —— 见 IMPLEMENTATION_SPEC §7。
 *
 * Core 定义策略接口。具体策略位于
 * `packages/governance`。orchestrator 在任何子进程或文件系统操作之前
 * 调用这些策略；高风险动作默认 DENY，
 * 而非依赖 prompt 层面的约束（§12.4）。
 */

import type { CommandSpec } from "../domain/project.js";
import type { Worktree } from "./adapters.js";

export type RiskClass =
  | "auto_allowed" // §7.2 读取/搜索/LSP/diff/已配置测试
  | "needs_execution_approval" // 修改 worktree / 构建
  | "needs_human_approval" // 删除 / 安装依赖 / 网络 / 数据库迁移
  | "denied"; // push / PR / 远程 / 凭据 / 生产环境

export interface CommandPolicyDecision {
  readonly allowed: boolean;
  readonly riskClass: RiskClass;
  readonly reason: string;
}

export interface PathPolicyDecision {
  readonly allowed: boolean;
  readonly reason: string;
  /** 解析后的真实路径（若允许）。 */
  readonly resolvedPath?: string;
}

export interface ApprovalDecision {
  readonly required: boolean;
  readonly riskClass: RiskClass;
  readonly reason: string;
}

export interface CommandPolicy {
  /**
   * 判定提议的 argv 是否可以运行。argv 必须匹配项目
   * 已注册的白名单（§7.2）；模型输出永远不会被拼接进
   * argv。
   */
  decide(argv: readonly string[], projectWhitelist: {
    readonly lint?: CommandSpec;
    readonly typecheck?: CommandSpec;
    readonly test: CommandSpec;
    readonly build?: CommandSpec;
  }): CommandPolicyDecision;
}

export interface PathPolicy {
  /**
   * 解析并校验 `unresolvedPath` 位于 `roots` 之一内部。拒绝
   * 路径穿越和符号链接逃逸（§7.2）。
   */
  decide(unresolvedPath: string, roots: readonly string[]): PathPolicyDecision;
}

export interface ApprovalPolicy {
  decide(args: {
    readonly action: string;
    readonly riskClass: RiskClass;
    readonly hasExecutionApproval: boolean;
    readonly hasHumanApproval: boolean;
    readonly projectPreauthorized: boolean;
  }): ApprovalDecision;
}

export interface AuditPolicy {
  /**
   * 判定命令执行需要记录什么。按 §7.3：记录 argv、
   * cwd、退出码、截断信息、diff hash、审批人、审查结论。
   * 敏感变量只记录名称，绝不记录值。
   */
  redactEnv(env: Readonly<Record<string, string>>): Readonly<Record<string, "[redacted]" | string>>;
  /** 将输出截断到最大字节预算，保留可读的尾部。 */
  truncateOutput(output: string, maxBytes: number): {
    readonly retained: string;
    readonly originalBytes: number;
    readonly retainedBytes: number;
    readonly truncated: boolean;
  };
}

/**
 * 便利聚合接口 —— orchestrator 依赖此接口，从而
 * 无需了解每个策略的名称。
 */
export interface GovernancePolicies {
  readonly command: CommandPolicy;
  readonly path: PathPolicy;
  readonly approval: ApprovalPolicy;
  readonly audit: AuditPolicy;
}

export interface WorktreePathContext {
  readonly worktree: Worktree;
  readonly projectRepositoryPath: string;
}
