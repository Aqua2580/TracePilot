/**
 * AgentRun 领域模型 —— 见 IMPLEMENTATION_SPEC §3.1、§7.3。
 *
 * Runtime 事件（RuntimeEvent）先进入内存缓冲区，再按顺序批量追加到
 * `agent_runs` 表。每条 AgentRunRecord 对应一次 flush 落库的批量事件。
 *
 * 截断规则（§7.3）：
 * - `totalBytes`：原始未截断字节数（即使被丢弃也计入）。
 * - `retainedBytes`：实际落库保留的字节数。
 * - `truncated`：是否发生截断。
 * - `contentHash`：原始事件序列的哈希，保证截断后仍可追溯。
 */

import type { RuntimeEvent } from "../ports/adapters.js";

export interface AgentRunRecord {
  readonly id: string;
  readonly taskId: string;
  readonly runId: string;
  /** 产生事件的角色：analyze / develop / review。 */
  readonly role: string;
  readonly events: readonly RuntimeEvent[];
  /** 原始未截断字节数。 */
  readonly totalBytes: number;
  /** 落库保留的字节数。 */
  readonly retainedBytes: number;
  readonly truncated: boolean;
  /** 原始事件序列的哈希，截断后仍可追溯。 */
  readonly contentHash: string;
  readonly startedAt: string;
  readonly endedAt: string;
}
