# ADR-010：本机 debugpy 运行时证据边界

- 状态：已采纳（Phase 7 候选实现）
- 日期：2026-08-12

## 背景

Phase 7 的 Resume Release 需要至少一个可追溯的运行时调试证据场景：从
pytest 堆栈定位暂停位置，读取局部变量，并将其写入新的 `runtime` Evidence。
这项能力不能改变 TracePilot 的基本边界：SQLite 仍是唯一真源，Evidence Pack
仍按版本不可变，且不得将任意远程调试器、变量值或调试命令暴露给 Dashboard、
Runtime 或模型。

候选实现的受保护门禁会在 `127.0.0.1` 验证
`initialize → attach → initialized → configurationDone → stopped → stackTrace →
scopes → variables`，并从合成 Python pytest 暂停帧读取局部变量。该场景仅在
操作者显式设置 `TRACEPILOT_PHASE7_DEBUGPY_ACK=1` 并执行
`pnpm test:phase7-debugpy` 后运行；它不调用 Omp、模型或 SAG。未执行时必须
显示为未验证，不得以本地替身测试替代真实本机结果。

## 决策

1. Core 定义 `RuntimeDebugEvidenceAdapter`，由 `DebugpyRuntimeEvidenceAdapter`
   实现；Core 不依赖 TCP、debugpy 或 Node API。
2. Adapter 只连接固定的 `127.0.0.1`，端口仅可为 1024 至 65535；不接受主机名、
   远程地址、任意 DAP 方法或任意启动命令。
3. 仅从 pytest 格式堆栈的最后一个 Python 文件行定位源码，并通过既有
   `PathPolicy` 验证其真实路径位于已登记 worktree 内。工作树外路径、符号链接
   逃逸、缺失暂停帧和协议异常一律失败关闭。
4. 只读取匹配源文件的第一个暂停帧、`Locals` 作用域和最多 20 个变量；疑似
   凭据名称的值替换为 `[redacted]`，单个非敏感值最多保留 240 个字符。
5. API 端点 `POST /tasks/:taskId/runtime-evidence/python` 不接受 EvidenceItem、
   调试主机或变量值。它验证任务和登记 worktree，先持久化 `runtime`
   Evidence Request，再调用 Adapter，最后经 `evolvePackWithNewEvidence` 生成
   Pack v(n+1)。端点仅在 `GATHERING_EVIDENCE` 状态可用；执行中的任务必须先
   经既有 Evidence Gap 回环返回该状态。采集失败时不会生成新 Pack。
6. Adapter 不启动 debugpy、不运行 pytest、不修改工作树、不调用模型、也不写
   SQLite；操作者须在受控本机工作树中另行启动短生命周期调试会话。
7. 调试证据的取消信号只能由 API 请求生命周期创建。客户端断开时 Adapter 立即
   销毁 DAP socket，并且不再发送清理请求或等待 DAP 超时；浏览器请求体不得
   伪造 `AbortSignal`。

## 后果

- Pack v1 永远保留；运行时证据只会进入可审计的新版本。
- Dashboard 不能把任意调试会话当作数据通道；它只能请求受限采集入口。
- DAP 连接意外中断、端口不可用或返回格式异常都会失败关闭，任务与现有 Pack
  保持原状。
- 当前实现覆盖最小 Python/debugpy 场景，不等价于生产远程调试、自动设置断点、
  自动启动调试器或多语言 DAP 支持；这些能力需新 ADR 和独立验收。
