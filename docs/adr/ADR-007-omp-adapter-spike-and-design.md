# ADR-007：OmpAdapter Spike 结果与设计决策

- **状态：** 已接受（Phase 4 实现中，真实闭环与 P1-R01 待独立验收）
- **日期：** 2026-07-27
- **阶段：** Phase 4（真实修复闭环）—— 实现者自测已跑通两个真实失败任务，但未经独立 Reviewer 授权复验；P1-R01 执行期逐路径隔离方案已落地（受控文件工具代理），待独立验收
- **取代：** ADR-001 中 `OmpAdapter` stub 部分
- **被取代：** 暂无

> **重要修正（2026-07-30，对应 PHASE-4-ACCEPTANCE-REVIEW §18.3 P1-R01 关闭方案）：**
>
> 1. 本 ADR 早期版本中 `--auto-approve` 被标为"非交互模式必需"，
>    且 `--cwd` 被描述为"足以锁定受控 worktree"。当前 `OmpAdapter`
>    **明确拒绝** `--auto-approve` / `--approval-mode=yolo`，改用
>    `--approval-mode=write`。`--cwd` 仅锁定工作目录，不构成工具级
>    逐路径 `Plan.allowedPaths` 隔离。
> 2. **P1-R01 关闭方案（2026-07-30 落地，待独立验收）：** omp develop
>    阶段改为 `--tools read,grep,glob`（只读，无 edit/write/bash），
>    omp 没有任何写入能力。所有文件修改通过 `<file_change>` XML
>    指令输出，由 `ControlledFileWriter` 代为写入并在**写入前同步**
>    校验路径（allowedPaths glob 匹配 + 受保护路径检查 + 路径穿越
>    检查 + 符号链接逃逸检查）。这是"同步、操作前、逐路径"的强制
>    边界（§18.3 要求），从源头杜绝越权写入。原四层防御
>    （`applyExecutionIsolation` + `watchForSymlinkEscapes` +
>    `enforceFilesystemScope` + `rollback`）退为恢复层，作为纵深
>    防御保留，不再是 P1-R01 的主边界。
> 3. 下表"真实任务闭环 ✅ 已验证"仅为实现者自测，**不能替代独立验收**。
>    Phase 4 真实闭环尚待未参与实现的 Reviewer 在用户明确授权下执行
>    `pnpm test:omp-real` 的两个真实任务（见验收报告 §18.3）。

## 实现状态（2026-07-30 更新）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Spike（omp 安装与 CLI 拓扑验证） | ✅ 已完成 | omp v17.1.5 安装成功，CLI 参数与 worktree 约束已验证 |
| `OmpAdapter` 代码框架 | ✅ 已落地 | `packages/adapters/src/omp-adapter.ts` 实现 `analyze`/`develop`/`review`/`cancel`，含 prompt 构造、NDJSON 解析、ReviewResult 容错提取、`validateOmpArgv` 等价 CommandPolicy |
| 受控 argv 拓扑 | ✅ 已落地 | 固定使用 `--approval-mode=write`（非 yolo/`--auto-approve`）+ `--no-session` + `--no-extensions` + `--no-skills` + `--no-rules`；`validateOmpArgv` 将三者列为必需项，缺失任一抛 `missing-no-auto-discovery-flag` |
| **受控文件工具代理（P1-R01 §18.3 关闭方案）** | ✅ 已落地（待独立验收） | **omp develop 阶段使用 `--tools read,grep,glob`（只读，无 edit/write/bash/browser）。** omp 没有任何写入能力，所有文件修改通过 `<file_change>` XML 指令输出，由 `ControlledFileWriter` 代为写入并在**写入前同步**校验路径：(1) `isProtectedPath` 拒绝 `.git` 等受保护路径；(2) `resolve`+`relative` 规范化路径，捕获 `..` 穿越、绝对路径、跨盘符逃逸；(3) `findPathScopeViolations` 校验 allowedPaths glob 匹配；(4) `lstatSync`+`readlinkSync`+`isSymlinkTargetOutsideWorktree` 检查符号链接逃逸。任一文件越界立即抛 `PathScopeViolationError`，不写入任何文件（原子性）。**实现者自测**：17 个真实文件系统对抗性测试覆盖合法写入、`..` 穿越、绝对路径、`.git` 受保护、符号链接逃逸、原子性、父目录自动创建、端到端模拟 omp develop（含合法与越权）。`validateOmpArgv` 同时拒绝 `--tools` 包含 `bash/edit/write/browser` 等任何写入工具。 |
| 执行期路径隔离（P1-R01 恢复层） | ✅ 已落地（恢复层） | 四层防御现为**恢复层**：(1) `applyExecutionIsolation` 将非 allowedPaths 文件设只读 + 符号链接逃逸检测 + 失败关闭；(2) `watchForSymlinkEscapes` 用 `fs.watch` 递归监听 worktree，近实时检测新增符号链接逃逸并 abort Runtime；(3) `enforceFilesystemScope` 在 Runtime 结束后检测新增/改指向的符号链接目标是否逃逸；(4) `rollback` 回滚越界变更。**主边界为受控文件工具代理**（见上行），omp 无写入能力，恢复层仅作为纵深防御与异常情况下的兜底。 |
| 单元测试 | ✅ 已通过 | OmpAdapter 测试（71 个）+ `local-controlled-file-writer` 测试（17 个）+ smoke 测试 + `--no-*` 契约测试 + `applyExecutionIsolation` 直接单元测试全部通过 |
| 组合根受控装配 | ✅ 已落地 | `apps/api/src/composition-root.ts` 通过 `TRACEPILOT_OMP_PATH` 与 `TRACEPILOT_OMP_MODEL` 环境变量受控切换 OmpAdapter 与 LocalCommandAdapter 降级模式；OmpAdapter 装配时注入 `LocalControlledFileWriter`；`.env` 文件自动加载（Node 22+ `process.loadEnvFile`，零依赖） |
| LLM 提供商连通性 | ✅ 已验证（实现者自测） | DeepSeek `deepseek-v4-flash` 经 `DEEPSEEK_API_KEY` 环境变量连通验证通过；白名单透传 `DEEPSEEK_API_KEY` 等凭据给 omp 子进程 |
| `.env` 配置支持 | ✅ 已落地 | `ProcessPolicy.allowedEnvVarNames` 白名单字段 + `LocalProcessRunner.buildChildEnv` 按白名单透传 + `.env.example` 模板 + `skipEnvFile` 测试选项 |
| 真实任务闭环 | ⚠️ 实现者自测通过，待独立验收 | 实现者自测：两个真实失败任务由 OmpAdapter + DeepSeek 完成 develop→verify→review。**此为实现者自测，不能替代独立验收。** 尚待未参与实现的 Reviewer 在用户授权下执行 `pnpm test:omp-real` |
| ADR-008（事件协议修订） | ✅ 不需要 | 真实 `--mode json` 事件结构已验证：`session`/`message_update`(含 `thinking_end`/`toolcall_end` 子类型)/`tool_execution_start`/`tool_execution_end`/`turn_end`(isTerminal) 等。`parseOmpNdjsonEvents` 与 `mapOmpObjectToRuntimeEvent` 已按真实事件类型实现，单元测试已同步更新。无需新增 ADR-008 |

## 背景

ADR-001 在 Phase 0 因 `omp` 未安装而落地 `LocalCommandAdapter` 作为 MVP 降级 Runtime，
并保留 `OmpAdapter` stub（每次调用抛 `OmpUnavailableError`）。ADR-001 明确要求 Phase 4
再次尝试真实 `OmpAdapter` Spike，若仍失败则需新增 ADR 重新界定发布范围。

Phase 4 进入后，本次 Spike 已成功安装 `omp v17.1.5` 并验证其非交互调用方式、CLI 参数
拓扑与 worktree 约束可行性。本 ADR 记录 Spike 结论与 `OmpAdapter` 设计决策。

## Spike 结果（2026-07-27）

### 环境

| 检查项 | 结果 |
| --- | --- |
| `omp` 安装方式 | Windows PowerShell `irm https://omp.sh/install.ps1 \| iex` |
| `omp` 版本 | `omp/17.1.5` |
| 安装路径 | `C:\Users\EDY\AppData\Local\omp\omp.exe` |
| `bun` 前置依赖 | 未单独安装；PowerShell 安装脚本下载预编译二进制，无需 bun |
| Node / pnpm / git | `node v24.18.0`、`pnpm v11.16.0`、`git 2.55.0.windows.2` |

### omp CLI 拓扑（与非交互调用相关的关键发现）

`omp` 是**统一 prompt 驱动的 coding agent**，没有专门的 `analyze` / `develop` / `review`
子命令。TracePilot 的 `RuntimeAdapter.analyze / develop / review` 通过不同的 prompt +
共享的 CLI 参数实现。

关键 CLI 参数：

| 参数 | 用途 | TracePilot 映射 |
| --- | --- | --- |
| `-p` / `--print` | 非交互模式：处理 prompt 后退出 | `analyze` / `develop` / `review` 必须使用 |
| `--mode json` | JSON 输出模式（流式事件） | `RuntimeEvent` 转换源 |
| `--cwd=<path>` | 指定工作目录 | worktree 约束（受控根目录）。**注意：`--cwd` 仅锁定工作目录，不构成工具级逐路径 `Plan.allowedPaths` 隔离。** 执行期路径隔离由 `applyExecutionIsolation` + 快照检测 + 回滚恢复组成 |
| `--approval-mode=write` | 工作区写入审批模式 | **当前使用**。允许 omp 编辑工作区内文件，但不等价于逐路径白名单 |
| `--auto-approve` | 自动批准所有工具调用 | **已拒绝**。`validateOmpArgv` 拒绝包含此参数的 argv |
| `--approval-mode=yolo` | 等价于 `--auto-approve` | **已拒绝**。`validateOmpArgv` 拒绝 yolo 模式 |
| `--no-session` | 不保存会话（ephemeral） | 任务隔离 |
| `--no-extensions` | 禁用自动发现的扩展 | **P1-R01 必需**。防止项目/用户环境中的扩展引入额外工具绕过 `--tools` 限制 |
| `--no-skills` | 禁用自动发现的技能 | **P1-R01 必需**。同上 |
| `--no-rules` | 禁用自动发现的规则 | **P1-R01 必需**。同上 |
| `--max-time=<duration>` | 超时控制（如 `600`、`10m`、`1h`） | `ProcessPolicy.timeoutMs` |
| `--model=<name>` | 指定 LLM 模型 | 由项目配置注入 |
| `--no-tools` | 禁用所有内置工具 | 纯分析模式（可选） |
| `--add-dir=<path>` | 添加额外工作区目录 | 只读引用其他目录 |
| `--no-lsp` | 禁用 LSP | 降级模式 |
| `--config=<path>` | 加载额外配置覆盖 | 项目级配置 |

### worktree 约束

`omp` 没有等价于 TracePilot「已登记 worktree」的内建概念。`--cwd` 参数将 agent
的工作目录锁定到 TracePilot 创建的受控 worktree 路径，**但仅锁定工作目录，不构成
工具级逐路径 `Plan.allowedPaths` 隔离**。结合 `--add-dir` 可允许只读引用项目仓库
根（用于跨目录搜索）。

**P1-R01 主边界（受控文件工具代理，2026-07-30 落地）：** omp develop 阶段使用
`--tools read,grep,glob`（只读，无 edit/write/bash/browser）。omp 没有任何写入
能力，所有文件修改通过 `<file_change>` XML 指令输出，由 `ControlledFileWriter`
代为写入并在**写入前同步**校验路径（§18.3 要求"同步、操作前、逐路径"）：

1. `isProtectedPath` 拒绝 `.git` 等受保护路径；
2. `resolve`+`relative` 规范化路径，捕获 `..` 穿越、绝对路径、跨盘符逃逸；
3. `findPathScopeViolations` 校验 allowedPaths glob 匹配；
4. `lstatSync`+`readlinkSync`+`isSymlinkTargetOutsideWorktree` 检查符号链接逃逸。

任一文件越界立即抛 `PathScopeViolationError`，不写入任何文件（原子性：全部通过
才写入，任一失败全部不写）。omp 无写入能力，所有写入都经此校验，从源头杜绝越权。

恢复层（纵深防御，非主边界）：
1. **执行期隔离**（`applyExecutionIsolation`）：将非 allowedPaths 文件设只读 +
   符号链接逃逸检测 + 失败关闭
2. **运行期监听**（`watchForSymlinkEscapes`）：`fs.watch` 递归监听 worktree，
   近实时检测新增符号链接逃逸并 abort Runtime
3. **快照检测**（`createSnapshot` + `detectChanges`）：Runtime 结束后对比前后快照
4. **回滚恢复**（`rollback`）：将越界变更恢复到快照状态

**Windows 平台限制**：Windows 目录 read-only 不阻止文件创建。但主边界
（受控文件工具代理）独立于 OS 文件权限——omp 无写入能力，所有写入经
`ControlledFileWriter` 同步校验，与 OS 文件权限无关。恢复层在异常情况
（如 omp 通过未发现的扩展能力绕过 `--tools`）下作为兜底。

`omp worktree` 子命令是管理 omp 自己的 `~/.omp/wt` worktree，与 TracePilot 的
受控 worktree 无关，不使用。

### analyze / develop / review 的 prompt 驱动实现

`omp` 没有专门的 `/analyze`、`/develop`、`/review` 子命令。TracePilot 通过构造
结构化 prompt 实现 `RuntimeAdapter` 三个方法：

- **`analyze`**：prompt 要求 omp 在 worktree 中运行测试、读取失败堆栈、收集证据，
  但不修改文件（可配合 `--no-tools` 限制为只读，或通过 prompt 指令约束）。
- **`develop`**：prompt 要求 omp 修复指定失败，明确约束 `allowedPaths` 与命令白名单，
  修改完成后运行验证命令。
- **`review`**：prompt 要求 omp 基于给定的 diff + 验证结果输出结构化 JSON 裁决
  （P0-P3 findings、verdict、summary）。

### 流式事件协议

`--mode json` 输出流式 JSON 事件（每行一个 JSON 对象，NDJSON 格式）。
具体事件类型与字段需在 API key 配置后实际跑通验证（见 §待解决问题）。

### 取消信号

`omp` 作为子进程运行时，`SIGINT`（Windows 下等价于 `taskkill /PID`）可终止进程。
`RuntimeAdapter.cancel(runId)` 通过 `AbortController` 或 `ChildProcess.kill()` 实现。

## 决策

1. **`OmpAdapter` 为 Phase 4 默认 Runtime。** 替换 ADR-001 中的 stub，实现真实的
   `analyze` / `develop` / `review` / `cancel`。`LocalCommandAdapter` 降级为测试与
   Spike 用途（ADR-001 第 3 条保留有效）。

2. **调用方式：`omp -p --mode json --cwd <worktree> --approval-mode=write --no-session --no-extensions --no-skills --no-rules --max-time <ms> "<prompt>"`。**
   - `--mode json` 输出 NDJSON 事件流，`OmpAdapter` 解析并转换为 `RuntimeEvent`；
   - `--cwd` 锁定工作目录到受控 worktree（**不构成工具级路径隔离**）；
   - `--approval-mode=write` 允许工作区写入（**拒绝 yolo/`--auto-approve`**）；
   - `--no-extensions` + `--no-skills` + `--no-rules` 禁用自动发现能力（P1-R01 必需）；
   - `--no-session` 保证无状态；
   - `--max-time` 由 `ProcessPolicy.timeoutMs` 注入。

3. **`RuntimeAdapter` 接口保持不变。** `OmpAdapter` 实现 `packages/core/src/ports/adapters.ts`
   中的 `RuntimeAdapter`，与 `LocalCommandAdapter` / `FakeRuntimeAdapter` 共享同一契约测试。

4. **安全边界不变。** `OmpAdapter` 发起的所有 omp 调用必须经 `ProcessRunner` +
   `CommandPolicy` + `PathPolicy` 治理，与 `LocalCommandAdapter` 一致。omp 的
   `--cwd` 参数值必须经 `PathPolicy` 校验位于受控 worktree 根目录内。

5. **prompt 模板在 `OmpAdapter` 内部管理。** `analyze` / `develop` / `review` 的
   prompt 构造逻辑封装在 `OmpAdapter` 私有方法中，不暴露给调用方。prompt 必须包含：
   - 任务目标、约束、验收标准（来自 `TaskInput`）；
   - `allowedPaths` 白名单（来自 Plan）；
   - 命令白名单（来自 `ProjectCommands`）；
   - 失败堆栈（来自 `TaskInput.failure`）。

6. **`review` 输出结构化 JSON。** prompt 要求 omp 输出符合 `ReviewResult` 接口的
   JSON（`verdict` + `findings[]` + `summary`），`OmpAdapter.review` 解析 omp 的
   文本输出提取 JSON。

## 待解决问题（实现者自测，待独立验收）

以下问题在实现者自测中已验证，但 Phase 4 真实闭环尚待独立 Reviewer 授权复验（见 `docs/reviews/PHASE-4-ACCEPTANCE-REVIEW.md`）：

1. ✅ `--mode json` 的具体事件类型与字段结构已确认：`session`、`agent_start`、
   `turn_start`/`turn_end`(含 `isTerminal`)、`message_start`/`message_end`、
   `message_update`(含 `assistantMessageEvent.type` = `thinking_end`/`toolcall_end`/
   `thinking_start`/`thinking_delta`/`toolcall_start`/`toolcall_delta`)、
   `tool_execution_start`/`tool_execution_end`、`error`/`failed`。
   `mapOmpObjectToRuntimeEvent` 已按真实事件类型映射，高频噪声事件（`turn_start`、
   `message_start`/`message_end`、`thinking_delta` 等）静默跳过。

2. ✅ `develop` 完成后检测文件修改：`ExecutionOrchestrator.runDevelop` 在 omp
   退出后调用 `WorktreeManager.captureDiffForTask` 获取 DiffArtifact，验证
   `changedFiles` 包含预期文件（`src/users.py` / `src/users.js`）。

3. ✅ `review` JSON 输出可靠性：`extractReviewResult` 三级容错（整段解析 →
   平衡花括号子串 → 启发式回退）在真实输出中有效。omp + DeepSeek 在两个
   任务上均返回有效裁决（`ship` / `ship_with_fixes` / `block` 之一）。

4. ⏳ omp 的 token 消耗与成本：尚未在基准任务上测量，后续可按需收集。

5. ✅ omp 在 Windows 下的 `--cwd` 路径格式：反斜杠路径正常工作
   （`C:\Users\...\worktrees\...`）。

## 影响

- **正面影响：** `OmpAdapter` 与 `LocalCommandAdapter` 共享 `RuntimeAdapter` 契约，
  替换成本为零；omp 的 LSP/DAP 能力为后续 Phase 7 运行时调试证据提供基础。
  实现者自测已跑通两个真实失败任务闭环（Python + JavaScript），**但此为实现者
  自测，不等于 Phase 4 验收通过**——尚待未参与实现的 Reviewer 在用户授权下执行
  `pnpm test:omp-real` 的独立复验。
- **负面影响：** `OmpAdapter` 依赖外部 LLM API key，本地无网络时不可用；omp 的
  `--mode json` 输出格式未官方文档化，可能随版本变化（已通过容错解析缓解）；
  prompt 驱动的 `review` 输出不保证结构化 JSON，需容错解析（已通过三级容错缓解）。
- **P1-R01 状态（2026-07-30 落地，待独立验收）：** omp develop 阶段使用
  `--tools read,grep,glob`（只读，无 edit/write/bash），所有文件修改通过
  `<file_change>` XML 指令输出，由 `ControlledFileWriter` 代为写入并在写入前
  同步校验路径（allowedPaths glob 匹配 + 受保护路径检查 + 路径穿越检查 + 符号链接
  逃逸检查）。这是"同步、操作前、逐路径"的强制边界（§18.3 要求），omp 无写入
  能力，从源头杜绝越权写入。原四层防御（`applyExecutionIsolation` +
  `watchForSymlinkEscapes` + `enforceFilesystemScope` + `rollback`）退为恢复层，
  作为纵深防御保留。**实现者自测通过**（17 个真实文件系统对抗性测试 + 71 个
  OmpAdapter 单元测试），但 Phase 4 整体验收仍待独立 Reviewer 复验。
- **后续动作：** Phase 4 真实闭环待独立 Reviewer 授权复验（见
  `docs/reviews/PHASE-4-ACCEPTANCE-REVIEW.md` §18.3），无需新增 ADR-008。
  后续可按需收集 omp 的 token 消耗与成本数据，并在 omp 版本升级时回归验证
  事件协议与 `<file_change>` XML 输出格式。
