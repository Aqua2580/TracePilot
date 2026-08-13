/**
 * 本地 SAG HTTP 传输 —— Phase 7。
 *
 * 只允许访问 loopback 的 SAG API，避免把本地 Repair Memory 意外发送到
 * 远程地址。认证令牌仅作为请求头发送，从不记录到日志或错误消息。
 */

import { createHash } from "node:crypto";
import type {
  KnowledgeDocument,
  KnowledgeDocumentKind,
  MemoryQuery,
  SagMirrorPayload,
  SagMirrorTransport,
  SagSourceDocument,
  SagSourceDocumentSearchInput,
  SagSourceDocumentTransport
} from "@tracepilot/core";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_EXCERPT_LENGTH = 2_000;
const DOCUMENT_KINDS = new Set<KnowledgeDocumentKind>([
  "adr",
  "issue",
  "pull_request",
  "repair_record"
]);

export type SagTransportFailureCode =
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "http"
  | "malformed_response"
  | "invalid_configuration";

export class SagTransportError extends Error {
  constructor(
    readonly code: SagTransportFailureCode,
    message: string
  ) {
    super(`SAG 传输失败：${message}`);
    this.name = "SagTransportError";
  }
}

export interface SagHttpTransportOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

/** 对接 SAG 1.5+ 的本地 source 文档写入与 source-scoped 搜索接口。 */
export class SagHttpTransport implements SagMirrorTransport, SagSourceDocumentTransport {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SagHttpTransportOptions) {
    this.baseUrl = validateLocalSagUrl(options.baseUrl);
    if (options.token.trim().length === 0) {
      throw new SagTransportError("invalid_configuration", "本地 SAG token 不能为空");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async upsertRepairRecord(payload: SagMirrorPayload): Promise<void> {
    validateMirrorPayload(payload);
    const title = `TracePilot Repair Record ${payload.repairRecordId}`;
    const text = [
      `tracepilot_document_id=${payload.repairRecordId}`,
      `tracepilot_repair_record_id=${payload.repairRecordId}`,
      `tracepilot_project_id=${payload.projectId}`,
      "tracepilot_document_kind=repair_record",
      `tracepilot_locator=${payload.sourceLocator}`,
      `tracepilot_content_hash=${payload.contentHash}`,
      `tracepilot_title=${title}`,
      `来源=${payload.sourceLocator}`,
      `症状：${payload.symptom}`,
      // SAG 的分块器可能舍弃文档开头的元数据。把稳定记录 ID 放在症状后，
      // 确保任一可检索正文分块都能被安全地映射回 SQLite 真源记录。
      `tracepilot_repair_record_id=${payload.repairRecordId}`,
      `根因：${payload.rootCause}`,
      `修复：${payload.fixSummary}`,
      // 在正文尾部再次放置完整归属元数据。SAG 若把超长文档分块并只返回
      // 末段，仍有机会被严格校验；无法携带完整元数据的分块宁可被拒绝。
      `tracepilot_document_id=${payload.repairRecordId}`,
      `tracepilot_repair_record_id=${payload.repairRecordId}`,
      `tracepilot_project_id=${payload.projectId}`,
      "tracepilot_document_kind=repair_record",
      `tracepilot_locator=${payload.sourceLocator}`,
      `tracepilot_content_hash=${payload.contentHash}`,
      `tracepilot_title=${title}`
    ].join("\n");
    await this.request(
      `sources/${encodeURIComponent(payload.knowledgeSourceId)}/documents/ingest`,
      {
        title,
        text
      },
      payload.repairRecordId
    );
  }

  async searchRepairRecordIds(input: {
    readonly projectId: string;
    readonly knowledgeSourceId: string;
    readonly query: MemoryQuery;
  }): Promise<readonly string[]> {
    const query = [input.query.symptom, input.query.rootCause].filter(Boolean).join(" ").trim();
    if (!query) return [];
    const records = await this.searchRawDocuments({
      projectId: input.projectId,
      knowledgeSourceId: input.knowledgeSourceId,
      query,
      maxResults: Math.min(input.query.maxResults ?? 10, 20),
      kinds: ["repair_record"]
    });
    return records
      .flatMap((record) => extractMetadataValue(record.excerpt, "tracepilot_repair_record_id"))
      .filter((id): id is string => typeof id === "string")
      .filter((id, index, values) => values.indexOf(id) === index);
  }

  /** 受控导入审查过的 ADR、Issue、PR 或 Repair Record 来源。 */
  async upsertSourceDocument(document: SagSourceDocument): Promise<void> {
    validateSourceDocument(document);
    const text = [
      `tracepilot_document_id=${document.id}`,
      `tracepilot_project_id=${document.projectId}`,
      `tracepilot_document_kind=${document.kind}`,
      `tracepilot_locator=${document.locator}`,
      `tracepilot_content_hash=${document.contentHash}`,
      `tracepilot_title=${document.title}`,
      document.text
    ].join("\n");
    await this.request(
      `sources/${encodeURIComponent(document.knowledgeSourceId)}/documents/ingest`,
      { title: document.title, text },
      document.id
    );
  }

  /**
   * Source-scoped 读取，不信任 SAG 返回的任意字段。只有正文中携带完整
   * TracePilot 元数据、且项目/类别/定位/哈希均合法的命中才能离开 Adapter。
   */
  async searchSourceDocuments(
    input: SagSourceDocumentSearchInput
  ): Promise<readonly KnowledgeDocument[]> {
    return this.searchRawDocuments(input);
  }

  private async searchRawDocuments(
    input: SagSourceDocumentSearchInput
  ): Promise<readonly KnowledgeDocument[]> {
    assertSearchInput(input);
    const response = await this.request(
      `sources/${encodeURIComponent(input.knowledgeSourceId)}/search`,
      { query: input.query, strategy: "vector", top_k: input.maxResults },
      undefined,
      input.abortSignal
    );
    return parseSourceDocuments(response, input);
  }

  private async request(
    path: string,
    body: unknown,
    idempotencyKey?: string,
    callerSignal?: AbortSignal
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = callerSignal
      ? AbortSignal.any([timeout, callerSignal])
      : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": `tracepilot-${idempotencyKey}` } : {})
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (callerSignal?.aborted) {
        throw new SagTransportError("cancelled", "操作者已取消本地 SAG 查询");
      }
      if (timeout.aborted || isTimeoutError(error)) {
        throw new SagTransportError("timeout", "本地服务在 15 秒内未响应");
      }
      throw new SagTransportError("unavailable", "无法连接本地服务");
    }
    if (!response.ok) {
      throw new SagTransportError("http", `本地服务返回 HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new SagTransportError("malformed_response", "本地服务返回的 JSON 无法解析");
    }
  }
}

function validateLocalSagUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SagTransportError("invalid_configuration", "baseUrl 必须是有效的本地 HTTP URL");
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopbackHosts.has(url.hostname)) {
    throw new SagTransportError("invalid_configuration", "只允许配置 loopback 本地 SAG 地址");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function validateSourceDocument(document: SagSourceDocument): void {
  if (!isSafeIdentifier(document.projectId) || !isSafeIdentifier(document.knowledgeSourceId) || !isSafeIdentifier(document.id)) {
    throw new SagTransportError("invalid_configuration", "来源文档缺少项目、Source 或文档 ID");
  }
  if (!DOCUMENT_KINDS.has(document.kind) || !isSafeLocator(document.locator)) {
    throw new SagTransportError("invalid_configuration", "来源文档类别或 locator 非法");
  }
  if (
    !isSafeTitle(document.title) ||
    !document.text.trim() ||
    document.text.length > 128 * 1024 ||
    !isSha256(document.contentHash) ||
    document.contentHash !== hashSagSourceDocument(document.text)
  ) {
    throw new SagTransportError("invalid_configuration", "来源文档标题、正文或内容哈希非法");
  }
}

function validateMirrorPayload(payload: SagMirrorPayload): void {
  if (
    !isSafeIdentifier(payload.projectId) ||
    !isSafeIdentifier(payload.knowledgeSourceId) ||
    !isSafeIdentifier(payload.repairRecordId) ||
    !isSha256(payload.contentHash) ||
    !isSafeLocator(payload.sourceLocator) ||
    payload.symptom.length > 32 * 1024 ||
    payload.rootCause.length > 32 * 1024 ||
    payload.fixSummary.length > 32 * 1024
  ) {
    throw new SagTransportError("invalid_configuration", "Repair Record 镜像字段非法");
  }
}

function assertSearchInput(input: SagSourceDocumentSearchInput): void {
  if (!isSafeIdentifier(input.projectId) || !isSafeIdentifier(input.knowledgeSourceId)) {
    throw new SagTransportError("invalid_configuration", "来源检索缺少项目或 Source ID");
  }
  if (!input.query.trim() || input.query.length > 4_000) {
    throw new SagTransportError("invalid_configuration", "来源检索 query 长度非法");
  }
  if (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 20) {
    throw new SagTransportError("invalid_configuration", "来源检索 maxResults 必须是 1 到 20 的整数");
  }
  if (input.kinds && (input.kinds.length === 0 || input.kinds.some((kind) => !DOCUMENT_KINDS.has(kind)))) {
    throw new SagTransportError("invalid_configuration", "来源检索文档类别非法");
  }
}

function parseSourceDocuments(
  value: unknown,
  input: SagSourceDocumentSearchInput
): readonly KnowledgeDocument[] {
  const candidates = collectObjects(value);
  const seen = new Set<string>();
  const documents: KnowledgeDocument[] = [];
  for (const candidate of candidates) {
    const excerpt = pickExcerpt(candidate);
    if (!excerpt) continue;
    const id = extractMetadataValue(excerpt, "tracepilot_document_id");
    const projectId = extractMetadataValue(excerpt, "tracepilot_project_id");
    const rawKind = extractMetadataValue(excerpt, "tracepilot_document_kind");
    const locator = extractMetadataValue(excerpt, "tracepilot_locator");
    const contentHash = extractMetadataValue(excerpt, "tracepilot_content_hash");
    if (!id || !projectId || !rawKind || !locator || !contentHash) continue;
    if (projectId !== input.projectId || !DOCUMENT_KINDS.has(rawKind as KnowledgeDocumentKind)) continue;
    if (input.kinds && !input.kinds.includes(rawKind as KnowledgeDocumentKind)) continue;
    if (!isSafeLocator(locator) || !isSha256(contentHash) || seen.has(id)) continue;
    seen.add(id);
    const metadataTitle = extractMetadataValue(excerpt, "tracepilot_title");
    const candidateTitle = typeof candidate.title === "string" ? candidate.title.trim() : "";
    const title = metadataTitle && isSafeTitle(metadataTitle)
      ? metadataTitle
      : isSafeTitle(candidateTitle)
        ? candidateTitle
        : `TracePilot ${rawKind} ${id}`;
    documents.push({
      id,
      projectId,
      kind: rawKind as KnowledgeDocumentKind,
      locator,
      title,
      excerpt: excerpt.slice(0, MAX_EXCERPT_LENGTH),
      contentHash
    });
    if (documents.length >= input.maxResults) break;
  }
  return documents;
}

function collectObjects(value: unknown): readonly Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const visit = (current: unknown, depth: number): void => {
    if (depth > 6 || current === null || current === undefined) return;
    if (Array.isArray(current)) {
      for (const child of current.slice(0, 100)) visit(child, depth + 1);
      return;
    }
    if (typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    result.push(record);
    for (const key of ["results", "items", "sections", "data", "chunks", "documents", "content"]) {
      if (key in record) visit(record[key], depth + 1);
    }
  };
  visit(value, 0);
  return result;
}

function pickExcerpt(candidate: Record<string, unknown>): string | undefined {
  for (const key of ["content", "text", "excerpt", "snippet", "page_content"]) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function extractMetadataValue(text: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|\\n)${escapeRegex(key)}=([^\\r\\n]+)`, "m").exec(text);
  return match?.[1]?.trim() || undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSafeLocator(value: string): boolean {
  return value.length > 0 && value.length <= 1_000 && !/[\r\n\0]/.test(value);
}

function isSafeTitle(value: string): boolean {
  return value.trim().length > 0 && value.length <= 500 && !/[\r\n\0]/.test(value);
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isSha256(value: string): boolean {
  return /^sha256-[a-f0-9]{64}$/i.test(value);
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/** 用于测试夹具导入时生成稳定内容哈希；不参与 SQLite 真源的安全判断。 */
export function hashSagSourceDocument(text: string): string {
  return `sha256-${createHash("sha256").update(text).digest("hex")}`;
}
