/** Phase 7 SAG outbox 集成测试：SQLite 真源、失败重试与审批状态纵深防御。 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteStore, type SqliteStore } from "../src/index.js";
import type { Project, RepairRecord, Task, SagMirrorTransport } from "@tracepilot/core";

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createFixture(): { store: SqliteStore; record: RepairRecord } {
  const directory = mkdtempSync(join(tmpdir(), "tracepilot-sag-outbox-"));
  paths.push(directory);
  const store = createSqliteStore({ dbPath: join(directory, "tracepilot.db") });
  const project: Project = {
    id: "project-sag-a",
    name: "SAG 测试项目",
    repositoryPath: "D:/fixture-sag-a",
    defaultBranch: "main",
    language: "typescript",
    commands: { test: { argv: ["pnpm", "test"], timeoutMs: 30_000 } },
    knowledgeSourceId: "source-project-a",
    createdAt: "2026-08-12T00:00:00.000Z"
  };
  const task: Task = {
    id: "task-sag-a",
    projectId: project.id,
    status: "COMPLETED",
    input: { objective: "x", constraints: [], acceptanceCriteria: [], riskLevel: "low", rawSource: "x", origin: "issue" },
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z"
  };
  const record: RepairRecord = {
    id: "repair-sag-a",
    projectId: project.id,
    taskId: task.id,
    status: "APPROVED",
    symptom: "构建失败",
    rootCause: "缺少依赖声明",
    rootCauseConfidence: 0.9,
    rootCauseEvidenceIds: ["evidence-1"],
    fixSummary: "补齐依赖",
    applicabilityConditions: [],
    applicabilityConditionEvidence: [],
    failureReasons: [],
    inputEvidencePackId: "pack-sag-a",
    inputEvidencePackVersion: 1,
    inputEvidencePackContentHash: "hash-pack",
    diffHash: "hash-diff",
    verificationResult: { passed: true, commands: [] },
    reviewResult: { verdict: "PASS", findings: [] },
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z"
  };
  return { store, record };
}

async function seed(store: SqliteStore, record: RepairRecord): Promise<void> {
  const project: Project = {
    id: record.projectId,
    name: "SAG 测试项目",
    repositoryPath: "D:/fixture-sag-a",
    defaultBranch: "main",
    language: "typescript",
    commands: { test: { argv: ["pnpm", "test"], timeoutMs: 30_000 } },
    knowledgeSourceId: "source-project-a",
    createdAt: record.createdAt
  };
  const task: Task = {
    id: record.taskId,
    projectId: record.projectId,
    status: "COMPLETED",
    input: { objective: "x", constraints: [], acceptanceCriteria: [], riskLevel: "low", rawSource: "x", origin: "issue" },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
  await store.unitOfWork.run(async (tx) => {
    await tx.projects.save(project);
    await tx.tasks.save(task);
    await tx.repairRecords.save(record);
  });
}

describe("SQLite SAG outbox", () => {
  it("SQLite 已提交 APPROVED Repair Record 后才异步投递，失败不会回滚真源且可重试", async () => {
    const { store, record } = createFixture();
    try {
      await seed(store, record);
      expect(store.sagOutbox.list()).toHaveLength(1);
      expect(store.sagSourceDocuments.list(record.projectId)).toEqual([
        expect.objectContaining({
          documentId: record.id,
          kind: "repair_record",
          knowledgeSourceId: "source-project-a",
          locator: expect.stringContaining(`repair-record:${record.id}`),
          contentHash: expect.stringMatching(/^sha256-[a-f0-9]{64}$/)
        })
      ]);
      const failing: SagMirrorTransport = {
        upsertRepairRecord: async () => { throw new Error("本地 SAG 暂不可达"); },
        searchRepairRecordIds: async () => []
      };
      await expect(store.sagOutbox.processReady(failing)).resolves.toMatchObject({ sent: 0, retried: 1, discarded: 0, deadLettered: 0 });
      const persisted = await store.unitOfWork.run((tx) => tx.repairRecords.findById(record.id));
      expect(persisted?.status).toBe("APPROVED");
      const row = store.sagOutbox.list()[0] as {
        status: string;
        attempts: number;
        last_error: string;
        payload_json: string;
      };
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe("本机 SAG 投递失败；事件将按受控退避策略重试或转入死信");
      expect(JSON.parse(row.payload_json)).toMatchObject({
        repairRecordId: record.id,
        projectId: record.projectId,
        contentHash: expect.stringMatching(/^sha256-[a-f0-9]{64}$/)
      });

      store.db.prepare("UPDATE sag_outbox SET next_attempt_at = ? WHERE repair_record_id = ?").run("2000-01-01T00:00:00.000Z", record.id);
      const received: string[] = [];
      const success: SagMirrorTransport = {
        upsertRepairRecord: async (payload) => { received.push(payload.repairRecordId); },
        searchRepairRecordIds: async () => []
      };
      await expect(store.sagOutbox.processReady(success)).resolves.toMatchObject({ sent: 1, retried: 0, discarded: 0, deadLettered: 0 });
      expect(received).toEqual([record.id]);
      expect((store.sagOutbox.list()[0] as { status: string }).status).toBe("SENT");
    } finally {
      store.close();
    }
  });

  it("审批被撤销或项目 SAG Source 解绑后，过期 outbox 不会被发送", async () => {
    const { store, record } = createFixture();
    try {
      await seed(store, record);
      store.db.prepare("UPDATE repair_records SET status = 'DEPRECATED' WHERE id = ?").run(record.id);
      const transport: SagMirrorTransport = {
        upsertRepairRecord: async () => { throw new Error("不得调用 SAG"); },
        searchRepairRecordIds: async () => []
      };
      await expect(store.sagOutbox.processReady(transport)).resolves.toMatchObject({ sent: 0, retried: 0, discarded: 1 });
      expect(store.sagOutbox.list()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("崩溃遗留的 PROCESSING 事件可恢复；达到上限进入死信并需显式重放", async () => {
    const { store, record } = createFixture();
    try {
      await seed(store, record);
      store.db.prepare(
        "UPDATE sag_outbox SET status = 'PROCESSING', attempts = 7, lease_expires_at = ?, updated_at = ? WHERE repair_record_id = ?"
      ).run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", record.id);
      const failing: SagMirrorTransport = {
        upsertRepairRecord: async () => { throw new Error("SAG 持续故障"); },
        searchRepairRecordIds: async () => []
      };
      await expect(store.sagOutbox.processReady(failing)).resolves.toMatchObject({
        recovered: 1, deadLettered: 1, sent: 0, retried: 0
      });
      const row = store.sagOutbox.list()[0] as { id: string; status: string; attempts: number };
      expect(row.status).toBe("DEAD_LETTER");
      expect(row.attempts).toBe(8);
      expect(await store.sagOutbox.replay(row.id)).toBe(true);
      expect(store.sagOutbox.list()[0]).toMatchObject({ status: "PENDING", attempts: 8 });
    } finally {
      store.close();
    }
  });

  it("两个并发 Worker 只能由一个领取同一事件，网络投递不会发生在 SQLite 事务内", async () => {
    const { store, record } = createFixture();
    try {
      await seed(store, record);
      let calls = 0;
      let markEntered: (() => void) | undefined;
      let releaseNetwork: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => { markEntered = resolve; });
      const networkFinished = new Promise<void>((resolve) => { releaseNetwork = resolve; });
      const transport: SagMirrorTransport = {
        upsertRepairRecord: async () => {
          calls += 1;
          markEntered?.();
          await networkFinished;
        },
        searchRepairRecordIds: async () => []
      };

      const firstWorker = store.sagOutbox.processReady(transport);
      await entered;
      const secondWorker = await store.sagOutbox.processReady(transport);
      expect(secondWorker).toMatchObject({ sent: 0, retried: 0, discarded: 0 });
      expect(calls).toBe(1);
      await expect(store.unitOfWork.run((tx) => tx.repairRecords.findById(record.id)))
        .resolves.toMatchObject({ status: "APPROVED" });

      releaseNetwork?.();
      await expect(firstWorker).resolves.toMatchObject({ sent: 1, retried: 0, discarded: 0 });
      expect(calls).toBe(1);
      expect(store.sagOutbox.list()[0]).toMatchObject({ status: "SENT" });
    } finally {
      store.close();
    }
  });

  it("Repair Record 失去 APPROVED 状态后不再保留可被 SAG 召回的来源登记", async () => {
    const { store, record } = createFixture();
    try {
      await seed(store, record);
      const deprecated = { ...record, status: "DEPRECATED" as const, updatedAt: "2026-08-12T01:00:00.000Z" };
      await store.unitOfWork.run((tx) => tx.repairRecords.save(deprecated));
      expect(store.sagSourceDocuments.list(record.projectId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("损坏的 outbox payload 不会阻塞后续任务，会被保留为无敏感内容的死信", async () => {
    const { store, record } = createFixture();
    try {
      await seed(store, record);
      store.db.prepare("UPDATE sag_outbox SET payload_json = ? WHERE repair_record_id = ?")
        .run('{"schemaVersion":1,"token":"不应出现在错误中"}', record.id);
      const transport: SagMirrorTransport = {
        upsertRepairRecord: async () => { throw new Error("损坏事件不应调用 SAG"); },
        searchRepairRecordIds: async () => []
      };
      await expect(store.sagOutbox.processReady(transport)).resolves.toMatchObject({
        sent: 0,
        retried: 0,
        deadLettered: 1
      });
      expect(store.sagOutbox.list()[0]).toMatchObject({
        status: "DEAD_LETTER",
        last_error: "本机 SAG 投递失败；事件将按受控退避策略重试或转入死信"
      });
      expect(String((store.sagOutbox.list()[0] as { last_error: string }).last_error)).not.toContain("token");
      await expect(store.unitOfWork.run((tx) => tx.repairRecords.findById(record.id)))
        .resolves.toMatchObject({ status: "APPROVED" });
    } finally {
      store.close();
    }
  });

  it("外部 SAG 错误中的令牌或响应正文不会写入重试记录", async () => {
    const { store, record } = createFixture();
    try {
      await seed(store, record);
      const transport: SagMirrorTransport = {
        upsertRepairRecord: async () => {
          throw new Error("401 token=top-secret; Authorization: Bearer exposed-value");
        },
        searchRepairRecordIds: async () => []
      };
      await expect(store.sagOutbox.processReady(transport)).resolves.toMatchObject({
        retried: 1,
        sent: 0
      });
      const row = store.sagOutbox.list()[0] as { last_error: string };
      expect(row.last_error).toBe("本机 SAG 投递失败；事件将按受控退避策略重试或转入死信");
      expect(row.last_error).not.toContain("top-secret");
      expect(row.last_error).not.toContain("exposed-value");
    } finally {
      store.close();
    }
  });

  it("重放入口拒绝控制字符事件 ID", async () => {
    const { store } = createFixture();
    try {
      await expect(store.sagOutbox.replay("bad\u0000id")).rejects.toThrow("事件 ID 非法");
    } finally {
      store.close();
    }
  });
});
