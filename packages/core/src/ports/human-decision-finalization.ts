/**
 * 人工决定最终提交守卫 —— Phase 5 审批 TOCTOU 安全边界。
 *
 * 守卫覆盖“最终 Diff 重抓 → 审批事务提交 → 提交后复核”的完整关键区。
 * TaskOrchestrator 只负责领域原子事务；真实 worktree 的冻结、任务级互斥、
 * 前后 Diff/快照复核以及异常补偿由实现本端口的执行编排器负责。
 */

export interface HumanDecisionFinalizationInput<T> {
  readonly taskId: string;
  readonly expectedDiffHash: string;
  /** 在最终 Diff 已确认后提交领域事务。 */
  readonly commit: () => Promise<T>;
  /** 提交后发现外部文件竞态时撤销领域结果。 */
  readonly compensate: (committed: T) => Promise<void>;
}

export interface HumanDecisionFinalizationGuard {
  finalize<T>(input: HumanDecisionFinalizationInput<T>): Promise<T>;
}

