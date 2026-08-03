/**
 * SQLite store 集成测试 —— 见 IMPLEMENTATION_SPEC §9 Phase 2、§3.1 与 ADR-005。
 *
 * 覆盖 Phase 2 退出条件：
 * - 迁移幂等且版本追踪正确
 * - 安全备份（备份失败不删除原库）
 * - WAL/锁等待策略（busy_timeout 生效）
 * - 单写入队列串行化
 * - 服务重启收口（EXECUTING/VALIDATING 任务 → INTERRUPTED）
 * - 事务回滚（回调抛错时全部回滚，与 InMemory 语义对齐）
 * - Task + Audit 原子提交
 * - Evidence Pack 按版本不可变
 * - Repair Memory 召回规则
 *
 * 每个测试使用临时数据库路径，测试后清理。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import {
  createSqliteStore,
  openDatabase,
  closeDatabase,
  backupDatabase,
  getAppliedVersions,
  getLatestMigrationVersion,
  type SqliteStore
} from "../src/index.js";
import {
  TaskOrchestrator,
  createInMemoryStore,
  type TaskInput,
  type Project
} from "@tracepilot/core";

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-test-"));
  return join(dir, "test.db");
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

/** 在 store 中创建项目（满足外键约束）。 */
async function seedProject(store: SqliteStore, project: Project = sampleProject()): Promise<void> {
  await store.unitOfWork.run(async (tx) => {
    await tx.projects.save(project);
  });
}

/** Windows 安全清理：WAL 文件可能被占用，重试几次。 */
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
    // 忽略：Windows 文件锁残留不影响测试结论
  }
}

function sampleTaskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    objective: "修复失败的 pytest 用例 test_users_create",
    constraints: ["不得修改 /api/users 的公开 API"],
    acceptanceCriteria: ["pytest tests/test_users.py 通过"],
    riskLevel: "low",
    rawSource: "FAILED test_users_create::test_returns_201 ...",
    origin: "failed_test_log",
    failure: {
      testNames: ["test_users_create::test_returns_201"],
      errorTypes: ["AssertionError"],
      stackSummary: "assert response.status == 201, got 400"
    },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 迁移测试
// ---------------------------------------------------------------------------

describe("SQLite 迁移", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });

  afterEach(() => {
    safeCleanup(dbPath);
  });

  it("首次打开数据库时应用所有迁移，版本号正确", () => {
    const db = openDatabase({ dbPath });
    const versions = getAppliedVersions(db);
    expect(versions).toEqual([1, 2, 3, 4]);
    expect(getLatestMigrationVersion()).toBe(4);
    closeDatabase(db);
  });

  it("重复打开数据库时迁移幂等，不重复应用", () => {
    const db1 = openDatabase({ dbPath });
    closeDatabase(db1);

    const db2 = openDatabase({ dbPath });
    const versions = getAppliedVersions(db2);
    expect(versions).toEqual([1, 2, 3, 4]);
    closeDatabase(db2);
  });

  it("迁移后所有表存在", () => {
    const db = openDatabase({ dbPath });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("projects");
    expect(tableNames).toContain("tasks");
    expect(tableNames).toContain("evidence_packs");
    expect(tableNames).toContain("evidence_requests");
    expect(tableNames).toContain("plans");
    expect(tableNames).toContain("approvals");
    expect(tableNames).toContain("worktrees");
    expect(tableNames).toContain("repair_records");
    expect(tableNames).toContain("audit_events");
    expect(tableNames).toContain("agent_runs");
    expect(tableNames).toContain("execution_results");
    expect(tableNames).toContain("schema_migrations");
    closeDatabase(db);
  });

  it("PRAGMA 设置正确：foreign_keys、WAL、busy_timeout", () => {
    const db = openDatabase({ dbPath, busyTimeoutMs: 8000 });
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(8000);
    closeDatabase(db);
  });
});

// ---------------------------------------------------------------------------
// 安全备份测试
// ---------------------------------------------------------------------------

describe("SQLite 安全备份", () => {
  let dbPath: string;
  let backupPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    backupPath = join(dbPath, "..", "backup.db");
  });

  afterEach(() => {
    safeCleanup(dbPath);
  });

  it("备份数据库到新文件，内容一致", async () => {
    const store = createSqliteStore({ dbPath });
    await seedProject(store);
    const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    await orchestrator.createTask({
      projectId: "proj-1",
      input: sampleTaskInput()
    });
    store.close();

    const db = openDatabase({ dbPath, skipMigrations: true });
    await backupDatabase(db, backupPath);
    closeDatabase(db);

    expect(existsSync(backupPath)).toBe(true);

    const backupDb = openDatabase({ dbPath: backupPath, skipMigrations: true });
    const count = backupDb
      .prepare("SELECT COUNT(*) as c FROM tasks")
      .get() as { c: number };
    expect(count.c).toBe(1);
    closeDatabase(backupDb);
  });

  it("备份失败不删除原库", async () => {
    const store = createSqliteStore({ dbPath });
    store.close();

    const db = openDatabase({ dbPath, skipMigrations: true });
    await expect(backupDatabase(db, "")).rejects.toThrow();
    closeDatabase(db);

    expect(existsSync(dbPath)).toBe(true);
    const db2 = openDatabase({ dbPath, skipMigrations: true });
    expect(db2.prepare("SELECT 1").get()).toBeTruthy();
    closeDatabase(db2);
  });
});

// ---------------------------------------------------------------------------
// 单写入队列 + 事务语义测试
// ---------------------------------------------------------------------------

describe("SQLite UnitOfWork 事务语义", () => {
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

  it("Task + Audit 原子提交：成功时同时可见", async () => {
    await seedProject(store);
    const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const task = await orchestrator.createTask({
      projectId: "proj-1",
      input: sampleTaskInput()
    });

    const dbTask = store.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(task.id);
    expect(dbTask).toBeTruthy();

    const dbAudit = store.db
      .prepare("SELECT * FROM audit_events WHERE task_id = ? AND type = ?")
      .get(task.id, "task_created") as { type: string } | undefined;
    expect(dbAudit?.type).toBe("task_created");
  });

  it("事务回滚：回调抛错时 Task 和 Audit 都不可见", async () => {
    await seedProject(store);
    const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const task = await orchestrator.createTask({
      projectId: "proj-1",
      input: sampleTaskInput()
    });

    await expect(
      store.unitOfWork.run(async (tx) => {
        await tx.tasks.save({
          ...task,
          status: "INTAKING",
          updatedAt: new Date().toISOString()
        });
        await tx.audit.append({
          id: "audit_should_rollback",
          taskId: task.id,
          type: "task_transitioned",
          fromStatus: "CREATED",
          toStatus: "INTAKING",
          recordedAt: new Date().toISOString()
        });
        throw new Error("模拟失败");
      })
    ).rejects.toThrow("模拟失败");

    const dbTask = store.db
      .prepare("SELECT status FROM tasks WHERE id = ?")
      .get(task.id) as { status: string };
    expect(dbTask.status).toBe("CREATED");

    const rollbackAudit = store.db
      .prepare("SELECT * FROM audit_events WHERE id = ?")
      .get("audit_should_rollback");
    expect(rollbackAudit).toBeUndefined();
  });

  it("单写入队列串行化：并发事务不交错", async () => {
    await seedProject(store);
    const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const task = await orchestrator.createTask({
      projectId: "proj-1",
      input: sampleTaskInput()
    });

    const p1 = orchestrator.transitionTask(task.id, "INTAKING");
    const p2 = orchestrator.transitionTask(task.id, "INTAKING");

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length + rejected.length).toBe(2);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Evidence Pack 版本不可变测试
// ---------------------------------------------------------------------------

describe("SQLite Evidence Pack 版本不可变", () => {
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

  it("事务回滚后 Evidence Pack 新版本不残留（P1-R01 对齐）", async () => {
    await seedProject(store);
    const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const task = await orchestrator.createTask({
      projectId: "proj-1",
      input: sampleTaskInput()
    });

    const packV1 = {
      id: "pack-1",
      taskId: task.id,
      version: 1,
      taskSnapshot: sampleTaskInput(),
      evidence: [],
      hypotheses: [],
      constraints: [],
      acceptanceCriteria: ["pytest 通过"],
      createdAt: new Date().toISOString(),
      contentHash: "hash-v1"
    };
    await store.unitOfWork.run(async (tx) => {
      await tx.evidencePacks.save(packV1);
    });

    await expect(
      store.unitOfWork.run(async (tx) => {
        await tx.evidencePacks.save({
          ...packV1,
          version: 2,
          createdAt: new Date().toISOString(),
          contentHash: "hash-v2"
        });
        throw new Error("模拟失败");
      })
    ).rejects.toThrow("模拟失败");

    const versions = await store.unitOfWork.run((tx) =>
      tx.evidencePacks.findVersions("pack-1")
    );
    expect(versions.map((p) => p.version)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// 服务重启收口测试
// ---------------------------------------------------------------------------

describe("SQLite 服务重启收口", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });

  afterEach(() => {
    safeCleanup(dbPath);
  });

  it("重启后 EXECUTING 任务被迁移到 INTERRUPTED", async () => {
    let store = createSqliteStore({ dbPath });
    await seedProject(store);
    let orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const task = await orchestrator.createTask({
      projectId: "proj-1",
      input: sampleTaskInput()
    });

    await store.unitOfWork.run(async (tx) => {
      await tx.tasks.save({
        ...task,
        status: "EXECUTING",
        updatedAt: new Date().toISOString()
      });
    });

    store.close();

    store = createSqliteStore({ dbPath });
    orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const recovered = await orchestrator.recoverInterruptedTasks();
    expect(recovered.map((t) => t.id)).toContain(task.id);

    const recoveredTask = recovered.find((t) => t.id === task.id);
    expect(recoveredTask?.status).toBe("INTERRUPTED");
    store.close();
  });

  it("重启后 VALIDATING 任务被迁移到 INTERRUPTED", async () => {
    let store = createSqliteStore({ dbPath });
    await seedProject(store);
    let orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const task = await orchestrator.createTask({
      projectId: "proj-1",
      input: sampleTaskInput()
    });

    await store.unitOfWork.run(async (tx) => {
      await tx.tasks.save({
        ...task,
        status: "VALIDATING",
        updatedAt: new Date().toISOString()
      });
    });

    store.close();

    store = createSqliteStore({ dbPath });
    orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const recovered = await orchestrator.recoverInterruptedTasks();
    expect(recovered.map((t) => t.status)).toContain("INTERRUPTED");
    store.close();
  });

  it("重启后 AWAITING_EXECUTION_APPROVAL 任务保持原状", async () => {
    let store = createSqliteStore({ dbPath });
    await seedProject(store);
    let orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const task = await orchestrator.createTask({
      projectId: "proj-1",
      input: sampleTaskInput()
    });

    await store.unitOfWork.run(async (tx) => {
      await tx.tasks.save({
        ...task,
        status: "AWAITING_EXECUTION_APPROVAL",
        updatedAt: new Date().toISOString()
      });
    });

    store.close();

    store = createSqliteStore({ dbPath });
    orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const recovered = await orchestrator.recoverInterruptedTasks();
    expect(recovered.find((t) => t.id === task.id)).toBeUndefined();
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Repair Memory 召回测试
// ---------------------------------------------------------------------------

describe("SQLite Repair Memory 召回", () => {
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

  async function seedRepairRecords(): Promise<void> {
    // 先创建 project 和 task 以满足外键约束
    await seedProject(store);
    await store.unitOfWork.run(async (tx) => {
      await tx.tasks.save({
        id: "task-1",
        projectId: "proj-1",
        status: "COMPLETED",
        input: sampleTaskInput(),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });
    });

    const baseRecord = {
      projectId: "proj-1",
      taskId: "task-1",
      symptom: "pytest 失败",
      rootCause: "空指针",
      fixSummary: "增加空检查",
      applicabilityConditions: ["python"],
      failureReasons: ["未处理 None"],
      inputEvidencePackId: "pack-1",
      inputEvidencePackVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    await store.knowledgeAdapter.write({ ...baseRecord, id: "r-draft", status: "DRAFT" as const });
    await store.knowledgeAdapter.write({ ...baseRecord, id: "r-verified", status: "VERIFIED" as const });
    await store.knowledgeAdapter.write({ ...baseRecord, id: "r-approved", status: "APPROVED" as const });
  }

  it("默认仅召回 APPROVED 记录", async () => {
    await seedRepairRecords();

    const results = await store.knowledgeAdapter.search({
      projectId: "proj-1"
    });
    expect(results.map((r) => r.id)).toEqual(["r-approved"]);
  });

  it("minStatus=VERIFIED 时召回 VERIFIED 和 APPROVED", async () => {
    await seedRepairRecords();

    const results = await store.knowledgeAdapter.search({
      projectId: "proj-1",
      minStatus: "VERIFIED"
    });
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(["r-approved", "r-verified"]);
  });
});

// ---------------------------------------------------------------------------
// SQLite vs InMemory 语义对齐测试
// ---------------------------------------------------------------------------

describe("SQLite 与 InMemory 语义对齐", () => {
  it("SQLite 与 InMemory 对同一操作序列产出相同结构", async () => {
    const sqlitePath = tempDbPath();
    const sqliteStore = createSqliteStore({ dbPath: sqlitePath });
    const inMemoryStore = createInMemoryStore();

    try {
      await seedProject(sqliteStore);
      const sqliteOrch = new TaskOrchestrator({ unitOfWork: sqliteStore.unitOfWork });
      const inMemOrch = new TaskOrchestrator({ unitOfWork: inMemoryStore.unitOfWork });

      const input = sampleTaskInput();

      const sqliteTask = await sqliteOrch.createTask({
        projectId: "proj-1",
        input,
        taskId: "task-align-1"
      });
      const inMemTask = await inMemOrch.createTask({
        projectId: "proj-1",
        input,
        taskId: "task-align-1"
      });

      expect(sqliteTask.status).toBe(inMemTask.status);
      expect(sqliteTask.input).toEqual(inMemTask.input);

      await sqliteOrch.transitionTask("task-align-1", "INTAKING");
      await inMemOrch.transitionTask("task-align-1", "INTAKING");

      const sqliteAudits = await sqliteStore.unitOfWork.run((tx) =>
        tx.audit.findByTask("task-align-1")
      );
      const inMemAudits = await inMemoryStore.unitOfWork.run((tx) =>
        tx.audit.findByTask("task-align-1")
      );
      expect(sqliteAudits.length).toBe(inMemAudits.length);
      expect(sqliteAudits.map((a) => a.type)).toEqual(inMemAudits.map((a) => a.type));
    } finally {
      sqliteStore.close();
      safeCleanup(sqlitePath);
    }
  });
});

// ---------------------------------------------------------------------------
// SQLite 锁等待策略（真实双连接，P1-05）
// ---------------------------------------------------------------------------
//
// Phase 2 退出条件要求“SQLite 锁等待策略通过集成测试”。仅断言 PRAGMA
// busy_timeout 被设置不足以证明运行时行为。这里用 worker_threads 在独立
// 线程持有 BEGIN IMMEDIATE 写锁，主线程用第二个连接制造真实锁竞争：
//
// 1. 锁在 busy_timeout 内释放 → 第二个写入成功
// 2. 超过 busy_timeout → 返回可识别的 SQLITE_BUSY 失败
// 3. SQLITE_BUSY 失败不破坏单写入队列 → 后续 UnitOfWork.run 恢复正常
//
// 必须用 worker_threads：better-sqlite3 是同步 API，主线程在 busy handler
// 里 native 阻塞期间不会 yield 事件循环，只有独立线程能在此期间释放锁。

/**
 * Worker 源码：打开 db，BEGIN IMMEDIATE 持有写锁 holdMs 毫秒后 COMMIT。
 *
 * 用 eval 模式 + CJS require，避免 ESM 项目下 worker 模块解析问题。
 * worker 持锁期间插入一行 projects（无外键依赖），保证锁是非空的。
 */
const LOCK_HOLDER_WORKER_CODE = `
const { workerData, parentPort } = require('node:worker_threads');
const Database = require('better-sqlite3');
const db = new Database(workerData.dbPath);
db.pragma('busy_timeout = 0');
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT OR IGNORE INTO projects (id, name, repository_path, default_branch, language, commands_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run('lock-holder', 'lock-holder', '/tmp', 'main', 'python', '{}', '2026-01-01T00:00:00.000Z');
parentPort.postMessage('locked');
setTimeout(() => {
  try { db.exec('COMMIT'); } catch (e) {}
  try { db.close(); } catch (e) {}
  parentPort.postMessage('released');
}, workerData.holdMs);
`;

/** 在 worker 线程持有写锁。 */
async function holdLockInWorker(
  dbPath: string,
  holdMs: number
): Promise<Worker> {
  const worker = new Worker(LOCK_HOLDER_WORKER_CODE, {
    eval: true,
    workerData: { dbPath, holdMs }
  });
  await new Promise<void>((resolve) => {
    worker.once("message", (msg: string) => {
      if (msg === "locked") resolve();
    });
  });
  return worker;
}

/** 等待 worker 发出 released 消息后终止。 */
async function releaseWorker(worker: Worker): Promise<void> {
  await new Promise<void>((resolve) => {
    worker.once("message", (msg: string) => {
      if (msg === "released") resolve();
    });
  });
  await worker.terminate();
}

const INSERT_PROJECT_SQL =
  "INSERT INTO projects (id, name, repository_path, default_branch, language, commands_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)";

describe("SQLite 锁等待策略（真实双连接，P1-05）", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
    // 预先迁移，确保表存在；worker 用 skipMigrations 打开。
    const db = openDatabase({ dbPath });
    closeDatabase(db);
  });

  afterEach(() => {
    safeCleanup(dbPath);
  });

  it("锁在 busy_timeout 内释放：第二个写入成功", async () => {
    // worker 持锁 400ms
    const worker = await holdLockInWorker(dbPath, 400);

    // 主线程连接 B，busy_timeout=2000；写入应等待约 400ms 后成功
    const dbB = openDatabase({ dbPath, busyTimeoutMs: 2000, skipMigrations: true });
    try {
      const start = Date.now();
      dbB.prepare(INSERT_PROJECT_SQL).run(
        "b-conn-win",
        "b-conn",
        "/tmp",
        "main",
        "python",
        "{}",
        "2026-01-01T00:00:00.000Z"
      );
      const elapsed = Date.now() - start;
      // 至少等待了 worker 持锁的一部分时间（留容差）
      expect(elapsed).toBeGreaterThanOrEqual(150);
      // 在 busy_timeout 内成功
      expect(elapsed).toBeLessThan(2000);

      // 写入确实落库
      const row = dbB
        .prepare("SELECT id FROM projects WHERE id = ?")
        .get("b-conn-win") as { id: string } | undefined;
      expect(row?.id).toBe("b-conn-win");
    } finally {
      closeDatabase(dbB);
    }

    await releaseWorker(worker);
  });

  it("超过 busy_timeout：返回可识别的 SQLITE_BUSY 失败", async () => {
    // worker 持锁 3000ms（远超 B 的 busy_timeout）
    const worker = await holdLockInWorker(dbPath, 3000);

    const dbB = openDatabase({ dbPath, busyTimeoutMs: 300, skipMigrations: true });
    try {
      const start = Date.now();
      let thrown: unknown;
      try {
        dbB.prepare(INSERT_PROJECT_SQL).run(
          "b-conn-timeout",
          "b-conn",
          "/tmp",
          "main",
          "python",
          "{}",
          "2026-01-01T00:00:00.000Z"
        );
      } catch (err) {
        thrown = err;
      }
      const elapsed = Date.now() - start;

      // 至少等待了接近 busy_timeout 的时间
      expect(elapsed).toBeGreaterThanOrEqual(250);
      // 抛出可识别的 SQLITE_BUSY
      expect(thrown).toBeDefined();
      expect((thrown as { code?: string }).code).toBe("SQLITE_BUSY");

      // 失败不污染连接：B 仍可正常读取（WAL 读不阻塞写锁；读不到 worker
      // 未提交的 INSERT，但 SELECT 本身必须成功返回）
      const count = dbB
        .prepare("SELECT COUNT(*) as c FROM projects")
        .get() as { c: number };
      expect(typeof count.c).toBe("number");
    } finally {
      closeDatabase(dbB);
    }

    await worker.terminate();
  });

  it("SQLITE_BUSY 失败不破坏单写入队列：后续 UnitOfWork.run 恢复正常", async () => {
    // worker 持锁 2000ms
    const worker = await holdLockInWorker(dbPath, 2000);

    // store 的单写入队列遇到 SQLITE_BUSY 失败
    const store = createSqliteStore({ dbPath, busyTimeoutMs: 300 });
    try {
      await expect(
        store.unitOfWork.run(async (tx) => {
          await tx.projects.save(sampleProject("queue-fail"));
        })
      ).rejects.toThrow();

      // 终止 worker 释放锁
      await worker.terminate();
      // 给 SQLite 一点时间回收锁
      await new Promise((resolve) => setTimeout(resolve, 200));

      // 同一 store 的单写入队列应恢复正常
      await store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject("queue-recovered"));
      });

      const recovered = await store.unitOfWork.run((tx) =>
        tx.projects.findById("queue-recovered")
      );
      expect(recovered).toBeDefined();
      expect(recovered?.id).toBe("queue-recovered");

      // 失败那次的项目不应存在
      const failed = await store.unitOfWork.run((tx) =>
        tx.projects.findById("queue-fail")
      );
      expect(failed).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
