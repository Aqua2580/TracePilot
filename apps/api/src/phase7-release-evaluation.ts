/**
 * Phase 7 发布级三组评测汇总。
 *
 * 此模块只计算已完成真实任务留下的原始计数；不启动 Omp、不请求 SAG，也不把
 * 本地检索夹具补写成发布成绩。输入不足六个样本时一律拒绝生成结果。
 */

export const PHASE7_RELEASE_EVALUATION_SCHEMA_VERSION = 1;
export const PHASE7_RELEASE_SCENARIOS = ["python-pytest", "node-test"] as const;
export const PHASE7_RELEASE_GROUPS = ["no_memory", "sqlite_memory", "sag_enhanced"] as const;

export type Phase7ReleaseGroupName = (typeof PHASE7_RELEASE_GROUPS)[number];
export type Phase7ReleaseScenarioId = (typeof PHASE7_RELEASE_SCENARIOS)[number];

export interface Phase7ReleaseEvaluationSample {
  readonly group: Phase7ReleaseGroupName;
  readonly scenario: Phase7ReleaseScenarioId;
  /** 三组必须是同一合成仓库基线，防止以不同难度掩盖差异。 */
  readonly repositoryBaseline: string;
  readonly taskClosed: boolean;
  readonly patchAccepted: boolean;
  readonly unsupportedChange: boolean;
  readonly keyEvidenceRecallAt5: number;
  readonly humanInterventionCount: number;
  readonly elapsedMs: number;
  readonly tokenCost: number;
  /** 对应 Omp 任务、人工批准与 Evidence Pack 的可追溯索引。 */
  readonly taskId: string;
  readonly evidencePackId: string;
  readonly approvalAuditId: string;
}

export interface Phase7ReleaseEvaluationGroup {
  readonly name: Phase7ReleaseGroupName;
  readonly sampleCount: number;
  readonly taskClosureRate: number;
  readonly patchAcceptanceRate: number;
  readonly unsupportedChangeRate: number;
  readonly keyEvidenceRecallAt5: number;
  readonly humanInterventions: number;
  readonly elapsedMs: number;
  readonly tokenCost: number;
}

export interface Phase7ReleaseEvaluationResult {
  readonly schemaVersion: 1;
  readonly kind: "phase7_real_resume_release_evaluation";
  readonly repositoryBaseline: string;
  readonly groups: readonly Phase7ReleaseEvaluationGroup[];
  readonly samples: readonly Phase7ReleaseEvaluationSample[];
}

/** 仅接受三组各两个真实任务的完整、可回溯计数。 */
export function summarizePhase7ReleaseEvaluation(
  samples: readonly Phase7ReleaseEvaluationSample[]
): Phase7ReleaseEvaluationResult {
  const expectedCount = PHASE7_RELEASE_GROUPS.length * PHASE7_RELEASE_SCENARIOS.length;
  if (samples.length !== expectedCount) {
    throw new Error(`发布级评测必须提供 ${expectedCount} 个原始样本，实际为 ${samples.length}`);
  }
  const baselines = new Set(samples.map((sample) => sample.repositoryBaseline));
  if (baselines.size !== 1 || ![...baselines][0]) {
    throw new Error("发布级三组评测必须使用同一个非空 repositoryBaseline");
  }
  const unique = new Set(samples.map((sample) => `${sample.group}:${sample.scenario}`));
  if (unique.size !== expectedCount || PHASE7_RELEASE_GROUPS.some((group) =>
    PHASE7_RELEASE_SCENARIOS.some((scenario) => !unique.has(`${group}:${scenario}`)))) {
    throw new Error("发布级评测必须为每个组别完整记录两个相同场景，且不得重复");
  }
  for (const sample of samples) validateSample(sample);

  return {
    schemaVersion: PHASE7_RELEASE_EVALUATION_SCHEMA_VERSION,
    kind: "phase7_real_resume_release_evaluation",
    repositoryBaseline: samples[0]!.repositoryBaseline,
    groups: PHASE7_RELEASE_GROUPS.map((groupName) => summarizeGroup(groupName, samples)),
    samples: [...samples]
  };
}

function validateSample(sample: Phase7ReleaseEvaluationSample): void {
  if (!sample.taskId || !sample.evidencePackId || !sample.approvalAuditId) {
    throw new Error(`发布级样本 ${sample.group}:${sample.scenario} 缺少任务、Evidence Pack 或人工批准审计索引`);
  }
  for (const [name, value] of Object.entries({
    keyEvidenceRecallAt5: sample.keyEvidenceRecallAt5,
    humanInterventionCount: sample.humanInterventionCount,
    elapsedMs: sample.elapsedMs,
    tokenCost: sample.tokenCost
  })) {
    if (!Number.isFinite(value) || value < 0 || (name === "keyEvidenceRecallAt5" && value > 1)) {
      throw new Error(`发布级样本 ${sample.group}:${sample.scenario} 的 ${name} 非法`);
    }
  }
}

function summarizeGroup(
  name: Phase7ReleaseGroupName,
  allSamples: readonly Phase7ReleaseEvaluationSample[]
): Phase7ReleaseEvaluationGroup {
  const samples = allSamples.filter((sample) => sample.group === name);
  const count = samples.length;
  return {
    name,
    sampleCount: count,
    taskClosureRate: rate(samples, (sample) => sample.taskClosed),
    patchAcceptanceRate: rate(samples, (sample) => sample.patchAccepted),
    unsupportedChangeRate: rate(samples, (sample) => sample.unsupportedChange),
    keyEvidenceRecallAt5: samples.reduce((total, sample) => total + sample.keyEvidenceRecallAt5, 0) / count,
    humanInterventions: samples.reduce((total, sample) => total + sample.humanInterventionCount, 0),
    elapsedMs: samples.reduce((total, sample) => total + sample.elapsedMs, 0),
    tokenCost: samples.reduce((total, sample) => total + sample.tokenCost, 0)
  };
}

function rate(
  samples: readonly Phase7ReleaseEvaluationSample[],
  predicate: (sample: Phase7ReleaseEvaluationSample) => boolean
): number {
  return samples.filter(predicate).length / samples.length;
}
