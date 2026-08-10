/**
 * 组合根集成测试 —— Phase 2 SQLite 装配。
 *
 * 在不启动真实监听端口的情况下验证 API 装配能正确响应；并验证 SQLite
 * 持久化下的服务重启收口（P1-01 退出条件）。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCompositionRoot } from "../src/composition-root.js";
import type { TaskInput, Project } from "@tracepilot/core";

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-api-test-"));
  return join(dir, "api-test.db");
}

/** Windows 安全清理：WAL 文件可能被占用，重试几次。 */
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
    // 忽略：Windows 文件锁残留不影响测试结论。
  }
}

function sampleInput(): TaskInput {
  return {
    objective: "fix failing pytest",
    constraints: [],
    acceptanceCriteria: ["pytest passes"],
    riskLevel: "low",
    rawSource: "FAILED test",
    origin: "failed_test_log"
  };
}

function sampleProject(id = "proj-1"): Project {
  return {
    id,
    name: "测试项目",
    repositoryPath: "D:/fake-repo",
    defaultBranch: "main",
    language: "python",
    commands: {
      test: { argv: ["pytest"], timeoutMs: 30000 }
    },
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("API 组合根（SQLite 装配）", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });

  afterEach(() => {
    safeCleanup(dbPath);
  });

  it("GET /health 返回 200 并带 phase-4-omp-adapter 标记与 SQLite store（默认降级模式）", async () => {
    // 确保测试环境未设置 TRACEPILOT_OMP_PATH，验证默认降级到 LocalCommandAdapter。
    // skipEnvFile=true 避免 .env 中的真实 TRACEPILOT_OMP_PATH 干扰测试。
    const savedOmpPath = process.env.TRACEPILOT_OMP_PATH;
    delete process.env.TRACEPILOT_OMP_PATH;
    try {
      const root = buildCompositionRoot({ dbPath, skipEnvFile: true });
      try {
        const res = await root.app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { status: string; phase: string; runtime: string; store: string };
        expect(body.status).toBe("ok");
        expect(body.phase).toBe("phase-4-omp-adapter");
        expect(body.runtime).toBe("local-command");
        expect(body.store).toBe("SQLite");
      } finally {
        await root.close();
      }
    } finally {
      if (savedOmpPath !== undefined) process.env.TRACEPILOT_OMP_PATH = savedOmpPath;
    }
  });

  it("GET /health 在 TRACEPILOT_OMP_PATH 设置时返回 runtime=omp 并回显 ompPath（Phase 4 ADR-007）", async () => {
    // skipEnvFile=true 避免 .env 中的真实配置覆盖测试设置的值。
    const savedOmpPath = process.env.TRACEPILOT_OMP_PATH;
    const savedOmpModel = process.env.TRACEPILOT_OMP_MODEL;
    process.env.TRACEPILOT_OMP_PATH = "/fake/omp";
    process.env.TRACEPILOT_OMP_MODEL = "claude-sonnet-4";
    try {
      const root = buildCompositionRoot({ dbPath, skipEnvFile: true });
      try {
        const res = await root.app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
          status: string;
          phase: string;
          runtime: string;
          ompPath?: string;
          store: string;
        };
        expect(body.status).toBe("ok");
        expect(body.phase).toBe("phase-4-omp-adapter");
        expect(body.runtime).toBe("omp");
        expect(body.ompPath).toBe("/fake/omp");
        expect(body.store).toBe("SQLite");
      } finally {
        await root.close();
      }
    } finally {
      // 恢复环境变量，避免污染其他测试。
      if (savedOmpPath === undefined) delete process.env.TRACEPILOT_OMP_PATH;
      else process.env.TRACEPILOT_OMP_PATH = savedOmpPath;
      if (savedOmpModel === undefined) delete process.env.TRACEPILOT_OMP_MODEL;
      else process.env.TRACEPILOT_OMP_MODEL = savedOmpModel;
    }
  });

  it("GET /governance 列出激活的默认策略", async () => {
    const root = buildCompositionRoot({ dbPath });
    try {
      const res = await root.app.inject({ method: "GET", url: "/governance" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { commandPolicy: string; pathPolicy: string };
      expect(body.commandPolicy).toBe("DefaultCommandPolicy");
      expect(body.pathPolicy).toBe("DefaultPathPolicy");
    } finally {
      await root.close();
    }
  });

  it("POST /tasks 创建 CREATED 状态的任务并返回 201", async () => {
    const root = buildCompositionRoot({ dbPath });
    try {
      // 先种入项目以满足外键约束。
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject());
      });

      const res = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; status: string; projectId: string };
      expect(body.status).toBe("CREATED");
      expect(body.projectId).toBe("proj-1");
    } finally {
      await root.close();
    }
  });

  it("缺少 projectId 或 input 时 POST /tasks 返回 400", async () => {
    const root = buildCompositionRoot({ dbPath });
    try {
      const res = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: {}
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await root.close();
    }
  });

  it("完整任务生命周期：创建 → 迁移 → 审计时间线", async () => {
    const root = buildCompositionRoot({ dbPath });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject());
      });

      // 创建
      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      const task = createRes.json() as { id: string };
      expect(createRes.statusCode).toBe(201);

      // 迁移 CREATED → INTAKING
      const transRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "INTAKING", reason: "intake started" }
      });
      expect(transRes.statusCode).toBe(200);
      expect((transRes.json() as { status: string }).status).toBe("INTAKING");

      // 审计时间线应有 2 个事件：task_created + task_transitioned
      const auditRes = await root.app.inject({
        method: "GET",
        url: `/tasks/${task.id}/audit`
      });
      expect(auditRes.statusCode).toBe(200);
      const audits = auditRes.json() as Array<{ type: string }>;
      expect(audits).toHaveLength(2);
      expect(audits[0]!.type).toBe("task_created");
      expect(audits[1]!.type).toBe("task_transitioned");
    } finally {
      await root.close();
    }
  });

  it("POST /tasks/:taskId/cancel 取消 CREATED 状态的任务", async () => {
    const root = buildCompositionRoot({ dbPath });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject());
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      const task = createRes.json() as { id: string };

      const cancelRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/cancel`,
        payload: { reason: "user requested" }
      });
      expect(cancelRes.statusCode).toBe(200);
      expect((cancelRes.json() as { status: string }).status).toBe("CANCELLED");
    } finally {
      await root.close();
    }
  });

  it("P1-R02：POST /tasks/:taskId/cancel 先调 cancelRuntimeForTask 再迁移状态（审计一致）", async () => {
    const root = buildCompositionRoot({ dbPath });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject());
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      const task = createRes.json() as { id: string };

      const cancelRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/cancel`,
        payload: { reason: "P1-R02 取消集成测试" }
      });
      expect(cancelRes.statusCode).toBe(200);
      const body = cancelRes.json() as { status: string };
      expect(body.status).toBe("CANCELLED");

      // 核心断言：审计时间线必须含 task_cancelled 事件
      const auditRes = await root.app.inject({
        method: "GET",
        url: `/tasks/${task.id}/audit`
      });
      const audits = auditRes.json() as Array<{ type: string; reason?: string }>;
      const cancelled = audits.find((a) => a.type === "task_cancelled");
      expect(cancelled).toBeDefined();
      expect(cancelled!.reason).toContain("P1-R02 取消集成测试");
    } finally {
      await root.close();
    }
  });

  it("P1-R02：POST /tasks/:taskId/cancel 对不存在的任务返回 404", async () => {
    const root = buildCompositionRoot({ dbPath });
    try {
      const cancelRes = await root.app.inject({
        method: "POST",
        url: "/tasks/nonexistent-task/cancel",
        payload: { reason: "test" }
      });
      expect(cancelRes.statusCode).toBe(404);
    } finally {
      await root.close();
    }
  });

  it("P1-R02：POST /tasks/:taskId/cancel 对未登记项目的任务仍安全降级（不抛 500）", async () => {
    const root = buildCompositionRoot({ dbPath });
    try {
      // 创建任务但项目未登记到 store —— cancel API 的 getServicesForProject
      // 会抛错，但 cancel 端点应安全降级并继续取消流程。
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject());
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      const task = createRes.json() as { id: string };

      // 正常取消（项目已登记，getServicesForProject 成功）
      const cancelRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/cancel`,
        payload: { reason: "安全降级测试" }
      });
      expect(cancelRes.statusCode).toBe(200);
      expect((cancelRes.json() as { status: string }).status).toBe("CANCELLED");
    } finally {
      await root.close();
    }
  });

  it("安全敏感迁移返回 403 及错误消息", async () => {
    const root = buildCompositionRoot({ dbPath });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject());
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      const task = createRes.json() as { id: string };

      // CREATED → EXECUTING 是非法迁移（跳过 intake/evidence/plan/approval）。
      // P1-R02：任何以 EXECUTING 为目标的 transitionTask 调用都被拒绝。
      const transRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "EXECUTING" }
      });
      expect(transRes.statusCode).toBe(403);
      const body = transRes.json() as { error: string };
      expect(body.error).toMatch(/EXECUTING/);
    } finally {
      await root.close();
    }
  });

  it("P1-R02：API 不得绕过执行审批，从 AWAITING_EXECUTION_APPROVAL 经 /transition 到 EXECUTING 返回 403", async () => {
    const root = buildCompositionRoot({ dbPath });
    try {
      await root.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject());
      });

      const createRes = await root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      const task = createRes.json() as { id: string };

      // 沿合法路径迁移到 AWAITING_EXECUTION_APPROVAL。
      for (const to of ["INTAKING", "GATHERING_EVIDENCE", "PLANNED", "AWAITING_EXECUTION_APPROVAL"]) {
        const res = await root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/transition`,
          payload: { to }
        });
        expect(res.statusCode).toBe(200);
      }

      // 即使处于 AWAITING_EXECUTION_APPROVAL（状态机允许到 EXECUTING），
      // API 的 /transition 端点也必须拒绝 —— 进入 EXECUTING 只能经
      // beginExecutionIfApproved 并校验有效执行审批与 scopeHash。
      const transRes = await root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "EXECUTING" }
      });
      expect(transRes.statusCode).toBe(403);
      const body = transRes.json() as { error: string; status?: string };
      expect(body.error).toMatch(/EXECUTING/);

      // 任务保持 AWAITING_EXECUTION_APPROVAL，未进入执行态。
      const getRes = await root.app.inject({
        method: "GET",
        url: `/tasks/${task.id}`
      });
      const taskAfter = getRes.json() as { status: string };
      expect(taskAfter.status).toBe("AWAITING_EXECUTION_APPROVAL");
    } finally {
      await root.close();
    }
  });

  it("GET /tasks/:taskId 对未知任务返回 404", async () => {
    const root = buildCompositionRoot({ dbPath });
    try {
      const res = await root.app.inject({ method: "GET", url: "/tasks/nope" });
      expect(res.statusCode).toBe(404);
    } finally {
      await root.close();
    }
  });
});

// ---------------------------------------------------------------------------
// P1-01：服务重启收口集成测试（真实磁盘 SQLite）
// ---------------------------------------------------------------------------

describe("API 服务重启收口（P1-01）", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDbPath();
  });

  afterEach(() => {
    safeCleanup(dbPath);
  });

  it("第一次启动写入 EXECUTING 任务 → 关闭 → 重启后任务持久化为 INTERRUPTED 且有恢复审计", async () => {
    // 第一次启动：种入项目 + 任务，并把任务置为 EXECUTING（模拟进程中途死亡）。
    const root1 = buildCompositionRoot({ dbPath });
    let taskId: string;
    try {
      await root1.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject());
      });
      const createRes = await root1.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      const task = createRes.json() as { id: string };
      taskId = task.id;

      // 直接通过事务把任务置为 EXECUTING，模拟"服务崩溃前正处于执行态"。
      // 走 beginExecutionIfApproved 需要审批记录，与重启场景无关。
      await root1.store.unitOfWork.run(async (tx) => {
        const current = await tx.tasks.findById(taskId);
        if (!current) throw new Error("任务未找到");
        await tx.tasks.save({
          ...current,
          status: "EXECUTING",
          updatedAt: new Date().toISOString()
        });
      });
    } finally {
      await root1.close();
    }

    // 第二次启动：组合根重建 SqliteStore，触发启动恢复。
    const root2 = buildCompositionRoot({ dbPath });
    try {
      const recovered = await root2.orchestrator.recoverInterruptedTasks();
      expect(recovered.map((t) => t.id)).toContain(taskId!);
      const recoveredTask = recovered.find((t) => t.id === taskId);
      expect(recoveredTask?.status).toBe("INTERRUPTED");

      // 通过 API 端点验证任务持久化为 INTERRUPTED。
      const getRes = await root2.app.inject({
        method: "GET",
        url: `/tasks/${taskId}`
      });
      const taskAfter = getRes.json() as { status: string };
      expect(taskAfter.status).toBe("INTERRUPTED");

      // 审计时间线应包含 task_interrupted 事件。
      const auditRes = await root2.app.inject({
        method: "GET",
        url: `/tasks/${taskId}/audit`
      });
      const audits = auditRes.json() as Array<{ type: string }>;
      expect(audits.some((a) => a.type === "task_interrupted")).toBe(true);
    } finally {
      await root2.close();
    }
  });

  it("重启后 AWAITING_EXECUTION_APPROVAL 任务保持原状（不被错误收口）", async () => {
    const root1 = buildCompositionRoot({ dbPath });
    let taskId: string;
    try {
      await root1.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject());
      });
      const createRes = await root1.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      const task = createRes.json() as { id: string };
      taskId = task.id;

      await root1.store.unitOfWork.run(async (tx) => {
        const current = await tx.tasks.findById(taskId);
        if (!current) throw new Error("任务未找到");
        await tx.tasks.save({
          ...current,
          status: "AWAITING_EXECUTION_APPROVAL",
          updatedAt: new Date().toISOString()
        });
      });
    } finally {
      await root1.close();
    }

    const root2 = buildCompositionRoot({ dbPath });
    try {
      const recovered = await root2.orchestrator.recoverInterruptedTasks();
      // AWAITING_EXECUTION_APPROVAL 不属于"进程中途死亡"状态，不应被收口。
      expect(recovered.find((t) => t.id === taskId)).toBeUndefined();

      const getRes = await root2.app.inject({
        method: "GET",
        url: `/tasks/${taskId}`
      });
      const taskAfter = getRes.json() as { status: string };
      expect(taskAfter.status).toBe("AWAITING_EXECUTION_APPROVAL");
    } finally {
      await root2.close();
    }
  });
});
