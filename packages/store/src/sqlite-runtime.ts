/**
 * SQLite 运行时初始化 —— 见 IMPLEMENTATION_SPEC §3.1 与 ADR-005。
 *
 * 职责：
 * - 解析数据目录（默认 %LOCALAPPDATA%/TracePilot/data/tracepilot.db）。
 * - 打开数据库并设置 PRAGMA：foreign_keys=ON、WAL、busy_timeout。
 * - 执行迁移（迁移机制见 migrations.ts）。
 * - 提供安全备份能力（备份失败不得删除原库）。
 *
 * 不得在数据库事务中等待模型响应、运行测试、创建 worktree 或调用外部进程。
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { Database as DatabaseType } from "better-sqlite3";
import { runMigrations } from "./migrations.js";

/** 默认数据目录解析。MVP 固定为 %LOCALAPPDATA%/TracePilot/data/tracepilot.db。 */
export function resolveDefaultDataPath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    // 非 Windows 环境兜底（测试 / WSL）。
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
    return resolve(home, ".local", "share", "TracePilot", "data", "tracepilot.db");
  }
  return resolve(localAppData, "TracePilot", "data", "tracepilot.db");
}

export interface OpenDatabaseOptions {
  /** 数据库文件路径。测试可传入临时路径。 */
  readonly dbPath: string;
  /** busy_timeout 毫秒数。默认 5000。 */
  readonly busyTimeoutMs?: number;
  /** 若为 true，跳过迁移（仅用于测试中已迁移的库）。 */
  readonly skipMigrations?: boolean;
}

/**
 * 打开 SQLite 数据库并应用 PRAGMA + 迁移。
 *
 * PRAGMA 说明（§3.1、ADR-005）：
 * - `foreign_keys=ON`：启用外键约束。
 * - `journal_mode=WAL`：WAL 模式，提升并发读性能。
 * - `busy_timeout`：写入锁等待上限，避免 SQLITE_BUSY 立即失败。
 * - `synchronous=NORMAL`：WAL 模式下的安全/性能折中。
 *
 * 返回的 Database 实例由调用方负责关闭。
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseType {
  const dir = resolve(options.dbPath, "..");
  mkdirSync(dir, { recursive: true });

  const db = new Database(options.dbPath);
  // PRAGMA 必须在事务外设置。
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  db.pragma("synchronous = NORMAL");

  if (!options.skipMigrations) {
    runMigrations(db);
  }

  return db;
}

/**
 * 安全备份 —— 将当前数据库备份到目标路径。
 *
 * §3.1：导出/备份失败不得删除原数据库。使用 SQLite 的 Online Backup API
 * （better-sqlite3 的 `db.backup`）保证一致性。备份目标目录会先创建。
 *
 * 备份失败时抛出异常，原库不受影响。
 */
export async function backupDatabase(
  db: DatabaseType,
  targetPath: string
): Promise<void> {
  const dir = resolve(targetPath, "..");
  mkdirSync(dir, { recursive: true });
  // better-sqlite3 的 backup 是异步的，返回 Promise。
  await db.backup(targetPath);
}

/** 关闭数据库。WAL 模式下会自动 checkpoint。 */
export function closeDatabase(db: DatabaseType): void {
  if (db.open) {
    db.close();
  }
}
