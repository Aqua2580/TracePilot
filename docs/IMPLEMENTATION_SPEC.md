# TracePilot 实施规格

> 版本：v1.2  
> 目标：为后续 AI 和开发者提供唯一的实现依据。本文定义 MVP 边界、架构、数据契约、执行流程、阶段门槛与验收标准。

## 1. 项目目标与实施原则

TracePilot 是面向本地 Git 代码仓库的证据驱动软件工程平台。它接收失败测试日志或 Issue，在修改代码前收集代码、Git、运行时和历史经验等证据；随后在隔离工作树中规划、修改、验证、审查，并将经人工确认的修复经验写入 SQLite 项目级记忆。SAG 是后续可选的同步与检索扩展，不参与 MVP 成功路径。

核心闭环：

```text
失败测试 / Issue
→ 任务结构化
→ 历史经验与代码证据收集
→ 冻结 Evidence Pack
→ 生成计划
→ 隔离 worktree 修改
→ 受控验证
→ 独立 Review
→ 人工审批
→ Repair Memory 沉淀
```

实现优先级：**先完成一条真实可验证的纵向闭环，再扩展多 Agent 并行、SAG、Web 功能和复杂评测。** 不得为了界面或模块数量牺牲端到端可运行性。

### 1.1 两级完成标准

```text
MVP Done
= SQLite Repair Memory + 真实任务闭环 + 安全治理

Resume Release Done
= MVP Done + 真实 OmpAdapter + SAG KnowledgeAdapter
  + 跨 ADR/Issue/PR/Repair Record 检索
  + SQLite 与 SAG 对比评测 + 至少一个运行时调试证据场景
```

SAG 不得阻塞 MVP，但不能从最终简历发布版中省略。项目对外描述为“多 Agent 协作”时，必须至少具备 Planner、Developer、Reviewer 的独立 Session、独立输入上下文和结构化结果交接；在实现实际并行前，不得声称“多 Agent 并行协作”。

## 2. MVP 范围

### 2.1 必须实现

* 注册本地 Git 项目：仓库路径、默认分支、语言、固定验证命令。
* 输入 Python `pytest` 或 TypeScript `Vitest/Jest` 的失败日志，或一个结构化 Issue。
* 规则化任务提取：目标、约束、验收条件、风险等级。
* SQLite Repair Memory、Git 历史和代码搜索证据采集；SQLite 是 MVP 的唯一持久化依赖。
* 带来源和版本的不可变 Evidence Pack。
* 单任务、串行状态机；Planner、Developer、Reviewer 是权限与输入不同的独立角色 Session，不要求并发。
* 外置 Git worktree、受控修改、Diff、测试命令、验证结果。
* 独立 Reviewer、人工批准/拒绝、审计日志。
* 写入和召回已验证的 Repair Record。

### 2.2 明确不做

自动 Push/合并 PR、生产环境访问、远程命令、自动数据库迁移、复杂并行 DAG、多租户账号体系、DAP 自动调试、远程 Agent、Docker、PostgreSQL、Prisma、Redis、完整 SAG 服务、端到端浏览器测试。

任何不在本节的能力都不得阻塞 MVP。若实现扩展能力，必须先新增 ADR 和验收标准。

## 3. 运行时边界

```text
TracePilot Core       = 领域状态、证据、编排、治理规则
Pi / oh-my-pi         = 代码阅读、搜索、修改、测试、Diff 的执行 Runtime
SQLite                 = MVP 唯一持久化依赖：任务业务状态、审计与 Repair Memory
SAG                   = Resume Release 必备的知识检索/镜像 Adapter；不是 MVP 前置依赖或 SQLite 写入前提
Git + worktree        = 代码版本和隔离修改工作区
Fastify / React       = API、SSE 与 UI，不承载领域规则
```

Pi/oh-my-pi 的实际 API 不得被假定。必须先实现 `OmpAdapter` Spike，验证：指定工作目录中的读取/搜索、受限修改、测试运行、Diff 获取、事件回传、取消与超时收口。如果 Spike 不稳定，使用 `LocalCommandAdapter` 作为临时执行实现，但保持 Adapter 接口不变。

### 3.1 SQLite-only 运行约束

MVP 数据库位置固定在用户本地数据目录：

```text
%LOCALAPPDATA%/TracePilot/data/tracepilot.db
```

该文件不得提交到 Git。项目仓库中只保存应用源码、迁移文件与示例配置，不保存任何用户任务、修复记录、日志、凭据或绝对本地路径。

SQLite 初始化必须启用 `foreign_keys=ON`、WAL journal mode 和有限的 `busy_timeout`。业务状态变更与审计事件使用短事务；不得在数据库事务中等待模型响应、运行测试、创建 worktree 或调用外部进程。

MVP 仅支持单进程、单任务串行编排和单个 SQLite 写入队列。Runtime 事件先进入内存缓冲区，再按顺序批量追加到 `agent_runs`/`audit_events`，并对单条输出和单任务总日志设置大小上限。不得通过多个 API 实例、多个写入进程或并发任务来规避 SQLite 写锁。

启动时必须执行数据库可用性检查；在执行迁移前创建可恢复备份或使用 SQLite 安全备份机制。导出/备份失败不得删除原数据库。横向扩展、多实例调度或高频实时日志存储属于 PostgreSQL 等后续架构决策，不能隐式加入 MVP。

### 3.2 技术栈冻结

```text
语言与包管理：TypeScript strict + pnpm
API 与事件：Fastify + REST + SSE
前端：React（最小 Dashboard，后置）
持久化：SQLite + Drizzle ORM
日志：Pino（应用日志）+ SQLite 审计摘要
测试：Vitest；Playwright 后置
运行环境：Windows 本地直接运行；不使用 Docker
```

不得将旧方案中的 NestJS、PostgreSQL、Prisma、Docker Compose 或“启动外部数据库服务”作为依赖、验收条件或文档示例。

### 3.3 文档与注释语言

所有开发者文档、ADR、AI 指令、代码注释、测试描述、日志中的业务说明和评审反馈必须使用中文。类型名、变量名、协议字段、第三方包名、命令行参数以及代码中必须保持兼容的原始术语可保留英文。

修改已有源码时，必须同步将所触及范围内的英文注释翻译为中文；不得为单纯翻译而改动运行逻辑、公开接口或自动生成文件。新增代码不允许再添加英文说明性注释。

### 3.4 实现与验收职责分离

实现 Agent 可以编写代码、补充测试并提交自测结果，但不得自行把阶段验收报告改为“通过”、自行关闭 P1/P2 问题或批准自己实现的代码。阶段验收必须由未参与该实现的独立 Reviewer Agent 执行：独立阅读规格、验收报告和变更后的源码，重新运行规定的测试、类型检查、lint 与构建，并将实际命令结果、发现的问题与最终结论写入验收报告。任何实现者自述只能作为待核验证据，不能作为验收结论。

## 4. 推荐目录与依赖方向

```text
tracepilot/
├── AGENTS.md
├── docs/
│   ├── IMPLEMENTATION_SPEC.md
│   └── adr/
├── apps/
│   ├── api/                     # Fastify：REST、SSE、composition root
│   └── web/                     # 最小任务界面，后置
├── packages/
│   ├── core/                    # 领域模型、状态机、服务、策略、接口
│   ├── store/                   # Drizzle schema、migrations、SQLite repositories
│   ├── orchestrator/            # 节点执行与恢复
│   ├── adapters/                # git、omp、knowledge、fake、process
│   ├── governance/              # command/path/approval/audit policy
│   ├── worktree-manager/
│   └── evaluation/
└── tests/
    ├── unit/
    ├── integration/
    ├── contract/
    └── fixtures/benchmarks/
```

依赖只能朝内：`apps → application/orchestrator → core → ports`；`store`、`adapters` 实现 Core 定义的接口。Core 不得 import Fastify、React、Drizzle、Git SDK 或 Pi SDK。

## 5. 核心领域模型

### 5.1 Project

```ts
type Project = {
  id: string;
  name: string;
  repositoryPath: string;        // 已解析且已校验的绝对路径
  defaultBranch: string;
  language: 'python' | 'typescript';
  commands: {
    lint?: CommandSpec;
    typecheck?: CommandSpec;
    test: CommandSpec;
    build?: CommandSpec;
  };
  knowledgeSourceId?: string;   // 仅 Phase 7+ 的可选 SAG Source 引用
  createdAt: string;
};

type CommandSpec = { argv: string[]; timeoutMs: number };
```

`argv` 是数组，绝不拼接 Issue、日志或模型输出到 shell 字符串。

### 5.2 Task 状态机

```text
CREATED → INTAKING → GATHERING_EVIDENCE → PLANNED
→ AWAITING_EXECUTION_APPROVAL → EXECUTING → VALIDATING
→ REVIEWING → AWAITING_HUMAN_APPROVAL → COMPLETED
                                      └→ REJECTED

任何非终态 → FAILED / CANCELLED / INTERRUPTED
```

* 状态迁移只能由 `TaskOrchestrator` 触发，并与审计事件在同一数据库事务中写入。
* 进程异常或服务重启中的运行任务必须置为 `INTERRUPTED`，不得误报成功。
* `COMPLETED` 前提：验证通过、Reviewer 无 P0/P1、人工审批通过。
* 执行过程中发现关键证据缺口时允许：`EXECUTING → EVIDENCE_GAP → GATHERING_EVIDENCE → PLANNED → AWAITING_EXECUTION_APPROVAL → EXECUTING`。若新计划扩大允许路径、命令范围或风险等级，已有执行审批自动失效，必须重新审批。

### 5.3 Evidence Pack

Evidence Pack 是同一任务、同一轮执行共享的不可变证据快照。它不可原地修改，但允许在受控流程中生成下一版本。Agent 只能引用当前批准版本的 Pack，不能把未记录的自由检索结果当作正式结论。

```ts
type EvidenceItem = {
  id: string;
  kind: 'code' | 'git' | 'runtime' | 'memory' | 'policy';
  source: string;
  locator: string;               // 文件:行、commit SHA、record ID 等
  capturedAt: string;
  contentHash: string;
  summary: string;
  relevance: number;             // 排序分数，不等于事实置信度
  trustLevel: 'PRIMARY' | 'VERIFIED_MEMORY' | 'UNVERIFIED';
};

type EvidencePack = {
  id: string;
  taskId: string;
  version: number;
  taskSnapshot: TaskInput;
  evidence: EvidenceItem[];
  hypotheses: Array<{ text: string; confidence: number; evidenceIds: string[] }>;
  constraints: Array<{ text: string; evidenceIds: string[]; required: boolean }>;
  acceptanceCriteria: string[];
  createdAt: string;
};
```

规则：根因只能以 `hypothesis` 表示并关联 `evidenceIds`；无来源信息不能成为强制约束；每次计划/执行必须记录输入 Pack 版本。

Developer、Planner 或 Reviewer 发现证据不足时，只能提交结构化 `EvidenceRequest`，包含缺口原因、需要的证据类别、允许查询的范围和预期对计划的影响。Orchestrator 审核该请求后回到 `GATHERING_EVIDENCE`，生成 `Evidence Pack v(n+1)`；旧版本永久保留用于审计。Agent 不得绕过此过程，将临时搜索内容直接写入根因、约束或 Review 结论。

### 5.4 Repair Record

```text
DRAFT → VERIFIED → APPROVED → DEPRECATED
```

* `VERIFIED`：测试通过且 Review 无 P0/P1，但尚未人工接受。
* `APPROVED`：人工明确接受，可作为后续任务的高可信历史经验。
* `DRAFT`、`DEPRECATED`：默认不得进入主提示上下文。
* 每条失败方案都要记录失败原因与适用条件，防止一次偶发失败被误用为通用规则。
* 验证与 Review 通过时创建或更新为 `VERIFIED`；人工批准任务时才更新为 `APPROVED`。不得跳过 `VERIFIED` 状态。

## 6. Adapter 契约

```ts
interface GitAdapter {
  validateRepository(projectPath: string): Promise<RepositoryInfo>;
  createWorktree(input: CreateWorktreeInput): Promise<Worktree>;
  getDiff(worktreePath: string): Promise<DiffArtifact>;
  getHistory(query: GitQuery): Promise<GitEvidence[]>;
  removeRegisteredWorktree(worktree: Worktree): Promise<void>;
}

interface RuntimeAdapter {
  analyze(input: RuntimeTaskInput): AsyncIterable<RuntimeEvent>;
  develop(input: RuntimeTaskInput): AsyncIterable<RuntimeEvent>;
  review(input: ReviewTaskInput): Promise<ReviewResult>;
  cancel(runId: string): Promise<void>;
}

interface KnowledgeAdapter {
  search(query: MemoryQuery): Promise<RepairRecord[]>;
  write(record: RepairRecord): Promise<void>;
}

interface ProcessRunner {
  run(spec: CommandSpec, cwd: string, policy: ProcessPolicy): Promise<CommandResult>;
}
```

MVP 必须实现 `SqliteRepairMemoryAdapter` 和 `FakeKnowledgeAdapter`；二者通过同一组契约测试。`SagKnowledgeAdapter` 在 Resume Release 的 Phase 7+ 实现，且不能替代 SQLite 的任务、审计或 Repair Record 真源。若启用 SAG，同步必须通过可重试 outbox 异步进行；SQLite 写入成功不得等待或依赖 SAG 成功。

每个真实 Adapter 必须与 Fake Adapter 通过同一组契约测试，至少保证：结构化错误、超时、取消、非零退出码、输出截断、路径记录和稳定的产物格式。

## 7. 隔离执行与治理规则

### 7.1 Worktree

Worktree 必须创建在仓库外的受控目录：

```text
%LOCALAPPDATA%/TracePilot/worktrees/<project-slug>/<task-id>/
```

创建前校验仓库、默认分支、目标目录和 Git 状态。清理时仅删除同时满足以下条件的目录：路径位于受控根目录、已在数据库登记、任务已终态。不得递归删除用户仓库或推导出的不明路径。

### 7.2 风险策略

| 风险 | 默认策略 |
| --- | --- |
| 读取、搜索、LSP、Diff、配置的测试命令 | 自动允许并审计 |
| 修改 worktree 内允许文件、创建 worktree、配置的构建命令 | 需执行审批或项目预授权，并审计 |
| 删除文件、依赖安装、网络访问、数据库迁移 | 必须逐次人工审批 |
| Push、PR 创建/合并、远程命令、凭据读取、生产环境访问 | 默认禁止 |

所有路径在实际操作前解析真实路径，验证其处于项目根或登记 worktree 内，并拒绝路径穿越和符号链接逃逸。Agent 提出的命令只能匹配项目注册时的固定 `argv` 白名单。

### 7.3 审计

追加记录：任务输入摘要、Evidence Pack 哈希与版本、计划节点、实际 argv、cwd、退出码、输出截断信息、Diff 哈希、审批人、Review 结论。敏感变量只记录变量名，不记录值。Runtime 原始输出不得无上限写入 SQLite：保存截断摘要、哈希、字节数与必要的可读尾部；完整调试日志只在受控本地日志目录短期保留。

## 8. MVP 工作流

### 8.1 失败测试到 Patch

1. 创建任务并提取失败测试名、堆栈、错误类型、约束和验收条件。
2. Evidence Router 按确定性规则请求代码、Git、运行时和 Repair Memory 证据。
3. 生成并持久化 Evidence Pack v1；用户可查看来源。
4. Planner 输出线性计划：复现、定位、设计、修改、补测试、验证、Review。
5. 获取执行批准后创建 worktree，并把允许路径、Pack、计划和验收条件传给 Developer。
6. Developer 仅在 worktree 改动；所有动作通过 Runtime/Process Adapter 发出事件。
7. Validation 按固定顺序执行：format（若配置）→ lint → typecheck → test → build（若配置）。
8. Reviewer 只接收原始任务、Pack、最终 Diff、验证结果、验收条件；不接收 Developer 的推理过程。
9. 无 P0/P1 时在同一 SQLite 真源中创建或更新 `VERIFIED` Repair Record，并进入人工批准；批准后更新为 `APPROVED`。Phase 7+ 通过 outbox 异步镜像该记录到 SAG；SAG 故障不能回滚或阻塞该任务完成。

### 8.2 Issue 到 Patch

输入 Issue 后先规则化提取 `objective`、`constraints`、`acceptanceCriteria`。后续完全复用 8.1；不能在 Issue-to-Patch 另建一条绕过 Evidence Pack、审批或 Review 的路径。

## 9. 实施计划与阶段门槛

### Phase 0：运行时 Spike（1-2 天）

实现最小 `OmpAdapter` 探针，验证读/改/测/Diff/取消和事件格式；写 `ADR-001-runtime-boundary.md`。若失败，落地 `LocalCommandAdapter`。  
**退出条件：** 已有真实命令记录证明可在指定目录完成最小读改测，或兜底 Adapter 可用。

### Phase 1：骨架和状态机（第 1 周）

建立 pnpm workspace、strict TypeScript、Vitest、Fastify、Pino、Core 与 InMemory Repository。实现 Project/Task/审计/状态机。  
**退出条件：** 状态迁移、取消、失败、重试与中断恢复的单元测试通过。

### Phase 2：SQLite、Fake 闭环、评测基准（第 2 周）

接入 Drizzle/SQLite 和迁移；建立 6-10 个固定基准任务；以 Fake Adapter 跑完整产物链。实现 SQLite 初始化、短事务、单写入队列、日志截断和安全备份。  
**退出条件：** 服务重启正确收口任务；每个基准任务可重复生成相同结构的 Pack/计划/审计；迁移、备份与 SQLite 锁等待策略通过集成测试。

### Phase 3：Git 与证据（第 3 周）

实现外置 worktree、Diff、历史、blame、日志解析、Evidence Router 与 Pack 版本。  
**退出条件：** 两个样例仓库能安全创建/回收 worktree；所有 Pack 证据可回溯来源。

### Phase 4：真实修复闭环（第 4 周）

接真实 `OmpAdapter`，先支持 pytest，再支持 Vitest/Jest；完成受控验证。`LocalCommandAdapter` 只能用于 Spike、Fake 测试或明确记录的降级，不能成为发布演示的唯一 Runtime。  
**退出条件：** 至少两个真实失败任务能由 `OmpAdapter` 在不污染原分支的情况下完成仓库分析、worktree 代码修改、测试执行与 Diff 获取，并产出 Patch 与测试结果。

### Phase 5：Review、审批、Repair Memory（第 5 周）

实现独立 Reviewer、P0-P3、批准/拒绝、记忆检索与质量门。  
**退出条件：** 人为构造的兼容性问题或缺少回归测试能被 Review 阻止；批准记忆可带来源被召回。

### Phase 6：最小 Dashboard（第 6 周）

实现项目、任务、时间线、Evidence Pack、Diff、验证、Review、审批和记忆视图。  
**退出条件：** 非开发者可通过 UI 完成一次演示；SSE 断线可恢复任务状态。

### Phase 7：Resume Release — SAG、运行时调试与评测（第 7-8 周）

以 `KnowledgeAdapter` 接入本地 SAG，并保持 SQLite 为唯一真源和默认基线；完成 ADR、Issue、PR 与 Repair Record 的来源可追溯检索；跑无记忆、SQLite Memory、SAG 镜像/检索增强三组对比。SAG 可以作为本地独立进程接入，但不得要求 Docker、PostgreSQL 或远程基础设施。增加一个最小运行时调试场景：从 pytest Stack Trace 定位断点，读取局部变量并写入带来源的 `runtime` Evidence；仅在 Omp/DAP 能力经 Spike 验证后实施。  
**退出条件：** 未配置 SAG 时所有 MVP 场景仍可通过；Resume Release 已配置真实 SAG 且完成跨文档检索演示；真实 `OmpAdapter` 已完成分析、修改、验证、Diff 和独立 Review；Adapter 可切换、无跨项目召回、outbox 可重试且不阻塞 SQLite 任务完成；运行时调试证据可在 Evidence Pack 中回溯；所有指标、样本数量与未验证限制均有记录。

## 10. 测试、评测与完成定义

| 层级 | 必测内容 |
| --- | --- |
| Unit | 状态机、Evidence Gap 回环、风险策略、Router、记忆排序、证据引用完整性 |
| Contract | Fake 与真实 Adapter 的成功/失败/取消/超时/输出格式一致性 |
| Integration | SQLite 迁移、备份、WAL/锁等待策略、单写入队列、Git worktree、命令白名单、路径边界、服务重启 |
| Scenario | pytest 或 Vitest 失败 → Patch → 验证 → Review → 审批 → 记忆 |
| Adversarial | Issue Prompt 注入、恶意相对路径、危险命令、越权修改 |

MVP Definition of Done：

* 在两个独立样例仓库中完成至少 6 个任务，至少 4 个产出经人工认可的 Patch；
* 每个任务均可查到 Evidence Pack、计划、Diff、验证命令与结果、Review、审批和审计；
* 所有写操作发生在登记 worktree 中，越权执行次数为 0；
* `COMPLETED` 任务不存在 P0/P1 Review 问题，且有人工审批；
* 未安装 Docker、PostgreSQL、SAG 或任何远程基础设施时，全部 MVP 场景仍可执行；
* 可报告任务闭环率、Patch 验收率、关键证据 Recall@5、无依据修改率、人工介入次数、耗时和 Token 成本。

Resume Release Definition of Done：

* 满足全部 MVP Definition of Done；
* 真实 `OmpAdapter` 已在至少两个任务中完成分析、隔离修改、验证、Diff 获取和独立 Reviewer 调用；
* 本地 SAG 已通过 `KnowledgeAdapter` 查询 ADR、Issue、PR、Repair Record，并提供可回溯来源；
* 已在固定基准任务集上报告无记忆、SQLite Memory 与 SAG 检索增强的对比结果；
* 至少一个运行时调试场景生成了可回溯的 `runtime` Evidence；
* 未实现实际并行时，对外表述为“职责隔离的多 Agent 工作流”，不得表述为“多 Agent 并行协作”。

样本不足时只报告探索性结果，不能声称记忆或 SAG 已显著提高修复质量。

## 11. 初始 ADR 清单

1. `ADR-001-runtime-boundary.md`：Pi/oh-my-pi 和 LocalCommandAdapter 的接口、已验证能力与降级策略。
2. `ADR-002-worktree-and-command-safety.md`：worktree 根目录、路径解析、命令 argv 白名单、清理策略。
3. `ADR-003-evidence-and-memory-trust.md`：Evidence Pack 版本、证据等级、Repair Record 状态与召回规则。
4. `ADR-004-sag-adapter.md`：SQLite 与 SAG 的检索/写入契约、项目隔离和来源引用。
5. `ADR-005-sqlite-runtime.md`：SQLite 数据位置、PRAGMA、备份、短事务、单写入队列、日志保留和单进程边界。
6. `ADR-006-evidence-pack-evolution.md`：Evidence Request、Pack 版本升级、审批失效条件与审计保留规则。

## 12. 不可违背的验收原则

1. “测试通过”不是任务成功的唯一条件；必须同时满足证据、验收条件、Review 和人工审批。
2. 模型输出不是事实；证据与来源才是事实依据。
3. 任何真实代码修改必须隔离在 worktree 中，并可用 Diff 和审计还原。
4. 任何高风险操作必须默认拒绝，而不是仅依赖提示词约束。
5. SAG、并行多 Agent 和复杂 UI 都是后续增量，不能替代真实闭环。
6. SQLite 是 MVP 唯一真源和唯一持久化依赖；SAG 只能作为可选异步镜像或检索增强，不能阻塞任务完成。
7. SAG 对 MVP 可选、对 Resume Release 必选；最终演示不得以 `LocalCommandAdapter` 替代真实 `OmpAdapter`。
8. Evidence Pack 不可原地修改，但必须允许经编排器批准的版本升级；所有正式结论均可回溯到具体 Pack 版本。
