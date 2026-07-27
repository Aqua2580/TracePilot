# Phase 3：Git 与证据 实现规格

## Why

Phase 2 已完成 SQLite 持久化与 Fake Adapter 闭环。Phase 3 必须把 `GitAdapter` 从内存 Fake 替换为真实 git 命令驱动的 `LocalGitAdapter`，落地外置 worktree 的创建/回收、Diff 获取、历史与 blame 解析，并把证据采集、Evidence Pack 版本编排接入 Orchestrator。这是 MVP 纵向闭环从"内存模拟"过渡到"真实隔离修改"的关键一步——没有真实 worktree，Phase 4 的真实修复闭环就无法在不污染原分支的情况下进行。

依据 `docs/IMPLEMENTATION_SPEC.md` §9 Phase 3 退出条件：**两个样例仓库能安全创建/回收 worktree；所有 Pack 证据可回溯来源。**

## What Changes

### 新增

- **真实 `LocalGitAdapter`**：通过受治理的 `ProcessRunner` 执行 git 命令，实现 `validateRepository` / `createWorktree` / `getDiff` / `getHistory` / `getBlame` / `removeRegisteredWorktree`。所有 git 子命令必须经 `CommandPolicy` 与 `PathPolicy` 校验，禁止直接 `child_process.spawn`。
- **Git 命令解析器**：`git log` 输出结构化为 `GitEvidence[]`，`git blame` 输出结构化为 `BlameEvidence[]`，`git diff` 输出计算稳定哈希与变更文件列表。
- **`BlameQuery` / `BlameEvidence` 端口扩展**：在 `GitAdapter` 接口上新增 `getBlame` 方法，与 `getHistory` 同属只读 git 证据来源。
- **`EvidenceRouter` 领域服务**：根据 `TaskInput.origin`（failed_test_log / issue）和 `failure` 元数据，按确定性规则输出对 `code` / `git` / `runtime` / `memory` / `policy` 五类证据的请求清单。Router 是纯领域逻辑，不直接调用 Adapter。
- **Orchestrator 证据/Pack 编排方法**：新增 `gatherEvidenceAndCreatePack`（生成 Pack v1）、`submitEvidenceRequestAndEvolvePack`（生成 Pack v(n+1)）、`attachWorktree`（把登记的 worktree 写到任务上）。每次 Pack 写入都在同一 `UnitOfWork` 事务内追加 `evidence_pack_versioned` 审计事件。
- **契约测试套件**：`FakeGitAdapter` 与 `LocalGitAdapter` 必须通过同一组契约测试（成功 / 失败 / 取消 / 超时 / 输出格式 / 路径边界），覆盖 §6 要求。
- **两个样例仓库夹具**：在测试中用真实 `git init` 在临时目录种出 python 与 typescript 两个最小样例仓库，用于真实 worktree 创建/回收集成测试。
- **ADR-002**：`docs/adr/ADR-002-worktree-and-command-safety.md` 落地 worktree 受控根目录、路径解析、命令 argv 白名单、清理策略（§7.1、§7.2、§11）。

### 修改

- **`FakeGitAdapter`**：补齐 `getBlame` 实现，使其与 `LocalGitAdapter` 满足同一契约。
- **`TaskOrchestrator`**：扩展证据/Pack 编排能力，但保持状态迁移与审计同事务的不变量。新增方法不得破坏既有 `transitionTask` / `beginExecutionIfApproved` 的安全边界。
- **`LocalCommandAdapter`**：`develop` 路径不再写 no-op 注释，改为明确"Phase 3 仍未接 LLM，develop 由 Phase 4 落地"，避免误导后续 AI。

### 不做（明确排除）

- 不接入真实 `OmpAdapter`（Phase 4）。
- 不实现 Planner / Developer / Reviewer 真实 LLM 调用（Phase 4 / 5）。
- 不引入 Docker、PostgreSQL、Prisma、Redis。
- 不修改 SQLite 迁移历史已发布版本（只追加新迁移）。
- 不修改 Phase 1 治理边界（CommandPolicy / PathPolicy / ApprovalPolicy / AuditPolicy）的安全语义；若发现漏洞必须按 AGENTS.md 规则 12 重新独立复核。

## Impact

### 受影响规格

- §5.3 Evidence Pack：Pack 版本编排从"领域模型存在"变为"Orchestrator 真实生成与版本升级"。
- §6 GitAdapter：从"端口定义"变为"端口 + 真实实现 + 契约测试"。
- §7.1 Worktree：从"治理规则"变为"治理规则 + 真实创建/回收 + 集成测试"。
- §8.1 工作流步骤 2-3：Evidence Router 与 Pack v1 生成从"规格描述"变为"可执行实现"。
- §11 ADR-002：从"待办"变为"已落地"。

### 受影响代码

| 文件 | 变更类型 |
| --- | --- |
| `packages/core/src/ports/adapters.ts` | 新增 `BlameQuery` / `BlameEvidence`，扩展 `GitAdapter` |
| `packages/core/src/services/task-orchestrator.ts` | 新增证据/Pack/worktree 编排方法 |
| `packages/core/src/services/evidence-router.ts` | 新增领域服务 |
| `packages/core/src/index.ts` | 导出新增类型 |
| `packages/core/tests/evidence-router.test.ts` | 新增单元测试 |
| `packages/core/tests/task-orchestrator.test.ts` | 新增 Pack 版本与 worktree 编排测试 |
| `packages/adapters/src/local-git-adapter.ts` | 新增真实实现 |
| `packages/adapters/src/git-parsers.ts` | 新增 log / blame / diff 解析器 |
| `packages/adapters/src/fakes.ts` | 补齐 `FakeGitAdapter.getBlame` |
| `packages/adapters/src/index.ts` | 导出新模块 |
| `packages/adapters/tests/git-adapter-contract.test.ts` | 新增契约测试套件 |
| `packages/adapters/tests/local-git-adapter.test.ts` | 新增真实 git 集成测试（含两个样例仓库） |
| `packages/adapters/tests/fixtures/sample-repos.ts` | 新增样例仓库种入辅助 |
| `docs/adr/ADR-002-worktree-and-command-safety.md` | 新增 ADR |
| `docs/reviews/PHASE-3-ACCEPTANCE-REVIEW.md` | 新增验收报告骨架（由独立 Reviewer 填写） |

## ADDED Requirements

### Requirement: 真实 GitAdapter 实现

系统 SHALL 通过 `LocalGitAdapter` 提供基于本地 `git` 二进制的 `GitAdapter` 实现，所有 git 命令 MUST 经注入的 `ProcessRunner` 执行，并经 `CommandPolicy` 与 `PathPolicy` 校验。

#### Scenario: 校验合法仓库

- **WHEN** 调用 `validateRepository("/path/to/repo")` 且路径是干净 git 仓库
- **THEN** 返回 `RepositoryInfo`，包含 `repositoryPath`（已解析真实路径）、`defaultBranch`（当前分支）、`headCommitSha`、`isClean=true`

#### Scenario: 拒绝非仓库路径

- **WHEN** 调用 `validateRepository("/not/a/repo")`
- **THEN** 抛出结构化错误，错误信息明确指出"不是 git 仓库"

#### Scenario: 拒绝脏仓库用作 worktree 创建

- **WHEN** 调用 `createWorktree` 且源仓库 `isClean=false`
- **THEN** 抛出错误，要求先提交或 stash 未提交改动

### Requirement: 外置 Worktree 创建与回收

系统 SHALL 在受控根目录 `%LOCALAPPDATA%/TracePilot/worktrees/<project-slug>/<task-id>/` 下创建 worktree，且 MUST 满足 §7.1 安全条件。

#### Scenario: 安全创建 worktree

- **WHEN** 调用 `createWorktree` 且仓库已校验、目标路径位于受控根目录内、目录不存在
- **THEN** 执行 `git worktree add <path> -b tp/<task-id> <base>`，返回 `Worktree` 记录，包含 `path`、`branch`、`baseCommitSha`、`allowedPaths`

#### Scenario: 拒绝路径穿越

- **WHEN** `taskId` 包含 `..` 或绝对路径片段
- **THEN** 抛出错误，不得创建任何目录或 worktree

#### Scenario: 拒绝覆盖已存在目录

- **WHEN** 目标 worktree 目录已存在
- **THEN** 抛出错误，不得执行 `git worktree add`

#### Scenario: 安全回收 worktree

- **WHEN** 调用 `removeRegisteredWorktree(worktree)` 且 `worktree.path` 位于受控根目录内、worktree 已在数据库登记
- **THEN** 执行 `git worktree remove <path>`，删除目录，并返回成功

#### Scenario: 拒绝回收未登记 worktree

- **WHEN** 调用 `removeRegisteredWorktree` 但 worktree 不在数据库登记中
- **THEN** 抛出错误，不得删除任何文件

#### Scenario: 拒绝回收受控根目录外的路径

- **WHEN** `worktree.path` 经 `realpath` 解析后位于受控根目录之外
- **THEN** 抛出错误，不得执行删除

### Requirement: Diff 获取与哈希

系统 SHALL 通过 `git diff` 在 worktree 中获取变更，并计算稳定哈希。

#### Scenario: 空改动

- **WHEN** worktree 无任何改动
- **THEN** 返回 `DiffArtifact`，`patch=""`、`hash=<空内容哈希>`、`changedFiles=[]`、`bytes=0`

#### Scenario: 有改动

- **WHEN** worktree 有改动
- **THEN** 返回 `DiffArtifact`，`patch` 为 unified diff，`hash` 为 `sha256-<hex>`，`changedFiles` 为变更文件相对路径列表

### Requirement: 历史与 Blame 解析

系统 SHALL 把 `git log` 与 `git blame` 输出结构化为 `GitEvidence[]` 与 `BlameEvidence[]`。

#### Scenario: 解析 git log

- **WHEN** 调用 `getHistory` 指定 `maxCount=5`
- **THEN** 返回最多 5 条 `GitEvidence`，每条包含 `commitSha`、`author`、`authoredAt`（ISO 8601）、`message`（首行）、`files`（该 commit 改动的文件相对路径）

#### Scenario: 解析 git blame

- **WHEN** 调用 `getBlame` 指定 `path="src/foo.ts"`
- **THEN** 返回 `BlameEvidence[]`，每条包含 `commitSha`、`author`、`authoredAt`、`lineRange`（`[startLine, endLine]`）、`lineContent`（该行原文）

### Requirement: Evidence Router 领域服务

系统 SHALL 提供 `EvidenceRouter`，根据 `TaskInput` 输出对五类证据的确定性请求清单，自身不执行 I/O。

#### Scenario: failed_test_log 任务

- **WHEN** 输入 `origin="failed_test_log"` 且 `failure.testNames` 非空
- **THEN** 输出包含 `code`（按 test 文件名定位）、`git`（按 test 文件 history）、`runtime`（运行测试捕获堆栈）、`memory`（按 symptom 召回）、`policy`（项目约束）五类请求

#### Scenario: issue 任务

- **WHEN** 输入 `origin="issue"`
- **THEN** 输出包含 `code`（关键词搜索）、`git`（最近 N 条历史）、`memory`（按 objective 召回）、`policy`（项目约束）四类请求，不含 `runtime`（issue 无失败日志可重跑）

#### Scenario: 确定性

- **WHEN** 同一 `TaskInput` 输入两次
- **THEN** 两次输出的请求清单完全相同（顺序、类别、定位参数一致）

### Requirement: Evidence Pack 版本编排

系统 SHALL 通过 `TaskOrchestrator` 受控生成 Evidence Pack v1，并通过 `EvidenceRequest` 流程生成 v(n+1)。

#### Scenario: 生成 Pack v1

- **WHEN** 任务处于 `GATHERING_EVIDENCE` 且 Orchestrator 收到 `EvidenceRouter` 的请求清单与 Adapter 返回的 `EvidenceItem[]`
- **THEN** 在同一 `UnitOfWork` 事务内创建 `EvidencePack { version: 1 }`，写入 `evidence_pack_versioned` 审计事件，并把 `task.currentEvidencePackId` / `currentEvidencePackVersion` 更新为该 Pack

#### Scenario: 生成 Pack v(n+1)

- **WHEN** Agent 提交结构化 `EvidenceRequest`，Orchestrator 审核后迁移到 `GATHERING_EVIDENCE`
- **THEN** 在同一事务内基于上一版本生成 `EvidencePack { version: n+1 }`，旧版本永久保留，新版本写入审计

#### Scenario: Pack 不可变

- **WHEN** 尝试对同一 `id` 和 `version` 二次写入
- **THEN** 抛出 `EvidencePackVersionError`，已存在的版本不被修改

### Requirement: 契约测试套件

系统 SHALL 提供 `FakeGitAdapter` 与 `LocalGitAdapter` 共用的契约测试套件，覆盖 §6 要求的成功 / 失败 / 取消 / 超时 / 输出格式 / 路径边界。

#### Scenario: 同一契约套件覆盖两个实现

- **WHEN** 运行契约测试套件
- **THEN** `FakeGitAdapter` 与 `LocalGitAdapter` 必须通过相同断言（结构、字段、错误类型、路径校验）

### Requirement: 两个样例仓库集成测试

系统 SHALL 在测试中种入两个真实 git 仓库（python + typescript）作为样例，覆盖 Phase 3 退出条件。

#### Scenario: python 样例仓库

- **WHEN** 在临时目录 `git init` 一个含 `pytest.ini` 与 `tests/test_sample.py` 的仓库
- **THEN** `LocalGitAdapter.createWorktree` + `getDiff` + `getHistory` + `getBlame` + `removeRegisteredWorktree` 全流程可执行，且 worktree 目录被正确清理

#### Scenario: typescript 样例仓库

- **WHEN** 在临时目录 `git init` 一个含 `package.json` 与 `src/index.ts` 的仓库
- **THEN** 同上全流程可执行

## MODIFIED Requirements

### Requirement: GitAdapter 端口

`GitAdapter` 接口 MUST 新增 `getBlame(query: BlameQuery): Promise<BlameEvidence[]>` 方法。`BlameQuery` 包含 `repositoryPath`、`path`（相对仓库根）、可选 `startLine` / `endLine`。`BlameEvidence` 包含 `commitSha`、`author`、`authoredAt`、`lineRange`、`lineContent`。

### Requirement: FakeGitAdapter

`FakeGitAdapter` MUST 实现 `getBlame`，返回确定性结构（与 `LocalGitAdapter` 满足同一契约）。原 `getHistory` 返回空数组的实现保留，但契约测试 MUST 覆盖"非空 history"场景（通过 `setHistory` 测试辅助注入）。

### Requirement: TaskOrchestrator

`TaskOrchestrator` MUST 新增以下方法，且每个方法都遵循"状态迁移 + 审计同事务"不变量：

- `gatherEvidenceAndCreatePack(args): Promise<EvidencePack>` —— 在 `GATHERING_EVIDENCE` 状态下生成 Pack v1
- `submitEvidenceRequest(args): Promise<EvidenceRequest>` —— 持久化 EvidenceRequest 并迁移到 `EVIDENCE_GAP`（若当前为 `EXECUTING`）或保持 `GATHERING_EVIDENCE`
- `evolvePackWithNewEvidence(args): Promise<EvidencePack>` —— 基于 EvidenceRequest 生成 Pack v(n+1)
- `attachWorktree(taskId, worktree): Promise<Task>` —— 把登记的 worktree 写到任务上

## REMOVED Requirements

无。Phase 3 不删除任何既有能力。

## 验证策略（自测仅用于确认实现正确性，不在文档中声称通过）

实现完成后，实现 Agent 应运行以下命令进行自测，但不得在 spec / tasks / checklist 或代码注释中声称"测试通过"或"验收通过"——验收结论只能由独立 Reviewer 在 `docs/reviews/PHASE-3-ACCEPTANCE-REVIEW.md` 中给出。

```powershell
pnpm install --no-frozen-lockfile
pnpm -r run typecheck
pnpm -r run lint
pnpm -r run build
pnpm -r run test
```

自测应覆盖以下场景（用于实现者自身验证，非验收结论）：

1. 两个样例仓库的 worktree 创建/回收全流程
2. `LocalGitAdapter` 与 `FakeGitAdapter` 通过同一契约套件
3. `EvidenceRouter` 对 `failed_test_log` 与 `issue` 两种 origin 的确定性输出
4. Pack v1 生成与 v(n+1) 升级的事务原子性
5. 路径穿越、未登记 worktree、受控根目录外路径的拒绝
