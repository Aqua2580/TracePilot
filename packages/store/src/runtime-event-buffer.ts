/**
 * RuntimeEventBuffer —— Runtime 事件内存缓冲 + 批量落库 + 截断。
 *
 * 见 IMPLEMENTATION_SPEC §3.1、§7.3 与 P1-03。
 *
 * 职责：
 * - Runtime 事件先进入按 (taskId, runId) 分组的内存缓冲区（§3.1）。
 * - flush 时通过 UnitOfWork 单写入队列批量追加到 `agent_runs` 表，
 *   与任务/审计事务串行化，避免 SQLite 写锁竞争。
 * - 单条事件 message/summary 超过 `maxEventBytes` 时截断（单条输出上限）。
 * - 单次落库保留字节超过 `maxRetainedBytes` 时从尾部保留可读尾部并标记
 *   truncated=true，同时记录原始事件序列的 contentHash 以便追溯（§7.3）。
 *
 * 不变式：
 * - 缓冲区仅在内存；flush 失败时已落库的审计不受影响，缓冲区清空策略
 *   由调用方决定（本实现：flush 失败保留缓冲区，便于重试）。
 * - 事件顺序严格按 append 顺序保持。
 */

import type {
  UnitOfWork,
  RuntimeEvent,
  AgentRunRecord
} from "@tracepilot/core";

/** 缓冲区条目：按 (taskId, runId) 分组。 */
interface BufferEntry {
  readonly taskId: string;
  readonly runId: string;
  readonly role: string;
  /** 已做单条截断的事件序列。 */
  readonly events: RuntimeEvent[];
  /** 原始未截断字节数（按 JSON 序列化计算）。 */
  originalBytes: number;
  /** 第一条事件的 at，作为 startedAt。 */
  startedAt: string;
}

export interface RuntimeEventBufferDeps {
  readonly unitOfWork: UnitOfWork;
  /** 单条事件 message/summary 的最大字节数；超出截断。默认 64 KiB。 */
  readonly maxEventBytes?: number;
  /** 单次 flush 落库保留的最大字节数；超出整体截断保留尾部。默认 256 KiB。 */
  readonly maxRetainedBytes?: number;
}

const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;
const DEFAULT_MAX_RETAINED_BYTES = 256 * 1024;
/** 截断标记后缀，便于追溯被截断的单条输出。 */
const TRUNCATION_SUFFIX = "\n[truncated]";

export class RuntimeEventBuffer {
  private readonly unitOfWork: UnitOfWork;
  private readonly maxEventBytes: number;
  private readonly maxRetainedBytes: number;
  private readonly buffer = new Map<string, BufferEntry>();

  constructor(deps: RuntimeEventBufferDeps) {
    this.unitOfWork = deps.unitOfWork;
    this.maxEventBytes = deps.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
    this.maxRetainedBytes = deps.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES;
  }

  /** 缓冲区中尚未 flush 的条目数（按 (taskId, runId) 计）。 */
  pendingCount(): number {
    return this.buffer.size;
  }

  /**
   * 追加一条事件到缓冲区。
   *
   * 单条截断：若 event 含 message 或 summary 字段且超过 maxEventBytes，
   * 截断该字段并追加 TRUNCATION_SUFFIX。原始字节数按截断前的 event 计算。
   */
  append(taskId: string, runId: string, role: string, event: RuntimeEvent): void {
    const key = bufferKey(taskId, runId);
    const originalBytes = byteLength(event);
    const truncatedEvent = truncateSingleEvent(event, this.maxEventBytes);

    const existing = this.buffer.get(key);
    if (!existing) {
      this.buffer.set(key, {
        taskId,
        runId,
        role,
        events: [truncatedEvent],
        originalBytes,
        startedAt: event.at
      });
      return;
    }
    existing.events.push(truncatedEvent);
    existing.originalBytes += originalBytes;
  }

  /**
   * 把指定 (taskId, runId) 的缓冲区落库。
   *
   * 应用总量截断：若保留字节超过 maxRetainedBytes，从尾部保留尽可能多
   * 的完整事件，并标记 truncated=true。contentHash 基于截断前的完整事件
   * 序列计算，保证截断后仍可追溯。
   *
   * flush 失败时缓冲区保留，调用方可重试。成功后清空对应缓冲区条目。
   */
  async flush(taskId: string, runId: string): Promise<AgentRunRecord | undefined> {
    const key = bufferKey(taskId, runId);
    const entry = this.buffer.get(key);
    if (!entry) return undefined;

    const record = this.buildRecord(entry);
    await this.unitOfWork.run(async (tx) => {
      await tx.agentRuns.save(record);
    });
    // 落库成功后清空缓冲区。
    this.buffer.delete(key);
    return record;
  }

  /** 把所有未 flush 的缓冲区依次落库（按插入顺序）。 */
  async flushAll(): Promise<AgentRunRecord[]> {
    const keys = [...this.buffer.keys()];
    const records: AgentRunRecord[] = [];
    for (const key of keys) {
      const entry = this.buffer.get(key);
      if (!entry) continue;
      const record = this.buildRecord(entry);
      await this.unitOfWork.run(async (tx) => {
        await tx.agentRuns.save(record);
      });
      this.buffer.delete(key);
      records.push(record);
    }
    return records;
  }

  private buildRecord(entry: BufferEntry): AgentRunRecord {
    const totalBytes = entry.originalBytes;
    const lastEvent = entry.events[entry.events.length - 1];
    const endedAt = lastEvent?.at ?? entry.startedAt;

    // 计算保留候选（未做总量截断的 events 序列化字节）。
    const retainedCandidateBytes = entry.events.reduce(
      (sum, e) => sum + byteLength(e),
      0
    );

    let retainedEvents: readonly RuntimeEvent[];
    let retainedBytes: number;
    let truncated: boolean;

    if (retainedCandidateBytes <= this.maxRetainedBytes) {
      retainedEvents = entry.events;
      retainedBytes = retainedCandidateBytes;
      truncated = false;
    } else {
      // 总量超限：从尾部保留尽可能多的完整事件。
      const kept: RuntimeEvent[] = [];
      let keptBytes = 0;
      for (let i = entry.events.length - 1; i >= 0; i--) {
        const ev = entry.events[i]!;
        const evBytes = byteLength(ev);
        if (keptBytes + evBytes > this.maxRetainedBytes) break;
        kept.unshift(ev);
        keptBytes += evBytes;
      }
      retainedEvents = kept;
      retainedBytes = keptBytes;
      truncated = true;
    }

    return {
      id: `run_${entry.runId}_${entry.startedAt.replace(/[^0-9a-zA-Z]/g, "")}`,
      taskId: entry.taskId,
      runId: entry.runId,
      role: entry.role,
      events: retainedEvents,
      totalBytes,
      retainedBytes,
      truncated,
      contentHash: hashEvents(entry.events),
      startedAt: entry.startedAt,
      endedAt
    };
  }
}

function bufferKey(taskId: string, runId: string): string {
  return `${taskId}::${runId}`;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * 单条事件截断：对 message / summary 字段应用 maxBytes 上限。
 *
 * 其余字段（at、runId、taskId、exitCode、bytes 等）不截断 —— 它们体积小
 * 且为结构化数据。仅文本类输出字段可能膨胀。
 */
function truncateSingleEvent(event: RuntimeEvent, maxBytes: number): RuntimeEvent {
  if (event.type === "progress" || event.type === "error") {
    const truncatedMessage = truncateText(event.message, maxBytes);
    if (truncatedMessage === event.message) return event;
    return { ...event, message: truncatedMessage } as RuntimeEvent;
  }
  if (event.type === "completed") {
    const truncatedSummary = truncateText(event.summary, maxBytes);
    if (truncatedSummary === event.summary) return event;
    return { ...event, summary: truncatedSummary } as RuntimeEvent;
  }
  return event;
}

function truncateText(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  // 按字节截断，再追加标记。Slice 按字符近似，再用 Buffer 精修到上限内。
  const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8"));
  const buf = Buffer.from(text, "utf8");
  const sliced = buf.subarray(0, budget).toString("utf8");
  return sliced + TRUNCATION_SUFFIX;
}

/**
 * 事件序列哈希（FNV-1a 32-bit）。与 core 的 computePackContentHash 同算法，
 * 用于截断后追溯原始事件序列。
 */
function hashEvents(events: readonly RuntimeEvent[]): string {
  const canonical = JSON.stringify(events);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `runhash-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
