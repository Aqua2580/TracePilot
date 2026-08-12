/**
 * SQLite Store 工厂 —— 集中创建完整的持久化栈。
 *
 * 见 IMPLEMENTATION_SPEC §3.1 与 ADR-005。
 *
 * 职责：
 * - 打开数据库并应用 PRAGMA + 迁移。
 * - 返回 UnitOfWork（供 TaskOrchestrator 使用）。
 * - 返回 KnowledgeAdapter（SqliteRepairMemoryAdapter）。
 * - 返回 db 句柄（供备份、健康检查等使用）。
 *
 * 调用方负责在关闭时调用 closeDatabase。
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { UnitOfWork, KnowledgeAdapter } from "@tracepilot/core";
import { openDatabase, closeDatabase, type OpenDatabaseOptions } from "./sqlite-runtime.js";
import { SqliteUnitOfWork } from "./sqlite-unit-of-work.js";
import { SqliteRepairMemoryAdapter } from "./sqlite-repair-memory-adapter.js";
import { SqliteSagOutbox } from "./sqlite-sag-outbox.js";

export interface SqliteStore {
  readonly db: DatabaseType;
  readonly unitOfWork: UnitOfWork;
  readonly knowledgeAdapter: KnowledgeAdapter;
  /** Phase 7：SQLite 已提交记录的 SAG 异步镜像队列。 */
  readonly sagOutbox: SqliteSagOutbox;
  /** 关闭数据库连接。 */
  close(): void;
}

/**
 * 创建 SQLite Store。
 *
 * 默认使用 %LOCALAPPDATA%/TracePilot/data/tracepilot.db；测试可传入
 * 临时路径。
 */
export function createSqliteStore(
  options: Pick<OpenDatabaseOptions, "dbPath"> & Partial<Omit<OpenDatabaseOptions, "dbPath">>
): SqliteStore {
  const db = openDatabase(options);
  const unitOfWork = new SqliteUnitOfWork({ db });
  // P1-04：KnowledgeAdapter 写入走 UnitOfWork 单写入队列，与任务/审计事务串行化。
  const knowledgeAdapter = new SqliteRepairMemoryAdapter({ db, unitOfWork });
  const sagOutbox = new SqliteSagOutbox({ db, unitOfWork });

  return {
    db,
    unitOfWork,
    knowledgeAdapter,
    sagOutbox,
    close: () => closeDatabase(db)
  };
}
