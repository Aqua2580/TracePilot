/**
 * Fake 适配器 — 用于测试与 Phase 2 基准测试夹具。
 *
 * 这些适配器实现与真实适配器相同的端口，但使用确定性的内存行为。
 * 依据 §6：Fake 适配器与真实适配器必须通过相同的契约测试套件
 * （成功 / 失败 / 取消 / 超时 / 输出格式）。
 * Phase 2 将落地契约测试；Phase 1 仅交付 fake 适配器本身。
 */

import { randomId } from "@tracepilot/core";
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
  constructor(private readonly behaviour: FakeRuntimeBehaviour = {}) {}

  async *analyze(input: RuntimeTaskInput): AsyncIterable<RuntimeEvent> {
    const runId = randomId("run");
    this.runs.add(runId);
    const at = new Date().toISOString();
    yield { type: "started", runId, taskId: input.taskId, at };

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

  async *develop(input: RuntimeTaskInput): AsyncIterable<RuntimeEvent> {
    const runId = randomId("run");
    this.runs.add(runId);
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    const n = this.behaviour.developProgressEvents ?? 1;
    for (let i = 0; i < n; i++) {
      if (this.cancelled.has(runId)) {
        yield {
          type: "error",
          runId,
          at: new Date().toISOString(),
          message: "cancelled"
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

  async review(input: ReviewTaskInput): Promise<ReviewResult> {
    return {
      verdict: this.behaviour.reviewVerdict ?? "ship",
      findings: this.behaviour.reviewFindings ?? [],
      summary: `FakeRuntimeAdapter review of ${input.diff.changedFiles.length} files`
    };
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
  }
}

// ---------------------------------------------------------------------------
// FakeKnowledgeAdapter — §6（必须与 SqliteRepairMemoryAdapter 通过相同契约）
// ---------------------------------------------------------------------------

export class FakeKnowledgeAdapter implements KnowledgeAdapter {
  private readonly records = new Map<string, RepairRecord>();

  async search(query: MemoryQuery): Promise<RepairRecord[]> {
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

    // 若提供 symptom / rootCause，则做朴素的文本匹配。
    if (query.symptom) {
      const s = query.symptom.toLowerCase();
      results = results.filter(
        (r) => r.symptom.toLowerCase().includes(s) || r.rootCause.toLowerCase().includes(s)
      );
    }
    if (query.rootCause) {
      const s = query.rootCause.toLowerCase();
      results = results.filter((r) => r.rootCause.toLowerCase().includes(s));
    }

    return results.slice(0, query.maxResults ?? 10);
  }

  async write(record: RepairRecord): Promise<void> {
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

  async validateRepository(projectPath: string): Promise<RepositoryInfo> {
    return {
      repositoryPath: projectPath,
      defaultBranch: "main",
      headCommitSha: "fake-sha-0001",
      isClean: true
    };
  }
  async createWorktree(input: CreateWorktreeInput): Promise<Worktree> {
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
    return {
      worktreePath,
      patch,
      hash: `sha256-${patch.length}`,
      changedFiles: patch ? ["src/fake.ts"] : [],
      bytes: patch.length
    };
  }
  async getHistory(_query: GitQuery): Promise<GitEvidence[]> {
    return [];
  }
  async removeRegisteredWorktree(worktree: Worktree): Promise<void> {
    this.worktrees.delete(worktree.id);
  }
  /** 仅用于测试的辅助方法，用于控制 getDiff 输出。 */
  setDiff(worktreePath: string, patch: string): void {
    this.diffPatches.set(worktreePath, patch);
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
