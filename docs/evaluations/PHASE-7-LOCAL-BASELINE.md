# Phase 7 本地三组检索评测基线

这是一组在真实 Resume Release 演示前运行的固定合成夹具。输入来自既有
`packages/store/src/benchmarks.ts` 的 8 个 Phase 2 基准任务；执行以下命令可
重新计算机器可读结果：

```powershell
pnpm --filter @tracepilot/api run evaluate:phase7
```

运行命令本身不访问 SAG、不调用 Omp 或外部模型，也不创建 Patch、审批或费用。
输出中的 `configuration.inputHash` 是本次固定任务输入的 SHA-256；合成夹具没有
真实 Git 仓库，因此不会伪造仓库 SHA。

| 组别 | Adapter | 样本数 | 关键来源 Recall@5 | 其余发布指标 |
| --- | --- | ---: | ---: | --- |
| 无记忆 | 实际调用空 `FakeKnowledgeAdapter` | 8 | 0.00 | `null`（未测量） |
| SQLite Memory | 实际调用已种入固定 Repair Record 的 `FakeKnowledgeAdapter` | 8 | 0.625 | `null`（未测量） |
| SAG 增强 | 实际调用 `SagKnowledgeAdapter`；内存传输替身只重排同项目 SQLite 真源 | 8 | 1.00 | `null`（未测量） |

本夹具证明的是固定输入、项目隔离、三种 Adapter 调用和来源排序的可复算性。SAG
组使用内存传输契约替身，只能重排 SQLite 已核验的同项目来源，不能新增未验证材料；
因此它不能说明真实 SAG 已连通或记忆已经提高修复质量。

任务闭环率、Patch 验收率、无依据修改率、人工介入次数、耗时与 Token/费用均明确
记录为 `null`，含义是“本夹具没有测量”，不是零。真实结果只能在用户再次授权 Omp
和本机 SAG 后运行、保存原始产物，并与这份基线并列报告；在此之前不得用此文档宣称
Phase 7 已通过或 Resume Release 已完成。
