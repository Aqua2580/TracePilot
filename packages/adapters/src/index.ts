/**
 * @tracepilot/adapters —— Runtime / Knowledge / Git / Process 实现。
 *
 * - LocalCommandAdapter：ADR-001 的 MVP Runtime 兜底实现（无需 omp）
 * - OmpAdapter：Phase 4 Spike 前抛 OmpUnavailableError 的 stub
 * - LocalProcessRunner：受治理闸门管控的子进程执行
 * - Fake* 适配器：确定性测试实现；必须与真实适配器通过同一套契约测试
 *   （§6）
 */

export {
  LocalCommandAdapter,
  OmpAdapter,
  OmpUnavailableError,
  PolicyDeniedError,
  hashDiff,
  type LocalCommandAdapterOptions
} from "./local-command-adapter.js";
export { LocalProcessRunner } from "./local-process-runner.js";
export {
  FakeRuntimeAdapter,
  FakeKnowledgeAdapter,
  FakeGitAdapter,
  FakeProcessRunner,
  type FakeRuntimeBehaviour
} from "./fakes.js";
