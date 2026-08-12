/** Phase 7 SAG 检索增强测试：SQLite 真源、项目隔离与网络失败回退。 */

import { describe, expect, it } from "vitest";
import {
  FakeKnowledgeAdapter,
  SagHttpTransport,
  SagKnowledgeAdapter,
  SagTransportError
} from "../src/index.js";
import type { RepairRecord, SagMirrorTransport } from "@tracepilot/core";

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
});

describe("SagHttpTransport", () => {
  it("拒绝非 loopback 地址，避免向远程端点发送本地 Repair Memory", () => {
    expect(() => new SagHttpTransport({ baseUrl: "https://example.com/api/v1", token: "token" }))
      .toThrow(SagTransportError);
  });
});
