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
import {
  assertMemoryQuery,
  assertRepairRecordForKnowledgeWrite,
  RepairMemoryWriteError,
  validateTrustedRepairRecordProvenance,
  type KnowledgeAdapter,
  type MemoryQuery,
  type RepairRecord,
  type UnitOfWork
} from "@tracepilot/core";
import type { RepairRecordRow } from "./sqlite-repositories.js";
import { createTrustedRepairRecordResolver } from "./trusted-repair-record.js";

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
    assertMemoryQuery(query);
    const minStatus = query.minStatus ?? "APPROVED";
    const statuses =
      minStatus === "APPROVED" ? ["APPROVED"] : ["VERIFIED", "APPROVED"];

    const placeholders = statuses.map(() => "?").join(", ");
    const sql = `SELECT * FROM repair_records WHERE project_id = ? AND status IN (${placeholders})`;
    const params: (string | number)[] = [query.projectId, ...statuses];

    // 读操作走 WAL 直接查询，不进入串行队列（读不阻塞写）。
    // 文本过滤和排序在内存中完成，确保 symptom/rootCause 的匹配分数
    // 与 FakeKnowledgeAdapter 使用同一套确定性规则。
    const rows = this.db.prepare(sql).all(...params) as RepairRecordRow[];
    const resolveTrustedRecord = createTrustedRepairRecordResolver(this.db);
    const records = rows
      .flatMap((row) => {
        // P1-08：状态标签不是信任依据。每次召回都重新绑定 Pack 与受控
        // ExecutionResult；任一来源缺失、损坏或不匹配时跳过该行。
        const resolved = resolveTrustedRecord(row);
        return resolved.record ? [resolved.record] : [];
      })
      .filter((record) => matchesMemoryQuery(record, query))
      .sort((left, right) => {
        const scoreDelta = memoryMatchScore(right, query) - memoryMatchScore(left, query);
        if (scoreDelta !== 0) return scoreDelta;
        const timeDelta = right.updatedAt.localeCompare(left.updatedAt);
        return timeDelta !== 0 ? timeDelta : left.id.localeCompare(right.id);
      });

    const limit = query.maxResults ?? 10;
    return limit > 0 ? records.slice(0, limit) : [];
  }

  async write(record: RepairRecord): Promise<void> {
    assertRepairRecordForKnowledgeWrite(record);
    // P1-04：写入走 UnitOfWork 单写入队列，与任务/审计事务串行化，
    // 保证 Repair Memory 写入不会与任务/审计事务交错，且失败时回滚。
    try {
      await this.unitOfWork.run(async (tx) => {
        const [project, task, existing] = await Promise.all([
          tx.projects.findById(record.projectId),
          tx.tasks.findById(record.taskId),
          tx.repairRecords.findById(record.id)
        ]);
        if (!project || !task) {
          throw new RepairMemoryWriteError(
            "missing_reference",
            `projectId=${record.projectId} 或 taskId=${record.taskId} 不存在`
          );
        }
        if (task.projectId !== record.projectId) {
          throw new RepairMemoryWriteError(
            "project_mismatch",
            `taskId=${record.taskId} 实际属于 projectId=${task.projectId}，不能写入 projectId=${record.projectId}`
          );
        }
        if (
          existing &&
          (existing.projectId !== record.projectId || existing.taskId !== record.taskId)
        ) {
          throw new RepairMemoryWriteError(
            "identity_mismatch",
            `Repair Record ${record.id} 的 projectId/taskId 身份不可变`
          );
        }

        if (record.status === "VERIFIED" || record.status === "APPROVED") {
          const [packVersions, executions] = await Promise.all([
            tx.evidencePacks.findVersions(record.inputEvidencePackId),
            tx.executionResults.findByTask(record.taskId)
          ]);
          const evidencePack = packVersions.find(
            (pack) => pack.version === record.inputEvidencePackVersion
          );
          const executionResult = [...executions]
            .reverse()
            .find(
              (execution) =>
                execution.diffHash === record.diffHash &&
                execution.verificationPassed &&
                execution.verificationExitCode === 0
            );
          const provenanceErrors = validateTrustedRepairRecordProvenance(record, {
            task: { id: task.id, projectId: task.projectId },
            evidencePack,
            executionResult
          });
          if (provenanceErrors.length > 0) {
            throw new RepairMemoryWriteError(
              "invalid_record",
              `高可信来源链校验失败：${provenanceErrors.join("；")}`
            );
          }
        }
        await tx.repairRecords.save(record);
      });
    } catch (error) {
      if (error instanceof RepairMemoryWriteError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/FOREIGN KEY constraint failed/i.test(message)) {
        throw new RepairMemoryWriteError(
          "missing_reference",
          `projectId=${record.projectId} 或 taskId=${record.taskId} 不存在`
        );
      }
      throw new RepairMemoryWriteError("write_failed", message);
    }
  }
}

function matchesMemoryQuery(
  record: RepairRecord,
  query: MemoryQuery
): boolean {
  const symptom = query.symptom?.trim().toLocaleLowerCase();
  const rootCause = query.rootCause?.trim().toLocaleLowerCase();
  if (symptom && !record.symptom.toLocaleLowerCase().includes(symptom) && !record.rootCause.toLocaleLowerCase().includes(symptom)) {
    return false;
  }
  if (rootCause && !record.rootCause.toLocaleLowerCase().includes(rootCause)) {
    return false;
  }
  return true;
}

function memoryMatchScore(
  record: RepairRecord,
  query: MemoryQuery
): number {
  const symptom = query.symptom?.trim().toLocaleLowerCase();
  const rootCause = query.rootCause?.trim().toLocaleLowerCase();
  const recordSymptom = record.symptom.toLocaleLowerCase();
  const recordRootCause = record.rootCause.toLocaleLowerCase();
  let score = 0;
  if (symptom) {
    if (recordSymptom === symptom) score += 100;
    else if (recordSymptom.includes(symptom)) score += 60;
    if (recordRootCause.includes(symptom)) score += 30;
  }
  if (rootCause) {
    if (recordRootCause === rootCause) score += 100;
    else if (recordRootCause.includes(rootCause)) score += 60;
  }
  return score;
}
