/**
 * Evidence Pack 领域模型 —— 详见 IMPLEMENTATION_SPEC §5.3。
 *
 * Evidence Pack 是一个按版本不可变的快照，被一个任务 / 一个执行轮次中的
 * 所有角色共享。它不能就地编辑；新版本通过 TaskOrchestrator 编排的
 * EvidenceRequest 流程产生。Agent 只能引用当前已批准的版本；临时搜索
 * 结果永远不作为权威依据。
 */

import type { TaskInput } from "./task.js";

export type EvidencePackId = string;
export type EvidencePackVersion = number;

export type EvidenceKind =
  | "code"
  | "git"
  | "runtime"
  | "memory"
  | "policy";

export type TrustLevel = "PRIMARY" | "VERIFIED_MEMORY" | "UNVERIFIED";

export interface EvidenceItem {
  readonly id: string;
  readonly kind: EvidenceKind;
  /** Adapter / 来源名称，例如 "git-history"、"sqlite-memory"、"code-search"。 */
  readonly source: string;
  /** file:line、commit SHA、记录 ID 等。 */
  readonly locator: string;
  readonly capturedAt: string;
  readonly contentHash: string;
  readonly summary: string;
  /** Sort score — NOT a fact-confidence value. */
  readonly relevance: number;
  readonly trustLevel: TrustLevel;
}

export interface Hypothesis {
  readonly text: string;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
}

export interface EvidenceConstraint {
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly required: boolean;
}

export interface EvidencePack {
  readonly id: EvidencePackId;
  readonly taskId: string;
  readonly version: EvidencePackVersion;
  readonly taskSnapshot: TaskInput;
  readonly evidence: readonly EvidenceItem[];
  readonly hypotheses: readonly Hypothesis[];
  readonly constraints: readonly EvidenceConstraint[];
  readonly acceptanceCriteria: readonly string[];
  readonly createdAt: string;
  /** 不可变 payload 的稳定内容哈希 —— 用于审计。 */
  readonly contentHash: string;
}

/**
 * 当 Agent 发现证据不充分时提交的结构化请求。
 * Orchestrator 进行审核，若批准则返回 GATHERING_EVIDENCE 并生成
 * Pack v(n+1)。旧版本永久保留以供审计。
 *
 * §5.3 规则：Agent 不得绕过此流程，将临时搜索结果直接写入根因 /
 * 约束 / Review 结论。
 */
export interface EvidenceRequest {
  readonly id: string;
  readonly taskId: string;
  readonly requesterRole: "planner" | "developer" | "reviewer";
  readonly gapReason: string;
  readonly neededKinds: readonly EvidenceKind[];
  readonly allowedScope: string;
  readonly expectedPlanImpact: string;
  readonly requestedAt: string;
}

export class EvidencePackVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidencePackVersionError";
  }
}

/**
 * 纯工厂：基于上一个 Pack 版本加上新收集的证据构建下一个 Pack 版本。
 * 旧版本从不被修改。版本号单调递增；contentHash 重新计算。
 */
export function nextPackVersion(
  previous: EvidencePack,
  additions: {
    evidence: readonly EvidenceItem[];
    hypotheses?: readonly Hypothesis[];
    constraints?: readonly EvidenceConstraint[];
    acceptanceCriteria?: readonly string[];
  }
): EvidencePack {
  const version = previous.version + 1;
  const evidence = [...previous.evidence, ...additions.evidence];
  const hypotheses = additions.hypotheses
    ? [...previous.hypotheses, ...additions.hypotheses]
    : previous.hypotheses;
  const constraints = additions.constraints
    ? [...previous.constraints, ...additions.constraints]
    : previous.constraints;
  const acceptanceCriteria =
    additions.acceptanceCriteria ?? previous.acceptanceCriteria;

  return {
    id: previous.id,
    taskId: previous.taskId,
    version,
    taskSnapshot: previous.taskSnapshot,
    evidence,
    hypotheses,
    constraints,
    acceptanceCriteria,
    createdAt: new Date().toISOString(),
    contentHash: computePackContentHash({
      id: previous.id,
      taskId: previous.taskId,
      version,
      taskSnapshot: previous.taskSnapshot,
      evidence,
      hypotheses,
      constraints,
      acceptanceCriteria
    })
  };
}

/**
 * 为 Pack payload 计算确定性内容哈希。
 *
 * 此哈希用于审计链路的版本可区分性，不用于任何安全目的。
 * 我们使用纯 JS 的 FNV-1a 32 位哈希，使领域层不引入 `node:crypto`
 * 且可同步运行。（规范仅禁止将 Fastify/React/Drizzle/Git/Pi SDK
 * 引入 Core；我们额外排除 crypto 以保持模块为纯 JS。）
 */
export function computePackContentHash(payload: {
  id: string;
  taskId: string;
  version: EvidencePackVersion;
  taskSnapshot: TaskInput;
  evidence: readonly EvidenceItem[];
  hypotheses: readonly Hypothesis[];
  constraints: readonly EvidenceConstraint[];
  acceptanceCriteria: readonly string[];
}): string {
  // 稳定的 JSON 规范化：键按插入顺序输出，因此我们基于固定形状的对象
  // 构造序列化形式。
  const canonical = JSON.stringify({
    id: payload.id,
    taskId: payload.taskId,
    version: payload.version,
    taskSnapshot: payload.taskSnapshot,
    evidence: payload.evidence,
    hypotheses: payload.hypotheses,
    constraints: payload.constraints,
    acceptanceCriteria: payload.acceptanceCriteria
  } as const);
  return `fnv1a32-${fnv1a32(canonical)}`;
}

/** FNV-1a 32 位哈希，返回 8 字符的小写十六进制。 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV 质数 0x01000193，通过 Math.imul 模 2^32 相乘（32 位）。
    hash = Math.imul(hash, 0x01000193);
  }
  // 强制转为无符号 32 位，再转为十六进制。
  return (hash >>> 0).toString(16).padStart(8, "0");
}
