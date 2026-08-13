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
const MAX_ATTEMPTS = 8;
const PROCESSING_LEASE_MS = 60_000;

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

/** 损坏的 SQLite 事件不能再安全投递，只能保留为人工可见死信。 */
interface MalformedOutboxItem {
  readonly id: string;
  readonly reason: string;
}

export interface SagOutboxProcessResult {
  readonly sent: number;
  readonly retried: number;
  readonly discarded: number;
  /** 本轮达到重试上限、等待操作者明确重放的事件数。 */
  readonly deadLettered: number;
  /** 启动或上轮进程崩溃后，从过期 PROCESSING 状态恢复的事件数。 */
  readonly recovered: number;
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
    const recovered = await this.recoverExpiredProcessing();
    let sent = 0;
    let retried = 0;
    let discarded = 0;
    let deadLettered = 0;
    for (let index = 0; index < maxItems; index += 1) {
      const item = await this.claimReady();
      if (!item) break;
      if ("reason" in item) {
        await this.moveToDeadLetter(item.id, new Error(item.reason));
        deadLettered += 1;
        continue;
      }
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
        if (item.attempts >= MAX_ATTEMPTS) {
          await this.moveToDeadLetter(item.id, error);
          deadLettered += 1;
        } else {
          await this.scheduleRetry(item.id, item.attempts, error);
          retried += 1;
        }
      }
    }
    return { sent, retried, discarded, deadLettered, recovered };
  }

  /** 仅供测试与 Dashboard 的只读投影使用。 */
  list(): readonly Record<string, unknown>[] {
    return this.deps.db.prepare("SELECT * FROM sag_outbox ORDER BY created_at ASC").all() as Record<string, unknown>[];
  }

  /**
   * 仅允许操作者明确重放单条死信或待处理事件；不会直接调用 SAG。
   * 重放保留历史尝试次数和错误摘要，便于审计外部服务的恢复过程。
   */
  async replay(id: string): Promise<boolean> {
    if (!id || id.length > 128 || /[\r\n\0]/.test(id)) {
      throw new Error("SAG outbox 事件 ID 非法");
    }
    return this.deps.unitOfWork.run(async () => {
      const changed = this.deps.db.prepare(
        `UPDATE sag_outbox
         SET status = 'PENDING', next_attempt_at = ?, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('DEAD_LETTER', 'PENDING')`
      ).run(new Date().toISOString(), new Date().toISOString(), id);
      return changed.changes === 1;
    });
  }

  /** 暴露固定上限，供 Dashboard/CLI 仅展示，不允许调用方绕过。 */
  static get maxAttempts(): number {
    return MAX_ATTEMPTS;
  }

  /** 暴露固定租约，供迁移后的 Worker 诊断与集成测试核对。 */
  static get processingLeaseMs(): number {
    return PROCESSING_LEASE_MS;
  }

  private async claimReady(): Promise<ClaimedOutboxItem | MalformedOutboxItem | undefined> {
    return this.deps.unitOfWork.run(async () => {
      const now = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + PROCESSING_LEASE_MS).toISOString();
      const row = this.deps.db.prepare(
        `SELECT id, project_id, repair_record_id, payload_json, attempts FROM sag_outbox
         WHERE status = 'PENDING' AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT 1`
      ).get(now) as OutboxRow | undefined;
      if (!row) return undefined;
      const changed = this.deps.db.prepare(
        `UPDATE sag_outbox
         SET status = 'PROCESSING', attempts = attempts + 1, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING'`
      ).run(leaseExpiresAt, now, row.id);
      if (changed.changes !== 1) return undefined;
      try {
        return { ...decodeRow(row), attempts: row.attempts + 1 };
      } catch {
        // 不把 payload 原文或异常细节写回错误列，避免把可能含敏感字段的
        // 损坏内容再次复制到审计/日志。操作者仍可从事件 ID 定位并手工处理。
        return { id: row.id, reason: "SAG outbox payload 格式损坏，已转入死信" };
      }
    });
  }

  /**
   * Worker 在网络调用期间崩溃不会留下永久 PROCESSING 事件。过期租约只能
   * 回到 PENDING，真正投递仍须通过下一轮领取和资格复核。
   */
  private async recoverExpiredProcessing(): Promise<number> {
    return this.deps.unitOfWork.run(async () => {
      const now = new Date();
      const changed = this.deps.db.prepare(
        `UPDATE sag_outbox
         SET status = 'PENDING', next_attempt_at = ?, lease_expires_at = NULL, updated_at = ?,
             last_error = COALESCE(last_error, 'Worker 租约过期，已恢复等待重试')
         WHERE status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
      ).run(now.toISOString(), now.toISOString(), now.toISOString());
      return changed.changes;
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
        "UPDATE sag_outbox SET status = 'SENT', lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'PROCESSING'"
      ).run(new Date().toISOString(), id);
    });
  }

  private async scheduleRetry(id: string, attempts: number, error: unknown): Promise<void> {
    const retryMs = Math.min(INITIAL_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
    const now = new Date();
    const message = summarizeTransportFailure(error);
    await this.deps.unitOfWork.run(async () => {
      this.deps.db.prepare(
        `UPDATE sag_outbox SET status = 'PENDING', next_attempt_at = ?, lease_expires_at = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'PROCESSING'`
      ).run(new Date(now.getTime() + retryMs).toISOString(), message, now.toISOString(), id);
    });
  }

  private async moveToDeadLetter(id: string, error: unknown): Promise<void> {
    const now = new Date().toISOString();
    const message = summarizeTransportFailure(error);
    await this.deps.unitOfWork.run(async () => {
      this.deps.db.prepare(
        `UPDATE sag_outbox SET status = 'DEAD_LETTER', lease_expires_at = NULL, last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'PROCESSING'`
      ).run(message, now, id);
    });
  }

  private async discard(id: string): Promise<void> {
    await this.deps.unitOfWork.run(async () => {
      this.deps.db.prepare("DELETE FROM sag_outbox WHERE id = ?").run(id);
    });
  }
}

/**
 * SAG 返回的异常可能含 URL 查询参数、鉴权头或响应片段，不能复制到 SQLite
 * 审计投影。详细诊断只保留在运行期受控日志中；outbox 仅记录固定、可公开的
 * 状态摘要，避免重试和死信本身成为凭据泄漏通道。
 */
function summarizeTransportFailure(_error: unknown): string {
  return "本机 SAG 投递失败；事件将按受控退避策略重试或转入死信".slice(0, MAX_ERROR_LENGTH);
}

function decodeRow(row: OutboxRow): ClaimedOutboxItem {
  const payload = JSON.parse(row.payload_json) as Partial<SagMirrorPayload>;
  if (
    payload.schemaVersion !== 1 ||
    payload.projectId !== row.project_id ||
    payload.repairRecordId !== row.repair_record_id ||
    typeof payload.knowledgeSourceId !== "string" ||
    payload.knowledgeSourceId.trim().length === 0 ||
    typeof payload.contentHash !== "string" ||
    !/^sha256-[a-f0-9]{64}$/i.test(payload.contentHash) ||
    typeof payload.symptom !== "string" ||
    typeof payload.rootCause !== "string" ||
    typeof payload.fixSummary !== "string" ||
    typeof payload.sourceLocator !== "string" ||
    payload.sourceLocator.length === 0 ||
    /[\r\n\0]/.test(payload.sourceLocator)
  ) {
    throw new Error(`SAG outbox ${row.id} 的投影内容不完整或项目归属不匹配`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    repairRecordId: row.repair_record_id,
    payload: payload as SagMirrorPayload,
    attempts: row.attempts
  };
}
