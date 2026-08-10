/**
 * Repository 端口定义。
 *
 * Core 定义这些接口，以便 orchestrator 和服务可以
 * 依赖抽象；InMemory（Phase 1）和 SQLite（Phase 2）
 * 实现都位于这些端口之后。orchestrator 永不直接
 * 接触 Drizzle 或 SQLite。
 */

import type { Project } from "../domain/project.js";
import type {
  Task,
  ApprovalRecord,
  Plan
} from "../domain/task.js";
import type {
  EvidencePack,
  EvidenceRequest
} from "../domain/evidence.js";
import type { RepairRecord } from "../domain/repair-record.js";
import type { AuditEvent } from "../domain/audit.js";
import type { AgentRunRecord } from "../domain/agent-run.js";
import type { ExecutionResult } from "../domain/execution-result.js";
import type { Worktree } from "./adapters.js";

export interface ProjectRepository {
  save(project: Project): Promise<void>;
  findById(id: string): Promise<Project | undefined>;
  findAll(): Promise<Project[]>;
  delete(id: string): Promise<void>;
}

export interface TaskRepository {
  save(task: Task): Promise<void>;
  findById(id: string): Promise<Task | undefined>;
  findByProject(projectId: string): Promise<Task[]>;
  /** 启动时用于查找需要 INTERRUPTED 恢复的任务（§5.2）。 */
  findInNonTerminalStatuses(): Promise<Task[]>;
}

export interface EvidencePackRepository {
  save(pack: EvidencePack): Promise<void>;
  findById(id: string): Promise<EvidencePack | undefined>;
  /** 返回 pack 的所有版本，按版本号升序排列。 */
  findVersions(id: string): Promise<EvidencePack[]>;
  /** pack 的最新版本；若 pack id 未知则返回 undefined。 */
  findLatestVersion(id: string): Promise<EvidencePack | undefined>;
}

export interface EvidenceRequestRepository {
  save(req: EvidenceRequest): Promise<void>;
  findById(id: string): Promise<EvidenceRequest | undefined>;
  findByTask(taskId: string): Promise<EvidenceRequest[]>;
}

export interface PlanRepository {
  save(plan: Plan): Promise<void>;
  findById(id: string): Promise<Plan | undefined>;
  findByTask(taskId: string): Promise<Plan[]>;
}

export interface ApprovalRepository {
  save(approval: ApprovalRecord): Promise<void>;
  /** 仅供审批提交竞态的失败补偿删除尚未生效的人工决定。 */
  delete(id: string): Promise<void>;
  findByTask(taskId: string): Promise<ApprovalRecord[]>;
  /** 任务的最新执行审批（若存在；可能已被失效）。 */
  findLatestExecutionApproval(taskId: string): Promise<ApprovalRecord | undefined>;
}

export interface WorktreeRepository {
  save(worktree: Worktree): Promise<void>;
  findById(id: string): Promise<Worktree | undefined>;
  findByTask(taskId: string): Promise<Worktree | undefined>;
  findAll(): Promise<Worktree[]>;
  delete(id: string): Promise<void>;
}

export interface RepairRecordRepository {
  save(record: RepairRecord): Promise<void>;
  findById(id: string): Promise<RepairRecord | undefined>;
  findByProject(projectId: string): Promise<RepairRecord[]>;
  findByTask(taskId: string): Promise<RepairRecord[]>;
}

export interface AuditRepository {
  append(event: AuditEvent): Promise<void>;
  findByTask(taskId: string): Promise<AuditEvent[]>;
  /** 为 API 的审计时间线提供流式读取。 */
  findAll(limit?: number): Promise<AuditEvent[]>;
}

/**
 * AgentRun 持久化端口 —— Runtime 事件批量落库（§3.1、§7.3）。
 *
 * RuntimeEvent 先进入内存缓冲区，再通过此端口批量追加到 `agent_runs` 表。
 * 落库时必须应用单条输出与单任务总日志大小上限，并保留截断摘要/哈希。
 */
export interface AgentRunRepository {
  save(record: AgentRunRecord): Promise<void>;
  findByTask(taskId: string): Promise<AgentRunRecord[]>;
  /** 按 runId 查找单条记录（重启后回放/查询用）。 */
  findByRunId(taskId: string, runId: string): Promise<AgentRunRecord | undefined>;
}

/**
 * ExecutionResult 持久化端口 —— P1-03（Phase 4 验收）。
 *
 * `runDevelop` 完成后把受控 Diff 哈希、patch、changedFiles、验证退出码、
 * 验证 stdout/stderr 持久化到此端口。`runReview` 从此端口读取受控来源
 * 的验证产物，不接受调用方提交的 Diff 或验证结果。
 *
 * 安全约束：Reviewer 输入必须来自受控来源（§8.1 第 8 步）。
 * 若当前工作树 Diff 与已验证哈希不一致，必须拒绝 Review。
 */
export interface ExecutionResultRepository {
  save(result: ExecutionResult): Promise<void>;
  /** 查找任务的最新执行结果（runReview 用此读取受控 Diff 与验证产物）。 */
  findLatestByTask(taskId: string): Promise<ExecutionResult | undefined>;
  /** 查找任务的所有执行结果（按创建时间升序）。 */
  findByTask(taskId: string): Promise<ExecutionResult[]>;
}

/**
 * 聚合 UnitOfWork 接口。orchestrator 通过此接口强制实施
 * §5.2 不变量：状态转换 + 审计事件必须在
 * 同一 DB 事务中写入。InMemory 实现以单个同步块运行；
 * SQLite 实现（Phase 2）将其包装在 `BEGIN ... COMMIT` 短事务中。
 */
export interface UnitOfWork {
  /**
   * 在所有 repository 的事务视图上运行 `fn`。在 `fn` 内部
   * 通过所提供的 repo 执行的所有写入将原子提交。
   * `fn` 内部不允许任何外部 I/O（模型调用、测试运行、worktree 创建） ——
   * 见 §3.1。
   */
  run<T>(fn: (tx: TransactionalRepos) => Promise<T>): Promise<T>;
}

export interface TransactionalRepos {
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly evidencePacks: EvidencePackRepository;
  readonly evidenceRequests: EvidenceRequestRepository;
  readonly plans: PlanRepository;
  readonly approvals: ApprovalRepository;
  readonly worktrees: WorktreeRepository;
  readonly repairRecords: RepairRecordRepository;
  readonly audit: AuditRepository;
  readonly agentRuns: AgentRunRepository;
  /** P1-03：执行结果持久化（runDevelop 写入，runReview 受控读取）。 */
  readonly executionResults: ExecutionResultRepository;
}
