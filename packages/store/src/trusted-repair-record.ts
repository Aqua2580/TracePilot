/**
 * SQLite 高可信 Repair Record 来源解析器。
 *
 * 该解析器把 repair_records 行重新绑定到精确版本的 Evidence Pack 与同一
 * Diff 的受控 ExecutionResult，再调用 Core 的纯领域校验器。迁移与召回
 * 共用同一条失败关闭边界，避免两处规则漂移。
 */

import type { Database as DatabaseType } from "better-sqlite3";
import {
  validateTrustedRepairRecordProvenance,
  type RepairRecord
} from "@tracepilot/core";
import {
  evidencePackFromRow,
  executionResultFromRow,
  repairRecordFromRow,
  type EvidencePackRow,
  type ExecutionResultRow,
  type RepairRecordRow
} from "./sqlite-repositories.js";

export interface TrustedRepairRecordResolution {
  readonly record?: RepairRecord;
  readonly errors: readonly string[];
}

/** 创建复用 prepared statement 的来源解析器。 */
export function createTrustedRepairRecordResolver(
  db: DatabaseType
): (row: RepairRecordRow) => TrustedRepairRecordResolution {
  const findTask = db.prepare(
    `SELECT id, project_id FROM tasks
     WHERE id = ?
     LIMIT 1`
  );
  const findPack = db.prepare(
    `SELECT * FROM evidence_packs
     WHERE id = ? AND version = ? AND task_id = ?
     LIMIT 1`
  );
  const findExecution = db.prepare(
    `SELECT * FROM execution_results
     WHERE task_id = ? AND diff_hash = ?
       AND verification_passed = 1 AND verification_exit_code = 0
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`
  );

  return (row) => {
    try {
      const record = repairRecordFromRow(row);
      const taskRow = findTask.get(record.taskId) as
        | { id: string; project_id: string }
        | undefined;
      const packRow = findPack.get(
        record.inputEvidencePackId,
        record.inputEvidencePackVersion,
        record.taskId
      ) as EvidencePackRow | undefined;
      const executionRow =
        typeof record.diffHash === "string" && record.diffHash.trim().length > 0
          ? (findExecution.get(record.taskId, record.diffHash) as
              | ExecutionResultRow
              | undefined)
          : undefined;
      const errors = validateTrustedRepairRecordProvenance(record, {
        task: taskRow
          ? { id: taskRow.id, projectId: taskRow.project_id }
          : undefined,
        evidencePack: packRow ? evidencePackFromRow(packRow) : undefined,
        executionResult: executionRow
          ? executionResultFromRow(executionRow)
          : undefined
      });
      return errors.length === 0 ? { record, errors } : { errors };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { errors: [`SQLite 来源数据无法解析：${message}`] };
    }
  };
}
