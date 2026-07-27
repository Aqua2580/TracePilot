# Phase 3 任务清单

> 所有任务遵循 AGENTS.md 规则 14：实现 Agent 可自测但不得声称验收通过。每个任务完成后勾选 `[x]`。验收结论由独立 Reviewer 在 `docs/reviews/PHASE-3-ACCEPTANCE-REVIEW.md` 给出。

## 一、端口与领域扩展（Core 层）

- [x] **任务 1：扩展 GitAdapter 端口，新增 BlameQuery / BlameEvidence**
  - [x] 1.1 在 `packages/core/src/ports/adapters.ts` 新增 `BlameQuery`（含 `repositoryPath`、`path`、可选 `startLine` / `endLine`）与 `BlameEvidence`（含 `commitSha`、`author`、`authoredAt`、`lineRange`、`lineContent`）接口
  - [x] 1.2 在 `GitAdapter` 接口新增 `getBlame(query: BlameQuery): Promise<BlameEvidence[]>` 方法
  - [x] 1.3 在 `packages/core/src/index.ts` 导出新增类型
  - [x] 1.4 运行 `pnpm --filter @tracepilot/core typecheck` 自检类型正确

- [x] **任务 2：实现 EvidenceRouter 领域服务**
  - [x] 2.1 新增 `packages/core/src/services/evidence-router.ts`，定义 `EvidenceRequestSpec`（kind / source / locator / allowedScope）与 `EvidenceRouter` 类
  - [x] 2.2 实现 `route(taskInput: TaskInput): EvidenceRequestSpec[]`，按 §8.1 步骤 2 输出确定性请求清单：
    - `origin="failed_test_log"`：输出 code（按 `failure.testNames` 定位）+ git（按 test 文件 history）+ runtime（运行测试捕获堆栈）+ memory（按 symptom 召回）+ policy（项目约束）
    - `origin="issue"`：输出 code（按 objective 关键词搜索）+ git（最近 N 条历史）+ memory（按 objective 召回）+ policy（项目约束），不含 runtime
  - [x] 2.3 Router 必须是纯函数式，不依赖 Adapter、不执行 I/O
  - [x] 2.4 在 `packages/core/src/index.ts` 导出 `EvidenceRouter` 与相关类型
  - [x] 2.5 新增 `packages/core/tests/evidence-router.test.ts`，覆盖：两种 origin 的请求清单、确定性（同输入两次输出相同）、空 failure 的 fallback

- [x] **任务 3：扩展 TaskOrchestrator 证据/Pack/worktree 编排方法**
  - [x] 3.1 在 `task-orchestrator.ts` 新增 `gatherEvidenceAndCreatePack(args: { taskId; packId; evidence; hypotheses?; constraints?; acceptanceCriteria? }): Promise<EvidencePack>`：校验任务处于 `GATHERING_EVIDENCE`，在同一 `UnitOfWork` 事务内创建 Pack v1、写 `evidence_pack_versioned` 审计、更新 `task.currentEvidencePackId/Version`
  - [x] 3.2 新增 `submitEvidenceRequest(args): Promise<EvidenceRequest>`：持久化 EvidenceRequest；若当前状态为 `EXECUTING` 迁移到 `EVIDENCE_GAP`，否则保持 `GATHERING_EVIDENCE`；追加 `evidence_request_submitted` 审计
  - [x] 3.3 新增 `evolvePackWithNewEvidence(args: { taskId; requestId; additions }): Promise<EvidencePack>`：基于上一版本用 `nextPackVersion` 生成 v(n+1)，在同一事务内写新 Pack + `evidence_pack_versioned` 审计 + 更新任务引用；旧版本不动
  - [x] 3.4 新增 `attachWorktree(taskId, worktree: Worktree): Promise<Task>`：在同一事务内把 `worktree.id` 写到 `task.worktreeId`，追加 `worktree_created` 审计
  - [x] 3.5 在 `packages/core/tests/task-orchestrator.test.ts` 新增测试：Pack v1 生成的事务原子性、Pack v(n+1) 升级保留旧版本、Pack 不可变（同 id+version 二次写入抛错）、attachWorktree 写审计、submitEvidenceRequest 状态迁移
  - [x] 3.6 运行 `pnpm --filter @tracepilot/core test` 自检

## 二、真实 GitAdapter 实现（adapters 层）

- [x] **任务 4：实现 git 输出解析器**
  - [x] 4.1 新增 `packages/adapters/src/git-parsers.ts`，实现 `parseGitLog(stdout: string): GitEvidence[]`：按 `\0` 或 `--format` 分隔字段（commitSha、author、authoredAt、message、files）
  - [x] 4.2 实现 `parseGitBlame(stdout: string): BlameEvidence[]`：解析 `git blame --line-porcelain` 输出，按行聚合 commit / author / lineRange / lineContent
  - [x] 4.3 实现 `parseGitDiffChangedFiles(stdout: string): string[]`：从 `git diff --name-only` 提取变更文件相对路径
  - [x] 4.4 新增 `packages/adapters/tests/git-parsers.test.ts`，覆盖正常输出、空输出、多 commit、多文件、特殊字符（中文文件名）的解析

- [x] **任务 5：实现 LocalGitAdapter**
  - [x] 5.1 新增 `packages/adapters/src/local-git-adapter.ts`，构造函数注入 `ProcessRunner`、`CommandPolicy`、`PathPolicy`、`ProcessPolicy`、`allowedWorktreeRoots`
  - [x] 5.2 实现 `validateRepository(projectPath)`：经治理闸门执行 `git rev-parse --show-toplevel`、`git rev-parse --abbrev-ref HEAD`、`git rev-parse HEAD`、`git status --porcelain`，返回 `RepositoryInfo`；非仓库或脏仓库抛结构化错误
  - [x] 5.3 实现 `createWorktree(input)`：
    - 校验 `taskId` 不含 `..` 或绝对路径片段
    - 计算受控路径 `%LOCALAPPDATA%/TracePilot/worktrees/<projectSlug>/<taskId>`
    - 用 `PathPolicy.decide` 校验目标路径位于受控根目录内
    - 校验目标目录不存在（拒绝覆盖）
    - 经治理闸门执行 `git worktree add <path> -b tp/<taskId> <baseSha>`
    - 返回 `Worktree` 记录
  - [x] 5.4 实现 `getDiff(worktreePath)`：经治理闸门执行 `git diff HEAD`，用 `node:crypto` 计算 `sha256-<hex>` 哈希，调用 `parseGitDiffChangedFiles` 提取变更文件列表
  - [x] 5.5 实现 `getHistory(query)`：经治理闸门执行 `git log --format=<...> -n <maxCount> [-- <paths>]`，调用 `parseGitLog` 解析
  - [x] 5.6 实现 `getBlame(query)`：经治理闸门执行 `git blame --line-porcelain [<startLine>,<endLine>] -- <path>`，调用 `parseGitBlame` 解析
  - [x] 5.7 实现 `removeRegisteredWorktree(worktree)`：
    - 用 `PathPolicy.decide` 校验 `worktree.path` 位于受控根目录内
    - 经治理闸门执行 `git worktree remove <path>`（若失败尝试 `--force` 并记录审计）
    - 不删除数据库登记记录（由调用方在事务内 `tx.worktrees.delete`）
  - [x] 5.8 所有 git 命令必须经注入的 `ProcessRunner.run(spec, cwd, policy)` 执行，禁止直接 `child_process.spawn`；argv 在调用前用 `CommandPolicy.decide` 校验
  - [x] 5.9 在 `packages/adapters/src/index.ts` 导出 `LocalGitAdapter` 与相关类型
  - [x] 5.10 修改 `packages/adapters/src/fakes.ts` 的 `FakeGitAdapter`，补齐 `getBlame` 实现（返回确定性结构），新增 `setHistory` 测试辅助方法供契约测试注入非空 history

## 三、契约测试与集成测试

- [x] **任务 6：实现 GitAdapter 契约测试套件**
  - [x] 6.1 新增 `packages/adapters/tests/git-adapter-contract.test.ts`，定义 `runGitAdapterContract(name, factory)` 工厂函数，接收 adapter 创建函数并运行统一断言
  - [x] 6.2 契约覆盖：
    - `validateRepository` 返回结构（字段齐全、类型正确）
    - `createWorktree` 返回结构（id / path / branch / baseCommitSha / allowedPaths / createdAt）
    - `getDiff` 返回结构（patch / hash / changedFiles / bytes）
    - `getHistory` 返回结构（commitSha / author / authoredAt / message / files）
    - `getBlame` 返回结构（commitSha / author / authoredAt / lineRange / lineContent）
    - `removeRegisteredWorktree` 对未登记 worktree 抛错
    - 路径穿越拒绝：`taskId="../../etc"` 必须抛错
    - 受控根目录外路径拒绝
  - [x] 6.3 在两个 `describe` 块中分别用 `FakeGitAdapter` 与 `LocalGitAdapter`（配合样例仓库夹具）实例化同一套契约
  - [x] 6.4 运行 `pnpm --filter @tracepilot/adapters test` 自检

- [x] **任务 7：实现两个样例仓库夹具与 LocalGitAdapter 集成测试**
  - [x] 7.1 新增 `packages/adapters/tests/fixtures/sample-repos.ts`，实现 `createPythonSampleRepo(tmpDir)` 与 `createTypescriptSampleRepo(tmpDir)`：
    - 用 `git init`、`git config user.email/name`、`git add`、`git commit` 在临时目录种出最小仓库
    - python 仓库含 `pytest.ini`、`tests/test_sample.py`、`src/sample.py`
    - typescript 仓库含 `package.json`、`tsconfig.json`、`src/index.ts`
  - [x] 7.2 新增 `packages/adapters/tests/local-git-adapter.test.ts`，覆盖 Phase 3 退出条件：
    - python 样例仓库：`validateRepository` → `createWorktree` → 在 worktree 内修改文件 → `getDiff` → `getHistory` → `getBlame` → `removeRegisteredWorktree`，断言 worktree 目录被清理
    - typescript 样例仓库：同上全流程
    - 拒绝非仓库路径
    - 拒绝脏仓库创建 worktree
    - 拒绝路径穿越（`taskId="../evil"`）
    - 拒绝覆盖已存在目录
    - 拒绝回收受控根目录外的路径
  - [x] 7.3 测试必须用真实 `git` 二进制（经 `LocalProcessRunner`），不 mock git 命令
  - [x] 7.4 Windows 与 POSIX 路径分隔符差异必须在夹具中处理（用 `node:path.join`）

## 四、文档与收尾

- [x] **任务 8：落地 ADR-002**
  - [x] 8.1 新增 `docs/adr/ADR-002-worktree-and-command-safety.md`，记录：
    - worktree 受控根目录（`%LOCALAPPDATA%/TracePilot/worktrees/<project-slug>/<task-id>/`）
    - 路径解析规则（realpath + 受控根目录校验 + 拒绝 `..`）
    - 命令 argv 白名单（git 只读子命令自动允许、worktree add 需执行审批、worktree remove 由 Manager 受控执行）
    - 清理策略（仅删除同时满足"路径在受控根目录内 + 已在数据库登记 + 任务已终态"的目录）
  - [x] 8.2 文档全中文，遵循 AGENTS.md 规则 11

- [x] **任务 9：调整 LocalCommandAdapter 注释与 index 导出**
  - [x] 9.1 修改 `packages/adapters/src/local-command-adapter.ts` 的 `develop` 方法注释，明确"Phase 3 仍未接 LLM，develop 由 Phase 4 落地"
  - [x] 9.2 更新 `packages/adapters/src/index.ts`，导出 `LocalGitAdapter`、`BlameQuery`、`BlameEvidence`、`EvidenceRouter`（如放在 adapters）等新类型
  - [x] 9.3 运行 `pnpm --filter @tracepilot/adapters typecheck` 自检

- [x] **任务 10：全仓自测与 README 更新**
  - [x] 10.1 运行 `pnpm install --no-frozen-lockfile` 确认依赖可装
  - [x] 10.2 运行 `pnpm -r run typecheck`、`pnpm -r run lint`、`pnpm -r run build`、`pnpm -r run test` 自测
  - [x] 10.3 更新 `README.md`：阶段状态从"Phase 2 已通过"改为"Phase 3 实现已完成，待独立验收"，新增 Phase 3 验收报告链接，新增 ADR-002 链接，更新测试统计
  - [x] 10.4 在 `docs/reviews/` 下创建 `PHASE-3-ACCEPTANCE-REVIEW.md` 骨架（仅标题与"待独立 Reviewer 填写"占位，不含任何结论）

# 任务依赖

- 任务 2、3 依赖任务 1（端口扩展）
- 任务 5 依赖任务 1（端口）与任务 4（解析器）
- 任务 6 依赖任务 5（LocalGitAdapter）与任务 5.10（FakeGitAdapter.getBlame）
- 任务 7 依赖任务 5 与任务 6
- 任务 8 可与任务 4-7 并行
- 任务 9 依赖任务 5
- 任务 10 依赖所有前置任务

可并行批次：
- 批次 A（Core 层，无依赖外部）：任务 1、2、3
- 批次 B（adapters 解析器，仅依赖任务 1 的类型）：任务 4
- 批次 C（真实实现，依赖批次 A + B）：任务 5
- 批次 D（测试，依赖批次 C）：任务 6、7
- 批次 E（文档，可并行 D）：任务 8、9
- 批次 F（收尾，依赖全部）：任务 10
