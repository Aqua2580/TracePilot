/** Phase 7 SAG 检索增强测试：SQLite 真源、项目隔离与网络失败回退。 */

import { describe, expect, it } from "vitest";
import {
  FakeKnowledgeAdapter,
  hashSagSourceDocument,
  SagHttpTransport,
  SagKnowledgeAdapter,
  SagKnowledgeSearchError,
  SagTransportError
} from "../src/index.js";
import type {
  KnowledgeDocument,
  RepairRecord,
  SagMirrorTransport,
  SagSourceDocumentTransport
} from "@tracepilot/core";

function sourceDocument(
  id: string,
  kind: KnowledgeDocument["kind"],
  projectId = "project-a",
  contentHash = `sha256-${"a".repeat(64)}`
): KnowledgeDocument {
  return {
    id,
    projectId,
    kind,
    locator: `${kind}:${id}`,
    title: `${kind} ${id}`,
    excerpt: `${kind} 来源 ${id}`,
    contentHash
  };
}

function record(id: string, projectId: string, symptom: string): RepairRecord {
  return {
    id,
    projectId,
    taskId: `task-${id}`,
    status: "APPROVED",
    symptom,
    rootCause: "缺少配置",
    rootCauseConfidence: 0.9,
    rootCauseEvidenceIds: ["evidence-1"],
    fixSummary: "补齐配置",
    applicabilityConditions: [],
    applicabilityConditionEvidence: [],
    failureReasons: [],
    inputEvidencePackId: `pack-${id}`,
    inputEvidencePackVersion: 1,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z"
  };
}

describe("SagKnowledgeAdapter", () => {
  it("只以同项目 SQLite 记录为真源，SAG 只能调整其中记录的排序", async () => {
    const sqlite = new FakeKnowledgeAdapter();
    const first = record("repair-a", "project-a", "构建失败");
    const second = record("repair-b", "project-a", "测试失败");
    const otherProject = record("repair-c", "project-b", "构建失败");
    sqlite.seed([first, second, otherProject]);
    const transport: SagMirrorTransport = {
      upsertRepairRecord: async () => undefined,
      searchRepairRecordIds: async () => ["repair-b", "repair-c", "unknown", "repair-b"]
    };
    const adapter = new SagKnowledgeAdapter({
      sqliteMemory: sqlite,
      resolveKnowledgeSourceId: async (projectId) => projectId === "project-a" ? "source-a" : undefined,
      transport
    });

    await expect(adapter.search({ projectId: "project-a" })).resolves.toMatchObject([
      { id: "repair-b", projectId: "project-a" },
      { id: "repair-a", projectId: "project-a" }
    ]);
  });

  it("SAG 搜索异常时无声回退到 SQLite 基线", async () => {
    const sqlite = new FakeKnowledgeAdapter();
    const item = record("repair-a", "project-a", "构建失败");
    sqlite.seed([item]);
    const adapter = new SagKnowledgeAdapter({
      sqliteMemory: sqlite,
      resolveKnowledgeSourceId: async () => "source-a",
      transport: {
        upsertRepairRecord: async () => undefined,
        searchRepairRecordIds: async () => { throw new Error("SAG 离线"); }
      }
    });
    await expect(adapter.search({ projectId: "project-a" })).resolves.toEqual([item]);
  });

  it("SAG 在 SQLite 最终上限截断前重排完整同项目候选", async () => {
    const sqlite = new FakeKnowledgeAdapter();
    const records = Array.from({ length: 6 }, (_, index) => record(
      `repair-${index + 1}`,
      "project-a",
      "同一症状"
    ));
    sqlite.seed(records);
    const adapter = new SagKnowledgeAdapter({
      sqliteMemory: sqlite,
      resolveKnowledgeSourceId: async () => "source-a",
      transport: {
        upsertRepairRecord: async () => undefined,
        searchRepairRecordIds: async () => ["repair-6"]
      }
    });

    const results = await adapter.search({ projectId: "project-a", symptom: "同一症状", maxResults: 5 });
    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({ id: "repair-6" });
  });

  it("跨文档搜索只接受 SQLite 已登记的同项目 ADR、Issue、PR 与 Repair Record", async () => {
    const candidates = [
      sourceDocument("adr-1", "adr"),
      sourceDocument("issue-1", "issue"),
      sourceDocument("pr-1", "pull_request"),
      sourceDocument("repair-1", "repair_record"),
      sourceDocument("foreign-1", "adr", "project-b"),
      sourceDocument("forged-1", "issue", "project-a", `sha256-${"b".repeat(64)}`)
    ];
    const transport: SagMirrorTransport & SagSourceDocumentTransport = {
      upsertRepairRecord: async () => undefined,
      searchRepairRecordIds: async () => [],
      upsertSourceDocument: async () => undefined,
      searchSourceDocuments: async () => candidates
    };
    const registered = new Set(candidates.slice(0, 4).map((document) =>
      `${document.id}:${document.contentHash}`
    ));
    const adapter = new SagKnowledgeAdapter({
      sqliteMemory: new FakeKnowledgeAdapter(),
      resolveKnowledgeSourceId: async () => "source-a",
      transport,
      isRegisteredSourceDocument: async (projectId, sourceId, document) =>
        projectId === "project-a" && sourceId === "source-a" &&
        registered.has(`${document.id}:${document.contentHash}`)
    });

    await expect(adapter.searchSourceDocuments({
      projectId: "project-a",
      query: "认证异常",
      maxResults: 10
    })).resolves.toEqual(candidates.slice(0, 4));
  });

  it("跨文档搜索没有 Source 或传输失败时返回结构化错误，不伪造 SQLite 命中", async () => {
    const sqlite = new FakeKnowledgeAdapter();
    const withoutSource = new SagKnowledgeAdapter({
      sqliteMemory: sqlite,
      resolveKnowledgeSourceId: async () => undefined,
      transport: {
        upsertRepairRecord: async () => undefined,
        searchRepairRecordIds: async () => []
      }
    });
    await expect(withoutSource.searchSourceDocuments({ projectId: "project-a", query: "x" }))
      .rejects.toMatchObject({ code: "source_missing" } satisfies Partial<SagKnowledgeSearchError>);

    const unavailable: SagMirrorTransport & SagSourceDocumentTransport = {
      upsertRepairRecord: async () => undefined,
      searchRepairRecordIds: async () => [],
      upsertSourceDocument: async () => undefined,
      searchSourceDocuments: async () => {
        throw new SagTransportError("timeout", "不应泄露地址或令牌");
      }
    };
    const adapter = new SagKnowledgeAdapter({
      sqliteMemory: sqlite,
      resolveKnowledgeSourceId: async () => "source-a",
      transport: unavailable,
      isRegisteredSourceDocument: async () => true
    });
    await expect(adapter.searchSourceDocuments({ projectId: "project-a", query: "x" }))
      .rejects.toMatchObject({ code: "transport_timeout" } satisfies Partial<SagKnowledgeSearchError>);
  });
});

describe("SagHttpTransport", () => {
  it("拒绝非 loopback 地址，避免向远程端点发送本地 Repair Memory", () => {
    expect(() => new SagHttpTransport({ baseUrl: "https://example.com/api/v1", token: "token" }))
      .toThrow(SagTransportError);
  });

  it("把 Repair Record ID 重复写入可检索正文，兼容 SAG 分块丢失首段元数据", async () => {
    let capturedBody: unknown;
    const transport = new SagHttpTransport({
      baseUrl: "http://127.0.0.1:8000/api/v1",
      token: "synthetic-token",
      fetchImpl: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ document: { id: "document-1", status: "READY" } }), { status: 200 });
      }
    });

    await transport.upsertRepairRecord({
      schemaVersion: 1,
      projectId: "project-a",
      knowledgeSourceId: "source-a",
      repairRecordId: "repair-a",
      contentHash: `sha256-${"a".repeat(64)}`,
      symptom: "构建失败",
      rootCause: "依赖缺失",
      fixSummary: "补齐依赖",
      sourceLocator: "synthetic/repair-a"
    });

    expect(capturedBody).toMatchObject({
      text: expect.stringContaining("症状：构建失败\ntracepilot_repair_record_id=repair-a")
    });
    expect(capturedBody).toMatchObject({
      text: expect.stringContaining("tracepilot_title=TracePilot Repair Record repair-a")
    });
  });

  it("跨文档搜索只解析带完整 TracePilot 元数据的同项目来源", async () => {
    const document = [
      "tracepilot_document_id=adr-1",
      "tracepilot_project_id=project-a",
      "tracepilot_document_kind=adr",
      "tracepilot_locator=docs/adr/ADR-001.md",
      `tracepilot_content_hash=sha256-${"c".repeat(64)}`,
      "tracepilot_title=ADR-001",
      "内容：审批边界"
    ].join("\n");
    const transport = new SagHttpTransport({
      baseUrl: "http://127.0.0.1:8000/api/v1",
      token: "synthetic-token",
      fetchImpl: async () => new Response(JSON.stringify({
        results: [
          { title: "ADR-001", content: document },
          { title: "跨项目伪造", content: document.replace("project-a", "project-b") },
          { title: "缺少哈希", content: document.replace(/^tracepilot_content_hash=.*\n/m, "") }
        ]
      }), { status: 200 })
    });

    await expect(transport.searchSourceDocuments({
      projectId: "project-a",
      knowledgeSourceId: "source-a",
      query: "审批",
      maxResults: 5
    })).resolves.toEqual([
      expect.objectContaining({
        id: "adr-1",
        projectId: "project-a",
        kind: "adr",
        locator: "docs/adr/ADR-001.md"
      })
    ]);
  });

  it("拒绝正文哈希不一致的来源导入，且请求不会发往本机 SAG", async () => {
    let requests = 0;
    const transport = new SagHttpTransport({
      baseUrl: "http://127.0.0.1:8000/api/v1",
      token: "synthetic-token",
      fetchImpl: async () => {
        requests += 1;
        return new Response(JSON.stringify({}), { status: 200 });
      }
    });
    await expect(transport.upsertSourceDocument({
      schemaVersion: 1,
      projectId: "project-a",
      knowledgeSourceId: "source-a",
      id: "adr-1",
      kind: "adr",
      locator: "docs/adr/ADR-001.md",
      title: "ADR-001",
      text: "实际正文",
      contentHash: hashSagSourceDocument("不同正文")
    })).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(requests).toBe(0);
  });

  it("导入仅在本机 SAG 文档状态 READY 后成功，并保持长文档每段的反向校验元数据", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const longText = "长文档正文。".repeat(600);
    const transport = new SagHttpTransport({
      baseUrl: "http://127.0.0.1:8000/api/v1",
      token: "synthetic-token",
      fetchImpl: async (input, init) => {
        calls.push({ method: init?.method ?? "GET", url: String(input), body: init?.body });
        if ((init?.method ?? "GET") === "POST") {
          return new Response(JSON.stringify({
            document: { status: "PROCESSING", status_url: "documents/document-1/status" }
          }), { status: 202 });
        }
        return new Response(JSON.stringify({ document: { status: "READY" } }), { status: 200 });
      }
    });

    await transport.upsertSourceDocument({
      schemaVersion: 1,
      projectId: "project-a",
      knowledgeSourceId: "source-a",
      id: "adr-long-1",
      kind: "adr",
      locator: "docs/adr/ADR-long.md",
      title: "长 ADR",
      text: longText,
      contentHash: hashSagSourceDocument(longText)
    });

    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
    const body = calls[0]!.body as string;
    expect(body.match(/tracepilot_document_id=adr-long-1/g)?.length).toBeGreaterThan(1);
    expect(body.match(/tracepilot_content_hash=sha256-/g)?.length).toBeGreaterThan(1);
  });

  it("SAG 导入未提供可检查状态时失败关闭，不能把 HTTP 已受理视为可检索", async () => {
    const transport = new SagHttpTransport({
      baseUrl: "http://127.0.0.1:8000/api/v1",
      token: "synthetic-token",
      fetchImpl: async () => new Response(JSON.stringify({ id: "document-1" }), { status: 202 })
    });
    await expect(transport.upsertRepairRecord({
      schemaVersion: 1,
      projectId: "project-a",
      knowledgeSourceId: "source-a",
      repairRecordId: "repair-a",
      contentHash: `sha256-${"a".repeat(64)}`,
      symptom: "构建失败",
      rootCause: "依赖缺失",
      fixSummary: "补齐依赖",
      sourceLocator: "synthetic/repair-a"
    })).rejects.toMatchObject({ code: "malformed_response" } satisfies Partial<SagTransportError>);
  });

  it("SAG 1.5 DocumentOut 回执按受控 Source 和文档 ID 轮询至 ready", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const transport = new SagHttpTransport({
      baseUrl: "http://127.0.0.1:8000/api/v1",
      token: "synthetic-token",
      fetchImpl: async (input, init) => {
        calls.push({ method: init?.method ?? "GET", url: String(input) });
        if (init?.method === "POST") {
          return new Response(JSON.stringify({
            id: "document-1", source_id: "source-a", status: "extracting"
          }), { status: 201 });
        }
        return new Response(JSON.stringify({
          id: "document-1", source_id: "source-a", status: "ready"
        }), { status: 200 });
      }
    });

    await transport.upsertSourceDocument({
      schemaVersion: 1,
      projectId: "project-a",
      knowledgeSourceId: "source-a",
      id: "adr-document-out-1",
      kind: "adr",
      locator: "docs/adr/document-out.md",
      title: "DocumentOut 回执",
      text: "合成内容",
      contentHash: hashSagSourceDocument("合成内容")
    });

    expect(calls).toEqual([
      { method: "POST", url: "http://127.0.0.1:8000/api/v1/sources/source-a/documents/ingest" },
      { method: "GET", url: "http://127.0.0.1:8000/api/v1/sources/source-a/documents/document-1" }
    ]);
  });

  it("SAG 状态查询接受受控 data 包装，但仍必须达到 READY", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const transport = new SagHttpTransport({
      baseUrl: "http://127.0.0.1:8000/api/v1",
      token: "synthetic-token",
      fetchImpl: async (input, init) => {
        calls.push({ method: init?.method ?? "GET", url: String(input) });
        if (init?.method === "POST") {
          return new Response(JSON.stringify({
            data: { status: "PROCESSING", job_url: "jobs/job-1" }
          }), { status: 202 });
        }
        return new Response(JSON.stringify({ data: { job: { status: "INDEXED" } } }), { status: 200 });
      }
    });

    await transport.upsertSourceDocument({
      id: "adr-data-1",
      projectId: "project-1",
      knowledgeSourceId: "source-1",
      kind: "adr",
      locator: "docs/adr/data.md",
      title: "Data 包装",
      text: "合成内容",
      contentHash: hashSagSourceDocument("合成内容")
    });

    expect(calls).toEqual([
      { method: "POST", url: "http://127.0.0.1:8000/api/v1/sources/source-1/documents/ingest" },
      { method: "GET", url: "http://127.0.0.1:8000/api/v1/jobs/job-1" }
    ]);
  });

  it("调用方取消来源检索时返回取消错误，不把请求误报为离线", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = new SagHttpTransport({
      baseUrl: "http://127.0.0.1:8000/api/v1",
      token: "synthetic-token",
      fetchImpl: async (_input, init) => {
        expect(init?.signal?.aborted).toBe(true);
        throw new DOMException("已取消", "AbortError");
      }
    });

    await expect(transport.searchSourceDocuments({
      projectId: "project-a",
      knowledgeSourceId: "source-a",
      query: "审批",
      maxResults: 5,
      abortSignal: controller.signal
    })).rejects.toMatchObject({ code: "cancelled" } satisfies Partial<SagTransportError>);
  });

  it("本机 SAG 返回非 JSON 时失败关闭，不接受不完整检索结果", async () => {
    const transport = new SagHttpTransport({
      baseUrl: "http://127.0.0.1:8000/api/v1",
      token: "synthetic-token",
      fetchImpl: async () => new Response("这不是 JSON", { status: 200 })
    });

    await expect(transport.searchSourceDocuments({
      projectId: "project-a",
      knowledgeSourceId: "source-a",
      query: "审批",
      maxResults: 5
    })).rejects.toMatchObject({ code: "malformed_response" } satisfies Partial<SagTransportError>);
  });
});
