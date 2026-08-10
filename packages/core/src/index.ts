/**
 * @tracepilot/core —— 公共 API。
 *
 * 领域模型、端口、内存仓储与 TaskOrchestrator。Core 不导入 Fastify、
 * React、Drizzle、Git SDK 或 Pi SDK。
 */

// 领域模型
export * from "./domain/project.js";
export * from "./domain/task.js";
export * from "./domain/evidence.js";
export * from "./domain/repair-record.js";
export * from "./domain/review.js";
export * from "./domain/audit.js";
export * from "./domain/agent-run.js";
export * from "./domain/execution-result.js";

// 端口（仅接口 —— 实现在 packages/adapters、packages/store）
export * from "./ports/adapters.js";
export * from "./ports/repositories.js";
export * from "./ports/policies.js";
export * from "./ports/worktree-filesystem-guard.js";
export * from "./ports/controlled-file-writer.js";
export * from "./ports/human-decision-finalization.js";

// 内存仓储（Phase 1 单元测试兜底实现）
export * from "./repositories/in-memory.js";

// 服务
export * from "./services/task-orchestrator.js";
export * from "./services/evidence-router.js";
export * from "./services/worktree-manager.js";
export * from "./services/evidence-collector.js";
export * from "./services/execution-orchestrator.js";
