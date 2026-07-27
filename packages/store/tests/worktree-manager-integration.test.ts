/**
 * WorktreeManager 端到端集成测试 —— Phase 3 P1-01 / P1-03。
 *
 * 见 docs/reviews/PHASE-3-ACCEPTANCE-REVIEW.md P1-01 修复要求：
 * - python 样例仓库经 WorktreeManager 全流程
 * - 断言登记（task.worktreeId + worktrees 表 + worktree_created 审计）
 * - 断言 git 命令审计写入 SQLite audit_events（command_executed）
 * - 拒绝伪造 worktree（不在数据库登记中）
 * - 拒绝非终态任务回收 worktree
 *
 * 使用真实 git 二进制（经 LocalGitAdapter / LocalProcessRunner 治理执行）
 * 与 SQLite 真源（createSqliteStore），不 mock 任何适配器。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSqliteStore,
  type SqliteStore
} from "../src/index.js";
import {
  TaskOrchestrator,
  WorktreeManager,
  WorktreeNotRegisteredException,
  WorktreeTaskNotTerminalException,
  type Project,
  type TaskInput,
  type PlanNode
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
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-wtm-"));
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
 * 在临时目录中创建最小可用 Python git 仓库。
 *
 * 与 adapters/tests/fixtures/sample-repos.ts 等价，但内联在此处
 * 避免 adapters 包公开导出测试夹具。夹具本身不经 ProcessRunner
 * 治理约束（它是测试基础设施），直接用 node:child_process 执行 git。
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
    id: "proj-wtm",
    name: "WorktreeManager 测试项目",
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

/**
 * P1-R03：合法时序辅助函数 —— 把任务从 CREATED 迁移到 AWAITING_EXECUTION_APPROVAL，
 * 记录 Plan（含 allowedPaths）并取得执行审批，使后续 createAndAttachWorktree
 * 可通过审批校验。
 *
 * 合法时序：
 * 1. CREATED → INTAKING → GATHERING_EVIDENCE
 * 2. gatherEvidenceAndCreatePack 生成 Pack v1（空 evidence，仅满足 Plan 引用）
 * 3. GATHERING_EVIDENCE → PLANNED
 * 4. planTask 记录 Plan（引用 Pack v1，含 allowedPaths）
 * 5. PLANNED → AWAITING_EXECUTION_APPROVAL
 * 6. recordApproval 记录 execution approval（scopeHash 由 computeCurrentScopeHash 计算）
 */
async function prepareAuthorizedForWorktree(
  orchestrator: TaskOrchestrator,
  taskId: string,
  allowedPaths: readonly string[] = ["src/", "tests/"]
): Promise<void> {
  // 1. CREATED → INTAKING → GATHERING_EVIDENCE
  await orchestrator.transitionTask(taskId, "INTAKING");
  await orchestrator.transitionTask(taskId, "GATHERING_EVIDENCE");

  // 2. 生成 Pack v1（空 evidence，仅满足 Plan 引用）
  const packId = `pack-${taskId}`;
  await orchestrator.gatherEvidenceAndCreatePack({
    taskId,
    packId,
    evidence: [],
    acceptanceCriteria: []
  });

  // 3. GATHERING_EVIDENCE → PLANNED
  await orchestrator.transitionTask(taskId, "PLANNED");

  // 4. 记录 Plan
  const nodes: PlanNode[] = [
    {
      id: "node-1",
      label: "修改 sample.py",
      description: "调整 add 函数实现",
      evidencePackId: packId,
      evidencePackVersion: 1
    }
  ];
  await orchestrator.planTask({
    taskId,
    nodes,
    allowedPaths,
    inputEvidencePackId: packId,
    inputEvidencePackVersion: 1
  });

  // 5. PLANNED → AWAITING_EXECUTION_APPROVAL
  await orchestrator.transitionTask(taskId, "AWAITING_EXECUTION_APPROVAL");

  // 6. 记录 execution approval
  const scopeHash = await orchestrator.computeCurrentScopeHash(taskId);
  await orchestrator.recordApproval({
    taskId,
    kind: "execution",
    approver: "test-approver",
    decision: "approved",
    scopeHash,
    reason: "测试用执行审批"
  });
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe("WorktreeManager 端到端集成 (P1-01 / P1-03)", () => {
  let dbPath: string;
  let store: SqliteStore;
  let tmpRoot: string;
  let repoPath: string;
  let worktreeRoot: string;
  let orchestrator: TaskOrchestrator;
  let manager: WorktreeManager;

  beforeEach(async () => {
    dbPath = tempDbPath();
    store = createSqliteStore({ dbPath });

    tmpRoot = mkdtempSync(join(tmpdir(), "tracepilot-wtm-repo-"));
    const sample = createPythonRepo(tmpRoot);
    repoPath = sample.repoPath;
    worktreeRoot = sample.worktreeRoot;

    // 注入项目（满足外键约束）
    await store.unitOfWork.run(async (tx) => {
      await tx.projects.save(sampleProject(repoPath));
    });

    orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const gitAdapter = buildGitAdapter(repoPath, worktreeRoot);
    manager = new WorktreeManager({
      gitAdapter,
      orchestrator,
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
  // 测试 1：全流程——创建 worktree → 登记 → 审计 → 终态后回收
  // -------------------------------------------------------------------------

  it("createAndAttachWorktree 登记 worktree 并写 worktree_created + command_executed 审计", async () => {
    const task = await orchestrator.createTask({
      projectId: "proj-wtm",
      input: sampleTaskInput()
    });

    // P1-R03：合法时序 —— 迁移到 AWAITING_EXECUTION_APPROVAL 并取得执行审批
    await prepareAuthorizedForWorktree(orchestrator, task.id);

    // 创建并登记 worktree
    const worktree = await manager.createAndAttachWorktree({
      taskId: task.id,
      input: {
        projectId: "proj-wtm",
        repositoryPath: repoPath,
        defaultBranch: "main",
        taskId: task.id,
        allowedPaths: ["src/", "tests/"]
      }
    });

    // 断言 1：task.worktreeId 已更新
    const storedTask = await store.unitOfWork.run((tx) => tx.tasks.findById(task.id));
    expect(storedTask?.worktreeId).toBe(worktree.id);

    // 断言 2：worktree 在 worktrees 表中已登记
    const registered = await store.unitOfWork.run((tx) =>
      tx.worktrees.findById(worktree.id)
    );
    expect(registered).toBeDefined();
    expect(registered?.taskId).toBe(task.id);
    expect(registered?.path).toBe(worktree.path);
    expect(registered?.branch).toBe(`tp/${task.id}`);

    // 断言 3：worktree_created 审计事件已写入
    const audits = await store.unitOfWork.run((tx) => tx.audit.findByTask(task.id));
    const createdAudit = audits.find((a) => a.type === "worktree_created");
    expect(createdAudit).toBeDefined();
    expect(createdAudit?.reason).toContain(worktree.id);

    // 断言 4：command_executed 审计事件已写入（git rev-parse / status / worktree add）
    const commandAudits = audits.filter((a) => a.type === "command_executed");
    expect(commandAudits.length).toBeGreaterThan(0);
    // 每条 command_executed 必须包含 argv / cwd / exitCode
    for (const audit of commandAudits) {
      expect(audit.executedArgv).toBeDefined();
      expect(audit.executedArgv!.length).toBeGreaterThan(0);
      expect(audit.executedCwd).toBeDefined();
      expect(typeof audit.exitCode).toBe("number");
      // argv 必须是 git 命令
      expect(audit.executedArgv![0]).toBe("git");
    }

    // 断言 5：至少有一条 git worktree add 命令
    const worktreeAddAudit = commandAudits.find((a) =>
      a.executedArgv!.includes("worktree") && a.executedArgv!.includes("add")
    );
    expect(worktreeAddAudit).toBeDefined();

    // 断言 6：worktree 目录确实存在
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("removeWorktreeIfTerminal 在终态后回收 worktree 并写 worktree_removed 审计", async () => {
    const task = await orchestrator.createTask({
      projectId: "proj-wtm",
      input: sampleTaskInput()
    });

    // P1-R03：合法时序 —— 迁移到 AWAITING_EXECUTION_APPROVAL 并取得执行审批
    await prepareAuthorizedForWorktree(orchestrator, task.id);

    const worktree = await manager.createAndAttachWorktree({
      taskId: task.id,
      input: {
        projectId: "proj-wtm",
        repositoryPath: repoPath,
        defaultBranch: "main",
        taskId: task.id,
        allowedPaths: ["src/", "tests/"]
      }
    });

    // 任务迁移到终态（CANCELLED）
    await orchestrator.cancel(task.id, "测试回收");

    // 回收 worktree
    await manager.removeWorktreeIfTerminal({
      taskId: task.id,
      worktreeId: worktree.id,
      reason: "任务取消，回收 worktree"
    });

    // 断言 1：worktree 目录已被删除
    expect(existsSync(worktree.path)).toBe(false);

    // 断言 2：worktree 登记记录已删除
    const registered = await store.unitOfWork.run((tx) =>
      tx.worktrees.findById(worktree.id)
    );
    expect(registered).toBeUndefined();

    // 断言 3：task.worktreeId 已解除
    const storedTask = await store.unitOfWork.run((tx) => tx.tasks.findById(task.id));
    expect(storedTask?.worktreeId).toBeUndefined();

    // 断言 4：worktree_removed 审计事件已写入
    const audits = await store.unitOfWork.run((tx) => tx.audit.findByTask(task.id));
    const removedAudit = audits.find((a) => a.type === "worktree_removed");
    expect(removedAudit).toBeDefined();
    expect(removedAudit?.reason).toContain(worktree.id);
    expect(removedAudit?.reason).toContain("任务取消");

    // 断言 5：command_executed 审计中包含 git worktree remove 命令
    const commandAudits = audits.filter((a) => a.type === "command_executed");
    const removeCmd = commandAudits.find((a) =>
      a.executedArgv!.includes("worktree") && a.executedArgv!.includes("remove")
    );
    expect(removeCmd).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 测试 2：负向——拒绝伪造 worktree（未在数据库登记）
  // -------------------------------------------------------------------------

  it("removeWorktreeIfTerminal 拒绝伪造 worktree（未在数据库登记）", async () => {
    const task = await orchestrator.createTask({
      projectId: "proj-wtm",
      input: sampleTaskInput()
    });

    // 创建真实 worktree 但绕过 WorktreeManager（不经 attachWorktree）
    // 模拟"调用方传入伪造对象 → Manager 必须从 DB 加载并拒绝"
    const gitAdapter = buildGitAdapter(repoPath, worktreeRoot);
    const realWorktree = await gitAdapter.createWorktree({
      projectId: "proj-wtm",
      repositoryPath: repoPath,
      defaultBranch: "main",
      taskId: task.id,
      allowedPaths: ["src/"]
    });

    // 任务迁移到终态
    await orchestrator.cancel(task.id, "测试拒绝伪造");

    // 尝试回收未登记的 worktree —— 必须被拒绝
    await expect(
      manager.removeWorktreeIfTerminal({
        taskId: task.id,
        worktreeId: realWorktree.id,
        reason: "尝试回收未登记的 worktree"
      })
    ).rejects.toBeInstanceOf(WorktreeNotRegisteredException);

    // 断言：worktree 目录仍存在（未被回收）
    expect(existsSync(realWorktree.path)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 测试 3：负向——拒绝非终态任务回收 worktree
  // -------------------------------------------------------------------------

  it("removeWorktreeIfTerminal 拒绝非终态任务回收 worktree", async () => {
    const task = await orchestrator.createTask({
      projectId: "proj-wtm",
      input: sampleTaskInput()
    });

    // P1-R03：合法时序 —— 迁移到 AWAITING_EXECUTION_APPROVAL 并取得执行审批
    await prepareAuthorizedForWorktree(orchestrator, task.id);

    const worktree = await manager.createAndAttachWorktree({
      taskId: task.id,
      input: {
        projectId: "proj-wtm",
        repositoryPath: repoPath,
        defaultBranch: "main",
        taskId: task.id,
        allowedPaths: ["src/", "tests/"]
      }
    });

    // P1-R03：合法创建后任务处于 AWAITING_EXECUTION_APPROVAL（非终态）
    // 尝试回收 —— 必须被拒绝
    await expect(
      manager.removeWorktreeIfTerminal({
        taskId: task.id,
        worktreeId: worktree.id,
        reason: "尝试非终态回收"
      })
    ).rejects.toBeInstanceOf(WorktreeTaskNotTerminalException);

    // 断言：worktree 目录仍存在
    expect(existsSync(worktree.path)).toBe(true);

    // 断言：worktree 登记记录仍存在
    const registered = await store.unitOfWork.run((tx) =>
      tx.worktrees.findById(worktree.id)
    );
    expect(registered).toBeDefined();

    // 断言：task.worktreeId 仍指向 worktree
    const storedTask = await store.unitOfWork.run((tx) => tx.tasks.findById(task.id));
    expect(storedTask?.worktreeId).toBe(worktree.id);
  });

  // -------------------------------------------------------------------------
  // 测试 4：拒绝从其他任务回收 worktree（跨任务隔离）
  // -------------------------------------------------------------------------

  it("removeWorktreeIfTerminal 拒绝从其他任务回收 worktree", async () => {
    const taskA = await orchestrator.createTask({
      projectId: "proj-wtm",
      input: sampleTaskInput({ objective: "任务 A" }),
      taskId: "task-a"
    });
    const taskB = await orchestrator.createTask({
      projectId: "proj-wtm",
      input: sampleTaskInput({ objective: "任务 B" }),
      taskId: "task-b"
    });

    // P1-R03：为任务 A 走合法时序
    await prepareAuthorizedForWorktree(orchestrator, taskA.id, ["src/"]);

    // 为任务 A 创建 worktree
    const worktreeA = await manager.createAndAttachWorktree({
      taskId: taskA.id,
      input: {
        projectId: "proj-wtm",
        repositoryPath: repoPath,
        defaultBranch: "main",
        taskId: taskA.id,
        allowedPaths: ["src/"]
      }
    });

    // 任务 B 也迁移到终态
    await orchestrator.cancel(taskB.id, "任务 B 取消");

    // 尝试用任务 B 回收任务 A 的 worktree —— 必须被拒绝
    await expect(
      manager.removeWorktreeIfTerminal({
        taskId: taskB.id,
        worktreeId: worktreeA.id,
        reason: "跨任务回收"
      })
    ).rejects.toThrow(/属于任务/);

    // 断言：worktree 目录仍存在
    expect(existsSync(worktreeA.path)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 测试 5：审计链完整性——所有 git 命令都有结构化字段
  // -------------------------------------------------------------------------

  it("command_executed 审计事件包含完整结构化字段（argv/cwd/exitCode/outputTruncation）", async () => {
    const task = await orchestrator.createTask({
      projectId: "proj-wtm",
      input: sampleTaskInput()
    });

    // P1-R03：合法时序
    await prepareAuthorizedForWorktree(orchestrator, task.id, ["src/"]);

    await manager.createAndAttachWorktree({
      taskId: task.id,
      input: {
        projectId: "proj-wtm",
        repositoryPath: repoPath,
        defaultBranch: "main",
        taskId: task.id,
        allowedPaths: ["src/"]
      }
    });

    const audits = await store.unitOfWork.run((tx) => tx.audit.findByTask(task.id));
    const commandAudits = audits.filter((a) => a.type === "command_executed");

    // 至少有 rev-parse / status / worktree add 几条命令
    expect(commandAudits.length).toBeGreaterThanOrEqual(3);

    for (const audit of commandAudits) {
      // 结构化字段必须存在
      expect(audit.executedArgv).toBeDefined();
      expect(Array.isArray(audit.executedArgv)).toBe(true);
      expect(audit.executedArgv!.length).toBeGreaterThan(0);
      expect(audit.executedCwd).toBeDefined();
      expect(typeof audit.executedCwd).toBe("string");
      expect(audit.exitCode).toBeDefined();
      expect(typeof audit.exitCode).toBe("number");
      expect(audit.outputTruncation).toBeDefined();
      expect(typeof audit.outputTruncation!.originalBytes).toBe("number");
      expect(typeof audit.outputTruncation!.retainedBytes).toBe("number");
      expect(typeof audit.outputTruncation!.truncated).toBe("boolean");

      // 不包含敏感环境变量值（仅 argv/cwd/exitCode/截断信息）
      // argv 永不来自模型输出（§5.1、§7.2）—— 全部是 git 子命令
      expect(audit.executedArgv![0]).toBe("git");
    }
  });

  // -------------------------------------------------------------------------
  // 测试 6：P1-R01 —— captureDiffForTask 把 git diff 写入 SQLite 审计链
  // -------------------------------------------------------------------------

  it("captureDiffForTask 调用 getDiff 并写 command_executed + diff_recorded 审计（P1-R01）", async () => {
    const task = await orchestrator.createTask({
      projectId: "proj-wtm",
      input: sampleTaskInput()
    });

    // P1-R03：合法时序
    await prepareAuthorizedForWorktree(orchestrator, task.id);

    const worktree = await manager.createAndAttachWorktree({
      taskId: task.id,
      input: {
        projectId: "proj-wtm",
        repositoryPath: repoPath,
        defaultBranch: "main",
        taskId: task.id,
        allowedPaths: ["src/", "tests/"]
      }
    });

    // 在 worktree 内修改文件以产生 Diff
    writeFileSync(
      join(worktree.path, "src", "sample.py"),
      "def add(a, b):\n    \"\"\"Return sum.\"\"\"\n    return a + b\n"
    );

    // 受控获取 Diff
    const diff = await manager.captureDiffForTask({
      taskId: task.id,
      worktreeId: worktree.id,
      reason: "执行后 Diff 采集"
    });

    // 断言 1：DiffArtifact 字段完整
    expect(diff.worktreePath).toBe(worktree.path);
    expect(diff.patch.length).toBeGreaterThan(0);
    expect(diff.hash).toMatch(/^sha256-/);
    expect(diff.changedFiles).toContain("src/sample.py");
    expect(diff.bytes).toBeGreaterThan(0);

    // 断言 2：command_executed 审计中包含 git diff HEAD 与 git diff --name-only HEAD
    const audits = await store.unitOfWork.run((tx) => tx.audit.findByTask(task.id));
    const commandAudits = audits.filter((a) => a.type === "command_executed");

    // captureDiffForTask 触发 2 条 git diff 命令
    const diffCmds = commandAudits.filter((a) =>
      a.executedArgv!.includes("diff")
    );
    expect(diffCmds.length).toBeGreaterThanOrEqual(2);

    // 至少一条是 git diff HEAD（patch）
    const patchCmd = diffCmds.find((a) =>
      a.executedArgv!.includes("HEAD") && !a.executedArgv!.includes("--name-only")
    );
    expect(patchCmd).toBeDefined();
    expect(patchCmd!.executedCwd).toBe(worktree.path);
    expect(typeof patchCmd!.exitCode).toBe("number");

    // 至少一条是 git diff --name-only HEAD（变更文件列表）
    const nameOnlyCmd = diffCmds.find((a) =>
      a.executedArgv!.includes("--name-only")
    );
    expect(nameOnlyCmd).toBeDefined();
    expect(nameOnlyCmd!.executedCwd).toBe(worktree.path);

    // 断言 3：diff_recorded 审计事件已写入，diffHash 与 DiffArtifact.hash 一致
    const diffRecordedAudits = audits.filter((a) => a.type === "diff_recorded");
    expect(diffRecordedAudits.length).toBe(1);
    const diffAudit = diffRecordedAudits[0]!;
    expect(diffAudit.diffHash).toBe(diff.hash);
    expect(diffAudit.reason).toContain(worktree.id);
    expect(diffAudit.reason).toContain(worktree.path);
    expect(diffAudit.reason).toContain("执行后 Diff 采集");
    expect(diffAudit.taskId).toBe(task.id);
  });

  // -------------------------------------------------------------------------
  // 测试 7：P1-R01 —— captureDiffForTask 拒绝伪造 worktree（未登记）
  // -------------------------------------------------------------------------

  it("captureDiffForTask 拒绝伪造 worktree（未在数据库登记）（P1-R01）", async () => {
    const task = await orchestrator.createTask({
      projectId: "proj-wtm",
      input: sampleTaskInput()
    });

    // 直接通过 Adapter 创建 worktree，绕过 WorktreeManager（不登记）
    const gitAdapter = buildGitAdapter(repoPath, worktreeRoot);
    const realWorktree = await gitAdapter.createWorktree({
      projectId: "proj-wtm",
      repositoryPath: repoPath,
      defaultBranch: "main",
      taskId: task.id,
      allowedPaths: ["src/"]
    });

    // 尝试获取未登记 worktree 的 Diff —— 必须被拒绝
    await expect(
      manager.captureDiffForTask({
        taskId: task.id,
        worktreeId: realWorktree.id,
        reason: "尝试为未登记 worktree 获取 Diff"
      })
    ).rejects.toBeInstanceOf(WorktreeNotRegisteredException);

    // 断言：没有 diff_recorded 审计事件
    const audits = await store.unitOfWork.run((tx) => tx.audit.findByTask(task.id));
    const diffAudits = audits.filter((a) => a.type === "diff_recorded");
    expect(diffAudits.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 测试 8：P1-R01 —— captureDiffForTask 拒绝跨任务 Diff
  // -------------------------------------------------------------------------

  it("captureDiffForTask 拒绝跨任务 Diff（P1-R01）", async () => {
    const taskA = await orchestrator.createTask({
      projectId: "proj-wtm",
      input: sampleTaskInput({ objective: "任务 A" }),
      taskId: "task-a-diff"
    });
    const taskB = await orchestrator.createTask({
      projectId: "proj-wtm",
      input: sampleTaskInput({ objective: "任务 B" }),
      taskId: "task-b-diff"
    });

    // P1-R03：为任务 A 走合法时序
    await prepareAuthorizedForWorktree(orchestrator, taskA.id, ["src/"]);

    // 为任务 A 创建并登记 worktree
    const worktreeA = await manager.createAndAttachWorktree({
      taskId: taskA.id,
      input: {
        projectId: "proj-wtm",
        repositoryPath: repoPath,
        defaultBranch: "main",
        taskId: taskA.id,
        allowedPaths: ["src/"]
      }
    });

    // 任务 B 尝试获取任务 A 的 worktree Diff —— 必须被拒绝
    await expect(
      manager.captureDiffForTask({
        taskId: taskB.id,
        worktreeId: worktreeA.id,
        reason: "跨任务 Diff"
      })
    ).rejects.toThrow(/属于任务/);

    // 断言：任务 B 没有任何 diff_recorded 审计
    const auditsB = await store.unitOfWork.run((tx) =>
      tx.audit.findByTask(taskB.id)
    );
    const diffAuditsB = auditsB.filter((a) => a.type === "diff_recorded");
    expect(diffAuditsB.length).toBe(0);
  });
});
