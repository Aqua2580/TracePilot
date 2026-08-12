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
  type UnitOfWork,
  type HumanDecisionFinalizationGuard,
  type HumanDecisionFinalizationInput,
  type AuditEvent,
  type EvidenceConstraint,
  type Hypothesis,
  type ExecutionResult,
  type Task,
  type KnowledgeAdapter,
  type SagMirrorTransport
} from "@tracepilot/core";
import { defaultGovernancePolicies } from "@tracepilot/governance";
import {
  LocalCommandAdapter,
  LocalProcessRunner,
  LocalGitAdapter,
  LocalWorktreeFilesystemGuard,
  LocalControlledFileWriter,
  OmpAdapter,
  SagHttpTransport,
  SagKnowledgeAdapter,
  resolveDefaultWorktreePath,
  ExecutionIsolationError
} from "@tracepilot/adapters";
import {
  createSqliteStore,
  resolveDefaultDataPath,
  RuntimeEventBuffer,
  type SqliteStore
} from "@tracepilot/store";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
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
  /** 服务端可信人工身份；不接受 HTTP 请求体声明。 */
  readonly humanApprovalIdentity?: string;
  /** 仅供人类 UI/CLI 通道的审批共享凭证，不注入任何 Runtime 进程。 */
  readonly humanApprovalChannelSecret?: string;
  /** 仅用于审批 TOCTOU 屏障测试；生产环境必须留空。 */
  readonly approvalFinalizationHook?: (input: {
    readonly taskId: string;
    readonly diffHash: string;
  }) => Promise<void>;
  /**
   * Dashboard 构建目录。生产环境使用 apps/web/dist；测试可注入临时目录，
   * 从而验证静态资源服务不会越过该目录读取任意文件。
   */
  readonly dashboardDistPath?: string;
  /** 仅用于测试：注入 SAG 传输替身，不能替代生产环境的本地 HTTP 配置。 */
  readonly sagTransportOverride?: SagMirrorTransport;
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
  const sagTransport = createSagTransport(options);
  // 配置错误必须在打开 SQLite 前失败，避免半配置在 Windows 留下数据库文件锁。
  const store = createSqliteStore({ dbPath });
  const knowledgeAdapter: KnowledgeAdapter = sagTransport
    ? new SagKnowledgeAdapter({
      sqliteMemory: store.knowledgeAdapter,
      resolveKnowledgeSourceId: async (projectId) =>
        store.unitOfWork.run(async (tx) => (await tx.projects.findById(projectId))?.knowledgeSourceId),
      transport: sagTransport
    })
    : store.knowledgeAdapter;
  const humanDecisionFinalizationGuard: HumanDecisionFinalizationGuard = {
    async finalize<T>(input: HumanDecisionFinalizationInput<T>): Promise<T> {
      const task = await store.unitOfWork.run((tx) => tx.tasks.findById(input.taskId));
      if (!task) throw new Error(`任务不存在：${input.taskId}`);
      const services = await getServicesForProject(task.projectId);
      return services.executionOrchestrator.finalize(input);
    }
  };
  const orchestrator = new TaskOrchestrator({
    unitOfWork: store.unitOfWork,
    humanApproval: {
      identity: options.humanApprovalIdentity ?? process.env.TRACEPILOT_HUMAN_APPROVER,
      channelSecret:
        options.humanApprovalChannelSecret ?? process.env.TRACEPILOT_HUMAN_APPROVAL_SECRET,
      challengeTtlMs: 5 * 60 * 1000
    },
    humanDecisionFinalizationGuard
  });
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

  // Phase 7：仅在本地 SAG 显式配置时启动 outbox 投递。处理器不参与任何
  // SQLite 业务事务；失败只保留为待重试记录，绝不阻断任务完成。
  const sagOutboxTimer = sagTransport
    ? setInterval(() => {
      void store.sagOutbox.processReady(sagTransport).catch((error) => {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, "SAG outbox 本轮投递失败，将按队列重试");
      });
    }, 5_000)
    : undefined;
  sagOutboxTimer?.unref();

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
      knowledgeAdapter,
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
      filesystemGuard: new LocalWorktreeFilesystemGuard(),
      approvalFinalizationHook: options.approvalFinalizationHook
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
  const dashboardDistPath = options.dashboardDistPath ?? resolveDashboardDistPath();

  // Phase 6：Dashboard 与 API 同源提供。这样浏览器无需保存 API 地址或
  // 凭证，SSE 也能在同源策略下自动恢复连接。只允许读取构建目录中的静态
  // 文件；路径穿越、绝对路径和缺失的入口页一律失败关闭。
  app.get("/dashboard", async (_req, reply) =>
    sendDashboardAsset(reply, dashboardDistPath, "index.html", true)
  );
  app.get<{ Params: { "*": string } }>("/dashboard/*", async (req, reply) =>
    sendDashboardAsset(reply, dashboardDistPath, req.params["*"], false)
  );

  // 健康检查 —— 操作者用来确认 API 存活与持久化模式。
  app.get("/health", async () => ({
    status: "ok",
    phase: "phase-4-omp-adapter",
    runtime: runtimeKind,
    ...(runtimeKind === "omp" ? { ompPath } : {}),
    knowledge: sagTransport ? "sag-enhanced" : "sqlite-memory",
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

  // Phase 6：Dashboard 项目列表。这里只暴露已经登记的项目，绝不在 UI
  // 路径上接受或探测任意本地仓库路径。
  app.get("/projects", async () => {
    const projects = await store.unitOfWork.run((tx) => tx.projects.findAll());
    return { projects: sortNewestFirst(projects) };
  });

  app.get<{ Params: { projectId: string } }>("/projects/:projectId", async (req, reply) => {
    const project = await store.unitOfWork.run((tx) => tx.projects.findById(req.params.projectId));
    if (!project) return reply.code(404).send({ error: "项目未登记" });
    return project;
  });

  // Dashboard 只读取项目既有任务；创建任务仍使用受校验的 POST /tasks。
  app.get<{ Params: { projectId: string } }>("/projects/:projectId/tasks", async (req, reply) => {
    const project = await store.unitOfWork.run((tx) => tx.projects.findById(req.params.projectId));
    if (!project) return reply.code(404).send({ error: "项目未登记" });
    const tasks = await store.unitOfWork.run((tx) => tx.tasks.findByProject(project.id));
    return { tasks: sortNewestFirst(tasks) };
  });

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

  // Phase 6：读取不可变 Evidence Pack 的全部版本。任务只保存当前 Pack
  // 引用，版本集合必须由 SQLite 仓储按 Pack ID 查询，避免 UI 伪造来源。
  app.get<{ Params: { taskId: string } }>("/tasks/:taskId/evidence-packs", async (req, reply) => {
    const task = await store.unitOfWork.run((tx) => tx.tasks.findById(req.params.taskId));
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    if (!task.currentEvidencePackId) return { packs: [] };
    const packs = await store.unitOfWork.run((tx) =>
      tx.evidencePacks.findVersions(task.currentEvidencePackId as string)
    );
    return { packs };
  });

  // Phase 6：Dashboard 提交的补充结论必须先形成 Evidence Request，再基于
  // 当前 Pack 已存在的 Evidence ID 生成新版本。UI 不能直接覆写 v1，也
  // 不能伪造任意外部 EvidenceItem；这保留了 §5.3 的不可变版本边界。
  app.get<{ Params: { taskId: string } }>("/tasks/:taskId/evidence-requests", async (req, reply) => {
    const task = await store.unitOfWork.run((tx) => tx.tasks.findById(req.params.taskId));
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    const requests = await store.unitOfWork.run((tx) => tx.evidenceRequests.findByTask(task.id));
    return { requests };
  });

  app.post<{
    Params: { taskId: string };
    Body: { gapReason: string; expectedPlanImpact: string };
  }>("/tasks/:taskId/evidence-requests", async (req, reply) => {
    try {
      const gapReason = req.body?.gapReason?.trim();
      const expectedPlanImpact = req.body?.expectedPlanImpact?.trim();
      if (!gapReason || !expectedPlanImpact) {
        return reply.code(400).send({ error: "gapReason 与 expectedPlanImpact 均为必填" });
      }
      const request = await orchestrator.submitEvidenceRequest({
        taskId: req.params.taskId,
        // Dashboard 将该请求限定为计划阶段的补充结论；不接受调用方伪造
        // developer/reviewer 角色，以免混淆运行期 Evidence Gap 语义。
        requesterRole: "planner",
        gapReason,
        neededKinds: ["code"],
        allowedScope: "仅引用当前 Evidence Pack 中已存在的 Evidence ID",
        expectedPlanImpact
      });
      return reply.code(201).send(request);
    } catch (err) {
      const name = (err as Error).name;
      const message = (err as Error).message;
      return reply.code(name === "TaskNotFoundError" ? 404 : 400).send({ error: message });
    }
  });

  app.post<{
    Params: { taskId: string; requestId: string };
    Body: {
      rootCause: Hypothesis;
      applicabilityConditions?: readonly EvidenceConstraint[];
    };
  }>("/tasks/:taskId/evidence-requests/:requestId/resolve", async (req, reply) => {
    try {
      const task = await store.unitOfWork.run((tx) => tx.tasks.findById(req.params.taskId));
      if (!task) return reply.code(404).send({ error: "任务不存在" });
      if (!task.currentEvidencePackId) {
        return reply.code(409).send({ error: "任务尚未形成 Evidence Pack，不能补充结论" });
      }
      const currentPack = await store.unitOfWork.run((tx) =>
        tx.evidencePacks.findLatestVersion(task.currentEvidencePackId as string)
      );
      if (!currentPack) return reply.code(409).send({ error: "当前 Evidence Pack 不存在" });

      const body = req.body;
      const validationError = validateDashboardEvidenceConclusion(
        body?.rootCause,
        body?.applicabilityConditions,
        currentPack.evidence.map((item) => item.id)
      );
      if (validationError) return reply.code(400).send({ error: validationError });

      const pack = await orchestrator.evolvePackWithNewEvidence({
        taskId: task.id,
        requestId: req.params.requestId,
        // 不接受网页提交新的 EvidenceItem；只为已登记证据添加可追溯的
        // hypothesis / constraint，由 Orchestrator 创建不可变 v(n+1)。
        additions: {
          evidence: [],
          hypotheses: [body.rootCause],
          constraints: body.applicabilityConditions
        }
      });
      return reply.code(201).send(pack);
    } catch (err) {
      const name = (err as Error).name;
      const message = (err as Error).message;
      const code = name === "TaskNotFoundError" ? 404 : 400;
      return reply.code(code).send({ error: message });
    }
  });

  // Phase 6：Diff 与验证结果只读取 runDevelop 已写入的受控产物。响应使用
  // 预览上限，避免浏览器页面意外承载超大 patch 或完整测试日志。
  app.get<{ Params: { taskId: string } }>("/tasks/:taskId/execution-results", async (req, reply) => {
    const task = await store.unitOfWork.run((tx) => tx.tasks.findById(req.params.taskId));
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    const results = await store.unitOfWork.run((tx) => tx.executionResults.findByTask(task.id));
    return { source: "controlled-execution-results", results: results.map(toDashboardExecutionResult) };
  });

  // Phase 6：审查产物、审批记录和审计时间线均只读自 SQLite 真源，供
  // Dashboard 分面展示。人工决定仍必须走 Phase 5 的两步挑战端点。
  app.get<{ Params: { taskId: string } }>("/tasks/:taskId/approvals", async (req, reply) => {
    const task = await store.unitOfWork.run((tx) => tx.tasks.findById(req.params.taskId));
    if (!task) return reply.code(404).send({ error: "任务不存在" });
    const approvals = await store.unitOfWork.run((tx) => tx.approvals.findByTask(task.id));
    return { approvals };
  });

  // SSE 在连接时立即推送最新持久化状态，并仅在任务或最新审计事件变化时
  // 再推送。连接中断后 EventSource 自动重连，会重新取得当前 SQLite 状态；
  // 因此客户端不依赖易丢失的内存事件来恢复任务视图。
  app.get<{ Params: { taskId: string } }>("/tasks/:taskId/events", async (req, reply) => {
    const initialTask = await store.unitOfWork.run((tx) => tx.tasks.findById(req.params.taskId));
    if (!initialTask) return reply.code(404).send({ error: "任务不存在" });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer"
    });
    raw.write("retry: 2000\n\n");

    let closed = false;
    let lastSignature = "";
    const publish = async (): Promise<void> => {
      try {
        const snapshot = await readTaskSnapshot(store.unitOfWork, req.params.taskId);
        if (closed || !snapshot) return;
        const signature = `${snapshot.task.updatedAt}:${snapshot.latestAudit?.id ?? ""}`;
        if (signature === lastSignature) return;
        lastSignature = signature;
        raw.write(buildTaskSnapshotEvent(snapshot.task, snapshot.latestAudit));
      } catch {
        // 不把内部错误或路径信息发送给浏览器；浏览器会按照 retry 自动重连。
        if (!closed) raw.write("event: stream_error\ndata: {\"error\":\"任务状态暂不可读取\"}\n\n");
      }
    };

    await publish();
    let lastHeartbeatAt = Date.now();
    const timer = setInterval(() => {
      void publish();
      const now = Date.now();
      // SSE 注释帧不携带任务数据，只用于让代理/浏览器及时发现半开连接。
      if (!closed && now - lastHeartbeatAt >= 15000) {
        raw.write(": heartbeat\n\n");
        lastHeartbeatAt = now;
      }
    }, 2000);
    req.raw.once("close", () => {
      closed = true;
      clearInterval(timer);
    });
  });

  // 迁移任务 —— POST /tasks/:taskId/transition，body 为 { to, reason? }。
  app.post<{
    Params: { taskId: string };
    Body: { to: TaskStatus; reason?: string };
  }>("/tasks/:taskId/transition", async (req, reply) => {
    const { to, reason } = req.body ?? ({} as { to: TaskStatus; reason?: string });
    if (!to) return reply.code(400).send({ error: "to 为必填" });
    const publicTransitionTargets = new Set<TaskStatus>([
      "INTAKING",
      "GATHERING_EVIDENCE",
      "PLANNED",
      "AWAITING_EXECUTION_APPROVAL",
      "EVIDENCE_GAP",
      "VALIDATING",
      "REVIEWING"
    ]);
    if (!publicTransitionTargets.has(to)) {
      return reply.code(403).send({
        error: `公开 transition 端点禁止进入安全敏感状态 ${to}`
      });
    }
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
        // Phase 5：Review 完成后必须立即经过确定性质量门，不能只把
        // Runtime 返回的 verdict 原样交给调用方。质量门通过才进入
        // AWAITING_HUMAN_APPROVAL；阻断结果会把任务收口为 FAILED。
        const gated = await orchestrator.recordReviewAndGate({
          taskId: task.id,
          review: result
        });
        const response = {
          ...result,
          qualityGate: gated.qualityGate,
          repairRecord: gated.repairRecord,
          task: gated.task
        };
        return reply.code(gated.qualityGate.passed ? 200 : 422).send(response);
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

  // Phase 5：签发一次性人工审批挑战。
  // 可信身份和通道凭证来自服务端装配，不从请求体读取 approver。
  app.post<{
    Params: { taskId: string };
    Body: { decision: "approved" | "rejected" };
  }>("/tasks/:taskId/human-approval/challenge", async (req, reply) => {
    try {
      const channelSecretHeader = req.headers["x-tracepilot-human-channel-secret"];
      const channelSecret = Array.isArray(channelSecretHeader)
        ? channelSecretHeader[0]
        : channelSecretHeader;
      if (!channelSecret) {
        return reply.code(401).send({ error: "缺少人工审批通道凭证" });
      }
      const rawBody = (req.body ?? {}) as unknown as Record<string, unknown>;
      if ("approver" in rawBody || "channelSecret" in rawBody) {
        return reply.code(400).send({ error: "approver 和 channelSecret 不得由调用方提交" });
      }
      if (req.body?.decision !== "approved" && req.body?.decision !== "rejected") {
        return reply.code(400).send({ error: "decision 必须是 approved 或 rejected" });
      }

      const task = await store.unitOfWork.run((tx) => tx.tasks.findById(req.params.taskId));
      if (!task) return reply.code(404).send({ error: "任务不存在" });
      const services = await getServicesForProject(task.projectId);
      await services.executionOrchestrator.assertReviewDiffStillCurrent(task.id);
      const challenge = await orchestrator.issueHumanApprovalChallenge({
        taskId: task.id,
        decision: req.body.decision,
        channelSecret
      });
      return reply.code(201).send(challenge);
    } catch (err) {
      const name = (err as Error).name;
      const message = (err as Error).message;
      if (name === "TaskNotFoundError") return reply.code(404).send({ error: message });
      if (name === "HumanApprovalCredentialError") return reply.code(401).send({ error: message });
      if (name === "HumanApprovalConfigurationError") return reply.code(503).send({ error: message });
      if (name === "InvalidApprovalStateError" || name === "ReviewNotReadyError" || name === "TaskNotInExpectedStatusError" || name === "DiffTamperError") {
        return reply.code(409).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  // Phase 5：消费一次性挑战，完成最终批准 / 拒绝。
  // 请求体只允许 challengeToken 和 reason；approver/decision 由服务端挑战绑定。
  app.post<{
    Params: { taskId: string };
    Body: {
      challengeToken: string;
      reason?: string;
    };
  }>("/tasks/:taskId/human-approval", async (req, reply) => {
    try {
      const body = req.body ?? ({} as { challengeToken: string; reason?: string });
      const rawBody = body as unknown as Record<string, unknown>;
      if ("approver" in rawBody || "decision" in rawBody) {
        return reply.code(400).send({ error: "approver 和 decision 不得由调用方提交，请先申请并消费人工审批挑战" });
      }
      if (typeof body.challengeToken !== "string" || body.challengeToken.length === 0) {
        return reply.code(400).send({ error: "challengeToken 为必填" });
      }
      const channelSecretHeader = req.headers["x-tracepilot-human-channel-secret"];
      const channelSecret = Array.isArray(channelSecretHeader)
        ? channelSecretHeader[0]
        : channelSecretHeader;
      if (!channelSecret) return reply.code(401).send({ error: "缺少人工审批通道凭证" });

      const task = await store.unitOfWork.run((tx) => tx.tasks.findById(req.params.taskId));
      if (!task) return reply.code(404).send({ error: "任务不存在" });
      const result = await orchestrator.recordHumanDecision({
        taskId: req.params.taskId,
        challengeToken: body.challengeToken,
        channelSecret,
        reason: body.reason
      });
      return reply.code(200).send(result);
    } catch (err) {
      const name = (err as Error).name;
      const message = (err as Error).message;
      if (name === "TaskNotFoundError") {
        return reply.code(404).send({ error: message });
      }
      if (name === "HumanApprovalCredentialError") {
        return reply.code(401).send({ error: message });
      }
      if (name === "HumanApprovalConfigurationError") {
        return reply.code(503).send({ error: message });
      }
      if (name === "InvalidApprovalStateError" || name === "ReviewNotReadyError" || name === "HumanApprovalChallengeError" || name === "TaskNotInExpectedStatusError" || name === "DiffTamperError" || name === "HumanDecisionFinalizationError") {
        return reply.code(409).send({ error: message });
      }
      return reply.code(400).send({ error: message });
    }
  });

  // Phase 5：查询某个任务产生的 Repair Record，包括 DRAFT / VERIFIED /
  // APPROVED / DEPRECATED 全部生命周期记录，供审计和人工查看。
  app.get<{ Params: { taskId: string } }>(
    "/tasks/:taskId/repair-records",
    async (req, reply) => {
      const task = await store.unitOfWork.run((tx) => tx.tasks.findById(req.params.taskId));
      if (!task) return reply.code(404).send({ error: "任务不存在" });
      const records = await store.unitOfWork.run((tx) => tx.repairRecords.findByTask(task.id));
      return { records };
    }
  );

  // Phase 5：项目级 Repair Memory 召回。默认只返回 APPROVED 记录，并在
  // 响应中保留 recordId、taskId、Evidence Pack 和 Diff 哈希作为来源链。
  app.get<{
    Params: { projectId: string };
    Querystring: { symptom?: string; rootCause?: string; maxResults?: string };
  }>("/projects/:projectId/repair-memory", async (req, reply) => {
    const project = await store.unitOfWork.run((tx) => tx.projects.findById(req.params.projectId));
    if (!project) return reply.code(404).send({ error: "项目未登记" });

    const parsedMax = req.query.maxResults === undefined ? undefined : Number(req.query.maxResults);
    if (parsedMax !== undefined && (!Number.isInteger(parsedMax) || parsedMax < 1 || parsedMax > 100)) {
      return reply.code(400).send({ error: "maxResults 必须是 1 到 100 的整数" });
    }

    const records = await knowledgeAdapter.search({
      projectId: project.id,
      symptom: req.query.symptom,
      rootCause: req.query.rootCause,
      maxResults: parsedMax
    });
    return {
      source: sagTransport ? "sag-enhanced-sqlite-truth" : "sqlite-memory",
      records: records.map((record) => ({
        ...record,
        sourceLocator: {
          adapter: "sqlite-memory",
          recordId: record.id,
          taskId: record.taskId,
          evidencePackId: record.inputEvidencePackId,
          evidencePackVersion: record.inputEvidencePackVersion,
          evidencePackContentHash: record.inputEvidencePackContentHash,
          evidenceIds: record.rootCauseEvidenceIds,
          applicabilityEvidence: record.applicabilityConditionEvidence,
          diffHash: record.diffHash
        }
      }))
    };
  });

  // policies 与 runtime 仅供测试 / 后续装配引用，不直接暴露 API。
  void policies;
  void runtime;

  const close = async (): Promise<void> => {
    if (sagOutboxTimer) clearInterval(sagOutboxTimer);
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

/** 只有地址与令牌同时显式存在时才启用 SAG；避免半配置绕过 SQLite 基线。 */
function createSagTransport(options: CompositionRootOptions): SagMirrorTransport | undefined {
  if (options.sagTransportOverride) return options.sagTransportOverride;
  const baseUrl = process.env.TRACEPILOT_SAG_BASE_URL;
  const token = process.env.TRACEPILOT_SAG_TOKEN;
  if (!baseUrl && !token) return undefined;
  if (!baseUrl || !token) {
    throw new Error("SAG 配置不完整：TRACEPILOT_SAG_BASE_URL 与 TRACEPILOT_SAG_TOKEN 必须同时设置");
  }
  return new SagHttpTransport({ baseUrl, token });
}

/** Dashboard 显示的单条执行产物预览上限。完整产物仍保存在 SQLite 真源。 */
const DASHBOARD_DIFF_PREVIEW_LIMIT = 64 * 1024;
const DASHBOARD_OUTPUT_PREVIEW_LIMIT = 8 * 1024;

/**
 * 把受控执行产物转换成适于页面展示的只读预览。
 *
 * 不接受浏览器提交的 Diff 或验证结果，也不把完整大输出无上限地传到页面；
 * Review 的可信输入仍只能通过 ExecutionOrchestrator 从该 SQLite 产物读取。
 */
function toDashboardExecutionResult(result: ExecutionResult) {
  const patch = truncateDashboardText(result.diffPatch, DASHBOARD_DIFF_PREVIEW_LIMIT);
  const stdout = truncateDashboardText(result.verificationStdout, DASHBOARD_OUTPUT_PREVIEW_LIMIT);
  const stderr = truncateDashboardText(result.verificationStderr, DASHBOARD_OUTPUT_PREVIEW_LIMIT);
  return {
    id: result.id,
    runId: result.runId,
    createdAt: result.createdAt,
    diff: {
      hash: result.diffHash,
      changedFiles: result.diffChangedFiles,
      bytes: result.diffBytes,
      patchPreview: patch.value,
      truncated: patch.truncated
    },
    verification: {
      exitCode: result.verificationExitCode,
      passed: result.verificationPassed,
      stdoutPreview: stdout.value,
      stdoutTruncated: stdout.truncated,
      stderrPreview: stderr.value,
      stderrTruncated: stderr.truncated
    }
  };
}

function truncateDashboardText(value: string, limit: number): {
  readonly value: string;
  readonly truncated: boolean;
} {
  return value.length > limit
    ? { value: value.slice(0, limit), truncated: true }
    : { value, truncated: false };
}

/**
 * 校验 Dashboard 补充结论只能引用当前 Evidence Pack 中已经存在的证据。
 *
 * 这只是 HTTP 边界的输入校验；真正的版本化、任务归属和 Request 归属仍由
 * TaskOrchestrator 在同一 SQLite 事务中强制执行，二者缺一不可。
 */
function validateDashboardEvidenceConclusion(
  rootCause: unknown,
  applicabilityConditions: unknown,
  availableEvidenceIds: readonly string[]
): string | undefined {
  const available = new Set(availableEvidenceIds);
  const validateReferences = (value: unknown, field: string): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return `${field} 必须是对象`;
    }
    const item = value as Record<string, unknown>;
    if (typeof item.text !== "string" || item.text.trim().length === 0) {
      return `${field}.text 必须是非空字符串`;
    }
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0) {
      return `${field}.evidenceIds 必须是非空数组`;
    }
    const ids = item.evidenceIds;
    if (ids.some((id) => typeof id !== "string" || id.trim().length === 0)) {
      return `${field}.evidenceIds 只能包含非空字符串`;
    }
    if (new Set(ids).size !== ids.length) {
      return `${field}.evidenceIds 不得包含重复值`;
    }
    if (ids.some((id) => !available.has(id))) {
      return `${field}.evidenceIds 只能引用当前 Evidence Pack 中的证据`;
    }
    return undefined;
  };

  const rootCauseError = validateReferences(rootCause, "rootCause");
  if (rootCauseError) return rootCauseError;
  const rootCauseRecord = rootCause as Record<string, unknown>;
  if (
    typeof rootCauseRecord.confidence !== "number" ||
    !Number.isFinite(rootCauseRecord.confidence) ||
    rootCauseRecord.confidence < 0 ||
    rootCauseRecord.confidence > 1
  ) {
    return "rootCause.confidence 必须位于 0 到 1";
  }

  if (applicabilityConditions === undefined) return undefined;
  if (!Array.isArray(applicabilityConditions)) {
    return "applicabilityConditions 必须是数组";
  }
  for (const [index, condition] of applicabilityConditions.entries()) {
    const error = validateReferences(condition, `applicabilityConditions[${index}]`);
    if (error) return error;
    const conditionRecord = condition as Record<string, unknown>;
    if (typeof conditionRecord.required !== "boolean") {
      return `applicabilityConditions[${index}].required 必须是布尔值`;
    }
  }
  return undefined;
}

/** 以任务更新时间优先排序，避免修改 SQLite 仓储返回的原始数组。 */
function sortNewestFirst<T extends { readonly createdAt: string; readonly updatedAt?: string }>(
  records: readonly T[]
): T[] {
  return [...records].sort((left, right) => {
    const leftAt = left.updatedAt ?? left.createdAt;
    const rightAt = right.updatedAt ?? right.createdAt;
    return rightAt.localeCompare(leftAt);
  });
}

/**
 * SSE 快照使用任务与最新审计的极简元信息。审计全文仍通过 /audit 获取，
 * 这样一条事件不会重复携带日志、命令输出或可能较长的理由字段。
 */
async function readTaskSnapshot(
  unitOfWork: UnitOfWork,
  taskId: string
): Promise<{ readonly task: Task; readonly latestAudit?: AuditEvent } | undefined> {
  return unitOfWork.run(async (tx) => {
    const task = await tx.tasks.findById(taskId);
    if (!task) return undefined;
    const audit = await tx.audit.findByTask(taskId);
    return { task, latestAudit: audit[audit.length - 1] };
  });
}

/** 导出纯序列化器，便于在不持久连接的测试中验证 SSE 首帧格式。 */
export function buildTaskSnapshotEvent(task: Task, latestAudit?: AuditEvent): string {
  const payload = {
    task,
    latestAudit: latestAudit
      ? {
          id: latestAudit.id,
          type: latestAudit.type,
          recordedAt: latestAudit.recordedAt
        }
      : undefined,
    emittedAt: new Date().toISOString()
  };
  return `event: task_snapshot\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** 解析生产环境的 Dashboard 构建目录，不依赖 process.cwd()。 */
function resolveDashboardDistPath(): string {
  // 源码路径为 apps/api/src，编译后为 apps/api/dist；二者向上两级都是 apps。
  return resolve(fileDirname(import.meta.url), "..", "..", "web", "dist");
}

/**
 * 安全发送 Dashboard 静态资源。`relative` + `isAbsolute` 同时覆盖 Windows
 * 盘符、UNC 路径、../ 穿越和分隔符混用，任何越界路径都不触碰文件系统。
 */
async function sendDashboardAsset(
  reply: FastifyReply,
  dashboardDistPath: string,
  requestedPath: string,
  isEntry: boolean
): Promise<FastifyReply> {
  applyDashboardSecurityHeaders(reply);
  const normalizedPath = requestedPath.replaceAll("\\", "/");
  if (
    normalizedPath.length === 0 ||
    normalizedPath.includes("\0") ||
    normalizedPath.startsWith("/")
  ) {
    return reply.code(400).send({ error: "Dashboard 资源路径非法" });
  }

  const absolutePath = resolve(dashboardDistPath, normalizedPath);
  const fromRoot = relative(dashboardDistPath, absolutePath);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith("../") ||
    fromRoot.startsWith("..\\") ||
    isAbsolute(fromRoot)
  ) {
    return reply.code(400).send({ error: "Dashboard 资源路径非法" });
  }

  try {
    const content = await readFile(absolutePath);
    return reply
      .type(dashboardContentType(extname(absolutePath)))
      .header("cache-control", isEntry ? "no-cache" : "public, max-age=300")
      .send(content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && isEntry) {
      return reply.code(503).send({
        error: "Dashboard 尚未构建，请先运行 pnpm --filter @tracepilot/web build"
      });
    }
    return reply.code(404).send({ error: "Dashboard 资源不存在" });
  }
}

/** Dashboard 会输入审批凭证，因此静态响应默认限制为同源资源和连接。 */
function applyDashboardSecurityHeaders(reply: FastifyReply): void {
  reply
    .header(
      "content-security-policy",
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'"
    )
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .header("x-frame-options", "DENY")
    .header("permissions-policy", "geolocation=(), microphone=(), camera=()");
}

function dashboardContentType(extension: string): string {
  switch (extension.toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
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
