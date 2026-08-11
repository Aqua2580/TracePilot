# Phase 6 验收评审报告

> 首轮独立复核日期：2026-08-10  
> 最终独立复核日期：2026-08-11  
> 评审范围：Phase 6「最小 Dashboard」  
> 当前验收结论：**正式通过并签发**  
> 后续 AI：以第 7 节为当前有效结论；第 0-6 节保留为首轮不通过的历史基线。Phase 6 已由独立 Reviewer 正式签发，可进入 Phase 7，但不得回退本报告确认的同源 Dashboard、受控 UI 编排、SQLite 投影、SSE 恢复、静态安全头、浏览器门禁及 Phase 4/5 安全边界。

## 0. 独立复核结论

当前候选已经具备可用的 Dashboard 基础形状：React/Vite 页面由 Fastify 同源提供；项目、任务、审计、Evidence Pack、Diff/验证、Repair Record、审批和 Repair Memory 均从 SQLite 真源读取；静态资源有目录穿越保护；人工决定继续复用 Phase 5 的两步挑战；真实浏览器中 SSE 在 API 停止后进入恢复态，并在同一 SQLite 数据库重启后重新取得任务状态。

但 Phase 6 **当前不能通过**：

1. 非开发者只能在页面创建任务、刷新数据、查询记忆，以及在任务已经被外部流程推进到最终人工审批态后提交决定；页面没有证据收集、计划、执行审批、worktree、分析、开发、验证或 Review 的推进入口，也没有后台自动编排服务。真实浏览器创建任务后停留在 `CREATED`，无法仅通过 UI 完成一次演示。
2. `apps/web/package.json` 已新增 React/Vite 等 6 个依赖，但 `pnpm-lock.yaml` 没有对应 importer。`pnpm install --frozen-lockfile` 直接以 `ERR_PNPM_OUTDATED_LOCKFILE` 失败，标准构建、测试和 Lint 链不能在干净环境复现。
3. 新增测试只覆盖 API 空投影、静态目录边界和 SSE 纯序列化首帧，没有自动执行浏览器完整演示，也没有真正断开并重连 SSE。虽然本轮人工浏览器复核证明当前 SSE 功能可恢复，但仓库门禁没有守住 Phase 6 的两个退出条件。

因此，不能用 Dashboard 可打开、3 项定向测试通过或 802 项本地回归通过替代阶段退出条件。

## 1. P1：必须关闭后才能通过

### P1-01：非开发者无法仅通过 UI 完成一次受控修复演示

**位置：** `apps/web/src/App.tsx:198-300`、`:331-456`。

页面当前可执行的动作只有：

- 刷新数据；
- 创建任务；
- 查询 Repair Memory；
- 任务已经处于 `AWAITING_HUMAN_APPROVAL` 时提交最终批准或拒绝。

创建任务后的页面提示明确写着“下一步由受控服务收集证据、规划并审批执行”，但仓库没有与该提示对应的后台工作进程或自动编排入口。已有 REST API 虽然支持 `transition`、`collect-evidence`、`plan`、`approvals`、`worktrees`、`begin-execution` 和 `run`，Dashboard 没有调用这些端点。

本轮使用真实浏览器登记一个临时合成项目并创建任务后，页面成功显示时间线和空产物视图，SSE 状态为“实时同步已连接”，但任务停留在 `CREATED`；页面没有任何可继续推进的按钮。要完成演示，仍必须由开发者在 PowerShell/API 外部逐步调用端点。这不满足实施规格 §9 Phase 6 的退出条件“非开发者可通过 UI 完成一次演示”。

**必须修复：**

1. 明确并实现一个可重复的 UI 演示路径。可以选择：
   - 由 Dashboard 分阶段调用现有受控端点，并在每个安全边界显示确认、输入和结果；或
   - 增加服务端受控编排命令，由 UI 启动并观察，但执行审批和最终人工决定仍必须保持独立人工边界。
2. UI 至少要能从预置已登记项目的任务创建开始，走到 Evidence Pack、Plan、执行审批、受控 worktree、真实/明确降级 Runtime、验证、Review、最终人工决定和终态。
3. 不得为了“自动演示”绕过 Phase 4/5 已签发的命令、路径、worktree、服务端 Diff/验证、独立 Review、质量门和人工挑战边界。
4. 增加一个固定合成仓库或受控夹具，使新 Reviewer 不需要手工拼接 SQLite/API 请求即可复验完整 UI 流程。

### P1-02：前端依赖未写入锁文件，干净安装失败

**位置：** `apps/web/package.json:13-20`；`pnpm-lock.yaml` 中不存在 `apps/web` importer 和对应依赖声明。

独立 Reviewer 执行：

```powershell
$env:CI='true'
pnpm install --frozen-lockfile
```

实际结果：

```text
ERR_PNPM_OUTDATED_LOCKFILE
Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with apps/web/package.json
6 dependencies were added: @types/react, @types/react-dom, @vitejs/plugin-react, vite, react, react-dom
```

README 当前反而要求使用 `pnpm install --no-frozen-lockfile`，这会在使用者本地重新解析并改写依赖图，不能证明候选提交可重复安装，也会掩盖遗漏锁文件的问题。

**必须修复：**

1. 使用仓库声明的 pnpm 版本同步 `pnpm-lock.yaml`，纳入 `apps/web` importer 和所有解析结果；
2. 在干净依赖目录执行 `pnpm install --frozen-lockfile`，必须退出码为 0；
3. README 的默认安装路径改为 frozen lockfile；`--no-frozen-lockfile` 只能作为明确的依赖维护动作，不能作为普通使用说明；
4. 重新运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm lint` 和 `git diff --check`。

### P1-03：自动化门禁没有覆盖 Phase 6 的两个退出条件

**位置：** `apps/api/tests/phase6-dashboard.test.ts:53-166`。

现有 3 项测试分别验证：

1. 已登记项目、任务、审计和空产物 API 投影；
2. 静态文件目录边界及未构建时 503；
3. `buildTaskSnapshotEvent()` 的字符串格式。

第 3 项没有建立真实 SSE HTTP 连接，没有模拟断线，也没有断言重连后从 SQLite 读取更新状态。整个仓库也没有浏览器测试去创建并完成一个任务。于是当前 P1-01 这样的功能缺口不会让 `test:phase6-dashboard` 失败。

**必须修复：**

1. 增加真实 HTTP SSE 集成测试：建立连接、读取首帧、改变 SQLite 任务状态、确认增量快照、主动断开、重新连接，并断言重连首帧来自当前 SQLite 状态；
2. 增加浏览器级场景：由 UI 从预置项目创建任务，完成候选定义的完整演示，并核对 Evidence、Diff、验证、Review、审批和记忆视图；
3. 浏览器场景必须断言不存在用于绕过执行审批、质量门或人工挑战的 UI/API 快捷路径；
4. 把这些测试加入普通本地门禁，不得依赖真实付费模型调用；真实 Omp 展示可以另设显式授权门禁。

## 2. P2：不单独决定结论，但必须登记

### P2-01：Review 对非开发者主要以原始 JSON 展示

`apps/web/src/App.tsx:524-538` 的“审查与修复记录”只把根因和修复摘要做了语义化展示，其余 `reviewResult`、finding、失败原因和来源字段统一放在 JSON 块中。建议增加 verdict、finding 优先级、category、confidence、locator 和确定性质量门原因的独立视图；原始 JSON 可保留为“技术详情”。

### P2-02：SSE 没有心跳，自动化也未覆盖半开连接

`apps/api/src/composition-root.ts:600-636` 只在任务或最新审计变化时写出事件。真实进程停止/重启场景可以恢复，但长时间无状态变化时没有 heartbeat；代理或网络形成半开连接时，浏览器发现故障的时间不可控。当前默认只监听 `127.0.0.1`，所以不作为本轮 P1；建议增加不含业务数据的注释心跳并测试 timer 清理。

### P2-03：静态页面缺少 CSP 等浏览器安全响应头

Dashboard 可在页面内输入人工审批通道凭证。当前 React 文本渲染避免了常见 HTML 注入，但静态响应没有 `Content-Security-Policy`、`X-Content-Type-Options`、`Referrer-Policy` 等最小加固头。默认 loopback 限制降低了风险；如果允许通过 `TRACEPILOT_HOST` 暴露到非回环地址，则必须先定义认证与浏览器安全边界。

### P2-04：浏览器请求 favicon 产生 404 控制台错误

真实浏览器打开 `/dashboard` 时唯一的初始控制台错误为 `/favicon.ico` 返回 404。该问题不影响功能，但会污染演示和自动化的“零控制台错误”基线。应提供图标或在页面中显式声明可用资源。

### P2-05：继续跟踪 Phase 5 的执行审批拒绝状态收口

Phase 5 签发报告中的 P2-05 仍然有效。Phase 6 如果增加执行审批 UI，应明确显示拒绝后的任务状态，不能把审批记录的 `rejected` 与任务继续停留在 `AWAITING_EXECUTION_APPROVAL` 的语义混为一谈。

## 3. 独立运行证据

运行环境：Windows，Node `v24.18.0`，pnpm `11.16.0`。本轮没有设置真实模型授权，显式保持 `TRACEPILOT_OMP_REAL_ACK=0` 和 `TRACEPILOT_PHASE5_REAL_ACK=0`，没有向 DeepSeek 发送任何场景，也没有产生模型调用费用。

### 3.1 安装与静态门禁

| 命令/检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | **失败**：`ERR_PNPM_OUTDATED_LOCKFILE`，缺少 `apps/web` 6 个依赖声明 |
| `tsc --noEmit`（`apps/web`） | 通过 |
| `vite build`（`apps/web`） | 通过；32 个模块，JS 155.82 kB，CSS 5.45 kB |
| `tsc -b apps/api` | 通过 |
| `git diff --check` | 通过；仅有既有 LF/CRLF 提示 |
| 全仓 `pnpm lint` | 未形成有效结果；标准 pnpm 执行在锁文件检查阶段已失败，临时无锁依赖图也不能作为可复现门禁 |

为继续区分锁文件缺陷与源码行为，本轮临时使用 `pnpm install --lockfile=false` 安装依赖；该命令没有修改 `pnpm-lock.yaml`，其后直接调用工作区本地二进制。临时依赖目录只用于本轮审查，不能替代 P1-02 的修复。

### 3.2 测试结果

| 工作区 | 结果 |
| --- | --- |
| Core | **142 项通过** |
| Governance | **244 项通过，1 项按设计跳过** |
| Adapters | **265 项通过** |
| Store | **98 项通过** |
| API | **53 项通过，4 项按设计跳过** |
| 合计 | **802 项通过，5 项按设计跳过** |

Phase 6 定向测试为 1 个文件、3 项通过。API 全量为 8 个文件、53 项通过、4 项真实场景按授权门禁跳过。Phase 4/5 的本地安全、质量门、人工审批和 Repair Memory 回归没有发现回退。

### 3.3 真实浏览器验收

本轮使用 Playwright CLI 驱动真实浏览器，使用临时 SQLite 数据库和临时合成项目；没有修改用户仓库代码。

| 场景 | 结果 |
| --- | --- |
| `/dashboard` 同源加载 | 通过；页面标题和空状态正常 |
| 已登记项目读取 | 通过；只显示临时 SQLite 中的项目 |
| UI 创建任务 | 通过；任务、`task_created` 时间线和空产物视图可见 |
| UI 完整演示 | **失败**；任务停在 `CREATED`，页面无后续推进操作 |
| SSE 初始连接 | 通过；显示“实时同步已连接” |
| API 停止 | 通过；页面自动变为“正在恢复同步” |
| 同库 API 重启 | 通过；自动恢复为“实时同步已连接”，任务仍从 SQLite 正确显示 |
| 初始控制台 | 1 个错误：`/favicon.ico` 404 |

浏览器和临时服务器在复核后均已关闭，临时数据库与 Playwright 会话产物已删除。

## 4. 已确认的正向实现

以下能力本轮确认成立，修复 P1 时应保留：

1. Dashboard 与 API 同源，默认 API 仍绑定 `127.0.0.1`；
2. 项目列表只读取已登记项目，不从网页扫描任意本地目录；
3. Evidence Pack、执行产物、审批和 Repair Record 来自 SQLite 仓储；
4. Diff 与验证输出有服务端预览上限，完整产物仍保存在 SQLite；
5. 静态资源目录穿越被拒绝，缺少构建产物时入口失败关闭为 503；
6. SSE 重连重新读取 SQLite，不依赖不可恢复的进程内事件；
7. 最终人工决定继续使用 Phase 5 的一次性挑战，浏览器不能提交 approver；
8. React 以文本方式渲染项目数据、日志、Diff 和 JSON，没有使用危险 HTML 注入；
9. Phase 4/5 本地回归共计 802 项通过，没有发现已签发边界回退。

## 5. 下一轮最低复验清单

实现 Agent 完成整改后，应提交以下自测证据，但不得自行签发：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm lint
git diff --check
```

独立 Reviewer 还必须重新执行：

1. Phase 6 定向 API/SSE 测试；
2. 浏览器完整演示，从预置项目开始直到明确终态；
3. 浏览器断线、API 重启、SQLite 状态更新后的自动恢复；
4. 最终批准与拒绝各一条安全路径，确认没有绕过挑战；
5. 路径穿越、超长 Diff/日志截断、跨项目记忆隔离和控制台错误检查。

## 6. 当前有效结论

| 编号 | 状态 | 结论 |
| --- | --- | --- |
| P1-01 UI 完整演示 | **未关闭** | 任务创建后停在 `CREATED`，必须依赖开发者外部调用 API |
| P1-02 锁文件一致性 | **未关闭** | frozen install 失败，标准门禁不可复现 |
| P1-03 阶段退出测试 | **未关闭** | 没有真实 SSE 重连自动化，也没有浏览器完整闭环测试 |
| P2-01 至 P2-05 | **已登记** | 不单独决定结论，下一轮复核时继续跟踪 |
| SSE 断线恢复功能 | **人工实测通过** | 进程停止进入恢复态，同库重启后自动恢复并保留任务状态 |
| Phase 4/5 安全边界 | **本地回归保持通过** | 802 项本地测试通过，5 项按授权/平台设计跳过 |

**第一轮最终有效结论：Phase 6 不通过，不予签发，禁止进入 Phase 7。实现 Agent 必须先关闭 P1-01、P1-02、P1-03，再交由独立 Reviewer 复验。**

## 7. 第二轮整改后最终独立复核与正式签发（2026-08-11）

### 7.1 复核范围与职责分离

本轮由未参与 Phase 6 实现的独立 Reviewer 重新阅读实施规格、首轮报告、当前源码、测试和依赖配置，并独立执行 frozen install、Phase 6 定向门禁、全仓测试、类型检查、构建、Lint、差异检查及真实浏览器闭环。

本轮 Reviewer 没有修改实现代码、测试代码、依赖或锁文件；只更新验收报告、README 和已获授权的 `AGENTS.md` 阶段状态。实现 Agent 的自测结论没有被直接当作签发证据。

Phase 6 浏览器演示使用 `runtimeOverride` 显式注入的 `DashboardDemoRuntimeAdapter`，不会调用外部模型。该替身只负责产生受控分析、允许路径内修改和结构化 Review；其余链路实际经过临时 Git 仓库、外置 worktree、文件系统守卫、服务端 Diff、项目验证命令、SQLite、确定性质量门、人工挑战和 Repair Memory。Phase 4/5 的真实 Omp + DeepSeek 能力仍以各自已签发报告为准，本轮不重复消费模型费用，也不把测试替身冒充真实 Omp。

### 7.2 P1-01：UI 完整演示关闭

`apps/web/src/App.tsx` 已增加逐阶段“受控修复向导”，并根据 SQLite 中的任务状态只显示当前允许的操作：

1. `CREATED`：进入 `INTAKING` / `GATHERING_EVIDENCE` 并由服务端收集 Evidence Pack；
2. `GATHERING_EVIDENCE`：先提交 Evidence Request，再仅引用当前 Pack 已存在的 Evidence ID 创建 v(n+1)；
3. 记录绑定当前 Pack 的 Plan 和 `allowedPaths`；
4. 进入执行审批并记录批准/拒绝；
5. 服务端重新计算范围哈希后创建外置 worktree，并进入受控执行；
6. 运行分析、开发和项目验证，页面不提交命令、Diff 或验证结果；
7. 进入独立 Review，由服务端持久化产物和确定性质量门决定下一状态；
8. 只有 `AWAITING_HUMAN_APPROVAL` 才显示 Phase 5 两步人工挑战；
9. 完成后可在同页查看 Evidence Pack v2、Diff、验证、Review、审批及 `APPROVED` Repair Memory。

真实 Playwright 浏览器测试只操作页面可见控件，从预置已登记项目创建任务，最终到达 `COMPLETED` 并召回 `APPROVED` 记忆。测试同时确认初始状态不存在“运行受控开发与验证”按钮，不能从 UI 跳过审批；API 对抗场景另行确认伪造 `EXECUTING` 迁移返回 403、未审批 `begin-execution` 失败。

因此 P1-01 **正式关闭**。

### 7.3 P1-02：锁文件与干净安装关闭

当前 `pnpm-lock.yaml` 已包含：

- `apps/web` importer；
- React、React DOM、Vite 和类型依赖；
- API 工作区的 Playwright 依赖；
- 对应完整解析结果与 integrity。

pnpm v11 的依赖布局配置已从旧 `.npmrc` 迁移到 `pnpm-workspace.yaml`，`hoist: false` 避免 Ajv 等不兼容主版本被错误提升。README 默认安装命令已改为 `pnpm install --frozen-lockfile`，并明确只有维护依赖时才可使用 `--no-frozen-lockfile`。

独立 Reviewer 在 Node `v24.18.0`、pnpm `11.16.0` 下执行 frozen install，结果为：锁文件通过供应链策略、resolution 被跳过、326 个包全部从锁定依赖图恢复、退出码 0。第一次沙箱内重建曾因 Windows 对旧 `node_modules` 文件的 `EPERM` 失败；同一命令在沙箱外重试成功，属于本机权限环境，不是锁文件漂移。

因此 P1-02 **正式关闭**。

### 7.4 P1-03：阶段退出自动化关闭

Phase 6 定向门禁现包含 2 个文件、6 项测试：

1. SQLite 项目、任务、审计与只读产物投影；
2. Dashboard 静态目录边界、缺失构建失败关闭、favicon 与安全响应头；
3. SSE 最小快照序列化；
4. 真实 HTTP SSE 首连、SQLite 状态增量、主动断开、断线后状态改变及重连首帧恢复；
5. 完整受控 API 演示及不可绕过审批、Pack 版本、验证和人工挑战的断言；
6. 真实 Chromium 页面闭环及控制台零错误断言。

定向命令实际达到 2 个文件、**6 项通过、0 项失败、0 项跳过**。浏览器用例验证 Evidence Pack v2、`src/status.txt` Diff、验证通过、Review、最终 `COMPLETED`、Repair Record=`APPROVED` 及项目内 Repair Memory 召回。

SSE 服务还增加 15 秒注释心跳；任务事件仍只在签名变化时发送，重连仍以 SQLite 当前状态为准，不依赖进程内丢失事件。

因此 P1-03 **正式关闭**。

### 7.5 首轮 P2 复核

| 编号 | 第二轮状态 | 关闭证据 |
| --- | --- | --- |
| P2-01 Review 可读视图 | **关闭** | 页面独立展示 verdict、finding priority/category/confidence/locator、消息和质量门原因；原始 JSON 仅保留为技术详情。 |
| P2-02 SSE 心跳 | **关闭** | 增加 15 秒无业务数据 heartbeat；真实 HTTP 断开/重连测试通过。 |
| P2-03 浏览器安全头 | **关闭** | Dashboard 静态响应增加 CSP、nosniff、no-referrer、DENY frame、Permissions-Policy；测试固定关键响应头。 |
| P2-04 favicon 404 | **关闭** | Vite public 资源提供 `/dashboard/favicon.svg`；真实浏览器闭环断言控制台零错误。 |
| P2-05 执行审批拒绝状态收口 | **继续登记，非阻断** | UI 明确提示拒绝已记录且任务仍停留在等待执行审批；领域状态语义仍按 Phase 5 报告继续跟踪。 |

本轮未发现新的 P1。Playwright Chromium 是浏览器门禁的显式前置条件，README 已提供 `pnpm --filter @tracepilot/api exec playwright install chromium`，不会在普通测试中隐式调用外部模型。

### 7.6 独立门禁结果

本轮显式设置 `TRACEPILOT_OMP_REAL_ACK=0` 和 `TRACEPILOT_PHASE5_REAL_ACK=0`，没有向 DeepSeek 发送场景，没有产生模型调用费用。

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过；锁文件一致，326 个包按锁定依赖图恢复 |
| `pnpm --filter @tracepilot/api run test:phase6-dashboard` | 2 个文件、**6 项通过** |
| `pnpm test` | **805 项通过、5 项按设计跳过** |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过；Dashboard 32 个模块，JS 165.19 kB、CSS 6.43 kB |
| `pnpm lint` | 通过 |
| `git diff --check` | 通过；仅有既有 LF/CRLF 提示 |

全仓通过项分布为 Core 142、Governance 244、Adapters 265、Store 98、API 56，共 805 项。5 项跳过为 Governance 平台路径用例、Phase 4 两个真实模型用例和 Phase 5 两个真实 Reviewer 用例；这些显式授权门禁没有被 Phase 6 改成普通测试或失败开放。

### 7.7 正式签发声明

Phase 6 的两个规格退出条件已经同时满足：

1. 非开发者可仅通过 UI 完成一次受控演示；
2. SSE 断开后可重连并从 SQLite 恢复当前任务状态。

三个首轮 P1 全部关闭，首轮 P2-01 至 P2-04 关闭，P2-05 作为既有非阻断项继续跟踪。全仓本地门禁通过，未发现 Phase 4/5 安全边界回退。

**独立 Reviewer 正式签发 Phase 6「最小 Dashboard」。验收结论：通过。允许进入 Phase 7。**

进入 Phase 7 后必须保留以下边界：

- Dashboard 继续与 API 同源，默认只监听 loopback；若暴露非回环地址，必须先新增认证与部署安全设计；
- UI 不得直接写 worktree、提交命令、Diff、验证结果或伪造最终审批人；
- Evidence Request、Pack 新版本、Plan、执行审批、外置 worktree、服务端 Diff/验证、独立 Review、确定性质量门和最终人工挑战不得被合并成可绕过的客户端快捷路径；
- SSE 重连必须继续从 SQLite 真源恢复，不得改为只依赖内存事件；
- Playwright 浏览器闭环必须保留在普通本地门禁中；测试替身只能通过 `runtimeOverride` 注入并明确标注；
- Phase 7 的 SAG 仍只能经 `KnowledgeAdapter` 后置接入，不得替换 SQLite MVP 真源，也不得要求 Docker/PostgreSQL；
- P2-05“执行审批拒绝状态收口”继续登记，后续整改仍需独立复核。

**第二轮最终有效结论：Phase 6 正式通过并签发，允许进入 Phase 7。**
