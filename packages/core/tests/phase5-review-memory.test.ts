import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryStore,
  HumanApprovalChallengeError,
  HumanApprovalConfigurationError,
  HumanApprovalCredentialError,
  TaskOrchestrator,
  type ExecutionResult,
  type HumanDecisionFinalizationGuard,
  type PlanNode,
  type Project,
  type ReviewResult,
  type TaskInput
} from "../src/index.js";

const HUMAN_SECRET = "phase5-human-approval-secret-32chars";
const ROOT_EVIDENCE_ID = "evidence-compat-stack";
const ROOT_CAUSE = {
  text: "新实现只覆盖了新调用方式，未保留旧版返回结构",
  confidence: 0.92,
  evidenceIds: [ROOT_EVIDENCE_ID]
} as const;
const APPLICABILITY = {
  text: "旧版客户端仍在使用",
  evidenceIds: [ROOT_EVIDENCE_ID],
  required: true
} as const;
const passThroughHumanDecisionGuard: HumanDecisionFinalizationGuard = {
  finalize: async (args) => args.commit()
};

function input(): TaskInput {
  return {
    objective: "修复兼容性回归",
    constraints: ["保留旧版 API 返回结构"],
    acceptanceCriteria: ["pytest tests/test_compat.py 通过"],
    riskLevel: "low",
    rawSource: "FAILED test_compat",
    origin: "failed_test_log",
    failure: {
      testNames: ["tests/test_compat.py::test_legacy_shape"],
      errorTypes: ["AssertionError"],
      stackSummary: "旧版调用方无法读取返回字段"
    }
  };
}

const project: Project = {
  id: "proj-phase5",
  name: "Phase 5 测试项目",
  repositoryPath: "/tmp/tracepilot/phase5-repo",
  defaultBranch: "main",
  language: "python",
  commands: { test: { argv: ["pytest"], timeoutMs: 30000 } },
  createdAt: "2026-08-03T00:00:00.000Z"
};

async function prepareReviewingTask(orchestrator: TaskOrchestrator, store: ReturnType<typeof createInMemoryStore>) {
  await store.unitOfWork.run(async (tx) => tx.projects.save(project));
  const task = await orchestrator.createTask({ projectId: project.id, input: input() });
  await orchestrator.transitionTask(task.id, "INTAKING");
  await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE");
  const pack = await orchestrator.gatherEvidenceAndCreatePack({
    taskId: task.id,
    packId: `pack-${task.id}`,
    evidence: [{
      id: ROOT_EVIDENCE_ID,
      kind: "runtime",
      source: "pytest",
      locator: "tests/test_compat.py::test_legacy_shape",
      capturedAt: "2026-08-03T00:00:00.000Z",
      contentHash: "sha256-compat-stack",
      summary: "旧版调用方无法读取返回字段",
      relevance: 1,
      trustLevel: "PRIMARY"
    }],
    hypotheses: [ROOT_CAUSE],
    constraints: [APPLICABILITY],
    acceptanceCriteria: input().acceptanceCriteria
  });
  await orchestrator.transitionTask(task.id, "PLANNED");
  const nodes: readonly PlanNode[] = [{
    id: "node-1",
    label: "修复兼容性回归",
    description: "补充兼容性保护",
    evidencePackId: pack.id,
    evidencePackVersion: pack.version
  }];
  await orchestrator.planTask({
    taskId: task.id,
    nodes,
    allowedPaths: ["src/**", "tests/**"],
    inputEvidencePackId: pack.id,
    inputEvidencePackVersion: pack.version
  });
  await orchestrator.transitionTask(task.id, "AWAITING_EXECUTION_APPROVAL");
  const scopeHash = await orchestrator.computeCurrentScopeHash(task.id);
  await orchestrator.recordApproval({
    taskId: task.id,
    kind: "execution",
    approver: "executor",
    decision: "approved",
    scopeHash
  });
  await orchestrator.beginExecutionIfApproved(task.id);
  await orchestrator.transitionTask(task.id, "VALIDATING");
  await orchestrator.transitionTask(task.id, "REVIEWING");

  const execution: ExecutionResult = {
    id: `exec-${task.id}`,
    taskId: task.id,
    runId: `run-${task.id}`,
    diffHash: `diff-${task.id}`,
    diffPatch: "patch",
    diffChangedFiles: ["src/compat.py"],
    diffBytes: 5,
    verificationExitCode: 0,
    verificationPassed: true,
    verificationStdout: "1 passed",
    verificationStderr: "",
    createdAt: "2026-08-03T00:00:01.000Z"
  };
  await store.unitOfWork.run(async (tx) => tx.executionResults.save(execution));
  return { task, execution };
}

function passingReview(): ReviewResult {
  return {
    verdict: "ship",
    findings: [],
    summary: "兼容性行为已通过回归测试",
    rootCause: ROOT_CAUSE,
    fixSummary: "恢复旧版字段并补充兼容性回归测试",
    applicabilityConditions: [APPLICABILITY]
  };
}

describe("Phase 5 Review → Repair Memory 闭环", () => {
  it("兼容性问题或缺少回归测试会阻断任务，不产生 VERIFIED 记忆", async () => {
    const store = createInMemoryStore();
    const orchestrator = new TaskOrchestrator({
      unitOfWork: store.unitOfWork,
      humanApproval: { identity: "product-owner", channelSecret: HUMAN_SECRET },
      humanDecisionFinalizationGuard: passThroughHumanDecisionGuard
    });
    const { task } = await prepareReviewingTask(orchestrator, store);

    const result = await orchestrator.recordReviewAndGate({
      taskId: task.id,
      review: {
        verdict: "ship",
        findings: [{
          priority: "P1",
          confidence: 0.95,
          category: "compatibility",
          message: "旧版客户端会崩溃"
        }],
        summary: "存在兼容性问题"
      }
    });

    expect(result.qualityGate.passed).toBe(false);
    expect(result.task.status).toBe("FAILED");
    expect(result.repairRecord.status).toBe("DRAFT");
    expect(result.repairRecord.failureReasons.join(" ")).toContain("兼容性");
  });

  it.each([
    ["缺失根因引用", undefined],
    ["跨任务或未知 Evidence ID", { ...ROOT_CAUSE, evidenceIds: ["other-task-evidence"] }],
    ["模型临时新造根因", { ...ROOT_CAUSE, text: "未进入 Pack 的新根因" }],
    ["只用自然语言声称有来源", "依据 Evidence Pack 已确认根因"]
  ])("%s 时失败关闭且只能产生 DRAFT", async (_label, rootCause) => {
    const store = createInMemoryStore();
    const orchestrator = new TaskOrchestrator({
      unitOfWork: store.unitOfWork,
      humanApproval: { identity: "product-owner", channelSecret: HUMAN_SECRET },
      humanDecisionFinalizationGuard: passThroughHumanDecisionGuard
    });
    const { task } = await prepareReviewingTask(orchestrator, store);
    const review = {
      verdict: "ship",
      findings: [],
      summary: "声称可以批准",
      ...(rootCause === undefined ? {} : { rootCause }),
      fixSummary: "修复摘要"
    } as unknown as ReviewResult;

    const result = await orchestrator.recordReviewAndGate({ taskId: task.id, review });
    expect(result.qualityGate.passed).toBe(false);
    expect(result.task.status).toBe("FAILED");
    expect(result.repairRecord.status).toBe("DRAFT");
    expect(result.repairRecord.rootCauseEvidenceIds).toEqual([]);
  });

  it("通过 Review 后生成 VERIFIED，人工批准后变为 APPROVED 并完成任务", async () => {
    const store = createInMemoryStore();
    const orchestrator = new TaskOrchestrator({
      unitOfWork: store.unitOfWork,
      humanApproval: { identity: "product-owner", channelSecret: HUMAN_SECRET },
      humanDecisionFinalizationGuard: passThroughHumanDecisionGuard
    });
    const { task } = await prepareReviewingTask(orchestrator, store);

    const reviewed = await orchestrator.recordReviewAndGate({
      taskId: task.id,
      review: passingReview()
    });
    expect(reviewed.qualityGate.passed).toBe(true);
    expect(reviewed.task.status).toBe("AWAITING_HUMAN_APPROVAL");
    expect(reviewed.repairRecord.status).toBe("VERIFIED");
    expect(reviewed.repairRecord.inputEvidencePackId).toBe(`pack-${task.id}`);
    expect(reviewed.repairRecord.inputEvidencePackContentHash).toMatch(/^fnv1a32-/);
    expect(reviewed.repairRecord.rootCauseEvidenceIds).toEqual([ROOT_EVIDENCE_ID]);
    expect(reviewed.repairRecord.applicabilityConditionEvidence).toEqual([APPLICABILITY]);

    const challenge = await orchestrator.issueHumanApprovalChallenge({
      taskId: task.id,
      decision: "approved",
      channelSecret: HUMAN_SECRET
    });
    const approved = await orchestrator.recordHumanDecision({
      taskId: task.id,
      challengeToken: challenge.challengeToken,
      channelSecret: HUMAN_SECRET,
      reason: "已确认兼容性回归和适用范围"
    });
    expect(approved.task.status).toBe("COMPLETED");
    expect(approved.repairRecord.status).toBe("APPROVED");
    expect(approved.approval.kind).toBe("human");

    const audits = await store.audit.findByTask(task.id);
    expect(audits.some((event) => event.type === "human_approval_granted")).toBe(true);
    expect(audits.some((event) => event.type === "repair_record_transitioned")).toBe(true);
  });

  it("人工拒绝不会完成任务，也不会让记忆进入 APPROVED", async () => {
    const store = createInMemoryStore();
    const orchestrator = new TaskOrchestrator({
      unitOfWork: store.unitOfWork,
      humanApproval: { identity: "product-owner", channelSecret: HUMAN_SECRET },
      humanDecisionFinalizationGuard: passThroughHumanDecisionGuard
    });
    const { task } = await prepareReviewingTask(orchestrator, store);
    await orchestrator.recordReviewAndGate({ taskId: task.id, review: passingReview() });

    const challenge = await orchestrator.issueHumanApprovalChallenge({
      taskId: task.id,
      decision: "rejected",
      channelSecret: HUMAN_SECRET
    });
    const rejected = await orchestrator.recordHumanDecision({
      taskId: task.id,
      challengeToken: challenge.challengeToken,
      channelSecret: HUMAN_SECRET,
      reason: "需要补充边界条件"
    });
    expect(rejected.task.status).toBe("REJECTED");
    expect(rejected.repairRecord.status).toBe("DEPRECATED");
    expect(rejected.repairRecord.failureReasons.join(" ")).toContain("需要补充边界条件");
  });

  it("人工挑战绑定身份、任务并且只能消费一次", async () => {
    const store = createInMemoryStore();
    const orchestrator = new TaskOrchestrator({
      unitOfWork: store.unitOfWork,
      humanApproval: { identity: "product-owner", channelSecret: HUMAN_SECRET },
      humanDecisionFinalizationGuard: passThroughHumanDecisionGuard
    });
    const { task } = await prepareReviewingTask(orchestrator, store);
    await orchestrator.recordReviewAndGate({ taskId: task.id, review: passingReview() });

    const challenge = await orchestrator.issueHumanApprovalChallenge({
      taskId: task.id,
      decision: "approved",
      channelSecret: HUMAN_SECRET
    });
    expect(challenge.approver).toBe("product-owner");
    await expect(
      orchestrator.recordHumanDecision({
        taskId: task.id,
        challengeToken: challenge.challengeToken,
        channelSecret: "wrong-secret"
      })
    ).rejects.toBeInstanceOf(HumanApprovalCredentialError);
    await expect(
      orchestrator.recordHumanDecision({
        taskId: "another-task",
        challengeToken: challenge.challengeToken,
        channelSecret: HUMAN_SECRET
      })
    ).rejects.toBeInstanceOf(HumanApprovalChallengeError);

    await orchestrator.recordHumanDecision({
      taskId: task.id,
      challengeToken: challenge.challengeToken,
      channelSecret: HUMAN_SECRET
    });
    await expect(
      orchestrator.recordHumanDecision({
        taskId: task.id,
        challengeToken: challenge.challengeToken,
        channelSecret: HUMAN_SECRET
      })
    ).rejects.toBeInstanceOf(HumanApprovalChallengeError);
  });

  it("过期挑战和伪造 approver 都失败关闭", async () => {
    vi.useFakeTimers();
    try {
      const store = createInMemoryStore();
      const orchestrator = new TaskOrchestrator({
        unitOfWork: store.unitOfWork,
        humanApproval: {
          identity: "product-owner",
          channelSecret: HUMAN_SECRET,
          challengeTtlMs: 10
        },
        humanDecisionFinalizationGuard: passThroughHumanDecisionGuard
      });
      const { task } = await prepareReviewingTask(orchestrator, store);
      await orchestrator.recordReviewAndGate({ taskId: task.id, review: passingReview() });

      await expect(
        orchestrator.recordHumanDecision({
          taskId: task.id,
          approver: "伪造身份",
          decision: "approved",
          reason: "伪造"
        } as unknown as Parameters<TaskOrchestrator["recordHumanDecision"]>[0])
      ).rejects.toBeInstanceOf(HumanApprovalCredentialError);

      const challenge = await orchestrator.issueHumanApprovalChallenge({
        taskId: task.id,
        decision: "approved",
        channelSecret: HUMAN_SECRET
      });
      vi.advanceTimersByTime(11);
      await expect(
        orchestrator.recordHumanDecision({
          taskId: task.id,
          challengeToken: challenge.challengeToken,
          channelSecret: HUMAN_SECRET
        })
      ).rejects.toBeInstanceOf(HumanApprovalChallengeError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("人工审批通道凭证短于 32 个字符时失败关闭", async () => {
    const store = createInMemoryStore();
    const orchestrator = new TaskOrchestrator({
      unitOfWork: store.unitOfWork,
      humanApproval: { identity: "product-owner", channelSecret: "too-short" },
      humanDecisionFinalizationGuard: passThroughHumanDecisionGuard
    });

    await expect(
      orchestrator.issueHumanApprovalChallenge({
        taskId: "missing-task",
        decision: "approved",
        channelSecret: "too-short"
      })
    ).rejects.toBeInstanceOf(HumanApprovalConfigurationError);
  });
});
