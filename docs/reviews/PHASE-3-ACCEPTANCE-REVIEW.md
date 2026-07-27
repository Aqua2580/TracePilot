# Phase 3 验收评审报告

> 独立复核日期：2026-07-27  
> 评审范围：Phase 3「Git 与证据」  
> 最终验收结论：**通过（2026-07-27 第五次独立复验）**  
> 后续 AI：可以进入 Phase 4；但不得绕过本报告已验证的 worktree、审批范围、Git 审计和 Evidence Pack 不可变性边界。实现 Agent 仍不得自行验收或批准自己的实现。

## 0. 独立复核结论

本报告由未参与 Phase 3 实现的 Reviewer 编写。验收依据为 `docs/IMPLEMENTATION_SPEC.md` §5.3、§6、§7、§8、§9 Phase 3、§10，`AGENTS.md` 规则 4、5、10、13、14，以及当前源码和独立命令结果。

实现已具备可观的基础：`LocalGitAdapter` 使用真实 git、存在 Python 与 TypeScript 两个样例仓库全流程测试、Git 解析器和 `EvidenceRouter` 已落地，且 `ADR-002` 已记录受控 worktree 设计。

但是 Phase 3 **暂不通过**。当前实现把“已登记 worktree”的安全承诺仅留在文档和接口名称中，实际并未持久化登记，也无法阻止传入伪造对象后执行受控根目录内的 `git worktree remove --force`。此外，生产约束下源仓库不在 `allowedWorktreeRoots`，导致真实仓库校验/创建无法运行；Git 操作没有形成规格要求的审计链；SQLite 中 Evidence Pack 同版本可被 SQL upsert 原地覆盖。

这些问题会直接破坏 Phase 3 的两个退出条件：安全创建/回收外置 worktree，以及证据 Pack 的可回溯与按版本不可变性。

## 1. P1：必须关闭后才能通过

### P1-01：worktree 未在同一事务中登记，回收接口可删除伪造对象所指目录

**位置：** `packages/core/src/services/task-orchestrator.ts` 的 `attachWorktree`，`packages/adapters/src/local-git-adapter.ts` 的 `removeRegisteredWorktree`。

`attachWorktree` 只写入 `task.worktreeId` 和 `worktree_created` 审计事件，没有调用 `tx.worktrees.save(worktree)`。这会留下一个指向不存在登记记录的 task 外键式引用。

同时 `removeRegisteredWorktree(worktree)` 只检查传入路径位于受控根目录，既不查询 `WorktreeRepository`，也不校验 worktree 的 `id`、`projectId`、`taskId` 是否真实登记，更不检查任务是否已终态。任意调用方只要构造一个路径位于受控根目录内的 `Worktree` 对象，就可能触发普通删除失败后的 `git worktree remove --force`。这与规格 §7.1 和 ADR-002 所写的“已登记 + 任务终态 + 受控根目录”三重条件不一致。

现有契约测试的“未登记”样例使用的是受控根目录**外**的路径，因此只验证了路径拒绝，未验证登记拒绝；这掩盖了问题。

**修复要求：**

* 在创建成功后，由应用/编排服务在同一 `UnitOfWork` 内保存 `tx.worktrees.save(worktree)`、更新 `task.worktreeId` 并写审计；失败时须有安全回收路径；
* 将回收收敛到能读取 `WorktreeRepository` 和任务状态的服务（例如 `WorktreeManager`），由它先加载登记记录、校验记录字段和终态，再调用 Adapter；Adapter 不得把调用方传入的任意对象视为“已登记”；
* 新增真实 git 集成测试：伪造但位于受控根目录内的 worktree 必须拒绝；已登记但非终态的 worktree 必须拒绝；已登记且终态的 worktree 才可回收；
* 断言任务、worktree 登记和 `worktree_created` / `worktree_removed` 审计事件具有一致事务语义。

### P1-02：源仓库路径被错误地当作 worktree 根目录，生产配置无法执行 Git 流程

**位置：** `packages/adapters/src/local-git-adapter.ts` 的 `runGoverned`，`docs/adr/ADR-002-worktree-and-command-safety.md`。

`runGoverned` 用 `allowedWorktreeRoots` 校验所有 cwd，其中包括 `validateRepository(input.repositoryPath)`、`createWorktree` 的源仓库命令、`getHistory(query.repositoryPath)` 与 `getBlame(query.repositoryPath)`。但 ADR-002 明确生产环境的 `allowedWorktreeRoots` 只能是唯一外置 worktree 根目录；源仓库不在其中，真实流程会被 `PathPolicy` 拒绝。

现有集成和契约测试通过向 `allowedWorktreeRoots` 额外塞入 `repoPath` 绕过了这个约束，正好掩盖了生产装配失败。这也使“worktree 根”和“已登记项目仓库根”两个安全域混在同一列表中。

**修复要求：**

* 在 `LocalGitAdapterOptions` 中区分只允许创建/回收的 `worktreeRoot` 与只读 Git 查询允许的已登记 `repositoryPath`（或由项目登记对象提供）；
* `createWorktree` 的目标只能位于唯一受控 worktree 根，源仓库命令只能在与当前 project 绑定的仓库根执行；回收时解析出的源仓库根也必须与登记项目一致；
* 更新生产 composition root / 应用装配，移除 Phase 2 的占位 `TRACEPILOT_ALLOWED_ROOTS` 方案；
* 将两个样例仓库测试改为生产等价配置，而非把 `repoPath` 塞进 `allowedWorktreeRoots`；新增拒绝“其他项目仓库”作为 cwd 的测试。

### P1-03：真实 Git / worktree 动作未写入 SQLite 审计链

**位置：** `packages/adapters/src/local-git-adapter.ts`、`packages/core/src/services/task-orchestrator.ts`。

规格 §7.3 要求记录实际 argv、cwd、退出码、输出截断信息和 Diff 哈希。当前 `LocalGitAdapter` 只返回 `CommandResult` / `DiffArtifact`；`TaskOrchestrator.attachWorktree` 仅写一条不包含 git 命令细节的 `worktree_created` 审计。没有任何应用服务把真实 Git 命令结果、Diff 哈希或回收动作追加到 SQLite `audit_events`。

因此即使测试中的 worktree 创建/回收成功，也无法审计还原“执行了什么、在哪执行、结果如何”，不满足 §7.3 和本阶段证据可回溯要求。

**修复要求：**

* 由应用/编排层消费 `LocalGitAdapter` 的命令结果与 DiffArtifact，在同一 SQLite 真源追加结构化审计；
* 至少覆盖 validate、worktree add、diff、history/blame 查询和 remove 的 argv、cwd、exitCode、截断信息，Diff 还要记录 hash；
* 新增 SQLite 集成测试，从审计时间线断言这些字段完整且不包含敏感环境变量值。

### P1-04：SQLite Evidence Pack 同一版本可被原地覆盖，且 Evidence Request 可跨任务使用

**位置：** `packages/store/src/sqlite-repositories.ts` 的 `SqliteEvidencePackRepository.save`，`packages/core/src/services/task-orchestrator.ts` 的 `evolvePackWithNewEvidence`。

SQLite 仓储使用 `INSERT ... ON CONFLICT(id, version) DO UPDATE`，会覆盖同一 Pack 版本的 evidence、hypotheses、constraints 和 acceptance criteria。它与 InMemory 仓储（重复版本抛 `EvidencePackVersionError`）不一致，也违反规格 §5.3、AGENTS.md 规则 10 的 Pack 不可原地修改要求。当前 Phase 3 不可变性测试仅使用 InMemory，未覆盖 SQLite 真源。

同时 `evolvePackWithNewEvidence` 仅检查 Evidence Request 存在，未验证 `request.taskId === args.taskId`；一个任务的 Request 可被用于升级另一个任务的 Pack，破坏 Pack 与证据请求的任务隔离。

**修复要求：**

* SQLite 仓储重复 `(id, version)` 必须拒绝并映射为与 InMemory 一致的领域错误，禁止 upsert；
* `evolvePackWithNewEvidence` 必须拒绝跨任务 Evidence Request，并在同一事务内保持旧版本与任务关联不变；
* 新增 SQLite 集成测试：同一 Pack 同版本二次写入被拒绝且原内容/哈希不变；跨任务 Request 升级被拒绝；合法 Request 仅生成 `v(n+1)` 并保留全部旧版本。

### P1-05：EvidenceRouter 未进入真实证据收集与 Pack 生成链

**位置：** `packages/core/src/services/evidence-router.ts`、`packages/core/src/services/task-orchestrator.ts`、`apps/api/src/composition-root.ts`。

`EvidenceRouter` 目前只是纯函数，返回描述性的 `EvidenceRequestSpec`；它没有被 `TaskOrchestrator` 或应用装配调用，也不会消费 `GitAdapter` / KnowledgeAdapter 输出。`gatherEvidenceAndCreatePack` 直接接受调用方传入的任意 `EvidenceItem[]`，未验证 `source`、`locator`、`contentHash` 是否存在或是否来自 Router 的允许范围。

因此当前两个真实 Git 样例与 Evidence Pack 完全分离，无法证明 Phase 3 退出条件“所有 Pack 证据可回溯来源”。

**修复要求：**

* 增加框架无关的证据收集/编排服务：使用 `EvidenceRouter` 生成请求，受控调用 Git / Memory / 代码证据 Adapter，并把返回结果转换为带 `source`、`locator`、`contentHash`、`capturedAt` 的 EvidenceItem；
* 在创建/升级 Pack 时验证每条证据的可回溯字段非空，并把 Router 请求、实际查询范围和 Pack 版本写入审计；
* 新增两样例仓库的端到端集成测试，将真实 Git 历史、blame、diff 证据写入 SQLite Pack，并逐条断言来源可追溯；不得只测试 Router 的纯输出或 Adapter 的孤立输出。

## 2. 独立运行结果

已在 Node `v24.18.0`、pnpm `v11.16.0` 下独立运行（未单独重新安装依赖；当前 lockfile 已是最新且依赖可加载）：

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm test` | 通过 | 483 项通过，1 项既有 Windows 符号链接权限跳过；Core 118、Governance 244、Adapters 62、Store 48、API 11。 |
| `pnpm typecheck` | 通过 | 5 个工作区包均通过。 |
| `pnpm lint` | 通过 | 5 个工作区包均通过。 |
| `pnpm build` | 通过 | 5 个工作区包均通过。 |
| Python 样例仓库真实 Git 全流程 | 测试通过 | 包含创建、Diff、历史、blame、回收；但采用非生产等价 roots 配置，不能关闭 P1-01/P1-02。 |
| TypeScript 样例仓库真实 Git 全流程 | 测试通过 | 同上。 |

测试通过不能替代上述安全与编排语义。尤其是外置目录删除、SQLite 不可变性和审计链必须以实现约束和针对性集成测试证明。

## 3. Phase 3 退出条件映射

| 规格退出条件 | 结论 | 原因 |
| --- | --- | --- |
| 两个样例仓库能安全创建/回收外置 worktree | 不满足 | 两个样例通过，但 worktree 未登记、非终态/伪造对象回收未被阻止，且测试配置绕过生产 roots 约束。 |
| 所有 Pack 证据可回溯来源 | 不满足 | Router、真实 Git 和 Pack 没有编排链；无来源字段验证或 Git 审计。 |
| Pack 不可原地修改，只能经 Evidence Request 升级 | 不满足 | SQLite 同版本 upsert 会覆盖，且 Request 不绑定 taskId。 |
| FakeGitAdapter 与 LocalGitAdapter 使用同一契约 | 部分满足 | 共享契约测试存在并通过，但“未登记”只覆盖根目录外路径，未覆盖受控根内伪造对象和生产 roots 配置。 |

## 4. 修复与复验顺序

1. 先关闭 P1-01 与 P1-02：建立真实 worktree 登记/回收服务，并分离项目仓库根与外置 worktree 根。
2. 关闭 P1-03：为所有真实 Git / worktree 动作补 SQLite 审计链。
3. 关闭 P1-04 与 P1-05：修复 SQLite Pack 不可变性和跨任务 Request 校验，接入 EvidenceRouter 的真实证据收集链。
4. 补齐两样例仓库的生产等价端到端测试和上述负向安全测试。
5. 由未参与实现的 Reviewer 重新运行：

```powershell
pnpm install --no-frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

全部 P1 关闭、两个样例仓库完成受控创建/登记/审计/回收、并可从 SQLite Evidence Pack 回溯真实 Git 证据后，方可将本报告更新为“通过”并解除 Phase 4 门禁。

---

## 5. 第二次独立复验（2026-07-27）

> 本节是当前有效结论，覆盖第 0 节及第 1～4 节中的历史“暂不通过”原因。  
> 复验角色：未参与本轮实现的独立 Reviewer。  
> **当前结论：Phase 3 仍暂不通过，禁止进入 Phase 4。**

本轮实现已经实质关闭了 P1-01、P1-02 和 P1-04：

* `WorktreeManager` 在真实 Git 操作之后，通过 `TaskOrchestrator.attachWorktree` 在同一 SQLite 事务内保存 `worktrees` 登记、更新 `task.worktreeId` 并写入 `worktree_created`；回收时先从数据库读取登记记录并检查任务终态，能够拒绝未登记、跨任务和非终态回收。
* `LocalGitAdapter` 已将 `allowedWorktreeRoots` 与 `allowedRepositoryRoots` 分离，真实 Git 测试使用生产等价 roots，并覆盖拒绝其他未登记仓库作为查询 cwd。
* SQLite Evidence Pack 重复 `(id, version)` 写入改为拒绝，跨任务 `EvidenceRequest` 升级被拒绝，且 SQLite 集成测试验证旧版本内容和哈希不变。
* `EvidenceCollector` 已把 Router 的 `git-history`、SQLite Repair Memory 和可选 `git-blame` 请求转换为带 `source`、`locator`、`contentHash`、`capturedAt` 的真实 EvidenceItem；`gatherEvidenceAndCreatePack` 也会拒绝缺少这些追溯字段的 Pack 证据。

但是，以下 P1 尚未关闭，故不能签发 Phase 3 通过结论。

### P1-R01：Diff 没有进入 SQLite 审计链，Phase 3 的 Git 审计闭环不完整

**位置：** `packages/adapters/src/local-git-adapter.ts` 的 `getDiff`、`packages/core/src/services/git-audit-sink.ts`、`packages/core/src/services/worktree-manager.ts`、`packages/core/src/services/evidence-collector.ts`。

`LocalGitAdapter.getDiff` 可以接收 `GitCommandAuditSink`，但当前没有应用/编排服务调用它，也没有任何路径追加 `diff_recorded` 审计事件。全仓搜索只发现 `getDiff` 在 Adapter 契约/样例测试中直接调用；`diff_recorded` 仅存在于审计事件类型定义，没有创建或持久化调用。因此 SQLite 时间线缺少 Diff 命令的 argv、cwd、退出码、输出截断信息及 `DiffArtifact.hash`，不满足实施规格 §7.3 对实际命令和 Diff 哈希的追加审计要求。

**关闭要求：**

1. 在框架无关的编排服务中增加受控 Diff 获取入口：传入已登记 worktree 和 taskId，使用 audit sink 调用 `getDiff`，把全部命令审计写入 SQLite，并在同一真源追加 `diff_recorded`（含 `diffHash`、worktree 标识和必要原因）。
2. 该入口必须先从 `WorktreeRepository` 读取登记记录，拒绝伪造 worktree 或跨任务 worktree；不得让 API/Runtime 直接调用 `LocalGitAdapter.getDiff` 绕过审计。
3. 新增真实 SQLite + Git 集成测试，断言 `git diff` / `git diff --name-only` 的 `command_executed` 结构化字段和 `diff_recorded.diffHash` 均可从任务时间线查询到。

### P1-R02：Evidence Router 的正式应用装配与查询范围审计缺失，Pack 证据链尚未可执行

**位置：** `apps/api/src/composition-root.ts`、`packages/core/src/services/evidence-collector.ts`、`packages/core/src/services/task-orchestrator.ts`。

`EvidenceCollector` 与 `WorktreeManager` 目前只在 Store 集成测试中手工构造。生产组合根只返回 `createGitAdapterForProject`，并未装配或暴露这两个受控服务；API 也没有由项目登记记录创建 Git Adapter、调用 Router/Collector、持久化 Pack 的入口。与此同时，当前只审计 Git 命令和 Pack 版本，未审计 Router 请求规格与实际查询范围；`EvidenceCollector` 也不收集 Diff 证据。结果是测试能证明类可协作，却不能证明服务运行时具备“任务 → Router → 受控查询 → Evidence Pack → 审计”的 Phase 3 可执行链路。

**关闭要求：**

1. 由组合根为已登记项目构建 `LocalGitAdapter`、`WorktreeManager`、`EvidenceRouter` 和 `EvidenceCollector`；增加最小应用服务或 API 用例，禁止调用方绕过这些受控服务直接传入任意 EvidenceItem 或 Worktree。
2. 以追加审计事件记录 Router 请求种类、实际项目/仓库查询范围、产生的 Pack ID/版本；日志不得记录敏感环境变量值。
3. 将 P1-R01 的受控 Diff 结果作为 `source`、`locator`、`contentHash` 完整的 Git Evidence 写入 Pack。
4. 新增从 API/应用服务入口开始的真实 SQLite + Git 场景测试，断言项目隔离、Router 请求、Git 历史/blame/Diff 证据、Pack 版本和完整审计时间线。

## 6. 本轮独立命令结果

复验环境为 Node `v24.18.0`、pnpm `v11.16.0`。首次执行测试发现本地 `better-sqlite3@12.11.1` 二进制仍是 Node 22 ABI 127，而当前 Node 24 需要 ABI 137；独立执行 `pnpm rebuild better-sqlite3` 后重新运行全部命令。该问题是本地原生依赖缓存与运行时不匹配，不是本轮 TypeScript 实现断言失败；重建后已能真实加载 SQLite。

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm rebuild better-sqlite3` | 通过 | `better-sqlite3` 已按当前 Node 24 原生 ABI 重建。 |
| `pnpm test` | 通过 | 501 项通过、1 项既有 Windows 符号链接权限跳过；Core 118、Governance 244、Adapters 65、Store 63、API 11。Store 包包含真实 SQLite、Python Git worktree 和 EvidenceCollector 集成测试。 |
| `pnpm typecheck` | 通过 | 5 个工作区包全部通过。 |
| `pnpm lint` | 通过 | 5 个工作区包全部通过。 |
| `pnpm build` | 通过 | 5 个工作区包全部通过。 |
| `git diff --check` | 通过 | 未发现本轮工作区文本补丁的空白错误。 |

## 7. 当前退出条件映射

| 规格退出条件 | 结论 | 当前证据 |
| --- | --- | --- |
| 两个样例仓库能安全创建/回收外置 worktree | 部分满足 | `WorktreeManager` 的真实 SQLite + Python Git 测试已覆盖登记、终态和跨任务拒绝；但正式组合根未接入受控服务，且 Diff 获取仍可绕开受控编排。 |
| 所有 Pack 证据可回溯来源 | 不满足 | 现有 Pack 条目字段可追溯，Git history/blame 与 Memory 已有真实集成测试；但正式装配、Router/范围审计和 Diff Evidence 均缺失。 |
| Pack 不可原地修改，只能经 Evidence Request 升级 | 满足 | SQLite 重复版本拒绝、跨任务 Request 拒绝、合法版本演进与旧版本保留均有真实 SQLite 测试。 |
| FakeGitAdapter 与 LocalGitAdapter 使用同一契约 | 满足 | 共享契约测试通过；LocalGitAdapter 的生产等价 roots 和未登记其他仓库拒绝测试通过。 |

## 8. 给后续实现 AI 的强制交接

1. 只实现 P1-R01、P1-R02 及其指定测试；不要把本报告、`AGENTS.md` 或 README 中的 Phase 3 状态改为“通过”。
2. 实现 Agent 可以运行自测，但不得审查或批准自己实现的代码，也不得关闭 P1-R01/P1-R02。
3. 完成后由未参与实现的独立 Reviewer 重新阅读本规格、本报告和源码，并独立运行本节命令；只有两项 P1 均关闭后，Reviewer 才能更新本报告结论、阶段门禁和 README。

---

## 9. 第三次独立复验（2026-07-27）

> 本节为当前有效结论，覆盖第 5～8 节。  
> 复验角色：未参与本轮实现的独立 Reviewer。  
> **当前结论：Phase 3 仍暂不通过，禁止进入 Phase 4。**

### 9.1 已关闭：P1-R01（Diff 审计闭环）

`WorktreeManager.captureDiffForTask` 现会先从 SQLite `WorktreeRepository` 加载登记记录并校验任务归属，再在事务外调用 `GitAdapter.getDiff`；随后追加两条 `command_executed`（`git diff HEAD`、`git diff --name-only HEAD`）和一条带 `diffHash` 的 `diff_recorded` 审计事件。伪造 worktree 与跨任务 worktree 都会在 Git I/O 前被拒绝。

`EvidenceCollector` 在提供 `worktreeId` 时只能通过该受控入口生成 `git-diff` EvidenceItem，其 `locator`、`contentHash` 分别绑定 worktree 与 `DiffArtifact.hash`。`apps/api/tests/controlled-services-integration.test.ts` 已以真实 SQLite + Git 验证 API 的 `/tasks/:taskId/diff` 和 Evidence Pack 链路中的 Diff 审计与证据。

### 9.2 已关闭：P1-R02（组合根与受控证据链）

组合根已通过 `createServicesForProject` 将项目绑定的 `LocalGitAdapter`、`WorktreeManager`、`EvidenceRouter` 与 `EvidenceCollector` 装配为同一受控服务集合，并按项目缓存。新增 API 端点把以下调用收敛到该集合：

* `POST /tasks/:taskId/worktrees`：创建并登记 worktree；
* `POST /tasks/:taskId/collect-evidence`：Router → Git 历史 / blame / SQLite Memory / 可选 Diff → Evidence Pack；
* `POST /tasks/:taskId/diff`：只经 `WorktreeManager.captureDiffForTask` 获取 Diff。

`EvidenceCollector` 会将每条 Router 请求作为 `evidence_router_request` 追加审计，记录 kind、source 和 allowedScope；真实 Git 命令、Diff 哈希与 Pack 版本也都能在同一 SQLite 时间线查询。真实 API 集成测试已验证项目仓库隔离、Pack 字段可追溯和 `git-diff` Evidence 写入 Pack。

### 9.3 新 P1-R03：创建 worktree 绕过执行审批

**位置：** `packages/core/src/services/worktree-manager.ts` 的 `createAndAttachWorktree`，`apps/api/src/composition-root.ts` 的 `POST /tasks/:taskId/worktrees`。

实施规格 §7.2 将“创建 worktree”列为“需执行审批或项目预授权，并审计”的操作；§8.1 第 5 步也明确“获取执行批准后创建 worktree”。但 `createAndAttachWorktree` 在调用 `git worktree add` 前未读取任务状态、未检查有效 execution approval，更未比对 approval 的 `scopeHash` 与 `allowedPaths` / 受控命令 / 风险等级。API 端点直接调用该方法，同样没有审批检查。

这不是理论风险：新增的 `controlled-services-integration.test.ts` 以刚创建的 `CREATED` 任务调用 `/tasks/:taskId/worktrees`，并断言 HTTP 201 与真实 worktree 创建成功。也就是说，虽然 `/transition` 已禁止绕过审批直接进入 `EXECUTING`，攻击者或调用方仍可绕过同一执行审批闸门触发 `git worktree add`。这违反 AGENTS.md 规则 5 的“审批不可绕过”边界，定为 P1。

**关闭要求：**

1. 将 worktree 创建授权收敛到 `WorktreeManager` 或一个更高层的框架无关编排服务：在任何 Git I/O 前原子读取任务、有效 execution approval 与当前 scopeHash；仅在审批有效且 scope 一致时允许创建。禁止只在 Fastify 路由层做检查。
2. 明确合法时序并落实到状态机：执行审批已获得后才可创建 worktree；若需要先创建再进入 `EXECUTING`，必须建立一个不会让审批与真实副作用脱钩的受控过渡，而不是允许 `CREATED` / `GATHERING_EVIDENCE` 任意创建。
3. `allowedPaths`、命令白名单和风险等级必须来自已批准的 Plan / scopeHash，不得信任 `/worktrees` 请求体提供的任意 `allowedPaths`；范围不匹配时拒绝并写 `policy_denied` 审计。
4. 新增真实 SQLite + Git 对抗性测试：`CREATED`、`GATHERING_EVIDENCE`、`PLANNED`、无审批的 `AWAITING_EXECUTION_APPROVAL`、失效审批和 scopeHash 不一致均必须拒绝且不创建目录；只有有效审批的合法状态能创建、登记并审计 worktree。

### 9.4 独立命令结果与环境说明

复验环境为 Node `v24.18.0`、pnpm `v11.16.0`。

首次运行根命令 `pnpm test` 时，`better-sqlite3@12.11.1` 被本地依赖状态切换为 Node 22 ABI 127，而当前 Node 24 需要 ABI 137，因此 Core、Governance、Adapters 共 427 项通过后，Store 与 API 的 SQLite 测试无法加载原生模块。执行 `pnpm rebuild better-sqlite3` 后，直接运行工作区测试命令获得完整通过结果：

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm test` | 环境失败 | `better-sqlite3` ABI 127 与 Node 24 ABI 137 不匹配；不是 TypeScript 断言失败，但根命令在当前本地缓存状态下不可直接完成。 |
| `pnpm rebuild better-sqlite3` | 通过 | 原生模块按当前 Node 24 重建。 |
| `pnpm -r run test` | 通过 | 509 项通过、1 项既有 Windows 符号链接权限跳过；Core 118、Governance 244、Adapters 65、Store 66、API 16。新增真实 API + SQLite + Git 场景测试通过。 |
| `pnpm typecheck` | 通过 | 5 个工作区包全部通过。 |
| `pnpm lint` | 通过 | 5 个工作区包全部通过。 |
| `pnpm build` | 通过 | 5 个工作区包全部通过。 |

ABI 缓存问题不改变 P1-R03 的源码结论；后续实现和下一轮验收应先在当前 Node 主版本执行 `pnpm rebuild better-sqlite3`，并进一步查明为何根 `pnpm test` 会重新落入 ABI 127，避免交付环境出现不可重复验证。

### 9.5 当前退出条件映射

| 规格退出条件 | 结论 | 当前证据 |
| --- | --- | --- |
| 两个样例仓库能安全创建/回收外置 worktree | 不满足 | 路径、登记、终态、Diff 审计和项目隔离均已有真实测试；但创建 worktree 可绕过执行审批，违反“安全创建”前提。 |
| 所有 Pack 证据可回溯来源 | 满足 | 真实 API 链路已产生 Router 范围审计、Git history/blame/Diff/Memory Evidence、Pack 版本与 Git 命令审计。 |
| Pack 不可原地修改，只能经 Evidence Request 升级 | 满足 | SQLite 不可变性与跨任务隔离集成测试通过。 |
| FakeGitAdapter 与 LocalGitAdapter 使用同一契约 | 满足 | 共享契约与真实 Git 测试通过。 |

### 9.6 给后续实现 AI 的强制交接

1. 仅修复 P1-R03 及其对抗性测试；不得将本报告、AGENTS.md 或 README 的 Phase 3 状态改为“通过”。
2. 实现 Agent 可以运行自测，但不得自行审查、批准自己的实现，也不得关闭 P1-R03。
3. 修复后由未参与该实现的 Reviewer 重新阅读规格、AGENTS.md、本报告和代码，并独立运行 `pnpm rebuild better-sqlite3`、`pnpm -r run test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`；P1-R03 关闭后才能签发 Phase 3 通过结论。

---

## 10. 第四次独立复验（2026-07-27）

> 本节为当前有效结论，覆盖第 9 节。  
> 复验角色：未参与本轮实现的独立 Reviewer。  
> **当前结论：Phase 3 仍暂不通过，禁止进入 Phase 4。**

### 10.1 已关闭：P1-R03（无审批创建 worktree）

`WorktreeManager.createAndAttachWorktree` 已在任何 Git I/O 前，于核心层读取 task、Plan、project 和有效 execution approval，并强制：

* 任务必须处于 `AWAITING_EXECUTION_APPROVAL`；
* 必须存在未失效的 execution approval；
* approval 的 scopeHash 必须与当前 Plan / project / risk 的范围快照一致；
* `allowedPaths` 只能取自已持久化的 Plan，`/worktrees` 请求体不再能够提交任意路径。

拒绝会以独立事务写入 `policy_denied`，成功才会执行 `git worktree add`、登记 worktree 和写命令审计。新增真实 SQLite + Git 对抗性测试已覆盖 `CREATED`、`GATHERING_EVIDENCE`、`PLANNED`、无审批、失效审批、范围不一致与有效审批成功七类场景。原 P1-R03 已关闭。

### 10.2 新 P1-R04：scopeHash 未包含实际命令 argv，审批后可替换同名危险命令

**位置：** `packages/core/src/services/worktree-manager.ts` 的 `authorizeWorktreeCreation`，`packages/core/src/services/task-orchestrator.ts` 的 `computeCurrentScopeHash` 与 `beginExecutionIfApproved`。

当前 scopeHash 的 `commandWhitelist` 由 `Object.keys(project.commands).sort()` 生成，只包含命令名称（例如 `test`、`lint`），不包含实际固定 argv、timeout 或其他执行语义。审批后，只要保留同一个 key，就可以把：

```text
test: ["python", "-m", "pytest"]
```

替换为任意不同 argv；scopeHash 仍然相同，`WorktreeManager` 会放行 worktree 创建。现有“scopeHash 不一致”测试只新增 `build` key，因此未覆盖这个同名替换攻击面。

此外，`beginExecutionIfApproved(taskId, planScopeHash)` 仍信任调用方传入的 hash，而不是在同一事务内从当前 Plan 与 Project 重新计算。因此调用方可持有旧 hash，在同名命令替换后继续进入 `EXECUTING`。这违反实施规格 §7.2 的“命令只能匹配项目注册时固定 argv 白名单”以及 AGENTS.md 规则 5 的审批不可绕过要求，定为 P1。

**关闭要求：**

1. scope 快照必须对完整命令契约进行规范化哈希：按命令名排序，并包含每条 `argv`、`timeoutMs` 及所有影响执行权限的字段；不得仅哈希命令 key。
2. `WorktreeManager` 和 `beginExecutionIfApproved` 必须在同一事务内从 `task.currentPlanId`、当前项目命令与风险等级重新计算权威 scopeHash；`beginExecutionIfApproved` 不得信任调用方可伪造或陈旧的 hash。
3. 增加真实 SQLite + Git 对抗性测试：审批后仅替换同一命令 key 的 argv（不增删 key）必须拒绝 worktree 创建、不得创建目录、写 `policy_denied`；同一情形也必须拒绝进入 `EXECUTING`。
4. 同时补充多 Plan 场景：范围校验必须使用 `task.currentPlanId` 指向的 Plan，不得以按时间排序的“最后一条 Plan”代替权威引用。

### 10.3 独立命令结果

复验环境为 Node `v24.18.0`、pnpm `v11.16.0`。先执行 `pnpm rebuild better-sqlite3` 以匹配当前 Node 24 原生 ABI，再运行：

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm rebuild better-sqlite3` | 通过 | 原生 SQLite 模块已按当前 Node 24 重建。 |
| `pnpm -r run test` | 通过 | 516 项通过、1 项既有 Windows 符号链接权限跳过；Core 118、Governance 244、Adapters 65、Store 66、API 23。新增 worktree 授权对抗性测试 7 项通过。 |
| `pnpm typecheck` | 通过 | 5 个工作区包全部通过。 |
| `pnpm lint` | 通过 | 5 个工作区包全部通过。 |
| `pnpm build` | 通过 | 5 个工作区包全部通过。 |
| `git diff --check` | 通过 | 未发现工作区补丁的空白错误。 |

### 10.4 当前退出条件映射

| 规格退出条件 | 结论 | 当前证据 |
| --- | --- | --- |
| 两个样例仓库能安全创建/回收外置 worktree | 不满足 | 登记、终态回收、审批状态、路径来源与审计已有真实测试；但同名命令 argv 可在审批后替换而不使 scopeHash 失效。 |
| 所有 Pack 证据可回溯来源 | 满足 | Router、Git history/blame/Diff、SQLite Memory、Pack 版本与审计链均有真实 API 场景覆盖。 |
| Pack 不可原地修改，只能经 Evidence Request 升级 | 满足 | SQLite 不可变性与跨任务隔离集成测试通过。 |
| FakeGitAdapter 与 LocalGitAdapter 使用同一契约 | 满足 | 共享契约与真实 Git 测试通过。 |

### 10.5 给后续实现 AI 的强制交接

1. 仅修复 P1-R04 及其对抗性测试；不得将本报告、AGENTS.md 或 README 的 Phase 3 状态改为“通过”。
2. 实现 Agent 可以运行自测，但不得自行审查、批准自己的实现，也不得关闭 P1-R04。
3. 修复后由未参与该实现的 Reviewer 重新阅读规格、AGENTS.md、本报告和代码，并独立运行本节命令；只有 P1-R04 关闭后才能签发 Phase 3 通过结论。

---

## 11. 第五次独立复验与最终验收（2026-07-27）

> 本节为当前有效结论，覆盖第 10 节及以前的所有“暂不通过”结论。  
> 复验角色：未参与 P1-R04 实现的独立 Reviewer。  
> **最终结论：Phase 3 通过，可以进入 Phase 4。**

### 11.1 P1-R04 已关闭：执行审批范围绑定完整命令契约和当前 Plan

经重新检查，P1-R04 的四项关闭要求均已满足：

1. `computeScopeHash` 对命令 key 排序，并将每条命令的 `argv`（保留顺序）与 `timeoutMs` 一并参与规范化哈希；`ProjectCommands` 中不存在其他影响执行权限的字段。
2. `WorktreeManager.createAndAttachWorktree` 在 Git I/O 前、同一事务内通过 `task.currentPlanId` 读取权威 Plan，重新计算范围哈希并校验有效 execution approval。`TaskOrchestrator.beginExecutionIfApproved` 已删除调用方传入 hash 的入口，改为在其事务内重新计算后再比对审批记录。
3. 真实 SQLite + Git 的 API 集成测试覆盖：审批后仅替换同名 `test` 命令的 `argv` 时，创建 worktree 被拒绝、不产生目录且写入 `policy_denied`；相同篡改也会拒绝进入 `EXECUTING`。
4. 多 Plan 对抗性测试直接插入时间更晚的 Plan B、保留 `task.currentPlanId` 指向 Plan A，并验证授权仍以 Plan A 为准，未退化为“最后一条 Plan”。

因此，审批后替换同名危险命令、传入陈旧 hash 或利用较晚 Plan 扩大范围的路径均不能越过核心授权边界。

### 11.2 独立运行结果

复验环境：Node `v24.18.0`、pnpm `v11.16.0`。先重建 `better-sqlite3` 以确保当前 Node 24 ABI 可真实加载 SQLite，再独立执行下列命令：

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm rebuild better-sqlite3` | 通过 | `better-sqlite3` 已按当前 Node 24 原生 ABI 重建并可被 SQLite 测试加载。 |
| `pnpm -r run test` | 通过 | 519 项通过、1 项既有 Windows 符号链接权限测试跳过；Core 118、Governance 244、Adapters 65、Store 66、API 26。API 中 P1-R04 同名命令篡改与多 Plan 场景均通过。 |
| `pnpm typecheck` | 通过 | 5 个工作区包全部通过。 |
| `pnpm lint` | 通过 | 5 个工作区包全部通过。 |
| `pnpm build` | 通过 | 5 个工作区包全部通过。 |
| `git diff --check` | 通过 | 未发现工作区补丁的空白错误。 |

### 11.3 Phase 3 退出条件最终映射

| 规格退出条件 | 最终结论 | 独立复验依据 |
| --- | --- | --- |
| 两个样例仓库能安全创建/回收外置 worktree | 满足 | LocalGitAdapter 契约与 Python、TypeScript 样例仓库真实 Git 测试覆盖创建、登记、受控根、终态回收、项目隔离、审批校验和审计。 |
| 所有 Pack 证据可回溯来源 | 满足 | 正式 API 链路覆盖 Router 范围审计、Git history/blame/Diff、SQLite Repair Memory、Pack 版本和 Git 命令审计。 |
| Pack 不可原地修改，只能经 Evidence Request 升级 | 满足 | SQLite 不可变性、跨任务隔离、合法版本演进和旧版本保留均有集成测试。 |
| FakeGitAdapter 与 LocalGitAdapter 使用同一契约 | 满足 | 共享契约测试与真实 Git 集成测试均通过。 |

### 11.4 后续阶段约束

1. Phase 4 必须先阅读本报告及 `docs/IMPLEMENTATION_SPEC.md`；Runtime 仍只能经 Adapter 边界接入，且 Resume Release 必须由真实 `OmpAdapter` 完成分析、修改、验证、Diff 和独立审查。
2. 不得因进入下一阶段回退 Phase 3 的安全边界：外置已登记 worktree、项目仓库根与 worktree 根分离、执行审批的完整命令范围哈希、Git 审计、Evidence Pack 不可变性均须保留。
3. 若改动上述边界，必须补齐回归与对抗性测试，并由未参与该实现的 Reviewer 重新独立复核；实现 Agent 不得自行将验收结论改为“通过”。
