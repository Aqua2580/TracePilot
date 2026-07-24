# Phase 2 验收评审报告

> 初次独立复核：2026-07-24  
> 再次独立复核：2026-07-24  
> 再次独立复核（二）：2026-07-24  
> 再次独立复核（三）：2026-07-24  
> 最终独立复核：2026-07-24  
> 评审范围：Phase 2「SQLite、Fake 闭环、评测基准」  
> 最终验收结论：**通过**  
> 后续 AI：可进入 Phase 3；修改 SQLite 运行时、迁移、单写入队列或基准闭环时，必须补回归测试并进行独立复核。实现 Agent 不得自行批准其实现的阶段代码。

## 0. 最终独立验收结论（2026-07-24）

本次最终复核由未参与本轮实现的 Reviewer 执行。在 Node `v24.18.0`、pnpm `v11.16.0` 下，`better-sqlite3@12.11.1` 可以正常加载，并已独立运行：

```powershell
pnpm --filter @tracepilot/store test
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

执行结果：

| 验收项目 | 结果 | 独立运行证据 |
| --- | --- | --- |
| SQLite Store、基准与事件缓冲 | 通过 | 3 个测试文件、48 项测试全部通过。 |
| 全仓自动化测试 | 通过 | 417 项通过，1 项因 Windows 符号链接权限跳过；该跳过已在 Phase 1 验收记录，非本阶段阻塞项。 |
| API SQLite 重启收口 | 通过 | API 11 项测试通过，包含真实磁盘 SQLite 的重启与 `INTERRUPTED` 收口。 |
| 固定 Fake Adapter 基准闭环 | 通过 | Store 基准 18 项测试通过，覆盖 8 个固定任务的可重复 Pack、计划、审计与运行事件结构。 |
| SQLite 迁移、备份、WAL / 锁等待 | 通过 | Store 集成测试通过，包含真实双连接写锁、等待成功、`SQLITE_BUSY` 超时与后续恢复。 |
| RuntimeEventBuffer 边界与失败语义 | 通过 | 11 项测试通过，覆盖截断、总量上限、顺序、同一缓冲区失败后重试、审计隔离和重启查询。 |
| TypeScript 类型检查、ESLint、构建 | 通过 | 5 个工作区包均通过。 |
| Node 24 原生依赖兼容性 | 通过 | `better-sqlite3@12.11.1` 已在当前 Node 24 环境完成真实 SQLite 测试。 |
| README 一致性 | 通过 | 已更新 SQLite、Store 包、Node 22/24 支持、测试说明与 Phase 2 独立通过状态。 |

此前 P1-00、P1-03、P1-06 和原 P1-01、P1-02、P1-04、P1-05 均已关闭。Phase 2 的规格退出条件——服务重启收口、固定基准任务的可重复产物、迁移/备份/锁等待集成测试——已经获得独立执行证据。因此 **Phase 2 验收通过，可进入 Phase 3**。

## 1. 上轮复核结论（历史记录）

本次复核针对上一轮仍开放的 P1-00、P1-03 进行。实现方新增了 `.nvmrc`（Node 22）、收紧根目录 `engines.node` 为 `>=22.0.0 <23.0.0`，并在 `pnpm-workspace.yaml` 显式允许构建 `better-sqlite3`；同时新增 `packages/store/tests/runtime-event-buffer.test.ts`，意图覆盖运行事件缓冲的五类边界。

本轮进一步确认，运行事件测试已修正为“可切换的同一 UnitOfWork → 同一 RuntimeEventBuffer 先失败 → 恢复后再次 flush → 查询真实 `agent_runs`”，并补充了 `maxEventBytes` 上限断言。Store 的直接 TypeScript 类型检查和 ESLint 均通过。

但验收结论仍为**暂不通过**：

1. 当前独立验收环境是 Node `v24.18.0`，项目现在会在运行任何 `pnpm` 脚本前正确拒绝该版本；本机没有 Node 22 / NVM 可用，因此 Store、全仓测试、类型检查、Lint、构建均未能在受支持环境实际执行。
2. README 仍把项目描述为“Phase 1 / InMemory，Phase 2 尚未接入 SQLite”，并指导使用 `Node ≥ 22` 与旧测试结果；它与 `AGENTS.md` 的 Node 22 固定约束、当前 SQLite 代码和“Phase 2 未通过、不得进入 Phase 3”的门禁冲突，可能使后续 AI 在错误前提下实现或验证。

在 Node 22 环境跑通所有规定命令，并修复 README 后，才可再次申请验收。

本节保留此前未通过时的审查轨迹，已由第 0 节最终独立验收结论取代。

此前 P1-01、P1-02、P1-04、P1-05 均已有对应的源码改动：

* API 组合根已改为创建 `SqliteStore`，启动入口执行中断任务收口，且有真实磁盘数据库的重启测试；
* 8 个固定基准任务已消费 `FakeRuntimeAdapter`、`FakeGitAdapter`、`FakeKnowledgeAdapter` 的输出，并将运行事件经 `RuntimeEventBuffer` 写入 `agent_runs`；
* Repair Memory 的 `write` 已通过 `UnitOfWork` 写入队列；
* 锁等待测试已使用两个真实 SQLite 连接（worker 持有 `BEGIN IMMEDIATE` 写锁）覆盖“等待成功”和 `SQLITE_BUSY` 超时。

当时 Phase 2 仍**不能通过**，原因是 SQLite 原生测试在当前声明支持的 Node 环境无法启动，且运行事件缓冲缺少规格要求的关键边界测试。后者已在第 0 节记录为源码层面补齐；本节仅保留历史审查轨迹。

## 2. 历史校验结果

已独立运行：

```powershell
pnpm typecheck
pnpm lint
pnpm build
pnpm --filter @tracepilot/store test
```

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| TypeScript 类型检查 | 本轮未执行 | 当前 Node 24 被收紧后的 `engines.node` 正确拒绝；上轮旧源码曾通过，不能代替本轮结果。 |
| ESLint | 本轮未执行 | 同上。 |
| TypeScript 构建 | 本轮未执行 | 同上。 |
| SQLite Store / 基准运行测试 | 本轮未执行 | `pnpm` 在启动测试前拒绝不受支持的 Node 24。 |
| API 重启、Fake 闭环、Repair Memory、锁竞争测试源码 | 已存在 | 仍须在 Node 22 上实际运行。 |
| RuntimeEventBuffer 专项测试 | 源码复核符合关闭要求 | 同一缓冲区失败后恢复重试、上限、顺序、审计不受影响与重启查询均有用例；仍须在 Node 22 实际执行。 |
| Store 静态类型检查（直接 `tsc`） | 通过 | 仅核对 `packages/store` 源码与新增测试可通过类型检查，不加载 SQLite 原生模块，不替代正式 `pnpm typecheck`。 |
| Store ESLint（直接 ESLint） | 通过 | 仅核对 `packages/store`，不替代受支持 Node 22 下的全仓 `pnpm lint`。 |

上轮环境中的当前 Node 为 `v24.18.0`（`NODE_MODULE_VERSION=137`），已安装的 `better-sqlite3` 原生模块以 ABI 127 构建：

```text
The module 'better_sqlite3.node' was compiled against a different Node.js version
using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.
```

本轮已将根目录约束收紧为 `node >=22.0.0 <23.0.0`，并添加 `.nvmrc`。这避免了 Node 24 错误加载 ABI 127 二进制，但仍必须在 Node 22 的干净安装环境取得真实通过结果；“正确拒绝不支持环境”不能替代“受支持环境可运行”。

## 3. 已关闭 P1（历史记录）

### P1-00：声明支持的 Node 环境无法加载 SQLite 原生依赖

**位置：** 根目录 `package.json`、`pnpm-lock.yaml` 与本地 `better-sqlite3` 安装物。

**本轮进展：** `.nvmrc`、精确的 Node 22 版本范围和 pnpm 构建许可已补充；当前 Node 24 会被 pnpm 提前拒绝，避免再次加载错误 ABI。

**关闭状态：已关闭（2026-07-24）。** Node 24 下将 `better-sqlite3` 升级至 `12.11.1` 后，独立 Reviewer 实际运行 Store 48 项与全仓 417 项测试均成功；Node 24 ABI 兼容性已获得运行证据。

**关闭条件：**

* 明确并固化受支持的 Node 主版本，或把 `better-sqlite3` 及其安装/重建流程升级为与该支持范围一致；不得只在某一开发者机器上手工修复；
* 在干净依赖安装后的受支持 Windows Node 环境运行 `pnpm --filter @tracepilot/store test` 成功；
* 将该 Node/原生依赖约束写入开发文档或自动化环境检查，避免下一位 AI 或开发者再次得到不可加载的二进制。

### P1-03：运行事件缓冲缺少关键边界与失败语义测试

**位置：** `packages/store/src/runtime-event-buffer.ts`、`packages/store/tests/benchmark-loop.test.ts`。

**已完成的源码部分：** 已定义 `AgentRunRecord`、仓储端口和 SQLite 实现；`RuntimeEventBuffer` 通过 `UnitOfWork` 批量写入，具备单条文本截断、总保留量上限、内容哈希和 flush 失败时保留内存缓冲的设计。Fake 基准链路也会调用 `flush` 并查询 `agent_runs`。

**本轮进展：** 已新增专项测试，覆盖单条大输出截断、总量超限时尾部保留、append 顺序、既有审计不受 flush 失败影响，以及重启后查询。

**本轮复核：** `SwitchableUnitOfWork` 已让同一 `RuntimeEventBuffer` 在首次 `flush` 失败后保留缓冲，在恢复依赖后由同一实例再次 `flush`，并查询真实 `agent_runs`。单条 `message` / `summary` 均已断言不超过 `maxEventBytes`。源码层面的关闭条件已满足。

**关闭状态：已关闭（2026-07-24）。** Node 24 下 `runtime-event-buffer.test.ts` 的 11 项真实 SQLite 集成测试全部通过。

**关闭条件：**

* 在关闭 P1-00 后，实际运行并通过全部 Store 测试；
* 独立确认 `retainedBytes`、`truncated`、`contentHash` 与失败后同一缓冲区重试的断言均实际通过。

### P1-06：README 与当前阶段、SQLite 实现和 Node 门禁相互矛盾

**位置：** `README.md`。

**问题（历史）：** README 曾将当前状态表述为“Phase 1 已通过、可以进入 Phase 2”，仅链接 Phase 1 验收报告；技术栈写“MVP 用 InMemory；Phase 2 替换为 SQLite”；安装要求写“Node ≥ 22”，它会错误接受 Node 24；构建授权说明只提 `esbuild`；测试统计、启动日志和目录结构也仍是 Phase 1 内容。

这不是普通文案问题：README 是后续 AI 与开发者的首要入口，错误的 Node 版本会导致安装或测试直接被 pnpm 拒绝，错误的阶段/持久化描述会破坏 Phase 2 门禁与实现边界。

**关闭条件：**

* 将 README 明确更新为“Phase 2 实现中、尚未独立验收通过，不得进入 Phase 3”，并链接 Phase 2 验收报告；
* 安装说明固定 Node 22 LTS，说明 `.nvmrc`、`engineStrict` 和 `better-sqlite3` 构建许可；
* 以当前 SQLite、Store 包、Phase 2 API 日志和真实验收结果更新技术栈、目录、测试和运行说明；未在 Node 22 验证的结果不得伪造为“通过”。

**关闭状态：已关闭（2026-07-24）。** README 已更新为 Phase 2 SQLite 实现、Store 包、Node 22/24 与 `better-sqlite3@12` 构建说明，并已同步本报告的最终独立通过结论。

## 4. 已关闭的原 P1

| 原问题 | 本轮源码复核 | 运行复验前状态 |
| --- | --- | --- |
| P1-01：API SQLite 重启闭环 | `composition-root.ts` 使用 `createSqliteStore`；`server.ts` 在监听前调用恢复；重启集成测试存在。 | 已关闭：API 11 项测试通过。 |
| P1-02：Fake Adapter 基准闭环 | 基准显式实例化并消费三个 Fake Adapter，断言运行事件、Pack、计划与审计。 | 已关闭：8 个固定基准任务的 18 项测试通过。 |
| P1-04：Repair Memory 绕过队列 | `SqliteRepairMemoryAdapter.write` 已经由 `unitOfWork.run` 调用仓储写入。 | 已关闭：SQLite Store 集成测试通过；后续可增强并发写入覆盖。 |
| P1-05：锁等待无真实测试 | 已采用两个连接和真实写锁，覆盖超时内成功、超时 `SQLITE_BUSY` 与后续恢复。 | 已关闭：真实双连接锁竞争测试通过。 |

## 5. 阶段结论与后续约束

1. Phase 2 已通过，允许开始 Phase 3 的 Git、worktree、Diff 与证据实现。
2. 继续遵守 SQLite-only MVP、单写入队列、外置 worktree、命令/路径/审批/审计边界及独立 Reviewer 规则。
3. 若变更 SQLite 迁移、原生依赖、运行事件缓冲、API 组合根或基准链路，必须重新运行本报告第 0 节列出的命令并保留独立复核记录。
