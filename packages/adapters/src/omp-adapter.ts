/**
 * OmpAdapter —— ADR-007 中 Phase 4 的真实 Runtime 实现。
 *
 * 通过调用 `omp` 二进制（prompt 驱动的 coding agent）实现 `RuntimeAdapter`。
 * `analyze` / `develop` / `review` 通过不同 prompt + 共享 CLI 参数实现。
 *
 * ## 安全边界（ADR-007 §决策 4）
 *
 * 所有 omp 调用必须经 `ProcessRunner` + `PathPolicy` 治理，与
 * `LocalCommandAdapter` 一致。`--cwd` 参数值必须经 `PathPolicy` 校验位于
 * 受控 worktree 根目录内。omp 二进制路径必须与构造时登记的 `ompPath`
 * 严格一致，防止 PATH 注入。
 *
 * `CommandPolicy` 接口的 `decide()` 签名针对项目命令白名单设计，对 omp
 * 这种「固定二进制 + 结构化 prompt」形态不直接适用。OmpAdapter 在内部
 * 通过 `validateOmpArgv` 等价实现 omp 专用的命令策略：校验 argv[0] 是
 * 受控 omp 路径、`--cwd` 值经 PathPolicy 校验、`--max-time` 在
 * ProcessPolicy 范围内。该设计与 ADR-007 §决策 4 的安全意图一致。
 *
 * ## 流式特性（ADR-007 §待解决问题 1）
 *
 * 当前 `ProcessRunner.run()` 是同步返回完整 stdout 的接口。OmpAdapter
 * 调用 omp 一次性返回完整 NDJSON 输出，解析后批量 yield RuntimeEvent。
 * 这失去真实流式特性，但安全边界与 LocalCommandAdapter 完全一致，且
 * Phase 4 退出条件（分析、修改、验证、Diff）不要求流式。后续若需真实
 * 流式，需新增 ADR 扩展 ProcessRunner 端口支持 AsyncIterable<Buffer>。
 *
 * ## 取消信号（P1-R02 / Phase 4 第三轮验收 §7.3）
 *
 * `analyze`/`develop`/`review` 接受可选的外部 `AbortSignal`：
 * - 在启动 omp 子进程前检查 `signal.aborted`，若已 aborted 则直接
 *   yield `error` 事件（analyze/develop）或抛错（review），不启动子进程。
 *   这解决了注册前竞态：取消 API 在 Runtime 产出 `started` 事件前
 *   abort signal，OmpAdapter 感知后不启动 omp。
 * - 把 `signal` 透传给 `ProcessRunner.run`，signal abort 时终止整个
 *   omp 进程树（含孙进程）。
 *
 * `cancel(runId)` 仍保留用于通过 runId 取消（向后兼容），内部维护
 * `runs: Map<runId, AbortController>`。当 ExecutionOrchestrator 提供
 * 外部 signal 时，取消主要通过 signal 完成；`cancel(runId)` 作为
 * 补充手段，对已结束的 run 安全（no-op）。
 *
 * runs 记录在 generator 的 finally 块中清理（§7.4 第 1 点），避免
 * 长期运行造成内存累积。
 */

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
  PathPolicy,
  ProjectCommands,
  ControlledFileWriter,
  FileChangeInstruction,
  Hypothesis,
  EvidenceConstraint
} from "@tracepilot/core";
import { PolicyDeniedError } from "./local-command-adapter.js";

/**
 * omp 二进制不可用或调用失败时抛出。
 *
 * 与 ADR-001 stub 时代的 `OmpUnavailableError` 语义一致；保留同名错误类
 * 便于调用方兼容。本实现中可由 omp 调用返回非零退出码（且非 timeout）
 * 时抛出。
 */
export class OmpUnavailableError extends Error {
  constructor(message = "omp 二进制不可用或调用失败。请确认 omp 已安装且 API key 已配置。") {
    super(message);
    this.name = "OmpUnavailableError";
  }
}

/**
 * omp argv 不符合受控结构时抛出（等价 CommandPolicy 拒绝）。
 *
 * 继承 `PolicyDeniedError`：argv 结构校验本质上也是治理策略拒绝，
 * 调用方捕获 `PolicyDeniedError` 时能统一处理 omp 专用与通用路径策略
 * 拒绝（ADR-007 §决策 4）。
 */
export class OmpArgvValidationError extends PolicyDeniedError {
  constructor(
    public readonly violatedRule: string,
    public readonly detail: string
  ) {
    super(`omp argv[${violatedRule}]`, detail);
    this.name = "OmpArgvValidationError";
  }
}

export interface OmpAdapterOptions {
  /** 受治理的 ProcessRunner —— omp 子进程必须经它执行。 */
  readonly processRunner: ProcessRunner;
  /** 路径策略 —— 校验 --cwd 与 --add-dir 是否位于已登记根目录内。 */
  readonly pathPolicy: PathPolicy;
  /** 进程执行策略 —— 超时、输出上限、允许的 cwd 根目录。 */
  readonly processPolicy: ProcessPolicy;
  /** 项目登记的命令白名单（用于 prompt 内约束 omp 行为）。 */
  readonly projectCommands: ProjectCommands;
  /** 允许的 worktree 根目录列表（--cwd 必须位于其中之一内）。 */
  readonly allowedWorktreeRoots: readonly string[];
  /** omp 二进制绝对路径（必须由装配方固定，禁止依赖 PATH 查找）。 */
  readonly ompPath: string;
  /** omp 调用整体超时（毫秒），默认取 processPolicy.timeoutMs。 */
  readonly defaultTimeoutMs?: number;
  /** 可选：指定 LLM 模型名（注入 --model 参数）。 */
  readonly model?: string;
  /** 可选：额外只读引用目录（注入 --add-dir，每个目录都经 PathPolicy 校验）。 */
  readonly extraReadonlyDirs?: readonly string[];
  /**
   * 可选：omp profile 名（注入 --profile 参数）。
   *
   * ADR-008：TRAE 沙盒阻止 omp 访问默认 `~/.omp/agent/agent.db`，导致
   * omp 启动时 SQLite 抛 SQLITE_IOERR_TRUNCATE。指定独立 profile 后，
   * omp 把 agent.db / sessions / caches 隔离到 `~/.omp/profiles/<name>/`，
   * 避开沙盒限制。profile 名必须匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`。
   */
  readonly profile?: string;
  /**
   * P1-R01（§18 受控文件工具代理）：受控文件写入器。
   *
   * **develop 阶段必需**：omp develop 改为只读工具集（`--tools read,grep,glob`），
   * omp 无法直接修改文件。omp 在文本输出中提供 `<file_change>` XML 修改指令，
   * 由本端口代为写入。本端口在每次写入前同步校验路径：
   * 1. 路径必须落在 `Plan.allowedPaths` 白名单内（glob 匹配）；
   * 2. 路径不是受保护路径（`.git` 等）；
   * 3. 写入路径解析后不越界（无符号链接逃逸）。
   *
   * 任一检查失败立即抛 `PathScopeViolationError`，**不写入任何文件**
   * （原子性：全部通过才写入，任一失败全部不写）。
   *
   * 这是"同步、操作前、逐路径"的强制边界——omp 没有写入能力，所有文件
   * 写入都经过本端口的路径校验，从操作前杜绝越权（§18.3 要求）。
   *
   * analyze/review 不需要本端口（只读阶段）；若调用 develop 时未提供，
   * 立即抛错（失败关闭，禁止以无写入器方式运行 develop）。
   */
  readonly controlledFileWriter?: ControlledFileWriter;
}

/**
 * 真实 OmpAdapter 实现（ADR-007）。
 *
 * 三个方法（analyze / develop / review）共享 omp 调用基础设施
 * （`runOmpGoverned`），只在 prompt 构造与结果解析上分化。
 *
 * P1-R02（Phase 4 第三轮验收 §7.3）：analyze/develop/review 接受可选
 * 外部 `AbortSignal`，使取消 API 能在 Runtime 启动前就阻止其运行。
 * `cancel(runId)` 保留用于通过 runId 取消（向后兼容）。
 */
export class OmpAdapter implements RuntimeAdapter {
  /**
   * 内部 runs 登记 —— `runId → AbortController`。
   *
   * P1-R02：当外部 signal 提供时，取消主要通过 signal 完成。
   * `cancel(runId)` 作为补充手段，用于通过 runId 取消（向后兼容）。
   * runs 记录在 generator/方法的 finally 块中清理（§7.4 第 1 点）。
   */
  private readonly runs = new Map<string, { cancelled: boolean; controller: AbortController }>();

  constructor(private readonly opts: OmpAdapterOptions) {}

  async *analyze(input: RuntimeTaskInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runId = randomId("run");
    const controller = new AbortController();
    this.runs.set(runId, { cancelled: false, controller });

    // P1-R02：signal 在 started 前 aborted → 直接 yield error，不启动 omp。
    // 这解决注册前竞态：取消 API 在 Runtime 产出 started 事件前 abort signal。
    if (signal?.aborted) {
      yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
      yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled before omp start (signal aborted)" };
      this.runs.delete(runId);
      return;
    }

    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };

    if (signal?.aborted || this.runs.get(runId)?.cancelled) {
      yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled before omp start" };
      this.runs.delete(runId);
      return;
    }

    const prompt = this.buildAnalyzePrompt(input);
    const argv = this.buildOmpArgv(input.worktreePath, prompt, this.opts.defaultTimeoutMs ?? this.opts.processPolicy.timeoutMs, "analyze");

    yield {
      type: "tool_call",
      runId,
      tool: "omp",
      argv: argv.slice(0, -1), // 不记录 prompt 内容（可能含任务敏感信息）
      cwd: input.worktreePath,
      at: new Date().toISOString()
    };

    try {
      // P1-R02：透传外部 signal（若有），否则用内部 controller.signal
      const effectiveSignal = signal ?? controller.signal;
      const result = await this.runOmpGoverned(argv, input.worktreePath, effectiveSignal);
      yield {
        type: "tool_result",
        runId,
        exitCode: result.exitCode,
        truncated: result.truncated,
        bytes: result.retainedBytes,
        at: new Date().toISOString()
      };
      // 解析 NDJSON 流式事件并逐条 yield
      for (const ev of parseOmpNdjsonEvents(result.stdout, runId)) {
        if (signal?.aborted || this.runs.get(runId)?.cancelled) {
          yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled during event stream" };
          return;
        }
        yield ev;
      }
      if (result.timedOut) {
        yield {
          type: "error",
          runId,
          at: new Date().toISOString(),
          message: `omp 调用超时（exitCode=${result.exitCode}）`
        };
        return;
      }
      if (result.exitCode !== 0) {
        yield {
          type: "error",
          runId,
          at: new Date().toISOString(),
          message: `omp 退出码 ${result.exitCode}：${truncateStderr(result.stderr)}`
        };
        return;
      }
      yield {
        type: "completed",
        runId,
        at: new Date().toISOString(),
        summary: `OmpAdapter analyze: omp 完成（worktree: ${input.worktreePath}，事件流已解析）`
      };
    } catch (err) {
      yield {
        type: "error",
        runId,
        at: new Date().toISOString(),
        message: (err as Error).message
      };
      return;
    } finally {
      // §7.4 第 1 点：无论成功/失败/取消，generator 结束后清理 runs 记录。
      this.runs.delete(runId);
    }
  }

  async *develop(input: RuntimeTaskInput, signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    const runId = randomId("run");
    const controller = new AbortController();
    this.runs.set(runId, { cancelled: false, controller });

    // P1-R01（§18 受控文件工具代理）：develop 阶段必须注入 ControlledFileWriter。
    // omp 改为只读工具集（--tools read,grep,glob），无写入能力；所有文件修改
    // 通过 <file_change> XML 指令输出，由 ControlledFileWriter 代为写入并在
    // 写入前同步校验路径。若未注入写入器，立即失败关闭，禁止以无写入器
    // 方式运行 develop（否则 omp 输出的修改指令无法落地，develop 无意义）。
    if (!this.opts.controlledFileWriter) {
      yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
      yield {
        type: "error",
        runId,
        at: new Date().toISOString(),
        message: "OmpAdapter develop 需要 ControlledFileWriter（P1-R01 §18：受控文件工具代理必需），未注入时禁止运行"
      };
      this.runs.delete(runId);
      return;
    }
    const controlledFileWriter = this.opts.controlledFileWriter;

    // P1-R02：signal 在 started 前 aborted → 直接 yield error，不启动 omp。
    if (signal?.aborted) {
      yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
      yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled before omp start (signal aborted)" };
      this.runs.delete(runId);
      return;
    }

    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };

    if (signal?.aborted || this.runs.get(runId)?.cancelled) {
      yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled before omp start" };
      this.runs.delete(runId);
      return;
    }

    const prompt = this.buildDevelopPrompt(input);
    const argv = this.buildOmpArgv(input.worktreePath, prompt, this.opts.defaultTimeoutMs ?? this.opts.processPolicy.timeoutMs, "develop");

    yield {
      type: "tool_call",
      runId,
      tool: "omp",
      argv: argv.slice(0, -1),
      cwd: input.worktreePath,
      at: new Date().toISOString()
    };

    try {
      const effectiveSignal = signal ?? controller.signal;
      const result = await this.runOmpGoverned(argv, input.worktreePath, effectiveSignal);
      yield {
        type: "tool_result",
        runId,
        exitCode: result.exitCode,
        truncated: result.truncated,
        bytes: result.retainedBytes,
        at: new Date().toISOString()
      };
      for (const ev of parseOmpNdjsonEvents(result.stdout, runId)) {
        if (signal?.aborted || this.runs.get(runId)?.cancelled) {
          yield { type: "error", runId, at: new Date().toISOString(), message: "cancelled during event stream" };
          return;
        }
        yield ev;
      }
      if (result.timedOut) {
        yield {
          type: "error",
          runId,
          at: new Date().toISOString(),
          message: `omp 调用超时（exitCode=${result.exitCode}）`
        };
        return;
      }
      if (result.exitCode !== 0) {
        yield {
          type: "error",
          runId,
          at: new Date().toISOString(),
          message: `omp 退出码 ${result.exitCode}：${truncateStderr(result.stderr)}`
        };
        return;
      }
      // P1-R01（§18 受控文件工具代理）：omp 事件流成功结束后，从 stdout 中
      // 提取 <file_change> XML 修改指令，交由 ControlledFileWriter 代为写入。
      // 写入器在每次写入前同步校验路径（allowedPaths glob 匹配 + 受保护路径
      // 检查 + 符号链接逃逸检查），任一文件越界立即抛 PathScopeViolationError，
      // 不写入任何文件（原子性）。这是"同步、操作前、逐路径"的强制边界：
      // omp 没有写入能力，所有写入都经此校验，从源头杜绝越权（§18.3 要求）。
      const changes = extractFileChangesFromStdout(result.stdout);
      if (changes.length > 0) {
        yield {
          type: "progress",
          runId,
          at: new Date().toISOString(),
          message: `受控文件工具代理：准备写入 ${changes.length} 个文件修改（路径将同步校验）`
        };
        try {
          await controlledFileWriter.writeFiles(
            input.taskId,
            input.worktreePath,
            input.allowedPaths,
            changes
          );
          yield {
            type: "progress",
            runId,
            at: new Date().toISOString(),
            message: `受控文件工具代理：${changes.length} 个文件已写入并通过路径校验`
          };
        } catch (writeErr) {
          // 路径越界或写入失败：失败关闭，禁止后续 Diff/验证/Review。
          // 调用方（ExecutionOrchestrator）捕获 error 事件后回滚 worktree
          // 并写 policy_denied 审计。
          yield {
            type: "error",
            runId,
            at: new Date().toISOString(),
            message: `受控文件工具代理拒绝写入：${(writeErr as Error).message}`
          };
          return;
        }
      } else {
        yield {
          type: "progress",
          runId,
          at: new Date().toISOString(),
          message: "受控文件工具代理：omp 未输出任何 <file_change> 修改指令"
        };
      }
      yield {
        type: "completed",
        runId,
        at: new Date().toISOString(),
        summary: `OmpAdapter develop: omp 完成（worktree: ${input.worktreePath}，${changes.length} 个文件经 ControlledFileWriter 代为写入，需通过 getDiff 验证实际改动）`
      };
    } catch (err) {
      yield {
        type: "error",
        runId,
        at: new Date().toISOString(),
        message: (err as Error).message
      };
      return;
    } finally {
      // §7.4 第 1 点：清理 runs 记录，避免内存累积。
      this.runs.delete(runId);
    }
  }

  async review(input: ReviewTaskInput, signal?: AbortSignal): Promise<ReviewResult> {
    // review 不流式：omp 一次性返回，解析其中的 ReviewResult JSON。
    // prompt 要求 omp 输出符合 ReviewResult 接口的 JSON；容错解析提取。
    // P1-R02：review 也接受外部 signal，signal aborted 时抛错，不启动 omp。
    // 这解决取消 API 无法取消 review 的问题（§7.3 第 2 点）。
    const runId = randomId("run");
    const controller = new AbortController();
    this.runs.set(runId, { cancelled: false, controller });

    // P1-R02：signal 在 review 前 aborted → 抛错，不启动 omp。
    if (signal?.aborted) {
      this.runs.delete(runId);
      throw new OmpUnavailableError("review cancelled before omp start (signal aborted)");
    }

    const prompt = this.buildReviewPrompt(input);
    const argv = this.buildOmpArgv(input.worktreePath, prompt, this.opts.defaultTimeoutMs ?? this.opts.processPolicy.timeoutMs, "review");

    try {
      const effectiveSignal = signal ?? controller.signal;
      const result = await this.runOmpGoverned(argv, input.worktreePath, effectiveSignal);

      if (result.timedOut) {
        throw new OmpUnavailableError(`omp review 超时（exitCode=${result.exitCode}）`);
      }
      if (result.exitCode !== 0) {
        throw new OmpUnavailableError(
          `omp review 退出码 ${result.exitCode}：${truncateStderr(result.stderr)}`
        );
      }
      if (result.truncated) {
        return truncatedReviewResult(input, result);
      }
      // Review 使用 text 模式：Omp 只返回最终 assistant 文本，必须严格按
      // 一个 ReviewResult JSON 解析，不再把事件流头部当作候选结果。
      const parsed = parseReviewResultText(result.stdout, input, undefined, {
        truncated: result.truncated,
        originalBytes: result.originalBytes,
        retainedBytes: result.retainedBytes,
        outputMode: "text",
        textSegmentCount: result.stdout.trim().length > 0 ? 1 : 0
      });
      return parsed;
    } finally {
      // §7.4 第 1 点：清理 runs 记录。
      this.runs.delete(runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) return; // §6：未知 runId 调用 cancel 必须安全。
    state.cancelled = true;
    // P1-05 / P1-R02：通过 AbortController 终止进行中的 omp 进程树。
    // LocalProcessRunner 监听 abort 事件并调用 killProcessTree 杀死
    // 整个进程树（含孙进程）。
    // 注意：当 ExecutionOrchestrator 提供外部 signal 时，取消主要通过
    // signal 完成；cancel(runId) 作为补充手段（向后兼容）。
    state.controller.abort();
  }

  // --------------------------------------------------------------------------
  // 私有：omp argv 构造与治理
  // --------------------------------------------------------------------------

  /**
   * 组装 omp argv。结构固定：
   *
   *   <ompPath> -p --mode json|text --cwd <worktree> --no-session
   *              --max-time <seconds> --tools <phase-specific-tools>
   *              --approval-mode=write [--profile <name>] [--model <name>]
   *              [--add-dir <path>...] "<prompt>"
   *
   * P1-01（Phase 4 验收）：用 `--tools` 标志按阶段限制 omp 可用的内置工具，
   * 作为不可绕过的安全边界（CLI 级强制，非 prompt 约束）：
   * - analyze：`--tools=read,grep,glob`（只读，无 bash/write/edit）
   * - develop：`--tools=read,grep,glob`（**只读**，无 bash/edit/write/browser/
   *   network 工具）。P1-R01（§18 受控文件工具代理）：omp 没有写入能力，
   *   所有文件修改通过 `<file_change>` XML 指令输出，由
   *   `ControlledFileWriter` 代为写入并在写入前同步校验路径。这是
   *   "同步、操作前、逐路径"的强制边界，从源头杜绝越权写入。
   * - review：`--no-tools`（review 只读 prompt 中的 diff+验证结果，无需工具）
   *
   * P1-R01（§9.2 执行期文件隔离）：`--approval-mode=write` 激活 omp CLI 级
   * 工作区写入边界 —— omp 仅自动批准 read + workspace-write 工具；非工作区
   * 写入（绝对路径、`..` 穿越、worktree 外）在非交互 -p 模式下被拒绝。
   * 这是 CLI 级强制（非 prompt 约束），与文件系统守卫（恢复层）和 Diff
   * 后置校验（检测层）互补，构成三层防御。
   *
   * prompt 是 TracePilot 内部构造的结构化文本（非模型输出），作为 argv
   * 最后一个参数传入。AGENTS.md 规则「模型输出绝不拼接进 argv」不违反：
   * prompt 内容来自 TaskInput（用户输入快照），不是模型生成的文本。
   */
  private buildOmpArgv(worktreePath: string, prompt: string, timeoutMs: number, phase: "analyze" | "develop" | "review"): string[] {
    const argv: string[] = [
      this.opts.ompPath,
      "-p",
      "--mode", phase === "review" ? "text" : "json",
      "--cwd", worktreePath,
      "--no-session",
      "--max-time", Math.max(1, Math.floor(timeoutMs / 1000)).toString()
    ];

    // P1-01：按阶段限制工具集（CLI 级强制安全边界）
    if (phase === "analyze") {
      // 只读分析：read + grep + glob，无 bash/write/edit
      argv.push("--tools", "read,grep,glob");
    } else if (phase === "develop") {
      // P1-R01（§18 受控文件工具代理）：develop 阶段也使用只读工具集
      // （read + grep + glob），omp 没有任何写入能力。omp 通过文本输出
      // `<file_change>` XML 指令描述文件修改，由 ControlledFileWriter
      // 代为写入并在写入前同步校验路径。这是"同步、操作前、逐路径"的
      // 强制边界，从源头杜绝越权写入（§18.3 要求）。
      // TracePilot 自己跑 test 命令验证，omp 不需要 bash。
      argv.push("--tools", "read,grep,glob");
    } else {
      // review：无需任何工具，prompt 已包含 diff 和验证结果
      argv.push("--no-tools");
    }

    // P1-R01（§9.2 执行期文件隔离）：--approval-mode=write 激活 omp CLI 级
    // 工作区写入边界。omp 仅自动批准 read + workspace-write 工具；非工作区
    // 写入（绝对路径、.. 穿越、worktree 外）在非交互 -p 模式下被拒绝
    // （无人审批）。这是 CLI 级强制，非 prompt 约束。
    // 禁止 --auto-approve（yolo 模式，绕过工作区写入边界）。
    argv.push("--approval-mode=write");

    // P1-R01（§10.2 第六次复验）：禁用 omp 自动发现的扩展、技能和规则。
    // 本机 `omp --help` 确认 --no-extensions / --no-skills / --no-rules 默认
    // 启用自动发现。项目目录或用户环境中被自动发现的扩展/技能/规则可能
    // 引入额外执行能力（如自定义 bash 工具），绕过 --tools 限制。
    // 逐项禁用，确保仅 --tools 声明的内置工具可用。
    argv.push("--no-extensions", "--no-skills", "--no-rules");

    if (this.opts.profile) {
      argv.push("--profile", this.opts.profile);
    }
    if (this.opts.model) {
      argv.push("--model", this.opts.model);
    }
    if (this.opts.extraReadonlyDirs) {
      for (const dir of this.opts.extraReadonlyDirs) {
        argv.push("--add-dir", dir);
      }
    }
    argv.push(prompt);
    return argv;
  }

  /**
   * 经治理闸门执行 omp（ADR-007 §决策 4）。
   *
   * 步骤：
   * 1. `validateOmpArgv`：等价 omp 专用 CommandPolicy，校验 argv 结构。
   *    - argv[0] 必须与 opts.ompPath 严格相等（防 PATH 注入）
   *    - analyze/develop 必须使用 --mode json；review 使用 --mode text
   *      只接收最终 assistant 文本；三者都必须包含 --approval-mode=write / --no-session
   *    - --cwd 值必须经 PathPolicy 校验位于 allowedWorktreeRoots 内
   *    - --add-dir 每个值也必须经 PathPolicy 校验
   *    - --max-time 必须在 [1, processPolicy.timeoutMs/1000] 范围内
   * 2. 用 PathPolicy 解析 worktreePath 真实路径（防符号链接逃逸）
   * 3. 构造 CommandSpec 并交给 ProcessRunner 执行
   * 4. 任何策略拒绝都抛 PolicyDeniedError，调用方负责写 policy_denied 审计
   */
  private async runOmpGoverned(
    argv: readonly string[],
    worktreePath: string,
    abortSignal?: AbortSignal
  ): Promise<CommandResult> {
    // 1. omp argv 结构校验（等价 CommandPolicy）
    this.validateOmpArgv(argv);

    // 2. PathPolicy 校验 --cwd（与 worktreePath 一致）
    const pathDecision = this.opts.pathPolicy.decide(worktreePath, this.opts.allowedWorktreeRoots);
    if (!pathDecision.allowed) {
      throw new PolicyDeniedError(
        `omp --cwd ${worktreePath}`,
        pathDecision.reason
      );
    }
    const resolvedCwd = pathDecision.resolvedPath ?? worktreePath;

    // 3. 构造 CommandSpec 并执行（P1-05：透传 abortSignal）
    const spec: CommandSpec = {
      argv,
      timeoutMs: this.opts.defaultTimeoutMs ?? this.opts.processPolicy.timeoutMs
    };
    return this.opts.processRunner.run(spec, resolvedCwd, this.opts.processPolicy, abortSignal);
  }

  /**
   * omp argv 结构校验（等价 CommandPolicy.decide，但针对 omp 特化）。
   *
   * 校验规则按 ADR-007 §决策 2 的固定 CLI 拓扑：
   *   <ompPath> -p --mode json|text --cwd <path> --approval-mode=write --no-session
   *             --no-extensions --no-skills --no-rules
   *             --max-time <sec> [--profile <name>] [--model <name>]
   *             [--add-dir <path>...] "<prompt>"
   *
   * P1-R01（§11.2 第七次复验）：`--no-extensions`、`--no-skills`、
   * `--no-rules` 为必需固定拓扑项，缺失任一都抛
   * `OmpArgvValidationError`（失败关闭）。这三项禁用 omp 的自动发现能力，
   * 防止项目目录或用户环境中被自动发现的扩展/技能/规则引入额外执行能力
   * 绕过 `--tools` 限制。
   *
   * 任何偏离都抛 OmpArgvValidationError，等价 CommandPolicy 拒绝。
   */
  private validateOmpArgv(argv: readonly string[]): void {
    if (!Array.isArray(argv) || argv.length < 8) {
      throw new OmpArgvValidationError(
        "argv-length",
        `argv 至少需要 8 个元素（ompPath + 7 个固定参数 + prompt），实际 ${argv.length}`
      );
    }
    // argv[0] 必须与受控 ompPath 严格相等
    if (argv[0] !== this.opts.ompPath) {
      throw new OmpArgvValidationError(
        "ompPath-mismatch",
        `argv[0] 必须是受控 ompPath=${this.opts.ompPath}，实际 ${argv[0]}`
      );
    }
    if (argv[1] !== "-p" && argv[1] !== "--print") {
      throw new OmpArgvValidationError(
        "missing-print-flag",
        `argv[1] 必须是 -p 或 --print，实际 ${argv[1]}`
      );
    }
    // analyze/develop 使用 JSON 事件流；review 使用 text 模式，避免完整事件流
    // 超过上限后只保留头部而丢失末尾 assistant ReviewResult。
    const modeIdx = argv.indexOf("--mode");
    const mode = modeIdx === -1 ? undefined : argv[modeIdx + 1];
    const isReviewTextMode = mode === "text" && argv.includes("--no-tools");
    if (modeIdx === -1 || (mode !== "json" && !isReviewTextMode)) {
      throw new OmpArgvValidationError(
        "invalid-mode",
        "analyze/develop 必须使用 --mode json；review 必须使用 --mode text 且包含 --no-tools"
      );
    }
    // --cwd <path>，且 path 必须经 PathPolicy 校验
    const cwdIdx = argv.indexOf("--cwd");
    if (cwdIdx === -1) {
      throw new OmpArgvValidationError(
        "missing-cwd",
        "argv 必须包含 --cwd <worktreePath>"
      );
    }
    const cwdValue = argv[cwdIdx + 1];
    if (!cwdValue) {
      throw new OmpArgvValidationError(
        "missing-cwd-value",
        "--cwd 缺少取值"
      );
    }
    const cwdDecision = this.opts.pathPolicy.decide(cwdValue, this.opts.allowedWorktreeRoots);
    if (!cwdDecision.allowed) {
      throw new OmpArgvValidationError(
        "cwd-outside-roots",
        `--cwd ${cwdValue} 不在受控 worktree 根目录内：${cwdDecision.reason}`
      );
    }
    // P1-R01（§9.2）：必须使用 --approval-mode=write 激活工作区写入边界。
    // 拒绝 --auto-approve（yolo 模式，绕过工作区边界）和 --approval-mode=yolo。
    // 先检查禁止项再检查必需项：使用 --auto-approve 替换 --approval-mode=write
    // 时应报 forbidden-yolo-mode（更具体、更准确），而非 missing-approval-mode-write。
    const hasWriteMode = argv.includes("--approval-mode=write");
    const hasYolo = argv.includes("--auto-approve") || argv.includes("--approval-mode=yolo");
    if (hasYolo) {
      throw new OmpArgvValidationError(
        "forbidden-yolo-mode",
        "argv 禁止包含 --auto-approve 或 --approval-mode=yolo（P1-R01：yolo 模式绕过工作区写入边界）"
      );
    }
    if (!hasWriteMode) {
      throw new OmpArgvValidationError(
        "missing-approval-mode-write",
        "argv 必须包含 --approval-mode=write（P1-R01：工作区写入边界强制）；禁止 --auto-approve 或 --approval-mode=yolo"
      );
    }
    // P1-01：必须包含 --tools 或 --no-tools，限制 omp 可用的内置工具。
    // 不含工具限制的 argv 被拒绝 —— omp 默认启用全部工具（含 bash/browser），
    // 违反命令/路径/审批不可绕过的安全边界。
    const hasTools = argv.includes("--tools");
    const hasNoTools = argv.includes("--no-tools");
    if (!hasTools && !hasNoTools) {
      throw new OmpArgvValidationError(
        "missing-tools-restriction",
        "argv 必须包含 --tools <list> 或 --no-tools（P1-01：禁止不限工具集的 omp 调用）"
      );
    }
    if (hasTools) {
      // P1-R01（§18 受控文件工具代理）：--tools 白名单只允许只读工具
      // （read, grep, glob）。禁止 edit/write/bash/browser/notebook/
      // inspect_image/python 等任何具有副作用或高风险的工具。
      //
      // omp develop 通过 `<file_change>` XML 指令输出文件修改，由
      // ControlledFileWriter 代为写入并在写入前同步校验路径。omp 自身
      // 没有写入能力，从源头杜绝越权写入（§18.3 要求）。
      const toolsIdx = argv.indexOf("--tools");
      const toolsValue = argv[toolsIdx + 1] ?? "";
      const allowedToolNames = new Set(["read", "grep", "glob"]);
      const requestedTools = toolsValue.split(",").map((t: string) => t.trim()).filter(Boolean);
      const forbidden = requestedTools.filter((t: string) => !allowedToolNames.has(t));
      if (forbidden.length > 0) {
        throw new OmpArgvValidationError(
          "forbidden-tool-in-whitelist",
          `--tools 包含禁止的工具：${forbidden.join(", ")}。允许的工具（仅只读）：${[...allowedToolNames].join(", ")}`
        );
      }
    }
    // --no-session
    if (!argv.includes("--no-session")) {
      throw new OmpArgvValidationError(
        "missing-no-session",
        "argv 必须包含 --no-session（任务隔离必需）"
      );
    }
    // P1-R01（§11.2 第七次复验）：必须包含 --no-extensions / --no-skills /
    // --no-rules，禁用 omp 自动发现的扩展、技能和规则。本机 `omp --help` 确认
    // 这三项默认启用；自动发现的项目目录或用户环境中的扩展/技能/规则可能
    // 引入额外执行能力（如自定义 bash 工具），绕过 --tools 限制。三项均为
    // 必需固定拓扑，缺失任一都拒绝执行（失败关闭）。
    const requiredNoFlags = [
      "--no-extensions",
      "--no-skills",
      "--no-rules"
    ] as const;
    for (const flag of requiredNoFlags) {
      if (!argv.includes(flag)) {
        throw new OmpArgvValidationError(
          "missing-no-auto-discovery-flag",
          `argv 必须包含 ${flag}（P1-R01 §11.2：禁用 omp 自动发现能力，防止绕过 --tools 限制）`
        );
      }
    }
    // --max-time <sec>，且在 [1, processPolicy.timeoutMs/1000] 范围内
    const maxTimeIdx = argv.indexOf("--max-time");
    if (maxTimeIdx === -1) {
      throw new OmpArgvValidationError(
        "missing-max-time",
        "argv 必须包含 --max-time <seconds>"
      );
    }
    const maxTimeRaw = argv[maxTimeIdx + 1];
    const maxTimeSec = Number(maxTimeRaw);
    if (!Number.isFinite(maxTimeSec) || maxTimeSec < 1) {
      throw new OmpArgvValidationError(
        "invalid-max-time",
        `--max-time 必须是正整数，实际 ${maxTimeRaw}`
      );
    }
    const policyMaxSec = Math.floor((this.opts.defaultTimeoutMs ?? this.opts.processPolicy.timeoutMs) / 1000);
    if (maxTimeSec > policyMaxSec) {
      throw new OmpArgvValidationError(
        "max-time-exceeds-policy",
        `--max-time ${maxTimeSec}s 超过 ProcessPolicy.timeoutMs 上限 ${policyMaxSec}s`
      );
    }
    // --profile <name>（可选）：必须匹配 omp profile 名规则
    const profileIdx = argv.indexOf("--profile");
    if (profileIdx !== -1) {
      const profileValue = argv[profileIdx + 1];
      if (!profileValue) {
        throw new OmpArgvValidationError(
          "missing-profile-value",
          "--profile 缺少取值"
        );
      }
      // omp profile 名规则：^[a-z0-9][a-z0-9._-]{0,63}$，非 Windows 保留名
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profileValue)) {
        throw new OmpArgvValidationError(
          "invalid-profile-name",
          `--profile "${profileValue}" 不符合 omp profile 名规则`
        );
      }
    }
    // --add-dir 每个值也必须经 PathPolicy 校验（若提供 extraReadonlyDirs）
    const addDirIndices: number[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--add-dir") addDirIndices.push(i);
    }
    for (const idx of addDirIndices) {
      const dir = argv[idx + 1];
      if (!dir) {
        throw new OmpArgvValidationError(
          "missing-add-dir-value",
          `--add-dir 在索引 ${idx} 缺少取值`
        );
      }
      // --add-dir 可以是项目仓库根（只读引用），允许的根目录集合 =
      // allowedWorktreeRoots + 已登记项目仓库根。这里保守只校验
      // allowedWorktreeRoots；若需引用项目仓库根，由装配方把它加入
      // allowedWorktreeRoots 或单独登记（待 ADR-008 进一步明确）。
      const dirDecision = this.opts.pathPolicy.decide(dir, this.opts.allowedWorktreeRoots);
      if (!dirDecision.allowed) {
        throw new OmpArgvValidationError(
          "add-dir-outside-roots",
          `--add-dir ${dir} 不在受控根目录内：${dirDecision.reason}`
        );
      }
    }
    // 最后一个元素是 prompt（非空字符串）
    const promptValue = argv[argv.length - 1];
    if (typeof promptValue !== "string" || promptValue.length === 0) {
      throw new OmpArgvValidationError(
        "missing-prompt",
        "argv 最后一个元素必须是非空 prompt 字符串"
      );
    }
  }

  // --------------------------------------------------------------------------
  // 私有：prompt 构造（ADR-007 §决策 5）
  // --------------------------------------------------------------------------

  /**
   * analyze prompt：要求 omp 在 worktree 中只读分析、收集证据，不修改文件。
   *
   * prompt 内嵌入任务目标、约束、验收标准、失败堆栈、allowedPaths、命令白名单。
   * omp 的所有工具调用仍受 ProcessRunner + PathPolicy 治理（prompt 约束是
   * 双重防御，不是唯一边界）。
   */
  private buildAnalyzePrompt(input: RuntimeTaskInput): string {
    const ti = input.taskInput;
    const lines: string[] = [
      "# 任务：分析失败并收集证据（只读）",
      "",
      `## 任务 ID: ${input.taskId}`,
      `## Evidence Pack: ${input.evidencePackId}@v${input.evidencePackVersion}`,
      "",
      "## 目标",
      ti.objective,
      "",
      "## 约束",
      ...(ti.constraints.length === 0 ? ["（无显式约束）"] : ti.constraints.map((c) => `- ${c}`)),
      "",
      "## 验收标准",
      ...(ti.acceptanceCriteria.length === 0 ? ["（无显式验收标准）"] : ti.acceptanceCriteria.map((c) => `- ${c}`)),
      "",
      "## 风险等级",
      ti.riskLevel,
      "",
      "## 失败来源",
      `origin: ${ti.origin}`,
      ti.rawSource ? "```" : "",
      ...(ti.rawSource ? ti.rawSource.split("\n") : []),
      ...(ti.rawSource ? ["```", ""] : []),
      "## 允许修改的路径白名单（develop 阶段使用，analyze 阶段只读）",
      ...(input.allowedPaths.length === 0 ? ["（无）"] : input.allowedPaths.map((p) => `- ${p}`)),
      "",
      "## 项目命令白名单（这些命令的 argv 固定，由 TracePilot 治理）",
      ...formatProjectCommands(input.projectCommands),
      "",
      "## 指令",
      "1. 在当前 worktree 中运行只读分析：执行项目 test 命令查看失败堆栈；",
      "2. 读取相关源码、测试、配置文件；",
      "3. 不得修改任何文件（本阶段只收集证据）；",
      "4. 不得执行白名单外的命令；",
      "5. 输出失败根因假设、相关文件路径与行号、建议的修复方向。",
      ""
    ];
    return lines.join("\n");
  }

  /**
   * develop prompt：要求 omp 修复指定失败，约束 allowedPaths 与命令白名单，
   * 修改完成后运行验证命令。
   *
   * P1-R01（§18 受控文件工具代理）：omp 只能使用只读工具（read/grep/glob），
   * 没有任何写入能力。所有文件修改必须通过 `<file_change>` XML 指令输出，
   * 由 TracePilot 的 ControlledFileWriter 代为写入并在写入前同步校验路径。
   *
   * prompt 明确告知 omp：
   * 1. 不要尝试使用 edit/write/bash 工具（已被 --tools 禁用）；
   * 2. 所有修改以 `<file_change path="相对路径">完整新内容</file_change>` 输出；
   * 3. 路径必须是 allowedPaths 白名单内的相对路径，否则会被同步拒绝；
   * 4. 内容如含特殊字符，用 CDATA 包裹（`<![CDATA[...]]>`）。
   *
   * **安全边界**：prompt 约束是双重防御，不是唯一边界。真正的强制边界是
   * `--tools read,grep,glob`（CLI 级）+ `ControlledFileWriter.writeFiles`
   * 的同步路径校验（操作前）。即使 omp 忽略 prompt 指令尝试越权，也无法
   * 绕过这两层强制边界。
   */
  private buildDevelopPrompt(input: RuntimeTaskInput): string {
    const ti = input.taskInput;
    const lines: string[] = [
      "# 任务：修复失败（develop）",
      "",
      `## 任务 ID: ${input.taskId}`,
      `## Evidence Pack: ${input.evidencePackId}@v${input.evidencePackVersion}`,
      "",
      "## 目标",
      ti.objective,
      "",
      "## 约束",
      ...(ti.constraints.length === 0 ? ["（无显式约束）"] : ti.constraints.map((c) => `- ${c}`)),
      "",
      "## 验收标准（必须全部满足）",
      ...(ti.acceptanceCriteria.length === 0 ? ["（无显式验收标准）"] : ti.acceptanceCriteria.map((c) => `- ${c}`)),
      "",
      "## 风险等级",
      ti.riskLevel,
      "",
      "## 失败来源",
      `origin: ${ti.origin}`,
      ti.rawSource ? "```" : "",
      ...(ti.rawSource ? ti.rawSource.split("\n") : []),
      ...(ti.rawSource ? ["```", ""] : []),
      "## 允许修改的路径白名单（严禁修改白名单外的文件）",
      ...(input.allowedPaths.length === 0 ? ["（无）"] : input.allowedPaths.map((p) => `- ${p}`)),
      "",
      "## 项目命令白名单（只能执行这些命令，argv 固定）",
      ...formatProjectCommands(input.projectCommands),
      "",
      "## 工具能力约束（不可绕过）",
      "你只能使用只读工具：read / grep / glob。edit / write / bash / browser 等工具",
      "已被 `--tools read,grep,glob` 在 CLI 级禁用，你无法直接修改任何文件。",
      "TracePilot 也不会替你执行任何 shell 命令；项目 test 命令由 TracePilot 自行运行。",
      "",
      "## 文件修改输出格式（必须严格遵守）",
      "所有文件修改必须以如下 XML 指令输出，由 TracePilot 代为写入：",
      "",
      "<file_change path=\"src/users.py\">",
      "<![CDATA[",
      "文件完整新内容（覆盖现有文件或创建新文件）",
      "]]>",
      "</file_change>",
      "",
      "可输出多个 `<file_change>` 块，每个块对应一个文件。规则：",
      "1. `path` 必须是相对 worktree 根的 POSIX 路径（如 `src/users.py`），",
      "   必须匹配上方 allowedPaths 白名单中的至少一个 glob 模式；",
      "2. 块内容是文件的**完整新内容**（非 diff），TracePilot 直接覆盖写入；",
      "3. 内容若含 `<`、`>`、`&` 或 `]]>`，必须用 CDATA 包裹；",
      "4. 不得修改 `.git/`、`.omp/` 等受保护路径，否则会被同步拒绝；",
      "5. 路径越界（不在 allowedPaths 内、绝对路径、`..` 穿越）会被同步拒绝，",
      "   所有修改都不会写入（原子性）。",
      "",
      "## 指令",
      "1. 在当前 worktree 中按失败堆栈定位 bug；",
      "2. 仅修改 allowedPaths 白名单内的文件；",
      "3. 不得尝试执行白名单外的命令（你没有 bash 工具）；",
      "4. 以 `<file_change>` XML 指令输出所有文件修改；",
      "5. TracePilot 将代为写入文件，然后运行 test 命令验证修复；",
      "6. 若 test 仍失败，TracePilot 会重新调用你（最多 3 次）。",
      ""
    ];
    return lines.join("\n");
  }

  /**
   * review prompt：要求 omp 基于 diff + 验证结果输出结构化 JSON 裁决。
   *
   * JSON schema 严格匹配 ReviewResult 接口。容错解析在 `extractReviewResult`
   * 中实现，处理模型可能不严格输出 JSON 的情况。
   */
  private buildReviewPrompt(input: ReviewTaskInput): string {
    const ti = input.taskInput;
    const lines: string[] = [
      "# 任务：独立审查（review）",
      "",
      `## 任务 ID: ${input.taskId}`,
      `## Evidence Pack: ${input.evidencePackId}@v${input.evidencePackVersion}`,
      "",
      "## Evidence Pack 内容（不可变来源快照）",
      "Reviewer 必须只使用以下已冻结来源；不得把未出现在 Pack 中的临时搜索或 Developer 推理当作正式证据。",
      "```json",
      JSON.stringify(input.evidencePack, null, 2),
      "```",
      "",
      "## 任务原始目标",
      ti.objective,
      "",
      "## 验收标准",
      ...(ti.acceptanceCriteria.length === 0 ? ["（无）"] : ti.acceptanceCriteria.map((c) => `- ${c}`)),
      "",
      "## 评审输入的验收标准（必须与任务快照一致）",
      ...(input.acceptanceCriteria.length === 0 ? ["（无）"] : input.acceptanceCriteria.map((c) => `- ${c}`)),
      "",
      "## Diff",
      `worktree: ${input.diff.worktreePath}`,
      `hash: ${input.diff.hash}`,
      `changedFiles: ${input.diff.changedFiles.join(", ") || "（无）"}`,
      "```diff",
      input.diff.patch || "（空 diff）",
      "```",
      "",
      "## 验证结果",
      "```json",
      JSON.stringify(input.verificationResult, null, 2),
      "```",
      "",
      "## 输出要求",
      "只输出一个 JSON 对象，不得包含任何额外文本。下面是只包含 JSON 对象内容的 schema 示例，不要复制任何包装：",
      buildReviewResultOutputExample(),
      "confidence 字段必须是不加引号的 JSON number，取值范围为 [0,1]；required 必须是 JSON boolean true 或 false。",
      "verdict、priority、category 必须分别使用各自枚举中的一个合法值，不得输出枚举说明文本。",
      "去除首尾空白后，首字符必须是 `{`，末字符必须是 `}`；不要输出 Markdown JSON 围栏或其他额外文本。",
      "",
      "## 评审要点",
      "1. diff 是否仅触碰 allowedPaths 白名单内的文件；",
      "2. 是否满足全部验收标准；",
      "3. 是否引入 P0/P1 风险（数据损坏、安全漏洞、回归）；",
      "4. 是否存在兼容性问题或缺少回归测试；这两类 finding 必须分别标记 category=compatibility 或 category=regression_test；category 缺失或不在枚举内时必须返回 block；",
      "5. 验证结果是否真实通过；",
      "6. verdict=ship/ship_with_fixes 时 rootCause 必须精确复制当前 Pack 中一个 hypothesis（text、confidence、evidenceIds 均一致）；不得根据临时搜索新造根因。Pack 没有合适 hypothesis 时必须 verdict=block 并说明需要 Evidence Request；",
      "7. applicabilityConditions 如提供，只能精确复制当前 Pack 中已有 constraint，并保留 evidenceIds 与 required；",
      "8. verdict=block 用于任何不能安全批准的结果；ship_with_fixes 只能用于没有阻断性 finding 的 P2/P3 建议；ship 用于没有问题的结果。",
      ""
    ];
    return lines.join("\n");
  }
}

// --------------------------------------------------------------------------
// 模块级辅助：NDJSON 解析、ReviewResult 提取、格式化
// --------------------------------------------------------------------------

/**
 * 返回嵌入 Review prompt 的合法 ReviewResult 示例。
 * 示例中的枚举只取一个合法值，数值和布尔值保持真实 JSON 类型，避免
 * 模型把类型说明文字误当成提交结果。
 */
export function buildReviewResultOutputExample(): string {
  return JSON.stringify(
    {
      verdict: "ship_with_fixes",
      findings: [
        {
          priority: "P2",
          confidence: 0.95,
          category: "correctness",
          message: "问题描述",
          locator: "src/example.ts:10"
        }
      ],
      rootCause: {
        text: "复制当前 Pack 中某个 hypotheses[].text",
        confidence: 0.95,
        evidenceIds: ["复制当前 Pack 中的 Evidence ID"]
      },
      fixSummary: "修复摘要",
      applicabilityConditions: [
        {
          text: "复制当前 Pack 中某个 constraints[].text",
          evidenceIds: ["复制当前 Pack 中的 Evidence ID"],
          required: true
        }
      ],
      summary: "评审摘要"
    },
    null,
    2
  );
}

/**
 * 解析 omp --mode json 的 NDJSON 输出为 RuntimeEvent 序列。
 *
 * ADR-008：API key 配置后实际跑通 omp v17.1.5，确认真实事件结构。
 * omp 事件类型与字段如下（每行一个 JSON 对象，NDJSON）：
 *
 * - {"type":"session","version":3,"id":"...","cwd":"..."} → started
 * - {"type":"agent_start"} → progress（agent 已启动）
 * - {"type":"turn_start"} → 跳过（噪声）
 * - {"type":"message_start","message":{"role":"user|assistant|toolResult",...}} → 跳过
 * - {"type":"message_end","message":{...}} → 跳过（信息冗余）
 * - {"type":"message_update","assistantMessageEvent":{"type":"thinking_start|thinking_delta|thinking_end|toolcall_start|toolcall_delta|toolcall_end",...}}
 *     - thinking_delta / toolcall_delta → 跳过（流式增量，噪声）
 *     - thinking_end → progress（完整 thinking 内容）
 *     - toolcall_end → tool_call（提取 toolCall.name 和 arguments 摘要）
 * - {"type":"tool_execution_start","toolCallId":"...","toolName":"read|write|bash|...","args":{...}}
 *     → progress（标注工具开始执行）
 * - {"type":"tool_execution_end","toolCallId":"...","toolName":"...","result":{...},"isError":false}
 *     → tool_result（exitCode = isError ? 1 : 0；bytes 估算）
 * - {"type":"turn_end","message":{...},"toolResults":[...],"isTerminal":true}
 *     → 若 isTerminal=true，产出 completed；否则 progress
 * - {"type":"error",...} → error
 *
 * 容错策略：
 * - 解析失败的行跳过并产出 progress 事件标注跳过原因
 * - 未知事件类型降级为 progress（保留原始 type 与 200 字符摘要）
 * - thinking_delta/toolcall_delta 等高频低价值事件直接跳过，避免日志爆炸
 */
export function parseOmpNdjsonEvents(
  stdout: string,
  runId: string
): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // 非 JSON 行：可能是 omp 的非结构化输出，跳过但记 progress
      events.push({
        type: "progress",
        runId,
        message: `[non-json-line] ${trimmed.slice(0, 200)}`,
        at: new Date().toISOString()
      });
      continue;
    }
    const ev = mapOmpObjectToRuntimeEvent(obj, runId);
    if (ev) events.push(ev);
  }
  return events;
}

/**
 * 把单个 omp 事件对象映射为 RuntimeEvent。返回 undefined 表示完全跳过。
 *
 * 容错策略：字段缺失时降级为 progress；类型未知时降级为 progress。
 */
function mapOmpObjectToRuntimeEvent(
  obj: Record<string, unknown>,
  runId: string
): RuntimeEvent | undefined {
  const type = typeof obj.type === "string" ? obj.type : "";
  const at = typeof obj.at === "string" ? obj.at : new Date().toISOString();

  // session：omp 启动后第一条事件
  if (type === "session") {
    return {
      type: "started",
      runId,
      taskId: "",
      at
    };
  }
  // agent_start：agent 已启动
  if (type === "agent_start") {
    return {
      type: "progress",
      runId,
      message: "omp agent 已启动",
      at
    };
  }
  // turn_start / turn_end：回合边界
  if (type === "turn_start") {
    return undefined; // 噪声跳过
  }
  if (type === "turn_end") {
    const isTerminal = typeof obj.isTerminal === "boolean" ? obj.isTerminal : false;
    if (isTerminal) {
      return {
        type: "completed",
        runId,
        at,
        summary: "omp 会话已结束（isTerminal=true）"
      };
    }
    return undefined; // 非终止回合跳过
  }
  // message_start / message_end：消息边界，信息冗余，跳过
  if (type === "message_start" || type === "message_end") {
    return undefined;
  }
  // message_update：流式增量，按 assistantMessageEvent.type 细分
  if (type === "message_update") {
    const amsg = obj.assistantMessageEvent as Record<string, unknown> | undefined;
    if (!amsg) return undefined;
    const subType = typeof amsg.type === "string" ? amsg.type : "";
    // thinking_end：完整 thinking 内容
    if (subType === "thinking_end") {
      const content = typeof amsg.content === "string" ? amsg.content : "";
      if (!content) return undefined;
      return {
        type: "progress",
        runId,
        message: `[thinking] ${content.slice(0, 500)}`,
        at
      };
    }
    // toolcall_end：完整工具调用结构
    if (subType === "toolcall_end") {
      const toolCall = amsg.toolCall as Record<string, unknown> | undefined;
      const toolName = toolCall && typeof toolCall.name === "string" ? toolCall.name : "unknown";
      const intent = toolCall && typeof (toolCall as { intent?: unknown }).intent === "string"
        ? (toolCall as { intent: string }).intent
        : "";
      const args = toolCall?.arguments as Record<string, unknown> | undefined;
      return {
        type: "tool_call",
        runId,
        tool: toolName,
        argv: intent ? [intent] : [],
        cwd: typeof (args as { cwd?: unknown })?.cwd === "string"
          ? (args as { cwd: string }).cwd
          : undefined,
        at
      };
    }
    // thinking_start / thinking_delta / toolcall_start / toolcall_delta：高频噪声跳过
    return undefined;
  }
  // tool_execution_start：工具开始执行
  if (type === "tool_execution_start") {
    const toolName = typeof obj.toolName === "string" ? obj.toolName : "unknown";
    const args = obj.args as Record<string, unknown> | undefined;
    const intent = args && typeof (args as { i?: unknown }).i === "string"
      ? (args as { i: string }).i
      : "";
    return {
      type: "progress",
      runId,
      message: `[tool_start] ${toolName}${intent ? `: ${intent}` : ""}`,
      at
    };
  }
  // tool_execution_end：工具执行完成
  if (type === "tool_execution_end") {
    const isError = typeof obj.isError === "boolean" ? obj.isError : false;
    const result = obj.result as Record<string, unknown> | undefined;
    const content = result && Array.isArray(result.content)
      ? (result.content as Array<{ type?: string; text?: string }>)
          .map((c) => c?.text ?? "")
          .join("")
      : "";
    const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : 0;
    return {
      type: "tool_result",
      runId,
      exitCode: isError ? 1 : 0,
      truncated: false,
      bytes,
      at
    };
  }
  // error
  if (type === "error" || type === "failed") {
    const message = typeof obj.message === "string" ? obj.message : JSON.stringify(obj).slice(0, 200);
    return {
      type: "error",
      runId,
      at,
      message
    };
  }
  // 未知类型：降级为 progress，保留原始 type 与 200 字符摘要
  return {
    type: "progress",
    runId,
    message: `[unknown-event:${type || "no-type"}] ${JSON.stringify(obj).slice(0, 200)}`,
    at
  };
}

/**
 * 从 omp review 的 stdout 中提取 ReviewResult JSON。
 *
 * 生产 Review 使用 text 模式并直接接收最终 assistant 文本；本函数兼容历史
 * NDJSON 夹具与调用方的 assistant 文本提取。两条路径都只接受裸 JSON 或恰好
 * 一层完整 Markdown JSON 围栏，不从说明文字中扫描或拼接对象。
 *
 * 字段校验：verdict 必须是 ship/ship_with_fixes/block；findings 数组每项
 * 必须有 priority、confidence、category 和非空 message。任何字段缺失或
 * 枚举非法都返回 block + P1 finding，禁止失败开放。
 */
export function extractReviewResult(
  stdout: string,
  input: ReviewTaskInput
): ReviewResult {
  const assistantText = extractAssistantTextFromOmpNdjson(stdout);
  const textModeMetrics = {
    outputMode: "text" as const,
    textSegmentCount: stdout.trim().length > 0 ? 1 : 0
  };
  if (assistantText.text !== null) {
    if (assistantText.reason) {
      return parseReviewResultText("", input, assistantText.reason, {
        outputMode: "ndjson",
        textSegmentCount: assistantText.textSegmentCount
      });
    }
    return parseReviewResultText(assistantText.text, input, undefined, {
      outputMode: "ndjson",
      textSegmentCount: assistantText.textSegmentCount
    });
  }

  if (assistantText.sawOmpEvent) {
    return parseReviewResultText("", input, assistantText.reason, {
      outputMode: "ndjson",
      textSegmentCount: assistantText.textSegmentCount
    });
  }

  // text 模式和本地 stub 都必须提供完整 JSON；不会从任意说明文字中抽取对象。
  return parseReviewResultText(stdout, input, assistantText.reason, textModeMetrics);
}

/**
 * 从 Omp `--mode json` 的 NDJSON 中提取 assistant 最终文本。
 *
 * 只读取 `message_end.message.content[]` 中 `role=assistant` 且
 * `type=text` 的内容，并按消息和内容块出现顺序拼接。thinking、tool、
 * session、turn_end 以及其他角色的消息都不会进入结果。
 *
 * 返回 null 表示没有可用于 Review 的 terminal assistant 文本，调用方必须
 * 失败关闭；该函数不执行任何文件、进程或网络操作。
 */
export function extractAssistantTextFromOmpNdjson(
  stdout: string
): {
  readonly text: string | null;
  readonly reason: string;
  readonly sawOmpEvent: boolean;
  /** NDJSON 中实际收集到的 assistant text 内容段数量。 */
  readonly textSegmentCount: number;
} {
  const assistantTexts: string[] = [];
  let sawAssistantMessage = false;
  let sawInvalidNdjsonLine = false;
  let sawOmpEvent = false;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        sawInvalidNdjsonLine = true;
        continue;
      }
      obj = parsed as Record<string, unknown>;
    } catch {
      // develop 允许忽略 Omp 附带的非结构化日志；Review 会在下方看到
      // reason 后失败关闭，不会把不完整流当成合法 Review。
      sawInvalidNdjsonLine = true;
      continue;
    }

    if (typeof obj.type === "string") sawOmpEvent = true;
    if (obj.type !== "message_end") continue;
    const message = obj.message as Record<string, unknown> | undefined;
    if (!message || message.role !== "assistant") continue;

    sawAssistantMessage = true;
    const content = message.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const block = part as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        assistantTexts.push(block.text);
      }
    }
  }

  const text = assistantTexts.join("");
  if (text.length > 0) {
    return {
      text,
      reason: sawInvalidNdjsonLine ? "Omp NDJSON 包含无法解析的行" : "",
      sawOmpEvent,
      textSegmentCount: assistantTexts.length
    };
  }

  return {
    text: null,
    reason: sawAssistantMessage
      ? "terminal assistant message 缺少非空 text 内容"
      : "未找到 terminal assistant message",
    sawOmpEvent,
    textSegmentCount: assistantTexts.length
  };
}

interface ReviewOutputMetrics {
  readonly truncated?: boolean;
  readonly originalBytes?: number;
  readonly retainedBytes?: number;
  /** text 表示最终 stdout 段；ndjson 表示 assistant content 段。 */
  readonly outputMode?: "text" | "ndjson";
  readonly textSegmentCount?: number;
}

interface ReviewTextDiagnostics extends ReviewOutputMetrics {
  readonly stdoutBytes: number;
  readonly markdownFenceStart: boolean;
  readonly markdownFenceEnd: boolean;
  readonly normalizationForm:
    | "bare"
    | "paired_fence"
    | "opening_fence_only"
    | "closing_fence_only"
    | "invalid_fence";
  readonly closingFenceOnLastLine: boolean;
  readonly objectStartsWithBrace: boolean;
  readonly objectEndsWithBrace: boolean;
  readonly internalFence: boolean;
  readonly normalizationError?: "markdown_fence_invalid";
  readonly jsonErrorCategory?:
    | "non_json_text"
    | "incomplete_json"
    | "trailing_content"
    | "invalid_json"
    | "json_non_object"
    | "markdown_fence_invalid";
  readonly jsonErrorPosition?: number;
}

interface NormalizedReviewText {
  readonly text: string;
  readonly markdownFenceStart: boolean;
  readonly markdownFenceEnd: boolean;
  readonly normalizationForm: ReviewTextDiagnostics["normalizationForm"];
  readonly closingFenceOnLastLine: boolean;
  readonly objectStartsWithBrace: boolean;
  readonly objectEndsWithBrace: boolean;
  readonly internalFence: boolean;
  readonly normalizationError?: "markdown_fence_invalid";
}

function normalizeReviewText(text: string): NormalizedReviewText {
  const trimmed = text.trim();
  const markdownFenceStart = trimmed.startsWith("```");
  const markdownFenceEnd = trimmed.endsWith("```");
  const openingMatch = /^```(?:json)?[ \t]*\r?\n/i.exec(trimmed);
  const closingMatch = /\r?\n```$/.exec(trimmed);
  const closingFenceOnLastLine = closingMatch !== null;
  const closingIndex = closingMatch?.index;
  const shapeStart = openingMatch?.[0].length ?? 0;
  const shapeEnd = closingIndex ?? trimmed.length;
  const shapeText = shapeEnd >= shapeStart
    ? trimmed.slice(shapeStart, shapeEnd).trim()
    : "";
  const fenceMarkerCount = countMarkdownFenceMarkers(trimmed);
  const boundaryFenceCount = Number(markdownFenceStart) + Number(markdownFenceEnd);
  const metadata = {
    markdownFenceStart,
    markdownFenceEnd,
    closingFenceOnLastLine,
    objectStartsWithBrace: shapeText.startsWith("{"),
    objectEndsWithBrace: shapeText.endsWith("}"),
    internalFence: fenceMarkerCount > boundaryFenceCount
  };

  const invalidFence = (): NormalizedReviewText => ({
    text: trimmed,
    ...metadata,
    normalizationForm: "invalid_fence",
    normalizationError: "markdown_fence_invalid"
  });

  if (!markdownFenceStart && !markdownFenceEnd) {
    if (trimmed.includes("```")) return invalidFence();
    return {
      text: trimmed,
      ...metadata,
      normalizationForm: "bare"
    };
  }

  if (markdownFenceStart && markdownFenceEnd) {
    const match = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
    const inner = match?.[1];
    if (inner === undefined || inner.includes("```")) return invalidFence();
    return {
      text: inner.trim(),
      ...metadata,
      normalizationForm: "paired_fence"
    };
  }

  if (markdownFenceStart) {
    const inner = openingMatch
      ? trimmed.slice(openingMatch[0].length).trim()
      : "";
    if (!openingMatch || inner.includes("```") || !inner.endsWith("}")) {
      return invalidFence();
    }
    return {
      text: inner,
      ...metadata,
      normalizationForm: "opening_fence_only"
    };
  }

  const body = closingIndex === undefined ? "" : trimmed.slice(0, closingIndex).trimEnd();
  if (
    closingIndex === undefined ||
    !body.startsWith("{") ||
    !body.endsWith("}") ||
    body.includes("```")
  ) {
    return invalidFence();
  }
  return {
    text: body,
    ...metadata,
    normalizationForm: "closing_fence_only"
  };
}

function countMarkdownFenceMarkers(text: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf("```", offset);
    if (index < 0) return count;
    count += 1;
    offset = index + 3;
  }
}

function classifyReviewJsonError(
  error: unknown,
  text: string,
  normalizationError?: "markdown_fence_invalid"
): { category: ReviewTextDiagnostics["jsonErrorCategory"]; position?: number } {
  if (normalizationError) return { category: normalizationError };
  const message = error instanceof SyntaxError ? error.message : "";
  const positionMatch = /(?:at position|position)\s+(\d+)/i.exec(message);
  const position = positionMatch ? Number(positionMatch[1]) : undefined;
  if (/unexpected end/i.test(message)) {
    return { category: "incomplete_json", ...(position !== undefined ? { position } : {}) };
  }
  if (/non-whitespace character after JSON/i.test(message)) {
    return { category: "trailing_content", ...(position !== undefined ? { position } : {}) };
  }
  const firstCharacter = text.trim().charAt(0);
  if (firstCharacter !== "{" && firstCharacter !== "[") {
    return { category: "non_json_text", ...(position !== undefined ? { position } : {}) };
  }
  return { category: "invalid_json", ...(position !== undefined ? { position } : {}) };
}

function formatReviewTextDiagnostics(diagnostics: ReviewTextDiagnostics): string {
  return JSON.stringify({
    stdoutBytes: diagnostics.stdoutBytes,
    markdownFenceStart: diagnostics.markdownFenceStart,
    markdownFenceEnd: diagnostics.markdownFenceEnd,
    normalizationForm: diagnostics.normalizationForm,
    closingFenceOnLastLine: diagnostics.closingFenceOnLastLine,
    objectStartsWithBrace: diagnostics.objectStartsWithBrace,
    objectEndsWithBrace: diagnostics.objectEndsWithBrace,
    internalFence: diagnostics.internalFence,
    ...(diagnostics.outputMode !== undefined
      ? { outputMode: diagnostics.outputMode }
      : {}),
    ...(diagnostics.textSegmentCount !== undefined
      ? { textSegmentCount: diagnostics.textSegmentCount }
      : {}),
    ...(diagnostics.normalizationError
      ? { normalizationError: diagnostics.normalizationError }
      : {}),
    ...(diagnostics.jsonErrorCategory
      ? { jsonErrorCategory: diagnostics.jsonErrorCategory }
      : {}),
    ...(diagnostics.jsonErrorPosition !== undefined
      ? { jsonErrorPosition: diagnostics.jsonErrorPosition }
      : {}),
    ...(diagnostics.truncated !== undefined ? { truncated: diagnostics.truncated } : {}),
    ...(diagnostics.originalBytes !== undefined
      ? { originalBytes: diagnostics.originalBytes }
      : {}),
    ...(diagnostics.retainedBytes !== undefined
      ? { retainedBytes: diagnostics.retainedBytes }
      : {})
  });
}

function parseReviewResultText(
  text: string,
  input: ReviewTaskInput,
  extractionReason?: string,
  outputMetrics?: ReviewOutputMetrics
): ReviewResult {
  const normalized = normalizeReviewText(text);
  let diagnostics: ReviewTextDiagnostics = {
    stdoutBytes: Buffer.byteLength(text, "utf8"),
    markdownFenceStart: normalized.markdownFenceStart,
    markdownFenceEnd: normalized.markdownFenceEnd,
    normalizationForm: normalized.normalizationForm,
    closingFenceOnLastLine: normalized.closingFenceOnLastLine,
    objectStartsWithBrace: normalized.objectStartsWithBrace,
    objectEndsWithBrace: normalized.objectEndsWithBrace,
    internalFence: normalized.internalFence,
    ...(normalized.normalizationError
      ? { normalizationError: normalized.normalizationError }
      : {}),
    ...(outputMetrics ?? {})
  };

  // 只对裸 JSON、完整成对围栏或严格单边围栏归一化后的全文解析。
  let candidate: unknown = null;
  if (normalized.normalizationError) {
    // 归一化器已经确认存在未受控围栏；即使原文碰巧是合法 JSON，也不得
    // 继续进入 schema 成功路径，否则 invalid_fence 的安全边界会失效。
    diagnostics = {
      ...diagnostics,
      jsonErrorCategory: "markdown_fence_invalid"
    };
  } else {
    try {
      candidate = JSON.parse(normalized.text);
    } catch (error) {
      const parseError = classifyReviewJsonError(error, normalized.text, normalized.normalizationError);
      diagnostics = {
        ...diagnostics,
        jsonErrorCategory: parseError.category,
        ...(parseError.position !== undefined ? { jsonErrorPosition: parseError.position } : {})
      };
    }
  }

  if (candidate !== null && (typeof candidate !== "object" || Array.isArray(candidate))) {
    diagnostics = { ...diagnostics, jsonErrorCategory: "json_non_object" };
  }

  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const obj = candidate as Record<string, unknown>;
    const verdict = normalizeVerdict(obj.verdict);
    if (!isReviewVerdict(obj.verdict)) {
      return invalidReviewSchema(input, "verdict 缺失或非法", formatReviewTextDiagnostics(diagnostics));
    }
    const findings = normalizeFindings(obj.findings);
    if (findings.error) {
      return invalidReviewSchema(input, findings.error, formatReviewTextDiagnostics(diagnostics));
    }
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    if (summary.length === 0) {
      return invalidReviewSchema(input, "summary 必须是非空字符串", formatReviewTextDiagnostics(diagnostics));
    }
    const rootCause = normalizeHypothesis(obj.rootCause);
    if (verdict !== "block" && rootCause.error) {
      return invalidReviewSchema(input, rootCause.error, formatReviewTextDiagnostics(diagnostics));
    }
    if (obj.rootCause !== undefined && rootCause.error) {
      return invalidReviewSchema(input, rootCause.error, formatReviewTextDiagnostics(diagnostics));
    }
    const fixSummary = typeof obj.fixSummary === "string" && obj.fixSummary.trim().length > 0
      ? obj.fixSummary.trim()
      : undefined;
    if (obj.fixSummary !== undefined && fixSummary === undefined) {
      return invalidReviewSchema(input, "fixSummary 必须是非空字符串", formatReviewTextDiagnostics(diagnostics));
    }
    const applicabilityConditions = normalizeEvidenceConstraints(obj.applicabilityConditions);
    if (applicabilityConditions.error) {
      return invalidReviewSchema(input, applicabilityConditions.error, formatReviewTextDiagnostics(diagnostics));
    }
    return {
      verdict,
      findings: findings.items,
      summary,
      ...(rootCause.item !== undefined ? { rootCause: rootCause.item } : {}),
      ...(fixSummary !== undefined ? { fixSummary } : {}),
      ...(applicabilityConditions.items !== undefined
        ? { applicabilityConditions: applicabilityConditions.items }
        : {})
    };
  }

  // 回退：无法解析时返回 block + P1 finding，提示人工复核。
  // 不把 stdout 原文放入响应，避免 prompt、凭据或业务内容泄漏。
  const reason = extractionReason || "assistant 文本不是完整 ReviewResult JSON";
  const diagnosticText = formatReviewTextDiagnostics(diagnostics);
  return {
    verdict: "block",
    findings: [
      {
        priority: "P1",
        confidence: 0.5,
        category: "other",
        message: `omp review 输出无法解析为 ReviewResult JSON，已回退到 block。原因：${reason}；诊断：${diagnosticText}`
      }
    ],
    summary: `OmpAdapter review 回退（任务 ${input.taskId}）：${reason}；诊断：${diagnosticText}`
  };
}

function normalizeVerdict(v: unknown): ReviewResult["verdict"] {
  if (v === "ship" || v === "ship_with_fixes" || v === "block") return v;
  return "block"; // 未知值保守视为 block
}

function isReviewVerdict(v: unknown): v is ReviewResult["verdict"] {
  return v === "ship" || v === "ship_with_fixes" || v === "block";
}

function invalidReviewSchema(
  input: ReviewTaskInput,
  reason: string,
  diagnostics?: string
): ReviewResult {
  const diagnosticSuffix = diagnostics ? `；诊断：${diagnostics}` : "";
  return {
    verdict: "block",
    findings: [
      {
        priority: "P1",
        confidence: 1,
        category: "other",
        message: `omp review 输出不符合严格 Review schema：${reason}${diagnosticSuffix}`
      }
    ],
    summary: `OmpAdapter review 失败关闭（任务 ${input.taskId}）：${reason}${diagnosticSuffix}`
  };
}

function truncatedReviewResult(
  input: ReviewTaskInput,
  result: CommandResult
): ReviewResult {
  const normalized = normalizeReviewText(result.stdout);
  const reason = [
    `truncated=${result.truncated}`,
    `originalBytes=${result.originalBytes}`,
    `retainedBytes=${result.retainedBytes}`,
    `stdoutBytes=${Buffer.byteLength(result.stdout, "utf8")}`,
    `markdownFenceStart=${normalized.markdownFenceStart}`,
    `markdownFenceEnd=${normalized.markdownFenceEnd}`,
    `normalizationForm=${normalized.normalizationForm}`,
    `closingFenceOnLastLine=${normalized.closingFenceOnLastLine}`,
    `objectStartsWithBrace=${normalized.objectStartsWithBrace}`,
    `objectEndsWithBrace=${normalized.objectEndsWithBrace}`,
    `internalFence=${normalized.internalFence}`,
    "outputMode=text",
    `textSegmentCount=${result.stdout.trim().length > 0 ? 1 : 0}`
  ].join(", ");
  return {
    verdict: "block",
    findings: [
      {
        priority: "P1",
        confidence: 1,
        category: "other",
        message: `omp review 输出被截断，已失败关闭：${reason}`
      }
    ],
    summary: `OmpAdapter review 失败关闭（任务 ${input.taskId}）：输出截断（${reason}）`
  };
}

function normalizeHypothesis(
  value: unknown
): { item?: Hypothesis; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "rootCause 必须是包含 text、confidence、evidenceIds 的对象" };
  }
  const obj = value as Record<string, unknown>;
  const text = typeof obj.text === "string" ? obj.text.trim() : "";
  if (text.length === 0) return { error: "rootCause.text 不能为空" };
  if (
    typeof obj.confidence !== "number" ||
    !Number.isFinite(obj.confidence) ||
    obj.confidence < 0 ||
    obj.confidence > 1
  ) {
    return { error: "rootCause.confidence 必须是 0 到 1 之间的数字" };
  }
  const evidenceIds = normalizeEvidenceIds(obj.evidenceIds, "rootCause.evidenceIds");
  if (evidenceIds.error) return { error: evidenceIds.error };
  return {
    item: {
      text,
      confidence: obj.confidence,
      evidenceIds: evidenceIds.items ?? []
    }
  };
}

function normalizeEvidenceConstraints(
  value: unknown
): { items?: readonly EvidenceConstraint[]; error?: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    return { error: "applicabilityConditions 必须是数组" };
  }
  const items: EvidenceConstraint[] = [];
  for (const [index, condition] of value.entries()) {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
      return { error: `applicabilityConditions[${index}] 必须是对象` };
    }
    const obj = condition as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    if (text.length === 0) {
      return { error: `applicabilityConditions[${index}].text 不能为空` };
    }
    if (typeof obj.required !== "boolean") {
      return { error: `applicabilityConditions[${index}].required 必须是 boolean` };
    }
    const evidenceIds = normalizeEvidenceIds(
      obj.evidenceIds,
      `applicabilityConditions[${index}].evidenceIds`
    );
    if (evidenceIds.error) return { error: evidenceIds.error };
    items.push({
      text,
      required: obj.required,
      evidenceIds: evidenceIds.items ?? []
    });
  }
  return { items };
}

function normalizeEvidenceIds(
  value: unknown,
  field: string
): { items?: readonly string[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: `${field} 必须是非空字符串数组` };
  }
  const items: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || id.trim().length === 0) {
      return { error: `${field} 只能包含非空字符串` };
    }
    items.push(id.trim());
  }
  if (new Set(items).size !== items.length) {
    return { error: `${field} 不得包含重复 ID` };
  }
  return { items };
}

function normalizeFindings(
  f: unknown
): { items: ReviewFinding[]; error?: string } {
  if (!Array.isArray(f)) return { items: [], error: "findings 必须是数组" };
  const out: ReviewFinding[] = [];
  for (const [index, item] of f.entries()) {
    if (!item || typeof item !== "object") {
      return { items: [], error: `findings[${index}] 必须是对象` };
    }
    const obj = item as Record<string, unknown>;
    const priority = obj.priority;
    const message = typeof obj.message === "string" ? obj.message.trim() : "";
    if (
      priority !== "P0" && priority !== "P1" && priority !== "P2" && priority !== "P3"
    ) {
      return { items: [], error: `findings[${index}].priority 非法` };
    }
    if (message.length === 0) {
      return { items: [], error: `findings[${index}].message 不能为空` };
    }
    if (
      typeof obj.confidence !== "number" ||
      !Number.isFinite(obj.confidence) ||
      obj.confidence < 0 ||
      obj.confidence > 1
    ) {
      return { items: [], error: `findings[${index}].confidence 必须是 0 到 1 之间的数字` };
    }
    const category = normalizeFindingCategory(obj.category);
    if (category === undefined) {
      return { items: [], error: `findings[${index}].category 缺失或非法` };
    }
    const locator = typeof obj.locator === "string" ? obj.locator : undefined;
    out.push({
      priority,
      confidence: obj.confidence,
      message,
      ...(locator !== undefined ? { locator } : {}),
      category
    });
  }
  return { items: out };
}

function normalizeFindingCategory(
  category: unknown
): "compatibility" | "regression_test" | "correctness" | "security" | "maintainability" | "other" | undefined {
  if (
    category === "compatibility" ||
    category === "regression_test" ||
    category === "correctness" ||
    category === "security" ||
    category === "maintainability" ||
    category === "other"
  ) {
    return category;
  }
  return undefined;
}

function formatProjectCommands(commands: ProjectCommands): string[] {
  const lines: string[] = [];
  const keys = Object.keys(commands).sort();
  for (const key of keys) {
    const spec = commands[key as keyof ProjectCommands];
    if (spec) {
      lines.push(`- ${key}: argv=${JSON.stringify(spec.argv)} timeoutMs=${spec.timeoutMs}`);
    }
  }
  return lines;
}

function truncateStderr(stderr: string, max = 500): string {
  if (stderr.length <= max) return stderr;
  return `${stderr.slice(0, max)}...(truncated)`;
}

// --------------------------------------------------------------------------
// P1-R01（§18 受控文件工具代理）：从 omp stdout 中提取文件修改指令
// --------------------------------------------------------------------------

/**
 * 从 omp NDJSON stdout 中提取 `<file_change>` XML 文件修改指令。
 *
 * omp develop 阶段使用只读工具集（`--tools read,grep,glob`），无写入能力。
 * omp 在 assistant 消息文本中通过 `<file_change path="...">...</file_change>`
 * XML 块输出文件修改指令，由 TracePilot 的 `ControlledFileWriter` 代为写入。
 *
 * 解析策略：
 * 1. 逐行解析 NDJSON，收集所有 `message_end` 事件中 role=assistant 的
 *    text 内容（omp `--mode json` 把 assistant 文本消息放在 message_end
 *    事件的 content 数组中，type=text）。
 * 2. 拼接所有 assistant 文本，扫描 `<file_change>` 块。
 * 3. 每个 `<file_change path="...">...</file_change>` 提取为
 *    `FileChangeInstruction`。
 * 4. 内容支持 CDATA 包裹（`<![CDATA[...]]>`）或 XML 实体转义
 *    （`&lt;`/`&gt;`/`&amp;`/`&quot;`/`&apos;`）。
 *
 * 容错策略：
 * - 非 JSON 行直接跳过（不抛错，由 parseOmpNdjsonEvents 已记 progress）；
 * - 无 assistant 消息时返回空数组（develop 产出 0 个修改）；
 * - `<file_change>` 块格式不合法时跳过该块，不影响其他块；
 * - path 属性缺失或为空时跳过该块。
 *
 * 安全说明：本函数只做解析，不做路径校验。路径校验由
 * `ControlledFileWriter.writeFiles` 在写入前同步完成（操作前强制边界）。
 *
 * @param stdout omp --mode json 的完整 NDJSON 输出
 * @returns 文件修改指令列表（可能为空）
 */
export function extractFileChangesFromStdout(stdout: string): FileChangeInstruction[] {
  const assistantText = extractAssistantTextFromOmpNdjson(stdout);
  return extractFileChangesFromText(assistantText.text ?? "");
}

/**
 * 从纯文本中提取 `<file_change>` XML 文件修改指令。
 *
 * 导出供单元测试直接验证解析逻辑（不依赖 NDJSON 结构）。
 *
 * 格式：
 *   <file_change path="src/users.py">
 *   <![CDATA[
 *   文件完整新内容
 *   ]]>
 *   </file_change>
 *
 * 或（无 CDATA，使用 XML 实体转义）：
 *   <file_change path="src/users.py">def hello(): pass</file_change>
 *
 * 解析规则：
 * - path 属性必填，必须是引号包裹的非空字符串；
 * - 内容若以 `<![CDATA[` 开头并以 `]]>` 结尾，提取 CDATA 内的原始内容；
 * - 否则对内容做 XML 实体反转义（`&lt;`→`<` 等）；
 * - 内容首尾的空白会被裁剪（避免 XML 缩进污染文件内容）；
 * - 重叠/嵌套的 `<file_change>` 块按非贪婪匹配逐个提取。
 */
export function extractFileChangesFromText(text: string): FileChangeInstruction[] {
  const changes: FileChangeInstruction[] = [];
  // 非贪婪匹配 `<file_change path="...">...</file_change>`，允许多行内容
  const regex = /<file_change\s+path="([^"]+)"\s*>([\s\S]*?)<\/file_change>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const relativePath = match[1];
    if (!relativePath) continue;
    // 先裁剪外层空白（XML 缩进/换行不应影响 CDATA 检测）
    let content = (match[2] ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
    // 优先处理 CDATA 包裹：`<![CDATA[...]]>`
    const cdataMatch = content.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
    if (cdataMatch) {
      // CDATA 内容不反转义（CDATA 内是原始字符），但裁剪首尾空白
      // （XML 格式化引入的换行和缩进不应进入文件内容）
      content = (cdataMatch[1] ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
    } else {
      // 非 CDATA：做 XML 实体反转义
      // （顺序很重要：&amp; 必须最后处理，否则 &amp;lt; 会被错误解码为 <）
      content = content
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
    }
    changes.push({ relativePath, content });
  }
  return changes;
}
