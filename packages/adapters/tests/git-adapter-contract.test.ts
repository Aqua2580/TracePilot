/**
 * GitAdapter 契约测试 —— Phase 3 任务 6。
 *
 * 定义统一的契约断言，对 FakeGitAdapter 与 LocalGitAdapter 实例化
 * 同一套测试。任何 GitAdapter 实现必须通过此契约（§6）。
 *
 * 契约覆盖：
 * - validateRepository / createWorktree / getDiff / getHistory / getBlame 返回结构
 * - removeRegisteredWorktree 对未登记 worktree 抛错
 * - createWorktree 拒绝路径穿越（taskId 含 ".."）
 *
 * 对于 FakeGitAdapter，用 setHistory / setBlame 预设非空数据；
 * 对于 LocalGitAdapter，用真实 git 仓库产生非空 history / blame。
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { FakeGitAdapter, LocalGitAdapter, LocalProcessRunner } from "../src/index.js";
import { DefaultCommandPolicy, DefaultPathPolicy } from "@tracepilot/governance";
import type {
  GitAdapter,
  GitEvidence,
  BlameEvidence,
  ProcessPolicy,
  ProjectCommands,
  Worktree
} from "@tracepilot/core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createPythonSampleRepo,
  cleanupSampleRepo
} from "./fixtures/sample-repos.js";

/**
 * 契约上下文 —— 工厂创建 adapter 时一并返回契约断言所需的路径与配置。
 *
 * 之所以扩展为携带上下文（而非仅返回 adapter），是因为 validateRepository /
 * getHistory / getBlame 需要一个有效的 repositoryPath，而 Fake 与 Local 的
 * 路径来源不同（Fake 用占位字符串，Local 用真实临时仓库路径）。
 */
interface GitAdapterContractContext {
  readonly adapter: GitAdapter;
  /** 用于 validateRepository / getHistory / getBlame 的仓库路径。 */
  readonly repositoryPath: string;
  /** 用于 getBlame 的相对文件路径。 */
  readonly blameFilePath: string;
  /** createWorktree 的 defaultBranch 参数。 */
  readonly defaultBranch: string;
  /** createWorktree 的 allowedPaths 参数。 */
  readonly allowedPaths: readonly string[];
  /** 受控 worktree 根目录（可选）；用于断言 createWorktree 的 path 落在其内。 */
  readonly worktreeRoot?: string;
  /** 位于受控根目录外 / 未登记的路径，用于 removeRegisteredWorktree 拒绝测试。 */
  readonly outsideWorktreePath: string;
  /** 清理回调（可选）。 */
  cleanup?(): Promise<void>;
}

/**
 * 运行统一的 GitAdapter 契约断言。
 *
 * @param name describe 块名称
 * @param factory 创建 GitAdapter 及其上下文的工厂函数
 */
function runGitAdapterContract(
  name: string,
  factory: () => Promise<GitAdapterContractContext>
): void {
  describe(name, () => {
    let ctx: GitAdapterContractContext;

    beforeAll(async () => {
      ctx = await factory();
    });

    afterAll(async () => {
      if (ctx.cleanup) await ctx.cleanup();
    });

    it("validateRepository 返回结构完整且类型正确", async () => {
      const info = await ctx.adapter.validateRepository(ctx.repositoryPath);
      expect(info).toBeDefined();
      expect(typeof info.repositoryPath).toBe("string");
      expect(info.repositoryPath.length).toBeGreaterThan(0);
      expect(typeof info.defaultBranch).toBe("string");
      expect(info.defaultBranch.length).toBeGreaterThan(0);
      expect(typeof info.headCommitSha).toBe("string");
      expect(info.headCommitSha.length).toBeGreaterThan(0);
      expect(typeof info.isClean).toBe("boolean");
    });

    it("createWorktree 返回结构完整且 branch 以 tp/ 开头", async () => {
      const wt = await ctx.adapter.createWorktree({
        projectId: "proj-contract",
        repositoryPath: ctx.repositoryPath,
        defaultBranch: ctx.defaultBranch,
        taskId: "contract-create-wt",
        allowedPaths: ctx.allowedPaths
      });
      expect(typeof wt.id).toBe("string");
      expect(wt.id.length).toBeGreaterThan(0);
      expect(wt.projectId).toBe("proj-contract");
      expect(wt.taskId).toBe("contract-create-wt");
      expect(typeof wt.path).toBe("string");
      expect(wt.path.length).toBeGreaterThan(0);
      expect(wt.branch).toMatch(/^tp\//);
      expect(typeof wt.baseCommitSha).toBe("string");
      expect(wt.baseCommitSha.length).toBeGreaterThan(0);
      expect(wt.allowedPaths).toEqual(ctx.allowedPaths);
      expect(typeof wt.createdAt).toBe("string");
      if (ctx.worktreeRoot) {
        // worktree 路径必须位于受控根目录内
        expect(wt.path.startsWith(ctx.worktreeRoot)).toBe(true);
      }
    });

    it("getDiff 返回结构完整（hash 是字符串、bytes 是数字）", async () => {
      const wt = await ctx.adapter.createWorktree({
        projectId: "proj-contract",
        repositoryPath: ctx.repositoryPath,
        defaultBranch: ctx.defaultBranch,
        taskId: "contract-diff",
        allowedPaths: ctx.allowedPaths
      });
      const diff = await ctx.adapter.getDiff(wt.path);
      expect(diff.worktreePath).toBe(wt.path);
      expect(typeof diff.patch).toBe("string");
      expect(typeof diff.hash).toBe("string");
      expect(diff.hash.length).toBeGreaterThan(0);
      expect(Array.isArray(diff.changedFiles)).toBe(true);
      expect(typeof diff.bytes).toBe("number");
    });

    it("getHistory 返回数组且每条含 commitSha / author / authoredAt / message / files", async () => {
      const history = await ctx.adapter.getHistory({
        repositoryPath: ctx.repositoryPath,
        maxCount: 5
      });
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThan(0);
      for (const entry of history) {
        expect(typeof entry.commitSha).toBe("string");
        expect(entry.commitSha.length).toBeGreaterThan(0);
        expect(typeof entry.author).toBe("string");
        expect(typeof entry.authoredAt).toBe("string");
        expect(typeof entry.message).toBe("string");
        expect(Array.isArray(entry.files)).toBe(true);
      }
    });

    it("getBlame 返回数组且每条含 lineRange（长度 2）与 lineContent", async () => {
      const blame = await ctx.adapter.getBlame({
        repositoryPath: ctx.repositoryPath,
        path: ctx.blameFilePath
      });
      expect(Array.isArray(blame)).toBe(true);
      expect(blame.length).toBeGreaterThan(0);
      for (const entry of blame) {
        expect(typeof entry.commitSha).toBe("string");
        expect(typeof entry.author).toBe("string");
        expect(typeof entry.authoredAt).toBe("string");
        expect(Array.isArray(entry.lineRange)).toBe(true);
        expect(entry.lineRange).toHaveLength(2);
        expect(typeof entry.lineContent).toBe("string");
      }
    });

    it("removeRegisteredWorktree 对未登记 worktree 抛错", async () => {
      // 构造一个未登记的 Worktree（path 指向受控根目录外或不存在）
      const unregistered: Worktree = {
        id: "wt-unregistered",
        projectId: "proj-contract",
        taskId: "unregistered",
        path: ctx.outsideWorktreePath,
        branch: "tp/unregistered",
        baseCommitSha: "0000000000000000000000000000000000000000",
        allowedPaths: [],
        createdAt: new Date().toISOString()
      };
      await expect(
        ctx.adapter.removeRegisteredWorktree(unregistered)
      ).rejects.toThrow();
    });

    it("createWorktree 拒绝路径穿越（taskId 含 ..）且不创建任何目录", async () => {
      await expect(
        ctx.adapter.createWorktree({
          projectId: "proj-contract",
          repositoryPath: ctx.repositoryPath,
          defaultBranch: ctx.defaultBranch,
          taskId: "../../etc",
          allowedPaths: ctx.allowedPaths
        })
      ).rejects.toThrow();
    });
  });
}

// ---------------------------------------------------------------------------
// 预设的 Fake 数据 —— 让契约断言有非空 history / blame 可校验
// ---------------------------------------------------------------------------

function fakeHistory(): GitEvidence[] {
  return [
    {
      commitSha: "fake-sha-0001",
      author: "Fake Author",
      authoredAt: "2026-01-01T00:00:00.000Z",
      message: "初始提交：fake 仓库",
      files: ["src/sample.py"]
    }
  ];
}

function fakeBlame(): BlameEvidence[] {
  return [
    {
      commitSha: "fake-sha-0001",
      author: "Fake Author",
      authoredAt: "2026-01-01T00:00:00.000Z",
      lineRange: [1, 2],
      lineContent: "def add(a, b):"
    }
  ];
}

// ---------------------------------------------------------------------------
// 构造 LocalGitAdapter 的共享辅助
// ---------------------------------------------------------------------------

function buildLocalAdapter(repoPath: string, worktreeRoot: string): LocalGitAdapter {
  const processPolicy: ProcessPolicy = {
    timeoutMs: 10000,
    maxOutputBytes: 1024 * 1024,
    allowedCwdRoots: [repoPath, worktreeRoot],
    inheritEnv: false
  };
  // git 命令走自动允许，不依赖白名单；此处仅提供一个最小 test 命令满足接口
  const projectCommands: ProjectCommands = {
    test: { argv: ["python", "-m", "pytest"], timeoutMs: 30000 }
  };
  // P1-02：生产等价配置——allowedWorktreeRoots 只含 worktreeRoot，
  // allowedRepositoryRoots 只含 repoPath。两个安全域不得混在一起。
  return new LocalGitAdapter({
    processRunner: new LocalProcessRunner(),
    commandPolicy: new DefaultCommandPolicy(),
    pathPolicy: new DefaultPathPolicy(),
    processPolicy,
    allowedWorktreeRoots: [worktreeRoot],
    allowedRepositoryRoots: [repoPath],
    projectCommands
  });
}

// ===========================================================================
// 契约实例化：FakeGitAdapter
// ===========================================================================

describe("GitAdapter 契约", () => {
  runGitAdapterContract("FakeGitAdapter 契约", async () => {
    const fake = new FakeGitAdapter();
    fake.setRepositoryInfo({
      repositoryPath: "/fake/repo",
      defaultBranch: "main",
      headCommitSha: "fake-sha-0001",
      isClean: true
    });
    fake.setHistory(fakeHistory());
    fake.setBlame("src/sample.py", fakeBlame());
    return {
      adapter: fake,
      repositoryPath: "/fake/repo",
      blameFilePath: "src/sample.py",
      defaultBranch: "main",
      allowedPaths: ["src/", "tests/"],
      outsideWorktreePath: "/outside/worktree"
    };
  });

  runGitAdapterContract("LocalGitAdapter 契约", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tracepilot-contract-"));
    const { repoPath, worktreeRoot } = await createPythonSampleRepo(tmpRoot);
    const adapter = buildLocalAdapter(repoPath, worktreeRoot);
    return {
      adapter,
      repositoryPath: repoPath,
      blameFilePath: "src/sample.py",
      defaultBranch: "main",
      allowedPaths: ["src/", "tests/"],
      worktreeRoot,
      // tmpRoot 是 worktreeRoot 与 repoPath 的父目录，位于受控根目录外
      outsideWorktreePath: tmpRoot,
      cleanup: async () => cleanupSampleRepo(tmpRoot)
    };
  });
});
