/**
 * Composition root —— Phase 2 SQLite 装配 + Phase 3 受控 worktree 根目录。
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
 *
 * P1-02：移除 Phase 2 的占位 `TRACEPILOT_ALLOWED_ROOTS` 方案，改用
 * `resolveDefaultWorktreePath()` 解析唯一受控 worktree 根目录（ADR-002）。
 * `LocalCommandAdapter` 的 `allowedWorktreeRoots` 只含此根目录；
 * `LocalGitAdapter` 的 `allowedRepositoryRoots` 在创建时按项目登记填充。
 *
 * P1-R02：组合根装配 `WorktreeManager`、`EvidenceRouter` 与
 * `EvidenceCollector`，并提供受控 API 端点：
 * - `POST /projects/:projectId/worktrees` —— 为任务创建并登记 worktree
 * - `POST /tasks/:taskId/collect-evidence` —— 经 EvidenceCollector 受控
 *   收集证据并生成 Evidence Pack v1（含 git-history / git-blame / sqlite-memory
 *   / git-diff 证据 + Router 请求审计 + command_executed + diff_recorded）
 * 调用方无法绕过这些受控服务直接传入任意 EvidenceItem 或 Worktree。
 */

import Fastify, { type FastifyInstance } from "fastify";
import { pino, type Logger } from "pino";
import {
  TaskOrchestrator,
  WorktreeManager,
  EvidenceRouter,
  EvidenceCollector,
  type TaskInput,
  type TaskStatus,
  type Project,
  type PlanNode
} from "@tracepilot/core";
import { defaultGovernancePolicies } from "@tracepilot/governance";
import {
  LocalCommandAdapter,
  LocalProcessRunner,
  LocalGitAdapter,
  resolveDefaultWorktreePath
} from "@tracepilot/adapters";
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
  /**
   * 受控 worktree 根目录。默认读 `TRACEPILOT_WORKTREE_ROOT` 环境变量，
   * 再回退到 `resolveDefaultWorktreePath()`
   * （%LOCALAPPDATA%/TracePilot/worktrees/，ADR-002）。
   * 测试应传入临时路径，避免污染真实 worktree 目录。
   */
  readonly worktreeRoot?: string;
}

export interface CompositionRoot {
  readonly app: FastifyInstance;
  readonly orchestrator: TaskOrchestrator;
  readonly logger: Logger;
  readonly store: SqliteStore;
  /** 受控 worktree 根目录（ADR-002）。 */
  readonly worktreeRoot: string;
  /**
   * P1-R02：为指定项目构造受控服务集合（LocalGitAdapter + WorktreeManager
   * + EvidenceCollector），确保调用方无法绕过受控服务直接传入任意
   * EvidenceItem 或 Worktree。
   *
   * 调用方注册项目后调用本工厂，得到与该项目绑定的受控服务集合。
   */
  createServicesForProject(project: Project): ProjectServices;
  /** 关闭 Fastify 与 SQLite 连接。服务停止时必须调用。 */
  close(): Promise<void>;
}

/**
 * P1-R02：项目绑定的受控服务集合。
 *
 * - `gitAdapter`：与项目仓库根绑定的 LocalGitAdapter
 * - `worktreeManager`：经该 Adapter + Orchestrator 受控管理 worktree 生命周期
 * - `evidenceCollector`：经该 Adapter + WorktreeManager + KnowledgeAdapter
 *   受控收集证据
 */
export interface ProjectServices {
  readonly gitAdapter: LocalGitAdapter;
  readonly worktreeManager: WorktreeManager;
  readonly evidenceCollector: EvidenceCollector;
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
  const router = new EvidenceRouter();

  // P1-02：解析唯一受控 worktree 根目录（ADR-002）。
  // 不再使用 Phase 2 的占位 TRACEPILOT_ALLOWED_ROOTS 方案。
  const worktreeRoot =
    options.worktreeRoot ??
    process.env.TRACEPILOT_WORKTREE_ROOT ??
    resolveDefaultWorktreePath();

  // P1-03：LocalCommandAdapter 必须经治理闸门执行命令。
  // allowedWorktreeRoots 只含唯一受控 worktree 根目录；
  // processPolicy.allowedCwdRoots 同步设为相同根目录，确保 Runtime
  // （analyze / develop）只能在被批准的 worktree 内执行命令。
  const placeholderProjectCommands = {
    test: { argv: ["pnpm", "test"], timeoutMs: 300000 }
  };
  const runtime = new LocalCommandAdapter({
    processRunner: new LocalProcessRunner(),
    commandPolicy: policies.command,
    pathPolicy: policies.path,
    processPolicy: {
      timeoutMs: 60000,
      maxOutputBytes: 256 * 1024,
      allowedCwdRoots: [worktreeRoot],
      inheritEnv: false
    },
    projectCommands: placeholderProjectCommands,
    allowedWorktreeRoots: [worktreeRoot]
  });

  logger.info(
    {
      runtime: "LocalCommandAdapter",
      policies: "default",
      store: "SQLite",
      dbPath,
      worktreeRoot
    },
    "TracePilot composition root 已初始化 —— Phase 3 受控 worktree 装配"
  );

  /**
   * P1-R02：为指定项目构造受控服务集合。
   *
   * 调用方注册项目后调用本工厂，得到与该项目绑定的：
   * - LocalGitAdapter（allowedWorktreeRoots=受控根，allowedRepositoryRoots=项目仓库根）
   * - WorktreeManager（依赖该 Adapter + Orchestrator + UnitOfWork）
   * - EvidenceCollector（依赖 Router + 该 Adapter + KnowledgeAdapter +
   *   WorktreeManager + UnitOfWork）
   *
   * 调用方无法绕过这些受控服务直接传入任意 EvidenceItem 或 Worktree ——
   * API 端点只接受项目 ID 与任务 ID，所有 Adapter 调用都在受控服务内完成。
   */
  const createServicesForProject = (project: Project): ProjectServices => {
    const gitAdapter = new LocalGitAdapter({
      processRunner: new LocalProcessRunner(),
      commandPolicy: policies.command,
      pathPolicy: policies.path,
      processPolicy: {
        timeoutMs: 60000,
        maxOutputBytes: 256 * 1024,
        allowedCwdRoots: [worktreeRoot, project.repositoryPath],
        inheritEnv: false
      },
      allowedWorktreeRoots: [worktreeRoot],
      allowedRepositoryRoots: [project.repositoryPath],
      projectCommands: project.commands
    });
    const worktreeManager = new WorktreeManager({
      gitAdapter,
      orchestrator,
      unitOfWork: store.unitOfWork
    });
    const evidenceCollector = new EvidenceCollector({
      router,
      gitAdapter,
      knowledgeAdapter: store.knowledgeAdapter,
      unitOfWork: store.unitOfWork,
      worktreeManager
    });
    return { gitAdapter, worktreeManager, evidenceCollector };
  };

  // 项目缓存：projectId → ProjectServices。生产环境可换成 LRU；当前 Phase 3
  // 只在 API 调用时按需构建并缓存，避免每次请求重复构造 Adapter。
  const projectServicesCache = new Map<string, ProjectServices>();
  const getServicesForProject = async (projectId: string): Promise<ProjectServices> => {
    const cached = projectServicesCache.get(projectId);
    if (cached) return cached;
    const project = await store.unitOfWork.run((tx) => tx.projects.findById(projectId));
    if (!project) throw new Error(`项目 ${projectId} 未登记`);
    const services = createServicesForProject(project);
    projectServicesCache.set(projectId, services);
    return services;
  };

  const app = Fastify({ logger: false });

  // 健康检查 —— 操作者用来确认 API 存活与持久化模式。
  app.get("/health", async () => ({
    status: "ok",
    phase: "phase-3-git-evidence",
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

  // P1-R03：受控 Plan 记录端点 —— 在 PLANNED 状态记录 Plan（含 allowedPaths）。
  // allowedPaths 是执行审批范围快照的组成部分；后续创建 worktree 必须从
  // 持久化的 Plan 读取，不得信任请求体提供的任意值。
  app.post<{
    Params: { taskId: string };
    Body: {
      nodes: readonly PlanNode[];
      allowedPaths: readonly string[];
      inputEvidencePackId: string;
      inputEvidencePackVersion: number;
      planId?: string;
    };
  }>("/tasks/:taskId/plan", async (req, reply) => {
    try {
      const body = req.body ?? ({} as {
        nodes: readonly PlanNode[];
        allowedPaths: readonly string[];
        inputEvidencePackId: string;
        inputEvidencePackVersion: number;
        planId?: string;
      });
      if (!body.nodes || !Array.isArray(body.nodes) || body.nodes.length === 0) {
        return reply.code(400).send({ error: "nodes 必须是非空数组" });
      }
      if (!body.allowedPaths || !Array.isArray(body.allowedPaths)) {
        return reply.code(400).send({ error: "allowedPaths 必须是数组" });
      }
      if (!body.inputEvidencePackId || typeof body.inputEvidencePackVersion !== "number") {
        return reply.code(400).send({
          error: "inputEvidencePackId 与 inputEvidencePackVersion 均为必填"
        });
      }
      const plan = await orchestrator.planTask({
        taskId: req.params.taskId,
        planId: body.planId,
        nodes: body.nodes,
        allowedPaths: body.allowedPaths,
        inputEvidencePackId: body.inputEvidencePackId,
        inputEvidencePackVersion: body.inputEvidencePackVersion
      });
      return reply.code(201).send(plan);
    } catch (err) {
      const message = (err as Error).message;
      const name = (err as Error).name;
      const code = name === "TaskNotFoundError" ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  // P1-R03：受控执行审批端点 —— 在 AWAITING_EXECUTION_APPROVAL 状态记录审批。
  // scopeHash 由 orchestrator.computeCurrentScopeHash 自动计算（基于持久化
  // Plan.allowedPaths + Project.commands keys + TaskInput.riskLevel），
  // 调用方无法传入任意 scopeHash 绕过范围校验。
  app.post<{
    Params: { taskId: string };
    Body: {
      approver: string;
      decision: "approved" | "rejected";
      reason?: string;
    };
  }>("/tasks/:taskId/approvals", async (req, reply) => {
    try {
      const body = req.body ?? ({} as {
        approver: string;
        decision: "approved" | "rejected";
        reason?: string;
      });
      if (!body.approver) {
        return reply.code(400).send({ error: "approver 为必填" });
      }
      if (body.decision !== "approved" && body.decision !== "rejected") {
        return reply.code(400).send({ error: "decision 必须是 approved 或 rejected" });
      }
      const scopeHash = await orchestrator.computeCurrentScopeHash(req.params.taskId);
      const approval = await orchestrator.recordApproval({
        taskId: req.params.taskId,
        kind: "execution",
        approver: body.approver,
        decision: body.decision,
        scopeHash,
        reason: body.reason
      });
      return reply.code(201).send(approval);
    } catch (err) {
      const message = (err as Error).message;
      const name = (err as Error).name;
      const code = name === "TaskNotFoundError" ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  // P1-R02 / P1-R03：受控 worktree 创建端点 —— 经 WorktreeManager 在事务内登记。
  // P1-R03：请求体不再接受 allowedPaths；WorktreeManager 会从持久化 Plan 读取
  // allowedPaths 并覆盖 input.allowedPaths 占位值，确保范围不可被请求体篡改。
  // 创建前在事务内校验：任务状态 === AWAITING_EXECUTION_APPROVAL、存在有效
  // execution approval、approval.scopeHash === 当前 Plan scopeHash；任一校验
  // 失败则写 policy_denied 审计并拒绝创建。
  app.post<{
    Params: { taskId: string };
  }>("/tasks/:taskId/worktrees", async (req, reply) => {
    try {
      const task = await store.unitOfWork.run((tx) =>
        tx.tasks.findById(req.params.taskId)
      );
      if (!task) return reply.code(404).send({ error: "任务不存在" });

      const project = await store.unitOfWork.run((tx) =>
        tx.projects.findById(task.projectId)
      );
      if (!project) return reply.code(404).send({ error: "项目未登记" });

      const services = await getServicesForProject(task.projectId);
      const worktree = await services.worktreeManager.createAndAttachWorktree({
        taskId: task.id,
        input: {
          projectId: project.id,
          repositoryPath: project.repositoryPath,
          defaultBranch: project.defaultBranch,
          taskId: task.id,
          // P1-R03：占位值，由 WorktreeManager.authorizeWorktreeCreation
          // 从持久化 Plan 读取并覆盖。
          allowedPaths: []
        }
      });
      return reply.code(201).send(worktree);
    } catch (err) {
      const message = (err as Error).message;
      const name = (err as Error).name;
      // P1-R03：审批校验失败一律返回 403，并通过 policy_denied 审计记录。
      const forbidden =
        name === "WorktreeCreationNotAllowedException" ||
        name === "MissingExecutionApprovalException" ||
        name === "WorktreeScopeMismatchException";
      const code = forbidden ? 403 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  // P1-R02：受控证据收集端点 —— 经 EvidenceCollector 收集证据并生成 Pack v1。
  // 调用方无法绕过 Collector 直接传入任意 EvidenceItem。
  app.post<{
    Params: { taskId: string };
    Body: {
      blameFilePaths?: readonly string[];
      worktreeId?: string;
      maxHistoryCount?: number;
    };
  }>("/tasks/:taskId/collect-evidence", async (req, reply) => {
    try {
      const task = await store.unitOfWork.run((tx) =>
        tx.tasks.findById(req.params.taskId)
      );
      if (!task) return reply.code(404).send({ error: "任务不存在" });

      const project = await store.unitOfWork.run((tx) =>
        tx.projects.findById(task.projectId)
      );
      if (!project) return reply.code(404).send({ error: "项目未登记" });

      const services = await getServicesForProject(task.projectId);

      // 收集证据（Router 请求审计 + git 命令审计 + 可选 Diff 证据）
      const result = await services.evidenceCollector.collectEvidence({
        taskId: task.id,
        taskInput: task.input,
        projectId: project.id,
        repositoryPath: project.repositoryPath,
        blameFilePaths: req.body?.blameFilePaths,
        worktreeId: req.body?.worktreeId ?? task.worktreeId,
        maxHistoryCount: req.body?.maxHistoryCount
      });

      // 若任务处于 GATHERING_EVIDENCE，生成 Pack v1
      let pack = null;
      if (task.status === "GATHERING_EVIDENCE") {
        pack = await orchestrator.gatherEvidenceAndCreatePack({
          taskId: task.id,
          packId: `pack-${task.id}`,
          evidence: result.evidence,
          acceptanceCriteria: task.input.acceptanceCriteria
        });
      }

      return reply.code(200).send({
        evidenceCount: result.evidence.length,
        gitCommandCount: result.gitCommandCount,
        evidence: result.evidence,
        pack
      });
    } catch (err) {
      const message = (err as Error).message;
      return reply.code(400).send({ error: message });
    }
  });

  // P1-R02：受控 Diff 采集端点 —— 经 WorktreeManager.captureDiffForTask。
  app.post<{
    Params: { taskId: string };
    Body: { worktreeId: string; reason?: string };
  }>("/tasks/:taskId/diff", async (req, reply) => {
    try {
      const task = await store.unitOfWork.run((tx) =>
        tx.tasks.findById(req.params.taskId)
      );
      if (!task) return reply.code(404).send({ error: "任务不存在" });

      const services = await getServicesForProject(task.projectId);
      const worktreeId = req.body?.worktreeId ?? task.worktreeId;
      if (!worktreeId) {
        return reply.code(400).send({ error: "任务未关联 worktree，需提供 worktreeId" });
      }
      const diff = await services.worktreeManager.captureDiffForTask({
        taskId: task.id,
        worktreeId,
        reason: req.body?.reason ?? "API 受控 Diff 采集"
      });
      return reply.code(200).send({
        worktreePath: diff.worktreePath,
        hash: diff.hash,
        changedFiles: diff.changedFiles,
        bytes: diff.bytes,
        patchPreview: diff.patch.slice(0, 4096)
      });
    } catch (err) {
      const message = (err as Error).message;
      const name = (err as Error).name;
      const code = name === "WorktreeNotRegisteredException" ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  // policies 与 runtime 仅供测试 / 后续装配引用，不直接暴露 API。
  void policies;
  void runtime;

  const close = async (): Promise<void> => {
    await app.close();
    store.close();
  };

  return {
    app,
    orchestrator,
    logger,
    store,
    worktreeRoot,
    createServicesForProject,
    close
  };
}
