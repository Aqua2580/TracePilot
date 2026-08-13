/**
 * Phase 7 本地可复算检索评测。
 *
 * 此文件的 SQLite 组会创建临时真实 SQLite、应用全部迁移，并经
 * SqliteRepairMemoryAdapter 查询；SAG 组以同一 SQLite 为真源，只用内存
 * 传输替身提供排序提示。它仍是无模型、无真实 SAG 的本地契约基线。
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SagKnowledgeAdapter } from "@tracepilot/adapters";
import {
  computePackContentHash,
  type EvidencePack,
  type Project,
  type RepairRecord,
  type SagMirrorTransport,
  type Task
} from "@tracepilot/core";
import { BENCHMARK_FIXTURES, createSqliteStore } from "@tracepilot/store";

export const PHASE7_EVALUATION_SCHEMA_VERSION = 3;
export const PHASE7_EVALUATION_SUITE_VERSION = "phase2-fixed-8@2026-08-13";
const EVALUATION_PROJECT_ID = "phase7-evaluation-project";
const EVALUATION_SOURCE_ID = "phase7-evaluation-source";

export const PHASE7_EVALUATION_INPUT_HASH = `sha256-${createHash("sha256")
  .update(JSON.stringify(BENCHMARK_FIXTURES.map((fixture) => ({
    id: fixture.id,
    taskInput: fixture.taskInput,
    expectedEvidenceCount: fixture.expectedEvidenceCount,
    expectedPlanNodeCount: fixture.expectedPlanNodeCount
  }))))
  .digest("hex")}`;

export interface Phase7EvaluationConfiguration {
  readonly schemaVersion: 3;
  readonly suiteVersion: string;
  readonly inputHash: string;
  readonly repositoryBaseline: "合成固定夹具；无真实仓库 SHA";
  readonly promptVersion: "不调用模型";
  readonly model: null;
  readonly temperature: null;
  readonly randomSeed: "确定性排序；无随机采样";
  readonly adapterByGroup: Readonly<Record<Phase7EvaluationGroup["name"], string>>;
  readonly authorization: "不调用 Omp、本机 SAG 或外部模型";
}

export interface Phase7EvaluationSample {
  readonly id: string;
  readonly objective: string;
  readonly expectedKind: "repair_record";
  readonly expectedLocator: string;
  readonly noMemory: readonly string[];
  readonly sqliteMemory: readonly string[];
  readonly sagEnhanced: readonly string[];
}

export interface Phase7EvaluationGroup {
  readonly name: "no_memory" | "sqlite_memory" | "sag_enhanced";
  readonly sampleCount: number;
  readonly keyEvidenceRecallAt5: number;
  /** 本地检索夹具不执行任务；null 表示未测量。 */
  readonly taskClosureRate: null;
  readonly patchAcceptanceRate: null;
  readonly unsupportedChangeRate: null;
  readonly humanInterventions: null;
  readonly elapsedMs: null;
  readonly tokenCost: null;
}

export interface Phase7EvaluationResult {
  readonly schemaVersion: 3;
  readonly kind: "phase7_local_retrieval_fixture";
  readonly configuration: Phase7EvaluationConfiguration;
  readonly samples: readonly Phase7EvaluationSample[];
  readonly groups: readonly Phase7EvaluationGroup[];
  readonly limitations: readonly string[];
}

export const PHASE7_EVALUATION_CONFIGURATION: Phase7EvaluationConfiguration = {
  schemaVersion: PHASE7_EVALUATION_SCHEMA_VERSION,
  suiteVersion: PHASE7_EVALUATION_SUITE_VERSION,
  inputHash: PHASE7_EVALUATION_INPUT_HASH,
  repositoryBaseline: "合成固定夹具；无真实仓库 SHA",
  promptVersion: "不调用模型",
  model: null,
  temperature: null,
  randomSeed: "确定性排序；无随机采样",
  adapterByGroup: {
    no_memory: "显式空结果；不创建 Memory Adapter",
    sqlite_memory: "临时真实 SQLite 迁移 + SqliteRepairMemoryAdapter",
    sag_enhanced: "SagKnowledgeAdapter；底层为同一临时真实 SQLite，内存传输只重排真源"
  },
  authorization: "不调用 Omp、本机 SAG 或外部模型"
};

/** 同一版本化输入实际经过三种检索配置；每个样本都使用独立临时 SQLite。 */
export async function runPhase7MemoryModeEvaluation(): Promise<Phase7EvaluationResult> {
  const samples: Phase7EvaluationSample[] = [];
  for (const fixture of BENCHMARK_FIXTURES) samples.push(await evaluateFixture(fixture.id));
  return {
    schemaVersion: PHASE7_EVALUATION_SCHEMA_VERSION,
    kind: "phase7_local_retrieval_fixture",
    configuration: PHASE7_EVALUATION_CONFIGURATION,
    samples,
    groups: evaluatePhase7MemoryModes(samples),
    limitations: [
      "固定合成夹具，不调用真实 SAG、Omp、模型或人工审批",
      "SAG 组是内存传输契约替身，只证明真实 SQLite 真源重排边界，不代表真实本机 SAG 连通性或质量",
      "仅衡量同项目已核验来源 Recall@5；发布级任务闭环、Patch、人工、耗时和费用指标须由受授权真实门禁另行产出",
      "所有 null 指标均表示本地检索夹具未测量，不表示零"
    ]
  };
}

export function evaluatePhase7MemoryModes(samples: readonly Phase7EvaluationSample[]): readonly Phase7EvaluationGroup[] {
  return [
    group("no_memory", samples, (sample) => sample.noMemory),
    group("sqlite_memory", samples, (sample) => sample.sqliteMemory),
    group("sag_enhanced", samples, (sample) => sample.sagEnhanced)
  ];
}

async function evaluateFixture(fixtureId: string): Promise<Phase7EvaluationSample> {
  const fixture = BENCHMARK_FIXTURES.find((item) => item.id === fixtureId);
  if (!fixture) throw new Error(`缺少固定评测夹具：${fixtureId}`);
  const directory = mkdtempSync(join(tmpdir(), "tracepilot-phase7-evaluation-"));
  const store = createSqliteStore({ dbPath: join(directory, "evaluation.db") });
  try {
    const records = createEvaluationRecords();
    await seedSqliteEvaluationRecords(store, records);
    const query = { projectId: EVALUATION_PROJECT_ID, symptom: "phase7-synthetic", maxResults: 5 };
    const transport: SagMirrorTransport = {
      upsertRepairRecord: async () => undefined,
      searchRepairRecordIds: async () => [fixture.id, ...records.map((record) => record.id)]
    };
    const sagEnhanced = new SagKnowledgeAdapter({
      sqliteMemory: store.knowledgeAdapter,
      resolveKnowledgeSourceId: async () => EVALUATION_SOURCE_ID,
      transport
    });
    const [sqliteResults, sagResults] = await Promise.all([
      store.knowledgeAdapter.search(query),
      sagEnhanced.search(query)
    ]);
    return {
      id: fixture.id,
      objective: fixture.taskInput.objective,
      expectedKind: "repair_record",
      expectedLocator: toLocator(fixture.id),
      noMemory: [],
      sqliteMemory: sqliteResults.map((record) => toLocator(record.id)),
      sagEnhanced: sagResults.map((record) => toLocator(record.id))
    };
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function createEvaluationRecords(): RepairRecord[] {
  return BENCHMARK_FIXTURES.map((fixture) => ({
    id: fixture.id,
    projectId: EVALUATION_PROJECT_ID,
    taskId: `task-${fixture.id}`,
    status: "APPROVED" as const,
    symptom: "phase7-synthetic",
    rootCause: fixture.taskInput.objective,
    rootCauseConfidence: 1,
    rootCauseEvidenceIds: [`evidence-${fixture.id}`],
    fixSummary: `合成 Repair Record：${fixture.id}`,
    applicabilityConditions: [],
    applicabilityConditionEvidence: [],
    failureReasons: [],
    inputEvidencePackId: `pack-${fixture.id}`,
    inputEvidencePackVersion: 1,
    diffHash: `diff-${fixture.id}`,
    verificationResult: { passed: true, ranCommands: ["synthetic"], exitCodes: { synthetic: 0 } },
    reviewResult: { verdict: "ship", findings: [] },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z"
  }));
}

async function seedSqliteEvaluationRecords(
  store: ReturnType<typeof createSqliteStore>,
  records: readonly RepairRecord[]
): Promise<void> {
  const project: Project = {
    id: EVALUATION_PROJECT_ID,
    name: "Phase 7 SQLite 评测合成项目",
    repositoryPath: "D:/phase7-evaluation-synthetic",
    defaultBranch: "main",
    language: "typescript",
    commands: { test: { argv: ["synthetic"], timeoutMs: 1_000 } },
    knowledgeSourceId: EVALUATION_SOURCE_ID,
    createdAt: "2026-08-13T00:00:00.000Z"
  };
  await store.unitOfWork.run(async (tx) => {
    await tx.projects.save(project);
    for (const record of records) {
      const task: Task = {
        id: record.taskId,
        projectId: record.projectId,
        status: "COMPLETED",
        input: { objective: record.rootCause, constraints: [], acceptanceCriteria: [], riskLevel: "low", rawSource: "synthetic", origin: "issue" },
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      };
      const packWithoutHash = {
        id: record.inputEvidencePackId,
        taskId: record.taskId,
        version: 1,
        taskSnapshot: task.input,
        evidence: [{ id: record.rootCauseEvidenceIds[0]!, kind: "code" as const, source: "synthetic", locator: `fixture:${record.id}`, capturedAt: record.createdAt, contentHash: `hash-${record.id}`, summary: "合成评测来源", relevance: 1, trustLevel: "PRIMARY" as const }],
        hypotheses: [{ text: record.rootCause, confidence: 1, evidenceIds: record.rootCauseEvidenceIds }],
        constraints: [],
        acceptanceCriteria: [],
        createdAt: record.createdAt
      };
      const pack: EvidencePack = { ...packWithoutHash, contentHash: computePackContentHash(packWithoutHash) };
      const trustedRecord = { ...record, inputEvidencePackContentHash: pack.contentHash };
      await tx.tasks.save(task);
      await tx.evidencePacks.save(pack);
      await tx.executionResults.save({ id: `execution-${record.id}`, taskId: record.taskId, runId: `run-${record.id}`, diffHash: record.diffHash!, diffPatch: "synthetic", diffChangedFiles: [], diffBytes: 0, verificationExitCode: 0, verificationPassed: true, verificationStdout: "", verificationStderr: "", createdAt: record.createdAt });
      await tx.repairRecords.save(trustedRecord);
    }
  });
}

function toLocator(recordId: string): string { return `repair-record:${recordId}`; }

function group(name: Phase7EvaluationGroup["name"], samples: readonly Phase7EvaluationSample[], select: (sample: Phase7EvaluationSample) => readonly string[]): Phase7EvaluationGroup {
  const hits = samples.filter((sample) => select(sample).slice(0, 5).includes(sample.expectedLocator)).length;
  return { name, sampleCount: samples.length, keyEvidenceRecallAt5: samples.length === 0 ? 0 : hits / samples.length, taskClosureRate: null, patchAcceptanceRate: null, unsupportedChangeRate: null, humanInterventions: null, elapsedMs: null, tokenCost: null };
}

if (process.argv[1]?.endsWith("phase7-evaluation.js")) {
  void runPhase7MemoryModeEvaluation().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`));
}
