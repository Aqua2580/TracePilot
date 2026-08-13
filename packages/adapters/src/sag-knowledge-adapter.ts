/**
 * SAG 检索增强 Adapter —— Phase 7。
 *
 * SQLite 先筛选、验证并提供 Repair Record 真源；SAG 只返回同一项目
 * Source 中记录 ID 的排序提示。跨文档材料必须与 SQLite 的受控来源登记
 * 完全匹配，才可作为未验证的 Evidence 候选。任何普通 Repair Memory
 * 检索异常都回退 SQLite 基线，绝不阻塞 MVP。
 */

import type {
  KnowledgeAdapter,
  KnowledgeDocument,
  KnowledgeDocumentQuery,
  KnowledgeDocumentSearchAdapter,
  MemoryQuery,
  RepairRecord,
  SagMirrorTransport,
  SagSourceDocumentTransport
} from "@tracepilot/core";
import { assertKnowledgeDocumentQuery } from "@tracepilot/core";
import {
  SagTransportError,
  type SagTransportFailureCode
} from "./sag-http-transport.js";

export type SagKnowledgeSearchFailureCode =
  | "source_missing"
  | "transport_unavailable"
  | "transport_timeout"
  | "transport_cancelled"
  | "transport_http"
  | "malformed_response"
  | "unsupported_transport"
  | "untrusted_source";

/** 跨文档来源检索的结构化失败，不会被普通 SQLite 基线吞掉。 */
export class SagKnowledgeSearchError extends Error {
  constructor(
    readonly code: SagKnowledgeSearchFailureCode,
    message: string
  ) {
    super(`SAG 来源检索失败：${message}`);
    this.name = "SagKnowledgeSearchError";
  }
}

export interface SagKnowledgeAdapterOptions {
  readonly sqliteMemory: KnowledgeAdapter;
  readonly resolveKnowledgeSourceId: (projectId: string) => Promise<string | undefined>;
  readonly transport: SagMirrorTransport;
  /**
   * 从 SQLite 受控登记中重新核对 SAG 文档。若缺失、跨项目或字段不一致，
   * 该文档绝不能被包装为 Evidence。
   */
  readonly isRegisteredSourceDocument?: (
    projectId: string,
    knowledgeSourceId: string,
    document: KnowledgeDocument
  ) => Promise<boolean>;
}

export class SagKnowledgeAdapter implements KnowledgeAdapter, KnowledgeDocumentSearchAdapter {
  constructor(private readonly options: SagKnowledgeAdapterOptions) {}

  async search(query: MemoryQuery): Promise<RepairRecord[]> {
    // 先取得 SQLite 的完整受控候选。若先按调用方 maxResults 截断，SAG 便无法
    // 将排在截断线之后的同项目已批准记录提升到前 N 条，所谓“排序增强”会失效。
    // 这里不放宽项目、状态或文本过滤，只把最终展示上限延后到排序完成之后。
    const { maxResults: _maxResults, ...unlimitedQuery } = query;
    const sqliteRecords = await this.options.sqliteMemory.search(unlimitedQuery);
    if (sqliteRecords.length < 2) return limitRecords(sqliteRecords, query.maxResults);
    const sourceId = await this.options.resolveKnowledgeSourceId(query.projectId);
    if (!sourceId) return limitRecords(sqliteRecords, query.maxResults);
    try {
      const rankedIds = await this.options.transport.searchRepairRecordIds({
        projectId: query.projectId,
        knowledgeSourceId: sourceId,
        query
      });
      return limitRecords(reorderSqliteRecords(sqliteRecords, rankedIds), query.maxResults);
    } catch {
      // 检索增强失败必须失败关闭到 SQLite 基线，不能中断任务证据收集。
      return limitRecords(sqliteRecords, query.maxResults);
    }
  }

  /**
   * 查询 ADR、Issue、PR 与 Repair Record 的本地 SAG 来源材料。
   *
   * 此方法刻意不回退成 SQLite Repair Record 列表：调用方请求的是跨文档
   * 资料，若 SAG 未绑定、取消、超时或返回畸形数据，必须知道该事实并决定
   * 是否提交 Evidence Gap，而不是把“没有来源”误报为“检索为空”。
   */
  async searchSourceDocuments(
    query: KnowledgeDocumentQuery
  ): Promise<readonly KnowledgeDocument[]> {
    assertKnowledgeDocumentQuery(query);
    const sourceId = await this.options.resolveKnowledgeSourceId(query.projectId);
    if (!sourceId) {
      throw new SagKnowledgeSearchError("source_missing", "项目尚未绑定本地 SAG Source");
    }
    if (!isSagSourceDocumentTransport(this.options.transport)) {
      throw new SagKnowledgeSearchError("unsupported_transport", "当前 SAG 传输不支持来源文档检索");
    }
    let candidates: readonly KnowledgeDocument[];
    try {
      candidates = await this.options.transport.searchSourceDocuments({
        projectId: query.projectId,
        knowledgeSourceId: sourceId,
        query: query.query,
        maxResults: query.maxResults ?? 10,
        kinds: query.kinds,
        abortSignal: query.abortSignal
      });
    } catch (error) {
      throw toSagKnowledgeSearchError(error);
    }

    if (!this.options.isRegisteredSourceDocument) {
      throw new SagKnowledgeSearchError("untrusted_source", "SQLite 未装配 SAG 来源登记校验");
    }
    const verified: KnowledgeDocument[] = [];
    for (const document of candidates) {
      if (document.projectId !== query.projectId) continue;
      if (query.kinds && !query.kinds.includes(document.kind)) continue;
      if (await this.options.isRegisteredSourceDocument(query.projectId, sourceId, document)) {
        verified.push(document);
      }
    }
    return verified;
  }

  async write(record: RepairRecord): Promise<void> {
    // SQLite 仍是唯一写入真源；镜像由 SQLite outbox 在事务提交后处理。
    await this.options.sqliteMemory.write(record);
  }
}

function isSagSourceDocumentTransport(
  transport: SagMirrorTransport
): transport is SagMirrorTransport & SagSourceDocumentTransport {
  return "searchSourceDocuments" in transport &&
    typeof (transport as Partial<SagSourceDocumentTransport>).searchSourceDocuments === "function";
}

function toSagKnowledgeSearchError(error: unknown): SagKnowledgeSearchError {
  if (error instanceof SagKnowledgeSearchError) return error;
  if (error instanceof SagTransportError) {
    return new SagKnowledgeSearchError(mapTransportCode(error.code), publicMessage(error.code));
  }
  return new SagKnowledgeSearchError("transport_unavailable", "本地 SAG 服务不可用");
}

function mapTransportCode(code: SagTransportFailureCode): SagKnowledgeSearchFailureCode {
  switch (code) {
    case "timeout": return "transport_timeout";
    case "cancelled": return "transport_cancelled";
    case "http": return "transport_http";
    case "malformed_response": return "malformed_response";
    case "invalid_configuration": return "unsupported_transport";
    case "unavailable": return "transport_unavailable";
  }
}

function publicMessage(code: SagTransportFailureCode): string {
  switch (code) {
    case "timeout": return "本地 SAG 检索超时";
    case "cancelled": return "本地 SAG 检索已取消";
    case "http": return "本地 SAG 返回失败状态";
    case "malformed_response": return "本地 SAG 返回畸形响应";
    case "invalid_configuration": return "本地 SAG 配置无效";
    case "unavailable": return "本地 SAG 服务不可用";
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

function limitRecords(records: readonly RepairRecord[], maxResults: number | undefined): RepairRecord[] {
  const limit = maxResults ?? 10;
  return limit > 0 ? records.slice(0, limit) : [];
}
