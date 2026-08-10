# Phase 5 验收评审报告

> 独立复核日期：2026-08-10  
> 评审范围：Phase 5「Review、审批、Repair Memory」  
> 当前验收结论：**正式通过并签发**  
> 后续 AI：Phase 5 已由独立 Reviewer 正式签发，可在同步 `AGENTS.md` 阶段状态后进入 Phase 6；必须保留本报告已经验收的 Review、人工审批、Repair Memory、真实 Omp、SQLite、命令、路径、凭据隔离和失败关闭边界。P2-05 作为已登记非阻断项继续跟踪，实现 Agent 不得把历史 P1/P2 关闭证据改写为自审结论。
> 最新复审：2026-08-10 第十九轮真实 Omp + DeepSeek 最终验收与正式签发见第 23 节；第 0-22 节保留为历史基线。经用户重新授权，完整 `pnpm test:phase5-real` 达到 4 项通过、0 项失败、0 项跳过、退出码 0；两个真实场景全部通过目标 category、质量门、Task、Repair Record、SQLite 和人工挑战断言。P1-07、P1-14 正式关闭，Phase 5 正式通过。

## 0. 首轮独立复核结论（历史基线）

当前实现已经具备 Phase 5 的主要形状：结构化 `ReviewFinding`、确定性质量门、`VERIFIED → APPROVED / DEPRECATED` 记忆状态、人工批准/拒绝 API、SQLite 项目隔离召回和来源定位均已接入。定向测试与全量本地门禁也全部通过。

但 Phase 5 **暂不通过**。本轮源码审查和只读探针确认：人工审批身份仍可由请求体伪造，领域层保留了绕过原子审批闭环的旧完成路径；Reviewer 实际没有收到 Evidence Pack 内容；兼容性/缺少回归测试的 finding 在 `category` 缺失时会失败开放；Review 后至人工审批前存在 Diff 篡改窗口；SQLite 会把 `ReadonlyMap` 型退出码序列化为空对象。与此同时，当前场景测试直接构造 `ReviewResult`，尚未证明真实 Omp Reviewer 能阻止人为构造的兼容性问题或回归测试缺口。

上述问题直接影响“独立 Review、人工明确接受、SQLite Repair Memory 可信来源”和 Phase 5 退出条件，因此不能用 729 项本地测试绿灯替代阶段签发。

## 1. P1：必须关闭后才能通过

### P1-01：人工审批身份可由 API 调用方伪造

**位置：** `apps/api/src/composition-root.ts:1079-1105`。

`POST /tasks/:taskId/human-approval` 直接接收请求体中的 `approver` 并作为人类身份写入审批、审计和 Repair Record。当前没有认证主体、一次性审批凭证、可信本地交互通道或与 Agent 隔离的授权边界。任意能调用本地 API 的进程都可以提交 `approver: "product-owner"`，把 `VERIFIED` 记录提升为 `APPROVED`。

这不满足“人工明确接受”的语义，也会污染默认高可信 Repair Memory。

**必须修复：**

1. `approver` 必须来自服务端可信身份上下文，不得由请求体自由声明；
2. 对本地 MVP，可使用只对人类 UI/CLI 暴露的一次性审批挑战，至少绑定 `taskId`、Repair Record ID、Evidence Pack ID/版本、`diffHash`、决定、有效期和随机 nonce；
3. Agent/Omp/验证进程不得读取审批凭证；
4. 增加无凭证、伪造身份、重放、跨任务复用、过期、错误 Diff 和并发审批对抗性测试。

### P1-02：领域层旧入口可绕过 Repair Record 的原子批准迁移

**位置：** `packages/core/src/services/task-orchestrator.ts:344-403`、`:507-569`；`packages/core/tests/task-orchestrator.test.ts:841-918`。

公开的 `recordApproval({ kind: "human" })` 可以单独写入人类批准，随后 `completeIfEligible()` 会把任务迁移为 `COMPLETED`。该路径不会把 Repair Record 从 `VERIFIED` 迁移为 `APPROVED`，也没有使用 `recordHumanDecision()` 中的同事务状态更新。

现有测试还把这条旧路径视为合法成功场景，实际固化了以下不一致状态：

```text
Task = COMPLETED
Human Approval = approved
Repair Record = VERIFIED
```

这违反实施规格 §5.4、§8.1 和 ADR-009 所要求的“审批、记忆状态和任务终态原子提交”。

**必须修复：** 删除或封闭通用 `human` 审批与 `completeIfEligible` 的组合入口；人工决定只能通过一个领域服务完成。增加事务回滚和“不可能产生 COMPLETED + VERIFIED”不变量测试。

### P1-03：独立 Reviewer 没有收到 Evidence Pack 内容

**位置：** `packages/core/src/ports/adapters.ts:186-195`、`packages/core/src/services/execution-orchestrator.ts:923-988`、`packages/adapters/src/omp-adapter.ts:954-1018`。

`ReviewTaskInput` 只有 `evidencePackId` 与 `evidencePackVersion`，没有 Evidence Pack 的证据条目、来源定位、信任等级、假设、约束或内容哈希。`ExecutionOrchestrator.runReview` 也没有加载 Pack 内容；最终 prompt 只显示：

```text
Evidence Pack: <id>@v<version>
```

所以 Reviewer 无法按规格 §8.1 第 8 步基于 Pack 独立审查，Repair Record 中的根因和适用条件也不能证明来自可回溯证据。

**必须修复：** 在事务内加载并验证任务当前不可变 Pack，将受控 Pack 快照或最小必要的结构化证据内容传入 Reviewer；Review、Repair Record 和审计必须记录 Pack 内容哈希。增加错误任务归属、旧版本、内容哈希不一致和 Reviewer 确实收到来源定位的测试。

### P1-04：兼容性与回归测试质量门在 `category` 缺失时失败开放

**位置：** `packages/adapters/src/omp-adapter.ts:1332-1376`、`packages/core/src/domain/review.ts:38-94`。

`normalizeFindings` 会接受缺少或包含非法 `category` 的 finding；质量门只在 `category` 精确等于 `compatibility` 或 `regression_test` 时阻断 P2/P3。模型漏字段、拼写错误或输出旧 schema 时，明确的兼容性/回归测试问题仍可进入人工审批。

本轮只读运行以下语义探针：验证通过、`ship_with_fixes`、P2 finding 文本为“修复没有新增回归测试”，但不提供 `category`。实际结果为：

```json
{"passed":true,"reasons":[],"blockingFindings":[]}
```

这直接违反 Phase 5 退出条件。

**必须修复：** Review JSON 必须经过严格 schema 校验；finding 的 `category` 缺失或非法时应失败关闭，至少不得产生 `VERIFIED`。必须补充漏字段、非法枚举、旧 schema、自然语言命中但分类缺失和多个 finding 混合场景。

### P1-05：Review 后、人工审批前存在未复核的 Diff 篡改窗口

**位置：** `packages/core/src/services/execution-orchestrator.ts:945-957`、`packages/core/src/services/task-orchestrator.ts:705-721`。

`runReview` 在调用 Reviewer 前会重新采集 worktree Diff 并校验哈希；但 `recordHumanDecision` 只比较 Repair Record 与 `execution_results` 中两份已经持久化的旧哈希，没有重新读取当前 worktree。

如果 Review 完成后、人工审批前 worktree 被再次修改，两份旧哈希仍然相等，任务仍可进入 `COMPLETED`，过期的 Repair Record 也会变为 `APPROVED`。

**必须修复：** 人工决定必须绑定被 Review 的精确 Diff，并在提交前重新校验登记 worktree 的当前 Diff，或在 Review 后以可证明的机制冻结 worktree。需要“Review 后修改允许文件/新增文件/恢复原文件再审批”对抗性测试，断言审批被拒绝且任务、记录、审计保持一致。

### P1-06：SQLite 持久化会丢失验证命令退出码

**位置：** `packages/core/src/domain/repair-record.ts:40-45`、`packages/store/src/sqlite-repositories.ts:675-677`、`:725-747`。

`VerificationSummary.exitCodes` 的领域类型是 `ReadonlyMap<string, number>`，SQLite Repository 使用普通 `JSON.stringify` / `JSON.parse`。JavaScript `Map` 会被序列化为 `{}`，重新读取后也不再是 `Map`。

本轮只读探针确认：

```json
{"passed":true,"ranCommands":["pytest"],"exitCodes":{}}
```

当前 `sqlite-store.test.ts` 创建了带 Map 的记录，却只检查召回 ID，没有断言 `exitCodes` 的内容和类型，因此测试绿灯不能证明往返正确。

**必须修复：** 将领域字段改为 JSON 安全结构，例如 `Readonly<Record<string, number>>` 或只读 tuple 数组，并提供显式编解码与已有 SQLite 数据兼容策略。补充 Repository 与 KnowledgeAdapter 往返测试，断言命令名、退出码、顺序和未知旧数据处理。

### P1-07：Phase 5 的真实退出条件尚未由独立 Reviewer 验证

当前 Core/API 场景测试直接构造 `ReviewResult` 并直接写入模拟 `execution_results`，没有通过 `/run` 的真实 Omp Review 路径。普通 `pnpm test` 中两个真实 Omp 场景按设计跳过，也不包含 Phase 5 的兼容性/缺少回归测试阻断场景。

**必须补齐：** 新增显式 opt-in、缺少前置条件时失败关闭的 `test:phase5-real`。至少使用两个合成场景：

1. 测试绿灯但破坏旧 API 兼容性；
2. 修复当前失败但没有新增或覆盖必要回归测试。

真实 Omp Reviewer 必须接收原始任务、实际 Evidence Pack、最终 Diff、受控验证结果和验收条件，输出结构化 finding，并由质量门阻断。运行前仍须获得用户对合成材料外发和模型费用的明确授权。

## 2. P2：不单独决定结论，但必须纳入整改

### P2-01：KnowledgeAdapter 缺少共享契约测试

实施规格 §6 明确要求 `FakeKnowledgeAdapter` 与 `SqliteRepairMemoryAdapter` 通过同一组契约测试。当前 Fake 的测试位于 `adapters-smoke.test.ts`，SQLite 测试位于 `sqlite-store.test.ts`，两套规则通过复制代码保持一致，没有共享 `knowledge-adapter-contract`。

应建立同一测试工厂，至少覆盖默认状态过滤、`minStatus`、项目隔离、文本匹配、稳定排序、默认/显式 limit、写后读、JSON 往返和结构化错误。

### P2-02：阶段状态文档冲突

`docs/reviews/PHASE-4-ACCEPTANCE-REVIEW.md` 第 21 节和 README 已记录 Phase 4 正式通过，但 `AGENTS.md` 第 17 条仍写“Phase 4 尚未验收通过”。这是上一轮受文件修改授权范围限制留下的状态冲突。

该问题不改变本次 Phase 5 代码结论，但会导致后续 AI 读取到互斥指令。获得授权后应同步 `AGENTS.md` 与 ADR-007；在此之前不得用冲突文本绕过本报告的 Phase 5 P1。

## 3. 独立运行结果

运行环境：Windows，Node `v24.18.0`。依赖目录最初因 pnpm `11.16.0` 与既有 pnpm `11.9.0` 元数据差异触发无 TTY 重建并遇到文件权限错误；随后使用现有锁文件和 pnpm `11.9.0` 完整恢复依赖。该过程未修改源码或锁文件，以下测试均在恢复后重新运行。

### 3.1 Phase 5 定向测试

| 范围 | 结果 |
| --- | --- |
| Core 质量门与 Review→Memory 场景 | 8 项通过 |
| API 人工决定与项目记忆召回 | 2 项通过 |
| SQLite Store 定向测试 | 20 项通过 |

### 3.2 全量门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 通过：729 项通过、3 项按设计跳过；真实模型未运行 |
| `pnpm typecheck` | 通过：5 个 workspace 项目全部完成 |
| `pnpm lint` | 通过：5 个 workspace 项目全部完成 |
| `pnpm build` | 通过：5 个 workspace 项目全部完成 |
| `git diff --check` | 通过：无空白错误；仅报告工作区既有 LF/CRLF 提示 |

全量绿灯说明当前已覆盖的实现路径没有回归，但不覆盖第 1 节列出的身份、证据输入、失败开放、审批时 Diff、Map 往返和真实 Reviewer 退出证据。

本轮没有运行 DeepSeek：Phase 5 已存在可由本地源码和只读探针确定的 P1，且本轮没有获得针对 Phase 5 合成场景外发的单独授权。真实模型运行不能弥补已确认的安全与数据一致性问题。

## 4. Phase 5 退出条件映射

| 规格退出条件 | 当前结论 | 原因 |
| --- | --- | --- |
| 实现独立 Reviewer | **部分满足** | 已有独立 Omp review Session 与结构化结果，但 Reviewer 没有收到 Evidence Pack 内容，且分类 schema 会失败开放。 |
| P0-P3 与质量门 | **部分满足** | P0/P1、显式兼容性和回归测试分类可阻断；缺失/非法 category 会放行。 |
| 人工批准/拒绝 | **不满足** | API 身份可伪造，并存在 `recordApproval + completeIfEligible` 旧路径绕过原子 Repair Record 迁移。 |
| 批准记忆带来源召回 | **部分满足** | 项目隔离、APPROVED 默认过滤和来源定位已实现，但 Reviewer 未消费 Pack 内容，验证退出码在 SQLite 中丢失。 |
| 人为构造兼容性或缺少回归测试能被 Review 阻止 | **未验证** | 当前测试注入预制 ReviewResult，没有真实 Omp Reviewer 场景。 |

## 5. 给后续实现 AI 的强制交接

1. 只关闭 P1-01 至 P1-07；不得通过降低优先级、只修改 prompt、只更新 ADR/README 或新增条件跳过来声称通过。
2. 人工审批、Review 输入和 Repair Memory 来源属于领域安全边界，修复必须在 Core/Orchestrator/Adapter 层成立，不能只依赖 Fastify 路由约定。
3. 现有 Phase 4 的受控写入、凭据隔离、服务端 Diff/验证来源、取消线性化和普通测试不调用外部模型等边界不得回退。
4. 实现 Agent 可以运行自测并记录结果，但不得自行把本报告改为“通过”或批准自己的实现。
5. 全部 P1 关闭后，由未参与修复的独立 Reviewer 重新阅读规格、本报告、ADR-009 和源码，运行定向/全量门禁；最后在用户明确授权下运行真实 Phase 5 Reviewer 场景。

**当前有效结论：Phase 5 暂不通过，禁止进入 Phase 6。**

## 6. 第二轮独立复审（2026-08-03）

### 6.1 本轮结论

实现方已针对首轮 7 个 P1 做了实质修改：增加服务端人工身份与一次性挑战、把完整 Evidence Pack 传给 Reviewer、严格解析 finding 分类、在审批 API 前重抓 Diff、把验证退出码改成 JSON 安全对象、增加 KnowledgeAdapter 共享测试和真实 Reviewer 门禁脚本。新增定向测试及全量本地门禁均通过。

但是，源码复审和独立语义探针确认仍有 4 个 P1 未关闭：

1. 通用状态迁移接口仍能绕过全部人工审批与 Repair Record 原子迁移，直接把任务置为 `COMPLETED`；
2. Reviewer 虽已收到完整 Pack，但正式根因仍是没有 `evidenceIds` 的自由字符串，可把无证据模型结论写成 `APPROVED` 高可信记忆；
3. 最终 Diff 重检与审批提交仍是两个独立步骤，中间没有任务级锁、worktree 冻结或同一关键区，仍存在检查—提交竞态；
4. 真实 Phase 5 Reviewer 场景只增加了脚本，本轮未获针对这两个场景的明确外发与费用授权，且脚本仍直接构造输入调用 Adapter，没有经过受控持久化闭环。

因此，第二轮独立复审结论仍为：**Phase 5 暂不通过，不签发，不得进入 Phase 6。**

### 6.2 首轮问题关闭矩阵

| 编号 | 第二轮状态 | 独立复核结论 |
| --- | --- | --- |
| P1-01 人工身份可伪造 | **已关闭** | `approver` 改为服务端配置；请求必须同时持有通道凭证和一次性挑战；挑战绑定任务、记录、Pack、Diff、决定和有效期，且 Omp/验证环境白名单不包含人工审批凭证。 |
| P1-02 旧完成路径绕过原子迁移 | **未关闭** | 旧 `recordApproval(human) + completeIfEligible` 已封闭，但公开 `transitionTask` 与 `/transition` 仍可直接进入 `COMPLETED`，形成更短的旁路。 |
| P1-03 Reviewer 未收到 Pack | **部分关闭，仍为 P1** | 完整 Pack 已加载、验哈希并写入 prompt；但根因和模型提供的适用条件没有绑定 Pack 内 `evidenceIds`，仍不能证明正式结论来自具体证据。 |
| P1-04 finding 分类失败开放 | **已关闭** | Omp 解析器严格校验 `priority/confidence/category/message`；Core 对缺失或非法 `category` 失败关闭，相关回归测试通过。 |
| P1-05 审批前 Diff 篡改窗口 | **部分关闭，仍为 P1** | 签发挑战和消费挑战前会重抓 Diff，可阻止请求开始前的篡改；但最终重抓与事务提交之间仍有 TOCTOU。 |
| P1-06 SQLite 丢失退出码 | **已关闭** | `exitCodes` 改为 `Readonly<Record<string, number>>`，SQLite 增加兼容解析，往返和契约断言通过。 |
| P1-07 真实 Reviewer 退出证据 | **部分关闭，仍为 P1** | 已增加严格授权入口和两个场景，但未实际运行；当前脚本也未覆盖完整受控编排与状态收口。 |
| P2-01 KnowledgeAdapter 共享契约 | **部分关闭** | 已建立同一测试工厂，但 SQLite 的种子写入绕过 `adapter.write()`，尚未真正验证两个 Adapter 的同一写契约。 |
| P2-02 阶段文档冲突 | **未关闭** | `AGENTS.md` 第 17 条仍称 Phase 4 未通过，与 Phase 4 报告和 README 冲突。 |

### 6.3 仍阻断验收的 P1

#### 6.3.1 P1-02：通用状态迁移接口可直接绕过人工审批

**位置：** `packages/core/src/services/task-orchestrator.ts:243-310`、`packages/core/src/domain/task.ts:205-221`、`apps/api/src/composition-root.ts:509-529`。

`transitionTask()` 目前只特别禁止通用迁移进入 `EXECUTING`，没有禁止进入 `AWAITING_HUMAN_APPROVAL` 或 `COMPLETED`。状态机同时把以下边定义为合法：

```text
REVIEWING → AWAITING_HUMAN_APPROVAL → COMPLETED
```

而 Fastify 仍把 `transitionTask()` 作为公开 `POST /tasks/:taskId/transition` 暴露。调用方可以：

1. 在 `REVIEWING` 时直接迁移到 `AWAITING_HUMAN_APPROVAL`，跳过 `recordReviewAndGate()`；
2. 再迁移到 `COMPLETED`，跳过挑战、人工审批记录和 `VERIFIED → APPROVED`。

本轮在最新构建产物上执行了只使用内存仓储的独立语义探针：创建一个处于 `AWAITING_HUMAN_APPROVAL` 的任务，直接调用公开 `transitionTask(taskId, "COMPLETED")`。实际结果为：

```json
{"taskStatus":"COMPLETED","humanApprovals":0,"repairRecords":0}
```

这直接违反实施规格 §5.2 的 `COMPLETED` 前置条件和 §5.4 的 Repair Record 状态要求。现有“旧 human recordApproval 被拒绝”测试没有覆盖该通用迁移旁路。

**必须修复：**

1. Core 层必须禁止 `transitionTask()` 通用进入 `AWAITING_HUMAN_APPROVAL`、`COMPLETED`，以及会绕过 Repair Record 一致性的人工终态；
2. `REVIEWING → AWAITING_HUMAN_APPROVAL` 只能由 `recordReviewAndGate()` 完成；`AWAITING_HUMAN_APPROVAL → COMPLETED/REJECTED` 只能由 `recordHumanDecision()` 完成；
3. 删除、限制或改造公开 `/transition` 调试端点，不能让 HTTP 调用方触发安全敏感迁移；
4. 增加 Core 和 API 对抗性测试，断言任何旁路都不能产生 `COMPLETED + 无 human approval`、`COMPLETED + 无 APPROVED Repair Record` 或 `COMPLETED + VERIFIED`。

#### 6.3.2 P1-03：正式根因仍未绑定具体 Evidence ID

**位置：** `docs/IMPLEMENTATION_SPEC.md:184-216`、`packages/core/src/ports/adapters.ts:208-217`、`packages/core/src/services/task-orchestrator.ts:639-658`、`packages/core/src/domain/repair-record.ts:21-40`、`packages/adapters/src/omp-adapter.ts:993-1021`。

本轮已经确认 `ExecutionOrchestrator.runReview()` 会加载任务当前 Pack、复算内容哈希，并把完整 Pack 快照传给 `OmpAdapter.review()`。这关闭了“Reviewer 完全看不到 Pack”的原问题。

但规格 §5.3 明确规定：根因只能以 `hypothesis` 表示并关联 `evidenceIds`，Agent 不得把未进入 Pack 的临时发现直接写入根因、约束或 Review 结论。当前实现仍然是：

```text
ReviewResult.rootCause?: string
    → recordReviewAndGate() 原样写入
    → RepairRecord.rootCause: string
    → 人工批准后成为 APPROVED 高可信记忆
```

输出 schema 没有 `rootCauseEvidenceIds` 或 Pack hypothesis ID；Core 也不校验根因是否等于 Pack 中已登记的 hypothesis、引用的 ID 是否存在、引用证据是否属于当前 Pack。模型提供的 `applicabilityConditions` 同样是无来源字符串。只把整包哈希挂到记录上，不能证明某条正式根因由包内哪一项证据支持。

因此，一个没有证据绑定的模型字符串仍可进入默认高可信召回，违反证据驱动平台的核心不变量。

**必须修复：**

1. 让 Review 根因以结构化 hypothesis 引用输出，至少包含 `text`、`confidence`、`evidenceIds`，或只允许引用当前 Pack 中已有 hypothesis ID；
2. Core 在创建 `VERIFIED` 前校验所有引用 ID 存在于当前 Pack，且拒绝空引用、跨 Pack 引用和模型新造但未走 Evidence Request 的正式根因；
3. Repair Record 持久化具体证据引用，召回的 `sourceLocator` 应能定位到 Pack 版本和具体 Evidence ID；
4. 增加缺失引用、未知 ID、跨任务 ID、只在 prompt 中声称有来源等失败关闭测试。

#### 6.3.3 P1-05：最终 Diff 检查与审批提交之间仍有 TOCTOU

**位置：** `packages/core/src/services/execution-orchestrator.ts:1010-1043`、`apps/api/src/composition-root.ts:1133-1186`、`packages/core/src/services/task-orchestrator.ts:804-935`。

消费人工挑战时的实际顺序为：

```text
assertReviewDiffStillCurrent() 重新执行 git diff 并返回
    → API 获得控制权
    → recordHumanDecision() 开启 SQLite UnitOfWork
    → 只比较数据库中已有的 execution / Repair Record / challenge.diffHash
    → 提交 COMPLETED + APPROVED
```

`assertReviewDiffStillCurrent()` 与 `recordHumanDecision()` 之间没有覆盖整个区间的任务级互斥租约、文件系统锁、冻结 commit 或不可变 worktree 机制。外部写入若恰好发生在两次调用之间，事务内比较的仍是三份旧哈希，审批会成功。

新增 API 测试只覆盖“在审批请求开始前修改允许文件或新增文件”，因此能被前置重抓捕获；它没有用屏障在 `assertReviewDiffStillCurrent()` 返回后、`recordHumanDecision()` 提交前注入修改，不能证明竞态已关闭。ADR-009 关于“消费前重读”的描述也不能替代同一关键区不变量。

**必须修复：**

1. 最终 Diff 捕获、挑战绑定复核和审批状态提交必须处于同一个任务级独占关键区；
2. 该关键区必须阻止 TracePilot 内部写入，并对外部 worktree 写入提供可证明的冻结、锁定或提交前后双重校验与失败补偿策略；
3. 增加确定性屏障测试，在 Diff 重抓返回后、SQLite 提交前修改允许文件和新增文件，断言任务不完成、记录不批准、审批不落库且审计一致；
4. 不能只增加一次更靠后的普通函数调用，否则仍会把竞态窗口移动到新的两步之间。

#### 6.3.4 P1-07：真实 Phase 5 Reviewer 仍没有独立运行证据

**位置：** `apps/api/tests/phase5-real-reviewer.test.ts:1-252`、`apps/api/package.json`、根 `package.json`。

本轮确认新增的 `pnpm test:phase5-real` 具备显式授权门禁。未设置 `TRACEPILOT_PHASE5_REAL_ACK=1` 时，严格入口按预期失败关闭，错误为：

```text
Phase 5 真实 Reviewer 测试需要显式授权：请设置 TRACEPILOT_PHASE5_REAL_ACK=1 后重试。
```

这说明普通测试不会误触发外部模型，是正确改进。但本轮没有得到针对 Phase 5 两个新合成场景的明确外发与费用授权，因此没有调用 DeepSeek，真实退出条件仍无独立结果。

此外，当前测试在空临时目录中手工构造 `ReviewTaskInput`、文本 Patch、Pack 和验证对象，直接调用 `OmpAdapter.review()` 后再调用纯函数 `evaluateReviewQuality()`。它没有经过 SQLite 中的真实 Pack/ExecutionResult、`ExecutionOrchestrator.runReview()`、`TaskOrchestrator.recordReviewAndGate()` 或 API `/run`，也没有断言任务最终为 `FAILED`、Repair Record 为 `DRAFT`、人工挑战不可签发。因此它证明的是“真实模型对一段构造 prompt 的分类能力”，还不是“受控 Phase 5 闭环阻止问题进入批准”的完整证据。

**必须补齐：** 在关闭其他 P1 后，用真实临时 Git 仓库和实际 Diff 走受控 Review→质量门→任务/记忆收口链路；分别断言兼容性破坏和回归测试缺口最终被阻断。随后取得用户对 Phase 5 合成内容和模型费用的明确授权，由独立 Reviewer 运行并把模型、命令、结果、跳过项和成本边界写回本报告。

### 6.4 第二轮 P2 与文档问题

#### 6.4.1 P2-01：共享契约只共享了搜索断言，没有真正共享写契约

`packages/store/tests/knowledge-adapter-contract.test.ts:71-117` 中，Fake 的 `seed()` 调用 `adapter.write()`，SQLite 的 `seed()` 却直接调用 `tx.repairRecords.save()`。所以名为“写入后可读”的测试并没有通过 `SqliteRepairMemoryAdapter.write()` 写 SQLite，也没有验证两个 Adapter 对外键缺失、重复 ID、更新和失败回滚的一致行为。

应让同一测试主体实际调用两个 Adapter 的公开 `write()`；测试工厂可以预先创建必要的 Project/Task 外键，但不能绕过被测方法。还应补齐默认 10 条限制、非法运行时 `minStatus/maxResults`、结构化错误与写失败回滚。

#### 6.4.2 P2-02：阶段状态文档仍冲突

`AGENTS.md` 第 17 条仍写“当前 Phase 4 尚未验收通过”，而 Phase 4 报告第 21 节和 README 已正式记录通过。该冲突仍会误导后续 AI；应在获得对应文件修改授权后统一，但不得借此进入 Phase 6。

#### 6.4.3 P2-03：人工审批必需配置没有进入可执行文档

生产组合根在缺少 `TRACEPILOT_HUMAN_APPROVER` 或 `TRACEPILOT_HUMAN_APPROVAL_SECRET` 时会以 503 失败关闭，这是正确的安全默认值；但 `.env.example:1-90` 没有这两个变量，README 的 API 端点表也没有挑战、人工决定、Repair Record 和项目记忆端点。按当前公开文档启动后，操作者无法流畅完成 Phase 5 闭环。

应补充密钥生成/最小强度、只在本地人类通道保存、轮换与泄漏处理说明，并给出不回显真实凭据的 PowerShell 审批示例。

#### 6.4.4 P2-04：Core 质量门只运行时校验了 category

`OmpAdapter` 已严格校验完整 Review schema，因此真实 Omp 路径不会失败开放；但 `evaluateReviewQuality()` 本身只运行时校验 `category`。本轮对最新构建产物传入非法 `verdict`、`priority=P9`、负置信度和空消息，实际仍返回：

```json
{"passed":true,"reasons":[],"blockingFindings":[]}
```

这不是当前 Omp 生产路径的 P1，但会让未来 RuntimeAdapter、测试覆盖或内部误用突破“确定性质量门”。建议在 Core/Adapter 边界复用一个完整运行时 schema 校验器，任何非法 verdict、priority、confidence、message、findings 形状均失败关闭。

### 6.5 第二轮独立运行结果

运行环境：Windows，Node `v24.18.0`，pnpm `11.16.0`。本轮没有修改任何实现代码；只运行测试、构建、只读/内存语义探针，并更新本验收报告。

#### 6.5.1 Phase 5 定向门禁

| 范围 | 结果 |
| --- | --- |
| Core：质量门、Review→Memory、TaskOrchestrator | 56 项通过 |
| Adapter：Omp 解析、ExecutionOrchestrator 对抗、Adapter smoke | 120 项通过 |
| Store：KnowledgeAdapter 共享测试、SQLite Store | 31 项通过 |
| API：Phase 5 审批/Diff/召回 | 3 项通过 |
| Phase 5 真实 Omp Reviewer | 2 项按授权门禁跳过，未外发数据 |

#### 6.5.2 全量门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 通过：742 项通过、5 项跳过；其中 4 项是真实模型测试，另 1 项是平台相关路径测试 |
| `pnpm typecheck` | 通过：5 个 workspace 项目全部完成 |
| `pnpm lint` | 通过：5 个 workspace 项目全部完成 |
| `pnpm build` | 通过：5 个 workspace 项目全部完成 |
| `git diff --check` | 通过：无空白错误；只有工作区既有 LF/CRLF 提示 |
| `pnpm test:phase5-real`（未设置 ACK） | 按预期失败关闭；没有调用模型 |

全量绿灯只能证明已覆盖路径没有回归。P1-02 的独立探针已经证明关键安全不变量不在现有 742 项测试中；P1-05 是现有测试没有插入屏障的竞态；P1-03 是领域模型缺少证据引用；P1-07 则仍缺真实运行结果。因此不能按测试数量签发。

### 6.6 第二轮 Phase 5 退出条件映射

| 规格退出条件 | 第二轮结论 | 原因 |
| --- | --- | --- |
| 独立 Reviewer 接收原始任务、Pack、最终 Diff、验证和验收条件 | **部分满足** | 受控装配已传完整 Pack；真实模型脚本未独立运行，脚本也未走完整持久化编排。 |
| P0-P3 与确定性质量门 | **局部满足** | Omp 真实路径严格 schema 与分类门已成立；Core 完整运行时 schema 校验仍有 P2。 |
| 人工批准/拒绝且不可绕过 | **不满足** | 通用 `/transition` 可直接完成任务，最终 Diff 检查与审批提交还有 TOCTOU。 |
| 批准记忆带来源召回 | **部分满足** | SQLite 召回、项目隔离、Pack 版本/哈希和退出码已成立；根因没有具体 Evidence ID 绑定。 |
| 人为构造兼容性或回归测试缺口被真实 Review 阻断 | **未验证** | 有 opt-in 脚本，无本轮授权运行结果，且尚非完整受控闭环。 |

### 6.7 给后续实现 AI 的第二轮强制交接

1. 先关闭 P1-02 通用迁移旁路；任何能产生无审批 `COMPLETED` 的入口都必须从 Core 层失败关闭。
2. 再关闭 P1-03，把根因和正式适用条件绑定到当前 Evidence Pack 的具体 Evidence ID，不能只靠 prompt 约束。
3. 再关闭 P1-05，用覆盖重抓到提交全过程的任务级关键区和屏障对抗测试证明竞态消失。
4. 完成上述本地 P1 后，再由独立 Reviewer 在用户明确授权下运行真实 Phase 5 两场景；实现 Agent 不得自己运行后把报告改为通过。
5. P2-01 至 P2-04 应同步整改，但不得用文档更新或新增普通 happy-path 测试替代 P1 修复。
6. 后续复审必须重新运行本节全部门禁与两个语义探针，并检查没有回退 Phase 4 的 worktree、凭据、Diff、验证和取消安全边界。

**第二轮当前有效结论：Phase 5 暂不通过，不予签发，禁止进入 Phase 6。**

## 7. 第三轮独立复审（2026-08-03）

### 7.1 本轮结论

本轮由未参与当前修复的独立 Reviewer 执行，只复核源码、运行测试与独立 SQLite 探针，并更新本验收报告；没有修改实现代码、测试、ADR 或运行时配置。

上一轮剩余的 4 个 P1 中，P1-02、P1-03、P1-05 已按指定边界实质关闭；P1-07 已从“直接构造 ReviewTaskInput”升级为真实临时 Git 仓库、实际 Diff、实际测试命令、SQLite 产物和 API `/run` 质量门闭环，本地夹具已经通过。但是，本轮没有调用真实 Omp + DeepSeek，因此真实 Reviewer 的两个阶段退出场景仍没有独立运行证据。

本轮还通过迁移源码与独立 SQLite 探针确认一个新的高可信记忆污染问题：迁移 5/6 对既有 Repair Record 只增加 `NULL`/`[]` 默认字段，没有隔离旧的 `APPROVED` 记录；召回层仍按状态直接返回，并把它们提升为 `VERIFIED_MEMORY`。这使旧数据库可以返回没有 Pack 内容哈希、根因置信度和 Evidence ID 的“高可信”记忆，违反 Phase 5 的来源闭环。

因此第三轮结论为：**Phase 5 暂不通过，不签发，不得进入 Phase 6。** 当前只剩两个阶段阻断项：P1-08 必须先修复；随后经用户对 Phase 5 两个合成场景的外发与模型费用单独授权，独立运行 P1-07 的真实 Omp Reviewer 门禁。

### 7.2 历史问题关闭矩阵

| 编号 | 第三轮状态 | 独立复核结论 |
| --- | --- | --- |
| P1-01 人工身份可伪造 | **已关闭** | 服务端身份、独立通道凭证、一次性挑战、过期/重放/跨任务约束均保留，人工凭证未进入 Omp 或验证进程环境白名单。 |
| P1-02 敏感状态旁路 | **已关闭** | `TaskOrchestrator.transitionTask()` 在 Core 层拒绝进入 `EXECUTING`、`AWAITING_HUMAN_APPROVAL`、`COMPLETED`、`REJECTED`；API 同时限制公开目标，受控执行、Review 和人工终态分别走专用领域入口。 |
| P1-03 正式根因未绑定 Evidence ID | **已关闭** | `ReviewResult.rootCause` 改为 `Hypothesis`；Core 完整校验其 text、confidence、evidenceIds 与当前 Pack 中某一 hypothesis 精确一致，适用条件也必须匹配 Pack constraint；VERIFIED/APPROVED 的 SQLite 往返保留引用。 |
| P1-04 finding schema 失败开放 | **已关闭** | Omp 解析器与 Core 双层完整校验 verdict、findings、priority、confidence、category、message 及扩展字段；非法结果失败关闭。 |
| P1-05 最终 Diff TOCTOU | **已关闭** | 最终捕获、领域提交和提交后复核已放入同一任务级独占关键区；worktree 审批期间隔离写入，提交前后双重 Diff/快照校验，检测竞态后补偿审批、任务与 Repair Record。修改已有文件和新增文件的确定性屏障测试均通过，满足第二轮第 6.3.3 节允许的“双重校验与失败补偿”关闭方案。 |
| P1-06 SQLite 丢失退出码 | **已关闭** | JSON 安全对象及兼容读取仍成立，SQLite 与共享 Adapter 契约往返通过。 |
| P1-07 真实 Reviewer 退出证据 | **本地闭环已补齐，真实运行未完成** | 测试已走真实 Git/worktree/验证/SQLite/API/质量门/状态收口，不再只是纯函数探针；普通测试的两项真实 Omp 场景仍按设计跳过，本轮未外发 Phase 5 合成材料。 |
| P1-08 旧 SQLite 高可信记忆无来源召回 | **新增，未关闭** | 迁移后的既有 APPROVED 记录可携带空 Evidence ID、空 Pack 哈希继续被默认召回，并被 EvidenceCollector 标记为 VERIFIED_MEMORY。 |
| P2-01 KnowledgeAdapter 共享契约 | **已关闭** | Fake/SQLite 均通过公开 `write()` 执行同一写入、失败、更新、JSON 往返、过滤、排序与数量限制契约。 |
| P2-02 阶段文档冲突 | **已关闭** | AGENTS、README 与 ADR-007 已统一为 Phase 4 正式通过、Phase 5 待独立验收。 |
| P2-03 人工审批可执行文档 | **已关闭** | `.env.example` 与 README 已包含服务端身份、通道凭证生成/轮换、挑战消费和端点说明。 |
| P2-04 Core 完整 schema | **已关闭** | `validateReviewResultSchema()` 已覆盖完整 ReviewResult 运行时边界。 |

### 7.3 P1-08：旧 SQLite Repair Record 会绕过新来源要求

**位置：** `packages/store/src/migrations.ts:225-237`、`packages/store/src/sqlite-repair-memory-adapter.ts:48-73`、`packages/core/src/services/evidence-collector.ts:340-365`、`apps/api/src/composition-root.ts:1252-1261`。

迁移 5 把 `input_evidence_pack_content_hash` 增加为可空列；迁移 6 把 `root_cause_confidence` 增加为可空列，并把 `root_cause_evidence_ids_json`、`applicability_evidence_json` 的默认值设为 `[]`。迁移没有回填、降级或隔离已经存在的 `VERIFIED`/`APPROVED` 行。

`SqliteRepairMemoryAdapter.search()` 只按 `project_id` 和状态过滤，不重新验证高可信记录是否具备 Pack 哈希、Evidence ID、验证结果和可追溯 Pack。`EvidenceCollector` 随后把每条结果无条件标记为 `trustLevel=VERIFIED_MEMORY`。项目记忆 API 虽返回 `sourceLocator`，但旧行只会得到空或缺失的来源字段。

本轮在临时 SQLite 中构造了与迁移后旧行等价的 `APPROVED` 记录：保留旧字段，令新来源字段为迁移默认值，然后调用默认 `KnowledgeAdapter.search({ projectId })`。实际输出为：

```json
[{"id":"legacy-approved","status":"APPROVED","evidenceIds":[]}]
```

这不是显示层问题：该记录会进入后续 Evidence Pack，并被标记为已验证记忆。它直接破坏“APPROVED 才是高可信且必须带来源”的 Phase 5 语义，因此按 P1 阻断。

**必须修复：**

1. 只能追加新的迁移版本，不得假定所有本地数据库都是空库，也不得通过修改已应用迁移版本掩盖升级问题。
2. 对既有 `VERIFIED`/`APPROVED` 行执行失败关闭迁移：只有能从对应 Evidence Pack 重新验证 Pack 哈希、根因 hypothesis、confidence、Evidence ID、Diff/验证来源的记录才允许保留；无法可靠回填的旧行必须降级为 `DRAFT` 或 `DEPRECATED`，不能继续默认召回。
3. 在 `SqliteRepairMemoryAdapter.search()` 或共享可信记录校验器增加纵深防御；即使数据库被旧版本、手工导入或内部误用写入无来源 APPROVED 行，也不得返回给默认高可信召回，更不得被提升为 `VERIFIED_MEMORY`。
4. 增加真实升级集成测试：先创建停留在迁移 5 且含旧 APPROVED/VERIFIED/DRAFT 行的数据库，再升级到最新版本；断言无来源旧行不被默认召回，合法新记录仍能带 Pack/Evidence/Diff 来源召回，重复启动迁移保持幂等。

### 7.4 P1-07：本地闭环已合格，但真实 Omp Reviewer 尚未运行

`apps/api/tests/phase5-real-reviewer.test.ts:280-517` 现在为两个场景创建真实临时 Git 仓库和外置 worktree，应用实际候选修改，运行真实 `node --test`，捕获实际 Diff，把 Pack 与 ExecutionResult 写入 SQLite，再通过 API `/tasks/:taskId/run` 调用 Review 与确定性质量门。测试同时断言：

- finding 包含 `compatibility` 或 `regression_test`；
- API 返回阻断结果；
- 任务最终为 `FAILED`；
- Repair Record 最终为 `DRAFT`；
- 人工挑战不能签发。

这关闭了第二轮指出的“只构造 Adapter 输入、没有持久化和状态收口”缺口。本地 Fake Reviewer 的两个等价夹具均通过。

真实 Omp 分支仍由 `TRACEPILOT_PHASE5_REAL_STRICT=1` 与 `TRACEPILOT_PHASE5_REAL_ACK=1` 双重 opt-in 控制。本轮显式设置 ACK=0 运行 `pnpm test:phase5-real`，测试在收集阶段按预期失败关闭，没有调用 Omp/DeepSeek。由于本轮没有收到针对 Phase 5 这两个新合成场景的单独外发与费用授权，不能把跳过项签成真实退出证据。

关闭 P1-08 后，需由独立 Reviewer 在用户明确授权的同一轮设置 ACK=1，运行两个真实场景，并把实际模型、命令、两个 finding 分类、质量门、任务/记录状态、跳过项和费用边界写回本报告。任何密钥值不得进入报告或日志摘录。

### 7.5 第三轮独立运行结果

运行环境：Windows，Node `v24.18.0`，pnpm `11.16.0`。普通测试没有调用外部模型。

#### 7.5.1 Phase 5 定向门禁

| 范围 | 结果 |
| --- | --- |
| Core：质量门、Evidence 绑定、Review→Memory、敏感迁移 | 67 项通过 |
| Store：共享 KnowledgeAdapter 契约、SQLite 往返 | 39 项通过 |
| API：人工审批竞态、本地 Reviewer 闭环 | 8 项通过、2 项真实 Omp 场景跳过 |

首次从仓库根直接执行 `pnpm exec vitest ...` 时，根级物理 Vite 目录缺少可解析的 `esbuild`，测试尚未收集即退出。改用各 workspace 的 pnpm 依赖链接后定向门禁全部通过；随后官方根脚本 `pnpm test` 也完整通过。因此该次启动错误不计为用例失败，但保留在报告中，避免把重试过程隐藏为一次成功。

#### 7.5.2 全量门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 通过：766 项通过、5 项跳过；其中 4 项为真实模型场景，1 项为平台相关路径测试 |
| `pnpm typecheck` | 通过：5 个 workspace 项目全部完成 |
| `pnpm lint` | 通过：5 个 workspace 项目全部完成 |
| `pnpm build` | 通过：5 个 workspace 项目全部完成 |
| `git diff --check` | 通过：无空白错误；只有既有 LF/CRLF 提示 |
| `TRACEPILOT_PHASE5_REAL_ACK=0; pnpm test:phase5-real` | 按预期失败关闭，0 项真实场景执行，未外发数据 |
| 独立旧记忆探针 | 复现：无 Evidence ID 的 APPROVED 行被默认召回 |

测试绿灯证明新实现路径没有已覆盖的回归，但不能覆盖迁移前既有数据的可信度，也不能替代被明确跳过的真实模型退出条件。

### 7.6 非阻断但影响流程流畅性的 P2

#### P2-05：执行审批的 `rejected` 决定没有明确状态收口

`POST /tasks/:taskId/approvals` 接受 `decision=rejected`，`recordApproval()` 会持久化该记录，但任务仍停留在 `AWAITING_EXECUTION_APPROVAL`；与此同时，通用迁移现在正确地禁止进入 `REJECTED`。现有测试只断言拒绝记录不能进入 EXECUTING，没有定义拒绝后是终止任务、回到计划修订，还是允许后续覆盖批准。

这不影响最终人类 Review 拒绝链路，故本轮列为 P2；但它会让操作者看到“拒绝成功 201”后任务仍永久等待。后续应选择并实现一个明确语义：要么由专用执行拒绝领域方法在同一事务进入 `REJECTED`，要么迁回可修订计划的状态并使旧审批失效；API、状态机、审计和 README 必须一致。

### 7.7 第三轮退出条件映射与交接

| Phase 5 退出条件 | 第三轮结论 | 原因 |
| --- | --- | --- |
| 独立 Reviewer 与确定性质量门 | **本地满足** | Pack 输入、完整 schema、Evidence 绑定和质量门均由源码与测试确认。 |
| 人工批准/拒绝与精确 Diff | **本地满足** | 服务端身份、一次性挑战、任务级关键区、双重校验与补偿测试通过。 |
| 批准记忆带来源召回 | **不满足** | 新记录满足，但迁移后的旧 APPROVED 行可无来源召回并被提升为 VERIFIED_MEMORY。 |
| 人为构造兼容性或回归测试缺口被 Review 阻止 | **本地夹具满足，真实模型未验证** | 完整受控闭环已存在；两项真实 Omp 场景仍跳过。 |

给后续实现 AI 的强制交接：

1. 只修复 P1-08 与相应真实升级/召回测试；不得修改本报告结论、降低旧记录信任要求，或把空 Evidence ID 包装成“兼容来源”。
2. 实现 Agent 可以提交自测结果，但不得自行签发 P1-08、P1-07 或 Phase 5 通过。
3. 修复后由独立 Reviewer 重新运行迁移探针、Phase 5 定向门禁、全量测试、typecheck、lint、build 和 diff check。
4. 本地 P1 全部关闭后，再取得 Phase 5 两个合成场景的明确外发与费用授权，运行 `pnpm test:phase5-real`；没有真实运行结果时只能维持“本地候选通过”，不能正式签发。
5. 只有 P1-08 与 P1-07 都关闭，才可由独立 Reviewer 更新本报告顶部结论、README 阶段表并正式允许进入 Phase 6。

**第三轮当前有效结论：Phase 5 暂不通过，不予签发，禁止进入 Phase 6。**

## 8. 第四轮独立复审（2026-08-04）

### 8.1 本轮结论

本轮由最终独立 Reviewer 继续执行，只审查第三轮报告之后的源码和测试变更，运行本地质量门、真实 Reviewer 授权门禁及独立临时 SQLite 探针，并更新本验收报告。**没有修改任何实现代码、测试、README、ADR 或运行时配置。**

迁移 7、共享可信来源解析器和召回时的纵深校验，已经正确关闭 P1-08 原先描述的“旧 `VERIFIED`/`APPROVED` 行缺少 Evidence Pack、Diff 和验证来源仍被召回”问题。真实 v5/v6 数据库升级测试、合法记录保留测试、损坏来源失败关闭测试均已进入 `sqlite-store.test.ts`，该文件 25 项全部通过。因此 P1-08 的原始问题可以由本轮独立 Reviewer 正式关闭。

但本轮发现两个新的阶段阻断：

1. Repair Record 的 `projectId` 与 `taskId` 只各自满足外键，没有验证任务实际属于该项目。项目 A 可以写入并召回一条全部来源于项目 B 任务的 `APPROVED` 记忆，构成跨项目记忆泄漏与污染（P1-09）。
2. SQLite 对重复 Repair Record ID 的更新只更新 Pack 内容哈希与 Diff 等字段，却保留旧 Pack ID/版本，形成无法重新验证的混合来源。共享契约已确定性失败，更新后的记录被可信召回直接丢弃（P1-10）。

此外，Fake 契约夹具仍使用伪造的 `fnv1a32-contract`，却与 SQLite 共用“必须为真实 FNV 哈希”的断言，导致第二个契约失败。根级 `pnpm test` 因此不是绿灯。P1-07 的本地完整闭环仍通过，但两项真实 Omp + DeepSeek Reviewer 场景继续跳过；本轮没有取得 Phase 5 合成场景单独外发与费用授权，未调用外部模型。

**第四轮结论：Phase 5 暂不通过，不签发，不得进入 Phase 6。**

### 8.2 最新问题状态矩阵

| 编号 | 第四轮状态 | 独立复核结论 |
| --- | --- | --- |
| P1-01 至 P1-06 | **保持关闭** | 本轮相关回归路径未发现反证；类型、Lint、构建和 API 本地测试均通过。 |
| P1-07 真实 Reviewer 退出证据 | **未关闭** | 本地 Git/worktree/SQLite/API/质量门闭环通过；真实 Omp 场景仍为 2 项跳过，严格入口在 ACK=0 时正确失败关闭。 |
| P1-08 旧 SQLite 无来源高可信记忆 | **已关闭** | 追加迁移 7 使用与召回相同的可信来源解析器；无法重新验证的旧高可信行降级为 `DEPRECATED`，合法 v6 记录升级后保留，召回继续失败关闭。 |
| P1-09 跨项目来源链可被当作本项目记忆 | **新增，未关闭** | 独立 SQLite 探针已复现项目 A 召回项目 B 任务的 Pack、执行结果和 Repair Record 来源链。 |
| P1-10 重复 ID 更新产生混合来源 | **新增，未关闭** | SQLite 共享契约确定性失败；更新后记录保留旧 Pack ID、写入新 Pack 哈希和 Diff，随后被可信解析器过滤。 |
| P2-01 KnowledgeAdapter 共享契约 | **重新打开** | 当前共享契约为 2 项失败；在 Fake 和 SQLite 都恢复绿灯前不能继续视为关闭。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 本轮相关实现未变化，第三轮结论继续有效。 |
| P2-06 Fake 可信来源夹具不一致 | **新增，未关闭** | Fake seed 原样写入伪哈希，但共享 JSON 往返用例要求真实 FNV 哈希，契约自身不一致。 |

### 8.3 P1-08 独立关闭证据

**位置：** `packages/store/src/migrations.ts:246-274`、`packages/store/src/trusted-repair-record.ts:29-69`、`packages/core/src/domain/repair-record.ts:173-295`、`packages/store/src/sqlite-repair-memory-adapter.ts:48-79`、`packages/store/tests/sqlite-store.test.ts:195-433`。

本轮确认：

- 迁移版本只追加到 7，没有改写已应用的旧迁移；
- 迁移 7 扫描既有 `VERIFIED`/`APPROVED` 行，无法重新绑定 Pack、重算 Pack 哈希、匹配 hypothesis/constraint、绑定 Diff 和通过的 ExecutionResult 时，统一降级为 `DEPRECATED`；
- `search()` 每次召回仍使用同一解析器重新校验，手工导入、旧版本或后续损坏不会只依赖状态标签；
- v5 真实升级、v6 合法来源保留、迁移重启幂等和损坏 Pack 失败关闭测试均通过；
- Store 的 `sqlite-store.test.ts` 本轮结果为 25/25 通过。

这满足第三轮 P1-08 列出的失败关闭、纵深防御和真实升级测试要求。下述 P1-09 是同一可信模型中另一个此前未覆盖的项目归属维度，不撤销 P1-08 针对旧无来源数据的关闭结论。

### 8.4 P1-09：可信 Repair Memory 没有验证项目与任务的真实归属

**位置：** `packages/store/src/migrations.ts:49-68`、`:128-147`，`packages/store/src/sqlite-repair-memory-adapter.ts:82-99`，`packages/store/src/trusted-repair-record.ts:32-64`，`packages/core/src/domain/repair-record.ts:200-278`。

当前数据库只分别约束：

```text
repair_records.project_id -> projects.id
repair_records.task_id    -> tasks.id
tasks.project_id          -> projects.id
```

它没有约束 `repair_records.project_id = tasks.project_id`。`write()` 只在任一外键不存在时失败；可信来源解析器按 `record.taskId` 查 Pack 和 ExecutionResult；Core 校验也只检查 Pack/ExecutionResult 与该 `taskId` 一致，没有加载 Task 并校验其 `projectId`。因此一条记录可以声明自己属于项目 A，同时完整绑定项目 B 任务的来源链。

本轮使用当前构建产物创建临时 SQLite：项目 A、项目 B、属于 B 的任务/Pack/ExecutionResult，以及声明 `projectId=A`、`taskId=B` 的合法 `APPROVED` Repair Record。默认召回的实际结果为：

```json
{"projectA":[{"id":"record-cross-project","projectId":"project-a","taskId":"task-project-b"}],"projectB":[]}
```

这证明项目 A 能读取和使用项目 B 的可信工程记忆。迁移 7 与运行时召回复用同一缺少项目归属检查的解析器，所以既有此类行也会被保留。该问题违反项目隔离和高可信来源闭环，按 P1 阻断。

**必须修复：**

1. 在共享可信来源解析器中加载 Task，并要求 `task.id === record.taskId` 且 `task.projectId === record.projectId`；迁移与召回必须继续复用同一规则。
2. `KnowledgeAdapter.write()` 必须在保存前失败关闭跨项目组合，不能只依赖两个独立外键；错误码应可区分“引用不存在”和“项目归属不匹配”。
3. 追加迁移或用升级迁移中的新版解析器，把既有跨项目 `VERIFIED`/`APPROVED` 行降级隔离；不得仅在查询时隐藏脏数据。
4. 为 Fake/SQLite 共用契约增加跨项目写入、手工脏行召回、v6→最新升级和迁移幂等测试，断言任何跨项目来源均不可进入高可信召回。

### 8.5 P1-10：重复 Repair Record ID 更新没有原子更新来源身份

**位置：** `packages/store/src/sqlite-repositories.ts:649-693`、`packages/store/tests/knowledge-adapter-contract.test.ts:107-200`、`:313-336`。

共享契约用同一 ID 先写“旧根因”，再写“新根因”。由于 Evidence Pack 不可变，SQLite 夹具为第二次写入创建新的 Pack 和 ExecutionResult。Repair Record UPSERT 更新了 `root_cause`、`input_evidence_pack_content_hash`、`diff_hash` 等字段，却没有更新 `project_id`、`task_id`、`input_evidence_pack_id` 和 `input_evidence_pack_version`。

最终数据库行形成“旧 Pack ID + 新 Pack 内容哈希 + 新根因 + 新 Diff”的混合来源。可信召回正确地将它失败关闭，但对外表现为成功写入后记录消失。当前官方测试结果：

```text
SQLite KnowledgeAdapter 契约 > 重复 ID 采用确定性更新而不是产生重复记录
expected [] to have a length of 1 but got 0
```

这既违反已经声明的共享 Adapter 更新契约，也会让高可信记忆在更新后静默不可用，按 P1 阻断。

**必须修复：** 明确并只保留一种领域语义：要么在同一事务中原子更新完整来源身份，并在提交前验证新 Pack/Task/ExecutionResult；要么把这些字段定义为不可变身份，在变化时显式拒绝整个写入。不得继续接受写入后留下混合来源，也不得通过删除断言或绕过可信解析器让测试变绿。修复后必须覆盖“同来源状态更新”“新 Pack 版本更新”“跨任务/跨项目更新拒绝”和失败回滚。

### 8.6 P2-06：Fake/SQLite 共享契约夹具自身不一致

**位置：** `packages/store/tests/knowledge-adapter-contract.test.ts:39-72`、`:87-104`、`:107-200`、`:369-378`。

`sampleRecord()` 默认使用无法通过真实格式校验的 `fnv1a32-contract`。SQLite seed 会创建 Pack、计算真实哈希并替换该字段；Fake seed 则原样写入。两者随后共用“哈希必须匹配 `^fnv1a32-[0-9a-f]{8}$`”的断言，导致 Fake 契约失败：

```text
expected 'fnv1a32-contract' to match /^fnv1a32-[0-9a-f]{8}$/
```

应让共享输入本身具备一致的合法来源值，或为两种 Adapter 提供语义等价的可信来源 fixture。不能删除哈希断言，因为 SQLite 真实来源往返仍需要它。该项本身是测试/契约一致性 P2，但它使官方根级测试门保持红灯，阶段仍不得签发。

### 8.7 P1-07 与外部模型边界

`pnpm --filter @tracepilot/api test` 本轮为 50 项通过、4 项跳过，其中 `phase5-real-reviewer.test.ts` 的 2 个本地完整闭环夹具通过，2 个真实 Omp 场景跳过。显式设置 `TRACEPILOT_PHASE5_REAL_ACK=0` 后运行严格入口，测试在收集阶段按预期报错：

```text
Phase 5 真实 Reviewer 测试需要显式授权：请设置 TRACEPILOT_PHASE5_REAL_ACK=1 后重试。
```

实际为 0 项真实场景执行，没有向 Omp/DeepSeek 外发数据。该门禁行为正确，但不能替代真实 Reviewer 退出证据。P1-09、P1-10 和根级测试红灯关闭前，也没有必要用外部模型结果掩盖本地确定性阻断。

### 8.8 第四轮独立运行结果

运行环境：Windows，Node `v24.18.0`，pnpm `11.16.0`。除构建生成物和本验收报告外，没有修改受版本控制的项目文件；所有 SQLite 语义探针均使用随后删除的临时数据库。

| 命令或探针 | 第四轮结果 |
| --- | --- |
| `pnpm build` | 通过：5 个 workspace 项目全部完成 |
| `pnpm typecheck` | 通过：5 个 workspace 项目全部完成 |
| `pnpm lint` | 通过：5 个 workspace 项目全部完成 |
| `pnpm test` | **失败**：在 Store 包停止；累计 721 项通过、1 项跳过、2 项失败，API 包未进入 |
| Store 包明细 | Core 141 通过；Governance 244 通过、1 跳过；Adapters 248 通过；Store 88 通过、2 失败 |
| `pnpm --filter @tracepilot/api test` | 通过：50 项通过、4 项跳过；真实 Omp/DeepSeek 未执行 |
| `TRACEPILOT_PHASE5_REAL_ACK=0` + `pnpm test:phase5-real` | 按预期失败关闭：0 项执行，未外发数据 |
| `git diff --check` | 通过：无空白错误；只有工作区既有 LF/CRLF 提示 |
| 独立跨项目 SQLite 探针 | **复现 P1-09**：项目 A 默认召回项目 B 任务的 APPROVED 记录 |

### 8.9 第四轮退出条件映射与强制交接

| Phase 5 退出条件 | 第四轮结论 | 原因 |
| --- | --- | --- |
| 独立 Reviewer 接收完整上下文并通过确定性质量门 | **本地满足，真实模型未验证** | 本地完整闭环通过；两项真实 Omp 场景仍按授权门禁跳过。 |
| 人工批准/拒绝与精确 Diff | **本地主要满足** | 既有批准安全边界保持；P2-05 的执行拒绝状态收口仍待定义。 |
| 批准记忆带完整、同项目来源召回 | **不满足** | P1-08 原问题已关闭，但 P1-09 证明项目归属未校验，P1-10 证明更新来源不原子。 |
| 阶段自动质量门全绿 | **不满足** | 根级 `pnpm test` 有 2 个确定性失败。 |
| 兼容性/回归测试缺口被真实 Reviewer 阻止 | **本地夹具满足，真实模型未验证** | P1-07 真实场景尚未获得 Phase 5 单独授权执行。 |

给后续实现 AI 的强制交接：

1. 先关闭 P1-09：把 Task 的项目归属纳入共享可信来源校验、写入失败关闭和升级隔离；不得只在 API 显示层过滤。
2. 再关闭 P1-10：统一重复 ID 更新语义，保证来源身份与内容原子一致或明确拒绝，不能留下混合行。
3. 修复 P2-06 并恢复 Fake/SQLite 同一共享契约；不得删除来源哈希断言或降低可信校验。
4. 由独立 Reviewer 重新运行跨项目探针、重复更新契约、真实升级测试、根级 `pnpm test`、typecheck、lint、build 和 diff check；实现 Agent 不得自己审查或签发。
5. 只有本地 P1 全部关闭且根级门禁全绿后，才可在用户对 **Phase 5 两个合成场景** 单独明确授权外发与模型费用的同一轮，由独立 Reviewer 设置 ACK=1 运行 `pnpm test:phase5-real`。
6. P1-07、P1-09、P1-10 全部关闭前，不得把 README 阶段状态改为通过，不得进入 Phase 6。

**第四轮当前有效结论：Phase 5 暂不通过，不予签发，禁止进入 Phase 6。**

## 9. 第五轮独立复审（2026-08-04）

### 9.1 本轮结论

本轮由未参与实现的独立 Reviewer 继续复核第四轮之后的修复，只检查源码、运行定向测试、全量质量门和独立临时 SQLite 探针，并更新本验收报告。没有修改实现代码、测试、README、ADR 或运行时配置。

第四轮新增的本地阻断已经实质关闭：

- P1-09：可信来源解析器现在加载 Task 并验证 `task.projectId === record.projectId`；公开写入在事务内验证项目、任务及其归属；迁移 8 隔离已经应用迁移 7 后可能遗留的跨项目高可信行；运行时召回继续失败关闭手工脏行。
- P1-10：Repair Record 的 `projectId/taskId` 被定义为不可变身份；同一任务允许原子升级完整 Pack ID/版本/哈希、Diff 和验证来源；跨任务或跨项目覆盖返回结构化 `identity_mismatch` 并回滚。
- P2-06：Fake 与 SQLite 契约现在共用同一份可重算的可信来源 fixture，原来的伪哈希不一致已经消失。

定向测试、全量测试、Build、Typecheck、Lint 和 Diff Check 全部通过；独立 SQLite 探针同时证明公开写入拒绝跨项目组合、手工脏行不被召回、同一任务的重复 ID 可升级至 Pack v2 并正常召回。本轮没有发现新的本地 P1。

但是，P1-07 要求的两个真实 Omp + DeepSeek Reviewer 场景仍然只在普通测试中按设计跳过。本轮没有取得针对 **Phase 5 两个合成场景** 的单独外发与费用授权，因此只以 ACK=0 验证严格入口失败关闭，没有调用外部模型。

因此第五轮结论为：**Phase 5 本地候选通过，但暂不正式签发，不得进入 Phase 6。当前唯一 P1 阻断为 P1-07 的真实 Reviewer 退出证据。**

### 9.2 最新问题状态矩阵

| 编号 | 第五轮状态 | 独立复核结论 |
| --- | --- | --- |
| P1-01 至 P1-06 | **保持关闭** | 全量测试及相关安全回归继续通过，没有发现反证。 |
| P1-07 真实 Reviewer 退出证据 | **唯一未关闭 P1** | 本地完整闭环通过；两个真实 Omp 场景仍按授权门禁跳过，未获得 Phase 5 单独真实运行结果。 |
| P1-08 旧 SQLite 无来源高可信记忆 | **保持关闭** | 迁移 7、共享来源解析和召回纵深防御继续通过。 |
| P1-09 跨项目来源链 | **已关闭** | 写入前项目归属校验、可信召回校验、迁移 8、共享契约及独立脏行探针全部通过。 |
| P1-10 重复 ID 混合来源 | **已关闭** | 身份不可变、完整 Pack 来源原子更新和更新前来源校验成立；共享契约和独立 v1→v2 探针通过。 |
| P2-01 KnowledgeAdapter 共享契约 | **重新关闭** | Fake/SQLite 共用 24 项契约全部通过。 |
| P2-05 执行拒绝状态收口 | **仍未关闭，非本轮阻断** | 第三轮结论继续有效；执行审批返回 rejected 后的产品状态语义仍需在后续明确。 |
| P2-06 Fake 可信来源夹具不一致 | **已关闭** | 两种 Adapter 使用同一可重算 fixture，哈希往返断言恢复通过。 |

### 9.3 P1-09 独立关闭证据

**位置：** `packages/core/src/domain/repair-record.ts:162-212`、`packages/store/src/trusted-repair-record.ts:29-81`、`packages/store/src/sqlite-repair-memory-adapter.ts:83-155`、`packages/store/src/migrations.ts:275-304`、`packages/store/tests/knowledge-adapter-contract.test.ts:396-423`、`packages/store/tests/sqlite-store.test.ts:437-524`。

本轮确认可信链的项目归属已覆盖三个层次：

1. 写入层在 UnitOfWork 内同时加载 Project、Task 和既有 Repair Record。任务不存在返回 `missing_reference`；任务属于其他项目返回 `project_mismatch`。
2. 召回与迁移共用的解析器加载 Task 的 `id/project_id`，Core 领域校验要求 Task ID 和项目均与 Repair Record 精确一致。
3. 迁移 8 使用新版解析器重新扫描高可信行，专门处理数据库已经记录迁移 7、因而不会重跑迁移 7 的升级场景。

独立探针使用项目 A、项目 B 和属于项目 B 的真实 Task/Pack/ExecutionResult。公开写入声明 `projectId=A, taskId=B` 的记录时，实际返回：

```json
{"name":"RepairMemoryWriteError","code":"project_mismatch"}
```

随后绕过公开 Adapter、通过底层 Repository 手工插入同一条 `APPROVED` 脏行。原始 SQL 能查询到该行，但 `KnowledgeAdapter.search({ projectId: "project-a" })` 返回空数组。这证明写入防线与召回纵深防御均成立，而不是仅靠测试夹具避免构造跨项目数据。

升级测试还分别从迁移 6 和迁移 7 构造跨项目高可信行并升级到最新版本，断言记录被降级为 `DEPRECATED`、默认召回为空且重复启动幂等。P1-09 可以正式关闭。

### 9.4 P1-10 独立关闭证据

**位置：** `packages/store/src/sqlite-repositories.ts:652-715`、`packages/store/src/sqlite-repair-memory-adapter.ts:106-144`、`packages/store/tests/knowledge-adapter-contract.test.ts:347-394`、`:425-465`。

SQLite Repository 在更新前读取既有 `project_id/task_id`。同一 Repair Record ID 试图切换任务或项目时返回 `identity_mismatch`；合法的同任务更新则在同一 UPSERT 中同步更新：

- `input_evidence_pack_id`；
- `input_evidence_pack_version`；
- `input_evidence_pack_content_hash`；
- 根因与 Evidence ID；
- Diff、验证和 Review 来源。

`SqliteRepairMemoryAdapter.write()` 对 `VERIFIED/APPROVED` 更新还会在保存前重新加载指定 Pack 版本和同任务 ExecutionResult，调用共享可信来源校验器。新来源不完整时整个事务失败，不会留下第四轮发现的“旧 Pack ID + 新哈希/新 Diff”混合行。

独立探针先写同一任务、Pack v1 的 `APPROVED` 记录，再以相同 ID 更新为 Pack v2、新根因和新 Diff。默认召回的实际结果为：

```json
[{"id":"upgrade","packId":"pack-a","packVersion":2,"rootCause":"新根因","diffHash":"diff-a2"}]
```

共享契约同时覆盖同来源 `VERIFIED→APPROVED`、同任务新 Pack 版本、跨任务/跨项目覆盖拒绝和失败后原记录保持。P1-10 可以正式关闭。

### 9.5 P2-06 与共享契约关闭证据

**位置：** `packages/store/tests/knowledge-adapter-contract.test.ts:44-188`。

契约测试新增 `createTrustedContractFixture()`，为 Fake 和 SQLite 生成相同的 Evidence Pack、可重算 `fnv1a32-*` 内容哈希、ExecutionResult 和 Repair Record 来源字段。Fake 不再原样使用旧的伪哈希，SQLite 也不再单独改写成另一套输入。两种 Adapter 本轮共同通过 24 项契约，因此 P2-06 关闭，P2-01 重新关闭。

### 9.6 第五轮独立运行结果

运行环境：Windows，Node `v24.18.0`，pnpm `11.16.0`。普通测试和独立 SQLite 探针均未调用外部模型；所有探针数据库均在结束后删除。

| 命令或探针 | 第五轮结果 |
| --- | --- |
| Core 来源校验定向测试 | 19 项通过 |
| Store 契约与 SQLite 升级定向测试 | 51 项通过 |
| `pnpm test` | 通过：782 项通过、5 项跳过；其中 4 项为真实模型场景，1 项为平台相关路径测试 |
| `pnpm build` | 通过：5 个 workspace 项目全部完成 |
| `pnpm typecheck` | 通过：5 个 workspace 项目全部完成 |
| `pnpm lint` | 通过：5 个 workspace 项目全部完成 |
| `git diff --check` | 通过：无空白错误；只有工作区既有 LF/CRLF 提示 |
| `TRACEPILOT_PHASE5_REAL_ACK=0` + `pnpm test:phase5-real` | 按预期失败关闭：0 项执行，未外发数据 |
| 独立跨项目公开写入探针 | 通过：返回 `project_mismatch`，未写入记录 |
| 独立跨项目脏行召回探针 | 通过：底层可见，可信召回为空 |
| 独立重复 ID 来源升级探针 | 通过：正常召回 Pack v2、新根因和新 Diff |

### 9.7 第五轮退出条件映射

| Phase 5 退出条件 | 第五轮结论 | 原因 |
| --- | --- | --- |
| 独立 Reviewer 接收完整 Pack、Diff、验证和验收条件 | **本地满足，真实模型未验证** | 本地真实 Git/worktree/SQLite/API 闭环通过；真实 Omp 场景仍跳过。 |
| P0-P3 与确定性质量门 | **本地满足** | 完整 schema、分类门和失败关闭测试继续通过。 |
| 人工批准/拒绝且不可绕过 | **本地满足阶段主条件** | 服务端身份、一次性挑战、精确 Diff 和任务级关键区测试通过；P2-05 仅影响执行审批拒绝后的流程体验。 |
| APPROVED Repair Memory 带完整且同项目来源 | **满足** | P1-08、P1-09、P1-10 均已关闭，升级、写入、召回和独立探针一致。 |
| 人为兼容性/回归测试缺口被 Reviewer 阻断 | **本地夹具满足，真实模型未验证** | 两个完整本地闭环通过；真实 Omp Reviewer 尚未独立执行。 |
| 本地自动质量门 | **满足** | 782 项通过、5 项设计性跳过，Build/Typecheck/Lint/Diff Check 全绿。 |

### 9.8 唯一剩余 P1 与后续 AI 强制交接

当前唯一 P1 是 P1-07。后续不得继续无目标修改本地实现，也不得由实现 Agent 自己运行真实模型后自行签发。

正式签发所需步骤：

1. 用户必须针对 **Phase 5 的两个合成 Git 场景** 明确授权把内容发送给 DeepSeek，并接受本次真实模型调用费用；Phase 4 的历史授权不得自动沿用。
2. 由未参与实现的独立 Reviewer 在同一轮设置 `TRACEPILOT_PHASE5_REAL_ACK=1`，运行 `pnpm test:phase5-real`；不得修改测试以迁就模型输出。
3. 报告必须记录实际模型、两项场景是否执行、finding 的 `compatibility/regression_test` 分类、质量门阻断结果、任务最终状态、Repair Record 状态、人工挑战未签发以及真实跳过数量。任何密钥值不得写入报告。
4. 两项真实场景均通过后，才可关闭 P1-07，由独立 Reviewer 把本报告顶部结论和 README 阶段状态改为正式通过，并签发进入 Phase 6。
5. 任一场景失败、仍被跳过或退出证据不完整，Phase 5 必须继续保持暂不通过，并把失败原因登记为新的 P1 修复项。
6. P2-05 可在不削弱现有安全门的前提下后续整改，但不得与 P1-07 的真实验收混淆。

**第五轮当前有效结论：Phase 5 本地候选通过；因 P1-07 尚无真实 Omp Reviewer 证据，暂不正式签发，禁止进入 Phase 6。**

## 10. 第六轮真实验收尝试（2026-08-04）

### 10.1 授权范围

用户已在本轮明确授权：

> 同意将 Phase 5 的两个合成 Git 场景发送给 DeepSeek，并接受本次模型调用费用。

该授权只覆盖 `apps/api/tests/phase5-real-reviewer.test.ts` 动态生成的兼容性和缺少回归测试两个合成 Git 场景，不包含真实业务仓库、用户数据或凭据外发。验收命令不得打印或记录 `DEEPSEEK_API_KEY`。

### 10.2 实际运行结果：环境启动阻断，0 项测试执行

独立 Reviewer 在仓库根设置 `TRACEPILOT_PHASE5_REAL_ACK=1` 并运行：

```powershell
pnpm test:phase5-real
```

命令尚未完成 Vitest 配置加载即失败，关键错误为：

```text
failed to load config from D:\agent\TracePilot\apps\api\vitest.config.ts
Error: spawn EPERM
  at ensureServiceIsRunning (...\esbuild\lib\main.js)
Test Files 0
```

本次结果不是用例失败：两个本地夹具和两个真实场景均未开始，Omp 未启动，DeepSeek 未收到合成内容，也没有发生模型调用费用。随后请求以非沙箱方式执行同一命令，但当前会话权限策略明确禁止沙箱升级，命令在启动前被环境拒绝。

为排除“只是不允许 esbuild”这一局部原因，本轮又运行最小只读探针，让 Node 执行 `spawnSync("git", ["--version"])`。实际同样返回：

```json
{"status":null,"error":{"code":"EPERM","message":"spawnSync git EPERM"}}
```

这证明当前 Codex 沙箱禁止 Node 创建通用子进程。生产 `OmpAdapter` 同样依赖 Node 启动 `omp.exe`，因此不能通过更换 Vitest 配置在本会话内完成等价真实验收；绕过生产 Adapter、手工单独调用模型也不能满足 P1-07 的真实 API/持久化闭环退出条件。

### 10.3 当前有效验收状态

| 项目 | 第六轮状态 |
| --- | --- |
| Phase 5 合成场景外发与费用授权 | **已满足** |
| P1-01 至 P1-06、P1-08 至 P1-10 | **保持关闭** |
| 本地自动质量门 | **候选通过：782 项通过、5 项设计性跳过** |
| P1-07 真实 Reviewer 执行 | **未完成：当前 Codex 沙箱 `spawn EPERM`** |
| 本次真实模型调用 | **0 次；未外发数据** |
| Phase 5 正式签发 | **不允许** |

环境阻断不应登记为新的代码 P1，也不能被解释为真实验收通过。P1-07 当前状态从“未授权”更新为“已授权、待在允许 Node 子进程和网络调用的普通本机终端执行”。

### 10.4 普通 PowerShell 的唯一后续命令

请在 Codex 沙箱之外的普通 PowerShell 中执行：

```powershell
Set-Location D:\agent\TracePilot
$env:TRACEPILOT_PHASE5_REAL_ACK = "1"
pnpm test:phase5-real
```

测试会从仓库 `.env` 读取 `TRACEPILOT_OMP_PATH` 与 `DEEPSEEK_API_KEY`，不需要也不得把密钥粘贴到聊天或报告。有效签发证据必须满足：

1. 命令退出码为 0；
2. 文件中的 4 项测试全部通过、0 项跳过，其中 2 项为本地闭环夹具，2 项为真实 Omp Reviewer 场景；
3. 真实兼容性场景产生 `compatibility` finding，真实缺少回归测试场景产生 `regression_test` finding；
4. 两项均被确定性质量门阻断，任务最终为 `FAILED`，Repair Record 为 `DRAFT`，人工挑战返回 409；
5. 完整终端输出交回独立 Reviewer 核验，不能只提供“运行成功”的口头结论。

收到完整输出后，独立 Reviewer 才能关闭 P1-07、更新本报告和 README 为正式通过，并签发进入 Phase 6；若命令失败，则按实际失败原因登记新的 P1。

**第六轮当前有效结论：Phase 5 本地候选通过，真实测试授权已满足；因当前 Codex 沙箱阻止 Node 子进程，P1-07 尚未取得真实运行证据，暂不正式签发，禁止进入 Phase 6。**

## 11. 第七轮真实 Omp + DeepSeek 验收（2026-08-04）

### 11.1 真实运行结果

用户在 Codex 沙箱之外的普通 PowerShell 中运行：

```powershell
Set-Location D:\agent\TracePilot
$env:TRACEPILOT_PHASE5_REAL_ACK = "1"
pnpm test:phase5-real
```

本次命令成功启动 Vitest、Git、Omp 和 DeepSeek，严格入口不再跳过真实场景。实际结果为：

| 场景 | 结果 | 用时 |
| --- | --- | --- |
| 本地 compatibility 完整闭环夹具 | 通过 | 536 ms |
| 本地 regression_test 完整闭环夹具 | 通过 | 429 ms |
| 真实 Omp compatibility | **失败** | 31,014 ms |
| 真实 Omp regression_test | **失败** | 56,747 ms |

测试文件汇总为 **2 项通过、2 项失败、0 项跳过**，总用时约 89.48 秒。Omp 本地日志确认两个会话实际使用 provider `deepseek`、model `deepseek-v4-flash`，均正常结束并包含 assistant 文本；因此这不是前置条件、网络、凭据或模型未调用问题。本轮确实发生了两次真实模型调用，具体费用未由测试输出导出。

两个真实场景均在同一断言失败：

```text
expected false to be true
body.findings.some((finding) => finding.category === expectedCategory)
```

其中 compatibility 场景没有返回可观察的 `compatibility` finding，regression_test 场景也没有返回可观察的 `regression_test` finding。API 的 HTTP 422 断言已经先行通过，说明系统至少保守阻断了 Review；但测试在分类断言处停止，后续的 `qualityGate.passed=false`、Task=`FAILED`、Repair Record=`DRAFT` 和人工挑战 409 并未在这次真实运行中完成断言，不能视为已取得退出证据。

### 11.2 P1-11：真实 Omp Review 的 NDJSON 外层被误解析为 ReviewResult

**位置：** `packages/adapters/src/omp-adapter.ts:432-448`、`:499-524`、`:1242-1285`、`:1555-1610`，`packages/adapters/tests/omp-adapter.test.ts:653-812`，`apps/api/tests/phase5-real-reviewer.test.ts:431-468`。

`OmpAdapter` 固定以 `--mode json` 启动 Omp。仓库现有实现和测试都已经确认该模式返回 NDJSON 事件流，assistant 最终文本位于：

```text
message_end.message.role = assistant
message_end.message.content[].type = text
message_end.message.content[].text = 模型输出
```

develop 路径的 `extractFileChangesFromStdout()` 已正确逐行解析 NDJSON，并从 `message_end` 提取 assistant 文本；但 review 路径没有复用等价逻辑。`review()` 直接执行：

```ts
extractReviewResult(result.stdout, input)
```

`extractReviewResult()` 先尝试把整段 stdout 作为单一 JSON；失败后只扫描 stdout 中第一个平衡花括号对象。真实 NDJSON 的第一个对象是 `session` 事件，不含 `verdict`。解析器因此立即返回：

```json
{
  "verdict": "block",
  "findings": [{
    "priority": "P1",
    "confidence": 1,
    "category": "other",
    "message": "omp review 输出不符合严格 Review schema：verdict 缺失或非法"
  }]
}
```

本轮又使用当前构建产物执行独立解析探针：构造真实 Omp 形状的 `session → message_end → turn_end` NDJSON，并在 `message_end` 文本内放入一个完全合法、包含 `category=compatibility` 的 ReviewResult。当前 `extractReviewResult()` 的实际输出仍是上述 `block/P1/other`。这证明即使 DeepSeek 已经正确识别兼容性问题，适配器也会在外层事件解析阶段丢失语义分类。

该缺陷是失败关闭而不是失败开放，所以不会错误批准候选 Diff；但它使所有真实 Review 都可能退化为无法解释的通用阻断，真实分类、根因和 Repair Memory 来源无法进入 Phase 5 闭环。因此按 P1 阻断，编号 **P1-11**。

Phase 4 的真实测试只断言 review verdict 属于 `ship/ship_with_fixes/block`；通用回退结果同样满足该断言。因此此前 Phase 4 的受控修改、验证和 Diff 安全结论不因本项自动撤销，但其 review 枚举断言不能作为 Phase 5 语义 Reviewer 的真实证据。

### 11.3 P1-11 强制修复要求

1. 为 Omp NDJSON 建立一个共享、只读的 assistant 文本提取器：逐行解析 `message_end`，只接受 `role=assistant` 的 `content[type=text].text`，按消息与内容顺序组合；不得把 `session`、thinking、tool 或 `turn_end` 外层事件当成 ReviewResult。
2. `review()` 必须先从 NDJSON 提取最终 assistant 文本，再对该文本执行严格 ReviewResult JSON 解析和现有 schema 校验。没有 assistant 文本、存在歧义、JSON 不完整或 schema 非法时继续失败关闭为 `block/P1/other`。
3. 增加真实 Omp 形状的 Adapter 单元测试：至少覆盖 `session → message_end(valid compatibility JSON) → turn_end`、`regression_test`、多个 text block、thinking block、多个 assistant 消息、非 JSON 文本和缺少 terminal assistant 消息。现有只把 stdout 直接构造成 ReviewResult JSON 的测试不能替代 NDJSON 契约。
4. 禁止通过把 `other` 映射为预期类别、根据场景名伪造 finding、删除分类断言或放宽 schema 让测试变绿。分类必须来自模型最终 assistant ReviewResult。
5. 真实验收失败时应在不泄露 prompt、凭据和业务数据的前提下打印或保存脱敏后的 verdict、finding categories/messages 和 schema fallback reason。当前只输出 `expected false`，诊断信息不足；该可观测性缺口登记为 **P2-07**。
6. 修复后先由实现 Agent 运行本地 Adapter 测试、Phase 5 本地夹具和全量质量门；实现 Agent 不得自行修改验收报告为通过。
7. 再由独立 Reviewer取得新一轮两次模型调用费用授权，运行 `pnpm test:phase5-real`。必须得到 4 项通过、0 项跳过，并逐项验证真实分类、质量门、Task/Repair Record 终态和人工挑战。

### 11.4 第七轮问题状态

| 编号 | 第七轮状态 | 结论 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-10 | **保持关闭** | 本轮真实失败没有提供这些边界回退的证据。 |
| P1-07 真实 Reviewer 退出证据 | **未关闭** | 两个真实场景均执行但失败，不能签发。 |
| P1-11 Omp Review NDJSON 解析错误 | **新增，未关闭** | 外层 `session` 被当作 ReviewResult，真实 assistant 分类被丢失。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 历史非阻断项继续有效。 |
| P2-07 真实测试失败诊断不足 | **新增，未关闭** | 失败输出没有显示实际 categories/messages 或 fallback reason。 |

### 11.5 后续 AI 强制交接

1. 只修复 P1-11 及其 NDJSON 单元/集成测试，同时补齐 P2-07 的脱敏诊断；不得改变两个合成场景、预期类别或质量门规则。
2. 本次真实失败必须保留在报告中，后续成功不得删除或覆盖该审计历史。
3. 修复完成后由独立 Reviewer先审查源码和本地门禁；没有新的 P1 时，再请求用户授权额外两次 DeepSeek 调用。
4. 真实复跑结果必须记录 model、4 项用例结果、0 跳过、两个预期 category、质量门、Task 状态、Repair Record 状态和人工挑战结果。
5. 只有 P1-11 修复且 P1-07 真实复跑通过后，才能正式签发 Phase 5 并进入 Phase 6。

**第七轮当前有效结论：Phase 5 不通过。真实 Omp + DeepSeek 已执行，但 2 个真实场景均因 P1-11 的 NDJSON ReviewResult 解析缺陷失败；不予签发，禁止进入 Phase 6。**

## 12. 第八轮 P1-11 修复后独立复核（2026-08-05）

### 12.1 源码复核结果

本轮只审查实现方在第七轮后提交的候选修复，独立 Reviewer 未修改实现或测试代码。复核确认：

1. `extractAssistantTextFromOmpNdjson()` 已成为 review/develop 共用的只读解析器，只按事件顺序读取 `message_end.message.role=assistant` 下 `content[type=text].text`；`session`、thinking、toolResult 和 `turn_end` 不会被当作 ReviewResult。
2. `extractReviewResult()` 会先提取真实 Omp NDJSON 中的 assistant 文本，再执行严格 JSON 和 Review schema 校验；没有 assistant 文本、非 JSON、非法 verdict/finding/category/confidence 等情况继续失败关闭为 `block/P1/other`。
3. 解析器没有依据场景名伪造 finding、没有把 `other` 映射成 `compatibility` / `regression_test`，真实验收中的类别断言和质量门终态断言均保留。
4. Adapter 测试新增真实形状的 `session → message_end → turn_end` 覆盖，包括 compatibility、regression_test、多个 assistant/text block、thinking/toolResult 排除、非 JSON 和缺少 assistant message。
5. 真实验收失败路径新增脱敏诊断，输出 verdict、finding categories/messages 和 fallback reason；但当前没有直接自动化测试验证诊断触发、截断及脱敏效果，因此 P2-07 只视为候选修复。

未发现通过放宽 schema、删除断言或修改两个合成场景来规避第七轮失败的行为，也未发现新的 P1。

### 12.2 独立本地门禁证据

独立 Reviewer 在不设置 `TRACEPILOT_PHASE5_REAL_ACK` 的情况下运行以下命令；本轮没有调用 DeepSeek，也没有新增模型费用：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @tracepilot/adapters test` | 8 个文件、252 项全部通过；其中 `omp-adapter.test.ts` 76 项通过 |
| `pnpm test` | **786 项通过、5 项按设计跳过**；Phase 5 本地两个场景通过，真实两个场景跳过 |
| `pnpm build` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `git diff --check` | 通过；仅有工作区既有 LF/CRLF 提示 |

全仓测试分布为 Core 142、Governance 244、Adapters 252、Store 98、API 50，共 786 项通过。5 项跳过中包含 Phase 4 的 2 项真实用例、Phase 5 的 2 项真实用例和 1 项平台相关路径用例；未设置真实授权变量时 Phase 5 测试保持跳过，符合费用门禁。

### 12.3 第八轮问题状态

| 编号 | 第八轮状态 | 结论 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-10 | **保持关闭** | 本轮本地全量门禁未见回退。 |
| P1-07 真实 Reviewer 退出证据 | **未关闭** | 修复后尚未取得 4 项通过、0 项跳过的真实复跑证据。 |
| P1-11 Omp Review NDJSON 解析错误 | **本地关闭，待真实确认** | 源码、76 项 Adapter 测试和全量门禁均支持修复成立；最终关闭并入 P1-07 的真实复跑。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 历史非阻断项继续有效。 |
| P2-07 真实测试失败诊断不足 | **候选修复，仍未关闭** | 已实现脱敏诊断，但缺少直接验证输出与脱敏效果的测试。 |

### 12.4 下一次真实验收要求

第七轮授权对应的两次真实模型调用已经实际发生，不能自动扩展为修复后的新调用。继续真实复验前必须重新取得用户对以下内容的明确授权：

- 将相同的两个合成 Git 场景发送给 DeepSeek；
- 接受新增两次真实 Reviewer 调用费用。

授权后仍使用：

```powershell
Set-Location D:\agent\TracePilot
$env:TRACEPILOT_PHASE5_REAL_ACK = "1"
pnpm test:phase5-real
```

有效结果必须为 **4 项通过、0 项跳过**，且两个真实场景分别产生 `compatibility` 与 `regression_test` finding，同时验证质量门失败、Task=`FAILED`、Repair Record=`DRAFT`、持久化状态一致和人工挑战返回 409。任何失败都必须保留脱敏诊断并重新进入独立复核。

**第八轮当前有效结论：P1-11 已通过本地独立复核，没有发现新的 P1；Phase 5 仍为暂不通过，原因仅剩修复后的真实 Reviewer 退出证据 P1-07 未取得。不予签发，禁止进入 Phase 6。**

## 13. 第九轮修复后真实 Omp + DeepSeek 验收（2026-08-05）

### 13.1 授权与真实运行结果

用户已明确同意将修复后的两个合成 Git 场景发送给 DeepSeek，并接受新增两次模型调用费用。独立 Reviewer 随后执行：

```powershell
$env:TRACEPILOT_PHASE5_REAL_ACK = "1"
pnpm test:phase5-real
```

本轮没有启动额外调用；严格测试中的两个真实场景各调用一次 DeepSeek。实际结果为：

| 场景 | 结果 | 关键证据 |
| --- | --- | --- |
| 本地 compatibility 闭环夹具 | 通过 | Git、验证、SQLite、API 和质量门均执行 |
| 本地 regression_test 闭环夹具 | 通过 | Git、验证、SQLite、API 和质量门均执行 |
| 真实 Omp compatibility | **失败** | findings 只有 `category=other` |
| 真实 Omp regression_test | **失败** | findings 只有 `category=other` |

测试汇总为 **2 项通过、2 项失败、0 项跳过**，总用时约 77.84 秒，命令退出码 1。两个真实场景均在 `assertReviewBlocked()` 的预期 category 断言失败；HTTP 422 已先通过，但后续质量门、Task、Repair Record、持久化和人工挑战断言未执行完毕，不能作为 Phase 5 退出证据。

Omp 日志确认两次会话均实际使用 provider `deepseek`、model `deepseek-v4-flash`，正常 `stop`，最终消息均为 `hasText=true`：

- compatibility 会话：`019fcfba-4f40-7000-b0c4-d69461ee2e72`；
- regression_test 会话：`019fcfba-ac57-7000-8632-33e5e51a7594`。

本地 `client_usage` 表仍没有对应费用记录，因此报告只能确认两次真实调用已经发生，不能给出可信的精确金额。

### 13.2 P2-07 已由真实失败路径关闭

本轮新增的脱敏诊断在两个失败场景中均实际触发，输出了 verdict、finding categories/messages 和 fallback reason，没有输出 prompt、API key、worktree 绝对路径或合成仓库内容。两个场景的共同诊断为：

```text
verdict=block
findingCategories=["other"]
reason=terminal assistant message 缺少非空 text 内容
```

因此 P2-07 不再只是候选实现，现按真实失败证据关闭。它也把第七轮笼统的 `expected false` 推进为可定位的适配器输出问题。

### 13.3 P1-12：Review 最终 assistant 输出未进入保留的 stdout

**位置：** `apps/api/src/composition-root.ts:288-294`、`packages/adapters/src/local-process-runner.ts:78-106`、`packages/adapters/src/omp-adapter.ts:435-448`、`:1254-1344`。

当前 Review 仍使用 Omp `--mode json`。该模式输出 session header 和完整事件流；Omp 官方 `print-mode.ts` 也明确区分：JSON 模式输出全部事件，而 text 模式只输出最终 assistant 的 text block。官方当前源码还专门删除 `message_update` 中重复的 partial snapshot，并说明旧行为会让长 turn 产生极大的日志：<https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/print-mode.ts>。

TracePilot 的组合根把 Omp `maxOutputBytes` 固定为 256 KiB。`LocalProcessRunner` 超限后只保留 stdout **头部**，后续数据全部丢弃；但 `OmpAdapter.review()` 没有检查 `result.truncated`、`originalBytes` 或 `retainedBytes`，直接把保留片段交给 Review 解析器。于是前部可能仍包含 assistant 的 tool-call/thinking `message_end`，却没有位于事件流末尾的最终 text ReviewResult。本轮真实诊断中的“找到了 assistant message、但没有非空 text”与该路径完全一致，而 Omp 自身日志同时确认最终消息实际 `hasText=true`。

独立 Reviewer 又运行了无网络截断探针：构造约 1,037,301 字节的真实形状 NDJSON，在前部放置无 text 的 assistant tool-call，在末尾放置合法 `category=compatibility` ReviewResult，再按生产配置只保留前 262,144 字节。当前构建产物实际得到：

```json
{
  "originalBytes": 1037301,
  "retainedBytes": 262144,
  "finalRetained": false,
  "verdict": "block",
  "category": "other",
  "reason": "terminal assistant message 缺少非空 text 内容"
}
```

该探针与两个真实场景的失败原因一致。由于当前真实测试没有把 `result.truncated/originalBytes/retainedBytes` 写入脱敏诊断，尚不能仅凭终端输出证明本次两个 stdout 的精确原始字节数；但“最终文本未进入解析器”已经由真实运行确认，而未检查截断、只保留头部的生产路径足以构成独立 P1。编号 **P1-12**。

### 13.4 P1-12 强制修复要求

1. **推荐方案：Review 改用 Omp `--mode text`。** Review 只需要最终结构化 JSON，不需要 analyze/develop 的全量事件流；text 模式可直接输出最终 assistant text，避免事件流膨胀和尾部丢失。analyze/develop 继续使用 JSON 模式，不得一并破坏其事件与文件修改协议。
2. 无论采用 text 还是 JSON，`review()` 都必须检查 `result.truncated`。截断时不得把不完整输出当作 ReviewResult；必须失败关闭并在脱敏诊断中记录 `truncated/originalBytes/retainedBytes`。
3. 若继续使用 JSON 模式，必须实现有界但保留终端事件的捕获策略，并从 terminal `message_end`、`turn_end.message` 或 `agent_end.messages` 中确定性选择最终 assistant text；不能继续只保留 stdout 头部，也不能简单无限提高内存上限。
4. 增加超过 256 KiB 的真实形状 NDJSON 回归测试：最终合法 ReviewResult 位于尾部，前部存在 assistant tool-call/thinking message；不得再返回误导性的 `terminal assistant message 缺少非空 text 内容`。
5. 增加 `result.truncated=true` 的 `OmpAdapter.review()` 测试，验证失败关闭和脱敏指标；同时保留未截断 compatibility/regression_test 正常解析测试。
6. 真实门禁不得删除 category 与终态断言，不得根据场景名补造 finding。实现 Agent 只能提交自测证据，不能自行关闭 P1-12 或签发 Phase 5。
7. 修复后先完成 Adapter、全仓 test/build/typecheck/lint，再由独立 Reviewer 重新审查；下一次真实模型调用仍需取得新的、单独的用户授权。

### 13.5 第九轮问题状态

| 编号 | 第九轮状态 | 结论 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-10 | **保持关闭** | 本轮没有这些边界回退的证据。 |
| P1-07 真实 Reviewer 退出证据 | **未关闭** | 修复后真实门禁仍为 2 通过、2 失败。 |
| P1-11 Omp NDJSON 外层解析 | **局部关闭** | 不再误解析首个 session，但真实最终文本仍不可达，不能单独作为阶段通过证据。 |
| P1-12 Review 最终输出丢失/截断未治理 | **新增，未关闭** | 两个真实场景均降级为“assistant 无 text”；生产路径未检查 256 KiB 头部截断。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 历史非阻断项继续有效。 |
| P2-07 真实测试失败诊断不足 | **关闭** | 本次两个真实失败均输出了有效脱敏诊断。 |

**第九轮当前有效结论：Phase 5 不通过。两次新增真实 Omp + DeepSeek 调用均已发生，但两个真实场景仍失败；新增 P1-12，必须先治理 Review 输出模式/截断并取得新的真实复跑证据。不予签发，禁止进入 Phase 6。**

## 14. 第十轮 P1-12 修复后本地独立复核（2026-08-05）

### 14.1 源码复核结果

本轮独立 Reviewer 只审查实现方提交的 P1-12 候选修复，没有修改实现或测试代码。复核确认：

1. `buildOmpArgv()` 现在按阶段固定输出模式：analyze/develop 使用 `--mode json`，review 使用 `--mode text`；review 同时强制 `--no-tools`，只消费 prompt 中已经冻结的 Evidence Pack、Diff 和验证结果。
2. `validateOmpArgv()` 已把 review 的 text 模式纳入受控 argv 拓扑；既有 `--no-session`、`--no-extensions`、`--no-skills`、`--no-rules`、模型、超时、cwd 和审批模式约束均未回退。
3. `review()` 在退出码检查后、解析前检查 `result.truncated`。任何 stdout/stderr 截断都会失败关闭为 `block/P1/other`，并只记录 `truncated`、`originalBytes`、`retainedBytes` 三个脱敏指标，不解析不完整结果。
4. 未截断的 text stdout 通过 `parseReviewResultText(..., allowEmbeddedJson=false)` 严格解析；额外说明、Markdown 围栏、非 JSON 或非法 schema 不会被宽松扫描为可接受 ReviewResult。
5. 新增测试验证 review argv 为 `--mode text --no-tools`、合法 JSON 正常解析、`truncated=true` 失败关闭并携带三个指标，以及超过 256 KiB 的 NDJSON 尾部解析能力；原 compatibility/regression_test 分类断言和真实闭环终态断言均保留。
6. analyze/develop 仍使用 JSON 事件流，develop 的 `<file_change>` 受控写入协议没有被 text 模式改动。

没有发现根据场景名伪造 finding、把 `other` 映射为目标类别、删除真实断言或简单无限提高输出上限的行为，也没有发现新的 P1。

### 14.2 独立本地门禁证据

独立 Reviewer 未设置 `TRACEPILOT_PHASE5_REAL_ACK`，因此本轮没有调用 DeepSeek，也没有新增模型费用。实际执行结果：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @tracepilot/adapters test` | 8 个文件、**254 项通过**；`omp-adapter.test.ts` 78 项通过 |
| `pnpm test` | **788 项通过、5 项按设计跳过** |
| `pnpm build` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `git diff --check` | 通过；仅有既有 LF/CRLF 提示 |

全仓测试分布为 Core 142、Governance 244、Adapters 254、Store 98、API 50，共 788 项通过。5 项跳过仍为 Phase 4 两个真实用例、Phase 5 两个真实用例和一个平台相关路径用例；费用门禁未回退。

### 14.3 第十轮问题状态

| 编号 | 第十轮状态 | 结论 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-10 | **保持关闭** | 全量门禁未见安全与持久化边界回退。 |
| P1-07 真实 Reviewer 退出证据 | **未关闭** | text 模式修复后尚未取得 4 项通过、0 项跳过的真实证据。 |
| P1-11 Omp NDJSON 外层解析 | **关闭** | 生产 Review 已不再消费 NDJSON 外层事件。 |
| P1-12 Review 最终输出丢失/截断未治理 | **本地关闭，待真实确认** | review 改用 text，截断强制失败关闭，相关 Adapter 与全量测试通过。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 历史非阻断项继续有效。 |
| P2-07 真实测试失败诊断不足 | **保持关闭** | 第九轮真实失败已验证脱敏诊断。 |

### 14.4 下一步真实验收要求

第九轮授权对应的两次真实调用已经实际发生，本轮本地复核没有扩展该授权。再次复验前必须重新取得用户明确同意：

- 将相同两个合成 Git 场景发送给 DeepSeek；
- 接受新增两次真实 Reviewer 调用费用。

授权后运行 `pnpm test:phase5-real`，有效签发证据仍必须满足：4 项通过、0 项跳过；真实 compatibility/regression_test finding 均存在；质量门失败；Task=`FAILED`；Repair Record=`DRAFT`；SQLite 持久化一致；人工挑战返回 409。若 text 模式输出仍失败，必须保留脱敏诊断并重新登记实际根因，不能自动回退到 JSON 事件流或放宽断言。

**第十轮当前有效结论：P1-11 已关闭，P1-12 已通过本地独立复核，没有发现新的 P1；Phase 5 仍暂不通过，唯一 P1 阻断为 P1-07 的修复后真实 Reviewer 退出证据尚未取得。不予签发，禁止进入 Phase 6。**

## 15. 第十一次 text 模式真实 Omp + DeepSeek 验收（2026-08-05）

### 15.1 普通本机终端真实运行结果

用户已再次明确同意外发 Phase 5 的两个合成 Git 场景并接受新增两次模型调用费用，随后在 `D:\agent\TracePilot` 的普通 PowerShell 终端设置 `TRACEPILOT_PHASE5_REAL_ACK=1` 并运行 `pnpm test:phase5-real`。本次没有跳过真实分支，实际结果为：

| 场景 | 结果 | 用时 | 关键诊断 |
| --- | --- | ---: | --- |
| 本地 compatibility 夹具 | 通过 | 624 ms | Git、验证、SQLite、API 和质量门闭环通过 |
| 本地 regression_test 夹具 | 通过 | 514 ms | Git、验证、SQLite、API 和质量门闭环通过 |
| 真实 compatibility | **失败** | 32.572 s | 返回了 `block`，但 finding 降级为 `other`；严格 schema 拒绝字符串型 `confidence` |
| 真实 regression_test | **失败** | 42.910 s | 返回了 `block`，但 finding 降级为 `other`；assistant 文本不是完整 ReviewResult JSON |

Vitest 汇总为 **2 项通过、2 项失败、0 项跳过**，测试执行 76.62 秒，总持续时间 77.51 秒，命令退出码 1。两个真实场景都在 `assertReviewBlocked()` 的预期 category 断言处失败；HTTP 422 断言已经通过，但其后的质量门、Task=`FAILED`、Repair Record=`DRAFT`、SQLite 往返和人工挑战 409 断言没有完整执行，因此不能作为 P1-07 的退出证据。

本次两条脱敏诊断都包含非空 assistant 文本对应的解析/校验错误，而不是 P1-12 的“terminal assistant message 缺少 text”或截断错误。这证明 review 的 `--mode text --no-tools` 传输路径已真实生效，P1-12 可以关闭；失败已推进到 ReviewResult 内容契约层。

### 15.2 P1-13：Review prompt 与严格 schema 的 `confidence` 类型互相矛盾

这是可由源码和真实输出共同确认的确定性缺陷：

- `packages/adapters/src/omp-adapter.ts` 的输出示例通过 `JSON.stringify()` 生成，并把 `findings[].confidence` 写成字符串 `"0.0-1.0"`；`rootCause.confidence` 同样展示为说明性字符串。
- 同文件严格归一化器要求 `findings[].confidence` 必须是 JavaScript `number`、有限且位于 0 到 1；字符串一律失败关闭。
- 真实 compatibility 场景已经返回可解析对象，但恰好因 `findings[0].confidence` 不是数字而被严格 schema 拒绝。这不是模型没有发现问题，而是平台提供的 JSON 示例与平台自己的接收契约不一致。

因此新增 **P1-13**。严格解析器拒绝错误类型是正确行为，不得通过把数字字符串静默强制转换为数字来掩盖提示词契约错误。

**P1-13 强制修复要求：**

1. 把输出部分改成真正可提交的合法 ReviewResult 示例：`confidence` 使用数字字面量，例如 `0.95`；枚举字段使用单个合法值，不得在 JSON 值中写 `"P0 | P1 | ..."` 这类说明字符串。
2. 在示例外明确写明 `findings[].confidence` 与 `rootCause.confidence` 均为不加引号的 JSON number，取值范围为 `[0,1]`；布尔值也必须使用 JSON boolean。
3. 增加 prompt 契约测试，直接断言生成的示例可被严格 ReviewResult schema 接受，并断言输出不再包含 `confidence: "0.0-1.0"` 一类错误类型。
4. 保留严格类型校验；不得把字符串 confidence、非法枚举或缺失 category 宽松归一化为有效结果。

### 15.3 P1-14：真实 text 输出缺少有界封装兼容与可定位诊断

regression_test 的真实调用已经成功返回 assistant 文本，但 `JSON.parse(text.trim())` 失败；生产路径设置 `allowEmbeddedJson=false` 后直接回退为通用 `other`。现有脱敏诊断只能证明“文本不是完整 JSON”，不能区分以下几类常见且修复方式不同的情况：恰好一层 Markdown JSON 围栏、JSON 前后附带说明、内容在语义上未闭合、或其他语法错误。

严格失败关闭不能放宽，但仅依赖一次自然语言指令保证裸 JSON，在两个阶段退出场景中已经实证不可靠；同时丢弃错误形态会让下一轮付费复验仍只能猜测。因此新增 **P1-14**。

**P1-14 强制修复要求：**

1. 优先使用 Omp/模型链路可用的原生结构化输出约束；如果当前接口不支持，则只允许确定性、有限的传输层归一化：可去除首尾空白和**恰好一层**完整的 Markdown JSON 代码围栏，然后仍对完整内部文本执行严格 JSON/schema 校验。
2. 不得恢复“扫描第一个平衡花括号”、从任意说明文字中抽取对象、按场景名补造 category，或把解析失败结果当作目标 finding；任一歧义继续失败关闭。
3. 在不记录 prompt、diff 或模型原文的前提下增加形态诊断：stdout UTF-8 字节数、是否以 JSON 围栏开头/结尾、JSON 解析错误类别或位置、`truncated` 及保留字节数。诊断必须脱敏且有长度上限。
4. 增加测试覆盖：裸 JSON 通过；单层完整 JSON 围栏按既定策略通过；任意前后说明文字、双重围栏、不完整 JSON、非法 schema 继续失败关闭；诊断不泄露模型原文。
5. 不得自动增加付费重试。若未来引入模型重试，必须另行设计调用上限、幂等性、费用门禁与用户授权，不能纳入本次修复的隐式行为。

### 15.4 第十一次问题状态

| 编号 | 第十一次状态 | 结论 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-10 | **保持关闭** | 本轮没有这些安全、持久化与质量门边界回退的证据。 |
| P1-07 真实 Reviewer 退出证据 | **未关闭** | 真实分支确已执行且 0 项跳过，但两个目标场景均失败，未达到 4 项通过。 |
| P1-11 Omp NDJSON 外层解析 | **保持关闭** | Review 已真实走 text 模式，不再误解析 NDJSON session 事件。 |
| P1-12 Review 最终输出丢失/截断未治理 | **关闭** | 两个真实调用均取得 assistant 文本并进入 JSON/schema 解析；本次没有终端文本丢失或截断证据。 |
| P1-13 prompt/schema confidence 类型冲突 | **新增，未关闭** | compatibility 真实输出直接复现了字符串示例与数字 schema 的矛盾。 |
| P1-14 text 输出封装与诊断不稳定 | **新增，未关闭** | regression_test 真实文本不是完整 JSON，当前诊断不足以区分具体形态。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 历史非阻断项继续有效。 |
| P2-07 真实测试基础脱敏诊断 | **保持关闭** | 已能安全输出 verdict/category/message/fallback；P1-14 另要求补充不含原文的解析形态指标。 |

### 15.5 修复与下一轮复验顺序

1. 实现 Agent 只修复 P1-13、P1-14，并补齐上述契约、对抗性和脱敏诊断测试；不得修改真实场景的 category、质量门和终态断言，也不得自行更新本报告为通过。
2. 先由实现 Agent 提交本地 Adapter、API、全仓 test/build/typecheck/lint 和 `git diff --check` 证据；再由未参与修复的独立 Reviewer 阅读源码并复跑本地门禁。
3. 本次授权的两次真实调用已经实际发生，不能沿用到下一轮。只有本地 P1-13、P1-14 独立关闭后，才可重新请求用户授权外发相同两个合成场景并接受新的模型调用费用。
4. 下一轮 `pnpm test:phase5-real` 仍必须满足：4 项通过、0 项跳过；真实 compatibility/regression_test finding 均存在；质量门失败；Task=`FAILED`；Repair Record=`DRAFT`；SQLite 持久化一致；人工挑战返回 409。
5. 若仍失败，按新脱敏诊断登记实际根因；不得删除断言、接受 `other` 代替目标 category、手工改写模型结果或由实现 Agent 自行签发。

**第十一次当前有效结论：Phase 5 不通过。P1-12 已由真实运行关闭，但 P1-07 仍缺成功退出证据，并新增 P1-13、P1-14 两个确定性阻断项。不予签发，禁止进入 Phase 6。**

## 16. 第十二轮 P1-13/P1-14 修复后本地独立复核（2026-08-07）

### 16.1 独立源码复核结果

本轮独立 Reviewer 没有参与候选修复，也没有修改实现或测试代码。源码复核确认：

1. `buildReviewResultOutputExample()` 生成的 JSON 已把 `findings[].confidence` 和 `rootCause.confidence` 改为数值 `0.95`，`required` 为真实 boolean，verdict/priority/category 各自使用单个合法枚举值；prompt 外层又明确禁止带引号的 confidence 和枚举说明文本。
2. 严格解析器仍拒绝字符串 confidence、非法枚举、缺失 category、空 message 和非法 rootCause/constraint；没有加入字符串转数字、按场景名补 category 或其他失败开放逻辑。
3. `normalizeReviewText()` 只去除首尾空白或恰好一层完整 Markdown JSON 代码围栏；围栏内部再次出现围栏、前后说明文字、半边围栏和不完整 JSON 均失败关闭。旧的“扫描第一个平衡花括号”没有恢复到生产 Review 路径。
4. 解析失败诊断只包含 stdout UTF-8 字节数、围栏首尾标记、归一化错误、JSON 错误类别/位置和截断指标，不记录 prompt、Diff 或模型原文；诊断对象字段固定且有界。
5. Review 的 text 模式、`--no-tools`、截断失败关闭与 analyze/develop 的 JSON 事件流边界保持不变；没有增加自动模型重试或隐式费用调用。
6. Adapter 新增/保留测试覆盖合法示例、裸 JSON、单层围栏、双层围栏、前后说明、不完整 JSON、非法 schema、原文不泄漏和截断指标。Phase 5 真实测试仍断言目标 category、质量门失败、Task=`FAILED`、Repair Record=`DRAFT`、SQLite 往返和人工挑战 409，没有削弱退出条件。

因此 **P1-13、P1-14 均通过本地独立复核**。这只证明下一次真实复验的本地前置条件已具备，不等于 P1-07 或 Phase 5 已通过。

### 16.2 独立本地门禁证据

本轮显式设置 `TRACEPILOT_PHASE5_REAL_ACK=0`，没有调用 DeepSeek，也没有产生模型费用。实际结果如下：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @tracepilot/adapters test` | 8 个文件、**258 项通过**；`omp-adapter.test.ts` 82 项通过 |
| 首次 `pnpm test` | **失败**；API 真实验证子进程取消用例 1 项失败，其余已执行测试通过 |
| 单独复跑 `cancel-runtime-adversarial.test.ts` | **11 项通过** |
| 第二次 `pnpm test` | **792 项通过、5 项按设计跳过** |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过 |
| `pnpm lint` | 通过 |
| `git diff --check` | 通过；仅有既有 LF/CRLF 提示 |

最终全仓通过项分布为 Core 142、Governance 244、Adapters 258、Store 98、API 50，共 792 项。5 项跳过仍为 Governance 的平台路径用例、Phase 4 的两个真实用例和 Phase 5 的两个真实用例；费用门禁没有回退。

首次全仓失败不能从记录中删除：`cancel-runtime-adversarial.test.ts` 的“Runtime completed 后终止真实验证进程树”在固定等待 500 ms 后仍通过 PID 检测发现进程存活；同一文件单独复跑 11/11 通过，第二次全仓也通过。当前证据更符合 Windows 并发下的时序或 PID 检测不稳定，尚未证明稳定的生产回归，因此登记为 P2-09，而不是重新打开 Phase 4 P1；若后续再次出现，必须升级为 P1 并审查 `taskkill` 完成确认与进程身份校验。

### 16.3 新增非阻断问题

#### P2-08：合法 JSON 示例的 verdict 与 finding 语义不一致

`buildReviewResultOutputExample()` 当前输出 `verdict="ship"`，同时给出一个 P2 correctness finding；同一 prompt 后文却规定 P2/P3 建议应为 `ship_with_fixes`，`ship` 仅用于没有问题。严格 schema 与 Core 质量门目前都不会拒绝这个交叉字段矛盾。

这不会让 compatibility/regression_test finding 通过质量门，因此不作为本轮 P1；但示例通常比说明文字更容易影响模型输出，并可能产生误导人工审批的 `ship + P2/P3` 结果。建议在下一次付费真实复验前把示例改为 `ship_with_fixes`，或保留 `ship` 但把 findings 改为空数组，并增加 verdict/findings 一致性测试。

#### P2-09：Windows 真实验证进程取消测试存在一次时序不稳定

首次全仓门禁在 PID 存活断言失败，随后单文件和第二次全仓均通过。测试使用固定 500 ms 等待并只按 PID 判断进程是否存在；生产 `killProcessTree()` 又以异步方式启动 `taskkill /T /F`，没有等待或记录 taskkill 的完成状态。两者共同使“取消 API 返回后整棵进程树已确定终止”的证据不够稳定。

建议将测试改为有总超时的轮询并核验进程身份，生产侧对 Windows taskkill 的完成/失败建立可等待、可审计的结果。不得通过简单延长固定 sleep 或删除真实进程断言来消除红灯。

### 16.4 第十二轮问题状态

| 编号 | 第十二轮状态 | 结论 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-12 | **保持关闭** | 本轮没有这些安全、持久化、NDJSON 与 text 传输边界回退的证据。 |
| P1-07 真实 Reviewer 退出证据 | **唯一未关闭 P1** | 本轮未获新的外发和费用授权，真实两个场景按设计跳过。 |
| P1-13 prompt/schema confidence 类型冲突 | **本地关闭，待真实确认** | 数值/布尔/枚举示例与严格 schema 一致，定向和全量测试通过。 |
| P1-14 text 输出封装与诊断不稳定 | **本地关闭，待真实确认** | 有界单层围栏处理、失败关闭和脱敏形态诊断均有测试覆盖。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 历史非阻断项继续有效。 |
| P2-08 prompt 示例语义一致性 | **新增，未关闭** | `ship + P2 finding` 与 prompt 后文规则冲突。 |
| P2-09 Windows 取消门禁时序稳定性 | **新增，未关闭** | 首次全仓失败，单独复跑和第二次全仓通过。 |

### 16.5 下一步真实验收要求

第十一次授权对应的两次真实调用已经实际发生，本轮没有扩展该授权。建议先关闭 P2-08，避免浪费下一轮付费调用；P2-09 可并行治理，但不得借此修改或跳过 Phase 5 真实断言。

再次复验前必须由用户重新明确同意：

- 将 Phase 5 的相同两个合成 Git 场景发送给 DeepSeek；
- 接受新增两次真实 Reviewer 模型调用费用。

授权后仍运行 `pnpm test:phase5-real`。正式签发只接受 4 项通过、0 项跳过，并要求两个真实场景均命中目标 category、质量门失败、Task=`FAILED`、Repair Record=`DRAFT`、SQLite 持久化一致、人工挑战返回 409。任一失败都必须继续保持 Phase 5 不通过并按脱敏诊断登记实际根因。

**第十二轮当前有效结论：P1-13、P1-14 已通过本地独立复核，当前唯一未关闭 P1 为 P1-07 的真实 Reviewer 退出证据。Phase 5 仍为本地候选通过但未正式签发，禁止进入 Phase 6。**

## 17. 第十三轮真实 Omp + DeepSeek 验收（2026-08-07）

### 17.1 普通本机终端真实运行结果

用户在普通 PowerShell 终端设置 `TRACEPILOT_PHASE5_REAL_ACK=1` 并运行 `pnpm test:phase5-real`。真实分支没有跳过，实际结果为：

| 场景 | 结果 | 用时 | 结论 |
| --- | --- | ---: | --- |
| 本地 compatibility 夹具 | 通过 | 750 ms | Git、验证、SQLite、API 和质量门闭环通过 |
| 本地 regression_test 夹具 | 通过 | 534 ms | Git、验证、SQLite、API 和质量门闭环通过 |
| 真实 compatibility | **通过** | 30.593 s | 命中 compatibility finding，并完整通过质量门、终态、SQLite 与人工挑战断言 |
| 真实 regression_test | **失败** | 61.702 s | assistant 文本只有结束 Markdown 围栏，被回退为 `block/P1/other`，未命中 regression_test category |

Vitest 汇总为 **3 项通过、1 项失败、0 项跳过**，测试执行 93.58 秒，总持续时间 94.63 秒，命令退出码 1。失败仍发生在 `assertReviewBlocked()` 的目标 category 断言；HTTP 422 已先通过，但 regression_test 场景后续质量门、Task、Repair Record、SQLite 往返和人工挑战断言没有完整执行，不能关闭 P1-07。

本轮相较第十一次真实验收有实质进展：compatibility 不再因字符串 confidence 失败，而是完整通过真实受控闭环。这构成 P1-13 的真实退出证据，P1-13 可以正式关闭。

### 17.2 P1-14 真实确认失败：模型返回单边结束围栏

regression_test 的脱敏诊断为：

- `stdoutBytes=2196`；
- `markdownFenceStart=false`；
- `markdownFenceEnd=true`；
- `normalizationError=markdown_fence_invalid`；
- 结果按设计失败关闭为 `block/P1/other`。

这说明 P1-14 新增的形态诊断已经发挥作用，且解析器没有失败开放；但“仅接受裸 JSON 或成对完整围栏”的协议仍无法稳定承接真实 Reviewer 输出。由于目标 regression_test finding 未进入质量门，P1-14 的真实确认失败，状态从“本地关闭，待真实确认”改为 **重新打开**。

当前脱敏证据不能证明去掉最后一个围栏后必然就是合法 JSON，也不能判断上游是模型生成了单边围栏还是 Omp text 传输处理了起始围栏。因此不得直接删除所有反引号、扫描首个 `{...}`、记录原文或手工补造 regression_test finding。

### 17.3 P1-14 修订后的强制修复边界

1. 优先确认 Omp/模型链路是否提供原生 JSON schema 或结构化输出约束；若可用，应在不启用工具、不恢复 NDJSON 大输出问题的前提下使用。
2. 若当前链路只能使用 text，则允许增加**精确且有限的单边围栏归一化**：
   - 结束围栏单边形态：全文去除首尾空白后必须以 `{` 开头，并且只在最后一行出现唯一的结束围栏；去除该结束围栏后，剩余全文必须能作为单个 JSON 对象严格解析。
   - 起始围栏单边形态：全文必须以唯一的 Markdown JSON 起始围栏开头；去除该起始围栏后，剩余全文必须以 `}` 结束并作为单个 JSON 对象严格解析。
   - 归一化后仍必须执行现有完整 ReviewResult schema、category、confidence、rootCause 和 Evidence ID 校验。
3. 任意前后说明文字、多个或嵌套围栏、JSON 后附加非围栏内容、数组顶层、不完整 JSON、非法 schema 均继续失败关闭；不得恢复平衡花括号扫描或从自然语言中抽取对象。
4. 诊断新增固定枚举 `normalizationForm`，至少区分 `bare`、`paired_fence`、`opening_fence_only`、`closing_fence_only`、`invalid_fence`；仍不得记录 stdout 原文、prompt 或 Diff。
5. 增加对抗性测试：合法裸 JSON、完整单层围栏、仅起始围栏、仅结束围栏通过；说明文字加结束围栏、起始围栏后附加文字、双层/内嵌围栏、不完整 JSON 和非法 schema 失败关闭；所有失败消息不含模型原文。
6. Prompt 进一步明确“首字符必须是 `{`、末字符必须是 `}`，不要输出 Markdown 围栏”；这只能作为辅助，不能替代解析边界。
7. 不得自动付费重试。修复后先完成 Adapter、API、全仓 test/build/typecheck/lint 和 diff check，再由独立 Reviewer 本地复核；下一次真实模型调用必须重新获得用户授权。

上述规则修订了第 15 节中“半边围栏一律失败”的原要求：新真实证据表明单边围栏是实际出现的传输形态。修订仍要求去除精确包装后对**剩余全文**严格解析，因此不会退化为任意文本 JSON 抽取。

### 17.4 P2-08/P2-09 补充复核

本次真实运行前，当前工作树已经包含上一轮两个 P2 的候选修复。本轮独立 Reviewer 只读复核并在 `TRACEPILOT_PHASE5_REAL_ACK=0` 下运行定向门禁：

- P2-08：Review 示例已改为 `ship_with_fixes + P2 finding`，与 prompt 语义一致；Adapter 8 个文件、258 项测试通过。
- P2-09：Windows 路径现在等待 `taskkill /T /F` 的 close/error/超时并返回结构化 termination 结果；真实取消测试改为有总超时的轮询和进程身份核验，`cancel-runtime-adversarial.test.ts` 11 项通过。

P2-08、P2-09 可以关闭。本轮没有再次运行全仓 test/build/typecheck/lint；这些门禁必须在 P1-14 下一次候选修复后统一重跑，当前定向结果不得替代最终全量证据。

### 17.5 第十三轮问题状态

| 编号 | 第十三轮状态 | 结论 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-12 | **保持关闭** | 本轮没有这些边界回退的证据。 |
| P1-07 真实 Reviewer 退出证据 | **未关闭** | 真实 compatibility 通过，但 regression_test 失败；尚未达到 4 项通过。 |
| P1-13 prompt/schema confidence 类型冲突 | **正式关闭** | compatibility 真实闭环完整通过，未再出现字符串 confidence 错误。 |
| P1-14 text 输出封装与诊断不稳定 | **重新打开** | regression_test 返回只有结束围栏的 2196 字节文本，目标 category 不可达。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 历史非阻断项继续有效。 |
| P2-08 prompt 示例语义一致性 | **关闭** | 示例已改为 `ship_with_fixes + P2`，Adapter 定向测试通过。 |
| P2-09 Windows 取消门禁时序稳定性 | **关闭** | taskkill 可等待且有结构化结果，真实取消测试 11 项通过。 |

### 17.6 下一步顺序

1. 实现 Agent 只按第 17.3 节修复 P1-14，不得修改真实 regression_test 的 category 和终态断言，不得接受 `other` 代替目标分类。
2. 完成本地定向与全量门禁后，由未参与修复的独立 Reviewer 复核并关闭 P1-14 的本地状态。
3. 本轮两次真实调用已经实际发生，授权不能沿用。再次复验前必须重新取得用户对相同两个合成场景外发和新增两次模型调用费用的明确同意。
4. 下一轮仍必须运行完整 `pnpm test:phase5-real`，不能只复跑失败场景；正式签发只接受 4 项通过、0 项跳过以及全部原始 category、质量门、终态、SQLite 和人工挑战断言通过。

**第十三轮当前有效结论：Phase 5 不通过。P1-13 已由真实 compatibility 场景正式关闭；P1-14 因真实 regression_test 的单边结束围栏重新打开，P1-07 仍未关闭。不予签发，禁止进入 Phase 6。**

## 18. 第十四轮 P1-14 候选修复独立复核（2026-08-07）

### 18.1 已正确实现的部分

本轮独立 Reviewer 没有修改实现或测试代码。只读复核确认候选修复已覆盖第 17.3 节的主要路径：

1. Prompt 新增“去除首尾空白后首字符必须是 `{`、末字符必须是 `}`，不要输出 Markdown 围栏或额外文本”的明确约束。
2. `normalizeReviewText()` 现在区分 `bare`、`paired_fence`、`opening_fence_only`、`closing_fence_only` 和 `invalid_fence`。
3. 仅结束围栏必须位于最后一行，正文必须以 `{` 开头、以 `}` 结束且不得再含三反引号；仅起始围栏必须使用受控 Markdown JSON 起始格式，正文不得含其他三反引号且必须以 `}` 结束。
4. 归一化后的剩余全文仍经过 `JSON.parse` 和现有 ReviewResult 严格 schema；没有恢复平衡花括号扫描、场景分类补造或自动模型重试。
5. 新增测试覆盖仅起始围栏、仅结束围栏、说明文字加结束围栏、起始围栏后附加说明和 `normalizationForm` 诊断；真实测试中的 category、质量门、终态、SQLite 和人工挑战断言保持不变。

### 18.2 P1-14 剩余确定性缺口：`normalizationError` 没有阻断候选对象

`normalizeReviewText()` 在裸文本包含任意三反引号时返回：

- `normalizationForm="invalid_fence"`；
- `normalizationError="markdown_fence_invalid"`；
- `text` 仍为原始完整文本。

但是 `parseReviewResultText()` 不检查 `normalized.normalizationError`，而是无条件继续执行 `JSON.parse(normalized.text)`。如果模型返回的是一个**语法完整、schema 合法的 JSON 对象**，只是某个 `message`、`summary` 或其他字符串字段内含三反引号，`JSON.parse` 仍会成功；随后代码直接返回 ReviewResult，不再理会已经存在的 `normalizationError`。

这形成了明确的控制流矛盾：同一输出同时被归一化器判定为 `invalid_fence`，又可能被解析器当作有效结果接受。现有“双层围栏”测试之所以通过，是因为整段文本本身不是合法 JSON；它没有覆盖“合法 JSON 字符串内部包含三反引号”的可解析分支。

该缺口不会恢复任意自然语言 JSON 扫描，但违反第 17.3 节“多个或内嵌围栏必须失败关闭”的边界，也使 `normalizationForm=invalid_fence` 的诊断语义不可信。因此 P1-14 **不能本地关闭**。

### 18.3 强制修复与测试要求

1. `normalized.normalizationError` 存在时必须在进入 `JSON.parse`/schema 成功返回路径前确定性失败关闭；可以直接跳过解析，也可以保证该结果永远不能形成可接受 candidate，但不得仅记录后继续。
2. 增加合法 ReviewResult JSON 对抗测试：在 finding `message` 和/或 `summary` 字符串中放入三反引号，断言结果为 `block/P1/other`，诊断包含 `normalizationForm=invalid_fence` 与 `markdown_fence_invalid`，且不泄漏原字符串。
3. 保留现有四条有效路径：裸 JSON、成对单层围栏、仅起始围栏、仅结束围栏；不得因修复而重新拒绝第十三轮真实出现的 closing-fence-only 形态。
4. 保留对说明文字、多重包装、不完整 JSON、数组顶层、非法 category/confidence/schema 的失败关闭测试；不得把内部三反引号简单删除后再解析。
5. 修复后先运行 Adapter 定向测试，再运行全仓 test/build/typecheck/lint 和 `git diff --check`；由独立 Reviewer 重新检查控制流后，才能把 P1-14 标记为“本地关闭，待真实确认”。
6. 本轮不具备新的真实调用授权。P1-14 本地关闭前不得请求或执行下一次 DeepSeek 复验。

### 18.4 本轮本地证据

本轮显式设置 `TRACEPILOT_PHASE5_REAL_ACK=0`，未调用 DeepSeek，也未产生模型费用。

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @tracepilot/adapters test` | 8 个文件、**262 项通过**；`omp-adapter.test.ts` 86 项通过 |
| 全仓 test/build/typecheck/lint | **未运行**；已有确定性 P1-14 缺口，留待修复后统一执行 |

测试绿灯只证明当前已覆盖路径没有回归，不能覆盖第 18.2 节指出的缺失分支。

### 18.5 第十四轮问题状态

| 编号 | 第十四轮状态 | 结论 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-13 | **保持关闭** | 本轮没有这些边界回退的证据。 |
| P1-07 真实 Reviewer 退出证据 | **未关闭** | 上轮真实门禁仍为 3 项通过、1 项失败。 |
| P1-14 text 输出封装与诊断不稳定 | **仍未关闭** | 单边围栏主体已实现，但 `normalizationError` 未阻断可解析 JSON 的成功路径。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 历史非阻断项继续有效。 |
| P2-08/P2-09 | **保持关闭** | 本轮没有语义示例或 Windows 取消边界回退证据。 |

**第十四轮当前有效结论：Phase 5 不通过。P1-14 候选修复尚有确定性失败关闭缺口，不能本地关闭；P1-07 仍未关闭。不予签发，禁止进入 Phase 6。**

## 19. 第十五轮 P1-14 修复后本地独立复核（2026-08-07）

### 19.1 源码与测试复核结论

本轮独立 Reviewer 没有修改实现或测试代码。复核确认：

1. `parseReviewResultText()` 在 `normalized.normalizationError` 存在时不再调用 `JSON.parse`，而是固定记录 `jsonErrorCategory=markdown_fence_invalid`，candidate 保持为空并进入 `block/P1/other` 回退路径。
2. 新增“合法 schema JSON 内嵌三反引号”对抗测试，同时在 finding message 和 summary 放入敏感标记；断言结果为 `block/P1/other`、诊断包含 `invalid_fence`，且 finding/summary 均不泄漏原文。
3. 裸 JSON、成对单层围栏、仅起始围栏和仅结束围栏四条有效路径仍保留；说明文字、多重/内嵌围栏、不完整 JSON 和非法 schema 继续失败关闭。
4. Prompt 首尾字符约束、`normalizationForm` 脱敏诊断、text `--no-tools`、截断失败关闭和严格 ReviewResult schema 均未回退。
5. Phase 5 真实测试继续断言目标 category、质量门失败、Task=`FAILED`、Repair Record=`DRAFT`、SQLite 往返和人工挑战 409；没有接受 `other`、删除断言或根据场景名补造 finding。

第 18.2 节指出的控制流矛盾已经关闭，未发现新的 P1。P1-14 可以更新为 **本地关闭，待真实确认**。

### 19.2 独立本地门禁证据

本轮显式设置 `TRACEPILOT_PHASE5_REAL_ACK=0`，未调用 DeepSeek，也未产生模型费用。实际结果：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @tracepilot/adapters test` | 8 个文件、**263 项通过**；`omp-adapter.test.ts` 87 项通过 |
| `pnpm test` | **797 项通过、5 项按设计跳过** |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过 |
| `pnpm lint` | 通过 |
| `git diff --check` | 通过；仅有既有 LF/CRLF 提示 |

全仓通过项分布为 Core 142、Governance 244、Adapters 263、Store 98、API 50，共 797 项。5 项跳过仍为 Governance 的平台路径用例、Phase 4 两个真实用例和 Phase 5 两个真实用例；授权与费用门禁没有回退。

### 19.3 第十五轮问题状态

| 编号 | 第十五轮状态 | 结论 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-13 | **保持关闭** | 本轮没有这些安全、持久化、输出传输或 schema 边界回退的证据。 |
| P1-07 真实 Reviewer 退出证据 | **唯一未关闭 P1** | 最近一次真实门禁仍为 3 项通过、1 项失败；修复后尚未重新运行。 |
| P1-14 text 输出封装与诊断不稳定 | **本地关闭，待真实确认** | 单边围栏、非法围栏短路、严格全文解析和脱敏诊断均通过独立本地复核。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 历史非阻断项继续有效。 |
| P2-08/P2-09 | **保持关闭** | 全仓门禁未见示例语义或 Windows 取消边界回退。 |

### 19.4 下一步真实验收要求

第十三轮授权对应的两次真实模型调用已经实际发生，本轮本地复核没有扩展该授权。再次复验前必须重新取得用户明确同意：

- 将 Phase 5 的相同两个合成 Git 场景发送给 DeepSeek；
- 接受新增两次真实 Reviewer 模型调用费用。

授权后仍必须运行完整 `pnpm test:phase5-real`，不得只跑曾失败的 regression_test。正式签发只接受 4 项通过、0 项跳过，并要求两个真实场景全部通过原始 category、质量门、Task、Repair Record、SQLite 和人工挑战断言。任一失败均继续保持 Phase 5 不通过，并根据脱敏诊断登记实际根因。

**第十五轮当前有效结论：P1-14 已通过本地独立复核，当前唯一未关闭 P1 为 P1-07 的真实 Reviewer 退出证据。Phase 5 仍为本地候选通过但未正式签发，禁止进入 Phase 6。**

## 20. 第十六轮真实 DeepSeek 复验（2026-08-07）

### 20.1 授权与执行边界

用户已明确同意将 Phase 5 的两个合成 Git 场景发送给 DeepSeek，并接受新增两次模型调用费用。独立 Reviewer 据此执行完整 `pnpm test:phase5-real`，没有只运行单个失败场景，也没有自动重试。

两次真实调用均已实际发生。本轮未修改实现代码或测试代码。

### 20.2 实际结果

| 项目 | 结果 |
| --- | --- |
| 测试文件 | 1 个失败 |
| 总测试数 | 4 项 |
| 本地受控夹具 | 2 项通过 |
| 真实 Omp + DeepSeek 场景 | 2 项失败 |
| 跳过 | 0 项 |
| 总耗时 | 96.80 秒；测试主体 95.71 秒 |
| 进程退出码 | 1 |

真实场景明细：

| 场景 | stdout 字节数 | 脱敏结构诊断 | 失败位置 |
| --- | ---: | --- | --- |
| `compatibility` | 2539 | `markdownFenceStart=false`、`markdownFenceEnd=true`、`normalizationForm=invalid_fence`、`normalizationError=markdown_fence_invalid` | 未生成 `category=compatibility` finding，回退为 `block/P1/other` |
| `regression_test` | 2332 | `markdownFenceStart=false`、`markdownFenceEnd=true`、`normalizationForm=invalid_fence`、`normalizationError=markdown_fence_invalid` | 未生成 `category=regression_test` finding，回退为 `block/P1/other` |

两个场景都在 `assertReviewBlocked()` 的首个目标 category 断言处失败。虽然适配器按设计失败关闭为 `block/P1/other`，但这不满足 Phase 5 的业务验收要求。由于测试在该断言后终止，本轮不能把后续质量门失败、Task=`FAILED`、Repair Record=`DRAFT`、SQLite 往返和人工挑战 409 记为已通过的真实证据。

### 20.3 独立 Reviewer 判定

本次结果证明第 19 节的本地修复没有失败开放，但仍不能稳定承接真实 Reviewer 输出。两个真实场景都带有结束围栏，却没有进入受控的 `closing_fence_only` 路径，说明以下条件至少有一项不成立：

1. 结束围栏单独位于最后一行；
2. 围栏前正文以 `{` 开头；
3. 围栏前正文以 `}` 结束；
4. 正文内部不再包含三反引号。

现有脱敏诊断没有分别记录上述谓词，因此不能从本轮证据确定究竟是前置说明、内部起始围栏、正文不完整，还是其他结构异常。不得在根因未确定时扩大自然语言扫描、任意提取平衡花括号、删除内部围栏或接受 `other` 代替目标 category。

因此：

- P1-14 从“本地关闭，待真实确认”改为 **重新打开**；
- P1-07 仍未关闭；
- Phase 5 本轮正式验收失败，不予签发。

### 20.4 强制修复与复验要求

1. 在不记录或泄漏模型原文的前提下，为 `invalid_fence` 增加确定性的细分原因，例如：结束围栏是否独占最后一行、正文是否以对象开始/结束、是否存在内部围栏，以及 assistant text block 数量；诊断只能输出布尔值、计数和枚举。
2. 使用细分诊断复现本次真实结构，并增加对应的 Adapter 对抗测试；不得根据场景名、expected category 或 prompt 内容补造 finding。
3. 优先消除输出协议歧义，例如避免在“禁止 Markdown 围栏”的同一输出说明中继续使用可被模型模仿的围栏示例；如 Omp/模型支持原生结构化 JSON schema，应先评估该路径。不得在没有证据时继续扩张容错语法。
4. 保持 `normalizationError` 在 `JSON.parse` 前失败关闭，保留裸 JSON、严格成对围栏和经证据确认的受控单边围栏测试。
5. 保持真实测试中的目标 category、质量门、Task、Repair Record、SQLite 和人工挑战断言不变；实现 Agent 不得自行审查或把本报告改为通过。
6. 修复后先由实现 Agent 运行本地定向及全仓门禁，再交由独立 Reviewer 只读复核。只有 P1-14 再次本地关闭后，才能请求下一轮真实外发与费用授权。
7. 本次授权的两次调用已经用尽，不得沿用本次授权自动重试。

### 20.5 第十六轮问题状态

| 编号 | 第十六轮状态 | 结论 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-13 | **保持关闭** | 本轮没有这些边界回退的证据。 |
| P1-07 真实 Reviewer 退出证据 | **未关闭** | 完整真实门禁为 2 项通过、2 项失败。 |
| P1-14 text 输出封装与诊断不稳定 | **重新打开** | 两个真实场景均为结束围栏信号但归一化失败，目标 category 不可达。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 历史非阻断项继续有效。 |
| P2-08/P2-09 | **保持关闭** | 本轮没有示例语义或 Windows 取消边界回退证据。 |

**第十六轮当前有效结论：Phase 5 不通过。P1-14 的真实确认在两个场景中均失败，P1-07 仍未关闭；本次两次真实调用授权已用尽，不予签发，禁止进入 Phase 6。**

## 21. 第十七轮 P1-14 候选修复独立复核（2026-08-10）

### 21.1 已正确实现的部分

本轮独立 Reviewer 没有修改实现代码或测试代码。只读复核确认候选修复具备以下正确性质：

1. `invalid_fence` 脱敏诊断新增 `closingFenceOnLastLine`、`objectStartsWithBrace`、`objectEndsWithBrace`、`internalFence` 和文本段计数；输出只包含布尔值、计数、枚举和字节数，不记录模型原文、Prompt 或 Diff。
2. `normalizationError` 仍在 `JSON.parse` 前确定性短路，不能通过构造一个内部含三反引号但 schema 合法的 JSON 绕过失败关闭。
3. 结束围栏、起始围栏和成对围栏的受控解析边界没有放宽；前置说明、尾部说明、内嵌/多重围栏继续回退为 `block/P1/other`。
4. Review Prompt 的输出 schema 示例已经不再包裹 Markdown 围栏，并继续明确首字符 `{`、末字符 `}` 和禁止附加文本。
5. 新增 Adapter 测试覆盖“说明文字 + 结束围栏”和“围栏后仍有尾部说明”的结构指标；内嵌三反引号的脱敏对抗测试也补充了新指标断言。
6. Phase 5 真实测试的目标 category、质量门、Task、Repair Record、SQLite 和人工挑战断言未被删除或放宽，没有按场景名补造 finding。

这些变化使下一次真实失败能够提供比第十六轮更精确的脱敏结构证据，也没有引入失败开放。

### 21.2 P1-14 仍未关闭：关键 Prompt 修复没有契约测试

第十六轮两个真实场景均因输出封装不稳定失败。本次候选中，真正可能改变下一次模型输出形态的代码变更，是把 `## 输出要求` 内的 schema 示例从 Markdown JSON 围栏改为裸 JSON 示例；其余新增内容主要用于失败后的诊断。

但是当前测试没有检查这一关键协议：

- `review 在 omp 成功返回合法 JSON 时返回 ReviewResult` 只断言 argv 中 `--mode` 等于 `text`；
- 没有从 stub runner 的 `lastArgv` 取出 Review Prompt；
- 没有隔离 `## 输出要求` 至 `## 评审要点` 区段并断言该区段不含三反引号；
- 没有断言该区段包含裸 ReviewResult 示例、首尾字符约束和“不得包含额外文本”的要求。

因此，即使后续维护者把输出 schema 重新包回 Markdown 围栏，当前 Adapter 264 项和全仓 798 项测试仍会全部通过。这直接影响已经造成四次真实模型调用失败的协议边界，也不满足第 20.4 节“为输出协议修复增加对应 Adapter 测试”的要求。P1-14 **不能在本轮本地关闭**。

强制补测要求：使用现有 stub runner 捕获 Review argv 最后一个 Prompt 参数，只截取 `## 输出要求` 到 `## 评审要点` 的区段，至少断言：

1. 区段内不含任何三反引号；不得对整个 Prompt 断言，因为 Evidence Pack、Diff 和验证输入仍合理使用受控围栏。
2. 区段包含 `buildReviewResultOutputExample()` 产生的裸 JSON 对象。
3. 区段包含“只输出一个 JSON 对象”“不得包含任何额外文本”“首字符必须是 `{`”“末字符必须是 `}`”和“不要输出 Markdown JSON 围栏”的约束。
4. 测试必须实际经过 `OmpAdapter.review()` 到 stub runner，不得只测试一个与生产 Prompt 构造无关的复制字符串。

补齐该测试并重新通过本地门禁后，独立 Reviewer 才能把 P1-14 更新为“本地关闭，待真实确认”。

### 21.3 两项非阻断问题

#### P2-10：text 模式的块计数命名会造成误读

真实 Review 使用 `--mode text`。该路径中的 `assistantTextBlockCount` 不是从 assistant content block 解析得到，而是按 `stdout.trim().length > 0 ? 1 : 0` 推导；因此数值 1 只能表示“收到一段非空 text stdout”，不能证明上游只有一个 assistant block。

应选择以下一种方式消除歧义：

- 将公共诊断名改为 `textSegmentCount`，并记录 `outputMode=text|ndjson`；或
- text 模式不输出 `assistantTextBlockCount`，另设 `textOutputPresent`；或
- 明确记录计数来源，使真实诊断不会把 text stdout 段误称为上游 content block。

该问题不泄漏原文，也不会导致失败开放，列为 P2。

#### P2-11：ADR-007 与当前 Review CLI 拓扑不一致

当前代码要求 Review 使用 `--mode text --no-tools`，但 ADR-007 第 78、158-160、180-182 和 215-216 行附近仍把统一调用方式描述为 `--mode json`、NDJSON 事件流和旧的 Review 文本容错。该文档还保留“三级容错”等已不符合当前严格全文解析策略的表述。

实现 Agent 应更新 ADR-007，明确：

1. analyze/develop 与 review 的 mode 差异；
2. Review 选择 text 模式的当前原因与安全边界；
3. 是否已评估 Omp/模型原生 JSON schema 或结构化输出能力，以及为什么当前采用或不采用；
4. 当前只接受裸 JSON、严格成对围栏和经证据确认的有限单边围栏，不进行任意自然语言 JSON 扫描。

该问题暂不改变运行时行为，列为 P2，但正式签发前应关闭，避免后续 AI 按过期 ADR 恢复错误实现。

### 21.4 独立本地门禁证据

本轮显式设置 `TRACEPILOT_PHASE5_REAL_ACK=0`，没有调用 DeepSeek，也没有产生模型费用。

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @tracepilot/adapters test` | 8 个文件、**264 项通过**；`omp-adapter.test.ts` 88 项通过 |
| `pnpm test` | **798 项通过、5 项按设计跳过** |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过 |
| `pnpm lint` | 通过 |
| `git diff --check` | 通过；仅有既有 LF/CRLF 提示 |

全仓通过项分布为 Core 142、Governance 244、Adapters 264、Store 98、API 50，共 798 项。5 项跳过为 Governance 的平台路径用例、Phase 4 两个真实用例和 Phase 5 两个真实用例。

Adapter 首次在当前沙箱内启动时因 esbuild 子进程 `spawn EPERM` 未进入测试；以相同代码和 `TRACEPILOT_PHASE5_REAL_ACK=0` 在获准的本地执行环境重跑后 264 项全部通过。该现象是执行沙箱限制，不记为产品测试失败。

### 21.5 第十七轮问题状态与下一步

| 编号 | 第十七轮状态 | 结论 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-13 | **保持关闭** | 本轮没有这些边界回退的证据。 |
| P1-07 真实 Reviewer 退出证据 | **未关闭** | 最近一次完整真实门禁仍为 2 项通过、2 项失败。 |
| P1-14 text 输出封装与诊断不稳定 | **仍未关闭** | 细分诊断与 Prompt 候选修复已落地，但关键 Prompt 输出协议没有契约测试。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 历史非阻断项继续有效。 |
| P2-08/P2-09 | **保持关闭** | 本轮没有语义示例或 Windows 取消边界回退证据。 |
| P2-10 text 模式块计数语义 | **新增，未关闭** | text stdout 是否非空被命名为 assistant block 数量，诊断来源不准确。 |
| P2-11 ADR-007 Review 拓扑漂移 | **新增，未关闭** | ADR 仍描述统一 `--mode json`，与当前 Review `--mode text --no-tools` 不一致。 |

下一步顺序：

1. 实现 Agent 只补齐第 21.2 节 Prompt 契约测试，并处理 P2-10/P2-11；不得修改真实 category 或终态断言。
2. 实现 Agent 运行 Adapter 与全仓 test/build/typecheck/lint/diff check，自测结果只能作为候选证据，不得自行关闭问题或把报告改为通过。
3. 由独立 Reviewer 再次只读复核；只有 P1-14 本地关闭后，才可请求用户重新授权两个合成 Git 场景外发及新增两次模型费用。
4. 当前没有新的真实调用授权，不得运行付费复验或自动重试。

**第十七轮当前有效结论：Phase 5 不通过。P1-14 因关键 Prompt 输出协议缺少契约测试而仍未本地关闭，P1-07 仍未关闭；新增 P2-10/P2-11。不予签发，禁止进入 Phase 6。**

## 22. 第十八轮 P1-14/P2-10/P2-11 修复后独立复核（2026-08-10）

### 22.1 P1-14 本地退出条件复核

本轮独立 Reviewer 没有修改实现代码、测试代码或 ADR。只读复核确认第 21.2 节要求已经完整落地：

1. 新增 `review 通过真实 argv 传递无围栏的严格 JSON 输出协议` 测试，实际调用 `OmpAdapter.review()`，通过 stub runner 的 `lastArgv` 获取生产 Prompt。
2. 测试只截取 `## 输出要求` 到 `## 评审要点` 区段，没有错误地禁止 Evidence Pack、Diff 和验证结果使用受控围栏。
3. 测试断言输出区段不含三反引号，并包含 `buildReviewResultOutputExample()` 生成的裸 JSON 对象。
4. 测试同时固定“只输出一个 JSON 对象”“不得包含任何额外文本”、首字符 `{`、末字符 `}` 和禁止 Markdown JSON 围栏的约束。
5. 生产 Prompt 与测试文字完全一致；没有为了让测试通过而复制一份与生产构造无关的常量。
6. `OmpAdapter.review()` 的真实 text 路径现在直接调用严格全文解析并显式传入 `outputMode=text`，不会把 text stdout 猜测为 NDJSON 事件流。
7. `normalizationError` 前置短路、严格 JSON/schema、受控单边围栏、内嵌围栏失败关闭和脱敏边界均保持不变。
8. Phase 5 真实测试继续保留目标 category、质量门、Task=`FAILED`、Repair Record=`DRAFT`、SQLite 往返和人工挑战 409 的原始断言。

第 21.2 节唯一 P1 阻断已经关闭，未发现新的失败开放或场景补造路径。因此 P1-14 可以更新为 **本地关闭，待真实确认**。

### 22.2 P2-10/P2-11 复核

#### P2-10 关闭

原 `assistantTextBlockCount` 已替换为：

- `outputMode=text|ndjson`；
- `textSegmentCount`。

代码注释明确说明：text 模式计数表示最终 stdout 段，NDJSON 模式计数表示实际收集的 assistant content 段。真实 Review 生产路径、兼容提取函数、截断诊断和 Adapter 对抗测试均使用新语义；旧的误导字段已经不存在。P2-10 可以关闭。

#### P2-11 关闭

ADR-007 已同步修订以下位置：

1. 参数表区分 analyze/develop 的 `--mode json` 与 review 的 `--mode text`；
2. Prompt 驱动、流式事件与 Review 文本协议分别描述两条通道；
3. 决策部分记录 Review 的完整 `--mode text --no-tools` 固定拓扑；
4. 明确只接受裸 JSON、严格成对围栏和经真实证据确认的有限单边围栏，不扫描自然语言 JSON 子串；
5. 记录本机 `omp v17.1.5 --help` 对原生结构化输出能力的评估。

独立 Reviewer 本轮实际执行 `omp --help` 与 `omp --version`：版本为 `omp/17.1.5`；公开输出 mode 只有 `text`、`json`、`rpc`、`rpc-ui`，未发现 JSON schema、response-format 等可验证参数。ADR 陈述与本机 CLI 证据及当前代码一致，P2-11 可以关闭。

### 22.3 独立本地门禁证据

本轮显式设置 `TRACEPILOT_PHASE5_REAL_ACK=0`，没有向 DeepSeek 发送场景，也没有产生模型费用。

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @tracepilot/adapters test` | 8 个文件、**265 项通过**；`omp-adapter.test.ts` 89 项通过 |
| `pnpm test` | **799 项通过、5 项按设计跳过** |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过 |
| `pnpm lint` | 通过 |
| `git diff --check` | 通过；仅有既有 LF/CRLF 提示 |
| `omp --help` / `omp --version` | 通过；版本 `omp/17.1.5`，无原生 JSON schema 参数 |

全仓通过项分布为 Core 142、Governance 244、Adapters 265、Store 98、API 50，共 799 项。5 项跳过为 Governance 的平台路径用例、Phase 4 两个真实用例和 Phase 5 两个真实用例；真实调用授权门禁没有回退。

### 22.4 第十八轮问题状态与下一步

| 编号 | 第十八轮状态 | 结论 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-13 | **保持关闭** | 本轮没有这些边界回退的证据。 |
| P1-07 真实 Reviewer 退出证据 | **唯一未关闭 P1** | 最近一次完整真实门禁仍为 2 项通过、2 项失败；本轮没有真实调用授权。 |
| P1-14 text 输出封装与诊断不稳定 | **本地关闭，待真实确认** | Prompt 契约、输出 mode/计数诊断、严格解析和本地全量门禁均通过独立复核。 |
| P2-05 执行拒绝状态收口 | **仍未关闭** | 历史非阻断项继续有效。 |
| P2-08/P2-09 | **保持关闭** | 本轮没有示例语义或 Windows 取消边界回退证据。 |
| P2-10 text 模式块计数语义 | **关闭** | 已改为带来源的 `outputMode + textSegmentCount`。 |
| P2-11 ADR-007 Review 拓扑漂移 | **关闭** | ADR、当前代码和本机 omp CLI 证据一致。 |

本地前置条件已满足。下一步必须由用户重新明确同意：

- 将 Phase 5 的相同两个合成 Git 场景发送给 DeepSeek；
- 接受新增两次真实 Reviewer 模型调用费用。

获得授权后仍必须完整运行 `pnpm test:phase5-real`，不得只跑其中一个场景。正式签发只接受 4 项通过、0 项跳过，并要求两个真实场景全部通过目标 category、质量门、Task、Repair Record、SQLite 和人工挑战断言。当前不得沿用以前已经消耗的授权，也不得自动重试。

**第十八轮当前有效结论：P1-14 已通过本地独立复核，P2-10/P2-11 已关闭；当前唯一未关闭 P1 为 P1-07 的真实 Reviewer 退出证据。Phase 5 为本地候选通过但尚未正式签发，禁止进入 Phase 6。**

## 23. 第十九轮真实 Omp + DeepSeek 最终验收与正式签发（2026-08-10）

### 23.1 授权、模型与执行范围

用户已重新明确授权：将 Phase 5 的两个合成 Git 场景发送给 DeepSeek，并接受新增两次真实 Reviewer 模型调用费用。独立 Reviewer 随后执行完整：

```powershell
$env:TRACEPILOT_PHASE5_REAL_ACK='1'
pnpm test:phase5-real
```

本轮没有只运行单个场景，也没有自动重试。两次模型调用均已实际发生，本次授权已使用完毕。

模型与通道证据：

- 真实测试在启动前强制检查 `DEEPSEEK_API_KEY`；缺失时立即失败；
- 本地 `.env` 明确配置 `TRACEPILOT_OMP_MODEL=deepseek-v4-flash`；
- API 组合根日志显示两个真实场景均使用 `runtime=omp` 和本机 `omp.exe`；
- 因此本轮实际 Reviewer 为通过 Omp 调用的 DeepSeek `deepseek-v4-flash`。

报告不记录、打印或转存任何 API key。

### 23.2 最终真实门禁结果

| 项目 | 结果 |
| --- | --- |
| 测试文件 | 1 个通过 |
| 总测试数 | **4 项通过** |
| 失败 | **0 项** |
| 跳过 | **0 项** |
| 测试主体耗时 | 80.12 秒 |
| 总持续时间 | 81.32 秒 |
| 进程退出码 | **0** |

四项测试包括：

1. compatibility 本地受控夹具；
2. regression_test 本地受控夹具；
3. compatibility 真实 Omp + DeepSeek Reviewer；
4. regression_test 真实 Omp + DeepSeek Reviewer。

Vitest 仅在整个 `assertReviewBlocked()` 链全部完成后才会把真实场景记为通过。因此两个真实场景均已实际证明：

- finding 命中原始 `compatibility` / `regression_test` category；
- `qualityGate.passed=false`；
- Task 最终状态为 `FAILED`；
- Repair Record 状态为 `DRAFT`；
- SQLite 重读后的 Task 和 Repair Record 状态一致；
- 人工批准挑战返回 409，没有对被质量门阻断的修复签发挑战。

测试没有接受 `other` 替代目标 category，没有按场景名补造 finding，也没有跳过真实分支。

### 23.3 P1 正式关闭与签发判定

| 编号 | 最终状态 | 关闭证据 |
| --- | --- | --- |
| P1-01 至 P1-06、P1-08 至 P1-13 | **保持正式关闭** | 本轮真实门禁没有出现安全、持久化、来源链、schema 或输出传输边界回退。 |
| P1-07 真实 Reviewer 退出证据 | **正式关闭** | 完整真实门禁达到 4 项通过、0 项失败、0 项跳过，并通过全部下游闭环断言。 |
| P1-14 text 输出封装与诊断不稳定 | **正式关闭** | 两个真实 DeepSeek 场景均被严格解析为目标 category，Prompt 契约和 text 传输候选修复取得真实退出证据。 |
| P2-05 执行拒绝状态收口 | **继续登记，非阻断** | 不影响已验收的最终人类 Review 拒绝链路；后续阶段按报告既定语义整改。 |
| P2-08 至 P2-11 | **保持关闭** | 本轮没有相关回退证据。 |

Phase 5 所有 P1 均已关闭，规定的本地与真实退出条件全部满足。独立 Reviewer 未发现需要阻止签发的新问题。

### 23.4 正式签发声明

**独立 Reviewer 正式签发 Phase 5「Review、审批、Repair Memory」。验收结论：通过。**

签发依据：

1. 第十八轮本地门禁：Adapter 265 项、全仓 799 项测试通过，5 项设计性跳过；build、typecheck、lint、diff check 全部通过。
2. 第十九轮真实门禁：4 项通过、0 项失败、0 项跳过、退出码 0。
3. 两个真实 DeepSeek 场景完整通过 category、质量门、Task、Repair Record、SQLite 和人工挑战断言。
4. 实现与验收职责分离：本轮独立 Reviewer 没有修改实现代码、测试代码或 ADR，只更新验收文档和 README。

自本节签发后，项目可以进入 Phase 6，但必须满足以下交接条件：

- 先把 `AGENTS.md` 第 17 项的“当前 Phase 5 尚未验收通过”同步为本次正式签发状态；该同步是行政文档一致性动作，不得改写本报告证据；
- Phase 6 不得回退 Phase 4/5 的命令、路径、worktree、凭据隔离、服务端 Diff/验证来源、Review schema、质量门、人工审批和 Repair Memory 边界；
- P2-05 继续作为已知非阻断项跟踪；若实现其整改，仍须补齐领域、API、审计和状态机测试；
- SAG 仍按既定架构通过 `KnowledgeAdapter` 后置接入，不得替换 SQLite MVP 真源。

**第十九轮最终有效结论：Phase 5 正式通过并签发，P1 全部关闭；允许在同步 AGENTS 阶段状态后进入 Phase 6。**
