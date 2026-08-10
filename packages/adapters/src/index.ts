/**
 * @tracepilot/adapters —— Runtime / Knowledge / Git / Process 实现。
 *
 * - LocalCommandAdapter：ADR-001 的 MVP Runtime 兜底实现（无需 omp；降级用途）
 * - OmpAdapter：ADR-007 的 Phase 4 真实 Runtime 实现（prompt 驱动 omp 二进制）
 * - LocalProcessRunner：受治理闸门管控的子进程执行
 * - LocalGitAdapter：Phase 3 真实 GitAdapter 实现（worktree / diff / history / blame）
 * - git-parsers：git log/blame/diff/status 输出的纯字符串解析器
 * - Fake* 适配器：确定性测试实现；必须与真实适配器通过同一套契约测试
 *   （§6）
 */

export {
  LocalCommandAdapter,
  PolicyDeniedError,
  hashDiff,
  type LocalCommandAdapterOptions
} from "./local-command-adapter.js";
export {
  OmpAdapter,
  OmpUnavailableError,
  OmpArgvValidationError,
  parseOmpNdjsonEvents,
  extractAssistantTextFromOmpNdjson,
  buildReviewResultOutputExample,
  extractReviewResult,
  extractFileChangesFromStdout,
  extractFileChangesFromText,
  type OmpAdapterOptions
} from "./omp-adapter.js";
export { LocalProcessRunner } from "./local-process-runner.js";
export {
  LocalGitAdapter,
  resolveDefaultWorktreePath,
  type LocalGitAdapterOptions
} from "./local-git-adapter.js";
export { LocalWorktreeFilesystemGuard, ExecutionIsolationError } from "./local-worktree-filesystem-guard.js";
export { LocalControlledFileWriter } from "./local-controlled-file-writer.js";
export {
  parseGitLog,
  parseGitBlame,
  parseGitDiffChangedFiles,
  parseGitStatusPorcelain
} from "./git-parsers.js";
export {
  FakeRuntimeAdapter,
  FakeKnowledgeAdapter,
  FakeGitAdapter,
  FakeProcessRunner,
  type FakeRuntimeBehaviour
} from "./fakes.js";
// 从 core 重新导出 BlameQuery / BlameEvidence，方便调用方从 adapters 包一次性导入。
export { type BlameQuery, type BlameEvidence } from "@tracepilot/core";
