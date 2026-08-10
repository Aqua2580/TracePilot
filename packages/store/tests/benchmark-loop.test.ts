/**
 * Fake Adapter 闭环测试 —— Phase 2 退出条件（§9）。
 *
 * P1-02 修复：本测试不再直接调用 `createBenchmarkEvidencePack` 等 fixture
 * 生成函数绕过 Adapter，而是真实实例化并消费 `FakeRuntimeAdapter` /
 * `FakeGitAdapter` / `FakeKnowledgeAdapter` 的输出：
 *
 * 1. 任务输入 → orchestrator.createTask
 * 2. FakeGitAdapter.validateRepository → git 证据
 * 3. FakeKnowledgeAdapter.search → memory 证据（预填 seed）
 * 4. FakeRuntimeAdapter.analyze → 流式 RuntimeEvent → RuntimeEventBuffer
 *    缓冲 → flush 落库到 agent_runs；completed 事件 summary → code 证据
 * 5. 上述 3 条 Fake Adapter 输出 → Evidence Pack v1
 * 6. Pack → Plan（确定性结构）
 * 7. 全部产物持久化到 SQLite，并写审计事件
 *
 * 断言显式验证 Fake Adapter 被调用及其产物被持久化：
 * - agent_runs 表存在 analyze 流产生的事件记录
 * - pack 的 evidence source 标注来自 Fake Adapter
 * - 相同输入重复执行产出相同结构（contentHash 一致）
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
  BENCHMARK_FIXTURES,
  createBenchmarkPlan,
  type BenchmarkFixture
} from "../src/benchmarks.js";
import {
  TaskOrchestrator,
  computePackContentHash,
  type Project,
  type RepairRecord,
  type EvidencePack,
  type EvidenceItem,
  type RuntimeTaskInput
} from "@tracepilot/core";
import {
  FakeRuntimeAdapter,
  FakeGitAdapter,
  FakeKnowledgeAdapter
} from "@tracepilot/adapters";

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-bench-"));
  return join(dir, "bench.db");
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
    // 忽略：Windows 文件锁残留不影响测试结论
  }
}

function sampleProject(id = "proj-bench"): Project {
  return {
    id,
    name: "基准测试项目",
    repositoryPath: "D:/fake-repo",
    defaultBranch: "main",
    language: "python",
    commands: {
      test: { argv: ["pytest"], timeoutMs: 30000 }
    },
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

/** 固定时间戳，保证 pack contentHash 在重复运行时一致。 */
const FIXED_AT = "2026-01-01T00:00:00.000Z";

/**
 * 为 FakeKnowledgeAdapter 预填一条 APPROVED RepairRecord，使 search() 返回
 * 非空结果。record 内容固定，保证 memory 证据确定性。
 */
function seedMemoryRecord(fixture: BenchmarkFixture): RepairRecord {
  return {
    id: `mem-${fixture.id}`,
    projectId: "proj-bench",
    taskId: `seed-task-${fixture.id}`,
    status: "APPROVED",
    symptom: fixture.taskInput.objective,
    rootCause: "历史相似根因",
    rootCauseConfidence: 0.9,
    rootCauseEvidenceIds: [`seed-evidence-${fixture.id}`],
    fixSummary: "历史修复摘要",
    applicabilityConditions: ["python"],
    applicabilityConditionEvidence: [
      {
        text: "python",
        evidenceIds: [`seed-evidence-${fixture.id}`],
        required: true
      }
    ],
    failureReasons: ["未处理边界"],
    inputEvidencePackId: `seed-pack-${fixture.id}`,
    inputEvidencePackVersion: 1,
    createdAt: FIXED_AT,
    updatedAt: FIXED_AT
  };
}

/**
 * 由 Fake Adapter 输出构造的闭环上下文。每个基准任务独立一份，避免
 * Fake Adapter 内部状态在任务间串扰。
 */
interface FakeAdapterChain {
  readonly runtime: FakeRuntimeAdapter;
  readonly git: FakeGitAdapter;
  readonly knowledge: FakeKnowledgeAdapter;
  readonly buffer: RuntimeEventBuffer;
  /** analyze 流结束后填充：从 completed 事件提取的 summary。 */
  analyzeSummary: string;
  /** analyze 流产生的事件数（含 started/progress/completed）。 */
  analyzeEventCount: number;
  /** validateRepository 返回的 head commit sha。 */
  gitHeadSha: string;
  /** search 返回的 RepairRecord id 列表。 */
  memoryRecordIds: readonly string[];
}

/**
 * 真实驱动 Fake Adapter 跑完整产物链，返回可比较的结构摘要。
 *
 * 步骤：
 * 1. createTask
 * 2. FakeGitAdapter.validateRepository → git 证据
 * 3. FakeKnowledgeAdapter.search → memory 证据
 * 4. FakeRuntimeAdapter.analyze → 流式消费 → buffer.flush 落库 agent_runs
 * 5. 用 3 条 Fake Adapter 输出构造 EvidencePack v1 并持久化 + 审计
 * 6. 构造 Plan 并持久化 + 审计
 */
async function runBenchmarkChain(
  store: SqliteStore,
  fixture: BenchmarkFixture,
  taskId: string,
  chain: FakeAdapterChain
): Promise<{
  evidenceCount: number;
  evidenceSources: string[];
  planNodeCount: number;
  packContentHash: string;
  auditCount: number;
  auditTypes: string[];
  taskStatus: string;
  agentRunCount: number;
  agentRunEventCount: number;
  analyzeSummary: string;
  gitHeadSha: string;
  memoryRecordIds: readonly string[];
}> {
  const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });

  // 1. 创建任务
  await orchestrator.createTask({
    projectId: "proj-bench",
    input: fixture.taskInput,
    taskId
  });

  // 2. FakeGitAdapter.validateRepository → git 证据
  const repoInfo = await chain.git.validateRepository("D:/fake-repo");
  chain.gitHeadSha = repoInfo.headCommitSha;

  // 3. FakeKnowledgeAdapter.search → memory 证据
  const memoryRecords = await chain.knowledge.search({
    projectId: "proj-bench",
    minStatus: "APPROVED"
  });
  chain.memoryRecordIds = memoryRecords.map((r) => r.id);

  // 4. FakeRuntimeAdapter.analyze → 流式消费 → buffer → flush 落库 agent_runs
  const runtimeInput: RuntimeTaskInput = {
    taskId,
    worktreePath: `/fake/worktrees/${taskId}`,
    allowedPaths: ["src/**"],
    evidencePackId: `pack-${fixture.id}`,
    evidencePackVersion: 1,
    taskInput: fixture.taskInput,
    projectCommands: {
      test: { argv: ["pnpm", "test"], timeoutMs: 60000 }
    }
  };
  let eventCount = 0;
  let lastRunId: string | undefined;
  for await (const ev of chain.runtime.analyze(runtimeInput)) {
    eventCount++;
    if ("runId" in ev) lastRunId = ev.runId;
    // 把事件交给 RuntimeEventBuffer 缓冲（role=analyze）
    chain.buffer.append(taskId, lastRunId ?? "unknown", "analyze", ev);
    if (ev.type === "completed") {
      chain.analyzeSummary = ev.summary;
    }
  }
  chain.analyzeEventCount = eventCount;

  // flush 落库到 agent_runs —— 证明 FakeRuntimeAdapter 事件被持久化
  if (lastRunId) {
    await chain.buffer.flush(taskId, lastRunId);
  }

  // 5. 用 Fake Adapter 输出构造 EvidencePack v1
  const evidence: EvidenceItem[] = [
    {
      id: `${fixture.id}-ev-code`,
      kind: "code",
      source: "fake-runtime-analyze",
      locator: `run:${lastRunId ?? "unknown"}`,
      capturedAt: FIXED_AT,
      contentHash: `hash-code-${fixture.id}`,
      summary: chain.analyzeSummary,
      relevance: 0.9,
      trustLevel: "PRIMARY"
    },
    {
      id: `${fixture.id}-ev-git`,
      kind: "git",
      source: "fake-git-validate",
      locator: `commit:${chain.gitHeadSha}`,
      capturedAt: FIXED_AT,
      contentHash: `hash-git-${fixture.id}`,
      summary: `Git 仓库校验：默认分支 ${repoInfo.defaultBranch}`,
      relevance: 0.7,
      trustLevel: "VERIFIED_MEMORY"
    },
    {
      id: `${fixture.id}-ev-memory`,
      kind: "memory",
      source: "fake-memory-search",
      locator: `repair-record:${chain.memoryRecordIds[0] ?? "none"}`,
      capturedAt: FIXED_AT,
      contentHash: `hash-memory-${fixture.id}`,
      summary: memoryRecords[0]?.fixSummary ?? "无历史经验",
      relevance: 0.6,
      trustLevel: "VERIFIED_MEMORY"
    }
  ];

  // P1-04：pack id 必须随 taskId 变化，否则重复执行会因 Pack 按版本不可变
  // 而抛 EvidencePackVersionError（同 (id, version) 拒绝 upsert）。
  const packPayload = {
    id: `pack-${taskId}`,
    taskId,
    version: 1 as const,
    taskSnapshot: fixture.taskInput,
    evidence,
    hypotheses: [
      {
        text: `根因假设：${fixture.taskInput.objective}`,
        confidence: 0.75,
        evidenceIds: evidence.map((e) => e.id)
      }
    ],
    constraints: fixture.taskInput.constraints.map((text, i) => ({
      text,
      evidenceIds: [evidence[0]!.id],
      required: i === 0
    })),
    acceptanceCriteria: [...fixture.taskInput.acceptanceCriteria]
  };
  const pack: EvidencePack = {
    ...packPayload,
    createdAt: FIXED_AT,
    contentHash: computePackContentHash(packPayload)
  };

  await store.unitOfWork.run(async (tx) => {
    await tx.evidencePacks.save(pack);
    await tx.audit.append({
      id: `${taskId}-audit-pack`,
      taskId,
      type: "evidence_pack_versioned",
      evidencePackId: pack.id,
      evidencePackVersion: pack.version,
      evidencePackHash: pack.contentHash,
      recordedAt: FIXED_AT
    });
  });

  // 6. 构造 Plan 并持久化 + 审计
  const plan = createBenchmarkPlan(fixture, taskId, pack.id);
  await store.unitOfWork.run(async (tx) => {
    await tx.plans.save(plan);
    await tx.audit.append({
      id: `${taskId}-audit-plan`,
      taskId,
      type: "plan_recorded",
      planId: plan.id,
      recordedAt: FIXED_AT
    });
  });

  // 7. 查询并返回结构摘要
  const savedPack = await store.unitOfWork.run((tx) =>
    tx.evidencePacks.findLatestVersion(pack.id)
  );
  const savedPlan = await store.unitOfWork.run((tx) =>
    tx.plans.findById(plan.id)
  );
  const audits = await store.unitOfWork.run((tx) =>
    tx.audit.findByTask(taskId)
  );
  const task = await store.unitOfWork.run((tx) => tx.tasks.findById(taskId));
  const agentRuns = await store.unitOfWork.run((tx) =>
    tx.agentRuns.findByTask(taskId)
  );

  return {
    evidenceCount: savedPack?.evidence.length ?? 0,
    evidenceSources: (savedPack?.evidence ?? []).map((e) => e.source).sort(),
    planNodeCount: savedPlan?.nodes.length ?? 0,
    packContentHash: savedPack?.contentHash ?? "",
    auditCount: audits.length,
    auditTypes: audits.map((a) => a.type).sort(),
    taskStatus: task?.status ?? "",
    agentRunCount: agentRuns.length,
    agentRunEventCount: agentRuns.reduce((sum, r) => sum + r.events.length, 0),
    analyzeSummary: chain.analyzeSummary,
    gitHeadSha: chain.gitHeadSha,
    memoryRecordIds: chain.memoryRecordIds
  };
}

/** 为每个基准任务创建独立的 Fake Adapter 链。 */
function newChain(store: SqliteStore, fixture: BenchmarkFixture): FakeAdapterChain {
  const knowledge = new FakeKnowledgeAdapter();
  knowledge.seed([seedMemoryRecord(fixture)]);
  const chain: FakeAdapterChain = {
    runtime: new FakeRuntimeAdapter(),
    git: new FakeGitAdapter(),
    knowledge,
    buffer: new RuntimeEventBuffer({ unitOfWork: store.unitOfWork }),
    analyzeSummary: "",
    analyzeEventCount: 0,
    gitHeadSha: "",
    memoryRecordIds: []
  };
  return chain;
}

describe("Fake Adapter 基准任务闭环", () => {
  let dbPath: string;
  let store: SqliteStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = createSqliteStore({ dbPath });
    // 创建项目以满足外键约束
    return store.unitOfWork.run(async (tx) => {
      await tx.projects.save(sampleProject());
    });
  });

  afterEach(() => {
    store.close();
    safeCleanup(dbPath);
  });

  // 每个基准任务单独测试
  for (const fixture of BENCHMARK_FIXTURES) {
    describe(`基准任务：${fixture.id}`, () => {
      it(`Fake Adapter 闭环产出结构符合预期（evidence=${fixture.expectedEvidenceCount}, planNodes=${fixture.expectedPlanNodeCount}）`, async () => {
        const chain = newChain(store, fixture);
        const result = await runBenchmarkChain(
          store,
          fixture,
          `${fixture.id}-run1`,
          chain
        );

        // Fake Adapter 输出被持久化为 evidence
        expect(result.evidenceCount).toBe(fixture.expectedEvidenceCount);
        expect(result.evidenceSources).toEqual([
          "fake-git-validate",
          "fake-memory-search",
          "fake-runtime-analyze"
        ]);

        // Plan 结构
        expect(result.planNodeCount).toBe(fixture.expectedPlanNodeCount);

        // 任务状态保持 CREATED
        expect(result.taskStatus).toBe("CREATED");

        // 审计事件：task_created + evidence_pack_versioned + plan_recorded
        expect(result.auditCount).toBe(3);
        expect(result.auditTypes).toEqual([
          "evidence_pack_versioned",
          "plan_recorded",
          "task_created"
        ]);

        // P1-02 核心断言：FakeRuntimeAdapter 事件被持久化到 agent_runs
        expect(result.agentRunCount).toBe(1);
        // analyze 流至少产生 started + progress + completed = 3 事件
        expect(result.agentRunEventCount).toBeGreaterThanOrEqual(3);
        expect(chain.analyzeEventCount).toBeGreaterThanOrEqual(3);

        // FakeGitAdapter / FakeKnowledgeAdapter 被调用
        expect(result.gitHeadSha).toBe("fake-sha-0001");
        expect(result.memoryRecordIds).toEqual([`mem-${fixture.id}`]);
      });

      it("相同输入重复执行产出相同结构（Fake Adapter 均被调用）", async () => {
        const chain1 = newChain(store, fixture);
        const chain2 = newChain(store, fixture);
        const r1 = await runBenchmarkChain(store, fixture, `${fixture.id}-rep1`, chain1);
        const r2 = await runBenchmarkChain(store, fixture, `${fixture.id}-rep2`, chain2);

        // 结构完全一致
        expect(r1.evidenceCount).toBe(r2.evidenceCount);
        expect(r1.evidenceSources).toEqual(r2.evidenceSources);
        expect(r1.planNodeCount).toBe(r2.planNodeCount);
        // P1-04：pack id 现在随 taskId 变化（避免同 (id, version) 冲突），
        // 因此 contentHash 不再要求一致；结构等价性由其余字段断言。
        expect(r1.auditCount).toBe(r2.auditCount);
        expect(r1.auditTypes).toEqual(r2.auditTypes);

        // 两次 Fake Adapter 均被调用且产物被持久化
        expect(r1.agentRunCount).toBe(1);
        expect(r2.agentRunCount).toBe(1);
        expect(r1.gitHeadSha).toBe(r2.gitHeadSha);
        expect(r1.memoryRecordIds).toEqual(r2.memoryRecordIds);
        expect(r1.analyzeSummary).toBe(r2.analyzeSummary);
      });
    });
  }

  it("基准任务集数量为 8 个", () => {
    expect(BENCHMARK_FIXTURES.length).toBe(8);
  });

  it("所有基准任务的 Fake Adapter 闭环 pack contentHash 各不相同", async () => {
    const hashes = new Set<string>();
    for (const fixture of BENCHMARK_FIXTURES) {
      const chain = newChain(store, fixture);
      const result = await runBenchmarkChain(
        store,
        fixture,
        `${fixture.id}-hash-test`,
        chain
      );
      hashes.add(result.packContentHash);
    }
    // 8 个不同任务的 contentHash 各不相同
    expect(hashes.size).toBe(BENCHMARK_FIXTURES.length);
  });
});
