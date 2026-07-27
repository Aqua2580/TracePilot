/**
 * EvidenceCollector 端到端集成测试 —— Phase 3 P1-05。
 *
 * 见 docs/reviews/PHASE-3-ACCEPTANCE-REVIEW.md P1-05 修复要求：
 * - python 样例仓库经 EvidenceCollector 写入 SQLite Pack
 * - 每条证据可追溯来源（source / locator / contentHash 非空）
 * - 审计含 git argv / cwd / exitCode（P1-03）
 * - Router 请求 → Adapter 收集 → Pack 版本化 完整链路
 *
 * 使用真实 git 二进制（经 LocalGitAdapter / LocalProcessRunner 治理执行）
 * 与 SQLite 真源（createSqliteStore），不 mock 任何适配器。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSqliteStore,
  type SqliteStore
} from "../src/index.js";
import {
  TaskOrchestrator,
  EvidenceRouter,
  EvidenceCollector,
  type Project,
  type TaskInput
} from "@tracepilot/core";
import {
  LocalGitAdapter,
  LocalProcessRunner
} from "@tracepilot/adapters";
import { DefaultCommandPolicy, DefaultPathPolicy } from "@tracepilot/governance";

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-ec-"));
  return join(dir, "test.db");
}

function safeCleanup(dbPath: string): void {
  const dir = join(dbPath, "..");
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      const buf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buf, 0, 0, 200);
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略：Windows 文件锁残留不影响测试结论
  }
}

/**
 * 在临时目录中创建最小可用 Python git 仓库（含两次提交，便于历史证据）。
 */
function createPythonRepo(tmpRoot: string): { repoPath: string; worktreeRoot: string } {
  const repoPath = join(tmpRoot, "python-repo");
  const worktreeRoot = join(tmpRoot, "python-worktrees");

  mkdirSync(repoPath, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  runGit(["init", "-b", "main"], repoPath);
  runGit(["config", "user.email", "test@example.com"], repoPath);
  runGit(["config", "user.name", "Test User"], repoPath);
  runGit(["config", "core.autocrlf", "false"], repoPath);

  // 第一次提交：基础版本
  writeFileSync(join(repoPath, "pytest.ini"), "[pytest]\ntestpaths = tests\n");
  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(join(repoPath, "src", "sample.py"), "def add(a, b):\n    return a + b\n");
  mkdirSync(join(repoPath, "tests"), { recursive: true });
  writeFileSync(
    join(repoPath, "tests", "test_sample.py"),
    "from src.sample import add\n\ndef test_add():\n    assert add(1, 2) == 3\n"
  );
  runGit(["add", "."], repoPath);
  runGit(["commit", "-m", "初始提交：python 样例仓库"], repoPath);

  // 第二次提交：修改 sample.py，便于 git history 证据有多条
  writeFileSync(
    join(repoPath, "src", "sample.py"),
    "def add(a, b):\n    \"\"\"Return sum of a and b.\"\"\"\n    return a + b\n"
  );
  runGit(["add", "."], repoPath);
  runGit(["commit", "-m", "增加 docstring"], repoPath);

  return { repoPath, worktreeRoot };
}

function runGit(args: readonly string[], cwd: string): void {
  execFileSync("git", [...args], {
    cwd,
    stdio: "ignore",
    encoding: "utf8"
  });
}

function buildGitAdapter(repoPath: string, worktreeRoot: string): LocalGitAdapter {
  return new LocalGitAdapter({
    processRunner: new LocalProcessRunner(),
    commandPolicy: new DefaultCommandPolicy(),
    pathPolicy: new DefaultPathPolicy(),
    processPolicy: {
      timeoutMs: 10000,
      maxOutputBytes: 1024 * 1024,
      allowedCwdRoots: [repoPath, worktreeRoot],
      inheritEnv: false
    },
    // P1-02：生产等价配置——worktreeRoot 与 repositoryRoot 分离
    allowedWorktreeRoots: [worktreeRoot],
    allowedRepositoryRoots: [repoPath],
    projectCommands: {
      test: { argv: ["python", "-m", "pytest"], timeoutMs: 30000 }
    }
  });
}

function sampleProject(repoPath: string): Project {
  return {
    id: "proj-ec",
    name: "EvidenceCollector 测试项目",
    repositoryPath: repoPath,
    defaultBranch: "main",
    language: "python",
    commands: {
      test: { argv: ["python", "-m", "pytest"], timeoutMs: 30000 }
    },
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function sampleTaskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    objective: "修复失败的 pytest 用例 test_sample",
    constraints: ["不得修改 src/sample.py 的公开 API"],
    acceptanceCriteria: ["pytest tests/test_sample.py 通过"],
    riskLevel: "low",
    rawSource: "FAILED test_sample::test_add ...",
    origin: "failed_test_log",
    failure: {
      testNames: ["tests/test_sample.py::test_add"],
      errorTypes: ["AssertionError"],
      stackSummary: "assert add(1, 2) == 3"
    },
    ...overrides
  };
}

/** 从 testNames 提取去重的文件路径（与 EvidenceRouter 内部逻辑一致）。 */
function extractFilePaths(testNames: readonly string[]): string[] {
  const paths = testNames.map((name) => {
    const idx = name.indexOf("::");
    return idx >= 0 ? name.slice(0, idx) : name;
  });
  return [...new Set(paths)];
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe("EvidenceCollector 端到端集成 (P1-05)", () => {
  let dbPath: string;
  let store: SqliteStore;
  let tmpRoot: string;
  let repoPath: string;
  let worktreeRoot: string;
  let orchestrator: TaskOrchestrator;
  let collector: EvidenceCollector;

  beforeEach(async () => {
    dbPath = tempDbPath();
    store = createSqliteStore({ dbPath });

    tmpRoot = mkdtempSync(join(tmpdir(), "tracepilot-ec-repo-"));
    const sample = createPythonRepo(tmpRoot);
    repoPath = sample.repoPath;
    worktreeRoot = sample.worktreeRoot;

    await store.unitOfWork.run(async (tx) => {
      await tx.projects.save(sampleProject(repoPath));
    });

    orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const gitAdapter = buildGitAdapter(repoPath, worktreeRoot);
    collector = new EvidenceCollector({
      router: new EvidenceRouter(),
      gitAdapter,
      knowledgeAdapter: store.knowledgeAdapter,
      unitOfWork: store.unitOfWork
    });
  });

  afterEach(() => {
    store.close();
    safeCleanup(dbPath);
    for (let i = 0; i < 3; i++) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
        break;
      } catch {
        const buf = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(buf, 0, 0, 200);
      }
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // 忽略 Windows 文件锁
    }
  });

  // -------------------------------------------------------------------------
  // 测试 1：collectEvidence 返回的证据每条可追溯来源
  // -------------------------------------------------------------------------

  it("collectEvidence 返回的每条证据都带 source/locator/contentHash/capturedAt", async () => {
    const task = await orchestrator.createTask({
      projectId: "proj-ec",
      input: sampleTaskInput()
    });

    const result = await collector.collectEvidence({
      taskId: task.id,
      taskInput: task.input,
      projectId: "proj-ec",
      repositoryPath: repoPath,
      blameFilePaths: extractFilePaths(task.input.failure?.testNames ?? [])
    });

    // 至少有 git history 证据（两次提交 → 至少 2 条）
    expect(result.evidence.length).toBeGreaterThanOrEqual(2);

    // 每条证据必须可追溯
    for (const item of result.evidence) {
      // P1-05：可回溯字段非空
      expect(item.source.length).toBeGreaterThan(0);
      expect(item.locator.length).toBeGreaterThan(0);
      expect(item.contentHash.length).toBeGreaterThan(0);
      expect(item.capturedAt.length).toBeGreaterThan(0);
      expect(typeof item.id).toBe("string");
      expect(item.id.length).toBeGreaterThan(0);
      expect(typeof item.summary).toBe("string");
      expect(typeof item.relevance).toBe("number");
      expect(item.trustLevel).toBeDefined();

      // source 必须是已知的 Adapter 来源
      expect([
        "git-history",
        "git-blame",
        "sqlite-memory"
      ]).toContain(item.source);
    }

    // 必须包含 git-history 证据
    const gitHistory = result.evidence.filter((e) => e.source === "git-history");
    expect(gitHistory.length).toBeGreaterThanOrEqual(2);
    for (const item of gitHistory) {
      expect(item.locator).toMatch(/^commit:/);
      expect(item.kind).toBe("git");
      expect(item.trustLevel).toBe("PRIMARY");
    }

    // 必须包含 git-blame 证据（blameFilePaths 提供了 tests/test_sample.py）
    const gitBlame = result.evidence.filter((e) => e.source === "git-blame");
    expect(gitBlame.length).toBeGreaterThan(0);
    for (const item of gitBlame) {
      expect(item.locator).toMatch(/^blame:/);
      expect(item.kind).toBe("git");
      expect(item.trustLevel).toBe("PRIMARY");
    }
  });

  // -------------------------------------------------------------------------
  // 测试 2：collectEvidence 把 git 命令审计写入 SQLite audit_events
  // -------------------------------------------------------------------------

  it("collectEvidence 把 git 命令审计写入 audit_events（argv/cwd/exitCode）", async () => {
    const task = await orchestrator.createTask({
      projectId: "proj-ec",
      input: sampleTaskInput()
    });

    const result = await collector.collectEvidence({
      taskId: task.id,
      taskInput: task.input,
      projectId: "proj-ec",
      repositoryPath: repoPath,
      blameFilePaths: ["src/sample.py", "tests/test_sample.py"]
    });

    // 至少触发了 git log + 2 次 git blame = 3 条命令
    expect(result.gitCommandCount).toBeGreaterThanOrEqual(3);

    const audits = await store.unitOfWork.run((tx) => tx.audit.findByTask(task.id));
    const commandAudits = audits.filter((a) => a.type === "command_executed");
    expect(commandAudits.length).toBe(result.gitCommandCount);

    // 每条 command_executed 必须包含结构化字段
    for (const audit of commandAudits) {
      expect(audit.executedArgv).toBeDefined();
      expect(audit.executedArgv![0]).toBe("git");
      expect(audit.executedCwd).toBeDefined();
      expect(audit.executedCwd).toBe(repoPath);
      expect(typeof audit.exitCode).toBe("number");
      expect(audit.outputTruncation).toBeDefined();
    }

    // 至少有一条 git log 命令
    const logCmd = commandAudits.find((a) => a.executedArgv!.includes("log"));
    expect(logCmd).toBeDefined();

    // 至少有两条 git blame 命令（src/sample.py + tests/test_sample.py）
    const blameCmds = commandAudits.filter((a) =>
      a.executedArgv!.includes("blame")
    );
    expect(blameCmds.length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // 测试 3：完整链路——收集证据 → gatherEvidenceAndCreatePack → SQLite Pack
  // -------------------------------------------------------------------------

  it("collectEvidence + gatherEvidenceAndCreatePack 把真实 git 证据写入 SQLite Pack", async () => {
    const task = await orchestrator.createTask({
      projectId: "proj-ec",
      input: sampleTaskInput()
    });

    // 迁移到 GATHERING_EVIDENCE
    await orchestrator.transitionTask(task.id, "INTAKING");
    await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE");

    // 收集证据
    const result = await collector.collectEvidence({
      taskId: task.id,
      taskInput: task.input,
      projectId: "proj-ec",
      repositoryPath: repoPath,
      blameFilePaths: extractFilePaths(task.input.failure?.testNames ?? [])
    });

    // 生成 Pack v1
    const pack = await orchestrator.gatherEvidenceAndCreatePack({
      taskId: task.id,
      packId: `pack-${task.id}`,
      evidence: result.evidence,
      acceptanceCriteria: task.input.acceptanceCriteria
    });

    expect(pack.version).toBe(1);
    expect(pack.evidence.length).toBe(result.evidence.length);
    expect(pack.taskId).toBe(task.id);

    // 从 SQLite 重新读取 Pack，验证证据可追溯
    const reloaded = await store.unitOfWork.run((tx) =>
      tx.evidencePacks.findLatestVersion(pack.id)
    );
    expect(reloaded).toBeDefined();
    expect(reloaded!.evidence.length).toBe(result.evidence.length);

    // 每条证据的 source / locator / contentHash 与收集时一致
    for (const item of reloaded!.evidence) {
      const original = result.evidence.find((e) => e.id === item.id);
      expect(original).toBeDefined();
      expect(item.source).toBe(original!.source);
      expect(item.locator).toBe(original!.locator);
      expect(item.contentHash).toBe(original!.contentHash);
    }

    // 任务关联的 Pack 版本已更新
    const storedTask = await store.unitOfWork.run((tx) => tx.tasks.findById(task.id));
    expect(storedTask?.currentEvidencePackId).toBe(pack.id);
    expect(storedTask?.currentEvidencePackVersion).toBe(1);

    // 审计时间线包含 evidence_pack_versioned 事件
    const audits = await store.unitOfWork.run((tx) => tx.audit.findByTask(task.id));
    const packAudit = audits.find((a) => a.type === "evidence_pack_versioned");
    expect(packAudit).toBeDefined();
    expect(packAudit?.evidencePackId).toBe(pack.id);
    expect(packAudit?.evidencePackVersion).toBe(1);
    expect(packAudit?.evidencePackHash).toBe(pack.contentHash);

    // 审计时间线同时包含 command_executed 事件（来自 EvidenceCollector）
    const commandAudits = audits.filter((a) => a.type === "command_executed");
    expect(commandAudits.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 测试 4：Router 请求规格与实际收集的证据来源一致
  // -------------------------------------------------------------------------

  it("Router 请求规格与实际收集的证据来源一致（git-history / sqlite-memory）", async () => {
    const taskInput = sampleTaskInput();
    const router = new EvidenceRouter();
    const specs = router.route(taskInput);

    // Router 应输出 5 类请求（failed_test_log + testNames）
    expect(specs.length).toBe(5);
    const specSources = specs.map((s) => s.source);
    expect(specSources).toContain("git-history");
    expect(specSources).toContain("sqlite-memory");

    // 收集证据
    const task = await orchestrator.createTask({
      projectId: "proj-ec",
      input: taskInput
    });
    const result = await collector.collectEvidence({
      taskId: task.id,
      taskInput,
      projectId: "proj-ec",
      repositoryPath: repoPath
    });

    // 实际收集到的证据 source 必须在 Router 请求的 source 范围内
    // （code/runtime/policy 在 Phase 3 不实现，所以只有 git-history 与 sqlite-memory）
    for (const item of result.evidence) {
      // git-blame 是额外补充的，不在 Router 的 source 中但仍是合法 git 证据
      if (item.source === "git-blame") continue;
      expect(specSources).toContain(item.source);
    }
  });

  // -------------------------------------------------------------------------
  // 测试 5：KnowledgeAdapter 集成——预填 RepairRecord 后被召回为 memory 证据
  // -------------------------------------------------------------------------

  it("KnowledgeAdapter 召回 APPROVED RepairRecord 转换为 memory 证据", async () => {
    // 先创建一个真实任务作为 RepairRecord 的外键宿主
    const seedTask = await orchestrator.createTask({
      projectId: "proj-ec",
      input: sampleTaskInput({ objective: "历史任务（用于 Repair Memory 预填）" }),
      taskId: "seed-task-ec"
    });

    // 预填一条 APPROVED RepairRecord
    await store.unitOfWork.run(async (tx) => {
      await tx.repairRecords.save({
        id: "rec-001",
        projectId: "proj-ec",
        taskId: seedTask.id,
        status: "APPROVED",
        symptom: "assert add(1, 2) == 3",
        rootCause: "add 函数返回了错误的值",
        fixSummary: "修正 add 函数实现",
        applicabilityConditions: ["pytest 失败"],
        failureReasons: [],
        inputEvidencePackId: "seed-pack",
        inputEvidencePackVersion: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });
    });

    const task = await orchestrator.createTask({
      projectId: "proj-ec",
      input: sampleTaskInput()
    });

    const result = await collector.collectEvidence({
      taskId: task.id,
      taskInput: task.input,
      projectId: "proj-ec",
      repositoryPath: repoPath
    });

    // 必须包含 sqlite-memory 证据
    const memoryEvidence = result.evidence.filter((e) => e.source === "sqlite-memory");
    expect(memoryEvidence.length).toBeGreaterThan(0);

    const memItem = memoryEvidence[0]!;
    expect(memItem.kind).toBe("memory");
    expect(memItem.locator).toBe("record:rec-001");
    expect(memItem.trustLevel).toBe("VERIFIED_MEMORY");
    expect(memItem.summary).toContain("add 函数返回了错误的值");
    expect(memItem.contentHash.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 测试 6：未提供 blameFilePaths 时不调用 getBlame
  // -------------------------------------------------------------------------

  it("未提供 blameFilePaths 时只收集 git-history 证据，不调用 getBlame", async () => {
    const task = await orchestrator.createTask({
      projectId: "proj-ec",
      input: sampleTaskInput()
    });

    const result = await collector.collectEvidence({
      taskId: task.id,
      taskInput: task.input,
      projectId: "proj-ec",
      repositoryPath: repoPath
      // 不提供 blameFilePaths
    });

    // 只有 git-history 证据，没有 git-blame
    const hasBlame = result.evidence.some((e) => e.source === "git-blame");
    expect(hasBlame).toBe(false);

    // git-history 证据存在
    const hasHistory = result.evidence.some((e) => e.source === "git-history");
    expect(hasHistory).toBe(true);

    // 命令审计只有 git log，没有 git blame
    const audits = await store.unitOfWork.run((tx) => tx.audit.findByTask(task.id));
    const commandAudits = audits.filter((a) => a.type === "command_executed");
    const hasBlameCmd = commandAudits.some((a) => a.executedArgv!.includes("blame"));
    expect(hasBlameCmd).toBe(false);
  });
});
