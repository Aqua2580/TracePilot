/**
 * SAG 检索增强 Adapter —— Phase 7。
 *
 * SQLite 先筛选、验证并提供 Repair Record 真源；SAG 只返回同一项目
 * Source 中记录 ID 的排序提示。任何网络异常、未知 ID 或跨项目结果都
 * 被忽略，因此 SAG 不可用不会阻塞 MVP，也不会扩大召回边界。
 */

import type {
  KnowledgeAdapter,
  MemoryQuery,
  RepairRecord,
  SagMirrorTransport
} from "@tracepilot/core";

export interface SagKnowledgeAdapterOptions {
  readonly sqliteMemory: KnowledgeAdapter;
  readonly resolveKnowledgeSourceId: (projectId: string) => Promise<string | undefined>;
  readonly transport: SagMirrorTransport;
}

export class SagKnowledgeAdapter implements KnowledgeAdapter {
  constructor(private readonly options: SagKnowledgeAdapterOptions) {}

  async search(query: MemoryQuery): Promise<RepairRecord[]> {
    const sqliteRecords = await this.options.sqliteMemory.search(query);
    if (sqliteRecords.length < 2) return sqliteRecords;
    const sourceId = await this.options.resolveKnowledgeSourceId(query.projectId);
    if (!sourceId) return sqliteRecords;
    try {
      const rankedIds = await this.options.transport.searchRepairRecordIds({
        knowledgeSourceId: sourceId,
        query
      });
      return reorderSqliteRecords(sqliteRecords, rankedIds);
    } catch {
      // 检索增强失败必须失败关闭到 SQLite 基线，不能中断任务证据收集。
      return sqliteRecords;
    }
  }

  async write(record: RepairRecord): Promise<void> {
    // SQLite 仍是唯一写入真源；镜像由 SQLite outbox 在事务提交后处理。
    await this.options.sqliteMemory.write(record);
  }
}

function reorderSqliteRecords(
  sqliteRecords: readonly RepairRecord[],
  rankedIds: readonly string[]
): RepairRecord[] {
  const byId = new Map(sqliteRecords.map((record) => [record.id, record]));
  const seen = new Set<string>();
  const result: RepairRecord[] = [];
  for (const id of rankedIds) {
    const record = byId.get(id);
    if (!record || seen.has(id)) continue;
    seen.add(id);
    result.push(record);
  }
  for (const record of sqliteRecords) {
    if (!seen.has(record.id)) result.push(record);
  }
  return result;
}
