# Phase 4 验收评审报告

> 独立复核日期：2026-08-03  
> 评审范围：Phase 4「真实修复闭环」  
> 最终验收结论：**通过**  
> 后续 AI：Phase 4 的 P1 已全部关闭，可进入 Phase 5；后续修改不得回退本报告第 21 节签发的命令、路径、审批、凭据、Diff 来源、取消和受控写入边界。

## 0. 最终独立复核结论

本报告由用户正式指定的最终独立 Reviewer 签发。验收依据为 `docs/IMPLEMENTATION_SPEC.md` §3、§6、§7、§8、§9 Phase 4、§10、§12，`AGENTS.md` 规则 2、3、5、9、11、14、16、17，以及当前源码、对抗性测试和真实 Omp 运行结果。

本报告第 1 至 20 节保留了历次“不通过”、问题关闭和实现侧自测记录，作为不可删除的验收审计历史；其中较早章节的“当前有效结论”只代表对应复核时点。**自 2026-08-03 起，以本节和第 21 节为最新有效结论。**

最终复核确认：Omp develop 已移除直接写入与 shell 工具，文件变更由 `LocalControlledFileWriter` 在操作前按登记 worktree、真实路径与 `Plan.allowedPaths` 强制校验；命令、审批、凭据隔离、服务端 Diff/验证来源、取消线性化和审计边界均有对抗性测试覆盖。普通测试不会隐式调用外部模型，受保护命令在前置条件不足时失败关闭。

独立 Reviewer 已在用户明确授权合成测试仓库外发和模型费用后运行两个真实 Omp + DeepSeek 失败任务。Python 与 JavaScript 场景均完成初始失败确认、analyze、受控 worktree 修改、验证通过、Diff 采集和 review。**Phase 4 全部退出条件已满足，正式验收通过。**

## 1. P1：必须关闭后才能通过

### P1-01：Omp 内部工具调用可绕过命令、路径与高风险操作治理

**位置：** `packages/adapters/src/omp-adapter.ts` 的 `buildOmpArgv`、`runOmpGoverned`、`buildAnalyzePrompt`、`buildDevelopPrompt`；`apps/api/src/composition-root.ts` 的 OmpAdapter 装配。

实现只验证“启动 `omp` 这条父进程 argv”是否固定、`--cwd` 是否位于受控根目录；随后固定传入 `--auto-approve`。实际读写、shell、测试、网络、删除或凭据读取由 Omp 子进程内置工具执行，未经过 TracePilot 的 `CommandPolicy`、`PathPolicy` 或逐次审批。`allowedPaths` 和命令白名单只出现在 prompt 中，不能作为不可绕过的安全边界。

`TaskInput.rawSource`、Issue 内容和失败日志也会直接进入 prompt。恶意输入可以要求 Agent 忽略指令、读取环境变量、访问 worktree 外路径或执行白名单外命令；在 `--auto-approve` 下不存在核心层的拦截点。该问题同时违反规格 §7.2、§12.4 与 `AGENTS.md` 规则 5、9。

**修复要求：**

1. 在真实工具调用层建立可强制的隔离：优先使用 Omp 已验证的工具权限/沙盒配置；若 Omp 不能为 shell、文件写入、网络和环境变量提供可审计的强制策略，则必须使用受控工具代理或操作系统级隔离，不能以 prompt 替代策略。
2. 强制所有文件写入仅落在登记 worktree 的 `allowedPaths` 内；命令仅允许项目登记的完整 `argv`；删除、安装、网络、数据库迁移、凭据读取和 worktree 外访问默认拒绝并记录 `policy_denied`。
3. 新增真实对抗性测试：在 `rawSource`/Issue 中注入越权指令，分别尝试白名单外命令、worktree 外文件、网络与环境变量读取；测试必须证明副作用未发生且审计可追溯。
4. 未具备上述强制能力前，不得以 `--auto-approve` 启用真实 Omp 开发模式，也不得宣称治理链路“不可绕过”。

### P1-02：验证命令全量继承环境变量，Agent 可通过修改 worktree 泄漏 LLM 凭据

**位置：** `apps/api/src/composition-root.ts` 的 `verificationProcessPolicy`（约第 226–236 行），`packages/adapters/src/local-process-runner.ts` 的 `buildChildEnv`。

`verificationProcessPolicy.inheritEnv` 被设为 `true`。`LocalProcessRunner` 在该分支返回完整 `process.env`，其中包括 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY` 等由 Omp 配置加载的凭据。Developer 已能修改登记 worktree；随后执行项目 `test` 命令时，恶意测试、`package.json` script、Python conftest 或子进程都可以读取并外传这些凭据。代码注释声称验证命令“不含 LLM 凭据，安全”，与实际实现相反。

这直接违反规格 §7.2 中“凭据读取默认禁止”和 §7.3 的敏感信息保护，也使 P1-01 的影响扩大。

**修复要求：**

1. 验证策略必须使用最小环境，禁止 `inheritEnv=true`；只按名称白名单传递运行测试必需的非敏感变量，并显式排除所有 API key、token、代理认证和本机凭据变量。
2. 必要的运行时路径（例如 `PATH`、Windows 系统目录或临时目录）应作为受控基础环境单独构造，不得通过全量继承获得。
3. 新增集成测试：设置凭据哨兵值，并在 worktree 的测试脚本中尝试读取；验证子进程必须读不到哨兵值。还应断言命令审计、Runtime 事件和错误输出不含凭据值。

### P1-03：Review 接受客户端提交的 Diff 与验证结果，独立审查可被伪造输入污染

**位置：** `apps/api/src/composition-root.ts` 的 `POST /tasks/:taskId/run` review 分支（约第 750–772 行），`packages/core/src/services/execution-orchestrator.ts` 的 `runReview`。

review API 要求调用方在 body 中提交 `diff` 和 `verificationResult`，并将其直接传给 `ExecutionOrchestrator.runReview`。该服务也接受任意 `DiffArtifact`，没有重新从已登记 worktree 获取 Diff、比较哈希，或从 SQLite 读取本次受控验证结果。

真实闭环测试实际提交了源仓库路径而非登记 worktree 路径、伪造的 `hash: "test-hash"`，以及客户端构造的验证对象。这证明当前 API 路径已经允许污染 Reviewer 输入，违反规格 §8.1 第 8 步“Reviewer 只接收原始任务、Pack、最终 Diff、验证结果、验收条件”的来源要求及 §12.1。

**修复要求：**

1. `runReview` 和 review API 仅接收 `taskId`；由核心服务从登记 worktree 重新受控采集 Diff，并从 SQLite 读取由 `runDevelop` 持久化的验证产物与哈希。不得接受调用方提交的 Diff、hash、patch、worktreePath 或验证结果。
2. 将本次执行的 Diff 哈希、验证命令、退出码、截断信息、Agent run 与 ReviewResult 用同一任务关联持久化并追加审计；若当前工作树 Diff 与已验证哈希不一致，必须拒绝 Review 并要求重新验证。
3. 新增 API 对抗性测试：伪造空 Diff、源仓库路径、错误 hash、伪造“通过”验证结果和 develop 后再修改文件均须拒绝；Reviewer 必须只看到受控来源的最终材料。

### P1-04：正式 API 无法安全进入 EXECUTING，真实闭环测试绕过应用入口且未执行 analyze

**位置：** `apps/api/src/composition-root.ts`、`apps/api/tests/omp-real-closed-loop.test.ts`。

通用 `/transition` 被核心正确禁止进入 `EXECUTING`，但 API 没有暴露调用 `beginExecutionIfApproved` 的受控入口。因此正常调用方在获得审批和创建 worktree 后无法从 API 运行 `develop`。真实闭环测试通过直接调用 `root.orchestrator.beginExecutionIfApproved(task.id)` 绕过该缺口，不能证明正式应用链路可执行。

此外，两条所谓完整闭环仅调用 `develop` 与 `review`，没有调用 `/run` 的 `analyze` 或 `ExecutionOrchestrator.runAnalyze`；也没有先断言失败测试在修改前实际失败。真实 Omp 测试在缺少二进制或 API key 时会跳过两个关键场景，并由一个“应跳过”的测试转为成功，因此常规绿灯不能作为 Phase 4 退出证据。

**修复要求：**

1. 增加受控的“开始执行”应用用例/API：只能从 `AWAITING_EXECUTION_APPROVAL` 调用 `beginExecutionIfApproved`，并保留现有事务内 scopeHash 重算与审计；禁止以通用状态迁移绕过。
2. 两个真实失败任务必须从正式 API 链路完成：先验证初始测试确实失败，再运行 Omp `analyze`、`develop`、受控验证、受控 Diff 和受控 Review；分别断言 Agent run、Diff、验证与审计已持久化，且原分支不被污染。
3. 将真实运行时验收拆为明确的受保护命令（例如 `test:omp-real`）：前置条件缺失应报告“未执行/不能验收”，不得把跳过场景计为通过。独立验收时须在可控预算下重新运行两任务，并保存不含凭据的结果摘要、版本与时间。

### P1-05：取消接口不能停止已启动的 Omp 进程，取消后仍可能继续修改 worktree

**位置：** `packages/adapters/src/omp-adapter.ts` 的 `cancel` 与 `runOmpGoverned`。

`cancel(runId)` 仅设置内存标记；Omp 已启动后不会向 `ProcessRunner` 传递 AbortSignal，也不会终止子进程树。源码注释已明确承认该限制。结果是任务/API 已被取消或调用方以为取消成功时，Omp 仍可在最多十分钟内继续修改 worktree、运行工具或访问网络。

这不满足规格 §3 对 Omp Spike 的“取消与超时收口”验证，也不满足 `RuntimeAdapter.cancel` 的实际语义；在受控写入场景属于安全阻断项。

**修复要求：**

1. 扩展 `ProcessRunner`/Runtime 端口以支持 `AbortSignal` 或受控运行句柄；`OmpAdapter` 必须保存活动进程，并在 `cancel` 时终止完整进程树。
2. 取消、超时、异常退出必须使任务转为 `INTERRUPTED` 或 `FAILED`，禁止后续 Diff、验证、Review 被当作成功流程继续执行，并追加结构化审计。
3. 新增 Windows 集成测试：启动可阻塞的 Omp/替身进程，调用 `cancel` 后断言进程树退出、无新增文件、无 `completed`、任务状态与审计正确。

## 2. 非阻断但必须随修复补齐的缺口

1. `ExecutionOrchestrator.runDevelop` 未检查 Runtime 事件流是否出现 `error` 或是否以 `completed` 终止，仍会继续 Diff 与验证；应在核心层失败关闭，并测试“Runtime 错误 + 预先通过的测试”不能被报告为修复成功。
2. `runAnalyze` 要求 task 已有 worktree 和 Plan，而工作流在 Plan/审批前就处于 `GATHERING_EVIDENCE`；应明确其在流程中的合法位置，或拆分一个不需 worktree 的分析/证据阶段，避免 API 标示可用但正常时序不可调用。
3. `ADR-007`、`OmpAdapter` 文件头和组合根注释对“API key 后待验证”与“真实闭环已验证”的描述互相矛盾。关闭 P1 后必须以独立复验结果统一文字，不能用实现者自述替代验收记录。

## 3. 独立运行结果

复验环境：Node `v24.18.0`、pnpm `v11.16.0`。先运行 `pnpm rebuild better-sqlite3`，再在显式清空 `TRACEPILOT_OMP_PATH` 与 `DEEPSEEK_API_KEY` 的条件下执行本地回归，以避免未经授权的外部模型调用与费用。

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `pnpm rebuild better-sqlite3` | 通过 | SQLite 原生模块可按当前 Node 24 ABI 加载。 |
| `$env:TRACEPILOT_OMP_PATH=''; $env:DEEPSEEK_API_KEY=''; pnpm -r run test` | 通过，但不能作为真实 Omp 退出证据 | 553 项通过、3 项跳过；其中 Phase 4 真实 Python/JavaScript Omp 场景共 2 项跳过，仅运行“前置条件不满足时跳过”的分支。 |
| `pnpm typecheck` | 通过 | 5 个工作区包全部通过。 |
| `pnpm lint` | 通过 | 5 个工作区包全部通过。 |
| `pnpm build` | 通过 | 5 个工作区包全部通过。 |
| `git diff --check` | 通过 | 未发现工作区补丁的空白错误。 |

未运行真实 Omp + 外部 LLM 测试：该测试会使用用户的 API key、产生外部调用与费用；更重要的是，P1-01 至 P1-05 已由源码和现有测试确定，直接运行不能弥补安全边界与来源可信性缺失。待修复后应由独立 Reviewer 在明确预算与凭据授权下重新运行受保护的两任务验收命令。

## 4. Phase 4 退出条件映射

| 规格退出条件 | 结论 | 原因 |
| --- | --- | --- |
| 至少两个真实失败任务由 OmpAdapter 完成仓库分析 | 不满足 | 现有两个条件化测试均未调用 `analyze`；本轮独立复验中二者跳过。 |
| 在不污染原分支的情况下完成 worktree 代码修改 | 不满足 | 虽有受控 worktree 与 Diff 基础，但 Omp 内部工具未受可强制路径/命令策略约束，不能证明不越权。 |
| 完成测试执行与 Diff 获取 | 部分满足 | `runDevelop` 已接线受控 Diff 和项目 test；但验证环境泄漏凭据、Runtime 错误不失败关闭，且测试未独立运行真实 Omp。 |
| 产出 Patch 与测试结果 | 不满足 | Review/验证材料可由客户端伪造，未形成 SQLite 中受控、不可替换的执行产物链。 |

## 5. 给后续实现 AI 的强制交接

1. 只关闭 P1-01 至 P1-05，并补齐本报告指定的单元、集成、API 对抗性和真实运行时验收测试；不得通过削弱测试、把真实场景改为跳过或仅更新 ADR/README 来关闭问题。
2. 实现 Agent 可以提交自测证据，但不得审查、批准自己的实现，也不得把本报告、`AGENTS.md` 或 README 的 Phase 4 状态改为“通过”。
3. 修复后由未参与实现的独立 Reviewer 重新阅读 `docs/IMPLEMENTATION_SPEC.md`、Phase 3/Phase 4 报告、ADR-007 与源码，并独立运行原生依赖重建、本地全量回归、类型/lint/build、P1 对抗性测试，以及经明确授权的两个真实 Omp 任务。所有 P1 关闭前不得进入 Phase 5。

## 6. 第二次独立复验（2026-07-28）

**本次结论：仍不通过 Phase 4，禁止进入 Phase 5。** 本轮只审查已有实现并更新验收记录；没有修改任何 Phase 4 业务代码，也没有把实现者自测当作验收结论。

### 6.1 已有实质修复，但不等于阶段通过

| 原问题 | 本轮判断 | 独立复验依据 |
| --- | --- | --- |
| P1-02 验证进程泄漏凭据 | 主路径已关闭 | `verificationProcessPolicy` 已设为 `inheritEnv: false`，使用最小变量白名单并开启 `disallowCredentialVars`；`LocalProcessRunner` 会拒绝名称含 `API_KEY`、`TOKEN`、`SECRET`、`CREDENTIAL`、`PASSWORD`、`PRIVATE_KEY` 的变量。适配器测试覆盖了凭据哨兵的拒绝情形。 |
| P1-03 Review 信任客户端 Diff/验证结果 | 主路径已关闭 | review API 只接收 `taskId` 与 `phase`；`ExecutionOrchestrator` 从 SQLite 读取受控执行结果，重新采集登记 worktree 的 Diff 并比较 hash，`execution-orchestrator-adversarial.test.ts` 覆盖伪造材料、缺失材料和 Diff 被篡改的拒绝情形。 |
| P1-04 缺少开始执行入口 | 应用入口已补齐，但退出证据未补齐 | 已新增 `POST /tasks/:taskId/begin-execution`，真实场景测试已改为经 API 先进入执行状态、检查初始失败、调用 analyze/develop/review。见 6.4，两个真实场景仍可跳过。 |
| P1-05 适配器无法中止子进程 | 适配器层已有修复，但任务取消链路未关闭 | `ProcessRunner` 已接受 `AbortSignal`，本地进程运行器在 Windows 使用进程树终止，`OmpAdapter` 也保存 `AbortController`。但 API 取消任务时并未调用该 Runtime 取消能力，详见 P1-R02。 |

### 6.2 P1-R01：Omp 的写入范围仍只靠提示词，未形成可强制的 Plan 路径边界

**位置：** `packages/adapters/src/omp-adapter.ts`、`packages/core/src/services/execution-orchestrator.ts`。

本轮确认 Omp 参数已从不受限工具收敛为：分析仅 `read,grep,glob`，开发仅 `read,grep,glob,edit,write`，审查使用 `--no-tools`。本机 `omp v17.1.5 --help` 也确认该 CLI 支持工具选择。这有效排除了 `bash`、浏览器等高风险工具，属于正向改进。

但 `--tools` 不是文件系统沙箱：开发阶段的 `edit,write` 仍可写入任意由 Omp 工具接受的路径。实现只通过 `--cwd` 将进程启动在登记 worktree，并没有发现 Omp 的受控路径参数、操作系统级沙箱或 Adapter 层拦截来禁止绝对路径、`..` 穿越、worktree 外路径。更关键的是，`runDevelop` 在取得 `diff.changedFiles` 后没有校验其是否为 `Plan.allowedPaths` 的子集，也未因越界变更拒绝验证/持久化/审查。

因此恶意或失控的开发模型仍可能修改计划之外的 worktree 文件（例如测试、构建脚本、依赖清单），并把这些变更带入受控验证；提示词中声明的 `allowedPaths` 不构成安全控制。这一项仍为 **P1**。

**必须完成：**

1. 为 Omp 的读写工具提供可强制的文件边界；至少必须在执行前后使用规范化绝对路径，拒绝工作树外路径、符号链接逃逸和 `..` 穿越。若 Omp 本身不能提供该边界，必须采用能约束工具文件访问的执行环境或 Adapter，不得用提示词代替。
2. 在核心层将受控 Diff 的每个变更路径与 `Plan.allowedPaths` 做精确比对；任何不匹配都必须失败关闭、禁止验证与 Review，并写入审计。此检查是补充检测，不能替代执行期写入隔离。
3. 增加对抗性测试：计划只允许 `src/users.py` 时，尝试改 `package.json`、测试文件、`../` 和绝对路径均须被阻止或导致失败；还须证明 Omp 原始输出、提示注入和调用方材料不能放宽该范围。

### 6.3 P1-R02：HTTP 取消接口没有连接正在运行的 Omp，取消后流程仍可继续

**位置：** `apps/api/src/composition-root.ts` 的 `POST /tasks/:taskId/cancel`，以及 `packages/core/src/services/execution-orchestrator.ts`。

虽然 `OmpAdapter.cancel(runId)` 现可触发 `AbortSignal` 并终止本地进程树，但 HTTP 取消接口只调用 `TaskOrchestrator.cancel`，没有把当前任务对应的 `runId` 交给 `ExecutionOrchestrator`/Runtime 取消。`ExecutionOrchestrator` 也没有维护可由任务 ID 查找的活动运行句柄。

所以用户从正式 API 取消任务后，任务状态可以变为取消，而 Omp 进程仍可能继续写入 worktree。并且 `runDevelop` 没有将 Runtime 的 `error` 或“未以 `completed` 结束”作为失败条件；即使运行被中止，当前流程仍可能继续采集 Diff、执行验证并持久化材料。这与 P1-05 的安全含义相冲突，仍为 **P1**。

**必须完成：**

1. 由 `ExecutionOrchestrator` 建立 `taskId → runId` 的受控活动运行登记；取消 API 必须先请求 Runtime 终止、等待收口，再将任务迁移到 `INTERRUPTED` 或等价终态并追加审计。
2. `runAnalyze`、`runDevelop` 必须仅在事件流无 `error`、且确实收到 `completed` 时才进入后续步骤。取消、超时或异常必须失败关闭，禁止产生可供 Review 使用的成功执行结果。
3. 增加从 HTTP API 出发的 Windows 集成测试：运行阻塞替身进程，调用 cancel 后断言完整进程树退出、没有后续写入、没有成功验证/Review 产物，且状态和审计一致。

### 6.4 真实运行时退出证据仍不足（P1-04 的剩余验收项）

本轮在显式清空 `TRACEPILOT_OMP_PATH` 与 `DEEPSEEK_API_KEY` 的条件下运行全量测试，以避免未经授权的模型调用和费用。结果为 **575 项通过、3 项跳过**；其中 `apps/api/tests/omp-real-closed-loop.test.ts` 的 Python、JavaScript 两个真实 Omp 任务均因前置条件缺失跳过。常规测试绿灯不能证明两个真实任务已经通过。

现有测试继续使用条件性 `skip`，且尚未提供会在前置条件缺失时明确报告“未执行、不能验收”的独立受保护命令（如 `test:omp-real`）。故“至少两个真实失败任务”这一 Phase 4 退出条件仍未被独立验证，不能关闭 P1-04 的验收部分。

**必须完成：** 新增受保护的真实验收命令，前置条件不足时以非通过状态结束；在用户明确授权模型预算与凭据使用后，由未参与实现的 Reviewer 运行两个真实任务并记录不含凭据的版本、时间、初始失败、analyze、develop、受控验证、Diff、Review 和原分支未污染证据。

### 6.5 本次独立运行记录

| 命令 | 结果 |
| --- | --- |
| `$env:TRACEPILOT_OMP_PATH=''; $env:DEEPSEEK_API_KEY=''; pnpm -r run test` | 通过：575 项通过、3 项跳过；不能作为真实 Omp 验收通过证据。 |
| `pnpm typecheck` | 通过：5 个工作区包。 |
| `pnpm lint` | 通过：5 个工作区包。 |
| `pnpm build` | 通过：5 个工作区包。 |
| `git diff --check` | 通过：未发现补丁空白错误。 |

### 6.6 当前交接结论

后续实现只能关闭 **P1-R01、P1-R02**，并补齐 6.4 的受保护真实验收命令与独立运行证据；不得以新增 prompt、`--auto-approve`、条件跳过、客户端提交的 Diff，或仅更新文档来声称通过。实现者不得自行修改本报告的“仍不通过”结论；全部 P1 关闭并完成独立复验前，不得进入 Phase 5。

---

## 7. 第三次独立复验（2026-07-28）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本节覆盖第 6 节的暂定判断。本轮由未参与实现的 Reviewer 重新阅读实施规格、Phase 3/Phase 4 报告及相关源码，并独立运行本节记录的命令；仅更新验收文档，没有修改实现代码。

### 7.1 已关闭的工程化验收缺口：真实验收命令不再把“跳过”计为通过

根目录已新增 `pnpm test:omp-real`，它调用 API 包的受保护命令并设置 `TRACEPILOT_OMP_REAL_STRICT=1`。真实 Omp 所需的 `TRACEPILOT_OMP_PATH` 或 `DEEPSEEK_API_KEY` 缺失时，测试文件会在收集阶段显式失败，而非使用条件性 `skip` 使普通绿灯被误解为真实验收通过。

本轮在显式清空两个变量的环境中运行该命令，得到退出码 `1` 和“前置条件缺失、无法执行真实 Omp 验收”的明确错误。这一行为符合第 6.4 节的要求，故 **P1-04 的“受保护命令”子项已关闭**。但两个真实任务仍未在经授权的模型预算下实际执行，Phase 4 的真实运行时退出证据仍然缺失。

### 7.2 P1-R01 仍未关闭：Diff 后置检查不能隔离 Omp 的实际读写范围

`ExecutionOrchestrator.runDevelop` 现已在验证前执行 `diff.changedFiles ⊆ Plan.allowedPaths` 校验，并在越界时写入 `policy_denied`、拒绝验证和 Review；`execution-orchestrator-adversarial.test.ts` 也覆盖了 `package.json`、测试文件、`../` 以及空白名单的模拟 Diff。这是正确的**事后检测**，应保留。

但它不能关闭原 P1：`OmpAdapter` 仍只把 `--cwd` 交给 `PathPolicy`，再以 `--tools read,grep,glob,edit,write --auto-approve` 启动 Omp。没有任何工具调用级的路径代理、Omp 已验证的允许路径参数或操作系统文件系统沙箱来限制 `read`、`grep`、`glob`、`edit`、`write` 的具体参数。工作树外的绝对路径读写不会出现在该 worktree 的 Git Diff 中，因而不会触发后置检查；同样，写入 worktree 内但不属于 `allowedPaths` 的副作用在被发现前已经发生。

现有对抗性测试通过 FakeGitAdapter 人工返回 `changedFiles`，不能证明真实 Omp 已被阻止访问绝对路径、路径穿越或符号链接逃逸。实施规格 §7.2 要求“实际操作前解析真实路径”，并要求高风险动作默认拒绝，故该缺口仍为 **P1**。

**关闭要求：**

1. 在真实 Omp 工具调用层实施可验证的文件系统策略：每次读写路径均须规范化并受限于登记 worktree；写入还必须受限于当前 Plan 的 `allowedPaths`。若 Omp 没有可强制的工具参数/沙箱能力，必须改用受控文件工具代理或操作系统级隔离；不得把 prompt、`--cwd` 或 Diff 检查当作替代品。
2. 继续保留 Diff 后置校验，且对越界发现后应生成明确的隔离/恢复策略，避免已发生的越权改动被误带入后续操作。
3. 新增真实 Runtime 对抗性测试：在 `rawSource` 中注入绝对路径、`..`、符号链接逃逸、白名单外读写请求，断言副作用未发生，并能在审计中看到 `policy_denied`。该测试不能以 FakeGitAdapter 的手工 Diff 代替。

### 7.3 P1-R02 仍未关闭：取消存在注册竞态，且 Review 与异常状态未被安全收口

本轮确认，`ProcessRunner` 的 `AbortSignal`、`OmpAdapter.cancel`、`ExecutionOrchestrator.activeRuns` 以及取消 API 的调用顺序均已有实质改进；运行已登记后的 analyze/develop 可以请求终止 Runtime，事件流出现 `error` 或未出现 `completed` 时也会阻断 Diff 和验证。

但以下安全路径仍未闭合：

1. **注册前竞态。** `/run` 在状态检查后异步加载任务上下文；只有 Runtime 流产出 `started` 事件时才写入 `activeRuns`。若取消请求落在两者之间，`cancelRuntimeForTask` 得到 `undefined`，随后 API 将任务置为 `CANCELLED`；原 `/run` 请求恢复后没有重新读取任务终态，仍可启动 Omp 并写 worktree。
2. **Review 无法取消。** `RuntimeAdapter.review` 只返回 `Promise<ReviewResult>`，不暴露 runId；`ExecutionOrchestrator` 只登记 analyze/develop。因此任务在 `REVIEWING` 阶段调用取消 API 时，`OmpAdapter` 虽有内部 `AbortController`，但应用层无法找到并中止该 review 进程。
3. **取消失败被错误降级。** 取消 API 捕获获取服务或 Runtime 终止异常后只记录 warning，仍把任务标为 `CANCELLED`。这会把“未确认进程已停止”伪装成安全取消。
4. **异常状态未迁移。** `runAnalyze`/`runDevelop` 抛出 `RuntimeStreamFailedError` 时，路由只返回 HTTP 400；任务仍可停留在 `EXECUTING`，没有按实施规格 §5.2 收口到 `FAILED` 或 `INTERRUPTED`，也没有该状态的审计证据。

现有取消测试仅验证无活动 Runtime 的 API 取消、或直接在编排服务中等待已登记的 FakeRuntime；没有从 HTTP API 并发启动阻塞 Runtime 后取消，也未覆盖 Review、注册前竞态和终止失败。因此该项仍为 **P1**。

**关闭要求：**

1. 在开始异步 Runtime 前建立可事务校验的任务执行租约/活动记录；取消必须能标记该租约，使尚未产出 runId 的执行在启动前二次检查并失败关闭。不得只依赖 `started` 事件后的内存 Map。
2. 将 Runtime 端口演进为可管理运行句柄，或为 review 建立同等可取消的 runId 登记；取消必须覆盖 analyze、develop、review 三个阶段。
3. Runtime 终止、超时或异常失败时，核心编排服务必须原子地把任务迁移到 `INTERRUPTED`/`FAILED` 并写审计；若终止请求本身失败，不得返回“已取消”，应保留可见的失败/中断状态供人工处理。
4. 新增从 HTTP API 出发的并发集成测试：覆盖注册前取消、已运行 develop 取消、review 取消、Runtime 终止报错；分别断言无后续写入、无成功验证/Review 产物、状态和审计一致。Windows 还须用真实阻塞子进程确认进程树退出。

### 7.4 非阻断问题

1. `OmpAdapter` 的文件头仍保留“运行中的进程无法取消”的旧说明，与当前 `AbortSignal` 实现矛盾；analyze/develop 成功或异常结束时也未删除 `runs` 中的记录，长期运行会造成内存累积。应修正文档并在 generator 的 `finally` 中清理记录。
2. API 组合根在 Omp 装配日志中仍写有“真实闭环已验证”，但本报告确认两个真实任务尚未经独立授权运行。日志、ADR 和 README 只能陈述已验证事实，不得把 Fake/Omp 装配测试表述为真实闭环验收。

### 7.5 本轮独立运行结果

复验环境：Node `v24.18.0`、pnpm `v11.16.0`。执行前已运行 `pnpm rebuild better-sqlite3`。全量本地回归前显式清空 `TRACEPILOT_OMP_PATH` 与 `DEEPSEEK_API_KEY`，未触发真实模型调用或产生费用。

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `$env:TRACEPILOT_OMP_PATH=''; $env:DEEPSEEK_API_KEY=''; pnpm -r run test` | 通过：590 项通过、3 项跳过 | 两个真实 Omp 场景按普通回归策略跳过；不能作为真实验收通过证据。 |
| `pnpm typecheck` | 通过 | 5 个工作区包。 |
| `pnpm lint` | 通过 | 5 个工作区包。 |
| `pnpm build` | 通过 | 5 个工作区包。 |
| `git diff --check` | 通过 | 未发现补丁空白错误。 |
| `$env:TRACEPILOT_OMP_PATH=''; $env:DEEPSEEK_API_KEY=''; pnpm test:omp-real` | 按预期失败（退出码 1） | 明确报告真实验收前置条件缺失，验证受保护命令失败关闭。 |

### 7.6 当前交接结论

下一轮只能实现并关闭 **P1-R01、P1-R02**，再由未参与实现的 Reviewer 在用户明确授权预算与凭据使用后执行 `pnpm test:omp-real` 的两个真实任务。仅有常规测试、受保护命令的“前置条件缺失”失败或文档宣称，均不得签发 Phase 4 通过结论。

---

## 8. 第四次独立复验（2026-07-29）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本节覆盖第 7 节的暂定判断。本轮 Reviewer 未参与本轮实现，仅审查变更后的源码、测试和现有阶段材料，并独立运行本节列出的本地命令。

### 8.1 已有实质关闭项

| 原阻断项 | 本轮结论 | 复验依据 |
| --- | --- | --- |
| P1-R01 的 worktree 内白名单外副作用 | **局部关闭，作为恢复层保留** | 新增 `WorktreeFilesystemGuard` 端口与 `LocalWorktreeFilesystemGuard`。生产组合根会注入守卫；`runDevelop` 在 Runtime 前后快照、检测未跟踪文件/删除/符号链接/类型变更，对白名单外改动回滚并写 `policy_denied`。真实临时文件系统对抗性测试覆盖新增、修改、删除、符号链接与回滚。 |
| P1-R02 的 Runtime 启动前竞态 | **该子项已关闭** | `runAnalyze`、`runDevelop`、`runReview` 均在加载上下文前登记 `AbortController` 租约，在事务内重新校验任务状态，并把 signal 传给 Runtime；取消 API 会先 abort 租约。 |
| P1-R02 的 Review 无法取消与 Runtime 异常状态悬挂 | **该子项已关闭** | Runtime 端口的 review 已接收 `AbortSignal`；`runReview` 使用租约，路由对 Runtime 失败迁移到 `FAILED`，analyze/develop 迁移到 `INTERRUPTED`。新增 API 对抗性测试覆盖阻塞 Runtime、终止失败和异常状态迁移。 |
| 真实验收命令的条件跳过 | **已关闭** | `pnpm test:omp-real` 继续在前置条件不足时失败关闭，不能把跳过场景计为通过。 |

这些改动提升了恢复能力和取消可靠性，但不改变以下两个 P1 的阶段结论。

### 8.2 P1-R01 仍未关闭：快照回滚不是 Omp 工具调用的执行期隔离

`LocalWorktreeFilesystemGuard` 只遍历并快照登记 worktree 内、且不名为 `.git` 的文件。它在 Omp `develop` 已经结束后才比较差异。`OmpAdapter` 仍以 `--tools read,grep,glob,edit,write --auto-approve` 运行，而这些内置工具的具体路径参数不经过 TracePilot 的 `PathPolicy` 或 `allowedPaths` 校验。

因此以下路径仍未被阻止或可靠恢复：

1. Omp 对 worktree 外绝对路径的读写不会出现在 worktree 快照和 Git Diff 中；这既可能泄漏本机数据，也可能修改用户仓库或临近目录。
2. worktree 顶层 `.git` 被守卫明确跳过。链接 worktree 的 `.git` 文件关联主仓库 gitdir；Omp 仍可修改该文件或通过它影响 Git 元数据，守卫不会检测或回滚。
3. 守卫把备份失败、恢复失败（例如 `backupFile`、`restoreFromBackup` 内部失败）大多吞掉；上层仍可能记录“已回滚”。没有基于回滚后的新快照重新校验 `before` 状态，不能证明恢复真的成功。

这违反实施规格 §7.2“在实际操作前解析真实路径”和 §12.4“高风险操作默认拒绝”。快照/回滚只能作为检测与恢复层，不能替代执行期边界，故 **P1-R01 仍未关闭**。

**关闭要求：**

1. 为 Omp 文件工具引入可强制的执行期路径策略：工具读写必须在调用前解析真实路径，拒绝 worktree 外路径、`.git`、路径穿越和符号链接逃逸；写入还必须逐项匹配权威 `Plan.allowedPaths`。若 Omp 不提供可验证的工具级 root/allowlist，必须使用受控文件工具代理或操作系统级沙箱，不能以 `--cwd`、prompt 或快照替代。
2. 保留现有快照守卫作为纵深恢复层，但任何快照、备份、回滚或回滚后完整性验证失败必须失败关闭、写明失败审计，且不得声称已经恢复。备份目录还须避免复制或暴露 worktree 中的凭据文件。
3. 以真实 Omp/隔离运行时进行对抗性验证：注入 worktree 外绝对路径、`.git`、`..`、符号链接和白名单外写入请求，断言副作用未发生，而不是仅在事后回滚 worktree 内的测试文件。

### 8.3 P1-R02 仍未关闭：Runtime 结束后到验证完成前，取消仍可放行后续副作用

`runDevelop` 在消费完 Runtime 事件流后立即从 `pendingLeases` 删除 `AbortController`，但之后仍会执行文件系统扫描、Diff、验证命令和 `execution_results` 持久化。此窗口内的取消 API 找不到 lease 和 active run，便会将任务迁移为 `CANCELLED`；原 `runDevelop` 没有重新检查任务状态，也没有向验证 `ProcessRunner.run` 传入 abort signal，仍可继续运行由 Developer 改写过的测试脚本并写入成功验证产物。

现有“running develop cancel”测试只在阻塞 Runtime 尚未完成时取消；没有覆盖“Runtime 已 completed、验证命令尚未结束”这一窗口。该窗口会破坏“取消后无后续验证/成功产物”的安全保证，且验证子进程运行的是 Agent 已修改的 worktree 内容，不能被视为无害。因此 **P1-R02 仍未关闭**。

**关闭要求：**

1. 将执行租约持有到整个 analyze/develop/review 应用用例完成；在 Diff、验证、执行结果持久化前后重新校验租约和任务非终态。取消后的执行必须失败关闭，不得写入成功 `execution_results`。
2. 向验证命令的 `ProcessRunner.run` 传递同一 AbortSignal，使取消能终止验证进程树；Runtime 已结束不应自动释放该控制权。
3. 新增 HTTP 并发集成测试：让 Runtime 正常 completed，然后阻塞项目验证命令；此时调用 `/cancel`，断言验证进程树退出、无验证成功结果、无 Review 输入且任务/审计保持一致。Windows 环境必须验证真实子进程树终止。

### 8.4 真实 Omp 退出条件仍未独立满足

本轮没有获得用户对外部模型预算和凭据使用的授权，因此没有运行两个真实 Omp 任务。普通回归中的 Python、JavaScript 真实场景仍按设计跳过；受保护命令只能证明“前置条件缺失时不能验收”，不能替代两个真实失败任务的 analyze、修改、验证、Diff、Review 和原分支未污染证据。

### 8.5 本轮独立运行结果

复验环境：Node `v24.18.0`、pnpm `v11.16.0`。执行前运行 `pnpm rebuild better-sqlite3`；全程显式清空 `TRACEPILOT_OMP_PATH` 与 `DEEPSEEK_API_KEY`，未触发外部模型调用。

| 命令 | 结果 |
| --- | --- |
| `$env:TRACEPILOT_OMP_PATH=''; $env:DEEPSEEK_API_KEY=''; pnpm -r run test` | 通过：611 项通过、3 项跳过。 |
| `pnpm typecheck` | 通过：5 个工作区包。 |
| `pnpm lint` | 通过：5 个工作区包。 |
| `pnpm build` | 通过：5 个工作区包。 |
| `git diff --check` | 通过：未发现补丁空白错误。 |

### 8.6 当前交接结论

后续实现只能关闭 **P1-R01、P1-R02**，并在两项均关闭后由独立 Reviewer 在明确授权下运行 `pnpm test:omp-real` 的 Python、JavaScript 两个真实任务。实现 Agent 不得自行把本报告、`AGENTS.md` 或 README 改为“Phase 4 通过”；在真实退出条件与全部 P1 均满足前，不得进入 Phase 5。

---

## 9. 第五次独立复验（2026-07-29）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本轮 Reviewer 未参与本轮实现；已重新核查本轮新增源码、对抗性测试和阶段验收材料，并独立执行本节列出的本地门禁命令。

### 9.1 本轮确认关闭的子项：Review 的普通运行时异常不再悬挂

`/run` 路由已把 `review` 阶段除 `DiffTamperError` 外的异常统一交给 `handleRunError`。该函数会将任务迁移为 `FAILED` 并返回 500，避免 Runtime 普通失败后任务停留在 `REVIEWING`。这关闭了第 8 节所述 P1-R02 中“Review 普通异常未进入终态”的子项；它不覆盖 develop 在 Runtime 完成后的取消窗口。

### 9.2 P1-R01 仍未关闭：恢复性快照不能构成执行期文件隔离

结论与第 8.2 节一致。`LocalWorktreeFilesystemGuard` 仅在 Runtime 前后对登记 worktree 进行快照和事后回滚；`OmpAdapter` 的 `read`、`grep`、`glob`、`edit`、`write` 工具调用仍没有在实际操作前经受控代理或操作系统沙箱校验真实路径和权威 `allowedPaths`。

尤其是 worktree 外副作用不在快照或 Diff 中，`.git` 被快照跳过，且备份、恢复及恢复后的完整性校验不能可靠失败关闭。因而 Omp 仍可能在执行期读取或改写边界外内容；将 worktree 文件备份到临时目录也可能扩大凭据暴露面。**P1-R01 仍为未关闭的阻断项。**

关闭前必须提供可强制的工具级路径策略、受控文件工具代理或操作系统级隔离：操作前解析真实路径，拒绝 worktree 外、`.git`、路径穿越与符号链接逃逸，写操作逐项匹配权威 `Plan.allowedPaths`；并以真实 Omp 或等价隔离运行时验证副作用根本未发生，而非仅验证事后回滚。

### 9.3 P1-R02 仍未关闭：验证阶段没有保留取消控制权

`runDevelop` 在 Runtime 事件流结束后立即执行 `pendingLeases.delete(taskId)`，随后才继续文件系统守卫、Diff、验证命令和 `execution_results` 持久化。源码注释也明确说明后续步骤“不受 Runtime 取消影响”。`ProcessRunner.run(testCommand, ...)` 没有接收同一 `AbortSignal`，且上述步骤前后没有重新核验任务是否已经被取消。

这意味着 Runtime 已 completed、验证命令正在运行时，`/cancel` 无法中止验证进程树；原调用仍可能写入验证成功和执行结果。现有 HTTP 对抗性测试覆盖的是 Runtime 尚阻塞时取消，不覆盖这一完成后验证窗口。验证命令执行的是 Agent 已修改的 worktree 内容，不能按无害后台工作处理。**P1-R02 仍为未关闭的阻断项。**

关闭前必须将同一执行租约保留到整个用例结束，向验证 `ProcessRunner.run` 传递该 signal，并在 Diff、验证及结果持久化前后原子核验任务和租约仍为有效非终态。还必须新增 HTTP 并发集成测试：让 Runtime 正常结束后阻塞真实验证子进程，再调用 `/cancel`，断言子进程树退出、没有成功验证结果或 Review 输入、任务状态和审计一致；Windows 下应验证真实子进程树终止。

### 9.4 真实 Omp 退出条件仍未满足

本轮没有用户对外部模型预算和凭据使用的明确授权，故未运行 `pnpm test:omp-real` 的 Python、JavaScript 两个真实任务。受保护命令在前置条件不足时的失败关闭，以及 Fake Runtime 回归，均不能替代真实 Omp 的分析、受控 worktree 修改、验证、Diff、独立 Review 和原分支未污染证据。

### 9.5 本轮独立运行结果

复验环境：Node `v24.18.0`、pnpm `v11.16.0`。执行前已运行 `pnpm rebuild better-sqlite3`；运行全量回归前显式清空 `TRACEPILOT_OMP_PATH` 与 `DEEPSEEK_API_KEY`，未触发外部模型调用。

| 命令 | 结果 |
| --- | --- |
| `$env:TRACEPILOT_OMP_PATH=''; $env:DEEPSEEK_API_KEY=''; pnpm -r run test` | 通过：611 项通过、3 项跳过。 |
| `pnpm typecheck` | 通过：5 个工作区包。 |
| `pnpm lint` | 通过：5 个工作区包。 |
| `pnpm build` | 通过：5 个工作区包。 |
| `git diff --check` | 通过：未发现补丁空白错误。 |

### 9.6 当前交接结论

下一步只应实现并独立复核 **P1-R01 的执行期文件隔离**与 **P1-R02 的 Runtime 完成后验证取消收口**。两项关闭后，仍须在用户明确授权成本与凭据使用后，执行两个真实 Omp 任务。实现 Agent 不得自审、自行签发通过结论或修改阶段状态；在上述条件全部满足前，不得进入 Phase 5。

---

## 10. 第六次独立复验（2026-07-29）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本轮 Reviewer 未参与实现，仅审查本轮更新后的实现、测试、已安装的本机 Omp 帮助输出及既有阶段材料；未运行会调用外部模型的 Omp 任务。

### 10.1 P1-R02 有实质进展，但最终持久化竞态仍未关闭

本轮实现已修复第 9.3 节的主要窗口：`runDevelop` 将租约保留至 `finally`，在 Diff、验证与持久化前检查 `AbortSignal` 和任务状态，并把同一 signal 传给 `ProcessRunner.run`。新增 HTTP 测试同时覆盖 Runtime 已 completed 后的阻塞验证取消，以及 Windows 真实 Node 验证子进程树终止；这些测试证明“验证运行中取消”已能终止进程且不写入结果。

但最后一次 `assertNotAborted` / `assertTaskStillInStatus` 与随后 `executionResults.save` 位于**不同的 SQLite 事务**。取消可以在最终检查返回后、保存事务提交前抢占：取消请求已 abort 租约并开始状态迁移，而 develop 流程仍可进入仅含 `save(executionResult)` 的事务。该事务内没有再次读取任务状态或把“任务仍为 EXECUTING、租约未取消”的条件与结果写入一起提交，故仍无法提供原子收口保证。

现有测试只在验证进程阻塞期间取消，不能稳定覆盖该最终 TOCTOU 窗口。**P1-R02 仍未关闭。**

**关闭要求：** 将最终状态/租约检查与 `execution_results` 写入置于同一受控单写事务（或建立等价的取消线性化锁）；若已取消则拒绝保存。新增可控屏障测试：让执行流停在最终检查与保存之间，发起 `/cancel` 后释放屏障，断言无 `execution_results`、无成功 API 响应、任务和审计一致。必须明确并测试“取消请求开始”与“结果提交”之间的线性化规则。

### 10.2 P1-R01 仍未关闭：本机 Omp 帮助不能证明代码声称的文件根隔离

本轮 `OmpAdapter` 已改用 `--approval-mode=write`、拒绝 `--auto-approve` / `yolo`、限制内置工具集，并把 worktree 顶层 `.git` 纳入快照。这些都是有效的纵深改进，但不足以证明执行期隔离：本机已安装 Omp（`omp v17.1.5`）的 `--help` 只说明 `--approval-mode` 是覆盖 `tools.approvalMode`，没有说明其会强制拒绝 worktree 外绝对路径、`..`、`.git`、符号链接逃逸或 `Plan.allowedPaths` 之外的写入。

此外，启动 argv 未包含 `--no-extensions`、`--no-skills`、`--no-rules`。本机帮助明确这些自动发现能力默认启用；仅限制内置 `--tools` 不能证明项目目录或用户环境中被自动发现的扩展、技能、规则不会引入额外执行能力。当前单元测试只断言生成的 argv，文件系统测试只验证事后快照/回滚，二者均不是实际 Omp 工具调用的执行期拒绝证据。

快照恢复仍不是可靠的最终边界：对缺失备份或缺少 `before` 信息的恢复路径会直接返回，且回滚后没有将新快照与原快照做完整性比对。因此 **P1-R01 仍未关闭。**

**关闭要求：** 以 Omp 已验证支持的受控文件工具代理或操作系统级隔离强制真实路径与权威 `allowedPaths`；若继续依赖 Omp 审批模式，必须先取得其可复现、版本绑定的官方行为证据，并在不含真实凭据的隔离环境中进行实际工具调用对抗测试。默认禁用自动发现的扩展、技能、规则，除非逐项登记、审计和契约测试。快照、备份、回滚及回滚后完整性验证任一失败都必须失败关闭。

### 10.3 真实 Omp 退出条件仍未满足

尽管本机存在 Omp 可执行文件，本轮未获得用户对模型费用和凭据使用的明确授权，故没有执行真实任务。`pnpm test:omp-real` 的两个场景、真实工具调用路径限制、真实 analyze/develop/验证/Diff/Review 以及原分支未污染，仍未由独立 Reviewer 验收。

### 10.4 本轮独立运行结果

复验环境：Node `v24.18.0`、pnpm `v11.16.0`、本机 Omp `v17.1.5`。执行前已运行 `pnpm rebuild better-sqlite3`；全量回归前显式清空 `TRACEPILOT_OMP_PATH` 与 `DEEPSEEK_API_KEY`，未触发外部模型调用。

| 命令 | 结果 |
| --- | --- |
| `C:\\Users\\EDY\\AppData\\Local\\omp\\omp.exe --help` | 通过：确认支持 `--approval-mode`、`--tools`、`--no-extensions`、`--no-skills`、`--no-rules`；帮助未承诺代码所需的路径根隔离语义。 |
| `$env:TRACEPILOT_OMP_PATH=''; $env:DEEPSEEK_API_KEY=''; pnpm -r run test` | 通过。 |
| `pnpm typecheck` | 通过：5 个工作区包。 |
| `pnpm lint` | 通过：5 个工作区包。 |
| `pnpm build` | 通过：5 个工作区包。 |
| `git diff --check` | 通过：未发现补丁空白错误。 |

### 10.5 当前交接结论

后续只应关闭以下两项：

1. **P1-R02**：让取消与执行结果提交具有可证明的原子线性化边界，并以最终持久化窗口对抗测试验证。
2. **P1-R01**：实现可证明的执行期文件隔离，禁用未登记自动扩展能力，并用真实受控 Omp 工具调用证明越界副作用从未发生。

两项完成后，仍须由未参与实现的 Reviewer 在用户明确授权后执行 `pnpm test:omp-real` 的两个真实任务。实现 Agent 不得自审或自行将阶段改为通过；在全部 P1 和真实退出条件满足前，不得进入 Phase 5。

---

## 11. 第七次独立复验（2026-07-29）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本轮 Reviewer 未参与实现，重新审查第 10 节后新增的源码、对抗性测试及 SQLite 单写事务实现，并独立运行本节的本地门禁；未调用外部模型。

### 11.1 P1-R02 已关闭：最终保存与取消建立了可验证的线性化边界

`runDevelop` 已将“任务必须为 `EXECUTING`”的读取、`executionResults.save` 与保存后的 `AbortSignal` 检查合并进同一个 `UnitOfWork` 写事务。SQLite `SqliteUnitOfWork` 以单写队列和 `BEGIN IMMEDIATE` 串行事务；取消请求若先完成状态迁移，保存事务会读到终态并拒绝写入；若取消在保存 await 期间发出，保存后的同步 abort 检查抛错并触发事务回滚。

新增 HTTP 层屏障对抗性测试确实在 `executionResults.save` 已进入、事务尚未提交时调用 `/cancel`，断言 abort 命中、事务回滚、无 `execution_results`、任务终态与审计一致。加上第 10 节已验证的验证进程树取消，本轮认为 **P1-R02 已关闭**。

说明：当保存事务已经完成并提交后，随后到达的取消按“develop 已先完成”线性化，保存结果保留是合理行为；这不是取消抢占后的成功产物。

### 11.2 P1-R01 仍未关闭：权威 `Plan.allowedPaths` 仍只在 prompt 与事后恢复层出现

本轮新增 `--no-extensions`、`--no-skills`、`--no-rules`，关闭了第 10.2 节所述自动发现能力可能扩展工具集的子项。Omp 仍使用只读/编辑/写入的最小内置工具集，并拒绝 yolo 模式；这些改动应保留。

但执行期的唯一 CLI 边界仍是 Omp 的工作区审批模式。`OmpAdapter` 没有向 Omp 文件工具提供可机器执行的权威 `Plan.allowedPaths` 策略；白名单只是 prompt 文本，实际强制仍发生在 Runtime 结束后的文件快照、Diff 检查和回滚。因此 Omp 可以先写入 worktree 内的白名单外文件，TracePilot 才发现和尝试恢复。这不满足实施规格要求的“实际操作前”路径校验。

同时，`validateOmpArgv` 尚未把 `--no-extensions`、`--no-skills`、`--no-rules` 设为必需项，`omp-adapter.test.ts` 也未断言三项存在或删除后被拒绝。未来 argv 构造回归时，治理闸门与测试均不能失败关闭。**P1-R01 仍未关闭。**

**关闭要求：**

1. 用受控文件工具代理或操作系统级隔离，在每一次读写前解析真实路径、拒绝 worktree 外/`.git`/路径穿越/符号链接逃逸，并逐项匹配权威 `Plan.allowedPaths`；不得依赖 prompt、Omp 审批模式或事后回滚。
2. 将三个 `--no-*` 参数纳入 `validateOmpArgv` 的必需固定拓扑，并补充缺失、篡改和正常 argv 的契约测试。
3. 在用户授权的隔离真实 Omp 场景中注入 worktree 内白名单外、worktree 外绝对路径、`..`、`.git` 和符号链接请求，证明工具调用在副作用发生前被拒绝。

### 11.3 真实 Omp 退出条件仍未满足

未获外部模型预算与凭据使用授权，故本轮未运行 `pnpm test:omp-real`。两个真实任务及其 analyze、受控修改、验证、Diff、独立 Review、原分支未污染证据仍缺失，不能由本地 Fake/argv/文件快照测试替代。

### 11.4 本轮独立运行结果

复验环境：Node `v24.18.0`、pnpm `v11.16.0`。执行前已运行 `pnpm rebuild better-sqlite3`；全量回归前显式清空 `TRACEPILOT_OMP_PATH` 与 `DEEPSEEK_API_KEY`，未触发外部模型调用。

| 命令 | 结果 |
| --- | --- |
| `$env:TRACEPILOT_OMP_PATH=''; $env:DEEPSEEK_API_KEY=''; pnpm -r run test` | 通过。 |
| `pnpm typecheck` | 通过：5 个工作区包。 |
| `pnpm lint` | 通过：5 个工作区包。 |
| `pnpm build` | 通过：5 个工作区包。 |
| `git diff --check` | 通过：未发现补丁空白错误。 |

### 11.5 当前交接结论

**P1-R02 已关闭；下一步只应关闭 P1-R01 的执行期、逐路径 `Plan.allowedPaths` 隔离。** 完成后仍须由未参与实现的 Reviewer 在用户明确授权下执行两个真实 Omp 任务。实现 Agent 不得自审或自行将 Phase 4 改为通过；在 P1-R01 和真实退出条件均满足前，不得进入 Phase 5。

---

## 12. 第八次独立复验（2026-07-29）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本轮 Reviewer 未参与实现，重新审查第 11 节后更新的 Omp argv 治理源码、契约测试与 ADR，并独立运行本节所列门禁；未调用外部模型。

### 12.1 已关闭的 P1-R01 子项：自动发现能力已失败关闭

`OmpAdapter` 现在固定加入 `--no-extensions`、`--no-skills`、`--no-rules`，且 `validateOmpArgv` 将三者列为必需参数。新增契约测试逐一删除三项、同时删除三项并验证拒绝，也验证正常 argv 可通过。因此，第 11.2 节指出的“未来 argv 回归重新启用自动发现但治理闸门未拒绝”已关闭。

### 12.2 P1-R01 仍未关闭：没有逐操作、逐路径的权威白名单执行器

`RuntimeTaskInput.allowedPaths` 在 `OmpAdapter` 中仍仅被格式化为 prompt 文本；`runOmpGoverned` 只校验 Omp 进程的 `--cwd` 和可选 `--add-dir`，不能截获 `read`、`glob`、`grep`、`edit`、`write` 各次工具调用的目标路径。现有快照守卫、Diff 检查与回滚发生在 Runtime 结束之后，无法阻止 worktree 内白名单外文件先被修改。

即使 `--approval-mode=write` 的工作区语义按注释成立，它也只可能约束“是否在工作区”，并没有将权威 `Plan.allowedPaths` 传入一个可执行的工具级 allowlist。因而它不能满足实施规格的“实际操作前解析真实路径、写操作逐项匹配批准范围”。**P1-R01 仍未关闭。**

关闭方案仍应是受控文件工具代理或操作系统级隔离；代理必须在每次读写前做真实路径解析，拒绝 worktree 外、`.git`、`..`、符号链接逃逸及 `Plan.allowedPaths` 外写入。事后快照仅保留为恢复层。

### 12.3 文档一致性问题：ADR-007 与当前安全实现冲突

ADR-007 的 CLI 参数表仍称 `--auto-approve`“非交互模式必需”、并把 `--cwd` 描述为足以锁定受控 worktree；这与当前 OmpAdapter 明确拒绝 yolo/`--auto-approve`、且本报告连续审查得出的路径隔离限制相冲突。ADR 的“真实任务闭环 ✅ 已验证”也只能代表实现者自测，不能替代独立验收。

此项当前列为 **P2 文档完整性问题**，但必须在签发 Phase 4 通过前修正：删除或标注历史 Spike 结论，明确当前受控 argv、未满足的工具级 `allowedPaths` 隔离，以及真实 Omp 仍待独立授权复验。否则后续 AI 可能依据 ADR 重新引入 `--auto-approve` 或错误认定阶段已通过。

### 12.4 真实 Omp 退出条件仍未满足

本轮未取得外部模型预算和凭据使用授权，未运行 `pnpm test:omp-real`。两项真实任务、真实工具调用前拒绝、analyze/develop/验证/Diff/独立 Review 及原分支未污染证据仍缺失。

### 12.5 本轮独立运行结果

复验环境：Node `v24.18.0`、pnpm `v11.16.0`。执行前已运行 `pnpm rebuild better-sqlite3`；全量回归前显式清空 `TRACEPILOT_OMP_PATH` 与 `DEEPSEEK_API_KEY`，未触发外部模型调用。

| 命令 | 结果 |
| --- | --- |
| `$env:TRACEPILOT_OMP_PATH=''; $env:DEEPSEEK_API_KEY=''; pnpm -r run test` | 通过。 |
| `pnpm typecheck` | 通过：5 个工作区包。 |
| `pnpm lint` | 通过：5 个工作区包。 |
| `pnpm build` | 通过：5 个工作区包。 |
| `git diff --check` | 通过：未发现补丁空白错误。 |

### 12.6 当前交接结论

Phase 4 只剩一个 P1：**以可执行的工具级或系统级边界，关闭 P1-R01 的逐路径 `Plan.allowedPaths` 隔离。** 修复 ADR-007 的 P2 文档冲突后，再由未参与实现的 Reviewer 在用户明确授权下完成两个真实 Omp 任务。此前不得进入 Phase 5，也不得自行签发通过。

---

## 13. 第九次独立复验（2026-07-29）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本轮 Reviewer 未参与实现，重新检查当前 OmpAdapter、ExecutionOrchestrator、组合根、Omp 契约测试与 ADR-007；未调用外部模型。

### 13.1 P1-R01 未发现新增关闭证据

当前 `OmpAdapter` 仍只把 `RuntimeTaskInput.allowedPaths` 格式化进 prompt。其受治理执行路径只校验 Omp 进程的 `--cwd`、`--add-dir` 和固定 argv，不存在能拦截 Omp `read`、`glob`、`grep`、`edit`、`write` 每次调用的受控文件代理、逐路径 allowlist 或操作系统级文件隔离。

因此，worktree 内白名单外写入仍可先发生，再由 Runtime 完成后的快照、Diff 与回滚发现；这不符合“实际操作前、逐项匹配 `Plan.allowedPaths`”的阶段安全边界。**P1-R01 仍未关闭。**

第 12 节确认的自动发现参数失败关闭仍有效；P1-R02 也维持已关闭结论。ADR-007 中 `--auto-approve`、`--cwd` 足以隔离以及“真实闭环已验证”的过时或易误解表述仍未修正，P2 文档完整性问题继续开放。

### 13.2 本轮验证范围说明

已完成当前源码、测试目录、ADR 和工作区变更状态的只读核查。计划运行的全量本地门禁（`pnpm rebuild better-sqlite3`、测试、类型检查、Lint、构建、`git diff --check`）在启动前因执行审批通道断连被系统拒绝；**未执行项目命令，不能把第 12.5 节的通过结果写成第九次运行结果。** 该情况是评审环境限制，不是项目测试失败。

### 13.3 当前交接结论

下一步仍只应实现 P1-R01 的执行期、逐路径 `Plan.allowedPaths` 隔离，并修正 ADR-007 的 P2 文档冲突。完成后由未参与实现的 Reviewer 重新运行完整门禁；再在用户明确授权下执行两个真实 Omp 任务。此前不得进入 Phase 5 或签发 Phase 4 通过。

---

## 14. 第十次独立复验（2026-07-29）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本轮 Reviewer 未参与实现，重新审查新加入的 `applyExecutionIsolation` 执行期隔离 lease、其接入路径与对抗性测试；未调用外部模型。

### 14.1 已确认的进展：既有白名单外常规文件有执行期只读保护

`ExecutionOrchestrator.runDevelop` 会在启动 Runtime 前创建快照并申请隔离 lease，Runtime 结束后才释放权限；现有白名单外普通文件和受保护文件可被设置为只读，相关单元测试覆盖了既有 `package.json`、嵌套测试文件、`.git` 与 `.gitignore` 的改写拒绝。此改动应保留，作为纵深防御的第一层。

### 14.2 P1-R01 仍未关闭：该 lease 在当前 Windows 环境不是可证明的逐路径隔离

该实现不满足阶段关闭要求，原因如下：

1. 源码明确承认 Windows 的目录只读不阻止文件创建。白名单外目录或 worktree 根目录仍可在 Runtime 执行期间创建新文件；目前只能在 Runtime 结束后由快照检测和回滚处理，违反“副作用发生前拒绝”。现有测试也没有断言 Windows 下白名单外新增文件会在执行期被拒绝。
2. `applyExecutionIsolation` 对已有符号链接直接 `continue`，既不拒绝、也不解析真实路径或锁定目标。Omp 若通过 worktree 内的符号链接写入，可能修改 worktree 外目标；链接本身未变化时快照也无法感知外部目标的副作用。
3. 无法读取目录时实现直接返回，`chmodSync` 失败时直接忽略并继续启动 Runtime；这与注释中的“失败关闭”相反。任何权限、文件锁或 TOCTOU 使隔离未完整应用时，系统仍会执行 Omp。
4. 隔离仅处理启动时已存在的条目，不能为动态创建的目录、重命名替换、硬链接等后续对象提供操作前校验；也没有受控文件工具代理拦截 Omp 的每次 `read`/`edit`/`write`。

因此，该 lease 可作为恢复层之前的缓解措施，但不能替代工具级代理或系统级沙箱。**P1-R01 仍未关闭。**

**关闭要求：** 对当前 Windows MVP，必须采用能阻止目录内新建与符号链接逃逸的机制，例如受控文件工具代理、受限账号/ACL/容器级隔离，或经验证的 Omp 文件工具根目录与逐路径 allowlist。任何遍历、权限设置、真实路径解析或释放前完整性检查失败都必须拒绝启动 Runtime；不能静默跳过。

### 14.3 P2 文档完整性仍未关闭

ADR-007 仍保留“`--auto-approve` 非交互必需”“`--cwd` 足以锁定受控 worktree”及“真实闭环已验证”的表述，和当前拒绝 yolo、P1-R01 未关闭、真实独立验收未完成的事实冲突。该问题继续保持 P2，须在 Phase 4 签发前修正。

### 14.4 本轮验证范围说明

本轮完成了当前源码、测试和 ADR 的只读核查。全量门禁未重跑：第九次中相同命令已因执行审批通道断连被系统拒绝，本轮没有再次绕过或重试该被拒绝操作。未执行项目命令不等同于测试失败，但第 12.5 节的通过记录不能视为本轮运行结果。

### 14.5 当前交接结论

下一步仍只应关闭 P1-R01，但实现方向必须从“只读权限 + 事后回滚”升级为在 Windows 上可证明阻止新增、符号链接逃逸和白名单外写入的执行期边界；同时修正 ADR-007 的 P2 冲突。完成后由未参与实现的 Reviewer 重新运行完整门禁，并在用户明确授权后执行两个真实 Omp 任务。此前不得进入 Phase 5 或签发通过。

---

## 15. 第十一次独立复验（2026-07-29）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本轮 Reviewer 未参与实现，重新逐行审查 `applyExecutionIsolation`、其对抗性测试、`enforceFilesystemScope` 和 ADR-007；未调用外部模型。

### 15.1 对第 14 节的更正：两项已有修复应予确认

第 14.2 节中“已有符号链接直接跳过”和“目录读取或 `chmodSync` 失败后仍继续运行”的描述已不适用于当前源码：

1. `applyExecutionIsolation` 现在会以 `realpathSync` 解析**执行开始前已存在**的符号链接；目标在登记 worktree 外或无法解析时抛 `ExecutionIsolationError`，不会启动 Runtime。
2. `readdirSync`、`lstatSync`、`chmodSync` 失败现在都会抛 `ExecutionIsolationError`；`runDevelop` 会释放快照并重新抛出，未再采取先前的静默继续策略。

这些改动及其针对既有外部链接、断链和权限设置的测试是有效改进，应保留。第 14 节仅在上述两点被本节覆盖；其关于 Windows 新建文件和缺少逐操作边界的 P1 结论仍有效。

### 15.2 P1-R01 仍未关闭：已承认的 Windows 新建文件窗口与运行中链接窗口都发生在副作用之后

当前实现明确写明：Windows 的目录只读不阻止在白名单外目录新建文件，并将处理交给 Runtime 结束后的快照和回滚。对应测试也明确“不验证新建是否成功”。这不是可接受的“已记录限制”：实施规格 §7.2 要求在**实际操作前**解析路径并拒绝越权操作；快照回滚只能恢复 worktree，不能使已经发生的副作用变为未发生。

此外，符号链接检查只遍历启动隔离时已经存在的条目。Runtime 执行期间新建的链接未经过实时 `realpath` 检查；结束后的 `enforceFilesystemScope` 只按链接自身的相对路径是否受保护或匹配 `allowedPaths` 判定，未解析新增链接的目标。若新增链接路径恰好位于允许目录，或 Runtime 已通过该链接影响外部目标，快照不能记录、回滚或验证外部目标的内容。现有测试没有覆盖“运行期间创建链接后经链接写入外部目标”的对抗场景。

因此，现有 lease 对既有文件形成缓解措施，但仍不是可证明的逐路径执行期隔离；也没有受控文件工具代理或经验证的 Omp 逐调用 allowlist 能拦截绝对路径、`..`、动态链接及白名单外新增。**P1-R01 继续开放。**

### 15.3 本轮测试状态

尝试运行仅包含文件系统守卫的本地 Vitest 测试时，pnpm 在运行测试前进入依赖状态检查，并要求移除 `node_modules` 后重新安装；非交互环境因无 TTY 安全中止。未执行安装、删除或替换依赖目录，因此本轮没有可记录为通过的测试结果。这是当前工作区依赖状态/评审环境的阻塞，不是测试断言失败，也不能用历史测试绿灯替代本轮复验。

### 15.4 P2 文档完整性仍未完全关闭

ADR-007 前部已经补充了“P1-R01 未关闭”和独立验收待执行的说明；但“影响”部分仍写有“Phase 4 退出条件已达成（两个真实失败任务闭环验证通过）”。该表述没有限定为实现者自测，仍可能被后续 AI 误读为阶段已验收，须在签发通过前改为与本报告一致的状态。

### 15.5 当前交接结论

下一步必须以可执行、失败关闭的机制在 Windows 上阻止白名单外**新增**、动态符号链接逃逸和逐操作越权；可选方案是受控文件工具代理、受限账号/ACL/沙箱，或经实际验证且能传入 `Plan.allowedPaths` 的 Omp 工具层策略。快照、Diff 和回滚只能作为恢复与审计层。修复后先恢复可复现的本地依赖与全量门禁，再由独立 Reviewer 在用户明确授权下执行两个真实 Omp 任务；此前不得进入 Phase 5 或签发 Phase 4 通过。

---

## 16. 第十二次独立复验（2026-07-29）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本轮 Reviewer 未参与实现，复查第 15 节后更新的 `ExecutionOrchestrator.enforceFilesystemScope`、符号链接路径解析函数及其对抗性测试；未调用外部模型。

### 16.1 已确认的新改进：运行期间新增或替换的外部符号链接会被事后拒绝

当前 `enforceFilesystemScope` 已在每个变更通过普通 `allowedPaths` 检查后，额外检查 `change.after.isSymlink`。它以 `isSymlinkTargetOutsideWorktree` 解析绝对路径、相对路径、`..` 穿越、Windows 盘符和 UNC 目标；目标位于 worktree 外时，即使链接自身位于 `allowedPaths` 内，也会写入越界集合、回滚并拒绝后续验证与 Review。

对抗性测试新增了“允许目录内新增外部链接”和“允许文件被替换为外部链接”两种场景，并覆盖字符串路径解析。该修复纠正了第 15.2 节对“新增链接完全未检查”的描述：**当前源码能够在 Runtime 结束后发现并移除该链接。**

### 16.2 P1-R01 仍未关闭：新链接及 Windows 新文件仍在事后处理，无法撤销外部副作用

上述新增检查仍发生在 Runtime 返回之后。若 Runtime 在创建指向外部目标的链接后立即通过该链接写入，外部目标的内容不在 worktree 快照或备份范围内；回滚只能删除/恢复 worktree 内的链接，不能恢复外部目标。现有对抗性测试只创建链接并断言最终拒绝，未在链接存续期间尝试写入外部目标并断言其内容未变。

同样，源码与测试继续承认 Windows 的目录只读不阻止白名单外新文件创建，并以快照回滚兜底。两者均违反实施规格 §7.2 的“实际操作前解析真实路径并拒绝”要求。`OmpAdapter` 也没有一个能逐次拦截 `read`/`edit`/`write` 目标的受控文件代理或经实测的 `Plan.allowedPaths` CLI 参数。

所以，这次改动强化了**事后检测与恢复**，但没有建立可证明的执行期逐路径边界。**P1-R01 继续开放。**

### 16.3 本轮验证范围与交接结论

本轮完成源码和测试的静态复核；未重试第 15.3 节已记录的 pnpm 依赖目录重装中止，也未把历史绿灯作为本轮测试结果。后续实现应将目标收敛为：在 Omp 每次文件操作前验证真实路径，或让 Runtime 运行于无法写出 `Plan.allowedPaths` 的强制隔离环境；并增加“动态外部链接后尝试写入”的对抗性测试。恢复依赖后，仍须由独立 Reviewer 重新执行全量门禁，并在用户明确授权下完成两个真实 Omp 任务。此前不得进入 Phase 5 或签发 Phase 4 通过。

### 16.4 P2 文档完整性已关闭

本轮复查 ADR-007 后确认，其状态、阶段说明、实现状态表和“影响”章节均已明确：两个真实失败任务只是实现者自测，不能替代独立验收；P1-R01 仍未关闭；`--auto-approve` / yolo 已被拒绝，`--cwd` 不构成逐路径隔离。第 15.4 节记录的 ADR-007 遗留“退出条件已达成”表述已不存在。

因此，**P2 文档完整性问题关闭**。当前 Phase 4 的唯一阻断项仍是 **P1-R01**，以及 P1 关闭后必须重新完成的本地门禁和经用户授权的真实 Omp 独立验收。

---

## 17. 第十三次独立复验（2026-07-29）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本轮 Reviewer 未参与实现，复查新加入的 `watchForSymlinkEscapes`、其在 `runDevelop` 中的接线、对抗性测试和 ADR-007；未调用外部模型。

### 17.1 已确认的缓解：动态外部链接的检测窗口被缩短

`runDevelop` 在启动 Runtime 前创建 `fs.watch` 监听器；检测到新增/重命名为越界符号链接时会 abort Runtime。对应测试模拟“创建链接 → 等待 200ms → 只有 signal 未 abort 才写外部目标”，并在该特定时序下断言外部目标保持不变。这是对第 16 节事后链接检测的有效补强，应保留为纵深防御。

### 17.2 P1-R01 仍未关闭：`fs.watch` 是异步、可失效的告警，不是操作前的强制边界

该实现不能满足实施规格 §7.2，具体原因如下：

1. 监听回调在事件循环后续 tick 执行；源码接口注释已承认 Runtime 可在创建链接后的同一同步代码块立即写入外部目标。当前测试刻意等待 200ms，验证的是有延迟的合作场景，未覆盖零等待的对抗场景。
2. `fs.watch` 创建失败、运行时 `error`、回调中 `lstatSync` / `readlinkSync` 失败都会静默返回或退化为 no-op watcher。源码虽标注“失败关闭”，实际行为是继续启动 Omp 并等待事后快照，属于 fail-open。
3. watcher 只关注符号链接，不会阻止 Windows 下白名单外普通新文件、重命名替换、硬链接或任意未经工具代理的逐次路径访问；`OmpAdapter` 仍未接收一个可执行的 `Plan.allowedPaths` 逐调用策略。
4. 即便 watcher 触发 abort，进程终止和外部写入之间仍无原子性保证；worktree 快照无法回滚 worktree 外的目标。

因此 watcher 只能缩小概率窗口，不能把“可能在操作后恢复”变成“操作前必然拒绝”。**P1-R01 继续开放。**

### 17.3 本轮命令结果与交接结论

本轮再次尝试运行 `pnpm --filter @tracepilot/adapters test -- filesystem-guard-adversarial.test.ts`，pnpm 在执行测试前要求移除并重装依赖目录，因无 TTY 安全中止；没有测试断言实际运行，也没有执行安装或删除。此为工作区依赖状态阻塞，不得记为测试失败或通过。

后续必须以可验证的工具级文件代理、受限账号/ACL、沙箱或已实测支持逐路径 allowlist 的 Runtime 实现**同步、失败关闭**的操作前校验；并补充“创建外部链接后零等待立即写入”和 watcher 初始化/运行失败均拒绝启动的对抗性测试。修复后重新建立可复现依赖并由独立 Reviewer 重跑完整门禁；获得用户明确授权后再执行两个真实 Omp 任务。此前不得进入 Phase 5 或签发 Phase 4 通过。

---

## 18. 第十四次独立复验（2026-07-30）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本轮 Reviewer 未参与实现，复查 2026-07-30 更新的 `LocalWorktreeFilesystemGuard`、新增 watcher 对抗性测试、实施规格 §7.2 与 ADR-007；未调用外部模型。

### 18.1 已确认的改进：watcher 初始化与监听错误不再静默降级

`watchForSymlinkEscapes` 现在在 `fs.watch` 创建失败时抛错；监听器 `error` 事件以及回调中无法读取路径/链接目标时都会调用违规回调，由 `runDevelop` abort Runtime。新增的 `FailingWatcherGuard` 测试也断言 watcher 初始化失败时 Runtime 不会启动。这关闭了第 17.2 节关于“watcher 初始化或运行错误静默继续”的子问题。

### 18.2 P1-R01 仍未关闭：零等待测试明确证明外部副作用仍可先发生

新增“零等待”测试让 Runtime 在创建指向 worktree 外部的符号链接后立即同步写入外部目标。测试只断言 `runDevelop` 最终抛错、删除链接并记录审计，且注释明确允许外部目标内容为原值或被篡改后的值。这正是无法通过 Phase 4 安全边界的证据：watcher 回调发生在事件循环后续 tick，abort 与事后回滚都不能撤销 worktree 外部的已发生写入。

此外，Windows 白名单外普通新文件仍由 Runtime 结束后的快照处理；不存在将 `Plan.allowedPaths` 交给 Omp 文件工具、在每次读写前解析真实路径的代理，或能证明阻止所有越界写入的 OS 级沙箱。因此新增代码虽已对监听失败关闭，仍不是**同步、操作前、逐路径**的强制边界。**P1-R01 继续开放。**

### 18.3 本轮命令结果与交接结论

本轮运行 `pnpm --filter @tracepilot/adapters test -- filesystem-guard-adversarial.test.ts` 未进入 Vitest：pnpm 先尝试访问 `https://registry.npmmirror.com/pnpm`，网络获取失败，随后因要求移除并重装依赖目录但无 TTY 而安全中止。未执行依赖安装、删除或任何测试断言；该结果是评审环境/依赖状态阻塞，不得记为项目测试失败或通过。

后续实现不应再用 watcher 时序缩小窗口来关闭 P1。必须使用受控文件工具代理、受限账户/ACL、沙箱，或经真实 Omp Spike 验证的逐路径 allowlist，在写入发生前同步拒绝越权；随后恢复可复现依赖、重跑完整门禁，并在用户明确授权下完成两个真实 Omp 任务。此前不得进入 Phase 5 或签发 Phase 4 通过。

---

## 19. 第十五次独立复验（2026-07-31）

**当前有效结论：Phase 4 仍不通过，禁止进入 Phase 5。** 本轮 Reviewer 未参与实现，审查新增 `ControlledFileWriter` 端口、`LocalControlledFileWriter`、`OmpAdapter.develop` 的只读工具配置、组合根装配与其对抗性测试；未调用外部模型。

### 19.1 已确认的实质进展：Omp 的直接写入能力已被移除

生产组合根向 `OmpAdapter` 注入 `LocalControlledFileWriter`；develop argv 已收敛为 `--tools read,grep,glob`，不再提供 `edit`、`write` 或 shell 工具。Omp 必须在文本输出中提供 `<file_change>` 指令，随后由写入器在写入前检查逻辑路径、受保护路径、`..` 穿越和最终节点的外部符号链接。未注入写入器时 develop 会失败关闭。

这比 watcher 与事后回滚更接近正确方向，且应保留：在 Omp 的工具集确实按 argv 生效时，模型本身不再拥有直接写入 worktree 的工具。

### 19.2 P1-R01 仍未关闭：写入器没有逐级解析父目录的真实路径

`LocalControlledFileWriter.checkPathViolation` 使用 `resolve(worktreePath, relativePath)` 做的是**词法**路径归一化，且只对最终文件节点调用 `lstatSync`。它没有逐级检查父目录是否为符号链接，也没有用 `realpath` 验证写入最终落点与 `Plan.allowedPaths` 的真实路径一致。

例如 `Plan.allowedPaths = ["src/**"]` 时，若 worktree 中已有 `src/alias` 符号链接并指向 worktree 内的 `tests/`，指令 `src/alias/new.py` 会通过字符串白名单和最终文件不存在检查；`mkdirSync` / `writeFileSync` 实际会创建 `tests/new.py`，即真实写入落在白名单外。当前文件系统守卫允许这种“指向 worktree 内部”的既有链接，且 Windows 的目录只读不可靠地阻止新文件创建。随后快照可以检测/回滚 `tests/new.py`，但副作用已经发生，不满足实施规格 §7.2 的“实际操作前解析真实路径”。

同一缺口还使写入器的“符号链接逃逸检查”仅覆盖叶子链接，未覆盖父目录链接；现有测试只覆盖 `src/escape-link` 这种最终节点直接指向 worktree 外的情形，没有覆盖内部父链接映射到白名单外目录、父链接指向外部或悬挂父链接。

所以新代理尚不是可证明的逐路径真实路径强制边界。**P1-R01 继续开放。**

### 19.3 还需补齐的验收与本轮命令说明

修复应在每次写入前从 worktree 根逐段解析父目录和最终文件的真实路径；真实落点必须同时位于登记 worktree 内，且其相对真实路径匹配 `Plan.allowedPaths`。任一级不存在、悬挂、不可解析或链接到未批准位置都必须失败关闭。随后应新增真实文件系统对抗性测试，至少覆盖上节的 `src/alias → tests/` 映射、外部父链接和 TOCTOU/解析失败，且断言白名单外目标未被创建。

本轮未重复运行 pnpm：第 18.3 节已经记录当前工作区在测试启动前尝试访问 registry、要求重装依赖并因无 TTY 中止；在依赖状态或网络条件改变前，重复同一命令不能构成独立测试证据。恢复可复现依赖后，必须由独立 Reviewer 运行新增写入器测试、全量门禁，并在用户明确授权下执行两个真实 Omp 任务。此前不得进入 Phase 5 或签发 Phase 4 通过。

---

## 20. 第十六次复核、修复与实现侧自测（2026-08-03）

**当前有效结论：Phase 4 的本地实现候选已通过全部本地门禁，但尚未获得独立验收签发，仍禁止进入 Phase 5。** 本轮先按 Reviewer 口径复查第 19 节问题；发现测试授权边界与 TOCTOU 证据仍需修正后，直接参与了实现，因此本节只能记录修复和实现侧自测，不能依据 AGENTS.md 第 14 条自行把 Phase 4 或 P1-R01 签为正式“通过”。

### 20.1 第 19.2 节父目录真实路径缺口已完成实现侧修复

当前 `LocalControlledFileWriter` 已在批量预检和每次写入前同时校验逻辑路径与真实落点：

1. 从登记 worktree 根开始逐段解析现有父目录和最终文件的真实路径；
2. 真实落点必须仍位于登记 worktree 内，且其真实相对 POSIX 路径必须匹配 `Plan.allowedPaths`；
3. `src/alias → tests/` 这类“仍在 worktree 内、但真实落点位于白名单外”的映射会在写入前拒绝；
4. 外部父链接、悬挂链接、解析失败、受保护路径与词法 `..` 穿越均失败关闭；
5. 父目录按段非递归创建，每段创建后立即重新解析；最终校验返回真实目标路径，实际写入该真实路径，不再通过可能被替换的词法链接路径二次寻址。

新增真实文件系统测试覆盖内部白名单外父链接的新建、覆盖和深层写入，外部父链接的新建、覆盖和深层写入，合法内部链接、悬挂链接、worktree 不存在及普通合法写入。上述场景均断言越权真实目标没有被创建或修改。

### 20.2 TOCTOU 要求已补齐确定性对抗性测试

第 19.3 节要求覆盖批量预检后的路径替换。本轮新增测试专用故障注入点，在“父目录准备完成、最终真实路径校验之前”把正常的 `src/race` 目录替换成指向 worktree 外部的 junction。最终校验抛出 `PathScopeViolationError`，且外部 `file.py` 不存在。

该测试证明预检结果不会被直接复用：每个文件在实际写入前必须重新解析真实路径。生产 Omp develop 仍只有 `read,grep,glob` 三个只读工具，无法自行创建竞态链接；文件系统守卫、Diff 范围校验和快照回滚继续作为纵深防御。实现侧认为第 19.2、19.3 节要求已满足，但正式关闭 P1-R01 仍须由未参与本轮修改的独立 Reviewer 复核。

### 20.3 修复普通测试意外触发真实模型调用的问题

复核标准全量测试时发现：旧测试只要本机 `.env` 同时存在 `TRACEPILOT_OMP_PATH` 和 `DEEPSEEK_API_KEY`，普通 `pnpm test` 就会自动执行两个最长 10 分钟的真实 Omp + DeepSeek 任务。这会在没有显式验收授权时产生网络调用和模型费用，也会让本地门禁不可预测。

现已改为严格 opt-in：只有 `TRACEPILOT_OMP_REAL_STRICT=1` 时真实 Python/JavaScript 闭环才允许运行；仓库提供的 `pnpm test:omp-real` 会显式设置该开关。普通 `pnpm test` 即使本机已配置密钥也只验证跳过分支，不调用真实模型。独立 Reviewer 仍必须先获得用户授权，再运行 `pnpm test:omp-real`。

### 20.4 本轮可复现命令证据

运行环境为 Node `v24.18.0`、pnpm `11.16.0`。为避免 pnpm 在无 TTY 环境中询问依赖目录重建，并保证不访问 registry，本轮标准门禁使用 `CI=true` 与 `PNPM_CONFIG_OFFLINE=true`：

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 通过：28 个测试文件，717 项通过，3 项条件跳过；真实 Omp 的 2 项测试按设计跳过 |
| `pnpm build` | 通过：5 个 workspace 项目全部完成 |
| `pnpm typecheck` | 通过：5 个 workspace 项目全部完成 |
| `pnpm lint` | 通过：5 个 workspace 项目全部完成 |
| `git diff --check` | 通过：无空白错误；仅报告工作区既有 LF/CRLF 提示 |
| 写入器定向测试 | 通过：`local-controlled-file-writer.test.ts` 共 29 项，包括 TOCTOU 父目录替换 |

本轮未把最初误触发且超时终止的真实模型运行计为任何验收证据；修正 opt-in 后也没有再次调用外部模型。

### 20.5 独立 Reviewer 的最终签发清单

下一位未参与本轮实现的 Reviewer 必须：

1. 重新阅读 `docs/IMPLEMENTATION_SPEC.md`、本报告和本轮代码；
2. 复核 `LocalControlledFileWriter` 的逐段真实路径、真实 allowlist、最终真实落点写入与 TOCTOU 测试，确认 P1-R01 可以正式关闭；
3. 独立重跑 `pnpm test`、`pnpm build`、`pnpm typecheck`、`pnpm lint` 和 `git diff --check`；
4. 获得用户对外部模型调用和费用的明确授权后，运行 `pnpm test:omp-real`，确认 Python 与 JavaScript 两个真实失败任务均完成 Omp 分析、受控 worktree 修改、测试验证和 Diff/Patch 产出；
5. 只有以上步骤全部通过，才可把本报告结论和 AGENTS.md 第 17 条更新为 Phase 4 正式通过。若未获真实 Omp 授权，只能维持“本地实现候选通过、阶段未签发”，不得进入 Phase 5。

## 21. 最终独立验收与正式签发（2026-08-03）

**最新有效结论：Phase 4 正式通过，可以进入 Phase 5。** 用户已明确指定本轮 Reviewer 承担最终独立验收与签发职责，并限定只可修改本验收报告和 README。本轮未修改实现代码、测试、ADR 或 AI 约束文件；签发依据全部来自重新阅读当前实现、独立运行本地门禁和经授权运行真实 Omp 闭环。

### 21.1 P1 最终关闭映射

| 原问题 | 最终结论 | 独立复核依据 |
| --- | --- | --- |
| P1-01 / P1-R01：命令、工具与路径边界可绕过 | **关闭** | develop 仅向 Omp 开放 `read,grep,glob`；模型输出的文件变更必须经过 `LocalControlledFileWriter`。写入器在批量预检和实际写入前逐段解析真实路径，强制落点位于登记 worktree 且匹配 `Plan.allowedPaths`，拒绝父链接逃逸、内部白名单外链接、悬挂链接、受保护路径与 `..` 穿越。最终写入通过已打开且未截断的文件句柄完成，并在写入前再次校验路径。29 项定向测试包含确定性父目录替换 TOCTOU 对抗场景。 |
| P1-02：验证进程泄漏凭据 | **关闭** | 验证进程采用最小环境变量白名单并拒绝凭据类变量；相关适配器与编排测试均通过。真实验收输出未包含密钥值。 |
| P1-03：Review 信任客户端 Diff 与验证结果 | **关闭** | review API 只接收任务和阶段标识；Diff 与验证结果来自 SQLite 中的受控执行结果，并在 review 前重新采集登记 worktree Diff、校验哈希。伪造、缺失和篡改输入的对抗性测试通过。 |
| P1-04：正式入口和真实运行时退出证据不足 | **关闭** | `begin-execution` 在事务内校验审批与权威 scope；受保护的 `test:omp-real` 缺少前置条件时失败关闭。本轮两个真实失败任务均确认修改前测试失败，并完成 analyze、develop、验证、Diff 和 review。 |
| P1-05 / P1-R02：取消不能可靠终止 Runtime 或阻止结果提交 | **关闭** | Runtime 取消连接到完整进程树终止；任务取消、活动运行登记和最终结果持久化形成失败关闭边界。单元、集成和 HTTP 屏障对抗性测试覆盖启动竞态、验证进程取消、review 取消和最终提交竞态。 |

最终复核未发现仍需阻断 Phase 4 的 P1。

### 21.2 独立本地门禁

复核环境：Windows，Node `v24.18.0`，pnpm `11.16.0`，Omp `17.1.5`。

| 命令 | 独立结果 |
| --- | --- |
| `pnpm test` | 通过：28 个测试文件，717 项通过，3 项按设计跳过；普通回归未调用真实模型 |
| `pnpm typecheck` | 通过：5 个 workspace 项目全部完成 |
| `pnpm lint` | 通过：5 个 workspace 项目全部完成 |
| `pnpm build` | 通过：5 个 workspace 项目全部完成；受限环境首次出现 `spawn EPERM`，在允许创建子进程的环境以同一命令复验成功 |
| `git diff --check` | 通过：无空白错误；仅有工作区既有 LF/CRLF 提示 |
| `local-controlled-file-writer.test.ts` | 通过：29 项，包括父目录替换 TOCTOU、外部/内部白名单外链接与合法写入 |

### 21.3 真实 Omp + DeepSeek 双任务证据

用户先后明确授权模型费用，以及将测试动态生成的两个合成仓库内容发送给 DeepSeek。验收使用临时 `uv` 环境提供 `pytest`，没有修改项目依赖，也没有向报告写入任何凭据。

| 项目 | 结果 |
| --- | --- |
| 受保护命令 | `uv run --with pytest -- <pnpm> test:omp-real` |
| 执行时间 | 2026-08-03 11:57（Asia/Shanghai） |
| 总耗时 | 345.84 秒；真实测试主体 344.69 秒 |
| Python 合成失败任务 | **通过**：修改前 pytest 确认失败；真实 Omp 完成 analyze，受控修改 `src/users.py`，pytest 验证通过，采集 Diff，并完成 review |
| JavaScript 合成失败任务 | **通过**：修改前 `node --test` 确认失败；真实 Omp 完成 analyze，受控修改 `src/users.js`，验证通过，采集 Diff，并完成 review |
| Vitest 汇总 | 1 个测试文件通过；2 项真实测试通过，1 项普通占位测试按严格模式设计跳过；退出码 0 |

两个场景都通过正式 API 状态流、执行审批、登记外置 worktree、SQLite 受控执行结果和服务端 review 来源运行；没有把 Fake Runtime、条件跳过或实现者自测计入真实退出证据。

### 21.4 签发结论与不可回退边界

最终独立 Reviewer 正式签发：**Phase 4「真实修复闭环」验收通过。** 自本节签发起，历史章节中的“仍不通过”仅保留为对应时点的审计记录，不再代表当前阶段状态。

允许进入 Phase 5，但后续实现必须保留以下边界并补齐相应回归：

1. 不得重新向 Omp develop 开放 `edit`、`write`、shell、`--auto-approve`、yolo 或自动扩展能力；
2. 所有模型生成的文件变化必须经过受控写入器，并继续执行真实路径、登记 worktree、`Plan.allowedPaths` 和受保护路径校验；
3. 不得让验证进程继承模型凭据，不得接受调用方伪造的 Diff 或验证结果；
4. 不得削弱审批 scope、取消线性化、SQLite 受控结果、Git Diff 复核和审计记录；
5. 普通 `pnpm test` 不得隐式调用外部模型；真实模型验收必须继续使用显式 opt-in 命令和用户授权。

### 21.5 受修改范围限制的文档同步项

用户本轮只授权修改验收文档与 README，因此 `AGENTS.md` 第 17 条和 ADR-007 中仍可能存在“Phase 4 尚未通过/待独立验收”的历史状态文字。本项属于 **P2 文档同步问题，不影响本次代码和阶段验收结论**；下一次获得相应文件修改授权后，应以本节签发结果同步，避免后续 AI 读取到冲突状态。在同步前，Phase 4 的最新验收事实以本报告第 0 节与第 21 节为准。
