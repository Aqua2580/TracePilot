/**
 * Phase 7 本地可复算检索评测。
 *
 * 这是发布真实 Omp/SAG 演示前的固定合成基线。三组结果不是预填分数：每个
 * 样本都会实际调用空 Memory、SQLite 契约 Memory 和 SagKnowledgeAdapter。
 * SAG 组使用内存传输替身验证“只能重排 SQLite 真源”的契约，绝不伪造为本机
 * SAG 服务或模型调用的结果。
 */

import { createHash } from "node:crypto";
import {
  FakeKnowledgeAdapter,
  SagKnowledgeAdapter
} from "@tracepilot/adapters";
import type { RepairRecord, SagMirrorTransport } from "@tracepilot/core";
import { BENCHMARK_FIXTURES } from "@tracepilot/store";

export const PHASE7_EVALUATION_SCHEMA_VERSION = 2;
export const PHASE7_EVALUATION_SUITE_VERSION = "phase2-fixed-8@2026-08-13";
const EVALUATION_PROJECT_ID = "phase7-evaluation-project";
const EVALUATION_SOURCE_ID = "phase7-evaluation-source";

/** 合成夹具没有真实仓库；该值是固定输入清单的 SHA-256，而不是伪造 Git SHA。 */
export const PHASE7_EVALUATION_INPUT_HASH = `sha256-${createHash("sha256")
  .update(JSON.stringify(BENCHMARK_FIXTURES.map((fixture) => ({
    id: fixture.id,
    taskInput: fixture.taskInput,
    expectedEvidenceCount: fixture.expectedEvidenceCount,
    expectedPlanNodeCount: fixture.expectedPlanNodeCount
  }))))
  .digest("hex")}`;

export interface Phase7EvaluationConfiguration {
  readonly schemaVersion: 2;
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
  readonly taskClosureRate: null;
  readonly patchAcceptanceRate: null;
  readonly unsupportedChangeRate: null;
  readonly humanInterventions: null;
  readonly elapsedMs: null;
  readonly tokenCost: null;
}

export interface Phase7EvaluationResult {
  readonly schemaVersion: 2;
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
    no_memory: "实际调用空 FakeKnowledgeAdapter",
    sqlite_memory: "实际调用已种入固定 Repair Record 的 FakeKnowledgeAdapter",
    sag_enhanced: "实际调用 SagKnowledgeAdapter；内存传输仅重排同项目 SQLite 真源"
  },
  authorization: "不调用 Omp、本机 SAG 或外部模型"
};

/**
 * 对同一固定输入实际运行三种检索配置。每个样本都重新创建 adapter，防止前一个
 * 样本的内存写入污染后一个样本；所有时间字段和排序输入固定，因此可复算。
 */
export async function runPhase7MemoryModeEvaluation(): Promise<Phase7EvaluationResult> {
  const samples = await Promise.all(BENCHMARK_FIXTURES.map((fixture) => evaluateFixture(fixture.id)));
  return {
    schemaVersion: PHASE7_EVALUATION_SCHEMA_VERSION,
    kind: "phase7_local_retrieval_fixture",
    configuration: PHASE7_EVALUATION_CONFIGURATION,
    samples,
    groups: evaluatePhase7MemoryModes(samples),
    limitations: [
      "固定合成夹具，不调用真实 SAG、Omp、模型或人工审批",
      "SAG 组是内存传输契约替身，只证明 SQLite 真源重排边界，不代表真实本机 SAG 连通性或质量",
      "仅衡量同项目已核验来源 Recall@5，不能推断任务闭环、Patch 验收或修复质量提升",
      "任务闭环率、Patch 验收率、无依据修改率、人工介入次数、耗时和 Token/费用均为 null，表示未测量而不是零"
    ]
  };
}

export function evaluatePhase7MemoryModes(
  samples: readonly Phase7EvaluationSample[]
): readonly Phase7EvaluationGroup[] {
  return [
    group("no_memory", samples, (sample) => sample.noMemory),
    group("sqlite_memory", samples, (sample) => sample.sqliteMemory),
    group("sag_enhanced", samples, (sample) => sample.sagEnhanced)
  ];
}

async function evaluateFixture(fixtureId: string): Promise<Phase7EvaluationSample> {
  const fixture = BENCHMARK_FIXTURES.find((item) => item.id === fixtureId);
  if (!fixture) throw new Error(`缺少固定评测夹具：${fixtureId}`);

  const records = createEvaluationRecords();
  const query = { projectId: EVALUATION_PROJECT_ID, symptom: "phase7-synthetic", maxResults: 5 };
  const emptyMemory = new FakeKnowledgeAdapter();
  const sqliteMemory = new FakeKnowledgeAdapter();
  sqliteMemory.seed(records);
  const sagMemory = new FakeKnowledgeAdapter();
  sagMemory.seed(records);
  const transport: SagMirrorTransport = {
    upsertRepairRecord: async () => undefined,
    searchRepairRecordIds: async () => [fixture.id, ...records.map((record) => record.id)]
  };
  const sagEnhanced = new SagKnowledgeAdapter({
    sqliteMemory: sagMemory,
    resolveKnowledgeSourceId: async () => EVALUATION_SOURCE_ID,
    transport
  });
  const [noMemory, sqliteResults, sagResults] = await Promise.all([
    emptyMemory.search(query),
    sqliteMemory.search(query),
    sagEnhanced.search(query)
  ]);
  return {
    id: fixture.id,
    objective: fixture.taskInput.objective,
    expectedKind: "repair_record",
    expectedLocator: toLocator(fixture.id),
    noMemory: noMemory.map((record) => toLocator(record.id)),
    sqliteMemory: sqliteResults.map((record) => toLocator(record.id)),
    sagEnhanced: sagResults.map((record) => toLocator(record.id))
  };
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
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z"
  }));
}

function toLocator(recordId: string): string {
  return `repair-record:${recordId}`;
}

function group(
  name: Phase7EvaluationGroup["name"],
  samples: readonly Phase7EvaluationSample[],
  select: (sample: Phase7EvaluationSample) => readonly string[]
): Phase7EvaluationGroup {
  const hits = samples.filter((sample) => select(sample).slice(0, 5).includes(sample.expectedLocator)).length;
  return {
    name,
    sampleCount: samples.length,
    keyEvidenceRecallAt5: samples.length === 0 ? 0 : hits / samples.length,
    taskClosureRate: null,
    patchAcceptanceRate: null,
    unsupportedChangeRate: null,
    humanInterventions: null,
    elapsedMs: null,
    tokenCost: null
  };
}

if (process.argv[1]?.endsWith("phase7-evaluation.js")) {
  void runPhase7MemoryModeEvaluation().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
}
