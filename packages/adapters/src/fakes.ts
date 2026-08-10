/**
 * Fake 适配器 — 用于测试与 Phase 2 基准测试夹具。
 *
 * 这些适配器实现与真实适配器相同的端口，但使用确定性的内存行为。
 * 依据 §6：Fake 适配器与真实适配器必须通过相同的契约测试套件
 * （成功 / 失败 / 取消 / 超时 / 输出格式）。
 * Phase 2 将落地契约测试；Phase 1 仅交付 fake 适配器本身。
 */

import { isAbsolute } from "node:path";
import {
  assertMemoryQuery,
  assertRepairRecordForKnowledgeWrite,
  randomId,
  RepairMemoryWriteError
} from "@tracepilot/core";
import type {
  RuntimeAdapter,
  RuntimeTaskInput,
  ReviewTaskInput,
  RuntimeEvent,
  ReviewResult,
  KnowledgeAdapter,
  MemoryQuery,
  RepairRecord,
  GitAdapter,
  RepositoryInfo,
  CreateWorktreeInput,
  Worktree,
  DiffArtifact,
  GitQuery,
  GitEvidence,
  BlameQuery,
  BlameEvidence,
  CommandSpec,
  ProcessRunner,
  ProcessPolicy,
  CommandResult
} from "@tracepilot/core";

// ---------------------------------------------------------------------------
// FakeRuntimeAdapter
// ---------------------------------------------------------------------------

export interface FakeRuntimeBehaviour {
  /** 若设置，develop() 会发出指定数量的合成 progress 事件。 */
  readonly developProgressEvents?: number;
  /** 若设置，review() 返回该 verdict；默认为 "ship"。 */
  readonly reviewVerdict?: ReviewResult["verdict"];
  /** 若设置，review() 返回这些 findings；默认为空。 */
  readonly reviewFindings?: ReviewResult["findings"];
  /** 若设置，analyze() 抛出该错误事件并停止。 */
  readonly analyzeError?: string;
}

export class FakeRuntimeAdapter implements RuntimeAdapter {
  private readonly runs = new Set<string>();
  private readonly cancelled = new Set<string>();
  /** 测试可读取的最后一次 Review 输入，用于验证 Pack 快照未被丢弃。 */
  lastReviewInput: ReviewTaskInput | undefined;
  constructor(private readonly behaviour: FakeRuntimeBehaviour = {}) {}

  async *analyze(input: RuntimeTaskInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runId = randomId("run");
    this.runs.add(runId);
    const at = new Date().toISOString();

    // P1-R02：signal 在 started 前 aborted → 直接 yield error，不启动 Runtime。
    if (signal?.aborted) {
      yield { type: "started", runId, taskId: input.taskId, at };
      yield {
        type: "error",
        runId,
        at: new Date().toISOString(),
        message: "cancelled before analyze start (signal aborted)"
      };
      return;
    }

    yield { type: "started", runId, taskId: input.taskId, at };

    if (signal?.aborted) {
      yield {
        type: "error",
        runId,
        at: new Date().toISOString(),
        message: "cancelled during analyze (signal aborted after start)"
      };
      return;
    }

    if (this.behaviour.analyzeError) {
      yield {
        type: "error",
        runId,
        at: new Date().toISOString(),
        message: this.behaviour.analyzeError
      };
      return;
    }
    yield {
      type: "progress",
      runId,
      message: "FakeRuntimeAdapter.analyze: synthesised evidence",
      at: new Date().toISOString()
    };
    yield {
      type: "completed",
      runId,
      at: new Date().toISOString(),
      summary: "fake analyze complete"
    };
  }

  async *develop(input: RuntimeTaskInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runId = randomId("run");
    this.runs.add(runId);

    // P1-R02：signal 在 started 前 aborted → 直接 yield error，不启动 Runtime。
    if (signal?.aborted) {
      yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
      yield {
        type: "error",
        runId,
        at: new Date().toISOString(),
        message: "cancelled before develop start (signal aborted)"
      };
      return;
    }

    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    const n = this.behaviour.developProgressEvents ?? 1;
    for (let i = 0; i < n; i++) {
      // P1-R02：检查外部 signal 和内部 cancel 标记
      if (signal?.aborted || this.cancelled.has(runId)) {
        yield {
          type: "error",
          runId,
          at: new Date().toISOString(),
          message: signal?.aborted ? "cancelled (signal aborted)" : "cancelled"
        };
        return;
      }
      yield {
        type: "progress",
        runId,
        message: `fake develop progress ${i + 1}/${n}`,
        at: new Date().toISOString()
      };
    }
    yield {
      type: "completed",
      runId,
      at: new Date().toISOString(),
      summary: "fake develop complete"
    };
  }

  async review(input: ReviewTaskInput, signal?: AbortSignal): Promise<ReviewResult> {
    // P1-R02：signal 在 review 前/中 aborted → 抛 AbortError
    if (signal?.aborted) {
      throw new Error("review cancelled (signal aborted)");
    }
    this.lastReviewInput = input;
    return {
      verdict: this.behaviour.reviewVerdict ?? "ship",
      findings: this.behaviour.reviewFindings ?? [],
      summary: `FakeRuntimeAdapter review of ${input.diff.changedFiles.length} files`,
      ...(input.evidencePack.hypotheses[0]
        ? { rootCause: input.evidencePack.hypotheses[0] }
        : {}),
      applicabilityConditions: [...input.evidencePack.constraints]
    };
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }
}

// ---------------------------------------------------------------------------
// FakeKnowledgeAdapter — §6（必须与 SqliteRepairMemoryAdapter 通过相同契约）
// ---------------------------------------------------------------------------

export interface FakeKnowledgeAdapterOptions {
  /** 可选的外键存在性检查；契约测试用它模拟关系型存储约束。 */
  readonly referenceExists?: (
    projectId: string,
    taskId: string
  ) => boolean | Promise<boolean>;
  /** 可选的项目存在性检查；与 taskProjectId 配合模拟项目外键。 */
  readonly projectExists?: (projectId: string) => boolean | Promise<boolean>;
  /** 返回任务真实所属项目；undefined 表示任务不存在。 */
  readonly taskProjectId?: (
    taskId: string
  ) => string | undefined | Promise<string | undefined>;
}

export class FakeKnowledgeAdapter implements KnowledgeAdapter {
  private readonly records = new Map<string, RepairRecord>();

  constructor(private readonly options: FakeKnowledgeAdapterOptions = {}) {}

  async search(query: MemoryQuery): Promise<RepairRecord[]> {
    assertMemoryQuery(query);
    const minStatus = query.minStatus ?? "APPROVED";
    const statusOrder: RepairRecord["status"][] = ["DRAFT", "VERIFIED", "APPROVED", "DEPRECATED"];
    const minIdx = statusOrder.indexOf(minStatus);

    let results = [...this.records.values()].filter((r) => {
      if (r.projectId !== query.projectId) return false;
      // 状态过滤：仅返回处于或高于 minStatus 层级的记录。
      const idx = statusOrder.indexOf(r.status);
      // APPROVED（idx 2）为默认最小值；VERIFIED（idx 1）低于它。
      // 仅当 minStatus 为 VERIFIED 时才包含 VERIFIED；否则仅包含 APPROVED。
      if (minStatus === "APPROVED" && r.status !== "APPROVED") return false;
      if (minStatus === "VERIFIED" && !(r.status === "VERIFIED" || r.status === "APPROVED")) return false;
      void idx; void minIdx;
      return true;
    });

    // 召回规则与 SQLite 实现保持一致：项目隔离、文本过滤、确定性
    // 相关性排序，最后按更新时间和 id 稳定打破平局。
    const symptom = query.symptom?.trim().toLocaleLowerCase();
    const rootCause = query.rootCause?.trim().toLocaleLowerCase();
    results = results.filter((record) => {
      if (symptom && !record.symptom.toLocaleLowerCase().includes(symptom) && !record.rootCause.toLocaleLowerCase().includes(symptom)) {
        return false;
      }
      if (rootCause && !record.rootCause.toLocaleLowerCase().includes(rootCause)) {
        return false;
      }
      return true;
    });
    const score = (record: RepairRecord): number => {
      const recordSymptom = record.symptom.toLocaleLowerCase();
      const recordRootCause = record.rootCause.toLocaleLowerCase();
      let value = 0;
      if (symptom) {
        if (recordSymptom === symptom) value += 100;
        else if (recordSymptom.includes(symptom)) value += 60;
        if (recordRootCause.includes(symptom)) value += 30;
      }
      if (rootCause) {
        if (recordRootCause === rootCause) value += 100;
        else if (recordRootCause.includes(rootCause)) value += 60;
      }
      return value;
    };
    results.sort((left, right) => {
      const scoreDelta = score(right) - score(left);
      if (scoreDelta !== 0) return scoreDelta;
      const timeDelta = right.updatedAt.localeCompare(left.updatedAt);
      return timeDelta !== 0 ? timeDelta : left.id.localeCompare(right.id);
    });

    const limit = query.maxResults ?? 10;
    return limit > 0 ? results.slice(0, limit) : [];
  }

  async write(record: RepairRecord): Promise<void> {
    assertRepairRecordForKnowledgeWrite(record);
    if (this.options.taskProjectId) {
      const [projectExists, taskProjectId] = await Promise.all([
        this.options.projectExists?.(record.projectId) ?? true,
        this.options.taskProjectId(record.taskId)
      ]);
      if (!projectExists || taskProjectId === undefined) {
        throw new RepairMemoryWriteError(
          "missing_reference",
          `projectId=${record.projectId} 或 taskId=${record.taskId} 不存在`
        );
      }
      if (taskProjectId !== record.projectId) {
        throw new RepairMemoryWriteError(
          "project_mismatch",
          `taskId=${record.taskId} 实际属于 projectId=${taskProjectId}，不能写入 projectId=${record.projectId}`
        );
      }
    } else if (
      this.options.referenceExists &&
      !(await this.options.referenceExists(record.projectId, record.taskId))
    ) {
      throw new RepairMemoryWriteError(
        "missing_reference",
        `projectId=${record.projectId} 或 taskId=${record.taskId} 不存在`
      );
    }

    const existing = this.records.get(record.id);
    if (
      existing &&
      (existing.projectId !== record.projectId || existing.taskId !== record.taskId)
    ) {
      throw new RepairMemoryWriteError(
        "identity_mismatch",
        `Repair Record ${record.id} 的 projectId/taskId 身份不可变`
      );
    }
    this.records.set(record.id, record);
  }

  /** 仅用于测试的辅助方法，用于为 fake 注入种子数据。 */
  seed(records: RepairRecord[]): void {
    for (const r of records) this.records.set(r.id, r);
  }
}

// ---------------------------------------------------------------------------
// FakeGitAdapter — 用于测试；从不接触真实 git 二进制。
// ---------------------------------------------------------------------------

export class FakeGitAdapter implements GitAdapter {
  private readonly worktrees = new Map<string, Worktree>();
  private readonly diffPatches = new Map<string, string>();
  private readonly changedFilesOverrides = new Map<string, string[]>();
  private readonly historyMap = new Map<string, GitEvidence[]>();
  private readonly blameMap = new Map<string, BlameEvidence[]>();
  private repositoryInfoOverride: RepositoryInfo | undefined;

  async validateRepository(projectPath: string): Promise<RepositoryInfo> {
    if (this.repositoryInfoOverride) {
      return this.repositoryInfoOverride;
    }
    return {
      repositoryPath: projectPath,
      defaultBranch: "main",
      headCommitSha: "fake-sha-0001",
      isClean: true
    };
  }
  async createWorktree(input: CreateWorktreeInput): Promise<Worktree> {
    // 校验 taskId 不含路径穿越片段，与 LocalGitAdapter 保持一致
    if (input.taskId.includes("..") || isAbsolute(input.taskId)) {
      throw new Error(`taskId 含非法路径片段: ${input.taskId}`);
    }
    const wt: Worktree = {
      id: randomId("wt"),
      projectId: input.projectId,
      taskId: input.taskId,
      path: `/fake/worktrees/${input.taskId}`,
      branch: `tp/${input.taskId}`,
      baseCommitSha: "fake-sha-0001",
      allowedPaths: input.allowedPaths,
      createdAt: new Date().toISOString()
    };
    this.worktrees.set(wt.id, wt);
    return wt;
  }
  async getDiff(worktreePath: string): Promise<DiffArtifact> {
    const patch = this.diffPatches.get(worktreePath) ?? "";
    const override = this.changedFilesOverrides.get(worktreePath);
    return {
      worktreePath,
      patch,
      hash: `sha256-${patch.length}`,
      changedFiles: override ?? (patch ? ["src/fake.ts"] : []),
      bytes: patch.length
    };
  }
  async getHistory(query: GitQuery): Promise<GitEvidence[]> {
    // 优先返回通过 setHistory 注入的数据；未注入时返回空数组。
    // 先按 repositoryPath 精确匹配，再回退到 setHistory 默认键（""）。
    const key = query.repositoryPath;
    return this.historyMap.get(key) ?? this.historyMap.get("") ?? [];
  }
  async getBlame(query: BlameQuery): Promise<BlameEvidence[]> {
    // 优先返回通过 setBlame 注入的数据；未注入时返回确定性结构。
    const injected = this.blameMap.get(query.path);
    if (injected) return injected;
    return [
      {
        commitSha: "fake-sha-0001",
        author: "Fake Author",
        authoredAt: "2026-01-01T00:00:00.000Z",
        lineRange: [1, 1],
        lineContent: "fake line content"
      }
    ];
  }
  async removeRegisteredWorktree(worktree: Worktree): Promise<void> {
    // 校验 worktree 已登记，与 LocalGitAdapter 的受控根目录校验对齐
    if (!this.worktrees.has(worktree.id)) {
      throw new Error(`worktree 未登记，无法回收: ${worktree.id}`);
    }
    this.worktrees.delete(worktree.id);
  }
  /** 仅用于测试的辅助方法，用于控制 getDiff 输出。 */
  setDiff(worktreePath: string, patch: string): void {
    this.diffPatches.set(worktreePath, patch);
  }
  /**
   * 仅用于测试的辅助方法，覆盖 getDiff 返回的 changedFiles。
   *
   * 用于 P1-R01 路径范围越界测试：让 FakeGitAdapter 返回不在
   * Plan.allowedPaths 内的变更路径，验证 runDevelop 的核心层校验。
   */
  setChangedFiles(worktreePath: string, changedFiles: string[]): void {
    this.changedFilesOverrides.set(worktreePath, changedFiles);
  }
  /** 仅用于测试的辅助方法，注入 getHistory 返回的数据。 */
  setHistory(history: GitEvidence[]): void {
    // 用空字符串键作为默认 repositoryPath 的占位，匹配任意未指定路径的查询。
    this.historyMap.set("", history);
  }
  /** 仅用于测试的辅助方法，按 path 注入 getBlame 返回的数据。 */
  setBlame(path: string, blame: BlameEvidence[]): void {
    this.blameMap.set(path, blame);
  }
  /** 仅用于测试的辅助方法，覆盖 validateRepository 返回的 RepositoryInfo。 */
  setRepositoryInfo(info: RepositoryInfo): void {
    this.repositoryInfoOverride = info;
  }
}

// ---------------------------------------------------------------------------
// FakeProcessRunner — 用于测试；从不派生真实子进程。
// ---------------------------------------------------------------------------

export class FakeProcessRunner implements ProcessRunner {
  private readonly results = new Map<string, CommandResult>();
  private readonly invocations: Array<{ spec: CommandSpec; cwd: string; policy: ProcessPolicy }> = [];

  async run(spec: CommandSpec, cwd: string, policy: ProcessPolicy): Promise<CommandResult> {
    this.invocations.push({ spec, cwd, policy });
    const key = spec.argv.join(" ");
    const preset = this.results.get(key);
    if (preset) return preset;
    return {
      argv: spec.argv,
      cwd,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      originalBytes: 0,
      retainedBytes: 0,
      timedOut: false,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString()
    };
  }
  /** 仅用于测试：为以空格连接的 argv 预设结果。 */
  setResult(argvJoined: string, result: CommandResult): void {
    this.results.set(argvJoined, result);
  }
  /** 仅用于测试：检视被调用内容。 */
  getInvocations(): readonly { spec: CommandSpec; cwd: string; policy: ProcessPolicy }[] {
    return this.invocations;
  }
}
