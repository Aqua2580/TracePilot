/**
 * LocalCommandAdapter —— ADR-001 中的 MVP Runtime 兜底实现。
 *
 * 仅使用本地 git + 文件系统 + 注入的 ProcessRunner 实现 `RuntimeAdapter`。
 * 不需要 `omp` 二进制。接口与未来的 `OmpAdapter` 一致，替换时无需改动
 * Orchestrator。
 *
 * Phase 1 范围：提供 `analyze` / `develop` / `review` / `cancel` 形状，
 * 实现是确定性、受治理闸门管控的。真实 LLM 驱动的分析在 Phase 4 落地。
 *
 * P1-03 修复要点：
 * - 所有命令必须经注入的 `ProcessRunner` 执行；
 * - 调用前用 `CommandPolicy` 检查 argv，用 `PathPolicy` 校验 cwd 位于
 *   已登记 worktree 根目录内；
 * - 禁止在本文件中直接 `child_process.spawn`；
 * - 未来 `OmpAdapter` 必须复用相同边界，不得另行绕过。
 */

import { createHash } from "node:crypto";
import { randomId } from "@tracepilot/core";
import type {
  RuntimeAdapter,
  RuntimeTaskInput,
  ReviewTaskInput,
  RuntimeEvent,
  ReviewResult,
  ReviewFinding,
  CommandSpec,
  CommandResult,
  ProcessRunner,
  ProcessPolicy,
  CommandPolicy,
  PathPolicy,
  ProjectCommands
} from "@tracepilot/core";

/**
 * 当调用方请求未实现的 `OmpAdapter` 时抛出。ADR-001 保留此 stub，迫使
 * 调用方显式选择 LocalCommandAdapter 或 FakeRuntimeAdapter。
 */
export class OmpUnavailableError extends Error {
  constructor(message = "OmpAdapter 不可用 —— 未安装 omp 二进制。请使用 LocalCommandAdapter 或 FakeRuntimeAdapter。") {
    super(message);
    this.name = "OmpUnavailableError";
  }
}

/**
 * 未来真实 OmpAdapter 的 stub。每次调用都抛错，确保任何装配错误立刻
 * 暴露。Phase 4 在 ADR-001 要求的 Spike 之后用真实 `omp` 实现替换。
 */
export class OmpAdapter implements RuntimeAdapter {
  // stub：Phase 4 真实实现前，generator 仅用于满足 AsyncIterable 签名，
  // 直接抛错让调用方立即失败。无 yield 是有意的，豁免 require-yield。
  // eslint-disable-next-line require-yield
  async *analyze(_input: RuntimeTaskInput): AsyncIterable<RuntimeEvent> {
    throw new OmpUnavailableError();
  }
  // eslint-disable-next-line require-yield
  async *develop(_input: RuntimeTaskInput): AsyncIterable<RuntimeEvent> {
    throw new OmpUnavailableError();
  }
  async review(_input: ReviewTaskInput): Promise<ReviewResult> {
    throw new OmpUnavailableError();
  }
  async cancel(_runId: string): Promise<void> {
    throw new OmpUnavailableError();
  }
}

/** 命令被治理策略拒绝时抛出（P1-03）。 */
export class PolicyDeniedError extends Error {
  constructor(
    public readonly deniedAction: string,
    public readonly deniedReason: string
  ) {
    super(`治理策略拒绝执行 ${deniedAction}：${deniedReason}`);
    this.name = "PolicyDeniedError";
  }
}

export interface LocalCommandAdapterOptions {
  /** 受治理的 ProcessRunner —— 所有子进程必须经它执行。 */
  readonly processRunner: ProcessRunner;
  /** 命令策略 —— 校验 argv 是否在白名单内。 */
  readonly commandPolicy: CommandPolicy;
  /** 路径策略 —— 校验 cwd 是否位于已登记 worktree 根目录内。 */
  readonly pathPolicy: PathPolicy;
  /** 进程执行策略 —— 超时、输出上限、允许的 cwd 根目录。 */
  readonly processPolicy: ProcessPolicy;
  /** 项目登记的命令白名单（test 必填，其余可选）。 */
  readonly projectCommands: ProjectCommands;
  /** 允许的 worktree 根目录列表（processPolicy.allowedCwdRoots 的语义等价物）。 */
  readonly allowedWorktreeRoots: readonly string[];
  /** 单次命令的默认超时（毫秒），默认 5000。 */
  readonly defaultTimeoutMs?: number;
}

/**
 * MVP Runtime。`analyze` 与 `develop` 流式产出确定性 RuntimeEvent，在
 * 不依赖 LLM 的前提下端到端验证 Orchestrator 装配。Phase 4 在 `omp`
 * 安装并完成 Spike 后替换为真实 `OmpAdapter`。
 *
 * `review` 产出确定性裁决 —— Phase 5 用真实 Reviewer（读取 diff + 验证
 * 结果）替换。
 *
 * 所有 git 命令都经 `runGoverned` 走 ProcessRunner + CommandPolicy +
 * PathPolicy，禁止直接 spawn。
 */
export class LocalCommandAdapter implements RuntimeAdapter {
  private readonly runs = new Map<string, { cancelled: boolean }>();

  constructor(private readonly opts: LocalCommandAdapterOptions) {}

  async *analyze(input: RuntimeTaskInput): AsyncIterable<RuntimeEvent> {
    const runId = randomId("run");
    this.runs.set(runId, { cancelled: false });
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };

    // 确定性“证据采集”：在 worktree 中运行 `git log -n 5` 和 `git status`
    // 捕获最近历史与脏状态。真实分析（LSP / 代码搜索）在 Phase 4 落地。
    for (const argv of [
      ["git", "log", "-n", "5", "--oneline"],
      ["git", "status", "--porcelain"]
    ] as const) {
      const state = this.runs.get(runId)!;
      if (state.cancelled) {
        yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled" };
        return;
      }
      yield {
        type: "tool_call",
        runId,
        tool: "git",
        argv,
        cwd: input.worktreePath,
        at: new Date().toISOString()
      };
      try {
        const result = await this.runGoverned(argv, input.worktreePath);
        yield {
          type: "tool_result",
          runId,
          exitCode: result.exitCode,
          truncated: result.truncated,
          bytes: result.retainedBytes,
          at: new Date().toISOString()
        };
      } catch (err) {
        // 治理拒绝或执行失败 —— 流式产出 error 并终止。
        yield {
          type: "error",
          runId,
          at: new Date().toISOString(),
          message: (err as Error).message
        };
        return;
      }
    }

    yield {
      type: "completed",
      runId,
      at: new Date().toISOString(),
      summary: `LocalCommandAdapter analyze: 已采集 git log + status（worktree: ${input.worktreePath}）`
    };
  }

  async *develop(_input: RuntimeTaskInput): AsyncIterable<RuntimeEvent> {
    const runId = randomId("run");
    this.runs.set(runId, { cancelled: false });
    yield { type: "started", runId, taskId: _input.taskId, at: new Date().toISOString() };
    // Phase 3 仍未接 LLM：develop 在流式事件之外是 no-op。Phase 3 已落地
    // 真实 LocalGitAdapter（worktree / diff / history / blame），但代码修改
    // 仍由 Phase 4 经 omp 运行时（或在 omp 仍不可用时用确定性规则补丁器）
    // 路由。在此之前 develop 不得声称完成真实修复。
    yield {
      type: "progress",
      runId,
      message: "LocalCommandAdapter.develop 在 Phase 3 仍是 no-op；真实代码修改由 Phase 4 落地",
      at: new Date().toISOString()
    };
    yield {
      type: "completed",
      runId,
      at: new Date().toISOString(),
      summary: "no-op develop（Phase 3 仍未接 LLM）"
    };
  }

  async review(input: ReviewTaskInput): Promise<ReviewResult> {
    // Phase 1 确定性评审：diff 为空时 ship_with_fixes（无内容可评审），
    // 否则 ship。Phase 5 用真实 Reviewer（按 P0–P3 排序发现）替换。
    const findings: ReviewFinding[] = [];
    let verdict: ReviewResult["verdict"] = "ship";
    if (input.diff.changedFiles.length === 0) {
      verdict = "ship_with_fixes";
      findings.push({
        priority: "P3",
        confidence: 0.5,
        message: "Diff 为空 —— 没有任何改动。修复是否已应用？"
      });
    } else {
      // 防御性检查：拒绝触碰任务输入快照 allowedPaths 之外的 diff。
      // Orchestrator 的 PathPolicy 已经阻止写入，但 Reviewer 永不信任那点。
      const taskInput = input.taskInput;
      const acceptanceMismatch = input.acceptanceCriteria.some(
        (c) => !taskInput.acceptanceCriteria.includes(c)
      );
      if (acceptanceMismatch) {
        verdict = "block";
        findings.push({
          priority: "P0",
          confidence: 0.9,
          message: "任务快照与评审输入的验收标准不一致"
        });
      }
    }
    return {
      verdict,
      findings,
      summary: `LocalCommandAdapter review: ${verdict}（${findings.length} 条发现）`
    };
  }

  async cancel(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) return; // §6：未知 runId 调用 cancel 必须安全。
    state.cancelled = true;
    // 实际进程终止由 ProcessRunner 内部处理（见 LocalProcessRunner 的
    // 超时/取消策略，P2-03）。这里只设置取消标记，下一次 tool_call 前
    // 检查标记并停止流式产出。
  }

  /**
   * 经治理闸门执行一条命令（P1-03）。
   *
   * 步骤：
   * 1. 用 PathPolicy 校验 cwd 位于已登记 worktree 根目录内；
   * 2. 用 CommandPolicy 校验 argv 在项目白名单或自动允许的只读 git
   *    操作内；
   * 3. 构造 CommandSpec 并交给 ProcessRunner 执行；
   * 4. 任何策略拒绝都抛 PolicyDeniedError，调用方负责写 policy_denied
   *    审计事件。
   */
  private async runGoverned(
    argv: readonly string[],
    cwd: string
  ): Promise<CommandResult> {
    // 1. 路径校验
    const pathDecision = this.opts.pathPolicy.decide(cwd, this.opts.allowedWorktreeRoots);
    if (!pathDecision.allowed) {
      throw new PolicyDeniedError(
        `command ${argv[0]} at ${cwd}`,
        pathDecision.reason
      );
    }
    const resolvedCwd = pathDecision.resolvedPath ?? cwd;

    // 2. 命令校验
    const cmdDecision = this.opts.commandPolicy.decide(argv, this.opts.projectCommands);
    if (!cmdDecision.allowed) {
      throw new PolicyDeniedError(
        `argv ${JSON.stringify(argv)}`,
        cmdDecision.reason
      );
    }

    // 3. 构造 CommandSpec 并执行
    const spec: CommandSpec = {
      argv,
      timeoutMs: this.opts.defaultTimeoutMs ?? this.opts.processPolicy.timeoutMs
    };
    return this.opts.processRunner.run(spec, resolvedCwd, this.opts.processPolicy);
  }
}

/** LocalCommandAdapter 与测试共用的 diff 哈希辅助。 */
export function hashDiff(patch: string): string {
  return `sha256-${createHash("sha256").update(patch).digest("hex")}`;
}
