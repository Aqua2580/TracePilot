/** Phase 7 SAG 装配测试：默认 SQLite 基线、半配置失败关闭与显式替身增强。 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCompositionRoot } from "../src/composition-root.js";
import { hashSagSourceDocument } from "@tracepilot/adapters";
import type {
  KnowledgeDocument,
  Project,
  SagMirrorTransport,
  SagSourceDocument,
  SagSourceDocumentTransport,
  TaskInput
} from "@tracepilot/core";

const directories: string[] = [];
const originalSagBaseUrl = process.env.TRACEPILOT_SAG_BASE_URL;
const originalSagToken = process.env.TRACEPILOT_SAG_TOKEN;

afterEach(() => {
  if (originalSagBaseUrl === undefined) delete process.env.TRACEPILOT_SAG_BASE_URL;
  else process.env.TRACEPILOT_SAG_BASE_URL = originalSagBaseUrl;
  if (originalSagToken === undefined) delete process.env.TRACEPILOT_SAG_TOKEN;
  else process.env.TRACEPILOT_SAG_TOKEN = originalSagToken;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function dbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "tracepilot-phase7-sag-api-"));
  directories.push(directory);
  return join(directory, "tracepilot.db");
}

function project(id: string, knowledgeSourceId?: string): Project {
  return {
    id,
    name: `Phase 7 ${id}`,
    repositoryPath: "D:/tracepilot-phase7-synthetic",
    defaultBranch: "main",
    language: "typescript",
    commands: { test: { argv: ["node", "--version"], timeoutMs: 30_000 } },
    ...(knowledgeSourceId ? { knowledgeSourceId } : {}),
    createdAt: "2026-08-13T00:00:00.000Z"
  };
}

function taskInput(): TaskInput {
  return {
    objective: "使用已登记来源补充证据",
    constraints: [],
    acceptanceCriteria: [],
    riskLevel: "low",
    rawSource: "合成 Issue",
    origin: "issue"
  };
}

function document(
  id: string,
  kind: KnowledgeDocument["kind"],
  projectId = "project-a"
): KnowledgeDocument {
  const text = `${kind} ${id} 合成正文`;
  return {
    id,
    projectId,
    kind,
    locator: `docs/${kind}/${id}.md`,
    title: `${kind} ${id}`,
    excerpt: `${kind} 的合成检索摘要`,
    contentHash: hashSagSourceDocument(text)
  };
}

describe("Phase 7 SAG 可选装配", () => {
  it("未配置 SAG 时继续使用 SQLite Repair Memory 基线", async () => {
    const root = buildCompositionRoot({ dbPath: dbPath(), skipEnvFile: true });
    try {
      const response = await root.app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { knowledge: string }).knowledge).toBe("sqlite-memory");
    } finally {
      await root.close();
    }
  });

  it("仅配置 SAG 地址或 token 时失败关闭", () => {
    process.env.TRACEPILOT_SAG_BASE_URL = "http://127.0.0.1:8000/api/v1";
    expect(() => buildCompositionRoot({ dbPath: dbPath(), skipEnvFile: true }))
      .toThrow("SAG 配置不完整");
  });

  it("仅通过显式测试替身启用 SAG 增强模式", async () => {
    const transport: SagMirrorTransport = {
      upsertRepairRecord: async () => undefined,
      searchRepairRecordIds: async () => []
    };
    const root = buildCompositionRoot({
      dbPath: dbPath(),
      skipEnvFile: true,
      sagTransportOverride: transport
    });
    try {
      const response = await root.app.inject({ method: "GET", url: "/health" });
      expect((response.json() as { knowledge: string }).knowledge).toBe("sag-enhanced");
    } finally {
      await root.close();
    }
  });

  it("只有 SQLite 已登记的同项目跨文档来源才能通过 API 进入新的 Evidence Pack", async () => {
    const uploaded: SagSourceDocument[] = [];
    let searchAbortSignal: AbortSignal | undefined;
    const sourceDocuments = [
      document("adr-01", "adr"),
      document("issue-01", "issue"),
      document("pr-01", "pull_request"),
      document("repair-01", "repair_record"),
      document("foreign-01", "adr", "project-b"),
      { ...document("forged-01", "issue"), contentHash: `sha256-${"b".repeat(64)}` }
    ];
    const transport: SagMirrorTransport & SagSourceDocumentTransport = {
      upsertRepairRecord: async () => undefined,
      searchRepairRecordIds: async () => [],
      upsertSourceDocument: async (item) => { uploaded.push(item); },
      searchSourceDocuments: async (input) => {
        searchAbortSignal = input.abortSignal;
        return sourceDocuments;
      }
    };
    const root = buildCompositionRoot({
      dbPath: dbPath(),
      skipEnvFile: true,
      sagTransportOverride: transport
    });
    try {
      await root.store.unitOfWork.run((tx) => tx.projects.save(project("project-a", "source-a")));
      const task = await root.orchestrator.createTask({ projectId: "project-a", input: taskInput() });
      await root.orchestrator.transitionTask(task.id, "INTAKING");
      await root.orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE");
      await root.orchestrator.gatherEvidenceAndCreatePack({
        taskId: task.id,
        packId: "pack-phase7-sag",
        evidence: []
      });

      for (const item of sourceDocuments.slice(0, 4)) {
        const response = await root.app.inject({
          method: "POST",
          url: "/projects/project-a/sag-source-documents",
          payload: {
            id: item.id,
            kind: item.kind,
            locator: item.locator,
            title: item.title,
            text: `${item.title} 合成正文`,
            contentHash: item.contentHash
          }
        });
        expect(response.statusCode, response.body).toBe(201);
      }
      expect(uploaded).toHaveLength(4);

      const evidenceResponse = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/sag-source-evidence`,
        payload: { query: "审批", maxResults: 10 }
      });
      expect(evidenceResponse.statusCode, evidenceResponse.body).toBe(201);
      const body = evidenceResponse.json() as {
        documents: KnowledgeDocument[];
        pack: { version: number; evidence: Array<{ source: string; locator: string }> };
      };
      expect(body.documents.map((item) => item.id)).toEqual(["adr-01", "issue-01", "pr-01", "repair-01"]);
      expect(body.pack.version).toBe(2);
      expect(body.pack.evidence.filter((item) => item.source.startsWith("sag-"))).toHaveLength(4);
      expect(body.pack.evidence.some((item) => item.locator.includes("foreign-01"))).toBe(false);
      expect(body.pack.evidence.some((item) => item.locator.includes("forged-01"))).toBe(false);
      expect(searchAbortSignal).toBeInstanceOf(AbortSignal);
      expect(searchAbortSignal?.aborted).toBe(false);

      const registry = await root.app.inject({ method: "GET", url: "/projects/project-a/sag-source-documents" });
      expect(registry.statusCode).toBe(200);
      expect((registry.json() as { documents: unknown[] }).documents).toHaveLength(4);
    } finally {
      await root.close();
    }
  });

  it("SAG 来源检索拒绝调用方伪造的取消控制对象", async () => {
    const root = buildCompositionRoot({
      dbPath: dbPath(),
      skipEnvFile: true,
      sagTransportOverride: {
        upsertRepairRecord: async () => undefined,
        searchRepairRecordIds: async () => [],
        upsertSourceDocument: async () => undefined,
        searchSourceDocuments: async () => []
      }
    });
    try {
      await root.store.unitOfWork.run((tx) => tx.projects.save(project("project-a", "source-a")));
      const task = await root.orchestrator.createTask({ projectId: "project-a", input: taskInput() });
      await root.orchestrator.transitionTask(task.id, "INTAKING");
      await root.orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE");
      await root.orchestrator.gatherEvidenceAndCreatePack({
        taskId: task.id,
        packId: "pack-phase7-sag-abort",
        evidence: []
      });

      const response = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/sag-source-evidence`,
        payload: { query: "审批", abortSignal: { aborted: false } }
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toEqual({ error: "不接受调用方提供 abortSignal" });
    } finally {
      await root.close();
    }
  });

  it("没有跨文档传输能力时，来源导入和 Pack 升版入口失败关闭", async () => {
    const root = buildCompositionRoot({
      dbPath: dbPath(),
      skipEnvFile: true,
      sagTransportOverride: {
        upsertRepairRecord: async () => undefined,
        searchRepairRecordIds: async () => []
      }
    });
    try {
      await root.store.unitOfWork.run((tx) => tx.projects.save(project("project-a", "source-a")));
      const response = await root.app.inject({
        method: "POST",
        url: "/projects/project-a/sag-source-documents",
        payload: {
          id: "adr-01",
          kind: "adr",
          locator: "docs/adr/ADR-01.md",
          title: "ADR-01",
          text: "正文",
          contentHash: hashSagSourceDocument("正文")
        }
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await root.close();
    }
  });

  it("来源正文的哈希由服务端计算，调用方提供不一致哈希会被拒绝", async () => {
    const transport: SagMirrorTransport & SagSourceDocumentTransport = {
      upsertRepairRecord: async () => undefined,
      searchRepairRecordIds: async () => [],
      upsertSourceDocument: async () => undefined,
      searchSourceDocuments: async () => []
    };
    const root = buildCompositionRoot({
      dbPath: dbPath(),
      skipEnvFile: true,
      sagTransportOverride: transport
    });
    try {
      await root.store.unitOfWork.run((tx) => tx.projects.save(project("project-a", "source-a")));
      const response = await root.app.inject({
        method: "POST",
        url: "/projects/project-a/sag-source-documents",
        payload: {
          id: "adr-hash",
          kind: "adr",
          locator: "docs/adr/hash.md",
          title: "哈希核验",
          text: "实际正文",
          contentHash: `sha256-${"f".repeat(64)}`
        }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: expect.stringContaining("contentHash") });
      expect(root.store.sagSourceDocuments.list("project-a")).toEqual([]);
    } finally {
      await root.close();
    }
  });

  it("同项目同类别与 locator 不允许被不同文档 ID 覆盖", async () => {
    const uploaded: SagSourceDocument[] = [];
    const transport: SagMirrorTransport & SagSourceDocumentTransport = {
      upsertRepairRecord: async () => undefined,
      searchRepairRecordIds: async () => [],
      upsertSourceDocument: async (item) => { uploaded.push(item); },
      searchSourceDocuments: async () => []
    };
    const root = buildCompositionRoot({
      dbPath: dbPath(),
      skipEnvFile: true,
      sagTransportOverride: transport
    });
    try {
      await root.store.unitOfWork.run((tx) => tx.projects.save(project("project-a", "source-a")));
      const first = await root.app.inject({
        method: "POST",
        url: "/projects/project-a/sag-source-documents",
        payload: { id: "adr-01", kind: "adr", locator: "docs/ADR-001.md", title: "ADR 001", text: "第一版正文" }
      });
      expect(first.statusCode).toBe(201);
      const conflict = await root.app.inject({
        method: "POST",
        url: "/projects/project-a/sag-source-documents",
        payload: { id: "adr-02", kind: "adr", locator: "docs/ADR-001.md", title: "ADR 001 新 ID", text: "第二版正文" }
      });
      expect(conflict.statusCode).toBe(409);
      expect(uploaded).toHaveLength(1);
    } finally {
      await root.close();
    }
  });

  it("outbox 重放入口不直接调用 SAG，只能把允许的单条事件恢复为待处理", async () => {
    const transport: SagMirrorTransport = {
      upsertRepairRecord: async () => { throw new Error("重放入口不应直接投递"); },
      searchRepairRecordIds: async () => []
    };
    const root = buildCompositionRoot({
      dbPath: dbPath(),
      skipEnvFile: true,
      sagTransportOverride: transport
    });
    try {
      const missing = await root.app.inject({ method: "POST", url: "/sag-outbox/not-found/replay" });
      expect(missing.statusCode).toBe(409);
      // Fastify 会先拒绝超过默认 URL 长度的路径；使用含控制字符的短 ID
      // 进入应用层，验证 outbox 的 ID 校验不会被路由层行为掩盖。
      const invalid = await root.app.inject({ method: "POST", url: "/sag-outbox/%00/replay" });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await root.close();
    }
  });
});
