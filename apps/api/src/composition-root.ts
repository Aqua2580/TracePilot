/**
 * Composition root —— Phase 2 SQLite 装配。
 *
 * 用 SqliteStore 装配 Orchestrator（满足 §3.1 SQLite 真源 + 服务重启收口），
 * 用 LocalCommandAdapter 作为 Runtime（Phase 4 换成 OmpAdapter），用默认治理
 * 策略。暴露单个 Fastify 实例，提供 health + 任务创建 + 任务迁移端点。
 *
 * Phase 2 范围：SQLite 持久化 + 启动恢复在真实磁盘库上生效。
 * Phase 3 加 Git/Worktree，Phase 6 加完整 UI。
 *
 * P1-01：组合根必须创建 SqliteStore，并在关闭 Fastify 时关闭 SQLite 连接。
 * 启动恢复（recoverInterruptedTasks）由 server.ts 在监听前显式调用，便于
 * 测试与日志记录；测试也可通过 orchestrator.recoverInterruptedTasks() 触发。
 */

import Fastify, { type FastifyInstance } from "fastify";
import { pino, type Logger } from "pino";
import {
  TaskOrchestrator,
  type TaskInput,
  type TaskStatus
} from "@tracepilot/core";
import { defaultGovernancePolicies } from "@tracepilot/governance";
import { LocalCommandAdapter, LocalProcessRunner } from "@tracepilot/adapters";
import {
  createSqliteStore,
  resolveDefaultDataPath,
  type SqliteStore
} from "@tracepilot/store";

export interface CompositionRootOptions {
  /**
   * SQLite 数据库路径。默认读 `TRACEPILOT_DB_PATH` 环境变量，再回退到
   * `resolveDefaultDataPath()`（%LOCALAPPDATA%/TracePilot/data/tracepilot.db）。
   * 测试应传入临时路径，避免污染真实数据目录。
   */
  readonly dbPath?: string;
}

export interface CompositionRoot {
  readonly app: FastifyInstance;
  readonly orchestrator: TaskOrchestrator;
  readonly logger: Logger;
  readonly store: SqliteStore;
  /** 关闭 Fastify 与 SQLite 连接。服务停止时必须调用。 */
  close(): Promise<void>;
}

export function buildCompositionRoot(
  options: CompositionRootOptions = {}
): CompositionRoot {
  const logger = pino({
    name: "tracepilot-api",
    level: process.env.LOG_LEVEL ?? "info"
  });

  const dbPath =
    options.dbPath ??
    process.env.TRACEPILOT_DB_PATH ??
    resolveDefaultDataPath();
  const store = createSqliteStore({ dbPath });
  const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
  const policies = defaultGovernancePolicies();

  // P1-03：LocalCommandAdapter 必须经治理闸门执行命令。Phase 2 没有真实
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
      store: "SQLite",
      dbPath
    },
    "TracePilot composition root 已初始化 —— Phase 2 SQLite 装配"
  );

  const app = Fastify({ logger: false });

  // 健康检查 —— 操作者用来确认 API 存活与持久化模式。
  app.get("/health", async () => ({
    status: "ok",
    phase: "phase-2-sqlite",
    runtime: "LocalCommandAdapter",
    store: "SQLite",
    dbPath
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
      const task = await store.unitOfWork.run((tx) =>
        tx.tasks.findById(req.params.taskId)
      );
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
      return store.unitOfWork.run((tx) => tx.audit.findByTask(req.params.taskId));
    }
  );

  // policies 与 runtime 仅供测试 / 后续装配引用，不直接暴露 API。
  void policies;
  void runtime;

  const close = async (): Promise<void> => {
    await app.close();
    store.close();
  };

  return { app, orchestrator, logger, store, close };
}
