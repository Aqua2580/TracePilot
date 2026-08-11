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
13. Phase 2 已于 2026-07-24 经独立 Reviewer 验收通过。进入 Phase 3 前必须阅读 `docs/reviews/PHASE-2-ACCEPTANCE-REVIEW.md`；若改动 SQLite 运行时、迁移、单写入队列、API 组合根或固定基准闭环，必须补齐回归测试并重新独立复核。
14. **实现与验收必须职责分离。** 实现 Agent 可以运行测试并提交自测证据，但不得自行把验收报告改为“通过”、自行关闭 P1/P2，或批准自己实现的代码。阶段验收只能由未参与该实现的独立 Reviewer Agent 在重新阅读规格、验收报告和代码后完成；Reviewer 必须独立运行规定命令并记录结论与未解决问题。
15. **Node 运行时版本要求 ≥ 22（推荐 24 LTS）。** `engines.node` 声明 `>=22.0.0`，`pnpm-workspace.yaml` 启用 `engineStrict: true` 确保下限检查，根目录 `.nvmrc` 固定 `24`。原因：`better-sqlite3@12` 通过 `prebuild-install` 提供 Node 22 (ABI 127) 与 Node 24 (ABI 137) 的预编译二进制。变更 Node 主版本前必须确认 `better-sqlite3` 提供对应 ABI 的预编译包，并验证原生依赖在干净安装后可加载。
16. Phase 3 已于 2026-07-27 经独立 Reviewer 验收通过。进入 Phase 4 前必须阅读 `docs/reviews/PHASE-3-ACCEPTANCE-REVIEW.md`；若改动外置已登记 worktree、项目仓库根/受控 worktree 根分离、执行审批范围哈希、Git 审计或 Evidence Pack 不可变性边界，必须补齐回归与对抗性测试并重新独立复核。
17. **Phase 4 已于 2026-08-03、Phase 5 已于 2026-08-10 经独立 Reviewer 正式验收通过，Phase 5 的 P1 已全部关闭，当前允许进入 Phase 6。** 开始 Phase 6 前必须阅读 `docs/reviews/PHASE-5-ACCEPTANCE-REVIEW.md` 第 23 节和 README 阶段状态；P2-05“执行审批拒绝状态收口”作为非阻断项继续跟踪。后续修改 Review、人工审批或 Repair Memory 时，必须补齐相应的单元、集成、API 对抗性、契约和真实 Reviewer 回归测试，并重新由未参与实现的独立 Reviewer 复核。Phase 6 不得回退 Phase 4/5 已验收的命令、路径、外置 worktree、凭据隔离、服务端 Diff/验证来源、Review schema、确定性质量门、人工审批、SQLite Repair Memory、取消和失败关闭边界；SAG 只能通过 `KnowledgeAdapter` 后置接入，不得替换 SQLite MVP 真源。
18. **Phase 6 已于 2026-08-11 经独立 Reviewer 正式验收通过并签发，首轮 P1-01 至 P1-03 已全部关闭，当前允许进入 Phase 7。** 开始 Phase 7 前必须阅读 `docs/reviews/PHASE-6-ACCEPTANCE-REVIEW.md` 第 7 节。后续不得回退 Dashboard 同源/loopback 默认边界、受控 UI 编排、Evidence Request 与 Pack 版本、Plan 与执行审批、外置 worktree、服务端 Diff/验证、独立 Review、确定性质量门、最终人工挑战、SQLite 投影、SSE 从 SQLite 恢复、静态安全头和 Playwright 浏览器闭环。浏览器测试替身只能经 `runtimeOverride` 显式注入并标注，不能替代真实 Omp 发布路径。P2-05“执行审批拒绝状态收口”继续作为非阻断项跟踪；SAG 仍只能通过 `KnowledgeAdapter` 后置接入，不得替换 SQLite MVP 真源或引入 Docker/PostgreSQL 必需依赖。
