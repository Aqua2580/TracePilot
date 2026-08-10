import { describe, expect, it, beforeEach } from "vitest";
import {
  TaskOrchestrator,
  createInMemoryStore,
  IllegalTransitionError,
  TaskNotFoundError,
  TerminalTaskError,
  ScopeMismatchError,
  InvalidApprovalStateError,
  isApprovalInvalidated,
  EvidencePackVersionError,
  type TaskInput,
  type TaskStatus,
  type EvidencePack,
  type EvidenceItem,
  type Worktree,
  type Project,
  type ProjectCommands,
  type PlanNode,
  type InMemoryStore
} from "../src/index.js";
function sampleTaskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    objective: "修复失败的 pytest 用例 test_users_create",
    constraints: ["不得修改 /api/users 的公开 API"],
    acceptanceCriteria: ["pytest tests/test_users.py 通过"],
    riskLevel: "low",
    rawSource: "FAILED test_users_create::test_returns_201 ...",
    origin: "failed_test_log",
    failure: {
      testNames: ["test_users_create::test_returns_201"],
      errorTypes: ["AssertionError"],
      stackSummary: "assert response.status == 201, got 400"
    },
    ...overrides
  };
}

/** 构造最小可用 EvidencePack，供版本回滚测试使用。 */
function sampleEvidencePack(
  id: string,
  version: number,
  taskId = "task-ep-test"
): EvidencePack {
  return {
    id,
    taskId,
    version,
    taskSnapshot: sampleTaskInput(),
    evidence: [],
    hypotheses: [],
    constraints: [],
    acceptanceCriteria: ["pytest tests/test_users.py 通过"],
    createdAt: new Date().toISOString(),
    contentHash: `fnv1a32-${version.toString(16).padStart(8, "0")}`
  };
}

/** 构造最小可用 EvidenceItem，供 Pack 编排测试使用。 */
function sampleEvidenceItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "ev-1",
    kind: "code",
    source: "code-search",
    locator: "src/users.ts:12",
    capturedAt: "2026-07-27T00:00:00.000Z",
    contentHash: "sha256-abc",
    summary: "function createUser 返回 400 当输入为空",
    relevance: 0.8,
    trustLevel: "PRIMARY",
    ...overrides
  };
}

/** 构造最小可用 Worktree，供 attachWorktree 测试使用。 */
function sampleWorktree(taskId: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: "wt-test-1",
    projectId: "proj-1",
    taskId,
    path: "/tmp/tracepilot/worktrees/proj-1/task-wt",
    branch: "tracepilot/task-wt",
    baseCommitSha: "abc123def456",
    allowedPaths: ["src/**"],
    createdAt: "2026-07-27T00:00:00.000Z",
    ...overrides
  };
}

/**
 * P1-R04：测试用命令契约。computeScopeHash 必须包含完整 argv + timeoutMs，
 * 因此测试需要构造完整的 ProjectCommands 而非命令 key 数组。
 */
const sampleCommands: ProjectCommands = {
  test: { argv: ["pytest"], timeoutMs: 30000 }
};

/** 构造最小可用 Project，供 computeCurrentScopeHash 读取。 */
function sampleProject(id = "proj-1"): Project {
  return {
    id,
    name: "测试项目",
    repositoryPath: "/tmp/tracepilot/repos/proj-1",
    defaultBranch: "main",
    language: "python",
    commands: sampleCommands,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

/**
 * P1-R04：构造最小可用 PlanNode 数组，供 planTask 使用。
 */
function samplePlanNodes(packId: string): readonly PlanNode[] {
  return [
    {
      id: "node-1",
      label: "修改 users.py",
      description: "调整 createUser 实现",
      evidencePackId: packId,
      evidencePackVersion: 1
    }
  ];
}

describe("TaskOrchestrator", () => {
  let store: InMemoryStore;
  let orchestrator: TaskOrchestrator;

  beforeEach(async () => {
    store = createInMemoryStore();
    orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    // P1-R04：computeCurrentScopeHash 需要从持久化的 Project 读取 commands，
    // 因此测试前先持久化一个最小可用 Project。
    await store.unitOfWork.run(async (tx) => {
      await tx.projects.save(sampleProject());
    });
  });

  /**
   * 把任务从 CREATED 一路迁移到目标状态（跳过审批闸门由调用方自理）。
   *
   * P1-R03 / P1-R04 修正：moveTo 必须走完整合法时序：
   * 1. CREATED → INTAKING → GATHERING_EVIDENCE
   * 2. 生成 Pack v1（空 evidence，仅满足 Plan 引用）
   * 3. GATHERING_EVIDENCE → PLANNED
   * 4. planTask 记录 Plan（含 allowedPaths，更新 task.currentPlanId）
   * 5. PLANNED → AWAITING_EXECUTION_APPROVAL
   * 6. computeCurrentScopeHash 获取权威 scopeHash（从 Plan + Project.commands）
   * 7. recordApproval 签发执行审批
   * 8. beginExecutionIfApproved 进入 EXECUTING（事务内重算 scopeHash 比对）
   */
  async function moveTo(taskId: string, target: TaskStatus): Promise<void> {
    const execAndBeyond: Partial<Record<TaskStatus, readonly TaskStatus[]>> = {
      EXECUTING: ["EXECUTING"],
      EVIDENCE_GAP: ["EXECUTING", "EVIDENCE_GAP"],
      VALIDATING: ["EXECUTING", "VALIDATING"],
      REVIEWING: ["EXECUTING", "VALIDATING", "REVIEWING"],
      AWAITING_HUMAN_APPROVAL: ["EXECUTING", "VALIDATING", "REVIEWING"]
    };

    // 1. CREATED → INTAKING → GATHERING_EVIDENCE。
    await orchestrator.transitionTask(taskId, "INTAKING");
    await orchestrator.transitionTask(taskId, "GATHERING_EVIDENCE");

    // 2. 如果目标就是 GATHERING_EVIDENCE，停留在此（让调用方自行
    //    决定何时调用 gatherEvidenceAndCreatePack）。
    if (target === "GATHERING_EVIDENCE") return;

    // 3. 生成 Pack v1（空 evidence，仅满足 Plan 引用）。
    const packId = `pack-${taskId}`;
    await orchestrator.gatherEvidenceAndCreatePack({
      taskId,
      packId,
      evidence: [],
      acceptanceCriteria: []
    });

    // 4. GATHERING_EVIDENCE → PLANNED。
    await orchestrator.transitionTask(taskId, "PLANNED");

    // 5. 记录 Plan（含 allowedPaths，更新 task.currentPlanId）。
    await orchestrator.planTask({
      taskId,
      nodes: samplePlanNodes(packId),
      allowedPaths: ["src/**"],
      inputEvidencePackId: packId,
      inputEvidencePackVersion: 1
    });

    // 6. 如果目标就是 PLANNED，到此为止。
    if (target === "PLANNED") return;

    // 7. PLANNED → AWAITING_EXECUTION_APPROVAL。
    await orchestrator.transitionTask(taskId, "AWAITING_EXECUTION_APPROVAL");
    if (target === "AWAITING_EXECUTION_APPROVAL") return;

    // 8. computeCurrentScopeHash + recordApproval + beginExecutionIfApproved。
    const scopeHash = await orchestrator.computeCurrentScopeHash(taskId);
    await orchestrator.recordApproval({
      taskId,
      kind: "execution",
      approver: "mover",
      decision: "approved",
      scopeHash
    });
    await orchestrator.beginExecutionIfApproved(taskId);

    // 9. 继续走 EXECUTING 之后的步骤。
    const tail = execAndBeyond[target]?.slice(1) ?? [];
    for (const s of tail) {
      await orchestrator.transitionTask(taskId, s);
    }
  }

  async function forceAwaitingHumanApproval(taskId: string): Promise<void> {
    await moveTo(taskId, "REVIEWING");
    await store.unitOfWork.run(async (tx) => {
      const current = await tx.tasks.findById(taskId);
      if (!current) throw new Error("测试任务不存在");
      await tx.tasks.save({
        ...current,
        status: "AWAITING_HUMAN_APPROVAL",
        updatedAt: new Date().toISOString()
      });
    });
  }

  describe("createTask", () => {
    it("创建任务后处于 CREATED，并写入 task_created 审计事件", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });

      expect(task.status).toBe("CREATED");
      expect(task.projectId).toBe("proj-1");

      const audits = await store.audit.findByTask(task.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.type).toBe("task_created");
      expect(audits[0]!.toStatus).toBe("CREATED");
    });
  });

  describe("transitionTask", () => {
    it("沿主路径迁移任务，每次迁移写一条审计事件", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });

      // P1-R03 / P1-R04：合法时序需要 Plan + execution approval 才能
      // 经 beginExecutionIfApproved 进入 EXECUTING。本测试直接走完整
      // 合法通用迁移只允许到 REVIEWING；进入人工审批必须由
      // recordReviewAndGate 完成，不能由本测试绕过。
      await orchestrator.transitionTask(task.id, "INTAKING");
      await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE");
      const packId = `pack-${task.id}`;
      await orchestrator.gatherEvidenceAndCreatePack({
        taskId: task.id,
        packId,
        evidence: [],
        acceptanceCriteria: []
      });
      await orchestrator.transitionTask(task.id, "PLANNED");
      await orchestrator.planTask({
        taskId: task.id,
        nodes: samplePlanNodes(packId),
        allowedPaths: ["src/**"],
        inputEvidencePackId: packId,
        inputEvidencePackVersion: 1
      });
      await orchestrator.transitionTask(task.id, "AWAITING_EXECUTION_APPROVAL");
      const scope = await orchestrator.computeCurrentScopeHash(task.id);
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "tester",
        decision: "approved",
        scopeHash: scope
      });
      await orchestrator.beginExecutionIfApproved(task.id);
      await orchestrator.transitionTask(task.id, "VALIDATING");
      await orchestrator.transitionTask(task.id, "REVIEWING");

      const final = await store.tasks.findById(task.id);
      expect(final?.status).toBe("REVIEWING");

      // 1 条创建 +
      // 2 条迁移到 GATHERING_EVIDENCE +
      // 1 条 Pack v1 + 1 条迁移到 PLANNED + 1 条 plan_recorded +
      // 1 条迁移到 AWAITING_EXECUTION_APPROVAL + 1 条执行审批 +
      // 1 条进入 EXECUTING 迁移 + 2 条迁移到 REVIEWING = 11 条
      const audits = await store.audit.findByTask(task.id);
      expect(audits).toHaveLength(11);
    });

    it("通用迁移不能绕过 Review、人工审批和 APPROVED Repair Record", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "REVIEWING");

      await expect(
        orchestrator.transitionTask(task.id, "AWAITING_HUMAN_APPROVAL")
      ).rejects.toThrow("必须使用对应的 Review、审批或终态领域服务");

      await store.unitOfWork.run(async (tx) => {
        const current = await tx.tasks.findById(task.id);
        if (!current) throw new Error("测试任务不存在");
        await tx.tasks.save({ ...current, status: "AWAITING_HUMAN_APPROVAL" });
      });
      await expect(
        orchestrator.transitionTask(task.id, "COMPLETED")
      ).rejects.toThrow("必须使用对应的 Review、审批或终态领域服务");
      await expect(
        orchestrator.transitionTask(task.id, "REJECTED")
      ).rejects.toThrow("必须使用对应的 Review、审批或终态领域服务");

      const stored = await store.tasks.findById(task.id);
      const approvals = await store.approvals.findByTask(task.id);
      const records = await store.repairRecords.findByTask(task.id);
      expect(stored?.status).toBe("AWAITING_HUMAN_APPROVAL");
      expect(approvals.filter((approval) => approval.kind === "human")).toHaveLength(0);
      expect(records).toHaveLength(0);
    });

    it("跳过闸门时抛 IllegalTransitionError", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });

      await expect(
        orchestrator.transitionTask(task.id, "EXECUTING")
      ).rejects.toBeInstanceOf(IllegalTransitionError);

      // 失败后任务保持原状态。
      const unchanged = await store.tasks.findById(task.id);
      expect(unchanged?.status).toBe("CREATED");
    });

    it("审计事件携带 from/to 状态", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await orchestrator.transitionTask(task.id, "INTAKING");

      const audits = await store.audit.findByTask(task.id);
      const transitionAudit = audits.find((a) => a.type === "task_transitioned");
      expect(transitionAudit).toBeDefined();
      expect(transitionAudit?.fromStatus).toBe("CREATED");
      expect(transitionAudit?.toStatus).toBe("INTAKING");
    });

    it("未知任务 id 抛 TaskNotFoundError", async () => {
      await expect(
        orchestrator.transitionTask("nope", "INTAKING")
      ).rejects.toBeInstanceOf(TaskNotFoundError);
    });
  });

  // P2-01：终态拒绝所有迁移，包括同状态 no-op
  describe("P2-01 终态拒绝迁移（含同状态 no-op）", () => {
    it("COMPLETED 任务迁移到任何状态都抛 TerminalTaskError", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "REVIEWING");
      // 该用例只验证终态状态机。Phase 5 的完成闸门由专门测试覆盖，
      // 这里直接把已完成快照写入测试仓储，避免重新引入已删除的布尔参数。
      await store.unitOfWork.run(async (tx) => {
        const current = await tx.tasks.findById(task.id);
        if (!current) throw new Error("测试任务不存在");
        await tx.tasks.save({
          ...current,
          status: "COMPLETED",
          updatedAt: new Date().toISOString()
        });
      });

      await expect(
        orchestrator.transitionTask(task.id, "REVIEWING")
      ).rejects.toBeInstanceOf(TerminalTaskError);

      // 同状态 no-op 也拒绝
      await expect(
        orchestrator.transitionTask(task.id, "COMPLETED")
      ).rejects.toBeInstanceOf(TerminalTaskError);
    });

    it("CANCELLED 任务不可再迁移", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await orchestrator.cancel(task.id, "用户取消");

      await expect(
        orchestrator.transitionTask(task.id, "INTAKING")
      ).rejects.toBeInstanceOf(TerminalTaskError);

      await expect(
        orchestrator.transitionTask(task.id, "CANCELLED")
      ).rejects.toBeInstanceOf(TerminalTaskError);
    });
  });

  describe("cancel", () => {
    it("取消非终态任务", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      const cancelled = await orchestrator.cancel(task.id, "用户请求");

      expect(cancelled.status).toBe("CANCELLED");
      const audits = await store.audit.findByTask(task.id);
      expect(audits.some((a) => a.type === "task_cancelled")).toBe(true);
    });

    it("拒绝取消已终态任务（抛 TerminalTaskError）", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await orchestrator.cancel(task.id, "第一次取消");

      await expect(orchestrator.cancel(task.id, "第二次取消")).rejects.toBeInstanceOf(
        TerminalTaskError
      );
    });
  });

  describe("fail", () => {
    it("把非终态任务标记为 FAILED 并记录原因", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await orchestrator.transitionTask(task.id, "INTAKING");

      const failed = await orchestrator.fail(task.id, "intake 解析失败");
      expect(failed.status).toBe("FAILED");
      expect(failed.lastTransitionReason).toBe("intake 解析失败");
    });
  });

  describe("interrupt + recoverInterruptedTasks（§3.1、§5.2）", () => {
    it("把 EXECUTING 任务标记为 INTERRUPTED", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "EXECUTING");

      const interrupted = await orchestrator.interrupt(task.id, "进程退出");
      expect(interrupted.status).toBe("INTERRUPTED");
    });

    it("recoverInterruptedTasks 把 EXECUTING/VALIDATING 迁到 INTERRUPTED，永不 COMPLETED", async () => {
      // 任务 A 卡在 EXECUTING
      const taskA = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(taskA.id, "EXECUTING");

      // 任务 B 卡在 VALIDATING
      const taskB = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(taskB.id, "VALIDATING");

      // 任务 C 在 AWAITING_EXECUTION_APPROVAL 等待 —— 非进行中，应保持原状
      const taskC = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(taskC.id, "AWAITING_EXECUTION_APPROVAL");

      const recovered = await orchestrator.recoverInterruptedTasks();
      const recoveredIds = recovered.map((t) => t.id).sort();
      expect(recoveredIds).toEqual([taskA.id, taskB.id].sort());

      const cAfter = await store.tasks.findById(taskC.id);
      expect(cAfter?.status).toBe("AWAITING_EXECUTION_APPROVAL");
    });
  });

  describe("resume", () => {
    it("INTERRUPTED → EXECUTING 重跑被中断的步骤", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "EXECUTING");
      await orchestrator.interrupt(task.id, "进程退出");

      const resumed = await orchestrator.resume(task.id, "EXECUTING");
      expect(resumed.status).toBe("EXECUTING");
    });

    it("拒绝直接 resume 到 COMPLETED", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "EXECUTING");
      await orchestrator.interrupt(task.id, "进程退出");

      await expect(orchestrator.resume(task.id, "COMPLETED")).rejects.toBeInstanceOf(
        IllegalTransitionError
      );
    });
  });

  describe("recordApproval（P2-05 状态校验）", () => {
    it("在 AWAITING_EXECUTION_APPROVAL 持久化执行审批并写审计", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_EXECUTION_APPROVAL");
      const scopeHash = await orchestrator.computeCurrentScopeHash(task.id);

      const approval = await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash
      });

      expect(approval.decision).toBe("approved");
      const audits = await store.audit.findByTask(task.id);
      expect(audits.some((a) => a.type === "execution_approval_granted")).toBe(true);
    });

    it("在 AWAITING_HUMAN_APPROVAL 拒绝旧的人类审批入口", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await forceAwaitingHumanApproval(task.id);
      await expect(
        orchestrator.recordApproval({
          taskId: task.id,
          kind: "human" as unknown as "execution",
          approver: "bob",
          decision: "rejected",
          scopeHash: "scope-x",
          reason: "修复未触及根因"
        })
      ).rejects.toThrow("不得通过通用 recordApproval");
      expect((await store.approvals.findByTask(task.id)).filter((a) => a.kind === "human")).toHaveLength(0);
    });

    it("P2-05：任务不存在时抛 TaskNotFoundError", async () => {
      await expect(
        orchestrator.recordApproval({
          taskId: "nope",
          kind: "execution",
          approver: "alice",
          decision: "approved",
          scopeHash: "scope-x"
        })
      ).rejects.toBeInstanceOf(TaskNotFoundError);
    });

    it("P2-05：状态不允许该类审批时抛 InvalidApprovalStateError", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      // CREATED 状态不接受 execution 审批
      await expect(
        orchestrator.recordApproval({
          taskId: task.id,
          kind: "execution",
          approver: "alice",
          decision: "approved",
          scopeHash: "scope-x"
        })
      ).rejects.toBeInstanceOf(InvalidApprovalStateError);
    });
  });

  describe("P1-02 审批失效与 scopeHash 校验", () => {
    it("范围未扩大时，原执行审批可继续使用", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_EXECUTION_APPROVAL");
      const scopeHash = await orchestrator.computeCurrentScopeHash(task.id);
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash
      });

      // scopeHash 一致 → 可进入 EXECUTING
      const executing = await orchestrator.beginExecutionIfApproved(task.id);
      expect(executing.status).toBe("EXECUTING");

      // 旧审批未失效
      const latest = await store.approvals.findLatestExecutionApproval(task.id);
      expect(latest).toBeDefined();
      expect(isApprovalInvalidated(latest!)).toBe(false);
    });

    it("范围扩大后，旧执行审批不可被查询为有效", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_EXECUTION_APPROVAL");
      const oldScope = await orchestrator.computeCurrentScopeHash(task.id);
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash: oldScope
      });

      // 进入 EXECUTING，遇到 EVIDENCE_GAP，扩大范围回到 GATHERING_EVIDENCE
      await orchestrator.beginExecutionIfApproved(task.id);
      await orchestrator.transitionTask(task.id, "EVIDENCE_GAP");
      await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE", {
        widenScope: true,
        reason: "新计划扩大允许路径"
      });

      // 旧审批已失效 —— findLatestExecutionApproval 不再返回它
      const latest = await store.approvals.findLatestExecutionApproval(task.id);
      expect(latest).toBeUndefined();

      // 失效事件写入审计时间线
      const audits = await store.audit.findByTask(task.id);
      const invalidation = audits.find(
        (a) => a.type === "execution_approval_invalidated"
      );
      expect(invalidation).toBeDefined();
      expect(invalidation?.reason).toContain("扩大");
    });

    it("未取得新批准前，不得从 AWAITING_EXECUTION_APPROVAL 进入 EXECUTING", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_EXECUTION_APPROVAL");
      const oldScope = await orchestrator.computeCurrentScopeHash(task.id);
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash: oldScope
      });
      await orchestrator.beginExecutionIfApproved(task.id);
      await orchestrator.transitionTask(task.id, "EVIDENCE_GAP");
      await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE", {
        widenScope: true,
        reason: "扩大范围"
      });
      // 重新规划 → AWAITING_EXECUTION_APPROVAL，但还没取得新审批
      await orchestrator.transitionTask(task.id, "PLANNED");
      await orchestrator.transitionTask(task.id, "AWAITING_EXECUTION_APPROVAL");

      // 旧审批已失效，新审批未签发 → 拒绝进入 EXECUTING
      await expect(
        orchestrator.beginExecutionIfApproved(task.id)
      ).rejects.toBeInstanceOf(ScopeMismatchError);
    });

    it("scopeHash 不一致时拒绝进入 EXECUTING（抛 ScopeMismatchError）", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_EXECUTION_APPROVAL");
      const approvedScope = await orchestrator.computeCurrentScopeHash(task.id);
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash: approvedScope
      });

      // P1-R04：修改 Project.commands（替换同名命令 argv）使 scopeHash 不一致。
      // 旧实现只哈希命令 key，这种修改不会被检测到；新实现必须检测。
      await store.unitOfWork.run(async (tx) => {
        await tx.projects.save({
          ...sampleProject(),
          commands: {
            test: { argv: ["python", "-m", "pytest"], timeoutMs: 60000 }
          }
        });
      });

      await expect(
        orchestrator.beginExecutionIfApproved(task.id)
      ).rejects.toBeInstanceOf(ScopeMismatchError);
    });

    it("失效事件和新批准均可在审计时间线中查到", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_EXECUTION_APPROVAL");
      const oldScope = await orchestrator.computeCurrentScopeHash(task.id);
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash: oldScope
      });
      await orchestrator.beginExecutionIfApproved(task.id);
      await orchestrator.transitionTask(task.id, "EVIDENCE_GAP");
      await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE", {
        widenScope: true,
        reason: "扩大范围"
      });
      await orchestrator.transitionTask(task.id, "PLANNED");
      // P1-R04：扩大范围需要记录新 Plan（含扩展的 allowedPaths）。
      await orchestrator.planTask({
        taskId: task.id,
        nodes: samplePlanNodes(`pack-${task.id}`),
        allowedPaths: ["src/**", "tests/**"],
        inputEvidencePackId: `pack-${task.id}`,
        inputEvidencePackVersion: 1
      });
      await orchestrator.transitionTask(task.id, "AWAITING_EXECUTION_APPROVAL");
      const newScope = await orchestrator.computeCurrentScopeHash(task.id);
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash: newScope
      });

      const audits = await store.audit.findByTask(task.id);
      // 失效事件
      expect(audits.some((a) => a.type === "execution_approval_invalidated")).toBe(true);
      // 新批准事件
      expect(
        audits.filter((a) => a.type === "execution_approval_granted")
      ).toHaveLength(2);

      // 新批准生效后可进入 EXECUTING
      const executing = await orchestrator.beginExecutionIfApproved(task.id);
      expect(executing.status).toBe("EXECUTING");
    });
  });

  // P1-R02：通用迁移接口 transitionTask 不得用于进入 EXECUTING；
  // 进入 EXECUTING 只能经 beginExecutionIfApproved，并校验有效审批与
  // scopeHash。以下测试覆盖：无审批、已拒绝审批、已失效审批、
  // scopeHash 不一致、transitionTask 直连 EXECUTING 均被拒绝。
  describe("P1-R02 执行审批安全边界", () => {
    it("transitionTask 拒绝任何以 EXECUTING 为目标的迁移（含 AWAITING_EXECUTION_APPROVAL）", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_EXECUTION_APPROVAL");

      // 即使当前处于 AWAITING_EXECUTION_APPROVAL（状态机允许到 EXECUTING），
      // 通用迁移接口也必须拒绝 —— 否则调用方可绕过审批直接进入执行态。
      await expect(
        orchestrator.transitionTask(task.id, "EXECUTING")
      ).rejects.toBeInstanceOf(IllegalTransitionError);

      // 任务保持原状态。
      const unchanged = await store.tasks.findById(task.id);
      expect(unchanged?.status).toBe("AWAITING_EXECUTION_APPROVAL");
    });

    it("完全无审批记录时，beginExecutionIfApproved 拒绝进入 EXECUTING", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_EXECUTION_APPROVAL");
      // 不签发任何审批记录，直接尝试进入 EXECUTING。

      await expect(
        orchestrator.beginExecutionIfApproved(task.id)
      ).rejects.toBeInstanceOf(ScopeMismatchError);

      const unchanged = await store.tasks.findById(task.id);
      expect(unchanged?.status).toBe("AWAITING_EXECUTION_APPROVAL");
    });

    it("已拒绝审批不得进入 EXECUTING（抛 ScopeMismatchError）", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_EXECUTION_APPROVAL");
      const scope = await orchestrator.computeCurrentScopeHash(task.id);
      // 签发一份被拒绝的执行审批。
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "rejected",
        scopeHash: scope,
        reason: "计划风险过高"
      });

      // findLatestExecutionApproval 仅返回 decision=approved 且未失效的记录，
      // 因此被拒绝的审批不构成有效批准 —— 进入 EXECUTING 被拒绝。
      await expect(
        orchestrator.beginExecutionIfApproved(task.id)
      ).rejects.toBeInstanceOf(ScopeMismatchError);

      const unchanged = await store.tasks.findById(task.id);
      expect(unchanged?.status).toBe("AWAITING_EXECUTION_APPROVAL");
    });

    it("已失效审批不得进入 EXECUTING（抛 ScopeMismatchError）", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_EXECUTION_APPROVAL");
      const oldScope = await orchestrator.computeCurrentScopeHash(task.id);
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash: oldScope
      });
      // 进入 EXECUTING → EVIDENCE_GAP → 扩大范围回 GATHERING_EVIDENCE，
      // 旧审批在同一事务内失效。
      await orchestrator.beginExecutionIfApproved(task.id);
      await orchestrator.transitionTask(task.id, "EVIDENCE_GAP");
      await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE", {
        widenScope: true,
        reason: "扩大范围"
      });
      await orchestrator.transitionTask(task.id, "PLANNED");
      // P1-R04：扩大范围需要记录新 Plan。
      await orchestrator.planTask({
        taskId: task.id,
        nodes: samplePlanNodes(`pack-${task.id}`),
        allowedPaths: ["src/**", "tests/**"],
        inputEvidencePackId: `pack-${task.id}`,
        inputEvidencePackVersion: 1
      });
      await orchestrator.transitionTask(task.id, "AWAITING_EXECUTION_APPROVAL");

      // 旧审批已失效，findLatestExecutionApproval 返回 undefined。
      const latest = await store.approvals.findLatestExecutionApproval(task.id);
      expect(latest).toBeUndefined();

      // 即使 scopeHash 与旧审批一致，也因无有效审批被拒绝。
      await expect(
        orchestrator.beginExecutionIfApproved(task.id)
      ).rejects.toBeInstanceOf(ScopeMismatchError);

      const unchanged = await store.tasks.findById(task.id);
      expect(unchanged?.status).toBe("AWAITING_EXECUTION_APPROVAL");
    });
  });

  it("通用审批入口拒绝 human kind，不能绕过 Repair Record 原子迁移", async () => {
    const task = await orchestrator.createTask({
      projectId: "proj-1",
      input: sampleTaskInput()
    });
    await forceAwaitingHumanApproval(task.id);
    await expect(
      orchestrator.recordApproval({
        taskId: task.id,
        kind: "human" as "execution",
        approver: "伪造身份",
        decision: "approved",
        scopeHash: "scope-test"
      })
    ).rejects.toThrow("不得通过通用 recordApproval");
    expect((await store.approvals.findByTask(task.id)).filter((a) => a.kind === "human")).toHaveLength(0);
    expect((await store.tasks.findById(task.id))?.status).toBe("AWAITING_HUMAN_APPROVAL");
  });

  describe("事务不变量（§5.2）", () => {
    it("任务更新与审计事件在同一 UnitOfWork 事务内写入", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });

      // 迁移后任务更新和审计事件必须同时可见 —— 不允许只有一方提交。
      await orchestrator.transitionTask(task.id, "INTAKING");

      const stored = await store.tasks.findById(task.id);
      const audits = await store.audit.findByTask(task.id);

      expect(stored?.status).toBe("INTAKING");
      expect(audits.some((a) => a.fromStatus === "CREATED" && a.toStatus === "INTAKING")).toBe(true);
    });
  });

  // P1-01：InMemory UnitOfWork 原子提交 + 串行写入
  describe("P1-01 InMemory UnitOfWork 原子提交与串行写入", () => {
    it("回调在第二次写入前抛错时，Task 和 Audit 都保持事务前状态", async () => {
      const taskId = "task-rollback-test";
      // 先正常创建一个任务（写 task + audit）。
      await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput(),
        taskId
      });
      const auditsBefore = await store.audit.findByTask(taskId);
      const taskBefore = await store.tasks.findById(taskId);

      // 手动构造一个会在第一次写 task 后、第二次写 audit 前抛错的事务。
      await expect(
        store.unitOfWork.run(async (tx) => {
          // 第一次写：把任务状态改成 INTAKING
          await tx.tasks.save({ ...taskBefore!, status: "INTAKING" });
          // 第二次写前抛错 —— 模拟审计写入失败
          throw new Error("模拟审计写入失败");
        })
      ).rejects.toThrow("模拟审计写入失败");

      // 回滚后：任务和审计都应保持事务前状态
      const taskAfter = await store.tasks.findById(taskId);
      const auditsAfter = await store.audit.findByTask(taskId);
      expect(taskAfter?.status).toBe(taskBefore!.status);
      expect(auditsAfter).toHaveLength(auditsBefore.length);
    });

    it("创建 Task 与 task_created 审计要么同时可见，要么同时不可见", async () => {
      // 构造一个会在 task.save 后、audit.append 前抛错的 createTask 等价路径。
      const taskId = "task-atomic-create";
      await expect(
        store.unitOfWork.run(async (tx) => {
          const now = new Date().toISOString();
          await tx.tasks.save({
            id: taskId,
            projectId: "proj-1",
            status: "CREATED",
            input: sampleTaskInput(),
            createdAt: now,
            updatedAt: now
          });
          throw new Error("审计写入前失败");
        })
      ).rejects.toThrow("审计写入前失败");

      // 两者必须同时不可见
      const task = await store.tasks.findById(taskId);
      const audits = await store.audit.findByTask(taskId);
      expect(task).toBeUndefined();
      expect(audits).toHaveLength(0);
    });

    it("两个并发状态迁移请求只能有一个成功，另一个基于最新状态被拒绝", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      // 两个并发请求都尝试从 CREATED → INTAKING
      const results = await Promise.allSettled([
        orchestrator.transitionTask(task.id, "INTAKING"),
        orchestrator.transitionTask(task.id, "INTAKING")
      ]);

      // 串行队列保证：第一个成功（CREATED → INTAKING），第二个看到
      // 最新状态 INTAKING，因 from === to 被拒绝（IllegalTransitionError）。
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        IllegalTransitionError
      );

      const final = await store.tasks.findById(task.id);
      expect(final?.status).toBe("INTAKING");

      // 只有一条迁移审计事件（来自成功的那次），没有交错脏数据。
      const audits = await store.audit.findByTask(task.id);
      const transitions = audits.filter((a) => a.type === "task_transitioned");
      expect(transitions).toHaveLength(1);
      expect(transitions[0]!.fromStatus).toBe("CREATED");
      expect(transitions[0]!.toStatus).toBe("INTAKING");
    });

    it("并发迁移不会产生交错审计（串行队列保证）", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      // 第一个请求 CREATED → INTAKING，第二个 INTAKING → GATHERING_EVIDENCE
      // 并发发起。串行队列保证它们按到达顺序执行，最终状态确定。
      await Promise.all([
        orchestrator.transitionTask(task.id, "INTAKING"),
        orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE")
      ]);

      const final = await store.tasks.findById(task.id);
      expect(final?.status).toBe("GATHERING_EVIDENCE");
    });

    // P1-R01：VersionedSnapshotTable 的事务前快照必须深拷贝每个版本数组，
    // 否则事务内 append 会污染共享数组，导致回滚后新版本仍残留。
    it("P1-R01：事务回滚后 Evidence Pack 新版本不残留（仅保留 v1）", async () => {
      const packId = "ep-rollback-r01";
      // 1. 先持久化 v1。
      await store.evidencePacks.save(sampleEvidencePack(packId, 1));
      const versionsBefore = await store.evidencePacks.findVersions(packId);
      expect(versionsBefore.map((v) => v.version)).toEqual([1]);

      // 2. 在事务内写入 v2 后抛错 —— 触发回滚。
      await expect(
        store.unitOfWork.run(async (tx) => {
          await tx.evidencePacks.save(sampleEvidencePack(packId, 2));
          throw new Error("模拟事务失败");
        })
      ).rejects.toThrow("模拟事务失败");

      // 3. 回滚后：仅保留 v1，v2 不得残留。
      const versionsAfter = await store.evidencePacks.findVersions(packId);
      expect(versionsAfter.map((v) => v.version)).toEqual([1]);
      const latest = await store.evidencePacks.findLatestVersion(packId);
      expect(latest?.version).toBe(1);
    });

    it("P1-R01：事务成功提交后 Evidence Pack 新版本可见", async () => {
      const packId = "ep-commit-r01";
      await store.evidencePacks.save(sampleEvidencePack(packId, 1));

      // 事务成功提交：v2 应可见。
      await store.unitOfWork.run(async (tx) => {
        await tx.evidencePacks.save(sampleEvidencePack(packId, 2));
      });

      const versions = await store.evidencePacks.findVersions(packId);
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      const latest = await store.evidencePacks.findLatestVersion(packId);
      expect(latest?.version).toBe(2);
    });
  });

  // ---------------------------------------------------------------------
  // Phase 3：证据 / Pack / worktree 编排方法（§5.3、§8.1 步骤 3-5）
  // ---------------------------------------------------------------------
  describe("Phase 3 gatherEvidenceAndCreatePack", () => {
    it("在 GATHERING_EVIDENCE 状态下生成 Pack v1，事务原子更新 task 与审计", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "GATHERING_EVIDENCE");

      const pack = await orchestrator.gatherEvidenceAndCreatePack({
        taskId: task.id,
        packId: "pack-phase3-1",
        evidence: [sampleEvidenceItem()],
        hypotheses: [
          { text: "createUser 未校验空输入", confidence: 0.7, evidenceIds: ["ev-1"] }
        ],
        acceptanceCriteria: ["pytest tests/test_users.py 通过"]
      });

      // Pack v1 已持久化
      expect(pack.version).toBe(1);
      expect(pack.id).toBe("pack-phase3-1");
      const stored = await store.evidencePacks.findById("pack-phase3-1");
      expect(stored).toBeDefined();
      expect(stored?.version).toBe(1);

      // task.currentEvidencePackId / Version 被更新
      const updatedTask = await store.tasks.findById(task.id);
      expect(updatedTask?.currentEvidencePackId).toBe("pack-phase3-1");
      expect(updatedTask?.currentEvidencePackVersion).toBe(1);

      // evidence_pack_versioned 审计事件被写入
      const audits = await store.audit.findByTask(task.id);
      const packAudit = audits.find((a) => a.type === "evidence_pack_versioned");
      expect(packAudit).toBeDefined();
      expect(packAudit?.evidencePackId).toBe("pack-phase3-1");
      expect(packAudit?.evidencePackVersion).toBe(1);
      expect(packAudit?.evidencePackHash).toBe(pack.contentHash);
      expect(packAudit?.reason).toContain("v1");
    });

    it("在非 GATHERING_EVIDENCE 状态下抛 IllegalTransitionError", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      // 任务处于 CREATED 状态
      await expect(
        orchestrator.gatherEvidenceAndCreatePack({
          taskId: task.id,
          packId: "pack-illegal",
          evidence: []
        })
      ).rejects.toBeInstanceOf(IllegalTransitionError);

      // 任务保持原状态，Pack 未被持久化
      const unchanged = await store.tasks.findById(task.id);
      expect(unchanged?.status).toBe("CREATED");
      const pack = await store.evidencePacks.findById("pack-illegal");
      expect(pack).toBeUndefined();
    });
  });

  describe("Phase 3 evolvePackWithNewEvidence", () => {
    it("基于上一版本生成 v2，旧版本保留（findVersions 返回 [v1, v2]）", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "GATHERING_EVIDENCE");

      // 1. 生成 Pack v1
      await orchestrator.gatherEvidenceAndCreatePack({
        taskId: task.id,
        packId: "pack-evolve-1",
        evidence: [sampleEvidenceItem()],
        acceptanceCriteria: ["pytest tests/test_users.py 通过"]
      });

      // 2. 提交 EvidenceRequest（任务保持在 GATHERING_EVIDENCE）
      const req = await orchestrator.submitEvidenceRequest({
        taskId: task.id,
        requesterRole: "planner",
        gapReason: "需要 git blame 证据确认回归提交",
        neededKinds: ["git"],
        allowedScope: "仓库历史",
        expectedPlanImpact: "补充回归假设"
      });

      // 3. 基于 request 升级 Pack
      const newPack = await orchestrator.evolvePackWithNewEvidence({
        taskId: task.id,
        requestId: req.id,
        additions: {
          evidence: [sampleEvidenceItem({ id: "ev-2", kind: "git", source: "git-history" })],
          hypotheses: [
            { text: "commit abc 引入回归", confidence: 0.6, evidenceIds: ["ev-2"] }
          ]
        }
      });

      // v2 已生成
      expect(newPack.version).toBe(2);
      expect(newPack.evidence).toHaveLength(2);

      // 旧版本保留
      const versions = await store.evidencePacks.findVersions("pack-evolve-1");
      expect(versions.map((v) => v.version)).toEqual([1, 2]);

      // task.currentEvidencePackVersion 更新为 2
      const updatedTask = await store.tasks.findById(task.id);
      expect(updatedTask?.currentEvidencePackVersion).toBe(2);

      // 审计事件记录版本升级
      const audits = await store.audit.findByTask(task.id);
      const versionedAudits = audits.filter((a) => a.type === "evidence_pack_versioned");
      expect(versionedAudits).toHaveLength(2);
      const v2Audit = versionedAudits.find((a) => a.evidencePackVersion === 2);
      expect(v2Audit).toBeDefined();
      expect(v2Audit?.reason).toContain("升级");
    });
  });

  describe("Phase 3 Pack 不可变约束", () => {
    it("直接对同一 id+version 二次 save 抛 EvidencePackVersionError", async () => {
      const packId = "pack-immutable-test";
      const v1 = sampleEvidencePack(packId, 1, "task-immutable");

      // 第一次 save 成功
      await store.evidencePacks.save(v1);

      // 第二次 save 同一版本抛 EvidencePackVersionError
      await expect(store.evidencePacks.save(v1)).rejects.toBeInstanceOf(
        EvidencePackVersionError
      );
    });
  });

  describe("Phase 3 attachWorktree", () => {
    it("写 task.worktreeId 并追加 worktree_created 审计事件", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      const wt = sampleWorktree(task.id);

      const updated = await orchestrator.attachWorktree(task.id, wt);

      expect(updated.worktreeId).toBe("wt-test-1");

      const stored = await store.tasks.findById(task.id);
      expect(stored?.worktreeId).toBe("wt-test-1");

      const audits = await store.audit.findByTask(task.id);
      const wtAudit = audits.find((a) => a.type === "worktree_created");
      expect(wtAudit).toBeDefined();
      expect(wtAudit?.reason).toContain("worktree");
    });

    it("任务不存在时抛 TaskNotFoundError", async () => {
      const wt = sampleWorktree("nope");
      await expect(
        orchestrator.attachWorktree("nope", wt)
      ).rejects.toBeInstanceOf(TaskNotFoundError);
    });
  });

  describe("Phase 3 submitEvidenceRequest", () => {
    it("在 EXECUTING 状态下迁移到 EVIDENCE_GAP 并写 evidence_request_submitted 审计", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "EXECUTING");

      const req = await orchestrator.submitEvidenceRequest({
        taskId: task.id,
        requesterRole: "developer",
        gapReason: "执行时发现缺少 runtime 堆栈证据",
        neededKinds: ["runtime"],
        allowedScope: "运行测试捕获堆栈",
        expectedPlanImpact: "需要补充运行时证据后调整修改方案"
      });

      expect(req.requesterRole).toBe("developer");
      expect(req.gapReason).toContain("runtime");

      // 任务迁移到 EVIDENCE_GAP
      const updated = await store.tasks.findById(task.id);
      expect(updated?.status).toBe("EVIDENCE_GAP");

      // 审计事件记录迁移与原因
      const audits = await store.audit.findByTask(task.id);
      const submitAudit = audits.find((a) => a.type === "evidence_request_submitted");
      expect(submitAudit).toBeDefined();
      expect(submitAudit?.fromStatus).toBe("EXECUTING");
      expect(submitAudit?.toStatus).toBe("EVIDENCE_GAP");
      expect(submitAudit?.reason).toBe(req.gapReason);
    });

    it("在 GATHERING_EVIDENCE 状态下保持原状态", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "GATHERING_EVIDENCE");

      await orchestrator.submitEvidenceRequest({
        taskId: task.id,
        requesterRole: "planner",
        gapReason: "需要更多 code 证据",
        neededKinds: ["code"],
        allowedScope: "worktree 内代码",
        expectedPlanImpact: "补充代码证据后细化计划"
      });

      // 任务保持 GATHERING_EVIDENCE
      const updated = await store.tasks.findById(task.id);
      expect(updated?.status).toBe("GATHERING_EVIDENCE");

      // 审计事件仍被写入
      const audits = await store.audit.findByTask(task.id);
      const submitAudit = audits.find((a) => a.type === "evidence_request_submitted");
      expect(submitAudit).toBeDefined();
      expect(submitAudit?.fromStatus).toBe("GATHERING_EVIDENCE");
      expect(submitAudit?.toStatus).toBe("GATHERING_EVIDENCE");
    });

    it("任务不存在时抛 TaskNotFoundError", async () => {
      await expect(
        orchestrator.submitEvidenceRequest({
          taskId: "nope",
          requesterRole: "planner",
          gapReason: "无",
          neededKinds: ["code"],
          allowedScope: "无",
          expectedPlanImpact: "无"
        })
      ).rejects.toBeInstanceOf(TaskNotFoundError);
    });
  });
});
