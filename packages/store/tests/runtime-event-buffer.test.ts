/**
 * RuntimeEventBuffer 边界与失败语义集成测试 —— P1-03 关闭条件。
 *
 * 见 PHASE-2-ACCEPTANCE-REVIEW.md P1-03 与 IMPLEMENTATION_SPEC §3.1、§7.3。
 *
 * 覆盖五类边界：
 * 1. 单条大输出截断：progress/completed 的 message/summary 超过 maxEventBytes
 * 2. 总量超限时尾部保留：retainedBytes 不超过 maxRetainedBytes，truncated=true
 * 3. append 顺序保持：落库后事件顺序与 append 顺序一致
 * 4. flush 写入失败后缓冲可重试且既有审计不受影响
 * 5. 已落库事件在重新打开数据库后可查询
 *
 * 所有测试使用真实 SQLite Store，不 mock 原生依赖。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSqliteStore,
  RuntimeEventBuffer,
  type SqliteStore
} from "../src/index.js";
import {
  TaskOrchestrator,
  type RuntimeEvent,
  type Project,
  type UnitOfWork,
  type TransactionalRepos
} from "@tracepilot/core";

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-reb-"));
  return join(dir, "test.db");
}

function safeCleanup(dbPath: string): void {
  const dir = join(dbPath, "..");
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const buf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buf, 0, 0, 200);
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略
  }
}

function sampleProject(id = "proj-1"): Project {
  return {
    id,
    name: "测试项目",
    repositoryPath: "D:/fake-repo",
    defaultBranch: "main",
    language: "python",
    commands: {
      test: { argv: ["pytest"], timeoutMs: 30000 }
    },
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

async function seedProject(store: SqliteStore): Promise<string> {
  await store.unitOfWork.run(async (tx) => {
    await tx.projects.save(sampleProject());
  });
  const orch = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
  const task = await orch.createTask({
    projectId: "proj-1",
    input: {
      objective: "测试目标",
      constraints: [],
      acceptanceCriteria: ["通过"],
      riskLevel: "low",
      rawSource: "raw",
      origin: "failed_test_log"
    }
  });
  return task.id;
}

/** 构造 started 事件。 */
function startedEvent(runId: string, at: string): RuntimeEvent {
  return { type: "started", runId, taskId: "task-1", at };
}

/** 构造 progress 事件。 */
function progressEvent(runId: string, message: string, at: string): RuntimeEvent {
  return { type: "progress", runId, message, at };
}

/** 构造 completed 事件。 */
function completedEvent(runId: string, summary: string, at: string): RuntimeEvent {
  return { type: "completed", runId, at, summary };
}

/** 生成指定字节数的文本（UTF-8 近似）。 */
function makeText(bytes: number): string {
  return "x".repeat(bytes);
}

/**
 * 可切换的 UnitOfWork 包装器：包装真实 store 的 UnitOfWork，但可通过
 * `failWith` / `recover` 在运行时切换是否抛错。
 *
 * 用于验证同一个 RuntimeEventBuffer 在 flush 失败后缓冲区保留，依赖恢复后
 * 同一实例重试成功落库原事件序列。
 */
class SwitchableUnitOfWork implements UnitOfWork {
  private error: Error | undefined;
  constructor(private readonly inner: UnitOfWork) {}

  /** 进入失败模式：后续 run 调用抛指定错误。 */
  failWith(err: Error): void {
    this.error = err;
  }

  /** 恢复正常：后续 run 调用转发到内部真实 UnitOfWork。 */
  recover(): void {
    this.error = undefined;
  }

  async run<T>(fn: (tx: TransactionalRepos) => Promise<T>): Promise<T> {
    if (this.error) throw this.error;
    return this.inner.run(fn);
  }
}

// ---------------------------------------------------------------------------
// 1. 单条大输出截断
// ---------------------------------------------------------------------------

describe("RuntimeEventBuffer 单条大输出截断", () => {
  let dbPath: string;
  let store: SqliteStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = createSqliteStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    safeCleanup(dbPath);
  });

  it("progress message 超过 maxEventBytes 时被截断，并追加 [truncated] 标记", async () => {
    const taskId = await seedProject(store);
    const maxEventBytes = 100;
    const buffer = new RuntimeEventBuffer({
      unitOfWork: store.unitOfWork,
      maxEventBytes
    });

    const longMessage = makeText(500);
    buffer.append(taskId, "run-1", "analyze", startedEvent("run-1", "2026-01-01T00:00:00.000Z"));
    buffer.append(taskId, "run-1", "analyze", progressEvent("run-1", longMessage, "2026-01-01T00:00:01.000Z"));

    const record = await buffer.flush(taskId, "run-1");
    expect(record).toBeDefined();

    const progressEv = record!.events.find((e) => e.type === "progress") as
      | { type: "progress"; message: string }
      | undefined;
    expect(progressEv).toBeDefined();
    // 截断后 message 字节数不超过 maxEventBytes（truncateText 保证 budget+suffix <= maxBytes）
    expect(Buffer.byteLength(progressEv!.message, "utf8")).toBeLessThanOrEqual(maxEventBytes);
    // 原始大小确实被缩减
    expect(Buffer.byteLength(progressEv!.message, "utf8")).toBeLessThan(500);
    // 包含截断标记
    expect(progressEv!.message).toContain("[truncated]");
  });

  it("completed summary 超过 maxEventBytes 时被截断", async () => {
    const taskId = await seedProject(store);
    const maxEventBytes = 80;
    const buffer = new RuntimeEventBuffer({
      unitOfWork: store.unitOfWork,
      maxEventBytes
    });

    const longSummary = makeText(300);
    buffer.append(taskId, "run-2", "develop", startedEvent("run-2", "2026-01-01T00:00:00.000Z"));
    buffer.append(taskId, "run-2", "develop", completedEvent("run-2", longSummary, "2026-01-01T00:00:01.000Z"));

    const record = await buffer.flush(taskId, "run-2");
    const completedEv = record!.events.find((e) => e.type === "completed") as
      | { type: "completed"; summary: string }
      | undefined;
    expect(completedEv).toBeDefined();
    // 截断后 summary 字节数不超过 maxEventBytes
    expect(Buffer.byteLength(completedEv!.summary, "utf8")).toBeLessThanOrEqual(maxEventBytes);
    expect(Buffer.byteLength(completedEv!.summary, "utf8")).toBeLessThan(300);
    expect(completedEv!.summary).toContain("[truncated]");
  });

  it("未超过 maxEventBytes 的事件不被截断", async () => {
    const taskId = await seedProject(store);
    const buffer = new RuntimeEventBuffer({
      unitOfWork: store.unitOfWork,
      maxEventBytes: 1000
    });

    const shortMessage = "正常消息";
    buffer.append(taskId, "run-3", "analyze", progressEvent("run-3", shortMessage, "2026-01-01T00:00:00.000Z"));

    const record = await buffer.flush(taskId, "run-3");
    const progressEv = record!.events.find((e) => e.type === "progress") as
      | { type: "progress"; message: string }
      | undefined;
    expect(progressEv!.message).toBe(shortMessage);
  });
});

// ---------------------------------------------------------------------------
// 2. 总量超限时尾部保留
// ---------------------------------------------------------------------------

describe("RuntimeEventBuffer 总量超限尾部保留", () => {
  let dbPath: string;
  let store: SqliteStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = createSqliteStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    safeCleanup(dbPath);
  });

  it("retainedBytes 不超过 maxRetainedBytes，truncated=true", async () => {
    const taskId = await seedProject(store);
    // 总量上限很小，强制触发截断
    const maxRetainedBytes = 200;
    const buffer = new RuntimeEventBuffer({
      unitOfWork: store.unitOfWork,
      maxEventBytes: 10000, // 不限制单条，只测总量
      maxRetainedBytes
    });

    // 追加多个事件，总量远超 maxRetainedBytes
    for (let i = 0; i < 20; i++) {
      buffer.append(
        taskId,
        "run-bulk",
        "analyze",
        progressEvent("run-bulk", makeText(100), `2026-01-01T00:00:${i.toString().padStart(2, "0")}.000Z`)
      );
    }

    const record = await buffer.flush(taskId, "run-bulk");
    expect(record).toBeDefined();
    expect(record!.truncated).toBe(true);
    expect(record!.retainedBytes).toBeLessThanOrEqual(maxRetainedBytes);
    // totalBytes 记录原始未截断字节数，应远大于 retainedBytes
    expect(record!.totalBytes).toBeGreaterThan(record!.retainedBytes);
    // contentHash 基于截断前的完整事件序列计算
    expect(record!.contentHash).toMatch(/^runhash-/);
  });

  it("未超限时 truncated=false，retainedBytes 等于实际保留字节", async () => {
    const taskId = await seedProject(store);
    const buffer = new RuntimeEventBuffer({
      unitOfWork: store.unitOfWork,
      maxRetainedBytes: 100000
    });

    buffer.append(taskId, "run-small", "analyze", startedEvent("run-small", "2026-01-01T00:00:00.000Z"));
    buffer.append(taskId, "run-small", "analyze", progressEvent("run-small", "短消息", "2026-01-01T00:00:01.000Z"));

    const record = await buffer.flush(taskId, "run-small");
    expect(record!.truncated).toBe(false);
    // 未截断时 retainedBytes 等于保留候选字节
    expect(record!.retainedBytes).toBe(record!.totalBytes);
  });
});

// ---------------------------------------------------------------------------
// 3. append 顺序保持
// ---------------------------------------------------------------------------

describe("RuntimeEventBuffer append 顺序保持", () => {
  let dbPath: string;
  let store: SqliteStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = createSqliteStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    safeCleanup(dbPath);
  });

  it("落库后事件顺序与 append 顺序一致", async () => {
    const taskId = await seedProject(store);
    const buffer = new RuntimeEventBuffer({
      unitOfWork: store.unitOfWork,
      maxRetainedBytes: 100000
    });

    const events: RuntimeEvent[] = [
      startedEvent("run-seq", "2026-01-01T00:00:00.000Z"),
      progressEvent("run-seq", "第一步", "2026-01-01T00:00:01.000Z"),
      progressEvent("run-seq", "第二步", "2026-01-01T00:00:02.000Z"),
      progressEvent("run-seq", "第三步", "2026-01-01T00:00:03.000Z"),
      completedEvent("run-seq", "完成", "2026-01-01T00:00:04.000Z")
    ];

    for (const ev of events) {
      buffer.append(taskId, "run-seq", "analyze", ev);
    }

    const record = await buffer.flush(taskId, "run-seq");
    expect(record!.events.length).toBe(5);

    // 验证顺序与 append 一致
    const types = record!.events.map((e) => e.type);
    expect(types).toEqual(["started", "progress", "progress", "progress", "completed"]);

    // 验证 progress 消息顺序
    const progressMessages = record!.events
      .filter((e) => e.type === "progress")
      .map((e) => (e as { message: string }).message);
    expect(progressMessages).toEqual(["第一步", "第二步", "第三步"]);
  });

  it("总量截断时尾部保留的事件仍保持原始顺序", async () => {
    const taskId = await seedProject(store);
    const buffer = new RuntimeEventBuffer({
      unitOfWork: store.unitOfWork,
      maxEventBytes: 10000,
      maxRetainedBytes: 250 // 只能保留尾部约 2 个事件
    });

    for (let i = 0; i < 10; i++) {
      buffer.append(
        taskId,
        "run-tail",
        "analyze",
        progressEvent("run-tail", `事件${i}`, `2026-01-01T00:00:${i.toString().padStart(2, "0")}.000Z`)
      );
    }

    const record = await buffer.flush(taskId, "run-tail");
    expect(record!.truncated).toBe(true);
    // 尾部保留的事件顺序仍为升序
    const messages = record!.events.map((e) => (e as { message: string }).message);
    for (let i = 1; i < messages.length; i++) {
      const prevNum = parseInt(messages[i - 1]!.replace("事件", ""), 10);
      const currNum = parseInt(messages[i]!.replace("事件", ""), 10);
      expect(currNum).toBeGreaterThan(prevNum);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. flush 写入失败后缓冲可重试且既有审计不受影响
// ---------------------------------------------------------------------------

describe("RuntimeEventBuffer flush 失败语义", () => {
  let dbPath: string;
  let store: SqliteStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = createSqliteStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    safeCleanup(dbPath);
  });

  it("flush 写入失败时缓冲区保留，同一缓冲区恢复后重试成功", async () => {
    const taskId = await seedProject(store);

    // 可切换的 UnitOfWork：先失败，恢复后转发到真实 store。
    // 对同一个 RuntimeEventBuffer 调用两次 flush，验证失败后缓冲区保留、
    // 恢复后同一实例能落库原事件序列且 pendingCount() 变为 0。
    const switchableUoW: SwitchableUnitOfWork = new SwitchableUnitOfWork(
      store.unitOfWork
    );

    const buffer = new RuntimeEventBuffer({
      unitOfWork: switchableUoW,
      maxRetainedBytes: 100000
    });

    buffer.append(taskId, "run-retry", "analyze", startedEvent("run-retry", "2026-01-01T00:00:00.000Z"));
    buffer.append(taskId, "run-retry", "analyze", progressEvent("run-retry", "消息", "2026-01-01T00:00:01.000Z"));

    expect(buffer.pendingCount()).toBe(1);

    // 第一次 flush：依赖处于失败模式 → 抛错，缓冲区保留
    switchableUoW.failWith(new Error("模拟数据库写入失败"));
    await expect(buffer.flush(taskId, "run-retry")).rejects.toThrow("模拟数据库写入失败");
    expect(buffer.pendingCount()).toBe(1);

    // 恢复依赖：同一缓冲区第二次 flush → 落库原事件序列
    switchableUoW.recover();
    const record = await buffer.flush(taskId, "run-retry");
    expect(record).toBeDefined();
    expect(buffer.pendingCount()).toBe(0);

    // 验证落库的是原始事件序列（2 条事件）
    expect(record!.events.length).toBe(2);
    expect(record!.events.map((e) => e.type)).toEqual(["started", "progress"]);

    // 验证确实落库到 agent_runs
    const runs = await store.unitOfWork.run((tx) => tx.agentRuns.findByTask(taskId));
    expect(runs.length).toBe(1);
    expect(runs[0]!.runId).toBe("run-retry");
    expect(runs[0]!.events.length).toBe(2);
  });

  it("flush 失败不破坏既有审计事件", async () => {
    const taskId = await seedProject(store);
    const orch = new TaskOrchestrator({ unitOfWork: store.unitOfWork });

    // 先正常迁移任务状态，产生审计事件
    await orch.transitionTask(taskId, "INTAKING");
    const auditsBefore = await store.unitOfWork.run((tx) => tx.audit.findByTask(taskId));
    expect(auditsBefore.length).toBeGreaterThanOrEqual(2); // task_created + task_transitioned

    // flush 失败：用可切换依赖包装真实 store
    const switchableUoW = new SwitchableUnitOfWork(store.unitOfWork);
    switchableUoW.failWith(new Error("模拟 flush 失败"));
    const failingBuffer = new RuntimeEventBuffer({
      unitOfWork: switchableUoW,
      maxRetainedBytes: 100000
    });
    failingBuffer.append(taskId, "run-audit", "analyze", startedEvent("run-audit", "2026-01-01T00:00:00.000Z"));

    await expect(failingBuffer.flush(taskId, "run-audit")).rejects.toThrow("模拟 flush 失败");

    // 既有审计事件不受影响（用真实 store 直接查询）
    const auditsAfter = await store.unitOfWork.run((tx) => tx.audit.findByTask(taskId));
    expect(auditsAfter.length).toBe(auditsBefore.length);
    expect(auditsAfter.map((a) => a.type)).toEqual(auditsBefore.map((a) => a.type));

    // agent_runs 表中无该 run 的记录
    const runs = await store.unitOfWork.run((tx) => tx.agentRuns.findByTask(taskId));
    expect(runs.find((r) => r.runId === "run-audit")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. 已落库事件在重新打开数据库后可查询
// ---------------------------------------------------------------------------

describe("RuntimeEventBuffer 重启后已落库事件可查询", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });

  afterEach(() => {
    safeCleanup(dbPath);
  });

  it("flush 落库的事件在重新打开数据库后可查询", async () => {
    // 第一次启动：写入事件并 flush
    let store = createSqliteStore({ dbPath });
    const taskId = await seedProject(store);
    const buffer = new RuntimeEventBuffer({
      unitOfWork: store.unitOfWork,
      maxRetainedBytes: 100000
    });

    buffer.append(taskId, "run-persist", "analyze", startedEvent("run-persist", "2026-01-01T00:00:00.000Z"));
    buffer.append(taskId, "run-persist", "analyze", progressEvent("run-persist", "持久化测试", "2026-01-01T00:00:01.000Z"));
    buffer.append(taskId, "run-persist", "analyze", completedEvent("run-persist", "完成", "2026-01-01T00:00:02.000Z"));

    const flushedRecord = await buffer.flush(taskId, "run-persist");
    expect(flushedRecord).toBeDefined();
    store.close();

    // 第二次启动：验证已落库事件可查询
    store = createSqliteStore({ dbPath });
    const runs = await store.unitOfWork.run((tx) => tx.agentRuns.findByTask(taskId));
    expect(runs.length).toBe(1);
    expect(runs[0]!.runId).toBe("run-persist");
    expect(runs[0]!.role).toBe("analyze");
    expect(runs[0]!.events.length).toBe(3);

    // 验证事件类型与内容
    const types = runs[0]!.events.map((e) => e.type);
    expect(types).toEqual(["started", "progress", "completed"]);

    // 验证 contentHash 在重启后保持一致
    expect(runs[0]!.contentHash).toBe(flushedRecord!.contentHash);
    expect(runs[0]!.truncated).toBe(false);
    expect(runs[0]!.totalBytes).toBe(flushedRecord!.totalBytes);

    // 通过 findByRunId 也能查到
    const byRunId = await store.unitOfWork.run((tx) =>
      tx.agentRuns.findByRunId(taskId, "run-persist")
    );
    expect(byRunId).toBeDefined();
    expect(byRunId!.runId).toBe("run-persist");

    store.close();
  });

  it("截断标记和 contentHash 在重启后保持一致", async () => {
    let store = createSqliteStore({ dbPath });
    const taskId = await seedProject(store);
    const buffer = new RuntimeEventBuffer({
      unitOfWork: store.unitOfWork,
      maxEventBytes: 10000,
      maxRetainedBytes: 150
    });

    // 追加大量事件触发总量截断
    for (let i = 0; i < 15; i++) {
      buffer.append(
        taskId,
        "run-trunc-persist",
        "develop",
        progressEvent("run-trunc-persist", makeText(80), `2026-01-01T00:00:${i.toString().padStart(2, "0")}.000Z`)
      );
    }

    const flushed = await buffer.flush(taskId, "run-trunc-persist");
    expect(flushed!.truncated).toBe(true);
    store.close();

    // 重启后验证截断标记
    store = createSqliteStore({ dbPath });
    const runs = await store.unitOfWork.run((tx) =>
      tx.agentRuns.findByRunId(taskId, "run-trunc-persist")
    );
    expect(runs).toBeDefined();
    expect(runs!.truncated).toBe(true);
    expect(runs!.contentHash).toBe(flushed!.contentHash);
    expect(runs!.retainedBytes).toBe(flushed!.retainedBytes);
    expect(runs!.totalBytes).toBe(flushed!.totalBytes);
    expect(runs!.retainedBytes).toBeLessThanOrEqual(150);
    store.close();
  });
});
