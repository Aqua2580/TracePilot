# ADR-001：Runtime 边界 —— oh-my-pi / LocalCommandAdapter

- **状态：** 已接受（MVP 降级方案）
- **日期：** 2026-07-23
- **阶段：** Phase 0（Runtime Spike）
- **取代：** 无
- **被取代：** 暂无；真实 `OmpAdapter` Spike 成功后重新评审

## 背景

`docs/IMPLEMENTATION_SPEC.md` §3 要求：不得凭空假设 Pi / oh-my-pi 的实际 API。Phase 0 需要完成最小 `OmpAdapter` 探针，在指定工作目录中验证读取、受限编辑、测试运行、Diff、事件回传、取消和超时行为。

如果探针不可用或不稳定，必须在保持 `RuntimeAdapter` 接口不变的前提下，落地 `LocalCommandAdapter` 作为降级 Runtime，使后续真实 `OmpAdapter` 可以替换它而无需修改 Orchestrator。

## Spike 结果（2026-07-23）

| 检查项 | 结果 |
| --- | --- |
| 开发机执行 `omp --version` | **未安装**。PowerShell 返回“无法将 `omp` 识别为 cmdlet、函数、脚本文件或可运行程序”。 |
| 尝试 `bun install -g @oh-my-pi/pi-coding-agent` | 本次 Spike 未执行。该操作需要全局安装工具与网络权限，超出 MVP 当前边界。 |
| 本地 `git`、`node`、`pnpm` | 可用：`git 2.55.0.windows.2`、`node v22.16.0`、`pnpm 11.16.0`。 |

结论：当前环境不存在 `omp` 二进制，无法执行真实 `OmpAdapter` Spike。依据规格中“若失败，落地 `LocalCommandAdapter`”的 Phase 0 退出条件，MVP 暂时采用 `LocalCommandAdapter`。

## 决策

1. **MVP Runtime 为 `LocalCommandAdapter`。** 它通过 Node `child_process`、本地 `git` 二进制和文件系统原语实现 `RuntimeAdapter`；不引入 `omp` 依赖。
2. **`RuntimeAdapter` 是唯一 Runtime 契约。** `LocalCommandAdapter`（真实降级实现）和 `FakeRuntimeAdapter`（测试实现）都必须实现它。未来 `OmpAdapter` 必须实现同一接口，并通过同一套契约测试后才可成为默认实现。
3. **`LocalCommandAdapter` 仅允许用于 MVP、Spike 或明确记录的降级模式。** 按 `AGENTS.md` 第 9 条与 Resume Release Definition of Done，最终简历发布版必须演示真实 `OmpAdapter` 完成仓库分析、代码修改、验证、Diff 获取和独立审查；`LocalCommandAdapter` 不能成为该演示的唯一 Runtime。
4. **源代码中不固化对 `omp` API 的猜测。** 当真实 Spike 可执行后，本 ADR 应由新的 ADR 取代，记录已验证的 `omp` 调用方式、流式协议、取消语义与输出结构。在此之前，`OmpAdapter` 仅保留为会抛出 `OmpUnavailableError` 的未实现桩，调用方必须显式选择 `LocalCommandAdapter` 或 `FakeRuntimeAdapter`。
5. **降级 Runtime 不能绕过安全边界。** `LocalCommandAdapter` 发起的所有命令都必须通过与未来 `OmpAdapter` 相同的 `ProcessRunner`、`CommandPolicy` 和 `PathPolicy`。不得由模型输出构造 argv；启动子进程前必须解析路径并验证其在登记的 worktree 内。

## 影响

- **正面影响：** MVP 不会被 `omp` 安装阻塞；契约边界使后续替换成本较低；所有 Runtime 可共享治理规则。
- **负面影响：** `LocalCommandAdapter` 无法提供 `omp` 的完整能力，例如 LSP 感知编辑、DAP 调试、hashline 编辑、具有 P0-P3 结论的 `/review`。因此 MVP Reviewer 只能基于 Diff 与验证结果运行确定性本地审查，不能将其表述为 `omp /review`。
- **后续动作：** Phase 4 必须再次尝试真实 `OmpAdapter` Spike。如果仍失败，则 Resume Release Definition of Done 不满足，必须新增 ADR 重新界定发布范围。

## 待解决问题（留待 Phase 4 Spike）

- 非交互式分析、开发、审查分别使用哪个 `omp` 子命令。
- 流式事件协议：换行分隔 JSON、SSE 或其他帧格式。
- 取消信号：SIGINT、`/cancel` 命令或优雅排空。
- `/review` 的输出结构：P0-P3、置信度、文件与行定位。
- `omp` 是否支持等价于已登记 worktree 约束的 `cwd` 或 `--worktree` 参数。

