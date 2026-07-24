/**
 * SQLite Repair Memory Adapter —— KnowledgeAdapter 的 SQLite 实现。
 *
 * 见 IMPLEMENTATION_SPEC §6、§5.4 与 ADR-005。
 *
 * Repair Record 是 SQLite MVP 的真源。此适配器直接读写 repair_records 表，
 * 不依赖外部 SAG 服务。FakeKnowledgeAdapter 与本适配器通过同一组契约测试
 * （Phase 2 落地契约测试套件）。
 *
 * 查询规则（§5.4）：
 * - 默认仅召回 APPROVED 状态记录（minStatus 默认 APPROVED）。
 * - minStatus=VERIFIED 时同时召回 VERIFIED 和 APPROVED。
 * - DRAFT / DEPRECATED 永不召回。
 * - 按相关性排序：symptom/rootCause 文本匹配优先，其次 updatedAt 降序。
 *
 * P1-04：写入必须收敛到 UnitOfWork 单写入队列，与任务/审计事务串行化，
 * 不得绕过事务边界直接 upsert。读操作（search）走 WAL 直接查询，不阻塞写。
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { KnowledgeAdapter, MemoryQuery, RepairRecord, UnitOfWork } from "@tracepilot/core";
import type { RepairRecordRow } from "./sqlite-repositories.js";
import { repairRecordFromRow } from "./sqlite-repositories.js";

export interface SqliteRepairMemoryAdapterDeps {
  readonly db: DatabaseType;
  /** 受控写入器：所有写操作通过此 UnitOfWork 串行化，与任务/审计事务共享队列。 */
  readonly unitOfWork: UnitOfWork;
}

export class SqliteRepairMemoryAdapter implements KnowledgeAdapter {
  private readonly db: DatabaseType;
  private readonly unitOfWork: UnitOfWork;

  constructor(deps: SqliteRepairMemoryAdapterDeps) {
    this.db = deps.db;
    this.unitOfWork = deps.unitOfWork;
  }

  async search(query: MemoryQuery): Promise<RepairRecord[]> {
    const minStatus = query.minStatus ?? "APPROVED";
    const statuses =
      minStatus === "APPROVED" ? ["APPROVED"] : ["VERIFIED", "APPROVED"];

    const placeholders = statuses.map(() => "?").join(", ");
    let sql = `SELECT * FROM repair_records WHERE project_id = ? AND status IN (${placeholders})`;
    const params: (string | number)[] = [query.projectId, ...statuses];

    // 简单文本匹配：symptom 或 rootCause 包含查询词（若提供）。
    if (query.symptom) {
      sql += ` AND symptom LIKE ?`;
      params.push(`%${query.symptom}%`);
    }
    if (query.rootCause) {
      sql += ` AND root_cause LIKE ?`;
      params.push(`%${query.rootCause}%`);
    }

    sql += ` ORDER BY updated_at DESC`;

    if (query.maxResults && query.maxResults > 0) {
      sql += ` LIMIT ?`;
      params.push(query.maxResults);
    }

    // 读操作走 WAL 直接查询，不进入串行队列（读不阻塞写）。
    const rows = this.db.prepare(sql).all(...params) as RepairRecordRow[];
    return rows.map(repairRecordFromRow);
  }

  async write(record: RepairRecord): Promise<void> {
    // P1-04：写入走 UnitOfWork 单写入队列，与任务/审计事务串行化，
    // 保证 Repair Memory 写入不会与任务/审计事务交错，且失败时回滚。
    await this.unitOfWork.run(async (tx) => {
      await tx.repairRecords.save(record);
    });
  }
}
