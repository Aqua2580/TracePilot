/**
 * Phase 4 真实 omp 闭环集成测试。
 *
 * 验证 ADR-007 退出条件：真实失败任务由 OmpAdapter 完成
 * analyze → develop → review，产出 Patch + 测试结果。
 *
 * 本测试调用真实 omp 二进制与操作者已登录的本机 profile，修改 worktree 中的源码，
 * 使失败测试转为通过。普通回归会在前置条件缺失时跳过；受保护的
 * `test:omp-real` 命令则要求两个任务的前置条件全部满足，否则失败关闭：
 * - omp 二进制位于 .env 中 TRACEPILOT_OMP_PATH 指定路径
 * - Omp 隔离 profile 已完成登录并选定模型
 * - python + pytest 已安装
 *
 * 不使用 mock：经真实 SQLite 存储、真实 git worktree、真实 ProcessRunner
 * 治理执行 omp 子进程。
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { buildCompositionRoot } from "../src/composition-root.js";
import { hashSagSourceDocument, SagHttpTransport } from "@tracepilot/adapters";
import type { KnowledgeDocumentKind, TaskInput, Project } from "@tracepilot/core";

// ---------------------------------------------------------------------------
// 前置条件检测
// ---------------------------------------------------------------------------

function loadEnvFile(): void {
  try {
    // apps/api/tests/omp-real-closed-loop.test.ts → 项目根往上三级
    const moduleDir = fileURLToPath(new URL(".", import.meta.url));
    const projectRoot = join(moduleDir, "..", "..", "..");
    const envPath = join(projectRoot, ".env");
    process.loadEnvFile?.(envPath);
  } catch {
    // .env 不存在 —— 静默跳过
  }
}

/**
 * 公共前置条件：omp 二进制存在 + 受控 profile 名可用。
 *
 * Python 与 JavaScript 闭环测试都需要这两项。Python 额外需要 pytest，
 * JavaScript 用 Node 18+ 内置 `node --test`，无需额外依赖。
 */
function checkCommonPrerequisites(): boolean {
  loadEnvFile();

  const ompPath = process.env.TRACEPILOT_OMP_PATH ?? "";
  const ompExists = ompPath.length > 0 && existsSync(ompPath);
  const profile = process.env.TRACEPILOT_OMP_PROFILE ?? "tracepilot";
  const validProfile = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile);

  return ompExists && validProfile;
}

/**
 * Python 闭环额外需要 pytest 可用。
 */
function checkPythonPrerequisites(): boolean {
  if (!checkCommonPrerequisites()) return false;
  const pythonPath = phase7RealRunRequested
    ? process.env.TRACEPILOT_PHASE7_PYTHON?.trim()
    : "python";
  if (!pythonPath || (phase7RealRunRequested && !existsSync(pythonPath))) return false;
  try {
    execFileSync(pythonPath, ["-m", "pytest", "--version"], {
      stdio: "ignore",
      encoding: "utf8",
      timeout: 5000
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 真实模型测试必须显式启用，普通 `pnpm test` 即使本机 `.env` 已配置密钥，
 * 也不得自动产生网络调用或模型费用。只有受保护的 `test:omp-real` 脚本会
 * 设置此开关；独立 Reviewer 仍需在获得用户授权后才能运行该脚本。
 */
const realRunRequested = process.env.TRACEPILOT_OMP_REAL_STRICT === "1";
/**
 * Phase 7 门禁复用本文件的两个真实 Omp 场景，并额外核对本机 SAG 来源、
 * 最终人工挑战和 outbox 镜像。该开关从不由普通测试隐式设置。
 */
const phase7RealRunRequested = process.env.TRACEPILOT_PHASE7_REAL_STRICT === "1";
const PHASE7_HUMAN_SECRET = "phase7-real-human-channel-secret-32chars";

interface Phase7RealConfiguration {
  readonly sourceId: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly pythonPath: string;
}

function readPhase7RealConfiguration(): Phase7RealConfiguration | undefined {
  loadEnvFile();
  const sourceId = process.env.TRACEPILOT_PHASE7_SAG_SOURCE_ID?.trim() ?? "";
  const baseUrl = process.env.TRACEPILOT_SAG_BASE_URL?.trim() ?? "";
  const token = process.env.TRACEPILOT_SAG_TOKEN?.trim() ?? "";
  const pythonPath = process.env.TRACEPILOT_PHASE7_PYTHON?.trim() ?? "";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sourceId) ||
    !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(baseUrl) ||
    !token ||
    !pythonPath ||
    !existsSync(pythonPath)
  ) {
    return undefined;
  }
  try {
    execFileSync(pythonPath, ["-c", "import debugpy, pytest"], {
      stdio: "ignore",
      timeout: 5_000
    });
  } catch {
    return undefined;
  }
  return { sourceId, baseUrl, token, pythonPath };
}

const phase7RealConfiguration = phase7RealRunRequested
  ? readPhase7RealConfiguration()
  : undefined;
const commonPrerequisitesAvailable = realRunRequested && checkCommonPrerequisites();
const pythonPrerequisitesAvailable =
  realRunRequested && commonPrerequisitesAvailable && checkPythonPrerequisites();
const javascriptPrerequisitesAvailable = realRunRequested && commonPrerequisitesAvailable;
const shouldRunPython = pythonPrerequisitesAvailable;
const shouldRunJavascript = javascriptPrerequisitesAvailable;

/**
 * §6.4 受保护验收命令支持：当 TRACEPILOT_OMP_REAL_STRICT=1 时，任一真实
 * 任务的前置条件缺失都必须以非通过状态结束（抛错使测试文件失败），而不是
 * 只跳过缺少环境的任务后把另一项任务误报成“两项真实任务”已验收。
 *
 * `test:omp-real` 脚本设置此环境变量后运行 vitest，确保独立验收时
 * 前置条件缺失不会被误认为“验收通过”。
 */
if (realRunRequested) {
  if (!commonPrerequisitesAvailable) {
    throw new Error(
      "TRACEPILOT_OMP_REAL_STRICT=1 但公共前置条件缺失：" +
      "TRACEPILOT_OMP_PATH 未配置，或 TRACEPILOT_OMP_PROFILE 不合法。" +
      "无法执行真实 omp 验收 —— 请配置受控 Omp 路径并完成该 profile 的模型登录后重试。"
    );
  }
  if (!pythonPrerequisitesAvailable) {
    throw new Error(
      "TRACEPILOT_OMP_REAL_STRICT=1 但 Python 真实任务前置条件缺失：" +
      `${phase7RealRunRequested ? "TRACEPILOT_PHASE7_PYTHON" : "python"} -m pytest --version 未通过。` +
      "无法完成两个真实 omp 任务验收 —— 请安装并检查 pytest 后重试。"
    );
  }
}

if (phase7RealRunRequested) {
  if (!realRunRequested || process.env.TRACEPILOT_PHASE7_REAL_ACK !== "1") {
    throw new Error(
      "Phase 7 真实门禁必须同时设置 TRACEPILOT_PHASE7_REAL_ACK=1 与 TRACEPILOT_OMP_REAL_STRICT=1。"
    );
  }
  if (!phase7RealConfiguration) {
    throw new Error(
      "Phase 7 真实门禁缺少本机 SAG 或 uv 调试前置条件：需要 loopback TRACEPILOT_SAG_BASE_URL、TRACEPILOT_SAG_TOKEN、TRACEPILOT_PHASE7_SAG_SOURCE_ID，以及已安装 debugpy/pytest 的 TRACEPILOT_PHASE7_PYTHON。"
    );
  }
}

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-omp-real-"));
  return join(dir, "test.db");
}

function safeCleanup(path: string): void {
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      // Windows 文件锁，短暂等待后重试
    }
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // 忽略残留
  }
}

function runGit(args: readonly string[], cwd: string): void {
  execFileSync("git", [...args], { cwd, stdio: "ignore", encoding: "utf8" });
}

/**
 * 创建 Python 失败任务仓库（create_user 返回错误状态码）。
 *
 * 模拟真实失败场景：用户管理模块 create_user 在输入合法时
 * 应返回 201，但实现错误地返回 400。pytest 测试明确失败。
 * omp 需分析失败堆栈、定位 bug、修改 src/users.py、使测试通过。
 */
function createPythonFailingRepo(tmpRoot: string): {
  repoPath: string;
  worktreeRoot: string;
} {
  const repoPath = join(tmpRoot, "python-failing-repo");
  const worktreeRoot = join(tmpRoot, "python-failing-worktrees");

  mkdirSync(repoPath, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  runGit(["init", "-b", "main"], repoPath);
  runGit(["config", "user.email", "test@example.com"], repoPath);
  runGit(["config", "user.name", "Test User"], repoPath);
  runGit(["config", "core.autocrlf", "false"], repoPath);

  writeFileSync(join(repoPath, "pytest.ini"), "[pytest]\ntestpaths = tests\n");

  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(
    join(repoPath, "src", "users.py"),
    [
      '"""用户管理模块。"""',
      "",
      "",
      "def create_user(name: str, email: str) -> dict:",
      '    """创建用户，应返回 status=201。"""',
      '    if not name or not email:',
      '        return {"status": 400, "error": "参数为空"}',
      "    # BUG：合法输入也错误返回 400，应返回 201",
      '    return {"status": 400, "user": {"name": name, "email": email}}',
      ""
    ].join("\n")
  );

  // Phase 7 严格门禁才会显式执行此 pytest 文件。它不在 pytest.ini 的
  // testpaths 内，普通 Phase 4 闭环不会导入 debugpy 或改变既有失败任务。
  mkdirSync(join(repoPath, "diagnostics"), { recursive: true });
  writeFileSync(
    join(repoPath, "diagnostics", "test_phase7_runtime.py"),
    [
      "import debugpy",
      "",
      "",
      "def test_phase7_runtime_evidence():",
      "    expected_status = 201",
      "    failed_value = 400",
      "    debugpy.breakpoint()",
      "    assert failed_value == expected_status"
    ].join("\n") + "\n"
  );

  mkdirSync(join(repoPath, "tests"), { recursive: true });
  writeFileSync(
    join(repoPath, "tests", "test_users.py"),
    [
      "from src.users import create_user",
      "",
      "",
      "def test_create_user_returns_201():",
      '    """合法输入应返回 status=201。"""',
      '    result = create_user("alice", "alice@example.com")',
      '    assert result["status"] == 201, f\'got {result["status"]}\'',
      "",
      "",
      "def test_create_user_invalid_input():",
      '    """空输入应返回 status=400。"""',
      '    result = create_user("", "")',
      '    assert result["status"] == 400',
      ""
    ].join("\n")
  );

  runGit(["add", "."], repoPath);
  runGit(["commit", "-m", "初始提交：python 失败任务（create_user 返回错误状态码）"], repoPath);

  return { repoPath, worktreeRoot };
}

function pythonFailingProject(repoPath: string): Project {
  const pythonPath = phase7RealConfiguration?.pythonPath ?? "python";
  return {
    id: "proj-omp-python",
    name: "Python 失败任务（omp 真实闭环）",
    repositoryPath: repoPath,
    defaultBranch: "main",
    language: "python",
    commands: {
      // 真实受控任务只允许修改 src/users.py；禁用 Python / pytest 运行缓存，
      // 避免测试框架自身生成的字节码被误判为越界源码修改。
      test: { argv: [pythonPath, "-B", "-m", "pytest", "-p", "no:cacheprovider", "-v"], timeoutMs: 60000 }
    },
    ...(phase7RealConfiguration ? { knowledgeSourceId: phase7RealConfiguration.sourceId } : {}),
    createdAt: "2026-07-28T00:00:00.000Z"
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Phase 7 临时 debugpy 端口不可用");
  const port = address.port;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

async function waitForDebugpyStartup(child: ChildProcess): Promise<void> {
  // 不能用裸 TCP 探测 debugpy：它只允许一个 DAP 客户端，探测会抢占正式握手。
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 500));
  if (child.exitCode !== null) {
    throw new Error(`Phase 7 debugpy 提前退出（exitCode=${child.exitCode}）`);
  }
}

function pythonFailingTaskInput(): TaskInput {
  return {
    objective:
      "修复 src/users.py 中 create_user 函数的 bug：合法输入应返回 status=201，但当前错误返回 400",
    constraints: [
      "不得修改 tests/ 目录下的测试文件",
      "不得修改 pytest.ini",
      "仅修改 src/users.py"
    ],
    acceptanceCriteria: [
      "python -m pytest tests/test_users.py 全部通过",
      "create_user('alice', 'alice@example.com') 返回 status=201",
      "create_user('', '') 返回 status=400"
    ],
    riskLevel: "low",
    rawSource: [
      "FAILED tests/test_users.py::test_create_user_returns_201",
      "assert result['status'] == 201, got 400",
      "",
      "def test_create_user_returns_201():",
      '    result = create_user("alice", "alice@example.com")',
      "    assert result['status'] == 201, f'got {result[\"status\"]}'"
    ].join("\n"),
    origin: "failed_test_log",
    failure: {
      testNames: ["tests/test_users.py::test_create_user_returns_201"],
      errorTypes: ["AssertionError"],
      stackSummary:
        "assert result['status'] == 201, got 400 — create_user 合法输入返回了错误状态码"
    }
  };
}

/**
 * 创建 JavaScript 失败任务仓库（createUser 返回错误状态码）。
 *
 * 用 node:test（Node 18+ 内置）作为测试 runner，无需任何 npm install。
 * 模拟真实失败场景：用户管理模块 createUser 在输入合法时应返回 201，
 * 但实现错误返回 400。omp 需分析失败堆栈、定位 bug、修改 src/users.js、
 * 使 node --test 通过。
 */
function createJavascriptFailingRepo(tmpRoot: string): {
  repoPath: string;
  worktreeRoot: string;
} {
  const repoPath = join(tmpRoot, "javascript-failing-repo");
  const worktreeRoot = join(tmpRoot, "javascript-failing-worktrees");

  mkdirSync(repoPath, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  runGit(["init", "-b", "main"], repoPath);
  runGit(["config", "user.email", "test@example.com"], repoPath);
  runGit(["config", "user.name", "Test User"], repoPath);
  runGit(["config", "core.autocrlf", "false"], repoPath);

  // package.json 声明 ESM 模块
  writeFileSync(
    join(repoPath, "package.json"),
    JSON.stringify(
      {
        name: "javascript-failing-repo",
        version: "1.0.0",
        type: "module",
        private: true
      },
      null,
      2
    ) + "\n"
  );

  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(
    join(repoPath, "src", "users.js"),
    [
      "// 用户管理模块。",
      "",
      "export function createUser(name, email) {",
      "  if (!name || !email) {",
      '    return { status: 400, error: "参数为空" };',
      "  }",
      "  // BUG：合法输入也错误返回 400，应返回 201",
      "  return { status: 400, user: { name, email } };",
      "}",
      ""
    ].join("\n")
  );

  mkdirSync(join(repoPath, "tests"), { recursive: true });
  writeFileSync(
    join(repoPath, "tests", "users.test.js"),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      "import { createUser } from '../src/users.js';",
      "",
      "test('createUser 合法输入应返回 status=201', () => {",
      '  const result = createUser("alice", "alice@example.com");',
      "  assert.equal(result.status, 201, `got ${result.status}`);",
      "});",
      "",
      "test('createUser 空输入应返回 status=400', () => {",
      '  const result = createUser("", "");',
      "  assert.equal(result.status, 400);",
      "});",
      ""
    ].join("\n")
  );

  runGit(["add", "."], repoPath);
  runGit(["commit", "-m", "初始提交：javascript 失败任务（createUser 返回错误状态码）"], repoPath);

  return { repoPath, worktreeRoot };
}

function javascriptFailingProject(repoPath: string): Project {
  return {
    id: "proj-omp-javascript",
    name: "JavaScript 失败任务（omp 真实闭环）",
    repositoryPath: repoPath,
    defaultBranch: "main",
    language: "javascript",
    commands: {
      // node --test 是 Node 18+ 内置测试 runner，无需 npm install
      test: { argv: ["node", "--test", "tests/users.test.js"], timeoutMs: 60000 }
    },
    ...(phase7RealConfiguration ? { knowledgeSourceId: phase7RealConfiguration.sourceId } : {}),
    createdAt: "2026-07-28T00:00:00.000Z"
  };
}

function javascriptFailingTaskInput(): TaskInput {
  return {
    objective:
      "修复 src/users.js 中 createUser 函数的 bug：合法输入应返回 status=201，但当前错误返回 400",
    constraints: [
      "不得修改 tests/ 目录下的测试文件",
      "不得修改 package.json",
      "仅修改 src/users.js"
    ],
    acceptanceCriteria: [
      "node --test tests/users.test.js 全部通过",
      'createUser("alice", "alice@example.com") 返回 status=201',
      'createUser("", "") 返回 status=400'
    ],
    riskLevel: "low",
    rawSource: [
      "✖ test 'createUser 合法输入应返回 status=201'",
      "  AssertionError [ERR_ASSERTION]: got 400",
      "      at TestContext.<anonymous> (tests/users.test.js:7:12)",
      "",
      "tests/users.test.js:",
      "test('createUser 合法输入应返回 status=201', () => {",
      '  const result = createUser("alice", "alice@example.com");',
      "  assert.equal(result.status, 201, `got ${result.status}`);",
      "});"
    ].join("\n"),
    origin: "failed_test_log",
    failure: {
      testNames: ["createUser 合法输入应返回 status=201"],
      errorTypes: ["AssertionError"],
      stackSummary:
        "AssertionError [ERR_ASSERTION]: got 400 — createUser 合法输入返回了错误状态码"
    }
  };
}

/**
 * Phase 7 真实门禁的本机 SAG 来源链。只有严格开关开启时才向操作者配置的
 * 临时 Source 写入合成 ADR/Issue/PR；Repair Record 由最终人工批准后的
 * outbox 产生，不能提前伪造。
 */
async function attachPhase7SagSourceEvidence(
  root: ReturnType<typeof buildCompositionRoot>,
  taskId: string,
  projectId: string
): Promise<void> {
  if (!phase7RealConfiguration) return;
  const kinds: readonly KnowledgeDocumentKind[] = ["adr", "issue", "pull_request"];
  const sourceDocuments = kinds.map((kind) => {
    const id = `phase7-${taskId}-${kind}`;
    const title = `Phase 7 合成 ${kind} ${taskId}`;
    const text = `${title}：仅用于已授权的 TracePilot Resume Release 合成验证。`;
    return { id, kind, title, text, locator: `phase7/${taskId}/${kind}.md` };
  });
  for (const document of sourceDocuments) {
    const response = await root.app.inject({
      method: "POST",
      url: `/projects/${projectId}/sag-source-documents`,
      payload: { ...document, contentHash: hashSagSourceDocument(document.text) }
    });
    expect(response.statusCode, response.body).toBe(201);
  }

  const transport = new SagHttpTransport({
    baseUrl: phase7RealConfiguration.baseUrl,
    token: phase7RealConfiguration.token
  });
  const expectedIds = new Set(sourceDocuments.map((document) => document.id));
  let recalled: readonly { id: string }[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    recalled = await transport.searchSourceDocuments({
      projectId,
      knowledgeSourceId: phase7RealConfiguration.sourceId,
      query: `Phase 7 ${taskId}`,
      kinds,
      maxResults: 10
    });
    if (recalled.filter((document) => expectedIds.has(document.id)).length === sourceDocuments.length) break;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  expect(recalled.filter((document) => expectedIds.has(document.id))).toHaveLength(sourceDocuments.length);

  const evidence = await root.app.inject({
    method: "POST",
    url: `/tasks/${taskId}/sag-source-evidence`,
    payload: { query: `Phase 7 ${taskId}`, kinds, maxResults: 10 }
  });
  expect(evidence.statusCode, evidence.body).toBe(201);
  const body = evidence.json() as {
    documents: Array<{ id: string; projectId: string; locator: string }>;
    pack: { version: number };
  };
  expect(body.pack.version).toBe(2);
  expect(body.documents).toHaveLength(sourceDocuments.length);
  expect(body.documents.every((document) => document.projectId === projectId)).toBe(true);
  expect(body.documents.every((document) => !document.locator.includes(".."))).toBe(true);
}

/**
 * 真实 pytest/debugpy 暂停帧只能在已授权的 Python 任务 worktree 中采集。
 * 先经 EXECUTING → EVIDENCE_GAP → GATHERING_EVIDENCE 回环使旧执行审批失效，
 * 写入 runtime Evidence 后再以新 Pack 重新计划、重新审批，绝不复用旧授权。
 */
async function attachPhase7RuntimeEvidenceAndReapprove(
  root: ReturnType<typeof buildCompositionRoot>,
  taskId: string,
  worktreePath: string
): Promise<{ readonly packId: string; readonly packVersion: number }> {
  if (!phase7RealConfiguration) {
    throw new Error("Phase 7 真实 debugpy 证据仅允许在严格门禁中运行");
  }
  const port = await reserveLoopbackPort();
  const child = spawn(phase7RealConfiguration.pythonPath, [
    "-Xfrozen_modules=off",
    "-m", "debugpy",
    "--listen", `127.0.0.1:${port}`,
    "--wait-for-client",
    "-m", "pytest", "-q", "-s", "diagnostics/test_phase7_runtime.py"
  ], { cwd: worktreePath, stdio: "ignore", windowsHide: true });
  try {
    await waitForDebugpyStartup(child);
    const gap = await root.app.inject({
      method: "POST",
      url: `/tasks/${taskId}/transition`,
      payload: { to: "EVIDENCE_GAP", reason: "需要受控采集真实 pytest 暂停帧" }
    });
    expect(gap.statusCode, gap.body).toBe(200);
    const gathering = await root.app.inject({
      method: "POST",
      url: `/tasks/${taskId}/transition`,
      payload: { to: "GATHERING_EVIDENCE", reason: "采集运行时证据扩大计划输入", widenScope: true }
    });
    expect(gathering.statusCode, gathering.body).toBe(200);
    const runtimeEvidence = await root.app.inject({
      method: "POST",
      url: `/tasks/${taskId}/runtime-evidence/python`,
      payload: {
        pytestStackTrace: 'File "diagnostics/test_phase7_runtime.py", line 7, in test_phase7_runtime_evidence',
        dapPort: port
      }
    });
    expect(runtimeEvidence.statusCode, runtimeEvidence.body).toBe(201);
    const runtimeBody = runtimeEvidence.json() as {
      pack: { id: string; version: number; evidence: Array<{ source: string; summary: string }> };
    };
    expect(runtimeBody.pack.version).toBe(4);
    expect(runtimeBody.pack.evidence).toContainEqual(expect.objectContaining({
      source: "debugpy-dap-loopback",
      summary: expect.stringContaining("expected_status=201")
    }));

    const planned = await root.app.inject({
      method: "POST",
      url: `/tasks/${taskId}/transition`,
      payload: { to: "PLANNED" }
    });
    expect(planned.statusCode, planned.body).toBe(200);
    const plan = await root.app.inject({
      method: "POST",
      url: `/tasks/${taskId}/plan`,
      payload: {
        nodes: [{
          id: "phase7-runtime-node",
          label: "基于运行时证据重新计划受控修复",
          description: "保留既有文件范围，使用新版本 Evidence Pack",
          evidencePackId: runtimeBody.pack.id,
          evidencePackVersion: runtimeBody.pack.version
        }],
        allowedPaths: ["src/users.py"],
        inputEvidencePackId: runtimeBody.pack.id,
        inputEvidencePackVersion: runtimeBody.pack.version
      }
    });
    expect(plan.statusCode, plan.body).toBe(201);
    const awaiting = await root.app.inject({
      method: "POST",
      url: `/tasks/${taskId}/transition`,
      payload: { to: "AWAITING_EXECUTION_APPROVAL" }
    });
    expect(awaiting.statusCode, awaiting.body).toBe(200);
    const approval = await root.app.inject({
      method: "POST",
      url: `/tasks/${taskId}/approvals`,
      payload: {
        approver: "phase7-real-runtime-reapproval",
        decision: "approved",
        reason: "运行时证据追加后重新审批"
      }
    });
    expect(approval.statusCode, approval.body).toBe(201);
    const resumed = await root.app.inject({
      method: "POST",
      url: `/tasks/${taskId}/begin-execution`
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    return { packId: runtimeBody.pack.id, packVersion: runtimeBody.pack.version };
  } finally {
    if (!child.killed) child.kill();
  }
}

/** 最终人工批准后，强制处理 outbox 并确认本机 SAG 可回溯该 Repair Record。 */
async function assertPhase7ApprovedRecordMirrored(
  root: ReturnType<typeof buildCompositionRoot>,
  taskId: string,
  projectId: string
): Promise<void> {
  if (!phase7RealConfiguration) return;
  const challenge = await root.app.inject({
    method: "POST",
    url: `/tasks/${taskId}/human-approval/challenge`,
    headers: { "x-tracepilot-human-channel-secret": PHASE7_HUMAN_SECRET },
    payload: { decision: "approved" }
  });
  expect(challenge.statusCode, challenge.body).toBe(201);
  const decision = await root.app.inject({
    method: "POST",
    url: `/tasks/${taskId}/human-approval`,
    headers: { "x-tracepilot-human-channel-secret": PHASE7_HUMAN_SECRET },
    payload: {
      challengeToken: (challenge.json() as { challengeToken: string }).challengeToken,
      reason: "Phase 7 已授权合成 Resume Release 人工批准"
    }
  });
  expect(decision.statusCode, decision.body).toBe(200);
  expect((decision.json() as { task: { status: string } }).task.status).toBe("COMPLETED");

  const records = await root.store.unitOfWork.run((tx) => tx.repairRecords.findByTask(taskId));
  expect(records).toHaveLength(1);
  const record = records[0]!;
  expect(record.status).toBe("APPROVED");

  const transport = new SagHttpTransport({
    baseUrl: phase7RealConfiguration.baseUrl,
    token: phase7RealConfiguration.token
  });
  let outbox = root.store.sagOutbox.list().filter((event) => event.repair_record_id === record.id);
  expect(outbox).toHaveLength(1);
  if (outbox[0]!.status !== "SENT") {
    await root.store.sagOutbox.processReady(transport);
    outbox = root.store.sagOutbox.list().filter((event) => event.repair_record_id === record.id);
  }
  expect(outbox[0]!.status).toBe("SENT");

  let recalled: readonly { id: string; projectId: string; locator: string }[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    recalled = await transport.searchSourceDocuments({
      projectId,
      knowledgeSourceId: phase7RealConfiguration.sourceId,
      query: record.id,
      kinds: ["repair_record"],
      maxResults: 10
    });
    if (recalled.some((document) => document.id === record.id)) break;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  expect(recalled).toContainEqual(expect.objectContaining({
    id: record.id,
    projectId,
    locator: expect.stringContaining(`repair-record:${record.id}`)
  }));
}

describe.skipIf(!shouldRunPython)(
  "Phase 4 真实 omp 闭环（Python 失败任务）",
  () => {
    let dbPath: string;
    let tmpRoot: string;

    afterEach(() => {
      if (dbPath) safeCleanup(join(dbPath, ".."));
      if (tmpRoot) safeCleanup(tmpRoot);
    });

    it(
      "Python 失败任务：omp develop 修复 create_user 使测试通过",
      { timeout: 600000 },
      async () => {
        // 1. 准备临时环境
        dbPath = tempDbPath();
        tmpRoot = mkdtempSync(join(tmpdir(), "tracepilot-omp-python-"));
        const { repoPath, worktreeRoot } = createPythonFailingRepo(tmpRoot);

        // 2. 构建组合根 —— 不跳过 .env 加载，使用真实 OmpAdapter
        const root = buildCompositionRoot({
          dbPath,
          worktreeRoot,
          skipEnvFile: false,
          ...(phase7RealConfiguration
            ? {
              humanApprovalIdentity: "phase7-real-human",
              humanApprovalChannelSecret: PHASE7_HUMAN_SECRET
            }
            : {})
        });

        try {
          // 3. 登记项目
          await root.store.unitOfWork.run(async (tx) => {
            await tx.projects.save(pythonFailingProject(repoPath));
          });

          // 4. 创建任务
          const createRes = await root.app.inject({
            method: "POST",
            url: "/tasks",
            payload: {
              projectId: "proj-omp-python",
              input: pythonFailingTaskInput()
            }
          });
          expect(createRes.statusCode).toBe(201);
          const task = createRes.json() as { id: string };

          // 5. 合法时序：CREATED → INTAKING → GATHERING_EVIDENCE
          for (const to of ["INTAKING", "GATHERING_EVIDENCE"] as const) {
            const res = await root.app.inject({
              method: "POST",
              url: `/tasks/${task.id}/transition`,
              payload: { to }
            });
            expect(res.statusCode).toBe(200);
          }

          // 6. 收集证据生成 Pack v1
          const collectRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/collect-evidence`,
            payload: {}
          });
          expect(collectRes.statusCode).toBe(200);
          const collectBody = collectRes.json() as {
            pack: { id: string; version: number; evidence: Array<{ id: string }> } | null;
          };
          expect(collectBody.pack).not.toBeNull();
          const firstPack = collectBody.pack!;
          const evidenceId = firstPack.evidence[0]?.id;
          expect(evidenceId).toBeDefined();

          await attachPhase7SagSourceEvidence(root, task.id, "proj-omp-python");

          // 6b. 先经 Evidence Request 为 v1 的既有证据补充可追溯根因，
          // 生成不可变 v2。Reviewer 只能精确引用该 hypothesis，不能自行
          // 创造无来源结论。
          const requestRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/evidence-requests`,
            payload: {
              gapReason: "需要绑定 pytest 失败与 create_user 返回状态的根因",
              expectedPlanImpact: "为受控修复和独立审查提供可追溯根因"
            }
          });
          expect(requestRes.statusCode).toBe(201);
          const requestId = (requestRes.json() as { id: string }).id;
          const resolveRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/evidence-requests/${requestId}/resolve`,
            payload: {
              rootCause: {
                text: "合法用户输入被错误返回为 400，导致 create_user 成功路径测试失败",
                confidence: 0.9,
                evidenceIds: [evidenceId]
              },
              applicabilityConditions: [
                {
                  text: "不得修改 tests/ 目录下的测试文件",
                  evidenceIds: [evidenceId],
                  required: true
                },
                {
                  text: "不得修改 pytest.ini",
                  evidenceIds: [evidenceId],
                  required: true
                },
                {
                  text: "仅修改 src/users.py",
                  evidenceIds: [evidenceId],
                  required: true
                }
              ]
            }
          });
          expect(resolveRes.statusCode).toBe(201);
          const evolvedPack = resolveRes.json() as { id: string; version: number };
          expect(evolvedPack.version).toBe(phase7RealConfiguration ? 3 : 2);
          const packId = evolvedPack.id;
          const packVersion = evolvedPack.version;

          // 7. GATHERING_EVIDENCE → PLANNED
          const plannedRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/transition`,
            payload: { to: "PLANNED" }
          });
          expect(plannedRes.statusCode).toBe(200);

          // 8. 记录 Plan（allowedPaths 限定为 src/users.py）
          const planRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/plan`,
            payload: {
              nodes: [
                {
                  id: "node-1",
                  label: "修复 create_user 状态码",
                  description: "将合法输入的返回值从 400 改为 201",
                  evidencePackId: packId,
                  evidencePackVersion: packVersion
                }
              ],
              allowedPaths: ["src/users.py"],
              inputEvidencePackId: packId,
              inputEvidencePackVersion: packVersion
            }
          });
          expect(planRes.statusCode).toBe(201);

          // 9. PLANNED → AWAITING_EXECUTION_APPROVAL
          const awaitingRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/transition`,
            payload: { to: "AWAITING_EXECUTION_APPROVAL" }
          });
          expect(awaitingRes.statusCode).toBe(200);

          // 10. 记录执行审批
          const approvalRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/approvals`,
            payload: {
              approver: "integration-test",
              decision: "approved",
              reason: "Phase 4 真实闭环集成测试"
            }
          });
          expect(approvalRes.statusCode).toBe(201);

          // 11. 创建 worktree
          const worktreeRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/worktrees`
          });
          expect(worktreeRes.statusCode).toBe(201);
          const worktree = worktreeRes.json() as { path: string };

          // 11b. P1-04：先验证初始测试确实失败（修改前）
          //      omp 修复前，create_user 返回 400，pytest 必须失败。
          //      pytest 失败时退出码非 0，execFileSync 会抛错；从 error.stdout
          //      取输出断言失败信息存在。使用 tests/ 路径与 pytest.ini 的 testpaths 一致。
          let initialTestOutput = "";
          try {
            execFileSync(phase7RealConfiguration?.pythonPath ?? "python", ["-B", "-m", "pytest", "-p", "no:cacheprovider", "tests/", "--tb=short"], {
              cwd: worktree.path,
              encoding: "utf8",
              timeout: 30000,
              stdio: "pipe"
            });
          } catch (err) {
            initialTestOutput = ((err as Error & { stdout?: string }).stdout ?? "");
          }
          expect(initialTestOutput.toLowerCase()).toContain("fail");

          // 12. AWAITING_EXECUTION_APPROVAL → EXECUTING
          // P1-04：必须经 POST /tasks/:taskId/begin-execution 端点，
          //         由 orchestrator.beginExecutionIfApproved 在事务内校验
          //         有效执行审批与权威 scopeHash 一致（不信任调用方）。
          //         transitionTask 显式拒绝迁移到 EXECUTING（task-orchestrator.ts:155-160）。
          const beginExecRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/begin-execution`
          });
          expect(beginExecRes.statusCode).toBe(200);
          const executingTask = beginExecRes.json() as { status: string };
          expect(executingTask.status).toBe("EXECUTING");

          // 12b. P1-04：调用 omp analyze 阶段（EXECUTING 状态）
          //      analyze 的合法位置在 worktree 创建、Plan 持久化、执行审批
          //      通过之后（Phase 4 验收 §2.2），让 omp 基于已收集证据与
          //      worktree 内容做初步分析，事件经 RuntimeEventSink 落库。
          const analyzeRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/run`,
            payload: { phase: "analyze" }
          });
          expect(analyzeRes.statusCode).toBe(200);
          const analyzeBody = analyzeRes.json() as {
            runId: string;
            eventCount: number;
          };
          expect(analyzeBody.eventCount).toBeGreaterThan(0);

          // Phase 7：在真实 Omp 修改前读取真实 pytest/debugpy 暂停帧，并经
          // Evidence Gap 回环生成 Pack v4、重新计划和重新审批后才恢复执行。
          // JavaScript 场景不伪造 Python DAP；两个场景共同构成真实 Omp 门禁，
          // Python 场景额外承担运行时 Evidence 验证。
          if (phase7RealConfiguration) {
            const refreshed = await attachPhase7RuntimeEvidenceAndReapprove(root, task.id, worktree.path);
            expect(refreshed.packVersion).toBe(4);
          }

          // 13. 调用 omp develop 修复 bug
          const developRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/run`,
            payload: { phase: "develop" }
          });

          // 验证 develop 结果
          expect(developRes.statusCode, developRes.body).toBe(200);
          const developBody = developRes.json() as {
            runId: string;
            eventCount: number;
            summary?: string;
            diff: {
              changedFiles: readonly string[];
              patchPreview: string;
            };
            verificationExitCode: number;
            verificationPassed: boolean;
            verificationStdoutPreview: string;
            verificationStderrPreview: string;
          };

          // omp 应该修改了 src/users.py
          expect(developBody.diff.changedFiles.length).toBeGreaterThan(0);
          expect(
            developBody.diff.changedFiles.some((f) => f.includes("users.py"))
          ).toBe(true);

          // 验证测试通过（核心断言：失败测试已被修复）
          expect(developBody.verificationPassed).toBe(true);
          expect(developBody.verificationExitCode).toBe(0);

          // 14. EXECUTING → VALIDATING → REVIEWING
          const validatingRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/transition`,
            payload: { to: "VALIDATING" }
          });
          expect(validatingRes.statusCode).toBe(200);

          const reviewingRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/transition`,
            payload: { to: "REVIEWING" }
          });
          expect(reviewingRes.statusCode).toBe(200);

          // 15. 调用 omp review 独立审查
          // P1-03：Reviewer 输入必须来自受控来源（execution_results 表），
          //         不接受调用方提交的 diff 或 verificationResult。
          //         runReview 内部会从 execution_results 表读取受控 Diff/验证产物，
          //         并重新捕获工作树 Diff 校验哈希一致性。
          const reviewRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/run`,
            payload: { phase: "review" }
          });

          expect(reviewRes.statusCode, reviewRes.body).toBe(200);
          const reviewBody = reviewRes.json() as {
            verdict: string;
            findings: unknown[];
            summary: string;
            qualityGate?: { passed: boolean };
          };
          // review 应返回有效裁决（ship / ship_with_fixes / block）
          expect(["ship", "ship_with_fixes", "block"]).toContain(
            reviewBody.verdict
          );
          if (phase7RealConfiguration) {
            expect(reviewBody.qualityGate?.passed).toBe(true);
            await assertPhase7ApprovedRecordMirrored(root, task.id, "proj-omp-python");
          }
        } finally {
          await root.close();
        }
      }
    );
  }
);

describe.skipIf(!shouldRunJavascript)(
  "Phase 4 真实 omp 闭环（JavaScript 失败任务）",
  () => {
    let dbPath: string;
    let tmpRoot: string;

    afterEach(() => {
      if (dbPath) safeCleanup(join(dbPath, ".."));
      if (tmpRoot) safeCleanup(tmpRoot);
    });

    it(
      "JavaScript 失败任务：omp develop 修复 createUser 使测试通过",
      { timeout: 600000 },
      async () => {
        // 1. 准备临时环境
        dbPath = tempDbPath();
        tmpRoot = mkdtempSync(join(tmpdir(), "tracepilot-omp-js-"));
        const { repoPath, worktreeRoot } = createJavascriptFailingRepo(tmpRoot);

        // 2. 构建组合根 —— 不跳过 .env 加载，使用真实 OmpAdapter
        const root = buildCompositionRoot({
          dbPath,
          worktreeRoot,
          skipEnvFile: false,
          ...(phase7RealConfiguration
            ? {
              humanApprovalIdentity: "phase7-real-human",
              humanApprovalChannelSecret: PHASE7_HUMAN_SECRET
            }
            : {})
        });

        try {
          // 3. 登记项目
          await root.store.unitOfWork.run(async (tx) => {
            await tx.projects.save(javascriptFailingProject(repoPath));
          });

          // 4. 创建任务
          const createRes = await root.app.inject({
            method: "POST",
            url: "/tasks",
            payload: {
              projectId: "proj-omp-javascript",
              input: javascriptFailingTaskInput()
            }
          });
          expect(createRes.statusCode).toBe(201);
          const task = createRes.json() as { id: string };

          // 5. 合法时序：CREATED → INTAKING → GATHERING_EVIDENCE
          for (const to of ["INTAKING", "GATHERING_EVIDENCE"] as const) {
            const res = await root.app.inject({
              method: "POST",
              url: `/tasks/${task.id}/transition`,
              payload: { to }
            });
            expect(res.statusCode).toBe(200);
          }

          // 6. 收集证据生成 Pack v1
          const collectRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/collect-evidence`,
            payload: {}
          });
          expect(collectRes.statusCode).toBe(200);
          const collectBody = collectRes.json() as {
            pack: { id: string; version: number; evidence: Array<{ id: string }> } | null;
          };
          expect(collectBody.pack).not.toBeNull();
          const firstPack = collectBody.pack!;
          const evidenceId = firstPack.evidence[0]?.id;
          expect(evidenceId).toBeDefined();

          await attachPhase7SagSourceEvidence(root, task.id, "proj-omp-javascript");

          // 6b. 先经 Evidence Request 为 v1 的既有证据补充可追溯根因，
          // 生成不可变 v2。Reviewer 只能精确引用该 hypothesis，不能自行
          // 创造无来源结论。
          const requestRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/evidence-requests`,
            payload: {
              gapReason: "需要绑定 Vitest 失败与 createUser 返回状态的根因",
              expectedPlanImpact: "为受控修复和独立审查提供可追溯根因"
            }
          });
          expect(requestRes.statusCode).toBe(201);
          const requestId = (requestRes.json() as { id: string }).id;
          const resolveRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/evidence-requests/${requestId}/resolve`,
            payload: {
              rootCause: {
                text: "合法用户输入被错误返回为 400，导致 createUser 成功路径测试失败",
                confidence: 0.9,
                evidenceIds: [evidenceId]
              },
              applicabilityConditions: [
                {
                  text: "不得修改 tests/ 目录下的测试文件",
                  evidenceIds: [evidenceId],
                  required: true
                },
                {
                  text: "不得修改 package.json",
                  evidenceIds: [evidenceId],
                  required: true
                },
                {
                  text: "仅修改 src/users.js",
                  evidenceIds: [evidenceId],
                  required: true
                }
              ]
            }
          });
          expect(resolveRes.statusCode).toBe(201);
          const evolvedPack = resolveRes.json() as { id: string; version: number };
          expect(evolvedPack.version).toBe(phase7RealConfiguration ? 3 : 2);
          const packId = evolvedPack.id;
          const packVersion = evolvedPack.version;

          // 7. GATHERING_EVIDENCE → PLANNED
          const plannedRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/transition`,
            payload: { to: "PLANNED" }
          });
          expect(plannedRes.statusCode).toBe(200);

          // 8. 记录 Plan（allowedPaths 限定为 src/users.js）
          const planRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/plan`,
            payload: {
              nodes: [
                {
                  id: "node-1",
                  label: "修复 createUser 状态码",
                  description: "将合法输入的返回值从 400 改为 201",
                  evidencePackId: packId,
                  evidencePackVersion: packVersion
                }
              ],
              allowedPaths: ["src/users.js"],
              inputEvidencePackId: packId,
              inputEvidencePackVersion: packVersion
            }
          });
          expect(planRes.statusCode).toBe(201);

          // 9. PLANNED → AWAITING_EXECUTION_APPROVAL
          const awaitingRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/transition`,
            payload: { to: "AWAITING_EXECUTION_APPROVAL" }
          });
          expect(awaitingRes.statusCode).toBe(200);

          // 10. 记录执行审批
          const approvalRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/approvals`,
            payload: {
              approver: "integration-test",
              decision: "approved",
              reason: "Phase 4 真实闭环集成测试（JavaScript）"
            }
          });
          expect(approvalRes.statusCode).toBe(201);

          // 11. 创建 worktree
          const worktreeRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/worktrees`
          });
          expect(worktreeRes.statusCode).toBe(201);
          const worktree = worktreeRes.json() as { path: string };

          // 11b. P1-04：先验证初始测试确实失败（修改前）
          //      omp 修复前，createUser 返回 400，node --test 必须失败。
          //      node --test 失败时退出码非 0，execFileSync 会抛错；
          //      从 error.stdout 取输出断言失败信息存在。
          let initialTestOutput = "";
          try {
            execFileSync("node", ["--test", "tests/users.test.js"], {
              cwd: worktree.path,
              encoding: "utf8",
              timeout: 30000,
              stdio: "pipe"
            });
          } catch (err) {
            initialTestOutput = ((err as Error & { stdout?: string }).stdout ?? "");
          }
          expect(initialTestOutput.toLowerCase()).toContain("fail");

          // 12. AWAITING_EXECUTION_APPROVAL → EXECUTING
          // P1-04：必须经 POST /tasks/:taskId/begin-execution 端点，
          //         由 orchestrator.beginExecutionIfApproved 在事务内校验
          //         有效执行审批与权威 scopeHash 一致（不信任调用方）。
          const beginExecRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/begin-execution`
          });
          expect(beginExecRes.statusCode).toBe(200);
          const executingTask = beginExecRes.json() as { status: string };
          expect(executingTask.status).toBe("EXECUTING");

          // 12b. P1-04：调用 omp analyze 阶段（EXECUTING 状态）
          //      analyze 的合法位置在 worktree 创建、Plan 持久化、执行审批
          //      通过之后（Phase 4 验收 §2.2），让 omp 基于已收集证据与
          //      worktree 内容做初步分析，事件经 RuntimeEventSink 落库。
          const analyzeRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/run`,
            payload: { phase: "analyze" }
          });
          expect(analyzeRes.statusCode).toBe(200);
          const analyzeBody = analyzeRes.json() as {
            runId: string;
            eventCount: number;
          };
          expect(analyzeBody.eventCount).toBeGreaterThan(0);

          // 13. 调用 omp develop 修复 bug
          const developRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/run`,
            payload: { phase: "develop" }
          });

          // 验证 develop 结果
          expect(developRes.statusCode, developRes.body).toBe(200);
          const developBody = developRes.json() as {
            runId: string;
            eventCount: number;
            summary?: string;
            diff: {
              changedFiles: readonly string[];
              patchPreview: string;
            };
            verificationExitCode: number;
            verificationPassed: boolean;
            verificationStdoutPreview: string;
            verificationStderrPreview: string;
          };

          // omp 应该修改了 src/users.js
          expect(developBody.diff.changedFiles.length).toBeGreaterThan(0);
          expect(
            developBody.diff.changedFiles.some((f) => f.includes("users.js"))
          ).toBe(true);

          // 验证测试通过（核心断言：失败测试已被修复）
          expect(developBody.verificationPassed).toBe(true);
          expect(developBody.verificationExitCode).toBe(0);

          // 14. EXECUTING → VALIDATING → REVIEWING
          const validatingRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/transition`,
            payload: { to: "VALIDATING" }
          });
          expect(validatingRes.statusCode).toBe(200);

          const reviewingRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/transition`,
            payload: { to: "REVIEWING" }
          });
          expect(reviewingRes.statusCode).toBe(200);

          // 15. 调用 omp review 独立审查
          // P1-03：Reviewer 输入必须来自受控来源（execution_results 表），
          //         不接受调用方提交的 diff 或 verificationResult。
          const reviewRes = await root.app.inject({
            method: "POST",
            url: `/tasks/${task.id}/run`,
            payload: { phase: "review" }
          });

          expect(reviewRes.statusCode, reviewRes.body).toBe(200);
          const reviewBody = reviewRes.json() as {
            verdict: string;
            findings: unknown[];
            summary: string;
            qualityGate?: { passed: boolean };
          };
          // review 应返回有效裁决（ship / ship_with_fixes / block）
          expect(["ship", "ship_with_fixes", "block"]).toContain(
            reviewBody.verdict
          );
          if (phase7RealConfiguration) {
            expect(reviewBody.qualityGate?.passed).toBe(true);
            await assertPhase7ApprovedRecordMirrored(root, task.id, "proj-omp-javascript");
          }
        } finally {
          await root.close();
        }
      }
    );
  }
);

describe.skipIf(shouldRunPython || shouldRunJavascript)(
  "Phase 4 真实 omp 闭环（跳过：前置条件不满足）",
  () => {
    it("应跳过 —— 受控 Omp 路径或 profile 前置条件不满足", () => {
      // 此测试组仅在前置条件不满足时运行，确认测试被正确跳过而非失败
      expect(shouldRunPython || shouldRunJavascript).toBe(false);
    });
  }
);
