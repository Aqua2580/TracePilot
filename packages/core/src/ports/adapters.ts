/**
 * Adapter 端口定义 —— 见 IMPLEMENTATION_SPEC §6。
 *
 * Core 定义这些接口；packages/adapters 和 packages/store
 * 提供实现。Core 永不导入实现；调用方
 * （apps/api、orchestrator 装配、测试）注入具体 adapter。
 */

import type { CommandSpec } from "../domain/project.js";
import type {
  EvidencePackId,
  EvidencePackVersion
} from "../domain/evidence.js";
import type { TaskInput } from "../domain/task.js";
import type { RepairRecord } from "../domain/repair-record.js";
import type { RepositoryInfo } from "../domain/project.js";

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

export interface GitAdapter {
  validateRepository(projectPath: string): Promise<RepositoryInfo>;
  createWorktree(input: CreateWorktreeInput): Promise<Worktree>;
  getDiff(worktreePath: string): Promise<DiffArtifact>;
  getHistory(query: GitQuery): Promise<GitEvidence[]>;
  removeRegisteredWorktree(worktree: Worktree): Promise<void>;
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
}

export interface ReviewTaskInput {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly evidencePackId: EvidencePackId;
  readonly evidencePackVersion: EvidencePackVersion;
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
  readonly findings: ReadonlyArray<{
    readonly priority: "P0" | "P1" | "P2" | "P3";
    readonly confidence: number;
    readonly message: string;
    readonly locator?: string;
  }>;
  readonly summary: string;
}

export interface RuntimeAdapter {
  /** 读取 / 搜索仓库以收集证据。以流式返回事件。 */
  analyze(input: RuntimeTaskInput): AsyncIterable<RuntimeEvent>;
  /** 修改 worktree 内的文件。以流式返回事件。 */
  develop(input: RuntimeTaskInput): AsyncIterable<RuntimeEvent>;
  /** 基于 diff + 验证结果进行独立审查。 */
  review(input: ReviewTaskInput): Promise<ReviewResult>;
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
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface ProcessRunner {
  run(spec: CommandSpec, cwd: string, policy: ProcessPolicy): Promise<CommandResult>;
}
