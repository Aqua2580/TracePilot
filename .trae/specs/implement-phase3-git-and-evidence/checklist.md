# Phase 3 验收检查清单

> 本清单用于实现 Agent 自检与独立 Reviewer 验收。实现 Agent 可勾选已完成项作为自测证据，但不得自行声明"验收通过"——验收结论只能由独立 Reviewer 在 `docs/reviews/PHASE-3-ACCEPTANCE-REVIEW.md` 中给出。

## 一、端口与领域扩展

- [x] `GitAdapter` 接口新增 `getBlame(query: BlameQuery): Promise<BlameEvidence[]>` 方法
- [x] `BlameQuery` 包含 `repositoryPath`、`path`、可选 `startLine` / `endLine`
- [x] `BlameEvidence` 包含 `commitSha`、`author`、`authoredAt`、`lineRange`、`lineContent`
- [x] 新增类型在 `packages/core/src/index.ts` 导出
- [x] `pnpm --filter @tracepilot/core typecheck` 无类型错误
- [x] `EvidenceRouter` 是纯领域逻辑，不导入 Fastify / Drizzle / Git SDK / Pi SDK
- [x] `EvidenceRouter.route(taskInput)` 对 `origin="failed_test_log"` 输出 code/git/runtime/memory/policy 五类请求
- [x] `EvidenceRouter.route(taskInput)` 对 `origin="issue"` 输出 code/git/memory/policy 四类请求（不含 runtime）
- [x] 同一 `TaskInput` 两次输入 `EvidenceRouter` 输出完全相同（顺序、类别、定位参数一致）
- [x] `TaskOrchestrator.gatherEvidenceAndCreatePack` 在 `GATHERING_EVIDENCE` 状态下生成 Pack v1
- [x] Pack v1 生成在同一 `UnitOfWork` 事务内写 `evidence_pack_versioned` 审计并更新 `task.currentEvidencePackId/Version`
- [x] `TaskOrchestrator.evolvePackWithNewEvidence` 基于上一版本生成 v(n+1)，旧版本保留
- [x] 尝试对同一 `id` + `version` 二次写入抛 `EvidencePackVersionError`
- [x] `TaskOrchestrator.attachWorktree` 在同一事务内写 `task.worktreeId` 与 `worktree_created` 审计
- [x] `TaskOrchestrator.submitEvidenceRequest` 在 `EXECUTING` 状态下迁移到 `EVIDENCE_GAP`，否则保持 `GATHERING_EVIDENCE`
- [x] 新增方法不破坏既有 `transitionTask` / `beginExecutionIfApproved` 的安全边界（EXECUTING 仍只能经 `beginExecutionIfApproved` 进入）
- [x] `pnpm --filter @tracepilot/core test` 覆盖 Pack v1/v(n+1) 事务原子性、不可变、attachWorktree 审计、EvidenceRequest 状态迁移

## 二、真实 GitAdapter 实现

- [x] `LocalGitAdapter` 构造函数注入 `ProcessRunner`、`CommandPolicy`、`PathPolicy`、`ProcessPolicy`、`allowedWorktreeRoots`
- [x] `LocalGitAdapter` 不直接调用 `child_process.spawn`，所有 git 命令经 `ProcessRunner.run`
- [x] 所有 git argv 在调用 `ProcessRunner` 前经 `CommandPolicy.decide` 校验
- [x] 所有 cwd 在调用 `ProcessRunner` 前经 `PathPolicy.decide` 校验
- [x] `validateRepository` 返回 `RepositoryInfo`（含 `repositoryPath` 真实路径、`defaultBranch`、`headCommitSha`、`isClean`）
- [x] `validateRepository` 对非仓库路径抛结构化错误
- [x] `createWorktree` 校验 `taskId` 不含 `..` 或绝对路径片段
- [x] `createWorktree` 目标路径位于受控根目录内（经 `PathPolicy.decide` 校验）
- [x] `createWorktree` 拒绝覆盖已存在目录
- [x] `createWorktree` 拒绝脏仓库（`isClean=false`）
- [x] `getDiff` 用 `node:crypto` 计算 `sha256-<hex>` 哈希
- [x] `getDiff` 空改动返回 `patch=""`、`changedFiles=[]`、`bytes=0`
- [x] `getHistory` 解析为 `GitEvidence[]`，字段齐全（commitSha / author / authoredAt ISO 8601 / message 首行 / files 相对路径）
- [x] `getBlame` 解析为 `BlameEvidence[]`，字段齐全（commitSha / author / authoredAt / lineRange / lineContent）
- [x] `removeRegisteredWorktree` 校验 `worktree.path` 位于受控根目录内
- [x] `removeRegisteredWorktree` 对未登记 worktree 抛错
- [x] `removeRegisteredWorktree` 对受控根目录外路径抛错
- [x] `FakeGitAdapter` 实现 `getBlame`，返回确定性结构
- [x] `FakeGitAdapter` 新增 `setHistory` 测试辅助方法供契约测试注入非空 history
- [x] `packages/adapters/src/index.ts` 导出 `LocalGitAdapter` 与新类型

## 三、解析器

- [x] `parseGitLog` 正确解析多 commit 输出
- [x] `parseGitLog` 对空输出返回空数组
- [x] `parseGitLog` 处理中文文件名
- [x] `parseGitBlame` 按 `--line-porcelain` 格式解析
- [x] `parseGitBlame` 聚合同 commit 连续行为 `lineRange`
- [x] `parseGitDiffChangedFiles` 从 `--name-only` 提取相对路径
- [x] `pnpm --filter @tracepilot/adapters test` 覆盖以上解析场景

## 四、契约测试

- [x] `git-adapter-contract.test.ts` 定义 `runGitAdapterContract(name, factory)` 工厂
- [x] 契约覆盖 `validateRepository` 返回结构
- [x] 契约覆盖 `createWorktree` 返回结构
- [x] 契约覆盖 `getDiff` 返回结构
- [x] 契约覆盖 `getHistory` 返回结构
- [x] 契约覆盖 `getBlame` 返回结构
- [x] 契约覆盖 `removeRegisteredWorktree` 对未登记 worktree 抛错
- [x] 契约覆盖路径穿越拒绝（`taskId="../../etc"`）
- [x] 契约覆盖受控根目录外路径拒绝
- [x] `FakeGitAdapter` 与 `LocalGitAdapter` 通过同一套契约断言

## 五、样例仓库集成测试

- [x] `createPythonSampleRepo` 用真实 `git init` 种出含 `pytest.ini`、`tests/test_sample.py`、`src/sample.py` 的仓库
- [x] `createTypescriptSampleRepo` 用真实 `git init` 种出含 `package.json`、`tsconfig.json`、`src/index.ts` 的仓库
- [x] python 样例仓库全流程：validateRepository → createWorktree → 修改文件 → getDiff → getHistory → getBlame → removeRegisteredWorktree
- [x] typescript 样例仓库全流程同上
- [x] 全流程后 worktree 目录被正确清理
- [x] 测试用真实 `git` 二进制（经 `LocalProcessRunner`），不 mock
- [x] Windows 与 POSIX 路径分隔符差异用 `node:path.join` 处理
- [x] 拒绝非仓库路径
- [x] 拒绝脏仓库创建 worktree
- [x] 拒绝路径穿越
- [x] 拒绝覆盖已存在目录
- [x] 拒绝回收受控根目录外路径

## 六、文档与收尾

- [x] `docs/adr/ADR-002-worktree-and-command-safety.md` 落地，全中文
- [x] ADR-002 记录受控根目录、路径解析、argv 白名单、清理策略
- [x] `LocalCommandAdapter.develop` 注释明确"Phase 3 仍未接 LLM"
- [x] `README.md` 阶段状态更新为"Phase 3 实现已完成，待独立验收"
- [x] `README.md` 新增 Phase 3 验收报告链接与 ADR-002 链接
- [x] `README.md` 测试统计更新（保留 Phase 2 历史基线，未声称 Phase 3 测试通过）
- [x] `docs/reviews/PHASE-3-ACCEPTANCE-REVIEW.md` 骨架创建（仅占位，无结论）

## 七、全仓自测（实现者自检，非验收结论）

- [x] `pnpm install --no-frozen-lockfile` 成功
- [x] `pnpm -r run typecheck` 无错误
- [x] `pnpm -r run lint` 无错误
- [x] `pnpm -r run build` 无错误
- [x] `pnpm -r run test` 全部执行完成（含新增测试，允许保留 Windows symlink 1 跳过）
- [x] 实现者未在任何文档/注释中声称"测试通过"或"验收通过"

> 上述勾选仅代表实现 Agent 已完成自测执行。具体测试计数与通过/失败结论由独立 Reviewer 在 `docs/reviews/PHASE-3-ACCEPTANCE-REVIEW.md` 中独立运行后填写。实现者自测结果不构成验收结论。

## 八、安全边界回归（AGENTS.md 规则 12）

- [x] 未修改 Phase 1 治理边界（CommandPolicy / PathPolicy / ApprovalPolicy / AuditPolicy）的安全语义
- [x] 若发现并修复了 Phase 1 安全漏洞，已记录并准备重新独立复核
- [x] `git push` / `git merge` / `git rebase` / `git reset --hard` / `git clean -f` / `git worktree remove` 仍被默认拒绝或受控执行
- [x] 路径穿越与符号链接逃逸仍被 `PathPolicy` 拒绝
- [x] 审计仍仅追加，敏感值仍只记录变量名

## 九、阶段退出条件（IMPLEMENTATION_SPEC §9 Phase 3）

- [x] 两个样例仓库能安全创建/回收 worktree（python + typescript 各一组集成测试）
- [x] 所有 Pack 证据可回溯来源（每条 `EvidenceItem` 含 `source` / `locator` / `contentHash`）
- [x] Evidence Pack 版本不可变，v(n+1) 经 `EvidenceRequest` 受控流程生成
- [x] `FakeGitAdapter` 与 `LocalGitAdapter` 通过同一契约套件（§6 要求）

> 上述全部勾选仅代表实现 Agent 自测完成。独立 Reviewer 必须重新阅读 spec、tasks、checklist 与代码，独立运行规定命令，并在 `docs/reviews/PHASE-3-ACCEPTANCE-REVIEW.md` 中给出最终结论。
