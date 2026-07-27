/**
 * LocalGitAdapter —— Phase 3 任务 5。
 *
 * 真实 GitAdapter 实现，所有 git 命令经注入的 ProcessRunner 执行，
 * argv 经 CommandPolicy 校验，cwd 经 PathPolicy 校验。禁止直接
 * `child_process.spawn`。
 *
 * 安全边界（P1-02 修复）：
 * - `allowedWorktreeRoots`：唯一受控 worktree 根目录，仅用于
 *   `createWorktree` 的目标路径与 `removeRegisteredWorktree` 的路径校验。
 * - `allowedRepositoryRoots`：已登记的项目仓库根目录，仅用于
 *   `validateRepository` / `getHistory` / `getBlame` / `createWorktree`
 *   的源仓库命令与 `removeRegisteredWorktree` 解析出的源仓库根。
 * - 生产环境 `allowedWorktreeRoots` 必须是唯一外置 worktree 根目录
 *   （ADR-002），源仓库路径不得混入此列表。
 *
 * 安全边界（P1-01 修复）：
 * - `removeRegisteredWorktree` 仅做 PathPolicy 校验与受控清理，
 *   不校验数据库登记或任务终态 —— 那是 WorktreeManager 的职责。
 *   Adapter 不得把调用方传入的任意对象视为"已登记"。
 *
 * 审计链（P1-03 修复）：
 * - 每次 git 命令执行后，若调用方提供了 GitCommandAuditSink，
 *   上报 argv、cwd、exitCode、outputTruncation。
 * - 应用/编排层（WorktreeManager / EvidenceCollector）消费这些审计，
 *   在同一 SQLite 真源追加结构化审计事件（§7.3）。
 *
 * 命令分类：
 * - 只读 git 子命令（log/show/diff/blame/status/rev-parse）由
 *   CommandPolicy 自动允许（§7.2）。
 * - `git worktree add` 归类为 needs_execution_approval，LocalGitAdapter
 *   作为受控 Manager 直接执行；执行审批由 Orchestrator 在
 *   AWAITING_EXECUTION_APPROVAL 状态下处理。
 * - `git worktree remove` 在 CommandPolicy 中默认拒绝（删除性操作）。
 *   `removeRegisteredWorktree` 在 PathPolicy 校验通过后直接调用
 *   ProcessRunner.run，不经过 CommandPolicy —— 这是 ADR-002 的受控
 *   清理策略，CommandPolicy 的默认拒绝仍对未受控调用方有效。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomId } from "@tracepilot/core";
import type {
  GitAdapter,
  GitCommandAudit,
  GitCommandAuditSink,
  CreateWorktreeInput,
  Worktree,
  DiffArtifact,
  GitQuery,
  GitEvidence,
  BlameQuery,
  BlameEvidence,
  RepositoryInfo,
  CommandSpec,
  CommandResult,
  ProcessRunner,
  ProcessPolicy,
  CommandPolicy,
  PathPolicy,
  ProjectCommands,
  OutputTruncation
} from "@tracepilot/core";
import { PolicyDeniedError } from "./local-command-adapter.js";
import {
  parseGitLog,
  parseGitBlame,
  parseGitDiffChangedFiles,
  parseGitStatusPorcelain
} from "./git-parsers.js";

export interface LocalGitAdapterOptions {
  /** 受治理的 ProcessRunner —— 所有子进程必须经它执行。 */
  readonly processRunner: ProcessRunner;
  /** 命令策略 —— 校验 argv 是否在白名单或自动允许范围内。 */
  readonly commandPolicy: CommandPolicy;
  /** 路径策略 —— 校验 cwd 是否位于受控根目录内。 */
  readonly pathPolicy: PathPolicy;
  /** 进程执行策略 —— 超时、输出上限、允许的 cwd 根目录。 */
  readonly processPolicy: ProcessPolicy;
  /**
   * 受控 worktree 根目录列表（createWorktree 在此创建子目录，
   * removeRegisteredWorktree 仅允许此根内的路径）。
   * 生产环境必须只注入唯一外置 worktree 根目录（ADR-002）。
   */
  readonly allowedWorktreeRoots: readonly string[];
  /**
   * P1-02：已登记的项目仓库根目录列表（validateRepository /
   * getHistory / getBlame / createWorktree 的源仓库命令仅允许此根）。
   * 与 allowedWorktreeRoots 分离，避免源仓库路径被误当作 worktree 根。
   */
  readonly allowedRepositoryRoots: readonly string[];
  /** 项目登记的命令白名单（用于 CommandPolicy.decide）。 */
  readonly projectCommands: ProjectCommands;
}

/** 标识 cwd 应校验 against worktree 根还是项目仓库根。 */
type RootKind = "worktree" | "repository";

export class LocalGitAdapter implements GitAdapter {
  constructor(private readonly opts: LocalGitAdapterOptions) {}

  async validateRepository(
    projectPath: string,
    auditSink?: GitCommandAuditSink
  ): Promise<RepositoryInfo> {
    // 1. git rev-parse --show-toplevel —— 失败（非仓库）抛结构化错误。
    let toplevel: string;
    try {
      const toplevelResult = await this.runGoverned(
        ["git", "rev-parse", "--show-toplevel"],
        projectPath,
        "repository",
        auditSink
      );
      toplevel = toplevelResult.stdout.trim();
    } catch (err) {
      // PolicyDeniedError 表示路径不在受控根目录内，应原样上抛；
      // 其他错误（git 命令失败）视为非 git 仓库。
      if (err instanceof PolicyDeniedError) throw err;
      throw new Error(`路径不是 git 仓库: ${projectPath}`);
    }

    // 2. git rev-parse --abbrev-ref HEAD —— 当前分支名。
    const branchResult = await this.runGoverned(
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      projectPath,
      "repository",
      auditSink
    );
    const branch = branchResult.stdout.trim();

    // 3. git rev-parse HEAD —— head commit sha。
    const shaResult = await this.runGoverned(
      ["git", "rev-parse", "HEAD"],
      projectPath,
      "repository",
      auditSink
    );
    const sha = shaResult.stdout.trim();

    // 4. git status --porcelain —— 判断是否干净。
    const statusResult = await this.runGoverned(
      ["git", "status", "--porcelain"],
      projectPath,
      "repository",
      auditSink
    );
    const isClean = parseGitStatusPorcelain(statusResult.stdout);

    return {
      repositoryPath: toplevel,
      defaultBranch: branch,
      headCommitSha: sha,
      isClean
    };
  }

  async createWorktree(
    input: CreateWorktreeInput,
    auditSink?: GitCommandAuditSink
  ): Promise<Worktree> {
    // 1. 校验 taskId 不含 `..` 且不是绝对路径。
    if (input.taskId.includes("..") || isAbsolute(input.taskId)) {
      throw new Error(`taskId 含非法路径片段: ${input.taskId}`);
    }

    // 2. 计算 projectSlug：替换非字母数字为 `-`。
    const projectSlug = input.projectId.replace(/[^a-zA-Z0-9]/g, "-");

    // 3. 计算受控路径：<worktreeRoot>/<projectSlug>/<taskId>。
    const worktreeRoot = this.getWorktreeRoot();
    const targetPath = join(worktreeRoot, projectSlug, input.taskId);

    // 4. PathPolicy 校验目标路径位于受控 worktree 根目录内（P1-02：仅 worktreeRoot）。
    const pathDecision = this.opts.pathPolicy.decide(
      targetPath,
      this.opts.allowedWorktreeRoots
    );
    if (!pathDecision.allowed) {
      throw new PolicyDeniedError(
        `createWorktree at ${targetPath}`,
        pathDecision.reason
      );
    }

    // 5. 校验目标目录不存在（拒绝覆盖）。
    if (existsSync(targetPath)) {
      throw new Error(`worktree 目标目录已存在: ${targetPath}`);
    }

    // 6. 校验源仓库干净（isClean=true）。
    // P1-02：源仓库命令使用 repositoryRoot 校验。
    const repoInfo = await this.validateRepository(
      input.repositoryPath,
      auditSink
    );
    if (!repoInfo.isClean) {
      throw new Error("源仓库不干净，请先提交或 stash");
    }

    // 7. git worktree add <targetPath> -b tp/<taskId> <defaultBranch>。
    //    CommandPolicy 判定为 needs_execution_approval（allowed=true），
    //    LocalGitAdapter 作为受控 Manager 直接执行；执行审批由调用方
    //    Orchestrator 在 AWAITING_EXECUTION_APPROVAL 状态下处理。
    // P1-02：源仓库命令使用 repositoryRoot 校验。
    const branch = `tp/${input.taskId}`;
    await this.runGoverned(
      ["git", "worktree", "add", targetPath, "-b", branch, input.defaultBranch],
      input.repositoryPath,
      "repository",
      auditSink
    );

    // 8. 获取新 worktree 的 baseCommitSha。
    //    在新 worktree 目录内执行，使用 worktreeRoot 校验。
    const shaResult = await this.runGoverned(
      ["git", "rev-parse", "HEAD"],
      targetPath,
      "worktree",
      auditSink
    );
    const baseCommitSha = shaResult.stdout.trim();

    return {
      id: randomId("wt"),
      projectId: input.projectId,
      taskId: input.taskId,
      path: targetPath,
      branch,
      baseCommitSha,
      allowedPaths: input.allowedPaths,
      createdAt: new Date().toISOString()
    };
  }

  async getDiff(
    worktreePath: string,
    auditSink?: GitCommandAuditSink
  ): Promise<DiffArtifact> {
    // 1. git diff HEAD —— 完整 patch。
    // P1-02：worktree 内命令使用 worktreeRoot 校验。
    const diffResult = await this.runGoverned(
      ["git", "diff", "HEAD"],
      worktreePath,
      "worktree",
      auditSink
    );
    const patch = diffResult.stdout;

    // 2. git diff --name-only HEAD —— 变更文件列表。
    const filesResult = await this.runGoverned(
      ["git", "diff", "--name-only", "HEAD"],
      worktreePath,
      "worktree",
      auditSink
    );
    const changedFiles = parseGitDiffChangedFiles(filesResult.stdout);

    // 3. 计算 sha256 哈希。
    const hash = `sha256-${createHash("sha256").update(patch).digest("hex")}`;

    return {
      worktreePath,
      patch,
      hash,
      changedFiles,
      bytes: Buffer.byteLength(patch, "utf8")
    };
  }

  async getHistory(
    query: GitQuery,
    auditSink?: GitCommandAuditSink
  ): Promise<GitEvidence[]> {
    const maxCount = query.maxCount ?? 10;
    // 用 \x1f 分字段、\x1e 分 commit，由 parseGitLog 解析。
    const argv: string[] = [
      "git",
      "log",
      "--format=%H%x1f%an%x1f%aI%x1f%s%x1e",
      "-n",
      String(maxCount)
    ];
    if (query.paths && query.paths.length > 0) {
      argv.push("--", ...query.paths);
    }
    // P1-02：仓库历史查询使用 repositoryRoot 校验。
    const result = await this.runGoverned(
      argv,
      query.repositoryPath,
      "repository",
      auditSink
    );
    // files 字段默认为空数组，调用方按需单独获取。
    return parseGitLog(result.stdout);
  }

  async getBlame(
    query: BlameQuery,
    auditSink?: GitCommandAuditSink
  ): Promise<BlameEvidence[]> {
    const argv: string[] = ["git", "blame", "--line-porcelain"];
    if (query.startLine !== undefined && query.endLine !== undefined) {
      argv.push("-L", `${query.startLine},${query.endLine}`);
    } else if (query.startLine !== undefined) {
      argv.push("-L", `${query.startLine},`);
    }
    argv.push("--", query.path);
    // P1-02：blame 查询使用 repositoryRoot 校验。
    const result = await this.runGoverned(
      argv,
      query.repositoryPath,
      "repository",
      auditSink
    );
    return parseGitBlame(result.stdout);
  }

  async removeRegisteredWorktree(
    worktree: Worktree,
    auditSink?: GitCommandAuditSink
  ): Promise<void> {
    // P1-01：Adapter 不校验数据库登记或任务终态 —— 那是 WorktreeManager
    // 的职责。Adapter 仅做 PathPolicy 校验与受控清理。
    // 1. PathPolicy 校验 worktree.path 位于受控 worktree 根目录内（P1-02：仅 worktreeRoot）。
    const pathDecision = this.opts.pathPolicy.decide(
      worktree.path,
      this.opts.allowedWorktreeRoots
    );
    if (!pathDecision.allowed) {
      throw new PolicyDeniedError(
        `removeRegisteredWorktree at ${worktree.path}`,
        pathDecision.reason
      );
    }

    // 2. 发现源仓库路径：从 worktree 自身的 git 元数据读取 common dir。
    //    `git rev-parse --git-common-dir` 返回主仓库 .git 目录的绝对路径，
    //    其父目录即源仓库根路径。必须在源仓库上下文执行
    //    `git worktree remove`，否则 worktreeRoot 不是 git 仓库会报错。
    //    P1-03：记录审计。
    const commonDirResult = await this.runRaw(
      ["git", "rev-parse", "--git-common-dir"],
      worktree.path,
      "worktree",
      auditSink
    );
    if (commonDirResult.exitCode !== 0) {
      throw new Error(
        `无法解析 worktree 的 git-common-dir: exitCode=${commonDirResult.exitCode} stderr=${commonDirResult.stderr}`
      );
    }
    const commonDir = commonDirResult.stdout.trim();
    const sourceRepoPath = dirname(commonDir);

    // 3. ADR-002 受控清理策略：CommandPolicy 对 `git worktree remove`
    //    默认拒绝（删除性操作）。LocalGitAdapter 作为受控 Manager，
    //    在 PathPolicy 校验通过后直接调用 ProcessRunner.run，不经过
    //    CommandPolicy。CommandPolicy 的默认拒绝仍对未受控调用方有效。
    //    P1-02：源仓库命令使用 repositoryRoot 校验。
    //    P1-03：记录审计。
    const timeoutMs = this.opts.processPolicy.timeoutMs;

    const removeSpec: CommandSpec = {
      argv: ["git", "worktree", "remove", worktree.path],
      timeoutMs
    };
    const result = await this.runRaw(
      removeSpec.argv,
      sourceRepoPath,
      "repository",
      auditSink,
      removeSpec.timeoutMs
    );

    if (result.exitCode !== 0) {
      // 4. 普通 remove 失败（目录有未提交改动等），尝试 --force。
      const forceSpec: CommandSpec = {
        argv: ["git", "worktree", "remove", "--force", worktree.path],
        timeoutMs
      };
      const forceResult = await this.runRaw(
        forceSpec.argv,
        sourceRepoPath,
        "repository",
        auditSink,
        forceSpec.timeoutMs
      );
      if (forceResult.exitCode !== 0) {
        throw new Error(
          `git worktree remove --force 失败: exitCode=${forceResult.exitCode} stderr=${forceResult.stderr}`
        );
      }
    }
    // 不删除数据库登记记录（由 WorktreeManager 在事务内 tx.worktrees.delete）。
  }

  /**
   * 返回受控 worktree 根目录（取 allowedWorktreeRoots[0]）。
   * 若未配置则抛错。
   */
  private getWorktreeRoot(): string {
    if (this.opts.allowedWorktreeRoots.length === 0) {
      throw new Error("未配置 allowedWorktreeRoots");
    }
    return this.opts.allowedWorktreeRoots[0]!;
  }

  /**
   * 根据 rootKind 返回对应的允许根目录列表（P1-02）。
   */
  private getAllowedRoots(kind: RootKind): readonly string[] {
    return kind === "worktree"
      ? this.opts.allowedWorktreeRoots
      : this.opts.allowedRepositoryRoots;
  }

  /**
   * 经治理闸门执行一条 git 命令（只读命令）。
   *
   * 步骤（参考 LocalCommandAdapter.runGoverned）：
   * 1. PathPolicy 校验 cwd 位于对应根目录内（P1-02：worktreeRoot 或 repositoryRoot）；
   * 2. CommandPolicy 校验 argv 在白名单或自动允许范围内；
   * 3. 构造 CommandSpec 并交给 ProcessRunner 执行；
   * 4. P1-03：上报命令审计到 auditSink（若提供）；
   * 5. exitCode !== 0 抛结构化错误，PolicyDeniedError 原样上抛。
   */
  private async runGoverned(
    argv: readonly string[],
    cwd: string,
    rootKind: RootKind,
    auditSink?: GitCommandAuditSink
  ): Promise<CommandResult> {
    const allowedRoots = this.getAllowedRoots(rootKind);

    // 1. 路径校验
    const pathDecision = this.opts.pathPolicy.decide(cwd, allowedRoots);
    if (!pathDecision.allowed) {
      throw new PolicyDeniedError(
        `command ${argv[0]} at ${cwd}`,
        pathDecision.reason
      );
    }
    const resolvedCwd = pathDecision.resolvedPath ?? cwd;

    // 2. 命令校验
    const cmdDecision = this.opts.commandPolicy.decide(
      argv,
      this.opts.projectCommands
    );
    if (!cmdDecision.allowed) {
      throw new PolicyDeniedError(
        `argv ${JSON.stringify(argv)}`,
        cmdDecision.reason
      );
    }

    // 3. 构造 CommandSpec 并执行
    const spec: CommandSpec = {
      argv,
      timeoutMs: this.opts.processPolicy.timeoutMs
    };
    const result = await this.opts.processRunner.run(
      spec,
      resolvedCwd,
      this.opts.processPolicy
    );

    // 4. P1-03：上报命令审计
    this.reportAudit(result, auditSink);

    // 5. exitCode !== 0 抛结构化错误
    if (result.exitCode !== 0) {
      throw new Error(
        `git 命令失败: ${argv.join(" ")} exitCode=${result.exitCode} stderr=${result.stderr}`
      );
    }
    return result;
  }

  /**
   * 直接经 ProcessRunner 执行命令（不经 CommandPolicy），用于
   * removeRegisteredWorktree 中需要绕过 CommandPolicy 默认拒绝的
   * `git worktree remove`。仍经 PathPolicy 校验 cwd。
   * P1-03：上报命令审计。
   */
  private async runRaw(
    argv: readonly string[],
    cwd: string,
    rootKind: RootKind,
    auditSink?: GitCommandAuditSink,
    timeoutMs?: number
  ): Promise<CommandResult> {
    const allowedRoots = this.getAllowedRoots(rootKind);

    // 路径校验
    const pathDecision = this.opts.pathPolicy.decide(cwd, allowedRoots);
    if (!pathDecision.allowed) {
      throw new PolicyDeniedError(
        `command ${argv[0]} at ${cwd}`,
        pathDecision.reason
      );
    }
    const resolvedCwd = pathDecision.resolvedPath ?? cwd;

    const spec: CommandSpec = {
      argv,
      timeoutMs: timeoutMs ?? this.opts.processPolicy.timeoutMs
    };
    const result = await this.opts.processRunner.run(
      spec,
      resolvedCwd,
      this.opts.processPolicy
    );

    // P1-03：上报命令审计（无论 exitCode 如何）
    this.reportAudit(result, auditSink);

    return result;
  }

  /**
   * P1-03：将 CommandResult 转换为 GitCommandAudit 并上报到 sink。
   */
  private reportAudit(
    result: CommandResult,
    auditSink?: GitCommandAuditSink
  ): void {
    if (!auditSink) return;
    const truncation: OutputTruncation = {
      originalBytes: result.originalBytes,
      retainedBytes: result.retainedBytes,
      truncated: result.truncated
    };
    const audit: GitCommandAudit = {
      argv: result.argv,
      cwd: result.cwd,
      exitCode: result.exitCode,
      outputTruncation: truncation
    };
    auditSink.record(audit);
  }
}

/**
 * 默认受控 worktree 根目录解析（ADR-002）。
 *
 * Windows：%LOCALAPPDATA%/TracePilot/worktrees/
 * 非 Windows 兜底：~/.local/share/TracePilot/worktrees/
 *
 * 调用方应在 composition root 中调用本函数，确保目录存在，并把返回路径
 * 作为 `LocalGitAdapter.allowedWorktreeRoots` 与
 * `LocalCommandAdapter.allowedWorktreeRoots` 的唯一受控根目录。
 */
export function resolveDefaultWorktreePath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  const worktreeRoot =
    localAppData
      ? resolve(localAppData, "TracePilot", "worktrees")
      : resolve(
          process.env.HOME ?? process.env.USERPROFILE ?? ".",
          ".local",
          "share",
          "TracePilot",
          "worktrees"
        );
  // 确保目录存在（幂等）。
  mkdirSync(worktreeRoot, { recursive: true });
  return worktreeRoot;
}
