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
      const failing: SagMirrorTransport = {
        upsertRepairRecord: async () => { throw new Error("本地 SAG 暂不可达"); },
        searchRepairRecordIds: async () => []
      };
      await expect(store.sagOutbox.processReady(failing)).resolves.toEqual({ sent: 0, retried: 1, discarded: 0 });
      const persisted = await store.unitOfWork.run((tx) => tx.repairRecords.findById(record.id));
      expect(persisted?.status).toBe("APPROVED");
      const row = store.sagOutbox.list()[0] as { status: string; attempts: number; last_error: string };
      expect(row.status).toBe("PENDING");
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain("本地 SAG 暂不可达");

      store.db.prepare("UPDATE sag_outbox SET next_attempt_at = ? WHERE repair_record_id = ?").run("2000-01-01T00:00:00.000Z", record.id);
      const received: string[] = [];
      const success: SagMirrorTransport = {
        upsertRepairRecord: async (payload) => { received.push(payload.repairRecordId); },
        searchRepairRecordIds: async () => []
      };
      await expect(store.sagOutbox.processReady(success)).resolves.toEqual({ sent: 1, retried: 0, discarded: 0 });
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
      await expect(store.sagOutbox.processReady(transport)).resolves.toEqual({ sent: 0, retried: 0, discarded: 1 });
      expect(store.sagOutbox.list()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
