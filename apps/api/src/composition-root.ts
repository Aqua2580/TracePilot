/**
 * Composition root —— Phase 1 最小装配。
 *
 * 用 InMemoryStore 装配 Orchestrator（Phase 2 换成 SQLite）、用
 * LocalCommandAdapter 作为 Runtime（Phase 4 换成 OmpAdapter）、用默认治理
 * 策略。暴露单个 Fastify 实例，提供 health + 任务创建 + 任务迁移端点。
 *
 * Phase 1 范围：证明装配可编译、Orchestrator 可响应。
 * Phase 2 加 SQLite，Phase 3 加 Git/Worktree，Phase 6 加完整 UI。
 *
 * P1-03：LocalCommandAdapter 现在必须注入受治理的 ProcessRunner +
 * CommandPolicy + PathPolicy + ProcessPolicy + 项目命令白名单。
 */

import Fastify, { type FastifyInstance } from "fastify";
import { pino, type Logger } from "pino";
import {
  TaskOrchestrator,
  createInMemoryStore,
  type TaskInput,
  type TaskStatus
} from "@tracepilot/core";
import { defaultGovernancePolicies } from "@tracepilot/governance";
import { LocalCommandAdapter, LocalProcessRunner } from "@tracepilot/adapters";

export interface CompositionRoot {
  readonly app: FastifyInstance;
  readonly orchestrator: TaskOrchestrator;
  readonly logger: Logger;
}

export function buildCompositionRoot(): CompositionRoot {
  const logger = pino({
    name: "tracepilot-api",
    level: process.env.LOG_LEVEL ?? "info"
  });

  const store = createInMemoryStore();
  const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
  const policies = defaultGovernancePolicies();

  // P1-03：LocalCommandAdapter 必须经治理闸门执行命令。Phase 1 没有真实
  // 项目登记，这里用一个占位的项目命令白名单 + 临时目录作为允许根目录。
  // Phase 3 引入真实 worktree 管理后，allowedWorktreeRoots 由 worktree
  // 登记动态填充。
  const placeholderProjectCommands = {
    test: { argv: ["pnpm", "test"], timeoutMs: 300000 }
  };
  const placeholderAllowedRoots = process.env.TRACEPILOT_ALLOWED_ROOTS
    ? process.env.TRACEPILOT_ALLOWED_ROOTS.split(",")
    : [];
  const runtime = new LocalCommandAdapter({
    processRunner: new LocalProcessRunner(),
    commandPolicy: policies.command,
    pathPolicy: policies.path,
    processPolicy: {
      timeoutMs: 60000,
      maxOutputBytes: 256 * 1024,
      allowedCwdRoots: placeholderAllowedRoots,
      inheritEnv: false
    },
    projectCommands: placeholderProjectCommands,
    allowedWorktreeRoots: placeholderAllowedRoots
  });

  logger.info(
    {
      runtime: "LocalCommandAdapter",
      policies: "default",
      store: "InMemory"
    },
    "TracePilot composition root 已初始化 —— Phase 1 兜底装配"
  );

  const app = Fastify({ logger: false });

  // 健康检查 —— 操作者用来确认 API 存活。
  app.get("/health", async () => ({
    status: "ok",
    phase: "phase-1-skeleton",
    runtime: "LocalCommandAdapter",
    store: "InMemory"
  }));

  // 列出治理策略摘要 —— 操作者用来确认哪些闸门已启用。
  app.get("/governance", async () => ({
    commandPolicy: "DefaultCommandPolicy",
    pathPolicy: "DefaultPathPolicy",
    approvalPolicy: "DefaultApprovalPolicy",
    auditPolicy: "DefaultAuditPolicy"
  }));

  // 创建任务 —— POST /tasks，body 为 TaskInput。
  app.post<{
    Body: { projectId: string; input: TaskInput };
  }>("/tasks", async (req, reply) => {
    const { projectId, input } = req.body ?? ({} as { projectId: string; input: TaskInput });
    if (!projectId || !input) {
      return reply.code(400).send({ error: "projectId 与 input 均为必填" });
    }
    const task = await orchestrator.createTask({ projectId, input });
    return reply.code(201).send(task);
  });

  // 按 id 获取任务。
  app.get<{ Params: { taskId: string } }>(
    "/tasks/:taskId",
    async (req, reply) => {
      const task = await store.tasks.findById(req.params.taskId);
      if (!task) return reply.code(404).send({ error: "任务不存在" });
      return task;
    }
  );

  // 迁移任务 —— POST /tasks/:taskId/transition，body 为 { to, reason? }。
  app.post<{
    Params: { taskId: string };
    Body: { to: TaskStatus; reason?: string };
  }>("/tasks/:taskId/transition", async (req, reply) => {
    const { to, reason } = req.body ?? ({} as { to: TaskStatus; reason?: string });
    if (!to) return reply.code(400).send({ error: "to 为必填" });
    try {
      const updated = await orchestrator.transitionTask(
        req.params.taskId,
        to,
        { reason }
      );
      return updated;
    } catch (err) {
      const message = (err as Error).message;
      const name = (err as Error).name;
      const code = name === "TaskNotFoundError" ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  // 取消任务。
  app.post<{ Params: { taskId: string }; Body: { reason: string } }>(
    "/tasks/:taskId/cancel",
    async (req, reply) => {
      try {
        const updated = await orchestrator.cancel(
          req.params.taskId,
          req.body?.reason ?? "通过 API 取消"
        );
        return updated;
      } catch (err) {
        const message = (err as Error).message;
        const name = (err as Error).name;
        const code = name === "TaskNotFoundError" ? 404 : 400;
        return reply.code(code).send({ error: message });
      }
    }
  );

  // 任务审计时间线。
  app.get<{ Params: { taskId: string } }>(
    "/tasks/:taskId/audit",
    async (req) => {
      return store.audit.findByTask(req.params.taskId);
    }
  );

  // policies 与 runtime 仅供测试 / Phase 2 装配引用，不直接暴露 API。
  void policies;
  void runtime;

  return { app, orchestrator, logger };
}
