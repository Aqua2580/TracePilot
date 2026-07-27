/**
 * WorktreeManager —— Phase 3 P1-01 / P1-03 修复。
 *
 * 见规格 §5.3、§7.1、§7.3、§8.1 步骤 5、ADR-002。
 *
 * 这是 worktree 生命周期的唯一受控入口。它把"Adapter 执行真实 git
 * 操作"与"Orchestrator 在事务内登记/解除登记 + 写审计"组合成一条
 * 受控链路，确保：
 *
 * 1. **登记一致**：`createWorktree` 成功后，worktree 必须在同一事务内
 *    落库到 `worktrees` 表，并更新 `task.worktreeId`（P1-01）。
 * 2. **回收安全**：`removeWorktreeIfTerminal` 必须先从数据库加载登记
 *    记录（拒绝伪造对象）、校验任务处于终态（拒绝非终态回收）、再调用
 *    Adapter 的 `removeRegisteredWorktree`，最后在事务内删除登记并写
 *    `worktree_removed` 审计（P1-01）。
 * 3. **审计链完整**：所有 git 命令（worktree add / git rev-parse /
 *    worktree remove / --force）通过 `GitCommandAuditSink` 收集，并在
 *    事务内追加为 `command_executed` 审计事件，包含 argv、cwd、exitCode、
 *    输出截断信息（P1-03）。
 *
 * WorktreeManager 只依赖 core ports（GitAdapter、TaskOrchestrator、
 * UnitOfWork），不依赖 Fastify / Drizzle / Git SDK。
 *
 * **不变量**：
 * - 永不把调用方传入的任意 `Worktree` 对象视为"已登记"——必须从
 *   `WorktreeRepository.findById` 加载。
 * - 永不绕过 `TaskOrchestrator.attachWorktree` / `detachWorktree`——
 *   后者负责事务一致性。
 * - 永不在事务回调内执行 git I/O（§3.1）——`GitAdapter` 调用必须在
 *   事务外完成，事务内只做持久化与审计追加。
 */

import type {
  GitAdapter,
  CreateWorktreeInput,
  Worktree,
  DiffArtifact
} from "../ports/adapters.js";
import type { UnitOfWork } from "../ports/repositories.js";
import type { TaskOrchestrator } from "./task-orchestrator.js";
import type { TaskStatus } from "../domain/task.js";
import { isTerminalStatus } from "../domain/task.js";
import { createAuditEvent } from "../domain/audit.js";
import {
  BufferedGitCommandAuditSink,
  flushGitCommandAudits
} from "./git-audit-sink.js";
import { computeScopeHash } from "./task-orchestrator.js";

/**
 * WorktreeManager 依赖。
 *
 * `unitOfWork` 用于在 git 操作完成后写 command_executed 审计事件；
 * `orchestrator` 用于 attachWorktree / detachWorktree（事务内登记）。
 */
export interface WorktreeManagerDeps {
  readonly gitAdapter: GitAdapter;
  readonly orchestrator: TaskOrchestrator;
  readonly unitOfWork: UnitOfWork;
}

/**
 * Worktree 未在数据库登记时抛出（P1-01）。
 *
 * 阻止"调用方传入伪造 Worktree 对象 → Adapter 触发 git worktree remove"
 * 的攻击路径。
 */
export class WorktreeNotRegisteredException extends Error {
  constructor(worktreeId: string) {
    super(`worktree ${worktreeId} 未在数据库登记，拒绝回收（P1-01）`);
    this.name = "WorktreeNotRegisteredException";
  }
}

/**
 * 任务未处于终态时回收 worktree 抛出（P1-01）。
 *
 * 防止误删仍需使用 worktree 的非终态任务的工作目录。
 */
export class WorktreeTaskNotTerminalException extends Error {
  constructor(taskId: string, status: TaskStatus) {
    super(
      `任务 ${taskId} 处于非终态 ${status}，拒绝回收其 worktree（P1-01）`
    );
    this.name = "WorktreeTaskNotTerminalException";
  }
}

/**
 * 任务状态不允许创建 worktree 时抛出（P1-R03）。
 *
 * 见规格 §8.1 步骤 5：worktree 创建必须在 AWAITING_EXECUTION_APPROVAL
 * 状态且已有有效 execution approval 时才允许。
 */
export class WorktreeCreationNotAllowedException extends Error {
  constructor(taskId: string, status: TaskStatus) {
    super(
      `任务 ${taskId} 状态 ${status} 不允许创建 worktree；必须先迁移到 AWAITING_EXECUTION_APPROVAL 并获得执行审批（P1-R03）`
    );
    this.name = "WorktreeCreationNotAllowedException";
  }
}

/**
 * 缺少有效 execution approval 时创建 worktree 抛出（P1-R03）。
 */
export class MissingExecutionApprovalException extends Error {
  constructor(taskId: string) {
    super(
      `任务 ${taskId} 缺少有效的 execution approval，拒绝创建 worktree（P1-R03）`
    );
    this.name = "MissingExecutionApprovalException";
  }
}

/**
 * execution approval 的 scopeHash 与当前 Plan scopeHash 不一致时抛出（P1-R03）。
 *
 * 防止 approval 后修改 Plan 或 Project.commands 导致范围扩大而绕过审批。
 */
export class WorktreeScopeMismatchException extends Error {
  constructor(taskId: string, expected: string, actual: string) {
    super(
      `任务 ${taskId} 的 execution approval scopeHash (${actual}) 与当前 Plan scopeHash (${expected}) 不一致，拒绝创建 worktree（P1-R03）`
    );
    this.name = "WorktreeScopeMismatchException";
  }
}

export class WorktreeManager {
  constructor(private readonly deps: WorktreeManagerDeps) {}

  /**
   * 创建受控 worktree 并登记到任务（P1-01 / P1-03 / P1-R03）。
   *
   * P1-R03 新增：执行审批闸门。
   * 见规格 §7.2、§8.1 步骤 5、ADR-002：创建 worktree 必须在
   * AWAITING_EXECUTION_APPROVAL 状态且已有有效 execution approval 时
   * 才允许。allowedPaths 必须从 Plan 读取，不得信任调用方传入的任意值。
   *
   * 流程：
   * 1. **审批校验（事务内，Git I/O 之前）**：
   *    - 任务存在性
   *    - `task.status === "AWAITING_EXECUTION_APPROVAL"`，否则抛
   *      `WorktreeCreationNotAllowedException` 并写 `policy_denied` 审计
   *    - 存在有效 execution approval（未失效），否则抛
   *      `MissingExecutionApprovalException` 并写 `policy_denied` 审计
   *    - approval.scopeHash === 当前 Plan 的 scopeHash（从 Plan.allowedPaths
   *      + Project.commands keys + TaskInput.riskLevel 计算），否则抛
   *      `WorktreeScopeMismatchException` 并写 `policy_denied` 审计
   *    - 从 Plan 读取 allowedPaths（覆盖调用方传入的 input.allowedPaths）
   * 2. 创建 `BufferedGitCommandAuditSink` 收集 git 命令审计。
   * 3. 调用 `GitAdapter.createWorktree(input, auditSink)` —— 真实 git
   *    操作（rev-parse / status / worktree add）。失败时不登记，直接
   *    上抛；调用方负责清理（本方法不在失败路径猜测清理）。
   * 4. 调用 `TaskOrchestrator.attachWorktree(taskId, worktree)` —— 在
   *    事务内 `tx.worktrees.save(worktree)` + 更新 task.worktreeId +
   *    写 worktree_created 审计。
   * 5. 在事务内把收集到的 git 命令审计逐条追加为 `command_executed`
   *    事件（P1-03）。
   *
   * @returns 登记后的 worktree（与 git 操作结果一致）
   */
  async createAndAttachWorktree(args: {
    readonly taskId: string;
    readonly input: CreateWorktreeInput;
  }): Promise<Worktree> {
    // 1. P1-R03：审批校验（事务内，Git I/O 之前）。
    //    从 Plan 读取 allowedPaths，覆盖 input.allowedPaths。
    const authorizedInput = await this.authorizeWorktreeCreation(args);

    const auditSink = new BufferedGitCommandAuditSink();

    // 2. 真实 git 操作（事务外）。失败时不登记，由调用方处理。
    const worktree = await this.deps.gitAdapter.createWorktree(
      authorizedInput,
      auditSink
    );

    // 3. 事务内登记 worktree + 写 worktree_created 审计。
    await this.deps.orchestrator.attachWorktree(args.taskId, worktree);

    // 4. 事务内追加 git 命令审计（P1-03）。
    await flushGitCommandAudits(
      this.deps.unitOfWork,
      args.taskId,
      auditSink.drain()
    );

    return worktree;
  }

  /**
   * P1-R03：worktree 创建授权校验。
   *
   * 在事务内原子读取 task、approval、plan、project，校验：
   * - 任务状态为 AWAITING_EXECUTION_APPROVAL
   * - 存在有效 execution approval
   * - approval.scopeHash 与当前 Plan scopeHash 一致
   *
   * **关键设计**：校验在事务内只读完成（不写审计、不抛异常），返回
   * 校验结果。校验失败时事务正常提交（无副作用），然后在**独立事务**
   * 内写 `policy_denied` 审计（避免被 ROLLBACK 回滚），最后抛出对应
   * 安全异常。这确保 `policy_denied` 审计事件始终被持久化，调用方
   * 看到 HTTP 403 时可在 SQLite 中查到拒绝原因。
   *
   * @returns 经过授权的 CreateWorktreeInput（allowedPaths 来自 Plan）
   */
  private async authorizeWorktreeCreation(args: {
    readonly taskId: string;
    readonly input: CreateWorktreeInput;
  }): Promise<CreateWorktreeInput> {
    // 1. 事务内只读校验，返回结果（不写审计、不抛异常）。
    const result = await this.deps.unitOfWork.run(async (tx) => {
      const task = await tx.tasks.findById(args.taskId);
      if (!task) {
        return {
          ok: false as const,
          code: "task_not_found" as const,
          message: `任务 ${args.taskId} 不存在`
        };
      }

      // 校验 1：任务状态必须为 AWAITING_EXECUTION_APPROVAL
      if (task.status !== "AWAITING_EXECUTION_APPROVAL") {
        return {
          ok: false as const,
          code: "status_not_allowed" as const,
          status: task.status,
          message: `任务状态 ${task.status} 不允许创建 worktree；必须为 AWAITING_EXECUTION_APPROVAL`
        };
      }

      // 校验 2：存在有效 execution approval
      const approval = await tx.approvals.findLatestExecutionApproval(args.taskId);
      if (!approval) {
        return {
          ok: false as const,
          code: "missing_approval" as const,
          message: "缺少有效的 execution approval"
        };
      }

      // 校验 3：approval.scopeHash 与当前 Plan scopeHash 一致
      const project = await tx.projects.findById(task.projectId);
      if (!project) {
        return {
          ok: false as const,
          code: "project_not_found" as const,
          message: `项目 ${task.projectId} 不存在（任务 ${args.taskId}）`
        };
      }

      // P1-R04：使用 task.currentPlanId 读取权威 Plan，而非按时间排序的最后一条。
      if (!task.currentPlanId) {
        return {
          ok: false as const,
          code: "no_plan" as const,
          message: "任务尚未记录 Plan（currentPlanId 为空），无法计算 scopeHash"
        };
      }
      const currentPlan = await tx.plans.findById(task.currentPlanId);
      if (!currentPlan) {
        return {
          ok: false as const,
          code: "no_plan" as const,
          message: `任务 ${args.taskId} 的 currentPlanId=${task.currentPlanId} 在 Plan 仓储中不存在`
        };
      }

      // P1-R04：scopeHash 必须包含完整命令契约（argv + timeoutMs）。
      const currentScopeHash = computeScopeHash({
        allowedPaths: currentPlan.allowedPaths,
        commands: project.commands,
        riskLevel: task.input.riskLevel
      });

      if (approval.scopeHash !== currentScopeHash) {
        return {
          ok: false as const,
          code: "scope_mismatch" as const,
          expected: currentScopeHash,
          actual: approval.scopeHash,
          message: `scopeHash 不一致：approval=${approval.scopeHash} current=${currentScopeHash}`
        };
      }

      // 授权通过：从权威 Plan 读取 allowedPaths。
      return {
        ok: true as const,
        allowedPaths: currentPlan.allowedPaths
      };
    });

    if (result.ok) {
      // 授权通过：用 Plan.allowedPaths 覆盖 input.allowedPaths。
      // 调用方传入的 input.allowedPaths 不被信任（P1-R03 第 3 点）。
      return {
        ...args.input,
        allowedPaths: result.allowedPaths
      };
    }

    // 2. 校验失败：在独立事务内写 policy_denied 审计（避免被 ROLLBACK）。
    await this.deps.unitOfWork.run(async (tx) => {
      await tx.audit.append(
        createAuditEvent({
          taskId: args.taskId,
          type: "policy_denied",
          deniedAction: "createWorktree",
          deniedReason: result.message
        })
      );
    });

    // 3. 抛出对应的安全异常（按 code 映射）。
    switch (result.code) {
      case "status_not_allowed":
        throw new WorktreeCreationNotAllowedException(args.taskId, result.status!);
      case "missing_approval":
        throw new MissingExecutionApprovalException(args.taskId);
      case "no_plan":
        // 没有 Plan 也视为缺少有效审批范围（无法计算 scopeHash）。
        throw new MissingExecutionApprovalException(args.taskId);
      case "scope_mismatch":
        throw new WorktreeScopeMismatchException(
          args.taskId,
          result.expected!,
          result.actual!
        );
      default:
        // task_not_found / project_not_found —— 数据完整性问题，抛通用错误。
        throw new Error(result.message);
    }
  }

  /**
   * 回收已登记的 worktree（P1-01 / P1-03）。
   *
   * 流程：
   * 1. 在事务内加载 worktree 登记记录与关联任务：
   *    - 登记记录不存在 → 抛 `WorktreeNotRegisteredException`（拒绝伪造）
   *    - 任务非终态 → 抛 `WorktreeTaskNotTerminalException`
   * 2. 创建 `BufferedGitCommandAuditSink`。
   * 3. 调用 `GitAdapter.removeRegisteredWorktree(registered, auditSink)` ——
   *    真实 git 操作（git-common-dir 解析 / worktree remove / --force 兜底）。
   * 4. 调用 `TaskOrchestrator.detachWorktree(taskId, worktreeId, reason)` ——
   *    事务内删除登记 + 解除 task.worktreeId 引用 + 写 worktree_removed
   *    审计。
   * 5. 事务内追加 git 命令审计（P1-03）。
   *
   * @param reason 必填，写入审计以便回溯为何回收（终态/失败回滚/手动等）
   */
  async removeWorktreeIfTerminal(args: {
    readonly taskId: string;
    readonly worktreeId: string;
    readonly reason: string;
  }): Promise<void> {
    // 1. 事务内加载登记记录与任务，校验终态。
    //    注意：校验必须在事务外完成 git 操作之前；但事务内的校验读取
    //    的是最新状态，因此把它放在一个独立的事务里，校验通过后再
    //    执行 git I/O。
    const registered = await this.deps.unitOfWork.run(async (tx) => {
      const wt = await tx.worktrees.findById(args.worktreeId);
      if (!wt) {
        throw new WorktreeNotRegisteredException(args.worktreeId);
      }
      if (wt.taskId !== args.taskId) {
        throw new Error(
          `worktree ${args.worktreeId} 属于任务 ${wt.taskId}，不可从任务 ${args.taskId} 回收`
        );
      }
      const task = await tx.tasks.findById(args.taskId);
      if (!task) {
        throw new Error(`任务 ${args.taskId} 不存在`);
      }
      if (!isTerminalStatus(task.status)) {
        throw new WorktreeTaskNotTerminalException(args.taskId, task.status);
      }
      return wt;
    });

    // 2. 真实 git 清理（事务外）。
    const auditSink = new BufferedGitCommandAuditSink();
    await this.deps.gitAdapter.removeRegisteredWorktree(registered, auditSink);

    // 3. 事务内删除登记 + 写 worktree_removed 审计。
    await this.deps.orchestrator.detachWorktree(
      args.taskId,
      args.worktreeId,
      args.reason
    );

    // 4. 事务内追加 git 命令审计（P1-03）。
    await flushGitCommandAudits(
      this.deps.unitOfWork,
      args.taskId,
      auditSink.drain()
    );
  }

  /**
   * 受控获取已登记 worktree 的 Diff（P1-R01）。
   *
   * 见规格 §7.3、§8.1 步骤 6：Diff 必须经编排服务获取，禁止调用方
   * 直接调用 `LocalGitAdapter.getDiff` 绕过审计。
   *
   * 流程：
   * 1. 事务内从 `WorktreeRepository` 读取登记记录：
   *    - 登记记录不存在 → 抛 `WorktreeNotRegisteredException`（拒绝伪造）
   *    - worktree.taskId !== args.taskId → 拒绝跨任务 Diff
   * 2. 创建 `BufferedGitCommandAuditSink`。
   * 3. 调用 `GitAdapter.getDiff(registered.path, auditSink)` —— 真实
   *    git 命令（git diff HEAD / git diff --name-only HEAD）。
   * 4. 事务内追加 git 命令审计（command_executed）。
   * 5. 事务内追加 `diff_recorded` 审计事件，携带：
   *    - `diffHash`：DiffArtifact.hash（用于审计回溯）
   *    - `reason`：调用方提供的用途说明（例如 "执行后 Diff 采集"）
   *    - `executedCwd`：worktree 路径（已在 command_executed 中记录）
   *
   * @returns DiffArtifact（含 patch、hash、changedFiles）
   */
  async captureDiffForTask(args: {
    readonly taskId: string;
    readonly worktreeId: string;
    /** 用途说明，写入 diff_recorded.reason 便于审计回溯。 */
    readonly reason: string;
  }): Promise<DiffArtifact> {
    // 1. 事务内加载登记记录，校验归属。
    const registered = await this.deps.unitOfWork.run(async (tx) => {
      const wt = await tx.worktrees.findById(args.worktreeId);
      if (!wt) {
        throw new WorktreeNotRegisteredException(args.worktreeId);
      }
      if (wt.taskId !== args.taskId) {
        throw new Error(
          `worktree ${args.worktreeId} 属于任务 ${wt.taskId}，不可为任务 ${args.taskId} 获取 Diff`
        );
      }
      return wt;
    });

    // 2. 真实 git diff（事务外）。
    const auditSink = new BufferedGitCommandAuditSink();
    const diff = await this.deps.gitAdapter.getDiff(
      registered.path,
      auditSink
    );

    // 3. 事务内追加 git 命令审计（command_executed）。
    await flushGitCommandAudits(
      this.deps.unitOfWork,
      args.taskId,
      auditSink.drain()
    );

    // 4. 事务内追加 diff_recorded 审计事件（含 diffHash）。
    await this.deps.unitOfWork.run(async (tx) => {
      await tx.audit.append(
        createAuditEvent({
          taskId: args.taskId,
          type: "diff_recorded",
          diffHash: diff.hash,
          reason: `Diff 采集 (worktree=${registered.id}, path=${registered.path}): ${args.reason}`
        })
      );
    });

    return diff;
  }
}
