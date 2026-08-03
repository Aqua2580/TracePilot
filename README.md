# TracePilot

> 证据驱动的本地 Git 仓库修复平台。
>
> 本仓库已完成 Phase 0、Phase 1、Phase 2（SQLite、Fake 闭环与评测基准）、**Phase 3（Git 与证据）** 和 **Phase 4（真实修复闭环）** 的独立验收。Phase 4 已于 2026-08-03 由用户指定的最终独立 Reviewer 正式签发，完整证据与不可回退边界见 [`docs/reviews/PHASE-4-ACCEPTANCE-REVIEW.md`](docs/reviews/PHASE-4-ACCEPTANCE-REVIEW.md) 第 21 节。完整规格见 [`docs/IMPLEMENTATION_SPEC.md`](docs/IMPLEMENTATION_SPEC.md)，各阶段验收结论见 [`docs/reviews/`](docs/reviews/)，开发规则见 [`AGENTS.md`](AGENTS.md)。

## 一、项目简介

TracePilot 把"修复一个失败仓库"这件事拆成一条**带证据、带审批、带审计**的流水线：

```
CREATED → INTAKING → GATHERING_EVIDENCE → PLANNED
  → AWAITING_EXECUTION_APPROVAL → EXECUTING → VALIDATING
  → REVIEWING → AWAITING_HUMAN_APPROVAL → COMPLETED
```

每个状态迁移都强制满足以下不变量（见规格 §5.2 / §7）：

- 状态迁移与审计事件在**同一数据库事务**内写入。
- argv 永远是**固定白名单**，绝不拼接 issue 文本、日志或模型输出。
- 高风险操作（push / PR / 删库 / 装依赖）**默认拒绝**，无覆盖开关。
- 审计只记录环境变量**名**，值一律 `[redacted]`。
- Evidence Pack **按版本不可变**，新证据只能产出新版本。
- Repair Record 不能跳过 `VERIFIED` 直达 `APPROVED`。

## 二、技术栈

| 层 | 选型 |
| --- | --- |
| 语言 / 构建 | TypeScript strict + pnpm workspace（**Node ≥ 22**，推荐 24 LTS，见下文安装说明） |
| API | Fastify + REST + SSE（SSE 后置阶段） |
| 日志 | Pino |
| 持久化 | SQLite + Drizzle ORM（Phase 2 已接入；见 [ADR-005](docs/adr/ADR-005-sqlite-runtime.md)） |
| Git | `LocalGitAdapter`（Phase 3 已接入；经 `ProcessRunner` + `CommandPolicy` + `PathPolicy` 治理，见 [ADR-002](docs/adr/ADR-002-worktree-and-command-safety.md)） |
| 测试 | Vitest（单元 / 契约 / 集成） |
| Runtime | MVP 的降级/测试路径使用 `LocalCommandAdapter`；Phase 4 已验收的真实修复路径使用受治理 `OmpAdapter`，模型写入必须经过 `LocalControlledFileWriter`（见 [ADR-007](docs/adr/ADR-007-omp-adapter-spike-and-design.md) 与 [Phase 4 验收报告](docs/reviews/PHASE-4-ACCEPTANCE-REVIEW.md)） |

依赖方向：`apps → orchestrator → core → ports`。Core 零外部 SDK 导入（不依赖 Fastify / React / Drizzle / Git SDK / Pi SDK）。

## 三、目录结构

```
tracepilot/
├── AGENTS.md                          # 开发规则（不可违反）
├── .nvmrc                             # 固定 Node 24
├── docs/
│   ├── IMPLEMENTATION_SPEC.md         # 权威规格
│   ├── reviews/                       # 各阶段验收报告
│   │   ├── PHASE-1-ACCEPTANCE-REVIEW.md
│   │   ├── PHASE-2-ACCEPTANCE-REVIEW.md
│   │   ├── PHASE-3-ACCEPTANCE-REVIEW.md  # Phase 3 独立验收报告
│   │   └── PHASE-4-ACCEPTANCE-REVIEW.md  # Phase 4 最终独立验收与签发报告
│   └── adr/
│       ├── ADR-001-runtime-boundary.md   # Runtime 边界决策
│       ├── ADR-002-worktree-and-command-safety.md  # Worktree 受控根目录与命令安全（Phase 3）
│       ├── ADR-005-sqlite-runtime.md     # SQLite 运行时约束
│       └── ADR-007-omp-adapter-spike-and-design.md  # OmpAdapter 边界与演进记录
├── package.json / pnpm-workspace.yaml # workspace 配置（engineStrict）
├── tsconfig.base.json                 # strict TS 基线
├── packages/
│   ├── core/                          # 领域模型 + 状态机 + ports + InMemory repos + Orchestrator + EvidenceRouter
│   ├── governance/                    # 默认 command/path/approval/audit 策略
│   ├── adapters/                      # LocalCommandAdapter + LocalGitAdapter + git-parsers + Fakes
│   └── store/                         # SQLite + Drizzle schema + 迁移 + 仓储 + UnitOfWork + RuntimeEventBuffer
└── apps/
    └── api/                           # Fastify composition root + Pino（Phase 2 SQLite 装配）
```

## 四、安装

### 4.1 前置要求

- **Node.js ≥ 22**（推荐 24 LTS；`better-sqlite3@12` 通过 `prebuild-install` 提供 Node 22 与 24 的预编译二进制）
- pnpm ≥ 11
- git

项目通过以下机制约束 Node 版本（见 [AGENTS.md](AGENTS.md) 规则 15）：

- `package.json` 的 `engines.node` 声明 `>=22.0.0`
- `pnpm-workspace.yaml` 启用 `engineStrict: true`，pnpm 会拒绝低于 22 的 Node 版本
- `.nvmrc` 固定 `24`（使用 nvm/fnm 时自动切换）

```powershell
# 确认 Node 版本（必须 v22.x 或 v24.x）
node --version

# 在项目根目录安装依赖
pnpm install --no-frozen-lockfile
```

> Windows 上首次安装若报 `ERR_PNPM_IGNORED_BUILDS`，已在 `pnpm-workspace.yaml` 里通过 `allowBuilds: { esbuild: true, better-sqlite3: true }` 授权，正常情况会自动通过。`better-sqlite3@12` 会通过 `prebuild-install` 下载与当前 Node ABI 匹配的预编译二进制，无需本地编译工具链。

## 五、如何测试

### 5.1 一键跑全部测试

```powershell
pnpm -r run test
```

Phase 2 独立验收时的测试统计（Node 24 环境复验，作为历史基线）：

| 包 | 结果 |
| --- | --- |
| `@tracepilot/core` | 91 通过 |
| `@tracepilot/governance` | 244 通过 + 1 跳过（Windows symlink 受限，正常） |
| `@tracepilot/adapters` | 23 通过 |
| `@tracepilot/store` | 48 通过 |
| `@tracepilot/api` | 11 通过 |
| **合计** | **417 通过，1 跳过** |

> 上述数字已由独立 Reviewer 在 Node 24 环境复验通过。完整命令和验收范围见 [`docs/reviews/PHASE-2-ACCEPTANCE-REVIEW.md`](docs/reviews/PHASE-2-ACCEPTANCE-REVIEW.md)。

Phase 3 在 Phase 2 基础上新增了 `LocalGitAdapter`、`git-parsers`、`EvidenceRouter`、受控 WorktreeManager、证据/Pack 编排、`git-adapter-contract` 契约测试与真实 Git 集成测试。该阶段已由独立 Reviewer 验收通过；完整测试统计、P1 修复历史和后续不可回退边界见 [`docs/reviews/PHASE-3-ACCEPTANCE-REVIEW.md`](docs/reviews/PHASE-3-ACCEPTANCE-REVIEW.md)。

Phase 4 最终独立验收结果（2026-08-03）：本地回归 717 项通过、3 项按设计跳过，类型检查、Lint、构建和差异检查通过；29 项受控写入器测试覆盖真实路径、链接逃逸和 TOCTOU。经用户明确授权后，Python 与 JavaScript 两个合成失败仓库均由真实 Omp + DeepSeek 完成初始失败确认、analyze、受控修改、验证、Diff 和 review，严格验收命令 2 项通过。完整签发记录见 [`docs/reviews/PHASE-4-ACCEPTANCE-REVIEW.md`](docs/reviews/PHASE-4-ACCEPTANCE-REVIEW.md) 第 21 节。

真实模型验收不会被普通测试隐式触发；只有在 Omp、DeepSeek 凭据和 Python/pytest 前置条件齐全，并已取得外部模型调用授权时才运行：

```powershell
pnpm test:omp-real
```

### 5.2 单独跑某个包

```powershell
pnpm --filter @tracepilot/core test
pnpm --filter @tracepilot/governance test
pnpm --filter @tracepilot/adapters test
pnpm --filter @tracepilot/store test
pnpm --filter @tracepilot/api test
```

### 5.3 监听模式（写代码时实时反馈）

```powershell
pnpm --filter @tracepilot/core test:watch
```

### 5.4 类型检查 + 构建 + Lint

```powershell
pnpm -r run typecheck   # 全包类型检查
pnpm -r run lint        # 全包 ESLint
pnpm -r run build       # 全包构建（生成 dist/）
```

### 5.5 测试覆盖的关键不变量

| 测试文件 | 验证内容 |
| --- | --- |
| `packages/core/tests/task-state-machine.test.ts` | §5.2 状态机：合法/非法迁移、终态、INTERRUPTED 恢复、`canComplete` 前置条件 |
| `packages/core/tests/task-orchestrator.test.ts` | 状态迁移+审计同事务、取消、失败、中断恢复、审批记录、scope 失效、完成门槛、Phase 3 Pack v1/v(n+1) 编排、attachWorktree 审计、EvidenceRequest 状态迁移 |
| `packages/core/tests/repair-record.test.ts` | §5.4 Repair Record 状态机、不可跳过 VERIFIED |
| `packages/core/tests/evidence-pack.test.ts` | §5.3 Pack 版本不可变、内容哈希稳定且区分版本 |
| `packages/core/tests/evidence-router.test.ts` | §8.1 EvidenceRouter：failed_test_log / issue 两种 origin 的请求清单、确定性、空 failure fallback |
| `packages/governance/tests/command-policy.test.ts` | §7.2 命令白名单、默认拒绝列表、风险分级、全局选项绕过防御、git worktree 子命令结构化判定 |
| `packages/governance/tests/path-policy.test.ts` | §7.2 路径穿越拒绝、symlink 逃逸拒绝 |
| `packages/governance/tests/approval-policy.test.ts` | §7.2 风险表四档审批决策 |
| `packages/governance/tests/audit-policy.test.ts` | §7.3 环境变量脱敏、输出截断 |
| `packages/adapters/tests/adapters-smoke.test.ts` | Fake/Local/Omp 适配器行为、ADR-001 stub 抛错 |
| `packages/adapters/tests/git-parsers.test.ts` | git log / blame / diff / status 输出解析、空输出、多 commit、中文文件名 |
| `packages/adapters/tests/git-adapter-contract.test.ts` | §6 契约测试：FakeGitAdapter 与 LocalGitAdapter 通过同一套断言（结构、字段、路径穿越拒绝、未登记 worktree 拒绝） |
| `packages/adapters/tests/local-git-adapter.test.ts` | Phase 3 退出条件：python / typescript 样例仓库 worktree 创建/回收全流程、边界拒绝（非仓库、脏仓库、路径穿越、覆盖、受控根目录外） |
| `packages/store/tests/sqlite-store.test.ts` | SQLite 迁移、安全备份、WAL/锁等待、单写入队列、事务回滚、Evidence Pack 不可变、服务重启收口、双连接锁竞争 |
| `packages/store/tests/runtime-event-buffer.test.ts` | RuntimeEventBuffer 单条截断、总量超限尾部保留、顺序保持、flush 失败重试、重启后查询 |
| `packages/store/tests/benchmark-loop.test.ts` | 8 个固定基准任务消费 Fake Adapter 闭环、产物结构可重复 |
| `apps/api/tests/composition-root.test.ts` | API 端到端：建任务、迁移、审计时间线、非法迁移 400、SQLite 重启收口 |

## 六、如何运行 API

### 6.1 启动开发服务器

```powershell
# 先构建一次（Core 等包需要 dist/ 才能被 API 解析类型）
pnpm -r run build

# 启动 API（默认 127.0.0.1:7431）
pnpm --filter @tracepilot/api start
# 或开发模式（文件变化自动重启）
pnpm --filter @tracepilot/api dev
```

启动日志会显示：

```
TracePilot composition root 已初始化 —— Phase 2 SQLite 装配
TracePilot API 已监听
```

API 默认在用户数据目录创建 SQLite 数据库（路径可通过 `TRACEPILOT_DB_PATH` 环境变量覆盖）。若启动时发现有任务卡在 `EXECUTING` / `VALIDATING`，会自动迁移到 `INTERRUPTED`（§5.2 中断恢复）。

### 6.2 API 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回 `phase-2-sqlite` 标记 |
| GET | `/governance` | 当前生效的策略列表 |
| POST | `/tasks` | 创建任务，body: `{ projectId, input: TaskInput }` → 201 |
| GET | `/tasks/:taskId` | 查任务，404 if not found |
| POST | `/tasks/:taskId/transition` | 迁移状态，body: `{ to, reason? }` → 200 / 400（非法迁移） |
| POST | `/tasks/:taskId/cancel` | 取消任务，body: `{ reason }` |
| GET | `/tasks/:taskId/audit` | 该任务的审计事件时间线 |

### 6.3 端到端手动验证（PowerShell 示例）

```powershell
# 1. 健康检查
Invoke-WebRequest http://127.0.0.1:7431/health -UseBasicParsing | Select-Object -ExpandProperty Content

# 2. 创建任务
$body = @{
  projectId = "proj-1"
  input = @{
    objective = "fix pytest"
    constraints = @()
    acceptanceCriteria = @("pytest passes")
    riskLevel = "low"
    rawSource = "FAILED"
    origin = "failed_test_log"
  }
} | ConvertTo-Json -Depth 5
$resp = Invoke-WebRequest http://127.0.0.1:7431/tasks -Method POST -Body $body -ContentType "application/json" -UseBasicParsing
$taskId = ($resp.Content | ConvertFrom-Json).id
$resp.StatusCode   # 201

# 3. 迁移状态（CREATED → INTAKING）
$trans = @{ to = "INTAKING"; reason = "test" } | ConvertTo-Json
Invoke-WebRequest "http://127.0.0.1:7431/tasks/$taskId/transition" -Method POST -Body $trans -ContentType "application/json" -UseBasicParsing

# 4. 查看审计时间线（应有 task_created + task_transitioned 两条）
Invoke-WebRequest "http://127.0.0.1:7431/tasks/$taskId/audit" -UseBasicParsing | Select-Object -ExpandProperty Content

# 5. 非法迁移应返回 400
$bad = @{ to = "EXECUTING" } | ConvertTo-Json
Invoke-WebRequest "http://127.0.0.1:7431/tasks/$taskId/transition" -Method POST -Body $bad -ContentType "application/json" -UseBasicParsing
# StatusCode: 400, error: "Illegal transition ..."
```

## 七、Phase 0 / Phase 2 / Phase 3 决策摘要

### Phase 0 Runtime 边界

详见 [ADR-001](docs/adr/ADR-001-runtime-boundary.md)：

- 本节记录 ADR-001 的历史降级决策；Phase 4 已由 ADR-007 接续 OmpAdapter 实现。
- `LocalCommandAdapter` 仍只可用于 Spike、测试或明确记录的降级模式，不能替代真实 Runtime 的发布演示。
- Phase 4 已于 2026-08-03 正式独立验收通过；生产真实修复路径可使用受治理 `OmpAdapter`，但不得回退受控写入器、真实路径与 `Plan.allowedPaths` 校验、凭据隔离、服务端 Diff/验证来源及取消边界。

### Phase 2 SQLite 运行时约束

详见 [ADR-005](docs/adr/ADR-005-sqlite-runtime.md)：

- SQLite 数据库默认存放在用户数据目录，可通过 `TRACEPILOT_DB_PATH` 覆盖。
- 启用 WAL 模式与外键约束；`busy_timeout` 默认 5000ms。
- 迁移机制采用内联 SQL，版本号单调递增，记录于 `schema_migrations` 表。
- 单写入串行队列（`SqliteUnitOfWork`）+ `BEGIN IMMEDIATE` 短事务，保证事务不交错。
- 服务重启时，`EXECUTING` / `VALIDATING` 任务自动迁移为 `INTERRUPTED` 并写审计。

### Phase 3 Worktree 受控根目录与命令安全

详见 [ADR-002](docs/adr/ADR-002-worktree-and-command-safety.md)：

- worktree 唯一受控根目录为 `%LOCALAPPDATA%/TracePilot/worktrees/`，子目录布局 `<worktree-root>/<project-slug>/<task-id>/`。
- `LocalGitAdapter` 的所有 git 命令经注入的 `ProcessRunner.run` 执行，禁止直接 `child_process.spawn`；argv 与 cwd 经 `CommandPolicy` / `PathPolicy` 校验。
- `git worktree add` 归类为 `needs_execution_approval`，`LocalGitAdapter` 作为受控 Manager 直接执行；执行审批由 `TaskOrchestrator` 在 `AWAITING_EXECUTION_APPROVAL` 状态下处理。
- `git worktree remove` 在 `CommandPolicy` 中默认拒绝（删除性操作）；`LocalGitAdapter.removeRegisteredWorktree` 在 `PathPolicy` 校验通过后直接调用 `ProcessRunner.run`，这是 ADR-002 的受控清理策略。
- `FakeGitAdapter` 与 `LocalGitAdapter` 通过同一套契约测试（`git-adapter-contract.test.ts`），确保 Phase 4+ 替换时不引入回归。

## 八、后续阶段

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| Phase 2 | SQLite + Drizzle 持久化、契约测试套件、8 个固定基准任务 | 已独立验收通过 |
| Phase 3 | 真实 Git worktree 创建/回收/Diff/历史/Blame、EvidenceRouter、Pack v1/v(n+1) 编排、契约测试、两个样例仓库集成测试、ADR-002 | 已独立验收通过 |
| Phase 4 | 真实 `OmpAdapter`、受控修复/验证/Diff/Review 闭环 | 已于 2026-08-03 独立验收通过；P1 全部关闭 |
| Phase 5 | 真实 Reviewer、Repair Memory 召回 | 未开始 |
| Phase 6+ | Dashboard、SAG（后置） | 未开始 |
