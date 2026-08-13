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
const INGEST_READY_TIMEOUT_MS = 90_000;
const INGEST_READY_POLL_MS = 1_000;
const MAX_EXCERPT_LENGTH = 2_000;
const MAX_SOURCE_SEGMENT_LENGTH = 1_024;
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
    await this.ingestAndWait(
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
    const metadata = [
      `tracepilot_document_id=${document.id}`,
      `tracepilot_project_id=${document.projectId}`,
      `tracepilot_document_kind=${document.kind}`,
      `tracepilot_locator=${document.locator}`,
      `tracepilot_content_hash=${document.contentHash}`,
      `tracepilot_title=${document.title}`
    ].join("\n");
    // SAG 会在后台按自身策略切分文本。将完整、可反向验证的元数据附在
    // 每个 TracePilot 受控小段前，确保长 ADR/Issue/PR 的中段命中也不会
    // 因为只有首段带 metadata 而被误认成不可信来源。
    const text = splitSourceTextWithMetadata(metadata, document.text);
    await this.ingestAndWait(
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

  /**
   * SAG 导入是后台任务：HTTP 2xx 只表示已受理，不能代表文档已经进入可
   * 检索索引。返回 READY 才允许上层将来源登记为可回读；处理中必须提供
   * 同一 loopback API 的状态/任务地址，否则失败关闭而不是盲等搜索。
   */
  private async ingestAndWait(path: string, body: unknown, idempotencyKey: string): Promise<void> {
    const accepted = await this.request(path, body, idempotencyKey);
    const receipt = parseIngestReceipt(accepted);
    if (receipt.state === "READY") return;
    if (receipt.state === "FAILED") {
      throw new SagTransportError("http", "本机 SAG 已明确报告导入失败");
    }
    const initialStatusUrl = receipt.statusUrl ?? documentStatusUrl(path, receipt.documentId);
    if (!initialStatusUrl) {
      throw new SagTransportError("malformed_response", "本机 SAG 已受理导入但未返回可轮询的文档或任务状态地址");
    }
    receipt.statusUrl = initialStatusUrl;
    const deadline = Date.now() + INGEST_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(INGEST_READY_POLL_MS);
      const status = parseIngestReceipt(await this.requestStatus(receipt.statusUrl));
      if (status.state === "READY") return;
      if (status.state === "FAILED") {
        throw new SagTransportError("http", "本机 SAG 已明确报告导入失败");
      }
      // 服务可能在处理中返回下一跳 Job 地址；未提供时沿用首次地址。
      receipt.statusUrl = status.statusUrl ?? receipt.statusUrl;
    }
    throw new SagTransportError("timeout", "本机 SAG 导入在 90 秒内未达到可检索状态");
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

  private async requestStatus(value: string): Promise<unknown> {
    const url = validateStatusUrl(value, this.baseUrl);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.options.token}` },
        signal: timeout
      });
    } catch (error) {
      if (timeout.aborted || isTimeoutError(error)) {
        throw new SagTransportError("timeout", "本机 SAG 状态查询在 15 秒内未响应");
      }
      throw new SagTransportError("unavailable", "无法连接本机 SAG 状态查询");
    }
    if (!response.ok) {
      throw new SagTransportError("http", `本机 SAG 状态查询返回 HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new SagTransportError("malformed_response", "本机 SAG 状态查询返回的 JSON 无法解析");
    }
  }
}

type IngestState = "READY" | "PENDING" | "FAILED";

interface IngestReceipt {
  readonly state: IngestState;
  /** SAG 1.5+ DocumentOut 的稳定文档标识，用于受控文档状态轮询。 */
  readonly documentId?: string;
  statusUrl?: string;
}

function parseIngestReceipt(value: unknown): IngestReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SagTransportError("malformed_response", "本机 SAG 导入响应不是对象");
  }
  const record = value as Record<string, unknown>;
  // 有些 SAG 版本以 data 包装文档/任务；保持解析仅限明确字段，不能把任意
  // 响应文本误认成已索引状态。
  const data = objectField(record, "data");
  const nested = [
    record,
    objectField(record, "document"),
    objectField(record, "job"),
    data,
    data && objectField(data, "document"),
    data && objectField(data, "job")
  ]
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const rawStatus = nested
    .map((item) => stringField(item, "status") ?? stringField(item, "state"))
    .find((item): item is string => Boolean(item))
    ?.trim()
    .toUpperCase();
  const statusUrl = nested
    .map((item) => stringField(item, "status_url") ?? stringField(item, "statusUrl") ?? stringField(item, "job_url") ?? stringField(item, "jobUrl"))
    .find((item): item is string => Boolean(item));
  const document = nested.find((item) =>
    Boolean(stringField(item, "id")) && Boolean(stringField(item, "source_id") ?? stringField(item, "sourceId"))
  );
  const documentId = document && stringField(document, "id");
  if (rawStatus && ["READY", "COMPLETED", "INDEXED", "SUCCESS", "SUCCEEDED"].includes(rawStatus)) {
    return { state: "READY", ...(documentId ? { documentId } : {}) };
  }
  if (rawStatus && ["FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(rawStatus)) {
    return { state: "FAILED", ...(documentId ? { documentId } : {}) };
  }
  if (rawStatus && ["PENDING", "QUEUED", "PROCESSING", "RUNNING", "INGESTING", "INDEXING"].includes(rawStatus)) {
    return {
      state: "PENDING",
      ...(statusUrl ? { statusUrl } : {}),
      ...(documentId ? { documentId } : {})
    };
  }
  throw new SagTransportError("malformed_response", "本机 SAG 导入响应缺少可识别的文档或任务状态");
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function validateStatusUrl(value: string, baseUrl: URL): URL {
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    throw new SagTransportError("malformed_response", "本机 SAG 返回的状态地址非法");
  }
  if (url.origin !== baseUrl.origin || !url.pathname.startsWith(baseUrl.pathname)) {
    throw new SagTransportError("malformed_response", "本机 SAG 返回了越出受控 API 根路径的状态地址");
  }
  return url;
}

/**
 * SAG 1.5.x 的 ingest 回执是 DocumentOut：它给出 document id 和状态，但不
 * 给 status_url。只有从本次受控 ingest 路径推导出的同 Source 文档地址才允许
 * 轮询，避免把服务返回的任意 ID 拼成越权请求。
 */
function documentStatusUrl(ingestPath: string, documentId: string | undefined): string | undefined {
  if (!documentId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(documentId)) return undefined;
  const match = /^(sources\/[^/]+)\/documents\/ingest$/.exec(ingestPath);
  return match ? `${match[1]}/documents/${encodeURIComponent(documentId)}` : undefined;
}

function splitSourceTextWithMetadata(metadata: string, source: string): string {
  const segments: string[] = [];
  for (let start = 0; start < source.length; start += MAX_SOURCE_SEGMENT_LENGTH) {
    segments.push(`${metadata}\ntracepilot_segment_offset=${start}\n${source.slice(start, start + MAX_SOURCE_SEGMENT_LENGTH)}`);
  }
  return segments.join("\n\n");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
