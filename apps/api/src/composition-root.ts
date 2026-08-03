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

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { pino, type Logger } from "pino";
import {
  TaskOrchestrator,
  WorktreeManager,
  EvidenceRouter,
  EvidenceCollector,
  ExecutionOrchestrator,
  RuntimeStreamFailedError,
  TaskNotInExpectedStatusError,
  PathScopeViolationError,
  type TaskInput,
  type TaskStatus,
  type Project,
  type PlanNode,
  type RuntimeAdapter,
  type ProcessRunner,
  type UnitOfWork
} from "@tracepilot/core";
import { defaultGovernancePolicies } from "@tracepilot/governance";
import {
  LocalCommandAdapter,
  LocalProcessRunner,
  LocalGitAdapter,
  LocalWorktreeFilesystemGuard,
  LocalControlledFileWriter,
  OmpAdapter,
  resolveDefaultWorktreePath,
  ExecutionIsolationError
} from "@tracepilot/adapters";
import {
  createSqliteStore,
  resolveDefaultDataPath,
  RuntimeEventBuffer,
  type SqliteStore
} from "@tracepilot/store";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 返回 ESM 模块所在目录的文件系统路径。 */
function fileDirname(moduleUrl: string): string {
  return resolve(fileURLToPath(moduleUrl), "..");
}

export interface CompositionRootOptions {
  /**
   * SQLite 数据库路径。默认读 `TRACEPILOT_DB_PATH` 环境变量，再回退到
   * `resolveDefaultDataPath()`（%LOCALAPPDATA%/TracePilot/data/tracepilot.db）。
   * 测试应传入临时路径，避免污染真实数据目录。
   */
  readonly dbPath?: string;
  /**
   * 是否跳过 `.env` 文件加载。默认 `false`（生产环境加载 `.env`）。
   * 测试设为 `true` 以避免 `.env` 中的真实配置干扰测试断言
   * （例如测试删除 `TRACEPILOT_OMP_PATH` 验证降级模式时，
   * `.env` 会把它加载回来导致断言失败）。
   */
  readonly skipEnvFile?: boolean;
  /**
   * 受控 worktree 根目录。默认读 `TRACEPILOT_WORKTREE_ROOT` 环境变量，
   * 再回退到 `resolveDefaultWorktreePath()`
   * （%LOCALAPPDATA%/TracePilot/worktrees/，ADR-002）。
   * 测试应传入临时路径，避免污染真实 worktree 目录。
   */
  readonly worktreeRoot?: string;
  /**
   * **仅用于测试**：注入自定义 RuntimeAdapter，绕过基于
   * `TRACEPILOT_OMP_PATH` 的 OmpAdapter/LocalCommandAdapter 装配。
   *
   * 生产环境必须留空 —— 由组合根根据环境变量受控装配真实 Runtime。
   * 测试用它注入 FakeRuntimeAdapter（如阻塞型、错误型），验证
   * HTTP API 层的取消、异常状态迁移等安全路径（P1-R02-E）。
   */
  readonly runtimeOverride?: RuntimeAdapter;
  /**
   * **仅用于测试**：注入自定义 ProcessRunner，绕过默认的
   * `LocalProcessRunner` 装配。
   *
   * 生产环境必须留空。测试用它注入阻塞型 ProcessRunner，验证
   * §9.3 场景：Runtime completed 后验证命令仍在运行时，/cancel 能
   * 通过 AbortSignal 终止验证进程树并阻止成功产物持久化。
   */
  readonly processRunnerOverride?: ProcessRunner;
  /**
   * **仅用于测试**：拦截 UnitOfWork，允许测试在事务内注入屏障
   * （如 `executionResults.save` 后暂停）。
   *
   * 生产环境必须留空。测试用它验证 §10.1 线性化点：最终 save 事务
   * 内，取消在 save 的 await yield 期间设置 abort 信号后，save 后的
   * abort 检查命中并回滚事务，拒绝持久化 executionResults。
   */
  readonly unitOfWorkInterceptor?: (uow: UnitOfWork) => UnitOfWork;
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
  /**
   * Phase 4：项目绑定的执行编排器。
   *
   * 负责把 RuntimeAdapter 的 analyze/develop/review 与任务状态机、
   * worktree、事件缓冲、验证命令串成完整闭环。它是系统中唯一调用
   * RuntimeAdapter 方法的组件（测试中的 FakeRuntimeAdapter 除外）。
   */
  readonly executionOrchestrator: ExecutionOrchestrator;
}

export function buildCompositionRoot(
  options: CompositionRootOptions = {}
): CompositionRoot {
  // P4：加载项目根 .env 文件（Node 22+ 内置 process.loadEnvFile，零依赖）。
  // .env 已在 .gitignore 中（第 32-34 行），不会提交。
  // 已存在的 process.env 不会被 .env 覆盖（仅填充缺失项），允许测试
  // 通过显式 env 覆盖。文件不存在时静默跳过。
  // 测试通过 skipEnvFile=true 跳过加载，避免 .env 真实配置干扰断言。
  if (!options.skipEnvFile) {
    loadDotEnv();
  }

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

  // P1-03：Runtime 必须经治理闸门执行命令。
  // allowedWorktreeRoots 只含唯一受控 worktree 根目录；
  // processPolicy.allowedCwdRoots 同步设为相同根目录，确保 Runtime
  // （analyze / develop）只能在被批准的 worktree 内执行命令。
  //
  // Phase 4（ADR-007）：受控装配 OmpAdapter 作为默认 Runtime。当且仅当
  // `TRACEPILOT_OMP_PATH` 指向受控 omp 二进制路径时启用 OmpAdapter；
  // 否则降级为 LocalCommandAdapter（ADR-001 MVP 兜底），仅用于 Spike、
  // 测试或明确记录的降级模式，不得作为发布演示的唯一 Runtime
  // （AGENTS.md 规则 9）。
  //
  // 真实闭环（analyze/develop/review 经 omp + LLM 完成）需 API key 配置
  // 后由专门集成测试覆盖；本装配只保证 OmpAdapter 实例可被创建且 argv
  // 治理链路可被触发，不验证 omp 调用的真实成功率。
  const placeholderProjectCommands = {
    test: { argv: ["pnpm", "test"], timeoutMs: 300000 }
  };

  // P4：OmpAdapter 场景下，omp 子进程需要 LLM 凭据才能调用模型。
  // 用 allowedEnvVarNames 白名单仅透传已知的 LLM API key 环境变量，
  // 不无差别继承 process.env（避免泄漏其他敏感变量）。白名单只声明
  // 变量名称，值从 process.env 读取，调用方无法通过此字段注入任意值。
  //
  // 支持的 LLM 提供商（omp --help "Environment Variables" 节 + 二进制内嵌扫描）：
  //   ANTHROPIC / OPENAI / GEMINI / AZURE_OPENAI / GROQ / CEREBRAS /
  //   XAI / OPENROUTER / KILO / MISTRAL / ZAI / MINIMAX / OPENCODE /
  //   AI_GATEWAY / WAFER_SERVERLESS / DEEPSEEK
  // DeepSeek 接入方案：omp 二进制内嵌 DEEPSEEK_API_KEY（虽未在 --help 列出，
  // 但通过二进制字符串扫描确认），直接用 DeepSeek 原生端点。模型名用
  // deepseek-v4-flash 或 deepseek-v4-pro（参考 https://api-docs.deepseek.com/zh-cn/）。
  const ompAllowedEnvVarNames = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "KILO_API_KEY",
    "MISTRAL_API_KEY",
    "ZAI_API_KEY",
    "MINIMAX_API_KEY",
    "OPENCODE_API_KEY",
    "AI_GATEWAY_API_KEY",
    "WAFER_SERVERLESS_API_KEY",
    "DEEPSEEK_API_KEY",
    "OMP_AUTH_BROKER_URL"
  ];

  const ompPath = process.env.TRACEPILOT_OMP_PATH;
  const useOmp = ompPath !== undefined && ompPath.length > 0;
  // P1-R02-E：测试可通过 runtimeOverride 注入 FakeRuntimeAdapter，
  // 绕过基于环境变量的真实 Runtime 装配。生产环境留空。
  const useOverride = options.runtimeOverride !== undefined;
  const runtimeKind: "omp" | "local-command" | "test-override" = useOverride
    ? "test-override"
    : useOmp
      ? "omp"
      : "local-command";

  // OmpAdapter 与 LocalCommandAdapter 共享基础 processPolicy，但 OmpAdapter
  // 额外配置 allowedEnvVarNames 白名单以透传 LLM 凭据。
  const baseProcessPolicy = {
    timeoutMs: 60000,
    maxOutputBytes: 256 * 1024,
    allowedCwdRoots: [worktreeRoot] as readonly string[],
    inheritEnv: false
  };

  // P1-02（Phase 4 验收）：验证命令专用 processPolicy —— 用于
  // ExecutionOrchestrator.runDevelop 跑项目 test 命令验证修改是否修复了
  // 失败测试。
  //
  // 安全约束（不可绕过）：
  // - inheritEnv=false：禁止全量继承 process.env，避免泄漏 LLM API key
  //   （DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY 等）。
  //   Agent 可修改 worktree 中的测试脚本 / package.json / conftest，
  //   若验证子进程能读到这些凭据，恶意测试可外传。
  // - allowedEnvVarNames 白名单：仅透传测试运行必需的非敏感变量
  //   （PATH / SYSTEMROOT / TEMP / TMP / PATHEXT / APPDATA / LOCALAPPDATA
  //   / PROGRAMFILES / USERPROFILE / COMSPEC / HOMEDRIVE / HOMEPATH / LANG
  //   / PYTHONIOENCODING / PYTHONUTF8 / NODE_OPTIONS / NODE_PATH）。
  //   任何含 API_KEY / TOKEN / SECRET / CREDENTIAL 的变量均不在白名单中。
  // - 更长超时（测试套件可能较慢，给 5 分钟）。
  const verificationAllowedEnvVarNames = [
    "PATH",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "USERPROFILE",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "PYTHONIOENCODING",
    "PYTHONUTF8",
    "NODE_OPTIONS",
    "NODE_PATH"
  ];
  const verificationProcessPolicy = {
    timeoutMs: 300000,
    maxOutputBytes: 512 * 1024,
    allowedCwdRoots: [worktreeRoot] as readonly string[],
    inheritEnv: false,
    allowedEnvVarNames: verificationAllowedEnvVarNames,
    // P1-02：纵深防御 —— 即使白名单误含凭据变量名（API_KEY / TOKEN 等），
    // 也拒绝透传。白名单本身已不含凭据变量，此标志作为二次保险。
    disallowCredentialVars: true
  };

  // P4：共享的 RuntimeEventBuffer —— 所有项目的 runtime 事件都通过此缓冲区
  // 落库到 agent_runs 表。RuntimeEventBuffer 只依赖 unitOfWork，与项目无关。
  const sharedEventSink = new RuntimeEventBuffer({ unitOfWork: store.unitOfWork });
  // §9.3：测试可通过 processRunnerOverride 注入阻塞型 ProcessRunner，
  // 验证 Runtime completed 后验证阶段取消能终止验证进程树。生产环境留空。
  const sharedProcessRunner = options.processRunnerOverride ?? new LocalProcessRunner();

  const runtime =
    useOverride && options.runtimeOverride
      ? options.runtimeOverride
      : useOmp && ompPath
        ? new OmpAdapter({
          processRunner: new LocalProcessRunner(),
          pathPolicy: policies.path,
          processPolicy: {
            ...baseProcessPolicy,
            // omp 调用 LLM 需要较长超时（10 分钟），与 LocalCommandAdapter 的
            // 60 秒区分开。ProcessPolicy.timeoutMs 与 defaultTimeoutMs 对齐，
            // OmpAdapter 内部转换为 --max-time 秒数。
            timeoutMs: 600000,
            allowedEnvVarNames: ompAllowedEnvVarNames
          },
          projectCommands: placeholderProjectCommands,
          allowedWorktreeRoots: [worktreeRoot],
          ompPath,
          defaultTimeoutMs: 600000,
          // 可选模型名：若项目环境配置 TRACEPILOT_OMP_MODEL 则注入 --model。
          ...(process.env.TRACEPILOT_OMP_MODEL
            ? { model: process.env.TRACEPILOT_OMP_MODEL }
            : {}),
          // ADR-008：omp 必须用独立 profile 避免访问被沙盒阻止的
          // `~/.omp/agent/agent.db`。默认 profile 名 "tracepilot"，可通过
          // TRACEPILOT_OMP_PROFILE 覆盖。profile 名由 OmpAdapter 校验规则。
          profile: process.env.TRACEPILOT_OMP_PROFILE ?? "tracepilot",
          // P1-R01（§18 受控文件工具代理）：注入受控文件写入器。
          // omp develop 阶段使用只读工具集（--tools read,grep,glob），无写入能力。
          // omp 通过 <file_change> XML 指令输出文件修改，由本写入器代为写入并在
          // 写入前同步校验路径（allowedPaths glob 匹配 + 受保护路径检查 + 符号链接
          // 逃逸检查）。这是"同步、操作前、逐路径"的强制边界，从源头杜绝越权写入。
          controlledFileWriter: new LocalControlledFileWriter()
        })
      : new LocalCommandAdapter({
          processRunner: new LocalProcessRunner(),
          commandPolicy: policies.command,
          pathPolicy: policies.path,
          processPolicy: baseProcessPolicy,
          projectCommands: placeholderProjectCommands,
          allowedWorktreeRoots: [worktreeRoot]
        });

  logger.info(
    {
      runtime: runtimeKind,
      policies: "default",
      store: "SQLite",
      dbPath,
      worktreeRoot,
      ...(runtimeKind === "omp" ? { ompPath } : {})
    },
    runtimeKind === "omp"
      ? "TracePilot composition root 已初始化 —— Phase 4 OmpAdapter 装配"
      : runtimeKind === "test-override"
        ? "TracePilot composition root 已初始化 —— 测试模式 runtimeOverride（仅用于测试）"
        : "TracePilot composition root 已初始化 —— Phase 4 降级模式 LocalCommandAdapter（ADR-001 MVP 兜底）"
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
    // P4：项目绑定的 ExecutionOrchestrator —— 共享 runtime / eventSink /
    // processRunner / verificationProcessPolicy，仅 worktreeManager 随项目绑定。
    // P1-R01（Phase 4 第三轮验收 §7.2）：注入 LocalWorktreeFilesystemGuard，
    // 在 runDevelop 前后做全量文件系统快照对比，检测并回滚越界写入。
    // §10.1：测试可通过 unitOfWorkInterceptor 在事务内注入屏障，
    // 验证最终持久化窗口的线性化保证。
    const effectiveUnitOfWork = options.unitOfWorkInterceptor
      ? options.unitOfWorkInterceptor(store.unitOfWork)
      : store.unitOfWork;
    const executionOrchestrator = new ExecutionOrchestrator({
      unitOfWork: effectiveUnitOfWork,
      runtime,
      worktreeManager,
      eventSink: sharedEventSink,
      processRunner: sharedProcessRunner,
      processPolicy: verificationProcessPolicy,
      filesystemGuard: new LocalWorktreeFilesystemGuard()
    });
    return { gitAdapter, worktreeManager, evidenceCollector, executionOrchestrator };
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
    phase: "phase-4-omp-adapter",
    runtime: runtimeKind,
    ...(runtimeKind === "omp" ? { ompPath } : {}),
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

  // P1-R02（Phase 4 第三轮验收 §7.3）：受控取消端点。
  //
  // 取消 API 必须先调用 `ExecutionOrchestrator.cancelRuntimeForTask`
  // 终止当前任务对应的 Runtime 运行（Omp 子进程树），再调用
  // `TaskOrchestrator.cancel` 迁移任务状态到 CANCELLED 并写审计。
  //
  // 顺序不可颠倒：若先迁移状态，Omp 进程可能仍继续写入 worktree，
  // 与“取消后无后续写入”的安全约束冲突。`cancelRuntimeForTask`
  // 对未知 runId 或已结束的运行安全（no-op），不影响正常取消流程。
  //
  // **P1-R02-D（§7.3 第 3 点 取消失败被错误降级）**：
  // 区分两种失败：
  // 1. 项目未登记（getServicesForProject 抛错）—— 无 Runtime 可终止，
  //    安全降级到 CANCELLED 状态迁移。
  // 2. cancelRuntimeForTask 抛错（runtime.cancel 失败或 ProcessRunner
  //    异常）—— Runtime 终止失败，不得伪装成 CANCELLED。必须迁移到
  //    INTERRUPTED（EXECUTING/VALIDATING）或 FAILED（REVIEWING 等），
  //    并返回 500，保留可见的失败/中断状态供人工处理。
  app.post<{ Params: { taskId: string }; Body: { reason: string } }>(
    "/tasks/:taskId/cancel",
    async (req, reply) => {
      try {
        const taskId = req.params.taskId;

        // §10.1 线性化修复：先遍历已缓存的项目服务调用 cancelRuntimeForTask，
        // 再读取任务。原因：store.unitOfWork.run 使用 BEGIN IMMEDIATE 获取写锁，
        // 当 develop 的 save 事务持有写锁（如 §10.1 屏障测试场景）时，读取
        // 任务会被阻塞，导致无法及时 abort controller。先调用
        // cancelRuntimeForTask（纯内存操作）确保 abort 信号立即设置，使
        // runDevelop 中 save 后的 abort 检查能命中。
        //
        // cancelRuntimeForTask 对 pendingLeases 中不存在的 taskId 是 no-op
        //（返回 undefined），遍历所有已缓存服务是安全的。
        let runtimeTerminationFailed = false;
        let runtimeTerminationError: Error | undefined;
        let cancelledRunId: string | undefined;

        // 1a. §10.1：先遍历已缓存服务调用 cancelRuntimeForTask（不受写锁阻塞）
        for (const services of projectServicesCache.values()) {
          try {
            const runId = await services.executionOrchestrator.cancelRuntimeForTask(taskId);
            if (runId) {
              cancelledRunId = runId;
              break; // 找到匹配的活动运行，不再遍历
            }
          } catch (err) {
            // cancelRuntimeForTask 抛错 —— 记录但不中断遍历
            const errorMessage = (err as Error).message ?? "";
            if (!errorMessage.includes("未登记")) {
              runtimeTerminationFailed = true;
              runtimeTerminationError = err as Error;
            }
          }
        }
        if (cancelledRunId) {
          logger.info(
            { taskId, runId: cancelledRunId },
            "取消 API 已终止 Runtime 运行（通过缓存遍历）"
          );
        }

        // 1b. 读取任务（可能被 develop 的写锁阻塞，但 abort 信号已设置）
        const task = await store.unitOfWork.run((tx) => tx.tasks.findById(taskId));
        if (!task) return reply.code(404).send({ error: "任务不存在" });

        // 1c. 若缓存遍历未找到活动运行且未出错，尝试通过 projectId 获取服务
        //（处理 develop 尚未开始或服务未缓存的场景）
        if (!cancelledRunId && !runtimeTerminationFailed) {
          try {
            const services = await getServicesForProject(task.projectId);
            const runId = await services.executionOrchestrator.cancelRuntimeForTask(taskId);
            if (runId) {
              cancelledRunId = runId;
              logger.info(
                { taskId, runId: cancelledRunId },
                "取消 API 已终止 Runtime 运行（通过 projectId 查找）"
              );
            }
          } catch (err) {
            const errorMessage = (err as Error).message ?? "";
            // 项目未登记：getServicesForProject 抛 "项目 {id} 未登记"
            // 此场景下无 Runtime 可终止，安全降级到 CANCELLED。
            if (errorMessage.includes("未登记")) {
              logger.warn(
                { taskId, err: errorMessage },
                "取消 API 无法获取项目服务，跳过 Runtime 终止（项目未登记，安全降级）"
              );
            } else {
              // P1-R02-D：Runtime 终止失败 —— 不得降级到 CANCELLED。
              // 迁移到 INTERRUPTED/FAILED 并返回 500。
              runtimeTerminationFailed = true;
              runtimeTerminationError = err as Error;
              logger.error(
                { taskId, err: errorMessage },
                "取消 API Runtime 终止失败 —— 将迁移到 INTERRUPTED/FAILED 而非 CANCELLED"
              );
            }
          }
        }

        // 2. 状态迁移
        const cancelReason = req.body?.reason ?? "通过 API 取消";
        if (runtimeTerminationFailed) {
          // P1-R02-D：Runtime 终止失败时迁移到 INTERRUPTED 或 FAILED。
          // - EXECUTING / VALIDATING → INTERRUPTED（进程可能仍在运行）
          // - 其他非终态 → FAILED（INTERRUPTED 不在这些状态的合法出边）
          //
          // 竞态处理：abort signal 可能使并发的 /run 请求先通过
          // handleRunError 把任务迁移到 INTERRUPTED/FAILED。此时本路径
          // 的 interrupt/fail 会抛 IllegalTransitionError。重新读取任务
          // 状态：若已处于终态（INTERRUPTED/FAILED/CANCELLED），仍返回 500
          // （Runtime 终止失败是事实），但 body 为当前任务状态。
          const failReason = `Runtime 终止失败：${runtimeTerminationError?.message ?? "未知错误"}；原取消原因：${cancelReason}`;
          try {
            let updated;
            if (task.status === "EXECUTING" || task.status === "VALIDATING") {
              updated = await orchestrator.interrupt(taskId, failReason);
            } else {
              updated = await orchestrator.fail(taskId, failReason);
            }
            return reply.code(500).send(updated);
          } catch (migrationErr) {
            // 任务可能已被并发 /run 请求的 handleRunError 迁移到终态。
            // 重新读取并返回 500（Runtime 终止失败是事实，不降级到 CANCELLED）。
            const currentTask = await store.unitOfWork.run((tx) =>
              tx.tasks.findById(taskId)
            );
            if (currentTask) {
              logger.warn(
                { taskId, currentStatus: currentTask.status, migrationErr: (migrationErr as Error).message },
                "取消 API Runtime 终止失败且状态迁移失败 —— 任务已被并发迁移到终态"
              );
              return reply.code(500).send(currentTask);
            }
            return reply.code(500).send({
              error: `Runtime 终止失败且状态迁移失败：${failReason}（迁移错误：${(migrationErr as Error).message}）`
            });
          }
        }

        // 正常路径：迁移到 CANCELLED 并写审计。
        const updated = await orchestrator.cancel(taskId, cancelReason);
        return updated;
      } catch (err) {
        const message = (err as Error).message;
        const name = (err as Error).name;
        if (name === "TaskNotFoundError") {
          return reply.code(404).send({ error: message });
        }
        // §9.3 竞态：cancel API 与并发 /run 的 handleRunError 竞争状态迁移。
        // 若 handleRunError 先把任务迁移到终态（INTERRUPTED/FAILED），
        // orchestrator.cancel 抛 TerminalTaskError/IllegalTransitionError。
        // 返回 409 + 当前任务状态，不掩盖并发迁移的结果。
        if (name === "TerminalTaskError" || name === "IllegalTransitionError") {
          const currentTask = await store.unitOfWork.run((tx) =>
            tx.tasks.findById(req.params.taskId)
          );
          if (currentTask) {
            return reply.code(409).send(currentTask);
          }
        }
        return reply.code(400).send({ error: message });
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

  // P1-04（Phase 4 验收）：受控的 EXECUTING 状态迁移入口。
  //
  // 调用方无法通过 /tasks/:taskId/transition?to=EXECUTING 直接迁移到
  // EXECUTING —— TaskOrchestrator.transitionTask 显式拒绝该路径，要求
  // 经此端点调用 beginExecutionIfApproved，由 Orchestrator 在事务内：
  //   1. 校验当前任务状态 === AWAITING_EXECUTION_APPROVAL；
  //   2. 加载最新 execution approval（已 approved 且未失效）；
  //   3. 在事务内通过 computeCurrentScopeHashFromTx 重算权威 scopeHash
  //      （不信任调用方传入的 hash），与 approval.scopeHash 比对；
  //   4. 一致则迁移到 EXECUTING 并写审计事件；不一致抛 ScopeMismatchError。
  //
  // 此端点是进入 EXECUTING 的唯一合法入口，配合 /tasks/:taskId/run
  //   phase="develop" 才能形成完整闭环。
  app.post<{ Params: { taskId: string } }>(
    "/tasks/:taskId/begin-execution",
    async (req, reply) => {
      try {
        const updated = await orchestrator.beginExecutionIfApproved(
          req.params.taskId
        );
        return reply.code(200).send(updated);
      } catch (err) {
        const message = (err as Error).message;
        const name = (err as Error).name;
        const code =
          name === "TaskNotFoundError" ? 404 :
          name === "ScopeMismatchError" ? 403 :
          400;
        return reply.code(code).send({ error: message });
      }
    }
  );

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

  // P4：受控执行编排端点 —— 经 ExecutionOrchestrator 驱动 runtime 闭环。
  //
  // 调用方通过 phase 参数指定要执行的阶段：
  // - "analyze"：在 EXECUTING 调用 runtime.analyze 分析 worktree
  //   （P1-04 §2.2：analyze 需要 worktree + Plan，故合法位置在 EXECUTING）
  // - "develop"：在 EXECUTING 调用 runtime.develop 修改 worktree，
  //   随后捕获 Diff 并跑项目 test 命令验证
  // - "review"：在 REVIEWING 调用 runtime.review 做独立审查
  //
  // 不绕过状态机与审批闸门：每个 phase 都校验当前任务状态是否匹配，
  // 调用方必须先通过 /transition / /approvals / /worktrees 端点完成
  // 状态迁移与审批登记，再调用本端点执行 runtime。
  //
  // **P1-R02（§7.3 第 4 点 异常状态未迁移）**：
  // 当 runAnalyze/runDevelop/runReview 抛出 `RuntimeStreamFailedError`
  // 或 `TaskNotInExpectedStatusError` 时，路由必须把任务状态迁移到
  // `FAILED`（或 `INTERRUPTED`），并写审计。不得只返回 HTTP 400 而
  // 让任务停留在 `EXECUTING`/`REVIEWING`，否则与 §5.2 "永不为中途
  // 死亡的进程声称成功" 冲突。
  app.post<{
    Params: { taskId: string };
    Body: { phase: "analyze" | "develop" | "review" };
  }>("/tasks/:taskId/run", async (req, reply) => {
    try {
      const phase = req.body?.phase;
      if (phase !== "analyze" && phase !== "develop" && phase !== "review") {
        return reply.code(400).send({ error: "phase 必须是 analyze / develop / review" });
      }
      const task = await store.unitOfWork.run((tx) =>
        tx.tasks.findById(req.params.taskId)
      );
      if (!task) return reply.code(404).send({ error: "任务不存在" });

      const services = await getServicesForProject(task.projectId);
      const exec = services.executionOrchestrator;

      if (phase === "analyze") {
        // P1-04（Phase 4 验收 §2.2）：analyze 的合法位置在 EXECUTING
        if (task.status !== "EXECUTING") {
          return reply.code(409).send({
            error: `analyze 要求任务状态为 EXECUTING，当前为 ${task.status}`
          });
        }
        try {
          const result = await exec.runAnalyze(task.id);
          return reply.code(200).send(result);
        } catch (err) {
          return handleRunError(reply, orchestrator, task.id, "analyze", err);
        }
      }

      if (phase === "develop") {
        if (task.status !== "EXECUTING") {
          return reply.code(409).send({
            error: `develop 要求任务状态为 EXECUTING，当前为 ${task.status}`
          });
        }
        try {
          const result = await exec.runDevelop(task.id);
          return reply.code(200).send({
            runId: result.runId,
            eventCount: result.eventCount,
            summary: result.summary,
            diff: {
              worktreePath: result.diff.worktreePath,
              hash: result.diff.hash,
              changedFiles: result.diff.changedFiles,
              bytes: result.diff.bytes,
              patchPreview: result.diff.patch.slice(0, 4096)
            },
            verificationExitCode: result.verificationExitCode,
            verificationPassed: result.verificationPassed,
            verificationStdoutPreview: result.verificationStdout.slice(0, 2048),
            verificationStderrPreview: result.verificationStderr.slice(0, 2048)
          });
        } catch (err) {
          return handleRunError(reply, orchestrator, task.id, "develop", err);
        }
      }

      // phase === "review"
      if (task.status !== "REVIEWING") {
        return reply.code(409).send({
          error: `review 要求任务状态为 REVIEWING，当前为 ${task.status}`
        });
      }
      // P1-03：Reviewer 输入必须来自受控来源（execution_results 表），
      //         不接受调用方提交的 diff 或 verificationResult。
      //         详见 ExecutionOrchestrator.runReview 的安全约束。
      try {
        const result = await exec.runReview(task.id);
        return reply.code(200).send(result);
      } catch (err) {
        // P1-03：DiffTamperError 是受控错误（非 Runtime 失败），不迁移状态
        const isDiffTamper = (err as Error).name === "DiffTamperError";
        if (isDiffTamper) {
          return reply.code(409).send({ error: (err as Error).message });
        }
        return handleRunError(reply, orchestrator, task.id, "review", err);
      }
    } catch (err) {
      const message = (err as Error).message;
      return reply.code(400).send({ error: message });
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

/**
 * P1-R02-D（§7.3 第 4 点 异常状态未迁移）：处理 /run 端点的 Runtime 错误。
 *
 * 当 `runAnalyze`/`runDevelop`/`runReview` 抛出安全相关错误时，路由不能
 * 只返回 HTTP 4xx 而让任务停留在 `EXECUTING`/`REVIEWING`。必须把任务
 * 状态原子迁移到终态（INTERRUPTED/FAILED）并写审计，再返回对应 HTTP
 * 状态码。这与规格 §5.2「永不为中途死亡的进程声称成功」一致。
 *
 * 错误处理矩阵：
 * - `RuntimeStreamFailedError`：Runtime 事件流出现 error 或未以 completed
 *   结束（取消/超时/异常）。
 *   - analyze/develop（EXECUTING）→ `interrupt`（进程可能仍残留）→ 500
 *   - review（REVIEWING）→ `fail`（REVIEWING 无 INTERRUPTED 出边）→ 500
 * - `TaskNotInExpectedStatusError`：任务状态在事务内 re-check 时与预期
 *   不符（典型：被并发取消 API 迁移到 CANCELLED）。任务已处于终态或
 *   安全状态，无需再迁移。→ 409（指示客户端重新读取状态）
 * - `PathScopeViolationError`：runDevelop 检测到 Diff 越界（P1-R01）。
 *   任务仍在 EXECUTING → `fail`（执行已被污染，需重新审批）→ 500
 * - review 阶段的其他 Runtime 错误（omp 超时/非零退出/解析失败等）：
 *   §7.3 第 3 点要求 Runtime 异常失败时必须迁移到终态。review 是
 *   Runtime 调用，失败后任务卡在 REVIEWING 无法自愈，必须 `fail` → 500。
 * - analyze/develop 阶段的其他错误：不迁移状态（可能是临时故障，
 *   调用方可重试）→ 400
 *
 * 状态迁移失败（如任务已被并发迁移到终态）时，捕获 `TerminalTaskError` /
 * `IllegalTransitionError` 并降级为 409，避免迁移异常掩盖原始错误。
 */
async function handleRunError(
  reply: FastifyReply,
  orchestrator: TaskOrchestrator,
  taskId: string,
  phase: "analyze" | "develop" | "review",
  err: unknown
): Promise<FastifyReply> {
  const error = err as Error;
  const errorName = error.name;
  const message = error.message;

  // RuntimeStreamFailedError：Runtime 失败，必须迁移到终态
  if (error instanceof RuntimeStreamFailedError || errorName === "RuntimeStreamFailedError") {
    const failReason = `Runtime ${phase} 失败：${message}`;
    try {
      // analyze/develop 在 EXECUTING → INTERRUPTED（进程可能仍残留）
      // review 在 REVIEWING → FAILED（REVIEWING 无 INTERRUPTED 出边）
      if (phase === "review") {
        await orchestrator.fail(taskId, failReason);
      } else {
        await orchestrator.interrupt(taskId, failReason);
      }
    } catch (migrationErr) {
      // 任务可能已被并发取消/迁移到终态 —— 降级，不掩盖原始错误
      return reply.code(409).send({
        error: `Runtime ${phase} 失败且状态迁移失败：${message}（迁移错误：${(migrationErr as Error).message}）`
      });
    }
    return reply.code(500).send({ error: failReason });
  }

  // TaskNotInExpectedStatusError：任务已被并发迁移（如取消）
  if (error instanceof TaskNotInExpectedStatusError || errorName === "TaskNotInExpectedStatusError") {
    // 任务已不在预期状态（典型：被取消 API 迁移到 CANCELLED）。
    // 无需再迁移 —— 让客户端重新读取状态。
    return reply.code(409).send({
      error: `任务状态已被并发迁移，无法执行 ${phase}：${message}`
    });
  }

  // PathScopeViolationError：Diff 越界（P1-R01），任务仍在 EXECUTING
  if (error instanceof PathScopeViolationError || errorName === "PathScopeViolationError") {
    const failReason = `Runtime ${phase} 路径越界：${message}`;
    try {
      await orchestrator.fail(taskId, failReason);
    } catch (migrationErr) {
      return reply.code(409).send({
        error: `路径越界且状态迁移失败：${message}（迁移错误：${(migrationErr as Error).message}）`
      });
    }
    return reply.code(500).send({ error: failReason });
  }

  // ExecutionIsolationError：执行期隔离失败（P1-R01 §14.2），Runtime 未启动。
  // 必须迁移到 INTERRUPTED（analyze/develop）或 FAILED（review）并返回 500。
  if (error instanceof ExecutionIsolationError || errorName === "ExecutionIsolationError") {
    const failReason = `执行期隔离失败：${message}`;
    try {
      if (phase === "review") {
        await orchestrator.fail(taskId, failReason);
      } else {
        await orchestrator.interrupt(taskId, failReason);
      }
    } catch (migrationErr) {
      return reply.code(409).send({
        error: `执行期隔离失败且状态迁移失败：${message}（迁移错误：${(migrationErr as Error).message}）`
      });
    }
    return reply.code(500).send({ error: failReason });
  }

  // review 阶段的其他 Runtime 错误（omp 超时/非零退出/解析失败等）：
  // §7.3 第 3 点要求 Runtime 异常失败时必须迁移到终态。review 失败后
  // 任务卡在 REVIEWING 无法自愈，必须迁移到 FAILED。
  // DiffTamperError 已在路由层单独处理（409），不会走到这里。
  if (phase === "review") {
    const failReason = `Runtime review 失败：${message}`;
    try {
      await orchestrator.fail(taskId, failReason);
    } catch (migrationErr) {
      return reply.code(409).send({
        error: `Runtime review 失败且状态迁移失败：${message}（迁移错误：${(migrationErr as Error).message}）`
      });
    }
    return reply.code(500).send({ error: failReason });
  }

  // analyze/develop 阶段的其他错误：不迁移状态（可能是临时故障，调用方可重试）
  return reply.code(400).send({ error: message });
}

/**
 * 加载项目根 `.env` 文件（P4：零依赖方案）。
 *
 * 使用 Node 22+ 内置的 `process.loadEnvFile(path)`。行为：
 * - 已存在的 `process.env` 不会被 `.env` 覆盖（仅填充缺失项），允许
 *   测试通过显式 env 覆盖。
 * - 文件不存在时静默跳过，不抛错。
 * - `.env` 已在 `.gitignore`（第 32-34 行），不会提交。
 *
 * 路径解析：从本文件（apps/api/src/composition-root.ts → dist/）往上
 * 查找项目根目录的 `.env`，不依赖 `process.cwd()`（pnpm filter 启动时
 * cwd 可能是子包目录）。
 *
 * 不引入 dotenv 依赖：Node 22 内置功能已满足需求，且 AGENTS.md 规则 7
 * 限制 MVP 依赖范围。
 */
function loadDotEnv(): void {
  try {
    // import.meta.url 在 ESM 中指向当前模块文件。
    // 编译后路径为 <root>/apps/api/dist/composition-root.js，
    // 项目根是往上三级。
    const moduleDir = fileDirname(import.meta.url);
    const projectRoot = resolve(moduleDir, "..", "..", "..");
    const envPath = join(projectRoot, ".env");
    process.loadEnvFile?.(envPath);
  } catch {
    // .env 不存在或不可读 —— 静默跳过，使用现有 process.env。
  }
}
