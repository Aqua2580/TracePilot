# ADR-009：Review、人工审批与 SQLite Repair Memory 闭环

## 状态

实现中，待由未参与实现的独立 Reviewer 按 Phase 5 退出条件验收。

## 背景

Phase 4 已经能够从受控 `execution_results` 读取 Diff 和验证产物，并调用真实
`OmpAdapter` 进行 Review。但仅有 Runtime 返回的 `ReviewResult` 还不能证明修复
可以发布，也不能直接成为长期记忆：模型可能漏报兼容性问题，验证结果可能失败，
调用方也不能被允许用请求体伪造“测试通过”或“没有 P0/P1”。

Phase 5 需要把以下事实连成一条可审计链：

```text
受控验证结果 + 当前 Evidence Pack + Diff
    → Reviewer Review
    → 确定性质量门
    → VERIFIED Repair Record
    → 人工批准 / 拒绝
    → APPROVED / DEPRECATED
    → 带来源的 SQLite Repair Memory 召回
```

## 决策

### 1. Review 结果必须经过确定性质量门

`packages/core/src/domain/review.ts` 提供纯函数 `evaluateReviewQuality`，不调用
模型、不读外部状态。以下任一条件都会阻断：

- 受控验证未通过；
- Reviewer 的 `verdict` 为 `block`；
- finding 为 P0 或 P1；
- finding 明确标记为 `compatibility`；
- finding 明确标记为 `regression_test`，表示缺少或不足的回归测试。

普通 P2/P3 建议可以进入人工审批，但不能自动成为 APPROVED 记忆。Review finding
增加 `category`，使“兼容性问题”和“缺少回归测试”不依赖自然语言关键词判断。
Core 质量门还会重新运行完整 schema 校验；非法 `verdict`、`priority`、
`confidence`、空 `message`、非数组 `findings` 或非法来源结构均失败关闭，不能假设
所有 RuntimeAdapter 都复用 OmpAdapter 的解析器。

### 2. Review 只能消费受控持久化产物

`ExecutionOrchestrator.runReview` 仍然只从 `execution_results` 读取 Diff、验证退出码
和输出，并重新捕获工作树 Diff 校验哈希。`TaskOrchestrator.recordReviewAndGate`
还会校验：

- 任务处于 `REVIEWING`；
- 存在最新受控执行结果；
- 当前 Evidence Pack 存在、归属于该任务且版本一致。
- Pack 内容哈希必须按当前内容重新计算并与持久化值一致；Repair Record 和审计
  会保存 Pack 内容哈希。

`ReviewTaskInput` 同时携带 Pack 完整内容、最终 Diff 和受控验证结果。OmpAdapter
的 Review prompt 只使用这份冻结快照；Review JSON 缺少 `category`、使用非法枚举、
优先级、置信度或消息时失败关闭为 `block`，不得依靠兼容性关键词猜测分类。

正式根因不再是自由字符串。Reviewer 必须把 `rootCause` 输出为当前 Pack 中某个
`Hypothesis` 的完整副本（`text`、`confidence`、`evidenceIds`），适用条件也必须
逐项复制当前 Pack 的 `EvidenceConstraint`。Core 会校验每个 Evidence ID 属于当前
Pack，并校验根因/条件与 Pack 登记项完全匹配。新根因必须先走 Evidence Request 生成
新 Pack；只在 prompt 中声称“来自证据”不能通过质量门。

因此 API 调用方不能通过提交自制 Diff、验证结果或旧 Pack 来生成正式记忆。

### 3. Repair Record 不得跳过 VERIFIED

质量门通过时，Orchestrator 在同一 SQLite UnitOfWork 中创建带以下来源字段的
`VERIFIED` 记录，并把任务迁移到 `AWAITING_HUMAN_APPROVAL`：

- `inputEvidencePackId` / `inputEvidencePackVersion`；
- `diffHash`；
- `verificationResult`；
- `reviewResult`；
- 根因、根因置信度、根因 Evidence ID、修复摘要、适用条件及其 Evidence 绑定和
  失败原因。

质量门阻断时只创建 `DRAFT` 记录，任务迁移到 `FAILED`，不得进入人工批准。
Repair Record 状态机仍由 `DRAFT → VERIFIED → APPROVED → DEPRECATED` 约束，
`transitionRepairRecord` 拒绝跨过 VERIFIED 的批准路径。
Core 的通用 `transitionTask` 与 HTTP `/transition` 同时拒绝进入 `EXECUTING`、
`AWAITING_HUMAN_APPROVAL`、`COMPLETED` 和 `REJECTED`；这些状态只能由执行审批、
Review 质量门或人工决定的专用领域服务进入。

### 4. 人工决定必须与状态和记忆迁移原子提交

人工审批采用两步挑战协议。`POST /tasks/:taskId/human-approval/challenge` 使用
服务端配置的 `TRACEPILOT_HUMAN_APPROVER` 身份和
`TRACEPILOT_HUMAN_APPROVAL_SECRET` 通道凭证，签发绑定任务、Repair Record、Pack
版本及内容哈希、Diff 哈希、决定、过期时间和随机 nonce 的一次性挑战。
请求体不得提供 `approver`、`channelSecret` 或最终决定之外的身份字段。

`POST /tasks/:taskId/human-approval` 只接受处于
`AWAITING_HUMAN_APPROVAL` 且存在 VERIFIED 记录的任务，并要求挑战 token 和通道
凭证：

- `approved`：写入人类审批，`VERIFIED → APPROVED`，任务进入 `COMPLETED`；
- `rejected`：写入人类审批，`VERIFIED → DEPRECATED`，任务进入 `REJECTED`。

两条路径都会在同一事务内写审批、Repair Record 和任务审计。挑战 token 只在签发
响应中出现，服务端内存只保存 SHA-256 摘要；挑战消费后立即删除，服务重启后未
持久化挑战全部失效。服务端要求人工通道凭证至少 32 个字符。

最终人工决定由 `HumanDecisionFinalizationGuard` 强制执行：develop、review 与审批
共享同一任务级独占队列；审批关键区把整个 worktree 临时设为只读，捕获最终 Diff
与文件系统快照，在领域事务提交后再次捕获并比较。若外部进程在最终捕获与提交之间
修改已有文件或新增文件，系统会执行补偿事务，删除刚写入的人工审批，把 Repair
Record 恢复为 `VERIFIED`、任务恢复为 `AWAITING_HUMAN_APPROVAL`，追加
`human_approval_invalidated` 审计并失败关闭。确定性屏障测试覆盖修改与新增两类竞态。

### 5. SQLite 是 MVP Repair Memory 真源

`SqliteRepairMemoryAdapter` 默认只召回 `APPROVED`，显式请求
`minStatus=VERIFIED` 时才额外包含 VERIFIED。召回按项目隔离，并按症状 / 根因
匹配分数、更新时间和记录 ID 稳定排序。Fake Adapter 使用相同规则，便于契约测试。
两个 Adapter 的共享契约均通过公开 `write()` 写入；测试工厂只预建 SQLite 外键，
并覆盖默认 10 条、显式 limit、非法运行时查询、结构化写入错误、缺失外键、重复 ID
更新和失败回滚。

`VERIFIED` / `APPROVED` 状态本身不再被当作信任证明。SQLite 每次召回都会把记录
重新绑定到精确 ID、版本、任务归属和内容哈希的 Evidence Pack，并重算 Pack 哈希；
根因 hypothesis、置信度、Evidence ID 和适用条件 constraint 必须与 Pack 完全匹配，
Diff 哈希和成功验证摘要也必须能回溯到同一任务的受控 `execution_results`。任一来源
缺失、JSON 损坏或绑定不一致时，该行会失败关闭且不会被提升为
`VERIFIED_MEMORY`，但任务级审计入口仍可查看原始记录。

迁移 7 专门处理已有数据库：它只追加新迁移，不改写已经发布的迁移 5/6。升级时会
重新验证既有 `VERIFIED` / `APPROVED` 行；无法可靠证明完整来源链的记录统一降为
`DEPRECATED`，并在失败原因中记录迁移隔离标记。`DRAFT` 保持原状态，来源完整的
高可信记录可保留。重复启动不会再次改变已隔离记录。

迁移 8 追加项目归属隔离。可信来源解析器会加载 Repair Record 所声明的 Task，并
要求 Task 的真实 `projectId` 与记录的 `projectId` 一致；已经应用迁移 7 的数据库中，
任何跨项目 `VERIFIED` / `APPROVED` 行都会在迁移 8 降为 `DEPRECATED`。运行时召回
复用同一解析器，因此手工导入或后续损坏也不能把其他项目任务的来源提升为当前项目
的可信记忆。

Repair Record ID 的项目和任务构成不可变身份。重复 ID 只允许在同一项目、同一任务
内更新状态或升级 Evidence Pack 来源；SQLite UPSERT 会原子更新 Pack ID、版本、
内容哈希、根因绑定、Diff、验证和 Review 字段。写入前会在同一 UnitOfWork 中加载
项目、Task、精确 Pack 版本和匹配 Diff 的 ExecutionResult 并执行完整来源校验。
跨项目 Task 组合返回 `project_mismatch`，用重复 ID 覆盖其他项目或任务返回
`identity_mismatch`，事务不会留下混合来源行。

项目召回入口默认最多返回 10 条记录，也可以通过 `maxResults` 指定 1 到 100 条：

```text
GET /projects/:projectId/repair-memory?symptom=...&rootCause=...&maxResults=...
```

响应中的每条记录附带 `sourceLocator`，包含 adapter、recordId、taskId、Evidence
Pack 版本、根因/适用条件 Evidence ID 和 Diff 哈希。任务级审计入口
`GET /tasks/:taskId/repair-records` 保留 DRAFT、VERIFIED、APPROVED、DEPRECATED
全生命周期，便于人工查看和追溯。

Phase 5 不引入 SAG、Docker、PostgreSQL 或其他必需外部服务。SAG 仍属于后续
Resume Release 的可选异步镜像能力，不能替代 SQLite 真源或阻塞 MVP 闭环。

## 后果

正面影响：

- Review 的“能否继续”由可测试的规则决定，而不是由模型措辞决定；
- 兼容性和回归测试缺口可被明确阻断；
- 只有人工明确批准的记录进入默认记忆召回；
- 每条批准记忆可回到任务、Evidence Pack、Diff 和验证结果。

当前限制：

- Phase 5 尚未由独立 Reviewer 正式签发；
- Reviewer 身份隔离由受控 OmpAdapter + 服务端挑战配置承担；正式的人类 UI 和
  多用户身份提供仍留在后续 Dashboard / Resume Release；
- `ExecutionResult` 当前持久化单条项目 test 命令的退出结果，后续如扩展多命令
  验证，应扩展该领域模型以保存完整命令清单。

## 验证范围

实现配套了完整质量门 schema/Evidence 绑定单元测试、敏感状态旁路测试、
TaskOrchestrator Review→审批场景测试、OmpAdapter Review JSON 解析回归、
Fake/SQLite KnowledgeAdapter 共享公开写入契约、SQLite 证据字段往返，以及 API
最终 Diff 屏障与补偿测试。P1-08 另有从迁移 5 数据库升级到最新版的集成测试，覆盖
旧 APPROVED/VERIFIED/DRAFT 隔离、合法新记录来源召回、重复启动幂等，以及手工
篡改或损坏高可信行的失败关闭。迁移 8 和共享 KnowledgeAdapter 契约继续覆盖跨项目
写入/脏行隔离、同来源状态更新、新 Pack 版本原子更新、跨身份更新拒绝与失败回滚。
`pnpm test:phase5-real` 使用真实临时 Git 仓库、外置
worktree、实际测试命令、SQLite Pack/ExecutionResult 和 API `/run` 质量门验证两个
真实 Omp Reviewer 场景；仍需用户明确授权合成材料外发与模型费用后，由独立
Reviewer 运行。本轮实现方未调用外部模型。上述均是实现方自测材料，不替代独立
阶段验收。
