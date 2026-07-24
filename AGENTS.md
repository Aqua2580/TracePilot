# TracePilot AI 实现约束

在修改实现前，必须完整阅读 `docs/IMPLEMENTATION_SPEC.md`。

## 实现规则

1. 在增加并行 Agent、复杂 Dashboard 或 SAG 前，先交付 MVP 纵向闭环。
2. 领域逻辑必须独立于 Fastify、Drizzle、Pi/oh-my-pi 和 React。
3. 所有外部集成必须通过 Adapter，并具备契约测试。
4. 不得直接在用户代码仓库修改；必须使用已登记的外置 Git worktree。
5. 命令、路径、审批和审计策略是不可绕过的安全边界。
6. 未满足阶段退出条件和规定测试前，不得声称阶段完成。
7. MVP 只使用 SQLite 持久化；除非后续已批准的 ADR 明确变更，否则不得引入 Docker、PostgreSQL、Prisma、Redis 或必需的 SAG 服务。
8. SQLite Repair Memory 是 MVP 真源。SAG 对 MVP 可选且不阻塞，但在完成 SQLite 纵向闭环后，必须通过 `KnowledgeAdapter` 接入，作为 Resume Release 的必备能力。
9. `LocalCommandAdapter` 仅可用于 Spike、测试或已明确记录的降级模式。Resume Release 必须由真实 `OmpAdapter` 完成仓库分析、worktree 修改、验证、Diff 获取和独立审查。
10. Evidence Pack 按版本不可变，但并非永久冻结。Agent 必须提交 Evidence Request，由 Orchestrator 生成新版本后，才能把新发现的材料作为正式结论。
11. **所有开发者文档、ADR、AI 指令、代码注释、测试描述和评审反馈必须使用中文。** 类型名、变量名、协议字段、第三方包名和命令行参数可保留其原始英文形式；不得为了翻译破坏代码接口。
12. Phase 1 已于 2026-07-24 经独立 Reviewer 验收通过。进入 Phase 2 前必须阅读 `docs/reviews/PHASE-1-ACCEPTANCE-REVIEW.md`，保留其中 P2 延后项并按后续阶段关闭；若改动 Phase 1 安全边界，必须补齐回归与对抗性测试并重新独立复核。
13. **实现与验收必须职责分离。** 实现 Agent 可以运行测试并提交自测证据，但不得自行把验收报告改为“通过”、自行关闭 P1/P2，或批准自己实现的代码。阶段验收只能由未参与该实现的独立 Reviewer Agent 在重新阅读规格、验收报告和代码后完成；Reviewer 必须独立运行规定命令并记录结论与未解决问题。
