/**
 * Adapter 端口定义 —— 见 IMPLEMENTATION_SPEC §6。
 *
 * Core 定义这些接口；packages/adapters 和 packages/store
 * 提供实现。Core 永不导入实现；调用方
 * （apps/api、orchestrator 装配、测试）注入具体 adapter。
 */

import type { CommandSpec, ProjectCommands } from "../domain/project.js";
import type {
  EvidencePackId,
  EvidencePackVersion,
  Hypothesis,
  EvidenceConstraint
} from "../domain/evidence.js";
import type { EvidencePack } from "../domain/evidence.js";
import type { TaskInput } from "../domain/task.js";
import type { RepairRecord } from "../domain/repair-record.js";
import type { ReviewFinding } from "../domain/repair-record.js";
import type { RepositoryInfo } from "../domain/project.js";
import type { OutputTruncation } from "../domain/audit.js";

// ---------------------------------------------------------------------------
// GitAdapter — §6
// ---------------------------------------------------------------------------

export interface CreateWorktreeInput {
  readonly projectId: string;
  readonly repositoryPath: string;
  readonly defaultBranch: string;
  readonly taskId: string;
  /** Developer 可编辑的文件 glob 白名单（相对于 worktree 根目录）。 */
  readonly allowedPaths: readonly string[];
}

export interface Worktree {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommitSha: string;
  readonly allowedPaths: readonly string[];
  readonly createdAt: string;
}

export interface DiffArtifact {
  readonly worktreePath: string;
  readonly patch: string;
  readonly hash: string;
  readonly changedFiles: readonly string[];
  readonly bytes: number;
}

export interface GitQuery {
  readonly repositoryPath: string;
  readonly paths?: readonly string[];
  readonly sinceCommit?: string;
  readonly untilCommit?: string;
  readonly maxCount?: number;
}

export interface GitEvidence {
  readonly commitSha: string;
  readonly author: string;
  readonly authoredAt: string;
  readonly message: string;
  readonly files: readonly string[];
}

/** Blame 查询参数 —— 见 §6、Phase 3 Git 证据采集。 */
export interface BlameQuery {
  readonly repositoryPath: string;
  /** 相对仓库根的路径。 */
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

/** Blame 证据项 —— 每行（或连续行段）对应的提交与作者信息。 */
export interface BlameEvidence {
  readonly commitSha: string;
  readonly author: string;
  /** ISO 8601 时间戳。 */
  readonly authoredAt: string;
  /** [startLine, endLine] 闭区间。 */
  readonly lineRange: readonly [number, number];
  readonly lineContent: string;
}

/**
 * 单条 git 命令的审计信息（P1-03）。
 *
 * 由 LocalGitAdapter 在每次执行 git 命令后通过 GitCommandAuditSink 上报。
 * 应用/编排层消费这些信息，在同一 SQLite 真源追加结构化审计
 * （§7.3：argv、cwd、退出码、输出截断信息）。
 */
export interface GitCommandAudit {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly outputTruncation: OutputTruncation;
}

/**
 * 命令审计收集器（P1-03）。
 *
 * LocalGitAdapter 在执行 git 命令后调用 `record` 上报审计信息。
 * 调用方（WorktreeManager / EvidenceCollector）提供收集器实现，
 * 在 git 操作完成后将收集到的审计写入 SQLite audit_events。
 */
export interface GitCommandAuditSink {
  record(audit: GitCommandAudit): void;
}

export interface GitAdapter {
  /**
   * 校验仓库路径并返回仓库元信息。
   * @param auditSink P1-03：可选的命令审计收集器。
   */
  validateRepository(
    projectPath: string,
    auditSink?: GitCommandAuditSink
  ): Promise<RepositoryInfo>;
  /**
   * 创建受控 worktree。
   * @param auditSink P1-03：可选的命令审计收集器。
   */
  createWorktree(
    input: CreateWorktreeInput,
    auditSink?: GitCommandAuditSink
  ): Promise<Worktree>;
  /**
   * 获取 worktree 内的 diff 产物。
   * @param auditSink P1-03：可选的命令审计收集器。
   */
  getDiff(
    worktreePath: string,
    auditSink?: GitCommandAuditSink
  ): Promise<DiffArtifact>;
  /**
   * 查询仓库历史。
   * @param auditSink P1-03：可选的命令审计收集器。
   */
  getHistory(
    query: GitQuery,
    auditSink?: GitCommandAuditSink
  ): Promise<GitEvidence[]>;
  /**
   * 获取指定文件指定行段的 blame 信息（Phase 3）。
   * @param auditSink P1-03：可选的命令审计收集器。
   */
  getBlame(
    query: BlameQuery,
    auditSink?: GitCommandAuditSink
  ): Promise<BlameEvidence[]>;
  /**
   * 回收已登记的 worktree（受控清理）。
   * @param auditSink P1-03：可选的命令审计收集器。
   */
  removeRegisteredWorktree(
    worktree: Worktree,
    auditSink?: GitCommandAuditSink
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// RuntimeAdapter — §6 (analyze / develop / review / cancel)
// ---------------------------------------------------------------------------

export interface RuntimeTaskInput {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly allowedPaths: readonly string[];
  readonly evidencePackId: EvidencePackId;
  readonly evidencePackVersion: EvidencePackVersion;
  readonly taskInput: TaskInput;
  /**
   * 项目登记的命令白名单（test / lint / typecheck / build）。
   *
   * P4：OmpAdapter 在 prompt 中嵌入这些命令，告知 omp 可用的项目命令
   * 及其固定 argv。LocalCommandAdapter 用它校验 omp 执行的命令是否
   * 在白名单内。每个任务的 projectCommands 来自其所属 Project，
   * 由 ExecutionOrchestrator 加载并传入。
   */
  readonly projectCommands: ProjectCommands;
}

export interface ReviewTaskInput {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly evidencePackId: EvidencePackId;
  readonly evidencePackVersion: EvidencePackVersion;
  /** Reviewer 实际消费的不可变 Evidence Pack 快照，而不是只有其 ID。 */
  readonly evidencePack: EvidencePack;
  readonly taskInput: TaskInput;
  readonly diff: DiffArtifact;
  readonly verificationResult: unknown;
  readonly acceptanceCriteria: readonly string[];
}

export type RuntimeEvent =
  | { readonly type: "started"; readonly runId: string; readonly taskId: string; readonly at: string }
  | { readonly type: "tool_call"; readonly runId: string; readonly tool: string; readonly argv?: readonly string[]; readonly cwd?: string; readonly at: string }
  | { readonly type: "tool_result"; readonly runId: string; readonly exitCode?: number; readonly truncated: boolean; readonly bytes: number; readonly at: string }
  | { readonly type: "progress"; readonly runId: string; readonly message: string; readonly at: string }
  | { readonly type: "completed"; readonly runId: string; readonly at: string; readonly summary: string }
  | { readonly type: "error"; readonly runId: string; readonly at: string; readonly message: string };

export interface ReviewResult {
  readonly verdict: "ship" | "ship_with_fixes" | "block";
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly summary: string;
  /**
   * Reviewer 选择的 Pack hypothesis。Core 会要求其 text、confidence 与
   * evidenceIds 精确匹配当前不可变 Pack，禁止模型临时新造正式根因。
   */
  readonly rootCause?: Hypothesis;
  /** Reviewer 对本次修改的结构化摘要；缺失时使用 summary。 */
  readonly fixSummary?: string;
  /** 只能引用当前 Pack 中已登记且带 Evidence ID 的约束。 */
  readonly applicabilityConditions?: readonly EvidenceConstraint[];
}

export interface RuntimeAdapter {
  /**
   * 读取 / 搜索仓库以收集证据。以流式返回事件。
   *
   * P1-R02（Phase 4 第三轮验收 §7.3）：可选的 `signal` 允许调用方
   * （ExecutionOrchestrator）在 Runtime 启动前或运行中取消执行。
   * 实现必须：
   * - 在启动子进程前检查 `signal.aborted`，若已 aborted 则直接 yield
   *   `error` 事件，不启动子进程；
   * - 把 `signal` 透传给 ProcessRunner，signal abort 时终止子进程树；
   * - 在事件流消费过程中检查 `signal.aborted`，若已 aborted 则停止
   *   yield 并清理资源。
   *
   * 这使取消 API 能在 Runtime 产出 `started` 事件前就阻止其启动，
   * 解决注册前竞态（§7.3 第 1 点）。
   */
  analyze(input: RuntimeTaskInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent>;
  /**
   * 修改 worktree 内的文件。以流式返回事件。
   *
   * P1-R02：与 `analyze` 相同的 `signal` 语义。
   */
  develop(input: RuntimeTaskInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent>;
  /**
   * 基于 diff + 验证结果进行独立审查。
   *
   * P1-R02（Phase 4 第三轮验收 §7.3 第 2 点）：可选的 `signal` 允许
   * 取消 API 在 REVIEWING 阶段终止 review 进程。实现必须把 `signal`
   * 透传给 ProcessRunner，signal abort 时终止子进程树并抛出
   * `AbortError`（或等价错误）。
   *
   * review 的 runId 由实现通过 `started` 事件产出；ExecutionOrchestrator
   * 需要为 review 建立可取消的活动运行登记。由于 review 返回
   * `Promise<ReviewResult>` 而非 `AsyncIterable<RuntimeEvent>`，
   * ExecutionOrchestrator 通过 `signal` 实现取消，不再依赖 `cancel(runId)`。
   */
  review(input: ReviewTaskInput, signal?: AbortSignal): Promise<ReviewResult>;
  /** 取消进行中的 run。对未知 runId 调用也必须安全。 */
  cancel(runId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// KnowledgeAdapter — §6 (MVP: SqliteRepairMemoryAdapter + FakeKnowledgeAdapter)
// ---------------------------------------------------------------------------

export interface MemoryQuery {
  readonly projectId: string;
  readonly symptom?: string;
  readonly rootCause?: string;
  readonly maxResults?: number;
  /** 默认仅召回 APPROVED 状态的记录（§5.4）。 */
  readonly minStatus?: "VERIFIED" | "APPROVED";
}

export class MemoryQueryValidationError extends Error {
  constructor(message: string) {
    super(`Repair Memory 查询无效：${message}`);
    this.name = "MemoryQueryValidationError";
  }
}

/** 所有 KnowledgeAdapter 共用的运行时查询边界。 */
export function assertMemoryQuery(query: unknown): asserts query is MemoryQuery {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new MemoryQueryValidationError("query 必须是对象");
  }
  const value = query as Record<string, unknown>;
  if (typeof value.projectId !== "string" || value.projectId.trim().length === 0) {
    throw new MemoryQueryValidationError("projectId 必须是非空字符串");
  }
  if (
    value.minStatus !== undefined &&
    value.minStatus !== "VERIFIED" &&
    value.minStatus !== "APPROVED"
  ) {
    throw new MemoryQueryValidationError("minStatus 只能是 VERIFIED 或 APPROVED");
  }
  if (
    value.maxResults !== undefined &&
    (typeof value.maxResults !== "number" ||
      !Number.isInteger(value.maxResults) ||
      (value.maxResults as number) < 1 ||
      (value.maxResults as number) > 100)
  ) {
    throw new MemoryQueryValidationError("maxResults 必须是 1 到 100 的整数");
  }
  for (const field of ["symptom", "rootCause"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new MemoryQueryValidationError(`${field} 必须是字符串`);
    }
  }
}

export interface KnowledgeAdapter {
  search(query: MemoryQuery): Promise<RepairRecord[]>;
  write(record: RepairRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// ProcessRunner — §6（治理约束的子进程执行）
// ---------------------------------------------------------------------------

export interface ProcessPolicy {
  /** 硬性 wall-clock 时限；超时后 ProcessRunner 会终止子进程。 */
  readonly timeoutMs: number;
  /** 保留的 stdout+stderr 最大字节数；超出部分被截断并标记。 */
  readonly maxOutputBytes: number;
  /** 工作目录必须解析到这些根目录之一内部。 */
  readonly allowedCwdRoots: readonly string[];
  /** 若为 true，`env` 中的环境变量将被透传；否则使用干净的环境。 */
  readonly inheritEnv: boolean;
  /**
   * 当 `inheritEnv=false` 时，仅透传这些**名称**对应的环境变量到子进程。
   *
   * 用于 OmpAdapter 场景：omp 子进程需要 `ANTHROPIC_API_KEY` 等 LLM 凭据
   * 才能调用模型，但不能无差别继承全部 `process.env`（避免泄漏其他敏感
   * 变量）。白名单仅声明变量**名称**，实际值从 `process.env` 读取，
   * 调用方无法通过此字段注入任意值。
   *
   * 当 `inheritEnv=true` 时此字段被忽略（全量透传已包含白名单）。
   * 未定义或空数组时不透传任何额外变量（保持 Phase 1-3 行为）。
   */
  readonly allowedEnvVarNames?: readonly string[];
  /**
   * P1-02（Phase 4 验收）：当为 `true` 时，即使 `allowedEnvVarNames`
   * 包含凭据变量名（匹配 `API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|
   * PRIVATE_KEY` 模式），也拒绝透传该变量。
   *
   * 用于验证命令场景（`pnpm test` / `pytest` 等）：Developer 可修改
   * worktree 中的测试脚本 / package.json / conftest，若验证子进程能读到
   * LLM API key，恶意测试可外传凭据。验证命令的 processPolicy 必须设
   * `disallowCredentialVars=true` 作为纵深防御，即使白名单误含凭据变量
   * 名也能阻止泄漏。
   *
   * omp 子进程的 processPolicy 必须设 `disallowCredentialVars=false`
   * （或不设），否则 omp 拿不到 LLM 凭据无法调用模型。
   *
   * 默认 `false`（向后兼容 Phase 1-3 行为）。
   */
  readonly disallowCredentialVars?: boolean;
}

export interface CommandResult {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly timedOut: boolean;
  /**
   * 取消或超时触发进程树终止时的脱敏结果。自然结束的命令不设置此字段。
   */
  readonly termination?: ProcessTerminationResult;
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface ProcessTerminationResult {
  /** 是否确实发起过终止请求。 */
  readonly requested: boolean;
  /** 使用的终止方式。Windows 生产路径为 taskkill。 */
  readonly method: "taskkill" | "process_group" | "child";
  /** 终止命令是否完成且返回成功。 */
  readonly completed: boolean;
  /** 终止命令的退出码；无法取得时省略。 */
  readonly exitCode?: number;
  /** 失败原因只允许固定类别，不记录命令输出。 */
  readonly failure?: "spawn_error" | "nonzero_exit" | "timeout";
  /** taskkill 失败后是否尝试过直接终止主进程。 */
  readonly fallbackAttempted?: boolean;
}

export interface ProcessRunner {
  /**
   * 执行受治理的子进程。
   *
   * P1-05（Phase 4 验收）：可选的 `abortSignal` 允许调用方在子进程完成前
   * 取消执行。当 signal 被 abort 时，ProcessRunner 必须终止整个进程树
   * （含孙进程），并返回 `timedOut=false` 但 `exitCode` 非 0 的结果，
   * 或抛出 `AbortError`。OmpAdapter.cancel 通过此机制终止进行中的 omp
   * 子进程，而非仅设置内存标记。
   *
   * @param abortSignal 可选的取消信号。未提供时行为与 Phase 1-3 一致。
   */
  run(spec: CommandSpec, cwd: string, policy: ProcessPolicy, abortSignal?: AbortSignal): Promise<CommandResult>;
}
