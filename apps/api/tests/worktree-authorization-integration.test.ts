/**
 * P1-R03：worktree 创建授权对抗性测试。
 *
 * 验证 `WorktreeManager.createAndAttachWorktree` 在调用 `git worktree add`
 * 之前，会原子校验任务状态、有效 execution approval 与 scopeHash 一致性，
 * 任一校验失败时拒绝创建并写 `policy_denied` 审计。
 *
 * 覆盖场景（见 PHASE-3-ACCEPTANCE-REVIEW.md §9.3 关闭要求 4）：
 * 1. CREATED 状态拒绝
 * 2. GATHERING_EVIDENCE 状态拒绝
 * 3. PLANNED 状态拒绝
 * 4. 无审批的 AWAITING_EXECUTION_APPROVAL 拒绝
 * 5. 失效审批拒绝（invalidateExecutionApproval 后）
 * 6. scopeHash 不一致拒绝（修改 Project.commands 后）
 * 7. 有效审批的合法状态能创建、登记并审计 worktree
 *
 * 使用真实 SQLite + Git，不 mock 任何适配器。每个拒绝场景断言：
 * - HTTP 403
 * - 不创建 worktree 目录
 * - 不写 worktree_created 审计
 * - 写 policy_denied 审计
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCompositionRoot } from "../src/composition-root.js";
import type { TaskInput, Project, ProjectCommands } from "@tracepilot/core";

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-r03-"));
  return join(dir, "test.db");
}

function safeCleanup(dbPath: string): void {
  const dir = join(dbPath, "..");
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // 等待文件锁释放后重试。
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略 Windows 文件锁残留。
  }
}

function runGit(args: readonly string[], cwd: string): void {
  execFileSync("git", [...args], {
    cwd,
    stdio: "ignore",
    encoding: "utf8"
  });
}

function createPythonRepo(tmpRoot: string): string {
  const repoPath = join(tmpRoot, "python-repo");
  mkdirSync(repoPath, { recursive: true });

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

  writeFileSync(
    join(repoPath, "src", "sample.py"),
    "def add(a, b):\n    \"\"\"Return sum.\"\"\"\n    return a + b\n"
  );
  runGit(["add", "."], repoPath);
  runGit(["commit", "-m", "增加 docstring"], repoPath);

  return repoPath;
}

function sampleProject(repoPath: string, id = "proj-r03"): Project {
  return {
    id,
    name: "P1-R03 对抗性测试项目",
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
 * 把任务从 CREATED 迁移到 GATHERING_EVIDENCE 并生成 Pack v1。
 * 返回 Pack v1 的 id 与 version。
 */
async function prepareGatheringEvidenceAndPack(
  root: Awaited<ReturnType<typeof buildCompositionRoot>>,
  taskId: string
): Promise<{ packId: string; packVersion: number }> {
  for (const to of ["INTAKING", "GATHERING_EVIDENCE"] as const) {
    const res = await root.app.inject({
      method: "POST",
      url: `/tasks/${taskId}/transition`,
      payload: { to }
    });
    expect(res.statusCode).toBe(200);
  }
  const collectRes = await root.app.inject({
    method: "POST",
    url: `/tasks/${taskId}/collect-evidence`,
    payload: {}
  });
  expect(collectRes.statusCode).toBe(200);
  const body = collectRes.json() as { pack: { id: string; version: number } | null };
  expect(body.pack).not.toBeNull();
  return { packId: body.pack!.id, packVersion: body.pack!.version };
}

/**
 * 在 PLANNED 状态记录 Plan（含 allowedPaths），然后迁移到
 * AWAITING_EXECUTION_APPROVAL 并记录 execution approval。
 *
 * 调用前任务必须已处于 PLANNED 状态。
 */
async function recordPlanAndApproval(
  root: Awaited<ReturnType<typeof buildCompositionRoot>>,
  taskId: string,
  packId: string,
  packVersion: number,
  allowedPaths: readonly string[]
): Promise<void> {
  const planRes = await root.app.inject({
    method: "POST",
    url: `/tasks/${taskId}/plan`,
    payload: {
      nodes: [
        {
          id: "node-1",
          label: "修改 sample.py",
          description: "调整 add 函数实现",
          evidencePackId: packId,
          evidencePackVersion: packVersion
        }
      ],
      allowedPaths,
      inputEvidencePackId: packId,
      inputEvidencePackVersion: packVersion
    }
  });
  expect(planRes.statusCode).toBe(201);

  const awaitingRes = await root.app.inject({
    method: "POST",
    url: `/tasks/${taskId}/transition`,
    payload: { to: "AWAITING_EXECUTION_APPROVAL" }
  });
  expect(awaitingRes.statusCode).toBe(200);

  const approvalRes = await root.app.inject({
    method: "POST",
    url: `/tasks/${taskId}/approvals`,
    payload: {
      approver: "test-approver",
      decision: "approved",
      reason: "测试用执行审批"
    }
  });
  expect(approvalRes.statusCode).toBe(201);
}

/**
 * 统计受控 worktreeRoot 下已创建的目录数，用于断言"未创建 worktree"。
 */
function countWorktreeDirs(worktreeRoot: string): number {
  if (!existsSync(worktreeRoot)) return 0;
  return readdirSync(worktreeRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .length;
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe("P1-R03：worktree 创建授权对抗性", () => {
  let dbPath: string;
  let tmpRoot: string;
  let repoPath: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    dbPath = tempDbPath();
    tmpRoot = mkdtempSync(join(tmpdir(), "tracepilot-r03-repo-"));
    repoPath = createPythonRepo(tmpRoot);
    worktreeRoot = join(tmpRoot, "worktrees");
    mkdirSync(worktreeRoot, { recursive: true });
  });

  afterEach(() => {
    safeCleanup(dbPath);
    for (let i = 0; i < 3; i++) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
        break;
      } catch {
        // 等待文件锁释放后重试。
      }
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // 忽略 Windows 文件锁。
    }
  });

  it("CREATED 状态拒绝创建 worktree（HTTP 403 + policy_denied 审计）", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject(repoPath));
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r03", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      const beforeCount = countWorktreeDirs(worktreeRoot);
      const wtRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/worktrees`,
        payload: {}
      });
      expect(wtRes.statusCode).toBe(403);
      expect(countWorktreeDirs(worktreeRoot)).toBe(beforeCount);

      // 审计含 policy_denied，不含 worktree_created
      const audits = await root.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = audits.filter((a) => a.type === "policy_denied");
      expect(denied.length).toBe(1);
      expect(denied[0]!.deniedAction).toBe("createWorktree");
      expect(denied[0]!.deniedReason).toContain("AWAITING_EXECUTION_APPROVAL");
      expect(audits.some((a) => a.type === "worktree_created")).toBe(false);
    } finally {
      await root.close();
    }
  });

  it("GATHERING_EVIDENCE 状态拒绝创建 worktree", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject(repoPath));
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r03", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      // 迁移到 GATHERING_EVIDENCE（不记录 Plan / 审批）
      await prepareGatheringEvidenceAndPack(root, task.id);

      const beforeCount = countWorktreeDirs(worktreeRoot);
      const wtRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/worktrees`,
        payload: {}
      });
      expect(wtRes.statusCode).toBe(403);
      expect(countWorktreeDirs(worktreeRoot)).toBe(beforeCount);

      const audits = await root.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      expect(audits.some((a) => a.type === "policy_denied")).toBe(true);
      expect(audits.some((a) => a.type === "worktree_created")).toBe(false);
    } finally {
      await root.close();
    }
  });

  it("PLANNED 状态（已记录 Plan 但未取得审批）拒绝创建 worktree", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject(repoPath));
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r03", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      // 迁移到 GATHERING_EVIDENCE + 生成 Pack v1
      const { packId, packVersion } = await prepareGatheringEvidenceAndPack(root, task.id);

      // 迁移到 PLANNED + 记录 Plan（但不迁移到 AWAITING_EXECUTION_APPROVAL）
      const plannedRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "PLANNED" }
      });
      expect(plannedRes.statusCode).toBe(200);
      const planRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/plan`,
        payload: {
          nodes: [
            {
              id: "node-1",
              label: "修改 sample.py",
              description: "调整 add 函数实现",
              evidencePackId: packId,
              evidencePackVersion: packVersion
            }
          ],
          allowedPaths: ["src/", "tests/"],
          inputEvidencePackId: packId,
          inputEvidencePackVersion: packVersion
        }
      });
      expect(planRes.statusCode).toBe(201);

      const beforeCount = countWorktreeDirs(worktreeRoot);
      const wtRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/worktrees`,
        payload: {}
      });
      expect(wtRes.statusCode).toBe(403);
      expect(countWorktreeDirs(worktreeRoot)).toBe(beforeCount);

      const audits = await root.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      expect(audits.some((a) => a.type === "policy_denied")).toBe(true);
      expect(audits.some((a) => a.type === "worktree_created")).toBe(false);
    } finally {
      await root.close();
    }
  });

  it("AWAITING_EXECUTION_APPROVAL 但无审批记录拒绝创建 worktree", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject(repoPath));
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r03", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      // 走合法时序到 AWAITING_EXECUTION_APPROVAL，但不调用 /approvals
      const { packId, packVersion } = await prepareGatheringEvidenceAndPack(root, task.id);
      const plannedRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "PLANNED" }
      });
      expect(plannedRes.statusCode).toBe(200);
      const planRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/plan`,
        payload: {
          nodes: [
            {
              id: "node-1",
              label: "修改 sample.py",
              description: "调整 add 函数实现",
              evidencePackId: packId,
              evidencePackVersion: packVersion
            }
          ],
          allowedPaths: ["src/", "tests/"],
          inputEvidencePackId: packId,
          inputEvidencePackVersion: packVersion
        }
      });
      expect(planRes.statusCode).toBe(201);
      const awaitingRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "AWAITING_EXECUTION_APPROVAL" }
      });
      expect(awaitingRes.statusCode).toBe(200);

      const beforeCount = countWorktreeDirs(worktreeRoot);
      const wtRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/worktrees`,
        payload: {}
      });
      expect(wtRes.statusCode).toBe(403);
      expect(countWorktreeDirs(worktreeRoot)).toBe(beforeCount);

      const audits = await root.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = audits.filter((a) => a.type === "policy_denied");
      expect(denied.length).toBe(1);
      expect(denied[0]!.deniedReason).toContain("execution approval");
      expect(audits.some((a) => a.type === "worktree_created")).toBe(false);
    } finally {
      await root.close();
    }
  });

  it("失效审批拒绝创建 worktree（invalidateExecutionApproval 后视为无审批）", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject(repoPath));
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r03", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      // 走合法时序取得审批
      const { packId, packVersion } = await prepareGatheringEvidenceAndPack(root, task.id);
      const plannedRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "PLANNED" }
      });
      expect(plannedRes.statusCode).toBe(200);
      await recordPlanAndApproval(root, task.id, packId, packVersion, ["src/", "tests/"]);

      // 失效该审批（模拟范围扩大或被撤销）
      await root.orchestrator.invalidateExecutionApproval(
        task.id,
        "测试：手动失效审批"
      );

      const beforeCount = countWorktreeDirs(worktreeRoot);
      const wtRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/worktrees`,
        payload: {}
      });
      expect(wtRes.statusCode).toBe(403);
      expect(countWorktreeDirs(worktreeRoot)).toBe(beforeCount);

      const audits = await root.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      // 失效审批后，findLatestExecutionApproval 返回 undefined，触发
      // MissingExecutionApprovalException 路径 → policy_denied
      const denied = audits.filter((a) => a.type === "policy_denied");
      expect(denied.length).toBe(1);
      expect(denied[0]!.deniedReason).toContain("execution approval");
      expect(audits.some((a) => a.type === "worktree_created")).toBe(false);
    } finally {
      await root.close();
    }
  });

  it("scopeHash 不一致拒绝创建 worktree（审批后修改 Project.commands）", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      const project = sampleProject(repoPath);
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(project);
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r03", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      // 走合法时序取得审批（scopeHash 基于原 Project.commands）
      const { packId, packVersion } = await prepareGatheringEvidenceAndPack(root, task.id);
      const plannedRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "PLANNED" }
      });
      expect(plannedRes.statusCode).toBe(200);
      await recordPlanAndApproval(root, task.id, packId, packVersion, ["src/", "tests/"]);

      // 修改 Project.commands：添加 build 命令键，改变 commandWhitelist，
      // 从而改变 computeCurrentScopeHash 的输出。
      const modifiedCommands: ProjectCommands = {
        ...project.commands,
        build: { argv: ["python", "-m", "build"], timeoutMs: 60000 }
      };
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save({
          ...project,
          commands: modifiedCommands
        });
      });
      // 清除项目服务缓存，确保下次 /worktrees 重新读取项目（虽然
      // WorktreeManager 直接从 tx.projects 读取，但缓存清除更稳妥）。
      // 这里不暴露清缓存接口，依赖 WorktreeManager 在事务内读取最新 project。

      const beforeCount = countWorktreeDirs(worktreeRoot);
      const wtRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/worktrees`,
        payload: {}
      });
      expect(wtRes.statusCode).toBe(403);
      expect(countWorktreeDirs(worktreeRoot)).toBe(beforeCount);

      const audits = await root.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = audits.filter((a) => a.type === "policy_denied");
      expect(denied.length).toBe(1);
      expect(denied[0]!.deniedReason).toContain("scopeHash 不一致");
      expect(audits.some((a) => a.type === "worktree_created")).toBe(false);
    } finally {
      await root.close();
    }
  });

  it("有效审批的合法状态能创建、登记并审计 worktree", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject(repoPath));
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r03", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      // 走完整合法时序
      const { packId, packVersion } = await prepareGatheringEvidenceAndPack(root, task.id);
      const plannedRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "PLANNED" }
      });
      expect(plannedRes.statusCode).toBe(200);
      await recordPlanAndApproval(root, task.id, packId, packVersion, ["src/", "tests/"]);

      const beforeCount = countWorktreeDirs(worktreeRoot);
      const wtRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/worktrees`,
        payload: {}
      });
      expect(wtRes.statusCode).toBe(201);
      const worktree = wtRes.json() as {
        id: string;
        path: string;
        branch: string;
        taskId: string;
      };
      expect(worktree.taskId).toBe(task.id);
      // 真实创建了 worktree 目录
      expect(countWorktreeDirs(worktreeRoot)).toBe(beforeCount + 1);
      expect(existsSync(worktree.path)).toBe(true);

      // worktree 在 worktrees 表中已登记
      const registered = await root.store.unitOfWork.run((tx) =>
        tx.worktrees.findById(worktree.id)
      );
      expect(registered).toBeDefined();
      expect(registered?.taskId).toBe(task.id);
      // allowedPaths 来自持久化 Plan（["src/", "tests/"]），不是请求体占位值（[]）
      expect(registered?.allowedPaths).toEqual(["src/", "tests/"]);

      // 审计含 worktree_created + command_executed，不含 policy_denied
      const audits = await root.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      expect(audits.some((a) => a.type === "worktree_created")).toBe(true);
      expect(audits.some((a) => a.type === "command_executed")).toBe(true);
      expect(audits.some((a) => a.type === "policy_denied")).toBe(false);
    } finally {
      await root.close();
    }
  });

  // -------------------------------------------------------------------------
  // P1-R04：scopeHash 必须包含完整命令契约（argv + timeoutMs）。
  // 旧实现只哈希命令 key，审批后保留同一 key 但替换 argv（例如把
  // `pytest` 改成 `rm -rf /`）不会改变 scopeHash，违反规格 §7.2。
  // -------------------------------------------------------------------------

  it("P1-R04：审批后仅替换同一命令 key 的 argv 必须拒绝创建 worktree", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      const project = sampleProject(repoPath);
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(project);
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r03", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      // 走合法时序取得审批（scopeHash 基于原 Project.commands.test.argv=["python","-m","pytest"]）
      const { packId, packVersion } = await prepareGatheringEvidenceAndPack(root, task.id);
      const plannedRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "PLANNED" }
      });
      expect(plannedRes.statusCode).toBe(200);
      await recordPlanAndApproval(root, task.id, packId, packVersion, ["src/", "tests/"]);

      // P1-R04 关键场景：不增删命令 key，仅替换同一 key 的 argv。
      // 旧实现只哈希 commandWhitelist=Object.keys(commands)，
      // 这种修改不会改变 scopeHash，因此 worktree 创建会被错误放行。
      // 新实现必须检测到 argv 变化并拒绝。
      const tamperedCommands: ProjectCommands = {
        test: { argv: ["rm", "-rf", "/"], timeoutMs: 30000 }
      };
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save({
          ...project,
          commands: tamperedCommands
        });
      });

      const beforeCount = countWorktreeDirs(worktreeRoot);
      const wtRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/worktrees`,
        payload: {}
      });
      expect(wtRes.statusCode).toBe(403);
      expect(countWorktreeDirs(worktreeRoot)).toBe(beforeCount);

      const audits = await root.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = audits.filter((a) => a.type === "policy_denied");
      expect(denied.length).toBe(1);
      expect(denied[0]!.deniedReason).toContain("scopeHash 不一致");
      expect(audits.some((a) => a.type === "worktree_created")).toBe(false);
    } finally {
      await root.close();
    }
  });

  it("P1-R04：审批后仅替换同一命令 key 的 argv 必须拒绝进入 EXECUTING", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      const project = sampleProject(repoPath);
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(project);
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r03", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      // 走合法时序取得审批
      const { packId, packVersion } = await prepareGatheringEvidenceAndPack(root, task.id);
      const plannedRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "PLANNED" }
      });
      expect(plannedRes.statusCode).toBe(200);
      await recordPlanAndApproval(root, task.id, packId, packVersion, ["src/", "tests/"]);

      // P1-R04：替换同一命令 key 的 argv（不增删 key）
      const tamperedCommands: ProjectCommands = {
        test: { argv: ["python", "-m", "pytest", "--collect-only"], timeoutMs: 30000 }
      };
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save({
          ...project,
          commands: tamperedCommands
        });
      });

      // 尝试进入 EXECUTING 必须被拒绝 —— beginExecutionIfApproved 在事务内
      // 重算 scopeHash，检测到 argv 变化后抛 ScopeMismatchError。
      // 注意：API 没有直接暴露 beginExecutionIfApproved 端点，但 transition
      // 到 EXECUTING 会内部调用它。这里直接调用 orchestrator 验证。
      const orchestrator = root.orchestrator;
      await expect(orchestrator.beginExecutionIfApproved(task.id)).rejects.toThrow();

      // 任务保持原状态
      const taskAfter = await root.store.unitOfWork.run((tx) =>
        tx.tasks.findById(task.id)
      );
      expect(taskAfter?.status).toBe("AWAITING_EXECUTION_APPROVAL");
    } finally {
      await root.close();
    }
  });

  it("P1-R04：多 Plan 场景使用 task.currentPlanId 而非最后一条 Plan", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      const project = sampleProject(repoPath);
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(project);
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r03", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      // 走合法时序取得审批（Plan A：allowedPaths=["src/", "tests/"]）
      const { packId, packVersion } = await prepareGatheringEvidenceAndPack(root, task.id);
      const plannedRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "PLANNED" }
      });
      expect(plannedRes.statusCode).toBe(200);
      await recordPlanAndApproval(root, task.id, packId, packVersion, ["src/", "tests/"]);

      // 验证 task.currentPlanId 指向 Plan A
      const taskAfterApproval = await root.store.unitOfWork.run((tx) =>
        tx.tasks.findById(task.id)
      );
      const planAId = taskAfterApproval?.currentPlanId;
      expect(planAId).toBeDefined();

      // 直接在数据库写入第二条 Plan B（绕过 planTask，模拟"按时间排序最后一条"）
      // Plan B 使用不同的 allowedPaths，按时间排序应该在 Plan A 之后
      const planBId = `${planAId}-B`;
      const plans = await root.store.unitOfWork.run((tx) =>
        tx.plans.findByTask(task.id)
      );
      const planA = plans[0]!;
      await root.store.unitOfWork.run(async (tx) => {
        await tx.plans.save({
          ...planA,
          id: planBId,
          createdAt: new Date(Date.now() + 1000).toISOString(),
          allowedPaths: ["src/", "tests/", "secret/"]
        });
        // 不更新 task.currentPlanId —— 它仍指向 Plan A
      });

      // 验证：task.currentPlanId 仍指向 Plan A
      const taskFinal = await root.store.unitOfWork.run((tx) =>
        tx.tasks.findById(task.id)
      );
      expect(taskFinal?.currentPlanId).toBe(planAId);

      // 验证：按时间排序的最后一条 Plan 是 Plan B
      const allPlans = await root.store.unitOfWork.run((tx) =>
        tx.plans.findByTask(task.id)
      );
      expect(allPlans.length).toBe(2);
      const latestByTime = allPlans[allPlans.length - 1]!;
      expect(latestByTime.id).toBe(planBId);

      // 创建 worktree：scopeHash 应基于 task.currentPlanId（Plan A），
      // 而非按时间排序的最后一条 Plan（Plan B）。
      // 由于 approval.scopeHash 是基于 Plan A 计算的，worktree 创建应该成功。
      const beforeCount = countWorktreeDirs(worktreeRoot);
      const wtRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/worktrees`,
        payload: {}
      });
      expect(wtRes.statusCode).toBe(201);
      expect(countWorktreeDirs(worktreeRoot)).toBe(beforeCount + 1);

      // worktree 的 allowedPaths 应来自 Plan A（["src/", "tests/"]），
      // 而非 Plan B（["src/", "tests/", "secret/"]）
      const worktree = wtRes.json() as { id: string; allowedPaths: string[] };
      expect(worktree.allowedPaths).toEqual(["src/", "tests/"]);

      const registered = await root.store.unitOfWork.run((tx) =>
        tx.worktrees.findById(worktree.id)
      );
      expect(registered?.allowedPaths).toEqual(["src/", "tests/"]);
    } finally {
      await root.close();
    }
  });
});
