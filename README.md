# TracePilot

> 证据驱动的本地 Git 仓库修复平台。
>
> 本仓库已完成 Phase 0 与 **Phase 1 独立验收**，可以进入 Phase 2（SQLite、Fake 闭环与评测基准）。这不表示 MVP 或真实修复闭环已经完成；后续仍须关闭验收报告中的 P2 延后项。完整规格见 [`docs/IMPLEMENTATION_SPEC.md`](docs/IMPLEMENTATION_SPEC.md)，当前验收报告见 [`docs/reviews/PHASE-1-ACCEPTANCE-REVIEW.md`](docs/reviews/PHASE-1-ACCEPTANCE-REVIEW.md)，开发规则见 [`AGENTS.md`](AGENTS.md)。

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
| 语言 / 构建 | TypeScript strict + pnpm workspace（Node ≥ 22） |
| API | Fastify + REST + SSE（SSE 后置阶段） |
| 日志 | Pino |
| 持久化 | MVP 用 InMemory；Phase 2 替换为 SQLite + Drizzle |
| 测试 | Vitest（单元 / 契约 / 集成） |
| Runtime | MVP 用 `LocalCommandAdapter`；Phase 4 替换为真实 `OmpAdapter` |

依赖方向：`apps → orchestrator → core → ports`。Core 零外部 SDK 导入（不依赖 Fastify / React / Drizzle / Git SDK / Pi SDK）。

## 三、目录结构

```
tracepilot/
├── AGENTS.md                          # 开发规则（不可违反）
├── docs/
│   ├── IMPLEMENTATION_SPEC.md         # 权威规格
│   └── adr/ADR-001-runtime-boundary.md # Runtime 边界决策
├── package.json / pnpm-workspace.yaml # workspace 配置
├── tsconfig.base.json                 # strict TS 基线
├── packages/
│   ├── core/                          # 领域模型 + 状态机 + ports + InMemory repos + Orchestrator
│   ├── governance/                    # 默认 command/path/approval/audit 策略
│   └── adapters/                      # LocalCommandAdapter + OmpAdapter stub + Fakes
└── apps/
    └── api/                           # Fastify composition root + Pino
```

## 四、安装

前置：Node ≥ 22、pnpm ≥ 11、git。

```powershell
# 在项目根目录
pnpm install --no-frozen-lockfile
```

> Windows 上首次安装若报 `ERR_PNPM_IGNORED_BUILDS`，已在 `pnpm-workspace.yaml` 里通过 `allowBuilds: { esbuild: true }` 授权，正常情况会自动通过。

## 五、如何测试

### 5.1 一键跑全部测试

```powershell
pnpm -r run test
```

预期输出（2026-07-23 实测）：

| 包 | 结果 |
| --- | --- |
| `@tracepilot/core` | 72 通过 |
| `@tracepilot/governance` | 37 通过 + 1 跳过（Windows symlink 受限，正常） |
| `@tracepilot/adapters` | 16 通过 |
| `@tracepilot/api` | 8 通过 |
| **合计** | **133 通过，1 跳过** |

### 5.2 单独跑某个包

```powershell
pnpm --filter @tracepilot/core test
pnpm --filter @tracepilot/governance test
pnpm --filter @tracepilot/adapters test
pnpm --filter @tracepilot/api test
```

### 5.3 监听模式（写代码时实时反馈）

```powershell
pnpm --filter @tracepilot/core test:watch
```

### 5.4 类型检查 + 构建

```powershell
pnpm -r run typecheck   # 全包类型检查
pnpm -r run build       # 全包构建（生成 dist/）
```

### 5.5 测试覆盖的关键不变量

| 测试文件 | 验证内容 |
| --- | --- |
| `packages/core/tests/task-state-machine.test.ts` | §5.2 状态机：合法/非法迁移、终态、INTERRUPTED 恢复、`canComplete` 前置条件 |
| `packages/core/tests/task-orchestrator.test.ts` | 状态迁移+审计同事务、取消、失败、中断恢复、审批记录、scope 失效、完成门槛 |
| `packages/core/tests/repair-record.test.ts` | §5.4 Repair Record 状态机、不可跳过 VERIFIED |
| `packages/core/tests/evidence-pack.test.ts` | §5.3 Pack 版本不可变、内容哈希稳定且区分版本 |
| `packages/governance/tests/command-policy.test.ts` | §7.2 命令白名单、默认拒绝列表、风险分级 |
| `packages/governance/tests/path-policy.test.ts` | §7.2 路径穿越拒绝、symlink 逃逸拒绝 |
| `packages/governance/tests/approval-policy.test.ts` | §7.2 风险表四档审批决策 |
| `packages/governance/tests/audit-policy.test.ts` | §7.3 环境变量脱敏、输出截断 |
| `packages/adapters/tests/adapters-smoke.test.ts` | Fake/Local/Omp 适配器行为、ADR-001 stub 抛错 |
| `apps/api/tests/composition-root.test.ts` | API 端到端：建任务、迁移、审计时间线、非法迁移 400 |

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
TracePilot composition root initialised — Phase 1 fallback wiring
TracePilot API listening port=7431 host=127.0.0.1
```

若启动时发现有任务卡在 `EXECUTING` / `VALIDATING`，会自动迁移到 `INTERRUPTED`（§5.2 中断恢复）。

### 6.2 API 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回 `phase-1-skeleton` 标记 |
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

## 七、Phase 0 决策摘要

详见 [ADR-001](docs/adr/ADR-001-runtime-boundary.md)：

- 本机未安装 `omp` 二进制，无法执行真实 `OmpAdapter` Spike。
- 按规格 Phase 0 退出条件，落地 `LocalCommandAdapter` 作为 MVP Runtime，`RuntimeAdapter` 接口保持不变。
- Phase 4 必须重试真实 `OmpAdapter` Spike；在此之前 `LocalCommandAdapter` 不得作为 Resume Release 演示的唯一 Runtime。

## 八、后续阶段

| 阶段 | 内容 |
| --- | --- |
| Phase 2 | SQLite + Drizzle 持久化、契约测试套件、6–10 个固定基准任务 |
| Phase 3 | 真实 Git worktree 创建/回收/Diff/历史 |
| Phase 4 | 真实 `OmpAdapter` Spike（安装 `omp` 后） |
| Phase 5 | 真实 Reviewer、Repair Memory 召回 |
| Phase 6+ | Dashboard、SAG（后置） |
