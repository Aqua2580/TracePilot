/**
 * 本地 SAG HTTP 传输 —— Phase 7。
 *
 * 只允许访问 loopback 的 SAG API，避免把本地 Repair Memory 意外发送到
 * 远程地址。认证令牌仅作为请求头发送，从不记录到日志或错误消息。
 */

import type { MemoryQuery, SagMirrorPayload, SagMirrorTransport } from "@tracepilot/core";

export class SagTransportError extends Error {
  constructor(message: string) {
    super(`SAG 传输失败：${message}`);
    this.name = "SagTransportError";
  }
}

export interface SagHttpTransportOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

/** 对接 SAG v2 的本地 source 文档写入与 source-scoped 搜索接口。 */
export class SagHttpTransport implements SagMirrorTransport {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SagHttpTransportOptions) {
    this.baseUrl = validateLocalSagUrl(options.baseUrl);
    if (options.token.trim().length === 0) {
      throw new SagTransportError("本地 SAG token 不能为空");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async upsertRepairRecord(payload: SagMirrorPayload): Promise<void> {
    const text = [
      `tracepilot_repair_record_id=${payload.repairRecordId}`,
      `tracepilot_project_id=${payload.projectId}`,
      `来源=${payload.sourceLocator}`,
      `症状：${payload.symptom}`,
      `根因：${payload.rootCause}`,
      `修复：${payload.fixSummary}`
    ].join("\n");
    await this.request(
      `sources/${encodeURIComponent(payload.knowledgeSourceId)}/documents/ingest`,
      {
        title: `TracePilot Repair Record ${payload.repairRecordId}`,
        text
      },
      payload.repairRecordId
    );
  }

  async searchRepairRecordIds(input: {
    readonly knowledgeSourceId: string;
    readonly query: MemoryQuery;
  }): Promise<readonly string[]> {
    const query = [input.query.symptom, input.query.rootCause].filter(Boolean).join(" ").trim();
    if (!query) return [];
    const response = await this.request(
      `sources/${encodeURIComponent(input.knowledgeSourceId)}/search`,
      { query, strategy: "vector", top_k: input.query.maxResults ?? 10 }
    );
    return extractRepairRecordIds(response);
  }

  private async request(path: string, body: unknown, idempotencyKey?: string): Promise<unknown> {
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
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SagTransportError(`无法连接本地服务：${message}`);
    }
    if (!response.ok) {
      throw new SagTransportError(`本地服务返回 HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
}

function validateLocalSagUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SagTransportError("baseUrl 必须是有效的本地 HTTP URL");
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopbackHosts.has(url.hostname)) {
    throw new SagTransportError("只允许配置 loopback 本地 SAG 地址");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function extractRepairRecordIds(value: unknown): string[] {
  const serialized = JSON.stringify(value);
  return [...serialized.matchAll(/tracepilot_repair_record_id=([A-Za-z0-9_-]+)/g)]
    .map((match) => match[1])
    .filter((id): id is string => Boolean(id));
}
