/**
 * 组合根冒烟测试——Phase 1。
 *
 * 在不启动真实服务器的情况下验证 API 装配能正确响应。
 * Phase 2 将增加针对 SQLite 的集成测试；Phase 6 将增加
 * SSE 韧性测试。
 */

import { describe, expect, it } from "vitest";
import { buildCompositionRoot } from "../src/composition-root.js";
import type { TaskInput } from "@tracepilot/core";

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

describe("API 组合根", () => {
  it("GET /health 返回 200 并带 phase-1-skeleton 标记", async () => {
    const { app } = buildCompositionRoot();
    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; phase: string; runtime: string; store: string };
      expect(body.status).toBe("ok");
      expect(body.phase).toBe("phase-1-skeleton");
      expect(body.runtime).toBe("LocalCommandAdapter");
      expect(body.store).toBe("InMemory");
    } finally {
      await app.close();
    }
  });

  it("GET /governance 列出激活的默认策略", async () => {
    const { app } = buildCompositionRoot();
    try {
      const res = await app.inject({ method: "GET", url: "/governance" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { commandPolicy: string; pathPolicy: string };
      expect(body.commandPolicy).toBe("DefaultCommandPolicy");
      expect(body.pathPolicy).toBe("DefaultPathPolicy");
    } finally {
      await app.close();
    }
  });

  it("POST /tasks 创建 CREATED 状态的任务并返回 201", async () => {
    const { app } = buildCompositionRoot();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { id: string; status: string; projectId: string };
      expect(body.status).toBe("CREATED");
      expect(body.projectId).toBe("proj-1");
    } finally {
      await app.close();
    }
  });

  it("缺少 projectId 或 input 时 POST /tasks 返回 400", async () => {
    const { app } = buildCompositionRoot();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: {}
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("完整任务生命周期：创建 → 迁移 → 审计时间线", async () => {
    const { app } = buildCompositionRoot();
    try {
      // 创建
      const createRes = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      const task = createRes.json() as { id: string };
      expect(createRes.statusCode).toBe(201);

      // 迁移 CREATED → INTAKING
      const transRes = await app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "INTAKING", reason: "intake started" }
      });
      expect(transRes.statusCode).toBe(200);
      expect((transRes.json() as { status: string }).status).toBe("INTAKING");

      // 审计时间线应有 2 个事件：task_created + task_transitioned
      const auditRes = await app.inject({
        method: "GET",
        url: `/tasks/${task.id}/audit`
      });
      expect(auditRes.statusCode).toBe(200);
      const audits = auditRes.json() as Array<{ type: string }>;
      expect(audits).toHaveLength(2);
      expect(audits[0]!.type).toBe("task_created");
      expect(audits[1]!.type).toBe("task_transitioned");
    } finally {
      await app.close();
    }
  });

  it("POST /tasks/:taskId/cancel 取消 CREATED 状态的任务", async () => {
    const { app } = buildCompositionRoot();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      const task = createRes.json() as { id: string };

      const cancelRes = await app.inject({
        method: "POST",
        url: `/tasks/${task.id}/cancel`,
        payload: { reason: "user requested" }
      });
      expect(cancelRes.statusCode).toBe(200);
      expect((cancelRes.json() as { status: string }).status).toBe("CANCELLED");
    } finally {
      await app.close();
    }
  });

  it("非法迁移返回 400 及错误消息", async () => {
    const { app } = buildCompositionRoot();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      const task = createRes.json() as { id: string };

      // CREATED → EXECUTING 是非法迁移（跳过 intake/evidence/plan/approval）。
      // P1-R02：任何以 EXECUTING 为目标的 transitionTask 调用都被拒绝。
      const transRes = await app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "EXECUTING" }
      });
      expect(transRes.statusCode).toBe(400);
      const body = transRes.json() as { error: string };
      expect(body.error).toMatch(/EXECUTING/);
    } finally {
      await app.close();
    }
  });

  it("P1-R02：API 不得绕过执行审批，从 AWAITING_EXECUTION_APPROVAL 经 /transition 到 EXECUTING 返回 400", async () => {
    const { app } = buildCompositionRoot();
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: "proj-1", input: sampleInput() }
      });
      const task = createRes.json() as { id: string };

      // 沿合法路径迁移到 AWAITING_EXECUTION_APPROVAL。
      for (const to of ["INTAKING", "GATHERING_EVIDENCE", "PLANNED", "AWAITING_EXECUTION_APPROVAL"]) {
        const res = await app.inject({
          method: "POST",
          url: `/tasks/${task.id}/transition`,
          payload: { to }
        });
        expect(res.statusCode).toBe(200);
      }

      // 即使处于 AWAITING_EXECUTION_APPROVAL（状态机允许到 EXECUTING），
      // API 的 /transition 端点也必须拒绝 —— 进入 EXECUTING 只能经
      // beginExecutionIfApproved 并校验有效执行审批与 scopeHash。
      const transRes = await app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "EXECUTING" }
      });
      expect(transRes.statusCode).toBe(400);
      const body = transRes.json() as { error: string; status?: string };
      expect(body.error).toMatch(/EXECUTING/);

      // 任务保持 AWAITING_EXECUTION_APPROVAL，未进入执行态。
      const getRes = await app.inject({
        method: "GET",
        url: `/tasks/${task.id}`
      });
      const taskAfter = getRes.json() as { status: string };
      expect(taskAfter.status).toBe("AWAITING_EXECUTION_APPROVAL");
    } finally {
      await app.close();
    }
  });

  it("GET /tasks/:taskId 对未知任务返回 404", async () => {
    const { app } = buildCompositionRoot();
    try {
      const res = await app.inject({ method: "GET", url: "/tasks/nope" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
