# ADR-002：Worktree 受控根目录与命令安全

- **状态：** 已接受
- **日期：** 2026-07-27
- **阶段：** Phase 3（Git 与证据）
- **关联规格：** IMPLEMENTATION_SPEC §7.1、§7.2、§11
- **取代：** 无
- **被取代：** 暂无

## 背景

Phase 3 把 `GitAdapter` 从内存 Fake 替换为基于本地 `git` 二进制的 `LocalGitAdapter`，并落地外置 worktree 的创建/回收、Diff 获取、历史与 blame 解析。这意味着 TracePilot 首次在用户磁盘上**真实创建目录、执行 `git worktree add`、删除目录**——这跨越了 Phase 1/2 仅在内存或 SQLite 中操作的安全边界。

`docs/IMPLEMENTATION_SPEC.md` §7.1 要求：

- worktree 必须创建在受控根目录内；
- 路径必须经 `realpath` 解析并校验位于受控根目录之内；
- 拒绝路径穿越（`..`）和符号链接逃逸；
- 不得在用户代码仓库内直接修改，必须使用已登记的外置 worktree。

§7.2 要求所有命令经 `CommandPolicy` 与 `PathPolicy` 校验，argv 是固定白名单，禁止由 issue 文本、日志或模型输出拼接而来。

如果没有一份 ADR 把"受控根目录在哪、谁可以创建/删除、argv 白名单如何收紧、清理策略是什么"明确写下来，后续 AI 或开发者可能会：

1. 把 worktree 创建到 `%LOCALAPPDATA%/TracePilot/worktrees/` 之外，绕过受控根目录；
2. 在 `LocalGitAdapter` 之外另起 `child_process.spawn` 调用 git，绕过 `ProcessRunner` 治理；
3. 误用 `git worktree remove --force` 删除未登记或非终态任务的 worktree，丢失未提交改动；
4. 误把 `git worktree add` 的执行审批语义（`AWAITING_EXECUTION_APPROVAL` 状态）与 `LocalGitAdapter` 内部的受控调用混为一谈。

本 ADR 明确上述边界，作为 `LocalGitAdapter`、`WorktreeManager`（Phase 4+）与未来 `OmpAdapter` 的共同约束。

## 决策

### 1. 受控根目录

- **唯一受控根目录**：`%LOCALAPPDATA%/TracePilot/worktrees/`
  - 非 Windows 兜底：`~/.local/share/TracePilot/worktrees/`（测试 / WSL）
- **子目录布局**：`<worktree-root>/<project-slug>/<task-id>/`
  - `project-slug` 由 `projectId` 经 `replace(/[^a-zA-Z0-9]/g, "-")` 派生，确保跨平台目录名安全；
  - `task-id` 必须不含 `..` 且不是绝对路径，否则在 `createWorktree` 入口直接抛错；
  - 完整路径在调用 `git worktree add` 前必须经 `PathPolicy.decide` 校验位于 `allowedWorktreeRoots` 之内。
- `LocalGitAdapter` 构造时通过 `allowedWorktreeRoots: readonly string[]` 注入受控根目录列表，取 `allowedWorktreeRoots[0]` 作为 `createWorktree` 的根。测试中可注入临时目录，生产环境必须只注入上述唯一受控根目录。

### 2. 路径解析规则

- **创建 worktree**：
  1. 校验 `taskId` 不含 `..` 且不是绝对路径（`path.isAbsolute`）；
  2. 计算 `targetPath = join(worktreeRoot, projectSlug, taskId)`；
  3. 调用 `PathPolicy.decide(targetPath, allowedWorktreeRoots)`，拒绝则抛 `PolicyDeniedError`；
  4. 校验 `targetPath` 不存在（`existsSync`），拒绝覆盖已存在目录；
  5. 校验源仓库 `isClean=true`，拒绝脏仓库创建 worktree；
  6. 执行 `git worktree add <targetPath> -b tp/<taskId> <baseBranch>`。
- **回收 worktree**：
  1. 调用 `PathPolicy.decide(worktree.path, allowedWorktreeRoots)`，拒绝则抛 `PolicyDeniedError`；
  2. 通过 `git rev-parse --git-common-dir` 解析源仓库根路径（worktree 自身目录不是 git 仓库，直接 cwd 会报错）；
  3. 在源仓库上下文执行 `git worktree remove <path>`，失败时尝试 `--force` 并记录审计；
  4. 不删除数据库登记记录，由调用方在 `UnitOfWork` 事务内 `tx.worktrees.delete`。
- **realpath 校验**：`PathPolicy` 内部使用 `realpathSync` 解析符号链接，确保 worktree.path 经解析后仍位于受控根目录之内。若目标路径尚不存在（例如 `createWorktree` 的 `targetPath`），`PathPolicy` 使用 `realpathSafe` 向上回溯到最近的现存祖先并解析。

### 3. 命令 argv 白名单

`LocalGitAdapter` 的所有 git 命令必须经注入的 `ProcessRunner.run` 执行，禁止直接 `child_process.spawn`。argv 在调用 `ProcessRunner` 前由 `CommandPolicy.decide(argv, projectCommands)` 校验，分类如下：

| git 子命令 | CommandPolicy 分类 | 谁可以执行 |
| --- | --- | --- |
| `git rev-parse` / `git status` / `git log` / `git diff` / `git blame` / `git show` | `auto_allowed`（只读） | `LocalGitAdapter` 直接执行 |
| `git worktree add` | `needs_execution_approval` | `LocalGitAdapter` 作为受控 Manager 直接执行；执行审批由 `TaskOrchestrator` 在 `AWAITING_EXECUTION_APPROVAL` 状态下处理 |
| `git worktree remove` / `git worktree remove --force` | 默认拒绝（删除性操作） | **仅** `LocalGitAdapter.removeRegisteredWorktree` 在 `PathPolicy` 校验通过后直接调用 `ProcessRunner.run`，**不**经 `CommandPolicy`；这是 ADR-002 的受控清理策略 |
| `git worktree prune` / `git worktree lock` / `git worktree move` | 默认拒绝 | 任何调用方均不得执行 |
| `git push` / `git merge` / `git rebase` / `git reset --hard` / `git clean -f` / `git config` / `git credential` | 默认拒绝（§7.2 危险命令） | 任何调用方均不得执行；P1-R04 已防御全局选项绕过 |

> **关于 `git worktree remove` 的特殊处理**：`CommandPolicy` 对所有 `git worktree remove` 形式默认拒绝，这是为了防止未受控调用方（例如未来 `OmpAdapter` 的 LLM 输出）通过白名单或全局选项绕过删除保护。`LocalGitAdapter.removeRegisteredWorktree` 作为**受控 Manager**，在完成 `PathPolicy` 校验后**直接**调用 `ProcessRunner.run`，不经过 `CommandPolicy`。这一豁免仅限 `LocalGitAdapter.removeRegisteredWorktree`，任何其他调用方仍受 `CommandPolicy` 默认拒绝约束。

### 4. 执行审批语义

`git worktree add` 被归类为 `needs_execution_approval`，但**实际审批由 `TaskOrchestrator` 在任务状态机层面处理**，与 `LocalGitAdapter` 内部的 `runGoverned` 解耦：

- `TaskOrchestrator.attachWorktree` 在 `UnitOfWork` 事务内把已登记的 `worktree.id` 写到 `task.worktreeId`；
- 任务进入 `EXECUTING` 状态前必须经过 `AWAITING_EXECUTION_APPROVAL`，由 `ApprovalPolicy` 决定是否需要人工审批（见 §7.2 风险表）；
- `LocalGitAdapter.createWorktree` 本身不检查 `ApprovalRecord`——它只负责在 `PathPolicy` 与 `CommandPolicy` 校验通过后执行 `git worktree add`，调用方（通常是 `TaskOrchestrator` 或上层服务）负责确保审批已记录。

### 5. 清理策略

`removeRegisteredWorktree` 仅在**同时满足以下三个条件**时执行删除：

1. **路径在受控根目录内**：`worktree.path` 经 `PathPolicy.decide` 校验位于 `allowedWorktreeRoots` 之内；
2. **已在数据库登记**：调用方传入的 `Worktree` 对象应来自 `WorktreeRepository.findById`，未登记的 worktree 抛错；
3. **任务已终态或显式回收**：调用方负责确认任务处于 `COMPLETED` / `FAILED` / `CANCELLED` / `INTERRUPTED` 等终态，或调用方有明确的回收理由（例如 worktree 创建失败后的清理）。

`LocalGitAdapter.removeRegisteredWorktree` 不主动检查任务状态——这是上层 `WorktreeManager`（Phase 4+）的职责。当前 Phase 3 的调用方是测试与未来 `TaskOrchestrator` 的清理路径，二者都已确保只在终态或失败回滚时调用。

### 6. 与 Phase 1 治理边界的关系

本 ADR 不修改 Phase 1 已通过的 `CommandPolicy` / `PathPolicy` / `ApprovalPolicy` / `AuditPolicy` 安全语义（见 `AGENTS.md` 规则 12）：

- `CommandPolicy` 的危险命令默认拒绝列表（`git push` / `git merge` / `git rebase` / `git reset --hard` / `git clean -f` / `git config` / `git credential` / `git worktree remove` / `git worktree prune`）保持不变；
- `PathPolicy` 的 `realpath` 解析与符号链接逃逸防御保持不变；
- `ApprovalPolicy` 的风险表与审批闸门保持不变；
- `AuditPolicy` 的仅追加与脱敏规则保持不变。

`LocalGitAdapter.removeRegisteredWorktree` 对 `git worktree remove` 的受控豁免是 Phase 3 新增的清理路径，已在本 ADR 第 3 节明确记录。若未来需要让 `OmpAdapter` 或其他调用方执行 `git worktree remove`，必须先经独立 Reviewer 重新评审本 ADR。

## 实现位置

| 组件 | 文件 |
| --- | --- |
| `LocalGitAdapter`（worktree 创建/回收/Diff/历史/blame） | `packages/adapters/src/local-git-adapter.ts` |
| `PathPolicy`（受控根目录与 realpath 校验） | `packages/governance/src/path-policy.ts` |
| `CommandPolicy`（git argv 白名单与危险命令默认拒绝） | `packages/governance/src/command-policy.ts` |
| `TaskOrchestrator.attachWorktree`（事务内登记 worktree） | `packages/core/src/services/task-orchestrator.ts` |
| 契约测试（Fake 与 Local 共用同一断言） | `packages/adapters/tests/git-adapter-contract.test.ts` |
| 样例仓库集成测试（python + typescript 全流程） | `packages/adapters/tests/local-git-adapter.test.ts` |
| 样例仓库夹具（真实 `git init` 种出最小仓库） | `packages/adapters/tests/fixtures/sample-repos.ts` |

## 后果

- **正面**：
  - worktree 创建/回收被收敛到唯一受控根目录与唯一受控 Manager，未受控调用方无法绕过；
  - `git worktree remove` 的 `CommandPolicy` 默认拒绝 + `LocalGitAdapter` 受控豁免，既保护了未受控路径，又允许测试与上层服务完成清理；
  - 契约测试确保 `FakeGitAdapter` 与 `LocalGitAdapter` 行为一致，Phase 4+ 替换时不引入回归。
- **负面**：
  - `LocalGitAdapter.removeRegisteredWorktree` 对 `CommandPolicy` 的豁免是一个有意识的边界破口，必须由本 ADR 明确记录并由独立 Reviewer 评审；
  - `git worktree remove --force` 在普通 remove 失败时作为兜底，可能丢失未提交改动——本 ADR 第 5 节的清理策略要求调用方确保任务已终态，缓解但未完全消除该风险。
- **后续**：
  - Phase 4 引入真实 `OmpAdapter` 时，必须复用 `LocalGitAdapter` 的 worktree 创建/回收路径，不得另行绕过；
  - Phase 5+ 若需要并发任务，必须重新评审受控根目录的隔离策略（例如每个任务一个独立 `project-slug/task-id` 子目录）；
  - 若未来需要支持 worktree 跨磁盘或跨卷创建，必须扩展 `allowedWorktreeRoots` 并补充 realpath 跨卷解析测试。
