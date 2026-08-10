import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { buildCompositionRoot } from "../src/composition-root.js";
import type { ExecutionResult, Project, TaskInput, Worktree } from "@tracepilot/core";

const HUMAN_SECRET = "phase5-api-human-approval-secret-32chars";
const ROOT_EVIDENCE_ID = "evidence-api-compat";
const ROOT_CAUSE = {
  text: "新实现没有保留旧版字段",
  confidence: 0.94,
  evidenceIds: [ROOT_EVIDENCE_ID]
} as const;
const APPLICABILITY = {
  text: "旧版客户端仍在使用",
  evidenceIds: [ROOT_EVIDENCE_ID],
  required: true
} as const;

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-phase5-api-"));
  return join(dir, "phase5.db");
}

function safeCleanup(dbPath: string): void {
  try {
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  } catch {
    // Windows 文件锁残留不影响测试结论。
  }
}

function safeCleanupDirectory(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Windows 文件锁残留不影响测试结论。
  }
}

const project: Project = {
  id: "proj-phase5-api",
  name: "Phase 5 API 测试项目",
  repositoryPath: "D:/fake-phase5-repo",
  defaultBranch: "main",
  language: "python",
  commands: { test: { argv: ["pytest"], timeoutMs: 30000 } },
  createdAt: "2026-08-03T00:00:00.000Z"
};

const taskInput: TaskInput = {
  objective: "修复兼容性问题",
  constraints: ["保留旧版返回结构"],
  acceptanceCriteria: ["pytest 通过"],
  riskLevel: "low",
  rawSource: "FAILED compatibility test",
  origin: "failed_test_log",
  failure: {
    testNames: ["tests/test_compat.py::test_legacy_shape"],
    errorTypes: ["AssertionError"],
    stackSummary: "旧版客户端无法读取返回字段"
  }
};

describe("Phase 5 Review 与 Repair Memory API", () => {
  const dbPaths: string[] = [];
  const worktreeRoots: string[] = [];

  afterEach(() => {
    for (const dbPath of dbPaths.splice(0)) safeCleanup(dbPath);
    for (const worktreeRoot of worktreeRoots.splice(0)) safeCleanupDirectory(worktreeRoot);
  });

  async function prepareAwaitingHumanApproval(options?: {
    readonly approvalFinalizationHookFactory?: (
      repositoryPath: string
    ) => (input: { readonly taskId: string; readonly diffHash: string }) => Promise<void>;
  }) {
    const dbPath = tempDbPath();
    dbPaths.push(dbPath);
    const worktreeRoot = mkdtempSync(join(tmpdir(), "tracepilot-phase5-worktree-"));
    worktreeRoots.push(worktreeRoot);
    const repositoryPath = join(worktreeRoot, "repo");
    mkdirSync(join(repositoryPath, "src"), { recursive: true });
    mkdirSync(join(repositoryPath, "tests"), { recursive: true });
    writeFileSync(join(repositoryPath, "src", "compat.py"), "return {'legacy': True}\n", "utf8");
    writeFileSync(join(repositoryPath, "tests", "test_compat.py"), "def test_legacy_shape(): pass\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=TracePilot Test", "-c", "user.email=tracepilot@example.invalid", "commit", "-m", "initial"],
      { cwd: repositoryPath, stdio: "ignore" }
    );
    writeFileSync(join(repositoryPath, "src", "compat.py"), "return {'legacy': True, 'new': True}\n", "utf8");

    const root = buildCompositionRoot({
      dbPath,
      worktreeRoot,
      skipEnvFile: true,
      humanApprovalIdentity: "product-owner",
      humanApprovalChannelSecret: HUMAN_SECRET,
      approvalFinalizationHook:
        options?.approvalFinalizationHookFactory?.(repositoryPath)
    });
    await root.store.unitOfWork.run(async (tx) => tx.projects.save({ ...project, repositoryPath }));

    const task = await root.orchestrator.createTask({
      projectId: project.id,
      input: taskInput
    });
    await root.orchestrator.transitionTask(task.id, "INTAKING");
    await root.orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE");
    const pack = await root.orchestrator.gatherEvidenceAndCreatePack({
      taskId: task.id,
      packId: `pack-${task.id}`,
      evidence: [{
        id: ROOT_EVIDENCE_ID,
        kind: "runtime",
        source: "pytest",
        locator: "tests/test_compat.py::test_legacy_shape",
        capturedAt: "2026-08-03T00:00:00.000Z",
        contentHash: "sha256-api-compat",
        summary: "旧版客户端无法读取返回字段",
        relevance: 1,
        trustLevel: "PRIMARY"
      }],
      hypotheses: [ROOT_CAUSE],
      constraints: [APPLICABILITY],
      acceptanceCriteria: taskInput.acceptanceCriteria
    });
    await root.orchestrator.transitionTask(task.id, "PLANNED");
    await root.orchestrator.planTask({
      taskId: task.id,
      nodes: [{
        id: "node-1",
        label: "修复兼容性问题",
        description: "补充旧版返回结构",
        evidencePackId: pack.id,
        evidencePackVersion: pack.version
      }],
      allowedPaths: ["src/**", "tests/**"],
      inputEvidencePackId: pack.id,
      inputEvidencePackVersion: pack.version
    });
    const worktree: Worktree = {
      id: `wt-${task.id}`,
      projectId: project.id,
      taskId: task.id,
      path: repositoryPath,
      branch: `tracepilot/${task.id}`,
      baseCommitSha: "initial",
      allowedPaths: ["src/**", "tests/**"],
      createdAt: "2026-08-03T00:00:00.000Z"
    };
    await root.orchestrator.attachWorktree(task.id, worktree);
    await root.orchestrator.transitionTask(task.id, "AWAITING_EXECUTION_APPROVAL");
    const scopeHash = await root.orchestrator.computeCurrentScopeHash(task.id);
    await root.orchestrator.recordApproval({
      taskId: task.id,
      kind: "execution",
      approver: "executor",
      decision: "approved",
      scopeHash
    });
    await root.orchestrator.beginExecutionIfApproved(task.id);
    await root.orchestrator.transitionTask(task.id, "VALIDATING");
    await root.orchestrator.transitionTask(task.id, "REVIEWING");

    const services = root.createServicesForProject({ ...project, repositoryPath });
    const currentDiff = await services.worktreeManager.captureDiffForTask({
      taskId: task.id,
      worktreeId: worktree.id,
      reason: "Phase 5 测试准备受控 Review Diff"
    });
    const execution: ExecutionResult = {
      id: `exec-${task.id}`,
      taskId: task.id,
      runId: `run-${task.id}`,
      diffHash: currentDiff.hash,
      diffPatch: currentDiff.patch,
      diffChangedFiles: currentDiff.changedFiles,
      diffBytes: currentDiff.bytes,
      verificationExitCode: 0,
      verificationPassed: true,
      verificationStdout: "1 passed",
      verificationStderr: "",
      createdAt: "2026-08-03T00:00:01.000Z"
    };
    await root.store.unitOfWork.run(async (tx) => tx.executionResults.save(execution));

    const gated = await root.orchestrator.recordReviewAndGate({
      taskId: task.id,
      review: {
        verdict: "ship",
        findings: [],
        summary: "兼容性回归已覆盖",
        rootCause: ROOT_CAUSE,
        fixSummary: "恢复旧版字段并添加回归测试",
        applicabilityConditions: [APPLICABILITY]
      }
    });
    expect(gated.task.status).toBe("AWAITING_HUMAN_APPROVAL");
    return { root, taskId: task.id, repositoryPath };
  }

  it("人类批准 API 会同时完成任务并批准 Repair Record", async () => {
    const { root, taskId } = await prepareAwaitingHumanApproval();
    try {
      const forgedIdentityResponse = await root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/human-approval/challenge`,
        headers: { "x-tracepilot-human-channel-secret": HUMAN_SECRET },
        payload: { decision: "approved", approver: "伪造身份" }
      });
      expect(forgedIdentityResponse.statusCode).toBe(400);

      const response = await root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/human-approval/challenge`,
        headers: { "x-tracepilot-human-channel-secret": HUMAN_SECRET },
        payload: { decision: "approved" }
      });
      expect(response.statusCode).toBe(201);
      const challenge = response.json() as { challengeToken: string };
      const approvalResponse = await root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/human-approval`,
        headers: { "x-tracepilot-human-channel-secret": HUMAN_SECRET },
        payload: {
          challengeToken: challenge.challengeToken,
          reason: "已核对兼容性回归"
        }
      });

      expect(approvalResponse.statusCode).toBe(200);
      const body = approvalResponse.json() as {
        task: { status: string };
        repairRecord: { status: string; inputEvidencePackId: string };
      };
      expect(body.task.status).toBe("COMPLETED");
      expect(body.repairRecord.status).toBe("APPROVED");
      expect(body.repairRecord.inputEvidencePackId).toBe(`pack-${taskId}`);
    } finally {
      await root.close();
    }
  });

  it("公开 transition 端点不能直接完成或拒绝等待人工审批的任务", async () => {
    const { root, taskId } = await prepareAwaitingHumanApproval();
    try {
      for (const to of ["COMPLETED", "REJECTED"] as const) {
        const response = await root.app.inject({
          method: "POST",
          url: `/tasks/${taskId}/transition`,
          payload: { to }
        });
        expect(response.statusCode).toBe(403);
      }
      const task = await root.store.unitOfWork.run((tx) => tx.tasks.findById(taskId));
      const approvals = await root.store.unitOfWork.run((tx) => tx.approvals.findByTask(taskId));
      const records = await root.store.unitOfWork.run((tx) => tx.repairRecords.findByTask(taskId));
      expect(task?.status).toBe("AWAITING_HUMAN_APPROVAL");
      expect(approvals.filter((approval) => approval.kind === "human")).toHaveLength(0);
      expect(records[0]?.status).toBe("VERIFIED");
    } finally {
      await root.close();
    }
  });

  it("项目 Repair Memory 召回默认只返回 APPROVED，并保留来源链", async () => {
    const { root, taskId } = await prepareAwaitingHumanApproval();
    try {
      const challenge = await root.orchestrator.issueHumanApprovalChallenge({
        taskId,
        decision: "approved",
        channelSecret: HUMAN_SECRET
      });
      await root.orchestrator.recordHumanDecision({
        taskId,
        challengeToken: challenge.challengeToken,
        channelSecret: HUMAN_SECRET,
        reason: "批准写入项目记忆"
      });

      const response = await root.app.inject({
        method: "GET",
        url: `/projects/${project.id}/repair-memory?symptom=${encodeURIComponent("旧版客户端")}`
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        source: string;
        records: Array<{
          status: string;
          sourceLocator: {
            adapter: string;
            taskId: string;
            evidencePackId: string;
          };
        }>;
      };
      expect(body.source).toBe("sqlite-memory");
      expect(body.records).toHaveLength(1);
      expect(body.records[0]?.status).toBe("APPROVED");
      expect(body.records[0]?.sourceLocator.adapter).toBe("sqlite-memory");
      expect(body.records[0]?.sourceLocator.taskId).toBe(taskId);
      expect(body.records[0]?.sourceLocator.evidencePackId).toBe(`pack-${taskId}`);
    } finally {
      await root.close();
    }
  });

  it("Review 后允许文件或新文件被改动时拒绝审批，恢复后必须重新签发挑战", async () => {
    const { root, taskId, repositoryPath } = await prepareAwaitingHumanApproval();
    const original = "return {'legacy': True, 'new': True}\n";
    const newFile = join(repositoryPath, "src", "temporary.py");
    try {
      const issueChallenge = async (): Promise<string> => {
        const challengeResponse = await root.app.inject({
          method: "POST",
          url: `/tasks/${taskId}/human-approval/challenge`,
          headers: { "x-tracepilot-human-channel-secret": HUMAN_SECRET },
          payload: { decision: "approved" }
        });
        expect(challengeResponse.statusCode).toBe(201);
        return (challengeResponse.json() as { challengeToken: string }).challengeToken;
      };
      const consumeChallenge = (challengeToken: string) => root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/human-approval`,
        headers: { "x-tracepilot-human-channel-secret": HUMAN_SECRET },
        payload: { challengeToken }
      });

      const firstToken = await issueChallenge();

      writeFileSync(join(repositoryPath, "src", "compat.py"), "return {'legacy': False}\n", "utf8");
      let response = await consumeChallenge(firstToken);
      expect(response.statusCode).toBe(409);

      writeFileSync(join(repositoryPath, "src", "compat.py"), original, "utf8");
      const secondToken = await issueChallenge();
      writeFileSync(newFile, "temporary = True\n", "utf8");
      response = await consumeChallenge(secondToken);
      expect(response.statusCode).toBe(409);

      rmSync(newFile, { force: true });
      const finalToken = await issueChallenge();
      response = await consumeChallenge(finalToken);
      expect(response.statusCode).toBe(200);

      const task = await root.store.unitOfWork.run((tx) => tx.tasks.findById(taskId));
      const records = await root.store.unitOfWork.run((tx) => tx.repairRecords.findByTask(taskId));
      expect(task?.status).toBe("COMPLETED");
      expect(records[0]?.status).toBe("APPROVED");
    } finally {
      await root.close();
    }
  });

  it.each(["修改已有文件", "新增文件"])(
    "最终 Diff 返回后、SQLite 提交前%s会触发补偿且不留下人工审批",
    async (scenario) => {
      let injected = false;
      const { root, taskId, repositoryPath } = await prepareAwaitingHumanApproval({
        approvalFinalizationHookFactory: (repoPath) => async () => {
          if (injected) return;
          injected = true;
          if (scenario === "修改已有文件") {
            chmodSync(join(repoPath, "src", "compat.py"), 0o666);
            writeFileSync(
              join(repoPath, "src", "compat.py"),
              "return {'legacy': False, 'race': True}\n",
              "utf8"
            );
          } else {
            chmodSync(join(repoPath, "src"), 0o777);
            writeFileSync(join(repoPath, "src", "race.py"), "race = True\n", "utf8");
          }
        }
      });
      try {
        const challengeResponse = await root.app.inject({
          method: "POST",
          url: `/tasks/${taskId}/human-approval/challenge`,
          headers: { "x-tracepilot-human-channel-secret": HUMAN_SECRET },
          payload: { decision: "approved" }
        });
        expect(challengeResponse.statusCode).toBe(201);
        const challenge = challengeResponse.json() as { challengeToken: string };
        const response = await root.app.inject({
          method: "POST",
          url: `/tasks/${taskId}/human-approval`,
          headers: { "x-tracepilot-human-channel-secret": HUMAN_SECRET },
          payload: { challengeToken: challenge.challengeToken }
        });
        expect(response.statusCode).toBe(409);
        expect(injected).toBe(true);

        const task = await root.store.unitOfWork.run((tx) => tx.tasks.findById(taskId));
        const approvals = await root.store.unitOfWork.run((tx) => tx.approvals.findByTask(taskId));
        const records = await root.store.unitOfWork.run((tx) => tx.repairRecords.findByTask(taskId));
        const audits = await root.store.unitOfWork.run((tx) => tx.audit.findByTask(taskId));
        expect(task?.status).toBe("AWAITING_HUMAN_APPROVAL");
        expect(records[0]?.status).toBe("VERIFIED");
        expect(approvals.filter((approval) => approval.kind === "human")).toHaveLength(0);
        expect(audits.some((event) => event.type === "human_approval_invalidated")).toBe(true);
      } finally {
        await root.close();
        rmSync(join(repositoryPath, "src", "race.py"), { force: true });
      }
    }
  );
});
