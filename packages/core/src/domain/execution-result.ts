/**
 * ExecutionResult 领域模型 —— P1-03（Phase 4 验收）。
 *
 * 持久化 `runDevelop` 产出的受控 Diff 哈希、patch、changedFiles、
 * 验证命令退出码、验证 stdout/stderr。`runReview` 仅从此表读取
 * 受控来源的验证产物，不接受调用方提交的 Diff 或验证结果。
 *
 * 安全约束（不可绕过）：
 * - Reviewer 只接收原始任务、Pack、最终 Diff、验证结果、验收条件
 *   （§8.1 第 8 步）。Diff 与验证结果必须来自受控来源（runDevelop
 *   持久化到 execution_results 表），不得由 API 调用方提交。
 * - 若当前工作树 Diff 与已验证哈希不一致，必须拒绝 Review 并要求
 *   重新验证（P1-03 修复要求 2）。
 */

/**
 * 持久化的执行结果。
 *
 * 每次 `runDevelop` 完成后写入一条记录。`runReview` 通过 taskId
 * 查询最新一条记录，从中读取受控的 Diff 和验证结果。
 */
export interface ExecutionResult {
  readonly id: string;
  readonly taskId: string;
  /** 关联的 Runtime runId（develop 阶段的 runId）。 */
  readonly runId: string;
  /** Diff 哈希（用于 Review 时校验工作树未被篡改）。 */
  readonly diffHash: string;
  /** Diff patch 内容。 */
  readonly diffPatch: string;
  /** Diff 变更文件列表（JSON 序列化形式存储）。 */
  readonly diffChangedFiles: readonly string[];
  /** Diff 原始字节数。 */
  readonly diffBytes: number;
  /** 验证命令退出码；0 表示测试通过。 */
  readonly verificationExitCode: number;
  /** 验证是否通过（exitCode === 0）。 */
  readonly verificationPassed: boolean;
  /** 验证命令 stdout。 */
  readonly verificationStdout: string;
  /** 验证命令 stderr。 */
  readonly verificationStderr: string;
  readonly createdAt: string;
}
