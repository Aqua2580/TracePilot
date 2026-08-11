/**
 * Phase 6 Dashboard API 集成测试。
 *
 * 验证 UI 所需的只读投影来自 SQLite 真源，静态资源被限制在 Dashboard
 * 构建目录内，以及 SSE 首帧只提供可恢复任务状态所需的最小元数据。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCompositionRoot, buildTaskSnapshotEvent } from "../src/composition-root.js";
import type { Project, TaskInput } from "@tracepilot/core";
import {
  createDashboardDemoFixture,
  DASHBOARD_DEMO_HUMAN_SECRET
} from "./fixtures/dashboard-demo.js";

function createTempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function safeCleanup(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Windows 上短暂文件锁不影响测试结论。
  }
}

const project: Project = {
  id: "proj-phase6-dashboard",
  name: "Phase 6 看板项目",
  repositoryPath: "D:/fake-phase6-repo",
  defaultBranch: "main",
  language: "typescript",
  commands: { test: { argv: ["pnpm", "test"], timeoutMs: 30000 } },
  createdAt: "2026-08-10T00:00:00.000Z"
};

const input: TaskInput = {
  objective: "在看板中查看受控修复流程",
  constraints: ["不得绕过审批"],
  acceptanceCriteria: ["页面能够恢复任务状态"],
  riskLevel: "low",
  rawSource: "Dashboard 演示任务",
  origin: "issue"
};

/** 读取 SSE 中下一条 task_snapshot，跳过 retry/heartbeat 等非业务帧。 */
class SseSnapshotReader {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async nextTask(timeoutMs = 7000): Promise<{ id: string; status: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const separator = this.buffer.indexOf("\n\n");
      if (separator >= 0) {
        const frame = this.buffer.slice(0, separator);
        this.buffer = this.buffer.slice(separator + 2);
        if (!frame.startsWith("event: task_snapshot\n")) continue;
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) throw new Error("task_snapshot 缺少 data 行");
        const payload = JSON.parse(dataLine.slice("data: ".length)) as {
          task: { id: string; status: string };
        };
        // 快照本身携带完整 Task；本测试只承诺并验证重连所必需的任务标识与状态，
        // 避免把无关的任务输入、时间戳字段误当成 SSE 协议断言。
        return { id: payload.task.id, status: payload.task.status };
      }

      const remaining = Math.max(1, deadline - Date.now());
      const result = await readWithTimeout(this.reader, remaining);
      if (result.done) throw new Error("SSE 在收到 task_snapshot 前关闭");
      this.buffer += this.decoder.decode(result.value, { stream: true });
    }
    throw new Error("等待 SSE task_snapshot 超时");
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("等待 SSE 帧超时")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("Phase 6 Dashboard API", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) safeCleanup(directory);
  });

  it("向看板提供已登记项目、任务、审计和只读空产物视图", async () => {
    const directory = createTempDirectory("tracepilot-phase6-api-");
    directories.push(directory);
    const root = buildCompositionRoot({
      dbPath: join(directory, "dashboard.db"),
      worktreeRoot: join(directory, "worktrees"),
      dashboardDistPath: join(directory, "dashboard-dist"),
      skipEnvFile: true
    });
    try {
      await root.store.unitOfWork.run((tx) => tx.projects.save(project));
      const task = await root.orchestrator.createTask({ projectId: project.id, input });
      await root.orchestrator.transitionTask(task.id, "INTAKING", { reason: "开始整理" });

      const projects = await root.app.inject({ method: "GET", url: "/projects" });
      expect(projects.statusCode).toBe(200);
      expect((projects.json() as { projects: Project[] }).projects).toEqual([project]);

      const tasks = await root.app.inject({ method: "GET", url: `/projects/${project.id}/tasks` });
      expect(tasks.statusCode).toBe(200);
      expect((tasks.json() as { tasks: Array<{ id: string; status: string }> }).tasks).toEqual([
        expect.objectContaining({ id: task.id, status: "INTAKING" })
      ]);

      const [audit, packs, results, approvals, records] = await Promise.all([
        root.app.inject({ method: "GET", url: `/tasks/${task.id}/audit` }),
        root.app.inject({ method: "GET", url: `/tasks/${task.id}/evidence-packs` }),
        root.app.inject({ method: "GET", url: `/tasks/${task.id}/execution-results` }),
        root.app.inject({ method: "GET", url: `/tasks/${task.id}/approvals` }),
        root.app.inject({ method: "GET", url: `/tasks/${task.id}/repair-records` })
      ]);
      expect((audit.json() as Array<{ type: string }>).map((event) => event.type)).toEqual([
        "task_created",
        "task_transitioned"
      ]);
      expect(packs.json()).toEqual({ packs: [] });
      expect(results.json()).toEqual({ source: "controlled-execution-results", results: [] });
      expect(approvals.json()).toEqual({ approvals: [] });
      expect(records.json()).toEqual({ records: [] });
    } finally {
      await root.close();
    }
  });

  it("静态入口只读取 Dashboard 构建目录，并在未构建时失败关闭", async () => {
    const directory = createTempDirectory("tracepilot-phase6-static-");
    directories.push(directory);
    const dashboardDistPath = join(directory, "dashboard-dist");
    mkdirSync(join(dashboardDistPath, "assets"), { recursive: true });
    writeFileSync(join(dashboardDistPath, "index.html"), "<main>TracePilot Dashboard</main>", "utf8");
    writeFileSync(join(dashboardDistPath, "assets", "app.js"), "export {};", "utf8");
    writeFileSync(join(dashboardDistPath, "favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "utf8");
    writeFileSync(join(directory, "secret.txt"), "不得读取", "utf8");

    const root = buildCompositionRoot({
      dbPath: join(directory, "dashboard.db"),
      worktreeRoot: join(directory, "worktrees"),
      dashboardDistPath,
      skipEnvFile: true
    });
    try {
      const [entry, asset, favicon, traversal] = await Promise.all([
        root.app.inject({ method: "GET", url: "/dashboard" }),
        root.app.inject({ method: "GET", url: "/dashboard/assets/app.js" }),
        root.app.inject({ method: "GET", url: "/dashboard/favicon.svg" }),
        root.app.inject({ method: "GET", url: "/dashboard/..%2Fsecret.txt" })
      ]);
      expect(entry.statusCode).toBe(200);
      expect(entry.body).toContain("TracePilot Dashboard");
      expect(entry.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(entry.headers["x-content-type-options"]).toBe("nosniff");
      expect(entry.headers["x-frame-options"]).toBe("DENY");
      expect(asset.headers["content-type"]).toContain("text/javascript");
      expect(favicon.headers["content-type"]).toContain("image/svg+xml");
      expect(traversal.statusCode).toBe(400);
      expect(traversal.body).not.toContain("不得读取");
    } finally {
      await root.close();
    }

    const missingRoot = buildCompositionRoot({
      dbPath: join(directory, "missing.db"),
      worktreeRoot: join(directory, "missing-worktrees"),
      dashboardDistPath: join(directory, "missing-dashboard-dist"),
      skipEnvFile: true
    });
    try {
      const missing = await missingRoot.app.inject({ method: "GET", url: "/dashboard" });
      expect(missing.statusCode).toBe(503);
      expect(missing.json()).toEqual({
        error: "Dashboard 尚未构建，请先运行 pnpm --filter @tracepilot/web build"
      });
    } finally {
      await missingRoot.close();
    }
  });

  it("SSE 首帧携带当前任务和最小审计元信息，不重复发送审计理由", () => {
    const event = buildTaskSnapshotEvent(
      {
        id: "task-phase6-sse",
        projectId: project.id,
        status: "INTAKING",
        input,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:01:00.000Z"
      },
      {
        id: "audit-phase6-sse",
        taskId: "task-phase6-sse",
        type: "task_transitioned",
        reason: "不应通过 SSE 发送的内部理由",
        recordedAt: "2026-08-10T00:01:00.000Z"
      }
    );
    expect(event).toMatch(/^event: task_snapshot\ndata: /);
    expect(event).toContain('"id":"audit-phase6-sse"');
    expect(event).not.toContain("不应通过 SSE 发送的内部理由");
    expect(event).toMatch(/\n\n$/);
  });

  it("真实 SSE 连接在断开后重连，并从 SQLite 读取当前任务状态", async () => {
    const fixture = await createDashboardDemoFixture();
    let firstAbort: AbortController | undefined;
    let firstReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let secondAbort: AbortController | undefined;
    let secondReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const created = await fixture.root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: fixture.project.id, input }
      });
      const taskId = (created.json() as { id: string }).id;
      const baseUrl = await fixture.root.app.listen({ port: 0, host: "127.0.0.1" });

      firstAbort = new AbortController();
      const firstResponse = await fetch(`${baseUrl}/tasks/${taskId}/events`, {
        signal: firstAbort.signal
      });
      expect(firstResponse.status).toBe(200);
      const connectedFirstReader = firstResponse.body?.getReader();
      expect(connectedFirstReader).toBeDefined();
      if (!connectedFirstReader) throw new Error("SSE 首次连接缺少响应流");
      firstReader = connectedFirstReader;
      const firstSse = new SseSnapshotReader(connectedFirstReader);
      const initial = await firstSse.nextTask();
      expect(initial).toEqual({ id: taskId, status: "CREATED" });

      const transitioned = await fixture.root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/transition`,
        payload: { to: "INTAKING", reason: "Phase 6 SSE 集成测试" }
      });
      expect(transitioned.statusCode).toBe(200);
      const incremental = await firstSse.nextTask();
      expect(incremental).toEqual({ id: taskId, status: "INTAKING" });

      firstAbort.abort();
      await connectedFirstReader.cancel().catch(() => undefined);
      firstReader = undefined;

      const secondTransition = await fixture.root.app.inject({
        method: "POST",
        url: `/tasks/${taskId}/transition`,
        payload: { to: "GATHERING_EVIDENCE", reason: "Phase 6 SSE 断线后状态变化" }
      });
      expect(secondTransition.statusCode).toBe(200);

      secondAbort = new AbortController();
      const secondResponse = await fetch(`${baseUrl}/tasks/${taskId}/events`, {
        signal: secondAbort.signal
      });
      const connectedSecondReader = secondResponse.body?.getReader();
      expect(connectedSecondReader).toBeDefined();
      if (!connectedSecondReader) throw new Error("SSE 重连缺少响应流");
      secondReader = connectedSecondReader;
      const secondSse = new SseSnapshotReader(connectedSecondReader);
      const reconnected = await secondSse.nextTask();
      expect(reconnected).toEqual({ id: taskId, status: "GATHERING_EVIDENCE" });
    } finally {
      firstAbort?.abort();
      secondAbort?.abort();
      if (firstReader) await firstReader.cancel().catch(() => undefined);
      if (secondReader) await secondReader.cancel().catch(() => undefined);
      await fixture.cleanup();
    }
  });

  it("Dashboard 演示所需的受控 API 链路不能跳过审批、版本化、验证或人工挑战", async () => {
    const fixture = await createDashboardDemoFixture();
    try {
      const created = await fixture.root.app.inject({
        method: "POST",
        url: "/tasks",
        payload: { projectId: fixture.project.id, input }
      });
      expect(created.statusCode).toBe(201);
      const task = created.json() as { id: string };

      // UI 不可通过公开迁移或 begin-execution 跨过计划与执行审批。
      const [forgedTransition, forgedExecution] = await Promise.all([
        fixture.root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/transition`,
          payload: { to: "EXECUTING" }
        }),
        fixture.root.app.inject({ method: "POST", url: `/tasks/${task.id}/begin-execution` })
      ]);
      expect(forgedTransition.statusCode).toBe(403);
      expect(forgedExecution.statusCode).toBe(400);

      for (const to of ["INTAKING", "GATHERING_EVIDENCE"] as const) {
        const response = await fixture.root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/transition`,
          payload: { to, reason: "Phase 6 API 演示" }
        });
        expect(response.statusCode).toBe(200);
      }
      const collected = await fixture.root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/collect-evidence`,
        payload: {}
      });
      expect(collected.statusCode).toBe(200);
      const firstPack = (collected.json() as {
        pack: { id: string; version: number; evidence: Array<{ id: string }> };
      }).pack;
      expect(firstPack.evidence.length).toBeGreaterThan(0);

      const request = await fixture.root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/evidence-requests`,
        payload: {
          gapReason: "需要将现有证据绑定到演示根因",
          expectedPlanImpact: "生成受控修复计划"
        }
      });
      expect(request.statusCode).toBe(201);
      const requestId = (request.json() as { id: string }).id;
      const evidenceId = firstPack.evidence[0]?.id;
      expect(evidenceId).toBeDefined();

      const resolved = await fixture.root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/evidence-requests/${requestId}/resolve`,
        payload: {
          rootCause: {
            text: "状态文件保留旧值",
            confidence: 0.8,
            evidenceIds: [evidenceId]
          },
          applicabilityConditions: [{
            text: "仅适用于当前合成项目",
            evidenceIds: [evidenceId],
            required: true
          }]
        }
      });
      expect(resolved.statusCode).toBe(201);
      const secondPack = resolved.json() as { id: string; version: number };
      expect(secondPack.version).toBe(2);

      const planTransition = await fixture.root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "PLANNED", reason: "Phase 6 API 演示：证据已完整" }
      });
      expect(planTransition.statusCode).toBe(200);
      const plan = await fixture.root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/plan`,
        payload: {
          nodes: [{
            id: "dashboard-demo-node",
            label: "修复状态文件",
            description: "在允许范围内将状态改为 fixed",
            evidencePackId: secondPack.id,
            evidencePackVersion: secondPack.version
          }],
          allowedPaths: ["src/**"],
          inputEvidencePackId: secondPack.id,
          inputEvidencePackVersion: secondPack.version
        }
      });
      expect(plan.statusCode).toBe(201);
      const approvalTransition = await fixture.root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/transition`,
        payload: { to: "AWAITING_EXECUTION_APPROVAL", reason: "等待执行审批" }
      });
      expect(approvalTransition.statusCode).toBe(200);

      const executionApproval = await fixture.root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/approvals`,
        payload: { approver: "dashboard-tester", decision: "approved", reason: "范围已核对" }
      });
      expect(executionApproval.statusCode).toBe(201);
      expect((await fixture.root.app.inject({ method: "POST", url: `/tasks/${task.id}/worktrees` })).statusCode).toBe(201);
      expect((await fixture.root.app.inject({ method: "POST", url: `/tasks/${task.id}/begin-execution` })).statusCode).toBe(200);
      expect((await fixture.root.app.inject({ method: "POST", url: `/tasks/${task.id}/run`, payload: { phase: "analyze" } })).statusCode).toBe(200);
      expect((await fixture.root.app.inject({ method: "POST", url: `/tasks/${task.id}/run`, payload: { phase: "develop" } })).statusCode).toBe(200);

      for (const to of ["VALIDATING", "REVIEWING"] as const) {
        const response = await fixture.root.app.inject({
          method: "POST",
          url: `/tasks/${task.id}/transition`,
          payload: { to, reason: "Phase 6 API 演示：进入独立 Review" }
        });
        expect(response.statusCode).toBe(200);
      }
      const review = await fixture.root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/run`,
        payload: { phase: "review" }
      });
      expect(review.statusCode).toBe(200);
      expect((review.json() as { task: { status: string } }).task.status).toBe("AWAITING_HUMAN_APPROVAL");

      const headers = { "x-tracepilot-human-channel-secret": DASHBOARD_DEMO_HUMAN_SECRET };
      const challenge = await fixture.root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/human-approval/challenge`,
        headers,
        payload: { decision: "approved" }
      });
      expect(challenge.statusCode).toBe(201);
      const decision = await fixture.root.app.inject({
        method: "POST",
        url: `/tasks/${task.id}/human-approval`,
        headers,
        payload: {
          challengeToken: (challenge.json() as { challengeToken: string }).challengeToken,
          reason: "Dashboard API 演示完成"
        }
      });
      expect(decision.statusCode).toBe(200);
      expect((await fixture.root.app.inject({ method: "GET", url: `/tasks/${task.id}` })).json()).toEqual(
        expect.objectContaining({ status: "COMPLETED" })
      );
      expect((await fixture.root.app.inject({ method: "GET", url: `/projects/${fixture.project.id}/repair-memory` })).json()).toEqual(
        expect.objectContaining({ records: [expect.objectContaining({ status: "APPROVED" })] })
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
