import { describe, expect, it, beforeEach } from "vitest";
import {
  TaskOrchestrator,
  createInMemoryStore,
  IllegalTransitionError,
  TaskNotFoundError,
  TerminalTaskError,
  ScopeMismatchError,
  InvalidApprovalStateError,
  computeScopeHash,
  isApprovalInvalidated,
  type TaskInput,
  type TaskStatus,
  type EvidencePack,
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

describe("TaskOrchestrator", () => {
  let store: InMemoryStore;
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    store = createInMemoryStore();
    orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
  });

  /** 把任务从 CREATED 一路迁移到目标状态（跳过审批闸门由调用方自理）。 */
  async function moveTo(taskId: string, target: TaskStatus): Promise<void> {
    // 进入 EXECUTING 必须经 beginExecutionIfApproved（P1-R02），因此
    // 到达 AWAITING_EXECUTION_APPROVAL 后签发一份执行审批再继续。
    const preExec: readonly TaskStatus[] = [
      "INTAKING", "GATHERING_EVIDENCE", "PLANNED", "AWAITING_EXECUTION_APPROVAL"
    ];
    const execAndBeyond: Partial<Record<TaskStatus, readonly TaskStatus[]>> = {
      EXECUTING: ["EXECUTING"],
      EVIDENCE_GAP: ["EXECUTING", "EVIDENCE_GAP"],
      VALIDATING: ["EXECUTING", "VALIDATING"],
      REVIEWING: ["EXECUTING", "VALIDATING", "REVIEWING"],
      AWAITING_HUMAN_APPROVAL: ["EXECUTING", "VALIDATING", "REVIEWING", "AWAITING_HUMAN_APPROVAL"]
    };

    // 1. 走到目标或 AWAITING_EXECUTION_APPROVAL（取较早者）。
    const preExecTargetIdx = preExec.indexOf(target);
    const stopIdx = preExecTargetIdx >= 0 ? preExecTargetIdx : preExec.length - 1;
    for (let i = 0; i <= stopIdx; i++) {
      await orchestrator.transitionTask(taskId, preExec[i]!);
    }
    if (preExecTargetIdx >= 0) return; // 目标在 EXECUTING 之前

    // 2. 签发执行审批并经 beginExecutionIfApproved 进入 EXECUTING。
    const scope = computeScopeHash({
      allowedPaths: ["src/**"],
      commandWhitelist: ["pytest"],
      riskLevel: "low"
    });
    await orchestrator.recordApproval({
      taskId,
      kind: "execution",
      approver: "mover",
      decision: "approved",
      scopeHash: scope
    });
    await orchestrator.beginExecutionIfApproved(taskId, scope);

    // 3. 继续走 EXECUTING 之后的步骤（EXECUTING 本身已完成，跳过）。
    const tail = execAndBeyond[target]?.slice(1) ?? [];
    for (const s of tail) {
      await orchestrator.transitionTask(taskId, s);
    }
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

      await orchestrator.transitionTask(task.id, "INTAKING");
      await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE");
      await orchestrator.transitionTask(task.id, "PLANNED");
      await orchestrator.transitionTask(task.id, "AWAITING_EXECUTION_APPROVAL");
      // P1-R02：进入 EXECUTING 必须经 beginExecutionIfApproved，不得用
      // 通用 transitionTask 接口。先签发执行审批，再校验 scopeHash 进入。
      const scope = computeScopeHash({
        allowedPaths: ["src/**"],
        commandWhitelist: ["pytest"],
        riskLevel: "low"
      });
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "tester",
        decision: "approved",
        scopeHash: scope
      });
      await orchestrator.beginExecutionIfApproved(task.id, scope);
      await orchestrator.transitionTask(task.id, "VALIDATING");
      await orchestrator.transitionTask(task.id, "REVIEWING");
      await orchestrator.transitionTask(task.id, "AWAITING_HUMAN_APPROVAL");

      const final = await store.tasks.findById(task.id);
      expect(final?.status).toBe("AWAITING_HUMAN_APPROVAL");

      // 1 条创建 + 4 条迁移到 AWAITING_EXECUTION_APPROVAL + 1 条执行审批 +
      // 1 条进入 EXECUTING 迁移 + 3 条迁移到 AWAITING_HUMAN_APPROVAL = 10 条
      const audits = await store.audit.findByTask(task.id);
      expect(audits).toHaveLength(10);
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
      await moveTo(task.id, "AWAITING_HUMAN_APPROVAL");
      await orchestrator.completeIfEligible({
        taskId: task.id,
        validationPassed: true,
        hasP0OrP1ReviewFindings: false,
        hasHumanApproval: true
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
      const scopeHash = computeScopeHash({
        allowedPaths: ["src/users/**"],
        commandWhitelist: ["pytest"],
        riskLevel: "low"
      });

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

    it("在 AWAITING_HUMAN_APPROVAL 持久化人类审批拒绝并写审计", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_HUMAN_APPROVAL");
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "human",
        approver: "bob",
        decision: "rejected",
        scopeHash: "scope-x",
        reason: "修复未触及根因"
      });

      const audits = await store.audit.findByTask(task.id);
      expect(audits.some((a) => a.type === "human_approval_rejected")).toBe(true);
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
      const scopeHash = computeScopeHash({
        allowedPaths: ["src/users/**"],
        commandWhitelist: ["pytest"],
        riskLevel: "low"
      });
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash
      });

      // scopeHash 一致 → 可进入 EXECUTING
      const executing = await orchestrator.beginExecutionIfApproved(task.id, scopeHash);
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
      const oldScope = computeScopeHash({
        allowedPaths: ["src/users/**"],
        commandWhitelist: ["pytest"],
        riskLevel: "low"
      });
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash: oldScope
      });

      // 进入 EXECUTING，遇到 EVIDENCE_GAP，扩大范围回到 GATHERING_EVIDENCE
      await orchestrator.beginExecutionIfApproved(task.id, oldScope);
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
      const oldScope = computeScopeHash({
        allowedPaths: ["src/users/**"],
        commandWhitelist: ["pytest"],
        riskLevel: "low"
      });
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash: oldScope
      });
      await orchestrator.beginExecutionIfApproved(task.id, oldScope);
      await orchestrator.transitionTask(task.id, "EVIDENCE_GAP");
      await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE", {
        widenScope: true,
        reason: "扩大范围"
      });
      // 重新规划 → AWAITING_EXECUTION_APPROVAL，但还没取得新审批
      await orchestrator.transitionTask(task.id, "PLANNED");
      await orchestrator.transitionTask(task.id, "AWAITING_EXECUTION_APPROVAL");

      const newScope = computeScopeHash({
        allowedPaths: ["src/users/**", "src/auth/**"],
        commandWhitelist: ["pytest", "ruff"],
        riskLevel: "medium"
      });

      // 旧审批已失效，新审批未签发 → 拒绝进入 EXECUTING
      await expect(
        orchestrator.beginExecutionIfApproved(task.id, newScope)
      ).rejects.toBeInstanceOf(ScopeMismatchError);
    });

    it("scopeHash 不一致时拒绝进入 EXECUTING（抛 ScopeMismatchError）", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_EXECUTION_APPROVAL");
      const approvedScope = computeScopeHash({
        allowedPaths: ["src/users/**"],
        commandWhitelist: ["pytest"],
        riskLevel: "low"
      });
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash: approvedScope
      });

      const differentScope = computeScopeHash({
        allowedPaths: ["src/users/**", "src/auth/**"],
        commandWhitelist: ["pytest"],
        riskLevel: "low"
      });

      await expect(
        orchestrator.beginExecutionIfApproved(task.id, differentScope)
      ).rejects.toBeInstanceOf(ScopeMismatchError);
    });

    it("失效事件和新批准均可在审计时间线中查到", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_EXECUTION_APPROVAL");
      const oldScope = computeScopeHash({
        allowedPaths: ["src/users/**"],
        commandWhitelist: ["pytest"],
        riskLevel: "low"
      });
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash: oldScope
      });
      await orchestrator.beginExecutionIfApproved(task.id, oldScope);
      await orchestrator.transitionTask(task.id, "EVIDENCE_GAP");
      await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE", {
        widenScope: true,
        reason: "扩大范围"
      });
      await orchestrator.transitionTask(task.id, "PLANNED");
      await orchestrator.transitionTask(task.id, "AWAITING_EXECUTION_APPROVAL");
      const newScope = computeScopeHash({
        allowedPaths: ["src/users/**", "src/auth/**"],
        commandWhitelist: ["pytest", "ruff"],
        riskLevel: "medium"
      });
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
      const executing = await orchestrator.beginExecutionIfApproved(task.id, newScope);
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
      const scope = computeScopeHash({
        allowedPaths: ["src/**"],
        commandWhitelist: ["pytest"],
        riskLevel: "low"
      });

      await expect(
        orchestrator.beginExecutionIfApproved(task.id, scope)
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
      const scope = computeScopeHash({
        allowedPaths: ["src/**"],
        commandWhitelist: ["pytest"],
        riskLevel: "low"
      });
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
        orchestrator.beginExecutionIfApproved(task.id, scope)
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
      const oldScope = computeScopeHash({
        allowedPaths: ["src/users/**"],
        commandWhitelist: ["pytest"],
        riskLevel: "low"
      });
      await orchestrator.recordApproval({
        taskId: task.id,
        kind: "execution",
        approver: "alice",
        decision: "approved",
        scopeHash: oldScope
      });
      // 进入 EXECUTING → EVIDENCE_GAP → 扩大范围回 GATHERING_EVIDENCE，
      // 旧审批在同一事务内失效。
      await orchestrator.beginExecutionIfApproved(task.id, oldScope);
      await orchestrator.transitionTask(task.id, "EVIDENCE_GAP");
      await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE", {
        widenScope: true,
        reason: "扩大范围"
      });
      await orchestrator.transitionTask(task.id, "PLANNED");
      await orchestrator.transitionTask(task.id, "AWAITING_EXECUTION_APPROVAL");

      // 旧审批已失效，findLatestExecutionApproval 返回 undefined。
      const latest = await store.approvals.findLatestExecutionApproval(task.id);
      expect(latest).toBeUndefined();

      // 即使传入与旧审批一致的 scopeHash，也因无有效审批被拒绝。
      await expect(
        orchestrator.beginExecutionIfApproved(task.id, oldScope)
      ).rejects.toBeInstanceOf(ScopeMismatchError);

      const unchanged = await store.tasks.findById(task.id);
      expect(unchanged?.status).toBe("AWAITING_EXECUTION_APPROVAL");
    });
  });

  describe("completeIfEligible", () => {
    it("验证通过、评审洁净、人类审批已记录时完成任务", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_HUMAN_APPROVAL");

      const completed = await orchestrator.completeIfEligible({
        taskId: task.id,
        validationPassed: true,
        hasP0OrP1ReviewFindings: false,
        hasHumanApproval: true
      });
      expect(completed.status).toBe("COMPLETED");
    });

    it("验证未通过时拒绝完成", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_HUMAN_APPROVAL");

      await expect(
        orchestrator.completeIfEligible({
          taskId: task.id,
          validationPassed: false,
          hasP0OrP1ReviewFindings: false,
          hasHumanApproval: true
        })
      ).rejects.toBeInstanceOf(IllegalTransitionError);
    });

    it("评审有 P0/P1 时拒绝完成", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_HUMAN_APPROVAL");

      await expect(
        orchestrator.completeIfEligible({
          taskId: task.id,
          validationPassed: true,
          hasP0OrP1ReviewFindings: true,
          hasHumanApproval: true
        })
      ).rejects.toBeInstanceOf(IllegalTransitionError);
    });

    it("缺少人类审批时拒绝完成", async () => {
      const task = await orchestrator.createTask({
        projectId: "proj-1",
        input: sampleTaskInput()
      });
      await moveTo(task.id, "AWAITING_HUMAN_APPROVAL");

      await expect(
        orchestrator.completeIfEligible({
          taskId: task.id,
          validationPassed: true,
          hasP0OrP1ReviewFindings: false,
          hasHumanApproval: false
        })
      ).rejects.toBeInstanceOf(IllegalTransitionError);
    });
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
});
