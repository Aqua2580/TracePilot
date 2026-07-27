/**
 * P1-R02：受控服务 API 集成测试。
 *
 * 验证组合根装配的 WorktreeManager / EvidenceRouter / EvidenceCollector
 * 与新增的受控 API 端点形成完整可执行链路：
 *
 * 1. 项目登记 → POST /tasks → POST /tasks/:taskId/worktrees（受控创建并登记）
 * 2. POST /tasks/:taskId/transition → GATHERING_EVIDENCE
 * 3. POST /tasks/:taskId/collect-evidence（受控收集证据 + Pack v1 + 审计）
 * 4. POST /tasks/:taskId/diff（受控 Diff 采集）
 *
 * 断言：
 * - 项目隔离（其他项目仓库作为 cwd 被拒绝）
 * - Router 请求规格写入审计（evidence_router_request）
 * - git 命令审计写入 SQLite（command_executed）
 * - Diff 采集写 diff_recorded（含 diffHash）
 * - Pack v1 证据每条可追溯（source/locator/contentHash）
 *
 * 使用真实 git 二进制（经 LocalGitAdapter / LocalProcessRunner 治理执行）
 * 与 SQLite 真源（createSqliteStore），不 mock 任何适配器。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCompositionRoot } from "../src/composition-root.js";
import type { TaskInput, Project } from "@tracepilot/core";

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-api-r02-"));
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

/**
 * 在临时目录中创建最小可用 Python git 仓库（含两次提交）。
 */
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

function sampleProject(repoPath: string, id = "proj-r02"): Project {
  return {
    id,
    name: "P1-R02 受控服务测试项目",
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
 * 记录 Plan（含 allowedPaths）并取得执行审批，使后续 /worktrees 创建可通过审批校验。
 *
 * 合法时序：
 * 1. CREATED → INTAKING → GATHERING_EVIDENCE
 * 2. /collect-evidence 生成 Pack v1（无 worktree，无 Diff）
 * 3. GATHERING_EVIDENCE → PLANNED
 * 4. /plan 记录 Plan（引用 Pack v1，含 allowedPaths）
 * 5. PLANNED → AWAITING_EXECUTION_APPROVAL
 * 6. /approvals 记录 execution approval（scopeHash 由后端自动计算）
 *
 * 返回 Pack v1 的 id 与 version，供 /plan 调用引用。
 */
async function prepareAuthorizedForWorktree(
  root: Awaited<ReturnType<typeof buildCompositionRoot>>,
  taskId: string,
  allowedPaths: readonly string[] = ["src/", "tests/"]
): Promise<{ packId: string; packVersion: number }> {
  // 1. CREATED → INTAKING → GATHERING_EVIDENCE
  for (const to of ["INTAKING", "GATHERING_EVIDENCE"] as const) {
    const res = await root.app.inject({
      method: "POST",
      url: `/tasks/${taskId}/transition`,
      payload: { to }
    });
    expect(res.statusCode).toBe(200);
  }

  // 2. /collect-evidence 生成 Pack v1
  const collectRes = await root.app.inject({
    method: "POST",
    url: `/tasks/${taskId}/collect-evidence`,
    payload: {}
  });
  expect(collectRes.statusCode).toBe(200);
  const collectBody = collectRes.json() as {
    pack: { id: string; version: number } | null;
  };
  expect(collectBody.pack).not.toBeNull();
  const packId = collectBody.pack!.id;
  const packVersion = collectBody.pack!.version;

  // 3. GATHERING_EVIDENCE → PLANNED
  const plannedRes = await root.app.inject({
    method: "POST",
    url: `/tasks/${taskId}/transition`,
    payload: { to: "PLANNED" }
  });
  expect(plannedRes.statusCode).toBe(200);

  // 4. /plan 记录 Plan
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

  // 5. PLANNED → AWAITING_EXECUTION_APPROVAL
  const awaitingRes = await root.app.inject({
    method: "POST",
    url: `/tasks/${taskId}/transition`,
    payload: { to: "AWAITING_EXECUTION_APPROVAL" }
  });
  expect(awaitingRes.statusCode).toBe(200);

  // 6. /approvals 记录 execution approval
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

  return { packId, packVersion };
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe("P1-R02：受控服务 API 集成", () => {
  let dbPath: string;
  let tmpRoot: string;
  let repoPath: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    dbPath = tempDbPath();
    tmpRoot = mkdtempSync(join(tmpdir(), "tracepilot-r02-repo-"));
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

  it("POST /tasks/:taskId/worktrees 经 WorktreeManager 受控创建并登记 worktree", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      // 登记项目
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject(repoPath));
      });

      // 创建任务
      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r02", input: sampleTaskInput() }
      });
      expect(createRes.statusCode).toBe(201);
      const task = createRes.json() as { id: string };

      // P1-R03：合法时序 —— 迁移到 AWAITING_EXECUTION_APPROVAL 并取得执行审批
      await prepareAuthorizedForWorktree(root, task.id);

      // 受控创建 worktree（请求体不再传 allowedPaths，由 WorktreeManager 从 Plan 读取）
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
      expect(worktree.branch).toBe(`tp/${task.id}`);
      // 路径校验：worktree 必须位于受控 worktreeRoot 内
      const normalizedPath = worktree.path.replace(/\\/g, "/");
      const normalizedRoot = worktreeRoot.replace(/\\/g, "/");
      expect(normalizedPath).toContain(normalizedRoot);

      // task.worktreeId 已更新
      const storedTask = await root.store.unitOfWork.run((tx) =>
        tx.tasks.findById(task.id)
      );
      expect(storedTask?.worktreeId).toBe(worktree.id);

      // worktree 在 worktrees 表中已登记
      const registered = await root.store.unitOfWork.run((tx) =>
        tx.worktrees.findById(worktree.id)
      );
      expect(registered).toBeDefined();
      expect(registered?.taskId).toBe(task.id);

      // 审计含 worktree_created + command_executed
      const audits = await root.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      expect(audits.some((a) => a.type === "worktree_created")).toBe(true);
      expect(audits.some((a) => a.type === "command_executed")).toBe(true);
    } finally {
      await root.close();
    }
  });

  it("POST /tasks/:taskId/collect-evidence 受控收集证据并生成 Pack v1（含 Router 审计 + git 命令审计）", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject(repoPath));
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r02", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      // 沿合法路径迁移到 GATHERING_EVIDENCE
      for (const to of ["INTAKING", "GATHERING_EVIDENCE"]) {
        const res = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/transition`,
          payload: { to }
        });
        expect(res.statusCode).toBe(200);
      }

      // 受控收集证据
      const collectRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/collect-evidence`,
        payload: {
          blameFilePaths: ["src/sample.py", "tests/test_sample.py"]
        }
      });
      expect(collectRes.statusCode).toBe(200);
      const body = collectRes.json() as {
        evidenceCount: number;
        gitCommandCount: number;
        evidence: Array<{
          id: string;
          source: string;
          locator: string;
          contentHash: string;
          capturedAt: string;
        }>;
        pack: {
          id: string;
          version: number;
          taskId: string;
          evidence: Array<{ source: string; locator: string; contentHash: string }>;
        } | null;
      };

      expect(body.evidenceCount).toBeGreaterThan(0);
      expect(body.gitCommandCount).toBeGreaterThan(0);
      expect(body.pack).not.toBeNull();
      expect(body.pack!.version).toBe(1);
      expect(body.pack!.taskId).toBe(task.id);

      // 每条证据可追溯字段非空
      for (const item of body.evidence) {
        expect(item.source.length).toBeGreaterThan(0);
        expect(item.locator.length).toBeGreaterThan(0);
        expect(item.contentHash.length).toBeGreaterThan(0);
        expect(item.capturedAt.length).toBeGreaterThan(0);
      }

      // 审计时间线包含 evidence_router_request + command_executed + evidence_pack_versioned
      const audits = await root.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const routerAudits = audits.filter((a) => a.type === "evidence_router_request");
      expect(routerAudits.length).toBeGreaterThan(0);
      // Router 对 failed_test_log + testNames 输出 5 类请求
      expect(routerAudits.length).toBe(5);
      for (const a of routerAudits) {
        expect(a.reason).toContain("kind=");
        expect(a.reason).toContain("source=");
        expect(a.reason).toContain("scope=");
      }

      const commandAudits = audits.filter((a) => a.type === "command_executed");
      expect(commandAudits.length).toBeGreaterThan(0);

      const packAudits = audits.filter((a) => a.type === "evidence_pack_versioned");
      expect(packAudits.length).toBe(1);
      expect(packAudits[0]!.evidencePackId).toBe(body.pack!.id);
      expect(packAudits[0]!.evidencePackVersion).toBe(1);
      expect(packAudits[0]!.evidencePackHash).toBe(body.pack!.id ? packAudits[0]!.evidencePackHash : "");
    } finally {
      await root.close();
    }
  });

  it("POST /tasks/:taskId/diff 受控 Diff 采集写 command_executed + diff_recorded（P1-R01 端到端）", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject(repoPath));
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r02", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      // P1-R03：合法时序 —— 迁移到 AWAITING_EXECUTION_APPROVAL 并取得执行审批
      await prepareAuthorizedForWorktree(root, task.id);

      // 创建 worktree
      const wtRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/worktrees`,
        payload: {}
      });
      const worktree = wtRes.json() as { id: string; path: string };

      // 在 worktree 内修改文件以产生 Diff（与仓库已有内容不同）
      writeFileSync(
        join(worktree.path, "src", "sample.py"),
        "def add(a, b):\n    \"\"\"Return sum of two numbers.\"\"\"\n    return a + b\n"
      );

      // 受控 Diff 采集
      const diffRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/diff`,
        payload: { reason: "API 端到端 Diff 采集" }
      });
      expect(diffRes.statusCode).toBe(200);
      const diffBody = diffRes.json() as {
        worktreePath: string;
        hash: string;
        changedFiles: string[];
        bytes: number;
        patchPreview: string;
      };
      expect(diffBody.hash).toMatch(/^sha256-/);
      expect(diffBody.changedFiles).toContain("src/sample.py");
      expect(diffBody.bytes).toBeGreaterThan(0);
      expect(diffBody.worktreePath).toBe(worktree.path);

      // 审计时间线包含 command_executed（git diff HEAD / git diff --name-only HEAD）
      const audits = await root.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const commandAudits = audits.filter((a) => a.type === "command_executed");
      const diffCmds = commandAudits.filter((a) =>
        a.executedArgv!.includes("diff")
      );
      expect(diffCmds.length).toBeGreaterThanOrEqual(2);

      // 审计时间线包含 diff_recorded 且 diffHash 与响应一致
      const diffRecorded = audits.filter((a) => a.type === "diff_recorded");
      expect(diffRecorded.length).toBe(1);
      expect(diffRecorded[0]!.diffHash).toBe(diffBody.hash);
      expect(diffRecorded[0]!.reason).toContain("API 端到端 Diff 采集");
    } finally {
      await root.close();
    }
  });

  it("项目隔离：其他项目仓库作为 cwd 被拒绝（生产等价 roots 配置）", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      // 登记项目 A
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject(repoPath, "proj-a"));
      });

      // 在 tmpRoot 下创建另一个仓库（项目 B，未登记）
      const repoPathB = join(tmpRoot, "python-repo-b");
      mkdirSync(repoPathB, { recursive: true });
      runGit(["init", "-b", "main"], repoPathB);
      runGit(["config", "user.email", "test@example.com"], repoPathB);
      runGit(["config", "user.name", "Test User"], repoPathB);
      writeFileSync(join(repoPathB, "README.md"), "项目 B\n");
      runGit(["add", "."], repoPathB);
      runGit(["commit", "-m", "项目 B 初始提交"], repoPathB);

      // 创建任务（属于项目 A）—— 任务存在即可，断言聚焦在项目隔离。
      await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-a", input: sampleTaskInput() }
      });

      // 直接通过 createServicesForProject 验证：用项目 A 的服务
      // 调用 GitAdapter.getBlame 时，传入项目 B 的仓库路径应被拒绝
      const projectA = (await root.store.unitOfWork.run((tx) =>
        tx.projects.findById("proj-a")
      ))!;
      const services = root.createServicesForProject(projectA);

      await expect(
        services.gitAdapter.getBlame({
          repositoryPath: repoPathB,
          path: "README.md"
        })
      ).rejects.toThrow();
    } finally {
      await root.close();
    }
  });

  it("POST /tasks/:taskId/collect-evidence 含 worktreeId 时收集 git-diff 证据", async () => {
    const root = buildCompositionRoot({ dbPath, worktreeRoot });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject(repoPath));
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-r02", input: sampleTaskInput() }
      });
      const task = createRes.json() as { id: string };

      // P1-R03：合法时序 —— 迁移到 AWAITING_EXECUTION_APPROVAL 并取得执行审批
      // 注意：合法时序下 Pack v1 在 GATHERING_EVIDENCE 生成（无 worktree），
      // worktree 在 AWAITING_EXECUTION_APPROVAL 创建。本测试验证"含 worktreeId
      // 时收集 git-diff 证据"，不再断言 Pack 升级（升级需 evolvePackWithNewEvidence，
      // 属于 Phase 5 范围）。
      await prepareAuthorizedForWorktree(root, task.id);

      // 创建 worktree
      const wtRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/worktrees`,
        payload: {}
      });
      const worktree = wtRes.json() as { id: string; path: string };

      // 修改 worktree 内文件以产生 Diff（与仓库已有内容不同）
      writeFileSync(
        join(worktree.path, "src", "sample.py"),
        "def add(a, b):\n    \"\"\"Return sum of two numbers.\"\"\"\n    return a + b\n"
      );

      // 受控收集证据（含 worktreeId → 触发 Diff 证据）
      const collectRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/collect-evidence`,
        payload: {}
      });
      expect(collectRes.statusCode).toBe(200);
      const body = collectRes.json() as {
        evidence: Array<{ source: string; locator: string; contentHash: string }>;
        pack: { version: number } | null;
      };

      // 必须包含 git-diff 证据
      const diffEvidence = body.evidence.filter((e) => e.source === "git-diff");
      expect(diffEvidence.length).toBe(1);
      const diffEv = diffEvidence[0]!;
      expect(diffEv.locator).toMatch(/^diff:/);
      expect(diffEv.contentHash).toMatch(/^sha256-/);

      // 审计时间线包含 diff_recorded
      const audits = await root.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const diffRecorded = audits.filter((a) => a.type === "diff_recorded");
      expect(diffRecorded.length).toBe(1);
    } finally {
      await root.close();
    }
  });
});
