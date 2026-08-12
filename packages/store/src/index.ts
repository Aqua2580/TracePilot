/**
 * @tracepilot/store —— SQLite 持久化层。
 *
 * 见 IMPLEMENTATION_SPEC §3.1、§6 与 ADR-005。
 *
 * 导出：
 * - schema（Drizzle 表定义，供类型安全查询使用）
 * - openDatabase / closeDatabase / backupDatabase（运行时初始化）
 * - runMigrations / getAppliedVersions（迁移）
 * - SqliteUnitOfWork（事务 + 单写入队列）
 * - SqliteRepositories（事务内仓储集合）
 * - SqliteRepairMemoryAdapter（KnowledgeAdapter 的 SQLite 实现）
 * - createSqliteStore（工厂：打开库 + 迁移 + 返回 UnitOfWork）
 */

export * from "./schema.js";
export {
  resolveDefaultDataPath,
  openDatabase,
  closeDatabase,
  backupDatabase,
  type OpenDatabaseOptions
} from "./sqlite-runtime.js";
export {
  runMigrations,
  getAppliedVersions,
  getLatestMigrationVersion
} from "./migrations.js";
export { SqliteUnitOfWork, type SqliteUnitOfWorkDeps } from "./sqlite-unit-of-work.js";
export { SqliteRepositories } from "./sqlite-repositories.js";
export { SqliteRepairMemoryAdapter } from "./sqlite-repair-memory-adapter.js";
export { SqliteSagOutbox, type SagOutboxProcessResult } from "./sqlite-sag-outbox.js";
export { createSqliteStore, type SqliteStore } from "./create-store.js";
export {
  RuntimeEventBuffer,
  type RuntimeEventBufferDeps
} from "./runtime-event-buffer.js";
