# ADR-004：SAG 作为 SQLite 真源后的可选镜像与检索增强

- 状态：已采纳（Phase 7 候选实现）
- 日期：2026-08-12

## 背景

TracePilot 的任务、审批、Evidence Pack、执行产物和 Repair Record 已以 SQLite
为唯一真源。Resume Release 需要通过 `KnowledgeAdapter` 使用本地 SAG 检索
ADR、Issue、PR 和 Repair Record，但不能使现有 MVP 依赖 SAG、Docker、
PostgreSQL 或任何远程基础设施。

## 决策

1. 每个 TracePilot 项目可选绑定一个由操作者显式提供的 `knowledgeSourceId`；
   不从网页扫描 Source，也不允许请求参数临时指定 Source。
2. 仅当 Repair Record 已在 SQLite 中变为 `APPROVED` 时，SQLite 事务才创建
   `sag_outbox` 记录。网络请求永不在 SQLite 事务内发生。
3. `SqliteSagOutbox` 在事务提交后领取、投递、确认或按指数退避重试。SAG
   不可达时 Repair Record、任务、审批与审计均保持原状。
4. `SagKnowledgeAdapter` 先向 SQLite 查询并验证 Repair Record 来源链；SAG
   只能返回这些 SQLite 记录的排序提示。陌生 ID、重复 ID、跨项目 ID 和网络
   错误一律忽略或回退 SQLite 基线。
5. `SagHttpTransport` 只接受 loopback `http(s)` 地址，令牌只留在 API 进程
   请求头中，不向 Dashboard、Runtime、验证进程或审计日志暴露。

## 真实 SAG 协议

Phase 7 使用本机 SAG 的 source-scoped 接口：

- `POST /api/v1/sources/{sourceId}/documents/ingest`
- `POST /api/v1/sources/{sourceId}/search`

每个镜像文档都带 `tracepilot_repair_record_id`、项目 ID、来源定位符、标题和
内容哈希。结果还必须与 SQLite `sag_source_documents` 中的项目、Source、类别、
locator、标题和哈希完全一致，才可作为新 Evidence Pack 的候选材料。

SAG 的文档写入是后台处理：`SagHttpTransport` 把 `202`、处理中状态或无法读取
状态的响应视为未投递完成。它必须从写入回执取得同源的文档或任务状态地址，轮询到
`READY` / `COMPLETED` / `INDEXED` 后才确认 outbox；失败、超时或没有可检查状态地址
都会保留为可重试失败。长内容按受限段落重复携带 TracePilot 来源元数据，确保 SAG
分块后仍可由 SQLite 的来源链反向核验。这个等待发生在 SQLite 提交之后，绝不占用
SQLite 写事务或阻塞任务完成。

## 未验证限制

公开资料确认 source-scoped 写入与搜索，但没有为 TracePilot 当前版本提供已验证
的文档更新/去重保证。因此 outbox 以稳定内容哈希抑制本地重复待办，语义是
“至少一次投递”。若网络在本地发送成功后中断，真实 SAG 可能需要由其自身的
文档标题/内容去重或运维清理处理。受保护的 `pnpm test:phase7-real` 会使用两个
真实 Omp 合成任务验证首次投递和来源召回；它不会把重复投递当作已验证。正式签发前，
独立 Reviewer 仍必须针对运行中的本地 SAG 验证重复投递行为并记录实际 API 版本与结果。

## 后果

- 未配置 `TRACEPILOT_SAG_BASE_URL` 和 `TRACEPILOT_SAG_TOKEN` 时，MVP 原有
  SQLite 路径完整可用。
- 只配置其中一个环境变量时 API 启动失败关闭，避免操作者误以为已启用 SAG。
- Phase 7 不能据此声明已完成跨文档真实 SAG 演示；尚需本地 SAG、来源资料、
  Omp 真闭环和独立验收证据。
