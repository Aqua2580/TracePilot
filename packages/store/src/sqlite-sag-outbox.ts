/**
 * SQLite SAG Outbox —— Phase 7。
 *
 * Repair Record 的 SQLite 事务先提交，再由本处理器调用本地 SAG。领取、
 * 成功确认和失败回退各自使用短事务；任何网络超时或 SAG 故障都不会回滚
 * SQLite 中的任务、审批或 Repair Memory。
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { SagMirrorPayload, SagMirrorTransport, UnitOfWork } from "@tracepilot/core";

const MAX_ERROR_LENGTH = 2_000;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 5 * 60_000;

interface OutboxRow {
  readonly id: string;
  readonly project_id: string;
  readonly repair_record_id: string;
  readonly payload_json: string;
  readonly attempts: number;
}

interface ClaimedOutboxItem {
  readonly id: string;
  readonly projectId: string;
  readonly repairRecordId: string;
  readonly payload: SagMirrorPayload;
  readonly attempts: number;
}

export interface SagOutboxProcessResult {
  readonly sent: number;
  readonly retried: number;
  readonly discarded: number;
}

export class SqliteSagOutbox {
  constructor(
    private readonly deps: { readonly db: DatabaseType; readonly unitOfWork: UnitOfWork }
  ) {}

  /** 处理最多 maxItems 条到期记录；网络调用始终发生在事务之外。 */
  async processReady(transport: SagMirrorTransport, maxItems = 20): Promise<SagOutboxProcessResult> {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) {
      throw new Error("SAG outbox 每次处理数量必须是 1 到 100 的整数");
    }
    let sent = 0;
    let retried = 0;
    let discarded = 0;
    for (let index = 0; index < maxItems; index += 1) {
      const item = await this.claimReady();
      if (!item) break;
      if (!(await this.isStillEligible(item))) {
        await this.discard(item.id);
        discarded += 1;
        continue;
      }
      try {
        await transport.upsertRepairRecord(item.payload);
        await this.markSent(item.id);
        sent += 1;
      } catch (error) {
        await this.scheduleRetry(item.id, item.attempts, error);
        retried += 1;
      }
    }
    return { sent, retried, discarded };
  }

  /** 仅供测试与 Dashboard 的只读投影使用。 */
  list(): readonly Record<string, unknown>[] {
    return this.deps.db.prepare("SELECT * FROM sag_outbox ORDER BY created_at ASC").all() as Record<string, unknown>[];
  }

  private async claimReady(): Promise<ClaimedOutboxItem | undefined> {
    return this.deps.unitOfWork.run(async () => {
      const now = new Date().toISOString();
      const row = this.deps.db.prepare(
        `SELECT id, project_id, repair_record_id, payload_json, attempts FROM sag_outbox
         WHERE status = 'PENDING' AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT 1`
      ).get(now) as OutboxRow | undefined;
      if (!row) return undefined;
      const changed = this.deps.db.prepare(
        `UPDATE sag_outbox SET status = 'PROCESSING', attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'PENDING'`
      ).run(now, row.id);
      if (changed.changes !== 1) return undefined;
      return { ...decodeRow(row), attempts: row.attempts + 1 };
    });
  }

  /** 审批竞态补偿或 Source 解绑后不得继续发送已过期的镜像。 */
  private async isStillEligible(item: ClaimedOutboxItem): Promise<boolean> {
    return this.deps.unitOfWork.run(async () => {
      const row = this.deps.db.prepare(
        `SELECT r.status, p.knowledge_source_id FROM repair_records r
         JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND r.project_id = ?`
      ).get(item.repairRecordId, item.projectId) as { status: string; knowledge_source_id: string | null } | undefined;
      return row?.status === "APPROVED" && row.knowledge_source_id === item.payload.knowledgeSourceId;
    });
  }

  private async markSent(id: string): Promise<void> {
    await this.deps.unitOfWork.run(async () => {
      this.deps.db.prepare(
        "UPDATE sag_outbox SET status = 'SENT', last_error = NULL, updated_at = ? WHERE id = ? AND status = 'PROCESSING'"
      ).run(new Date().toISOString(), id);
    });
  }

  private async scheduleRetry(id: string, attempts: number, error: unknown): Promise<void> {
    const retryMs = Math.min(INITIAL_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
    const now = new Date();
    const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
    await this.deps.unitOfWork.run(async () => {
      this.deps.db.prepare(
        `UPDATE sag_outbox SET status = 'PENDING', next_attempt_at = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'PROCESSING'`
      ).run(new Date(now.getTime() + retryMs).toISOString(), message, now.toISOString(), id);
    });
  }

  private async discard(id: string): Promise<void> {
    await this.deps.unitOfWork.run(async () => {
      this.deps.db.prepare("DELETE FROM sag_outbox WHERE id = ?").run(id);
    });
  }
}

function decodeRow(row: OutboxRow): ClaimedOutboxItem {
  const payload = JSON.parse(row.payload_json) as SagMirrorPayload;
  if (payload.schemaVersion !== 1 || payload.projectId !== row.project_id || payload.repairRecordId !== row.repair_record_id) {
    throw new Error(`SAG outbox ${row.id} 的投影内容不完整或项目归属不匹配`);
  }
  return { id: row.id, projectId: row.project_id, repairRecordId: row.repair_record_id, payload, attempts: row.attempts };
}
