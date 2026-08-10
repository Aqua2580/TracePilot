/**
 * Phase 5 真实 Omp Reviewer 受控闭环门禁 —— P1-07。
 *
 * 普通 `pnpm test` 永远跳过。只有用户明确同意合成材料外发和模型费用，并设置：
 *
 *   TRACEPILOT_PHASE5_REAL_ACK=1 pnpm test:phase5-real
 *
 * 才会运行两个场景。每个场景都使用真实临时 Git 仓库与外置 worktree，执行真实
 * 项目测试命令，将最终 Diff 与验证结果写入 SQLite，再通过 API `/run` 调用真实
 * Omp Reviewer 和 Core 确定性质量门。测试不直接构造 ReviewResult。
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type {
  EvidenceConstraint,
  EvidenceItem,
  ExecutionResult,
  Hypothesis,
  Project,
  RuntimeAdapter,
  TaskInput
} from "@tracepilot/core";
import { FakeRuntimeAdapter, LocalProcessRunner } from "@tracepilot/adapters";
import { buildCompositionRoot, type CompositionRoot } from "../src/composition-root.js";

type Scenario = "compatibility" | "regression_test";

const HUMAN_SECRET = "phase5-real-human-channel-secret-32chars";

function loadEnvFile(): void {
  try {
    const testsDirectory = fileURLToPath(new URL(".", import.meta.url));
    const projectRoot = join(testsDirectory, "..", "..", "..");
    process.loadEnvFile?.(join(projectRoot, ".env"));
  } catch {
    // .env 不存在时由严格前置条件统一报错。
  }
}

const strictMode = process.env.TRACEPILOT_PHASE5_REAL_STRICT === "1";
if (strictMode && process.env.TRACEPILOT_PHASE5_REAL_ACK !== "1") {
  throw new Error(
    "Phase 5 真实 Reviewer 测试需要显式授权：请设置 TRACEPILOT_PHASE5_REAL_ACK=1 后重试。"
  );
}

if (strictMode) {
  loadEnvFile();
  const ompPath = process.env.TRACEPILOT_OMP_PATH ?? "";
  if (!ompPath || !existsSync(ompPath)) {
    throw new Error("Phase 5 真实 Reviewer 测试缺少可执行的 TRACEPILOT_OMP_PATH。");
  }
  if (!(process.env.DEEPSEEK_API_KEY ?? "")) {
    throw new Error("Phase 5 真实 Reviewer 测试缺少 DEEPSEEK_API_KEY。");
  }
}

const shouldRun = strictMode;
const temporaryRoots: string[] = [];

function taskInputFor(scenario: Scenario): TaskInput {
  if (scenario === "compatibility") {
    return {
      objective: "把 createUser 的成功状态改为 201，同时保持 v1 客户端依赖的 user.id 返回字段。",
      constraints: ["不得删除 v1 返回字段", "只修改 src/users.js"],
      acceptanceCriteria: [
        "合法请求返回 status=201",
        "旧版客户端仍能读取 response.user.id",
        "node --test 通过"
      ],
      riskLevel: "medium",
      rawSource: "失败测试显示合法请求返回 status=400。",
      origin: "failed_test_log",
      failure: {
        testNames: ["tests/users.test.js::合法请求返回 201"],
        errorTypes: ["AssertionError"],
        stackSummary: "Expected 201, received 400"
      }
    };
  }

  return {
    objective: "修复 parse 对 null 输入的处理，使其返回空数组。",
    constraints: ["只修改 src/parser.js", "必须新增覆盖 null 输入的回归测试"],
    acceptanceCriteria: [
      "parse(null) 返回 []",
      "既有 node --test 全部通过",
      "新增 null 输入回归测试"
    ],
    riskLevel: "low",
    rawSource: "线上失败显示 parse(null) 抛出 TypeError。",
    origin: "failed_test_log",
    failure: {
      testNames: ["外部回归场景::null input"],
      errorTypes: ["TypeError"],
      stackSummary: "TypeError: Cannot read properties of null (reading 'split')"
    }
  };
}

function evidenceFor(scenario: Scenario): {
  readonly evidence: readonly EvidenceItem[];
  readonly hypotheses: readonly Hypothesis[];
  readonly constraints: readonly EvidenceConstraint[];
} {
  if (scenario === "compatibility") {
    const evidenceId = "e-compatibility-contract";
    return {
      evidence: [
        {
          id: evidenceId,
          kind: "code",
          source: "clients/v1-client.js",
          locator: "clients/v1-client.js:2",
          capturedAt: "2026-08-03T00:00:00.000Z",
          contentHash: "fnv1a32-v1-response-contract",
          summary: "仓库内现有 v1 客户端直接读取 createUser(id).user.id。",
          relevance: 1,
          trustLevel: "PRIMARY"
        }
      ],
      hypotheses: [
        {
          text: "createUser 的占位实现返回了错误的 400 状态",
          confidence: 0.98,
          evidenceIds: [evidenceId]
        }
      ],
      constraints: [
        {
          text: "修复状态码时必须保留 response.user.id 兼容契约",
          evidenceIds: [evidenceId],
          required: true
        }
      ]
    };
  }

  const evidenceId = "e-regression-inventory";
  return {
    evidence: [
      {
        id: evidenceId,
        kind: "runtime",
        source: "test-inventory",
        locator: "tests/parser.test.js",
        capturedAt: "2026-08-03T00:00:00.000Z",
        contentHash: "fnv1a32-existing-tests-only",
        summary: "现有测试只覆盖普通字符串；任务要求新增 null 输入回归测试。",
        relevance: 1,
        trustLevel: "PRIMARY"
      }
    ],
    hypotheses: [
      {
        text: "parse 未在调用 split 前处理 null 输入",
        confidence: 0.99,
        evidenceIds: [evidenceId]
      }
    ],
    constraints: [
      {
        text: "修复必须新增 null 输入的自动化回归测试",
        evidenceIds: [evidenceId],
        required: true
      }
    ]
  };
}

function initializeRepository(root: string, scenario: Scenario): string {
  const repositoryPath = join(root, "repository");
  mkdirSync(join(repositoryPath, "src"), { recursive: true });
  mkdirSync(join(repositoryPath, "tests"), { recursive: true });
  writeFileSync(
    join(repositoryPath, "package.json"),
    `${JSON.stringify({ name: `phase5-${scenario}`, private: true, type: "module" }, null, 2)}\n`,
    "utf8"
  );

  if (scenario === "compatibility") {
    mkdirSync(join(repositoryPath, "clients"), { recursive: true });
    writeFileSync(
      join(repositoryPath, "src", "users.js"),
      "export function createUser(id) {\n  return { status: 400, user: { id } };\n}\n",
      "utf8"
    );
    writeFileSync(
      join(repositoryPath, "clients", "v1-client.js"),
      "export function readUserId(result) {\n  return result.user.id;\n}\n",
      "utf8"
    );
    writeFileSync(
      join(repositoryPath, "tests", "users.test.js"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { createUser } from "../src/users.js";',
        "",
        'test("合法请求返回 201", () => {',
        '  assert.equal(createUser("user-1").status, 201);',
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
  } else {
    writeFileSync(
      join(repositoryPath, "src", "parser.js"),
      "export function parse(value) {\n  return value.split(',').map((item) => item.trim());\n}\n",
      "utf8"
    );
    writeFileSync(
      join(repositoryPath, "tests", "parser.test.js"),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { parse } from "../src/parser.js";',
        "",
        'test("解析普通逗号字符串", () => {',
        '  assert.deepEqual(parse("a, b"), ["a", "b"]);',
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
  }

  execFileSync("git", ["init", "-b", "main"], {
    cwd: repositoryPath,
    stdio: "ignore"
  });
  execFileSync("git", ["add", "."], { cwd: repositoryPath, stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=TracePilot Test",
      "-c",
      "user.email=tracepilot@example.invalid",
      "commit",
      "-m",
      "initial"
    ],
    { cwd: repositoryPath, stdio: "ignore" }
  );
  return repositoryPath;
}

function applyCandidatePatch(worktreePath: string, scenario: Scenario): void {
  if (scenario === "compatibility") {
    // 测试绿灯，但故意删除 v1 客户端依赖的 user.id。
    writeFileSync(
      join(worktreePath, "src", "users.js"),
      "export function createUser(_id) {\n  return { status: 201 };\n}\n",
      "utf8"
    );
    return;
  }

  // 修复 null，但故意不增加任务要求的回归测试。
  writeFileSync(
    join(worktreePath, "src", "parser.js"),
    "export function parse(value) {\n  return value === null ? [] : value.split(',').map((item) => item.trim());\n}\n",
    "utf8"
  );
}

async function prepareControlledReview(
  scenario: Scenario,
  runtimeOverride?: RuntimeAdapter
): Promise<{
  readonly root: CompositionRoot;
  readonly taskId: string;
}> {
  const temporaryRoot = mkdtempSync(join(tmpdir(), `tracepilot-phase5-${scenario}-`));
  temporaryRoots.push(temporaryRoot);
  const repositoryPath = initializeRepository(temporaryRoot, scenario);
  const worktreeRoot = join(temporaryRoot, "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const dbPath = join(temporaryRoot, "tracepilot.db");
  const root = buildCompositionRoot({
    dbPath,
    worktreeRoot,
    skipEnvFile: true,
    humanApprovalIdentity: "phase5-independent-human",
    humanApprovalChannelSecret: HUMAN_SECRET,
    ...(runtimeOverride ? { runtimeOverride } : {})
  });

  const project: Project = {
    id: `project-phase5-${scenario}`,
    name: `Phase 5 ${scenario} 合成项目`,
    repositoryPath,
    defaultBranch: "main",
    language: "typescript",
    commands: {
      test: { argv: [process.execPath, "--test"], timeoutMs: 60000 }
    },
    createdAt: "2026-08-03T00:00:00.000Z"
  };
  await root.store.unitOfWork.run((tx) => tx.projects.save(project));

  const taskInput = taskInputFor(scenario);
  const task = await root.orchestrator.createTask({
    projectId: project.id,
    input: taskInput
  });
  await root.orchestrator.transitionTask(task.id, "INTAKING");
  await root.orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE");
  const evidence = evidenceFor(scenario);
  const pack = await root.orchestrator.gatherEvidenceAndCreatePack({
    taskId: task.id,
    packId: `pack-${task.id}`,
    evidence: evidence.evidence,
    hypotheses: evidence.hypotheses,
    constraints: evidence.constraints,
    acceptanceCriteria: taskInput.acceptanceCriteria
  });
  await root.orchestrator.transitionTask(task.id, "PLANNED");
  await root.orchestrator.planTask({
    taskId: task.id,
    nodes: [
      {
        id: `node-${scenario}`,
        label: "应用候选修复",
        description: "由验收夹具提供存在明确审查问题的候选 Diff",
        evidencePackId: pack.id,
        evidencePackVersion: pack.version
      }
    ],
    allowedPaths: ["src/**", "tests/**"],
    inputEvidencePackId: pack.id,
    inputEvidencePackVersion: pack.version
  });
  await root.orchestrator.transitionTask(task.id, "AWAITING_EXECUTION_APPROVAL");
  const scopeHash = await root.orchestrator.computeCurrentScopeHash(task.id);
  await root.orchestrator.recordApproval({
    taskId: task.id,
    kind: "execution",
    approver: "phase5-test-executor",
    decision: "approved",
    scopeHash
  });

  const services = root.createServicesForProject(project);
  const worktree = await services.worktreeManager.createAndAttachWorktree({
    taskId: task.id,
    input: {
      projectId: project.id,
      repositoryPath,
      defaultBranch: project.defaultBranch,
      taskId: task.id,
      allowedPaths: []
    }
  });
  await root.orchestrator.beginExecutionIfApproved(task.id);
  applyCandidatePatch(worktree.path, scenario);

  const diff = await services.worktreeManager.captureDiffForTask({
    taskId: task.id,
    worktreeId: worktree.id,
    reason: "Phase 5 真实 Reviewer 捕获实际候选 Diff"
  });
  expect(diff.changedFiles).toEqual([
    scenario === "compatibility" ? "src/users.js" : "src/parser.js"
  ]);

  const verification = await new LocalProcessRunner().run(
    project.commands.test,
    worktree.path,
    {
      timeoutMs: project.commands.test.timeoutMs,
      maxOutputBytes: 256 * 1024,
      allowedCwdRoots: [worktreeRoot],
      inheritEnv: false,
      allowedEnvVarNames: ["PATH", "SYSTEMROOT", "PATHEXT", "TEMP", "TMP"],
      disallowCredentialVars: true
    }
  );
  expect(verification.exitCode).toBe(0);
  expect(verification.timedOut).toBe(false);

  const executionResult: ExecutionResult = {
    id: `execution-${task.id}`,
    taskId: task.id,
    runId: `fixture-${task.id}`,
    diffHash: diff.hash,
    diffPatch: diff.patch,
    diffChangedFiles: diff.changedFiles,
    diffBytes: diff.bytes,
    verificationExitCode: verification.exitCode,
    verificationPassed: verification.exitCode === 0,
    verificationStdout: verification.stdout,
    verificationStderr: verification.stderr,
    createdAt: verification.endedAt
  };
  await root.store.unitOfWork.run((tx) =>
    tx.executionResults.save(executionResult)
  );
  await root.orchestrator.transitionTask(task.id, "VALIDATING");
  await root.orchestrator.transitionTask(task.id, "REVIEWING");
  return { root, taskId: task.id };
}

function cleanupTemporaryRoots(): void {
  for (const root of temporaryRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 偶发文件句柄延迟释放不改变模型断言。
    }
  }
}

function sanitizeReviewerDiagnosticText(value: unknown): string {
  if (typeof value !== "string") return "<非字符串>";
  const sanitized = value
    .replace(/(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=<已脱敏>")
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gi, "<凭据>")
    .replace(/\b(?:sha256|fnv1a32)-[A-Za-z0-9_-]+\b/gi, "<哈希>")
    .replace(/\b[A-Za-z]:[\\/][^\s"']+/g, "<路径>")
    .replace(/\/[^\s"']+/g, "<路径>")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 240);
  return sanitized || "<空>";
}

function printSanitizedReviewDiagnostics(body: {
  readonly verdict?: unknown;
  readonly summary?: unknown;
  readonly findings?: unknown;
}): void {
  const findings = Array.isArray(body.findings) ? body.findings : [];
  const normalizedFindings = findings.map((finding) => {
    const item = finding && typeof finding === "object"
      ? finding as { category?: unknown; message?: unknown }
      : {};
    return {
      category: typeof item.category === "string" ? item.category : "<缺失>",
      message: sanitizeReviewerDiagnosticText(item.message)
    };
  });
  const fallbackReasons = normalizedFindings
    .filter((finding) => finding.category === "other")
    .map((finding) => finding.message);
  if (typeof body.summary === "string" && body.summary.includes("回退")) {
    fallbackReasons.push(sanitizeReviewerDiagnosticText(body.summary));
  }
  console.error(
    "[phase5-real-reviewer] 真实 Review 失败脱敏诊断",
    JSON.stringify({
      verdict: typeof body.verdict === "string" ? body.verdict : "<缺失>",
      findingCategories: normalizedFindings.map((finding) => finding.category),
      findingMessages: normalizedFindings.map((finding) => finding.message),
      fallbackReasons
    })
  );
}

async function assertReviewBlocked(
  root: CompositionRoot,
  taskId: string,
  expectedCategory: Scenario
): Promise<void> {
  const response = await root.app.inject({
    method: "POST",
    url: `/tasks/${taskId}/run`,
    payload: { phase: "review" }
  });
  const body = response.json() as {
    verdict?: unknown;
    summary?: unknown;
    findings: Array<{ category: string }>;
    qualityGate: { passed: boolean };
    repairRecord: { status: string };
    task: { status: string };
  };
  try {
    expect(response.statusCode).toBe(422);
    expect(
      body.findings.some((finding) => finding.category === expectedCategory)
    ).toBe(true);
    expect(body.qualityGate.passed).toBe(false);
    expect(body.task.status).toBe("FAILED");
    expect(body.repairRecord.status).toBe("DRAFT");

    const persistedTask = await root.store.unitOfWork.run((tx) =>
      tx.tasks.findById(taskId)
    );
    const records = await root.store.unitOfWork.run((tx) =>
      tx.repairRecords.findByTask(taskId)
    );
    expect(persistedTask?.status).toBe("FAILED");
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("DRAFT");

    const challenge = await root.app.inject({
      method: "POST",
      url: `/tasks/${taskId}/human-approval/challenge`,
      headers: { "x-tracepilot-human-channel-secret": HUMAN_SECRET },
      payload: { decision: "approved" }
    });
    expect(challenge.statusCode).toBe(409);
  } catch (error) {
    printSanitizedReviewDiagnostics(body);
    throw error;
  }
}

describe("Phase 5 Reviewer 受控闭环本地夹具", () => {
  afterEach(cleanupTemporaryRoots);

  it.each(["compatibility", "regression_test"] as const)(
    "%s 场景实际经过 Git、验证、SQLite、API 和质量门",
    { timeout: 60000 },
    async (scenario) => {
      const runtime = new FakeRuntimeAdapter({
        reviewVerdict: "ship",
        reviewFindings: [
          {
            priority: "P2",
            confidence: 0.99,
            category: scenario,
            message: scenario === "compatibility"
              ? "候选 Diff 删除既有 user.id 返回契约"
              : "候选 Diff 没有新增 null 输入回归测试"
          }
        ]
      });
      const { root, taskId } = await prepareControlledReview(scenario, runtime);
      try {
        await assertReviewBlocked(root, taskId, scenario);
      } finally {
        await root.close();
      }
    }
  );
});

describe.skipIf(!shouldRun)("Phase 5 真实 Omp Reviewer 受控闭环", () => {
  afterEach(cleanupTemporaryRoots);

  it.each([
    ["compatibility", "compatibility"],
    ["regression_test", "regression_test"]
  ] as const)(
    "%s 场景经真实 Review 后被质量门阻断并收口为 DRAFT",
    { timeout: 660000 },
    async (scenario, expectedCategory) => {
      const { root, taskId } = await prepareControlledReview(scenario);
      try {
        await assertReviewBlocked(root, taskId, expectedCategory);
      } finally {
        await root.close();
      }
    }
  );
});
