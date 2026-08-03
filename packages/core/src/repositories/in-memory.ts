/**
 * 内存版仓储实现 —— Phase 1 单元测试与契约测试用的兜底实现。
 *
 * 注意事项：
 * - 仅用于测试，不用于生产。所有数据存放在 Map 中，无持久化。
 * - 通过单写入串行队列 + 事务前快照回滚，模拟“状态迁移与审计事件
 *   在同一事务内原子写入”的语义（见规格 §5.2、§9）。
 * - 严禁在事务回调内执行模型、命令、Git 或 worktree 等 I/O（§3.1）。
 * - Phase 2 将在相同端口下提供 SQLite 实现，事务语义必须保持一致。
 */

import type { Project } from "../domain/project.js";
import type {
  Task,
  ApprovalRecord,
  Plan
} from "../domain/task.js";
import { isApprovalInvalidated } from "../domain/task.js";
import type {
  EvidencePack,
  EvidenceRequest
} from "../domain/evidence.js";
import { EvidencePackVersionError } from "../domain/evidence.js";
import type { RepairRecord } from "../domain/repair-record.js";
import type { AuditEvent } from "../domain/audit.js";
import type { AgentRunRecord } from "../domain/agent-run.js";
import type { ExecutionResult } from "../domain/execution-result.js";
import type { Worktree } from "../ports/adapters.js";
import type {
  ProjectRepository,
  TaskRepository,
  EvidencePackRepository,
  EvidenceRequestRepository,
  PlanRepository,
  ApprovalRepository,
  WorktreeRepository,
  RepairRecordRepository,
  AuditRepository,
  AgentRunRepository,
  ExecutionResultRepository,
  UnitOfWork,
  TransactionalRepos
} from "../ports/repositories.js";

// ---------------------------------------------------------------------------
// 基础容器：可快照、可回滚的内存表
// ---------------------------------------------------------------------------

/**
 * 可快照内存表。每次事务开始时拍摄快照，回调抛错时按快照恢复，
 * 保证“要么全部写入可见，要么全部回滚”。
 */
class SnapshotTable<T extends { readonly id: string }> {
  private readonly rows = new Map<string, T>();
  private snapshot: ReadonlyMap<string, T> | undefined;

  /** 拍摄当前状态快照，供事务回滚使用。 */
  beginSnapshot(): void {
    this.snapshot = new Map(this.rows);
  }

  /** 丢弃快照（事务成功提交后调用）。 */
  commitSnapshot(): void {
    this.snapshot = undefined;
  }

  /** 将表恢复到事务前快照（回调抛错时调用）。 */
  rollbackSnapshot(): void {
    if (this.snapshot) {
      this.rows.clear();
      for (const [k, v] of this.snapshot) this.rows.set(k, v);
      this.snapshot = undefined;
    }
  }

  set(value: T): void {
    this.rows.set(value.id, value);
  }
  get(id: string): T | undefined {
    return this.rows.get(id);
  }
  values(): T[] {
    return [...this.rows.values()];
  }
  delete(id: string): void {
    this.rows.delete(id);
  }
  clear(): void {
    this.rows.clear();
  }
}

/**
 * 多版本内存表，用于 Evidence Pack（按版本不可变，见 §5.3）。
 * 同样支持快照与回滚：回滚时丢弃事务期间新增的所有版本。
 */
class VersionedSnapshotTable<T extends { readonly id: string; readonly version: number }> {
  private readonly byId = new Map<string, T[]>();
  private snapshot: ReadonlyMap<string, readonly T[]> | undefined;

  /**
   * 拍摄事务前快照。
   *
   * P1-R01 修复：必须深拷贝每个版本数组。若仅浅拷贝 Map（
   * `new Map(this.byId)`），快照中的数组与活动表共享同一引用，事务内
   * `append` 的 `list.push(value)` 会污染快照，导致回滚后新版本仍残留。
   */
  beginSnapshot(): void {
    this.snapshot = new Map(
      Array.from(this.byId.entries(), ([k, v]) => [k, [...v]] as const)
    );
  }
  commitSnapshot(): void {
    this.snapshot = undefined;
  }
  rollbackSnapshot(): void {
    if (this.snapshot) {
      this.byId.clear();
      // 再拷贝一次，避免下一次事务的 append 污染已恢复的数组。
      for (const [k, v] of this.snapshot) this.byId.set(k, [...v]);
      this.snapshot = undefined;
    }
  }

  append(value: T): void {
    const list = this.byId.get(value.id) ?? [];
    if (list.some((p) => p.version === value.version)) {
      throw new Error(
        `EvidencePack ${value.id} 版本 ${value.version} 已存在 —— Pack 按版本不可变。`
      );
    }
    list.push(value);
    list.sort((a, b) => a.version - b.version);
    this.byId.set(value.id, list);
  }
  list(id: string): readonly T[] {
    return this.byId.get(id) ?? [];
  }
  latest(id: string): T | undefined {
    const list = this.byId.get(id);
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }
}

/**
 * 追加型内存表，用于审计事件（仅追加，不修改不删除，见 §7.3）。
 * 快照记录事务前的数组长度，回滚时截断到该长度。
 */
class AppendOnlySnapshotTable<T> {
  private readonly items: T[] = [];
  private snapshotLength = 0;

  beginSnapshot(): void {
    this.snapshotLength = this.items.length;
  }
  commitSnapshot(): void {
    this.snapshotLength = 0;
  }
  rollbackSnapshot(): void {
    if (this.items.length > this.snapshotLength) {
      this.items.length = this.snapshotLength;
    }
    this.snapshotLength = 0;
  }

  append(item: T): void {
    this.items.push(item);
  }
  all(): readonly T[] {
    return this.items;
  }
}

// ---------------------------------------------------------------------------
// 仓储实现
// ---------------------------------------------------------------------------

export class InMemoryProjectRepository implements ProjectRepository {
  constructor(private readonly table: SnapshotTable<Project>) {}
  async save(project: Project): Promise<void> {
    this.table.set(project);
  }
  async findById(id: string): Promise<Project | undefined> {
    return this.table.get(id);
  }
  async findAll(): Promise<Project[]> {
    return this.table.values();
  }
  async delete(id: string): Promise<void> {
    this.table.delete(id);
  }
}

export class InMemoryTaskRepository implements TaskRepository {
  private readonly nonTerminal = new Set<string>([
    "CREATED", "INTAKING", "GATHERING_EVIDENCE", "PLANNED",
    "AWAITING_EXECUTION_APPROVAL", "EXECUTING", "EVIDENCE_GAP",
    "VALIDATING", "REVIEWING", "AWAITING_HUMAN_APPROVAL"
  ]);

  constructor(private readonly table: SnapshotTable<Task>) {}
  async save(task: Task): Promise<void> {
    this.table.set(task);
  }
  async findById(id: string): Promise<Task | undefined> {
    return this.table.get(id);
  }
  async findByProject(projectId: string): Promise<Task[]> {
    return this.table.values().filter((t) => t.projectId === projectId);
  }
  async findInNonTerminalStatuses(): Promise<Task[]> {
    return this.table.values().filter((t) =>
      this.nonTerminal.has(t.status)
    );
  }
}

export class InMemoryEvidencePackRepository implements EvidencePackRepository {
  constructor(private readonly table: VersionedSnapshotTable<EvidencePack>) {}
  async save(pack: EvidencePack): Promise<void> {
    // 在 append 前检查重复版本，抛出领域错误 EvidencePackVersionError，
    // 使 Pack 不可变约束在仓储层即可被调用方捕获。
    const existing = this.table.list(pack.id);
    if (existing.some((p) => p.version === pack.version)) {
      throw new EvidencePackVersionError(
        `EvidencePack ${pack.id} 版本 ${pack.version} 已存在 —— Pack 按版本不可变。`
      );
    }
    this.table.append(pack);
  }
  async findById(id: string): Promise<EvidencePack | undefined> {
    return this.table.latest(id);
  }
  async findVersions(id: string): Promise<EvidencePack[]> {
    return [...this.table.list(id)];
  }
  async findLatestVersion(id: string): Promise<EvidencePack | undefined> {
    return this.table.latest(id);
  }
}

export class InMemoryEvidenceRequestRepository implements EvidenceRequestRepository {
  constructor(private readonly table: SnapshotTable<EvidenceRequest>) {}
  async save(req: EvidenceRequest): Promise<void> {
    this.table.set(req);
  }
  async findById(id: string): Promise<EvidenceRequest | undefined> {
    return this.table.get(id);
  }
  async findByTask(taskId: string): Promise<EvidenceRequest[]> {
    return this.table.values().filter((r) => r.taskId === taskId);
  }
}

export class InMemoryPlanRepository implements PlanRepository {
  constructor(private readonly table: SnapshotTable<Plan>) {}
  async save(plan: Plan): Promise<void> {
    this.table.set(plan);
  }
  async findById(id: string): Promise<Plan | undefined> {
    return this.table.get(id);
  }
  async findByTask(taskId: string): Promise<Plan[]> {
    return this.table.values().filter((p) => p.taskId === taskId);
  }
}

export class InMemoryApprovalRepository implements ApprovalRepository {
  constructor(private readonly table: SnapshotTable<ApprovalRecord>) {}
  async save(approval: ApprovalRecord): Promise<void> {
    this.table.set(approval);
  }
  async findByTask(taskId: string): Promise<ApprovalRecord[]> {
    return this.table
      .values()
      .filter((a) => a.taskId === taskId)
      .sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
  }
  async findLatestExecutionApproval(taskId: string): Promise<ApprovalRecord | undefined> {
    const all = await this.findByTask(taskId);
    // 仅返回尚未失效的执行审批（见 P1-02：失效审批不可作为有效批准依据）。
    const execApprovals = all.filter(
      (a) => a.kind === "execution" && a.decision === "approved" && !isApprovalInvalidated(a)
    );
    return execApprovals[execApprovals.length - 1];
  }
}

export class InMemoryWorktreeRepository implements WorktreeRepository {
  constructor(private readonly table: SnapshotTable<Worktree>) {}
  async save(worktree: Worktree): Promise<void> {
    this.table.set(worktree);
  }
  async findById(id: string): Promise<Worktree | undefined> {
    return this.table.get(id);
  }
  async findByTask(taskId: string): Promise<Worktree | undefined> {
    return this.table.values().find((w) => w.taskId === taskId);
  }
  async findAll(): Promise<Worktree[]> {
    return this.table.values();
  }
  async delete(id: string): Promise<void> {
    this.table.delete(id);
  }
}

export class InMemoryRepairRecordRepository implements RepairRecordRepository {
  constructor(private readonly table: SnapshotTable<RepairRecord>) {}
  async save(record: RepairRecord): Promise<void> {
    this.table.set(record);
  }
  async findById(id: string): Promise<RepairRecord | undefined> {
    return this.table.get(id);
  }
  async findByProject(projectId: string): Promise<RepairRecord[]> {
    return this.table.values().filter((r) => r.projectId === projectId);
  }
  async findByTask(taskId: string): Promise<RepairRecord[]> {
    return this.table.values().filter((r) => r.taskId === taskId);
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  constructor(private readonly table: AppendOnlySnapshotTable<AuditEvent>) {}
  async append(event: AuditEvent): Promise<void> {
    // 仅追加 —— 永不修改既有事件（§7.3）。
    this.table.append(event);
  }
  async findByTask(taskId: string): Promise<AuditEvent[]> {
    return this.table.all().filter((e) => e.taskId === taskId);
  }
  async findAll(limit?: number): Promise<AuditEvent[]> {
    const all = this.table.all();
    const slice = limit ? all.slice(-limit) : all;
    return [...slice];
  }
}

/**
 * AgentRun 内存仓储 —— 仅追加，事务回滚时截断到事务前长度。
 *
 * 与 audit 一致：落库后只读，事务内 save 失败时丢弃本次新增。
 */
export class InMemoryAgentRunRepository implements AgentRunRepository {
  constructor(private readonly table: AppendOnlySnapshotTable<AgentRunRecord>) {}
  async save(record: AgentRunRecord): Promise<void> {
    this.table.append(record);
  }
  async findByTask(taskId: string): Promise<AgentRunRecord[]> {
    return this.table.all().filter((r) => r.taskId === taskId);
  }
  async findByRunId(taskId: string, runId: string): Promise<AgentRunRecord | undefined> {
    return this.table.all().find((r) => r.taskId === taskId && r.runId === runId);
  }
}

/**
 * 内存版 ExecutionResultRepository —— P1-03（Phase 4 验收）。
 *
 * 持久化 runDevelop 的受控 Diff 与验证产物，供 runReview 受控读取。
 * 不接受调用方提交的 Diff 或验证结果。
 */
export class InMemoryExecutionResultRepository implements ExecutionResultRepository {
  constructor(private readonly table: AppendOnlySnapshotTable<ExecutionResult>) {}
  async save(result: ExecutionResult): Promise<void> {
    this.table.append(result);
  }
  async findLatestByTask(taskId: string): Promise<ExecutionResult | undefined> {
    const results = this.table.all().filter((r) => r.taskId === taskId);
    if (results.length === 0) return undefined;
    // 按 createdAt 降序取最新
    return results.reduce((latest, current) =>
      current.createdAt > latest.createdAt ? current : latest
    );
  }
  async findByTask(taskId: string): Promise<ExecutionResult[]> {
    return this.table.all()
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

// ---------------------------------------------------------------------------
// UnitOfWork：串行队列 + 快照回滚
// ---------------------------------------------------------------------------

/**
 * 内存版 UnitOfWork。
 *
 * 实现要点（修复 P1-01）：
 * 1. 单写入串行队列：所有 `run` 调用排队执行，避免并发交错读写造成
 *    重复审计或状态覆盖。
 * 2. 事务前快照：进入回调前对所有内部表拍摄快照；回调抛错时按快照
 *    回滚，保证“全部可见或全部不可见”。
 * 3. 严禁在回调内执行 I/O（模型/命令/Git/worktree）；仅限内存读写。
 *
 * 接口与 Phase 2 的 SQLite UoW 一致，后者用短事务（BEGIN…COMMIT）
 * 实现相同语义，Orchestrator 代码无需改动。
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  /** 串行执行队列，保证同一时刻仅有一个事务在写。 */
  private readonly queue: Promise<unknown> = Promise.resolve();
  private readonly tail: { promise: Promise<unknown> } = { promise: this.queue };

  constructor(private readonly tables: InMemoryTables) {}

  async run<T>(fn: (tx: TransactionalRepos) => Promise<T>): Promise<T> {
    // 串行化：把本次事务接到队列末尾，等前一个事务结束后再执行。
    const next = this.tail.promise.then(() => this.runInner(fn));
    this.tail.promise = next.then(
      () => undefined,
      () => undefined
    );
    return next as Promise<T>;
  }

  private async runInner<T>(fn: (tx: TransactionalRepos) => Promise<T>): Promise<T> {
    // 1. 拍摄事务前快照。
    for (const t of this.tables.all()) t.beginSnapshot();
    try {
      // 2. 执行回调。回调内仅允许内存读写，禁止 I/O。
      const result = await fn(this.tables.repos);
      // 3. 成功提交：丢弃快照。
      for (const t of this.tables.all()) t.commitSnapshot();
      return result;
    } catch (err) {
      // 4. 失败回滚：恢复所有表到事务前状态。
      for (const t of this.tables.all()) t.rollbackSnapshot();
      throw err;
    }
  }
}

/** 内部表聚合，供 UnitOfWork 统一拍摄/回滚快照。 */
interface SnapshotCapable {
  beginSnapshot(): void;
  commitSnapshot(): void;
  rollbackSnapshot(): void;
}

interface InMemoryTables extends TransactionalRepos {
  readonly repos: TransactionalRepos;
  all(): readonly SnapshotCapable[];
}

/**
 * 内存存储聚合：包含所有仓储实现 + 包装它们的 UnitOfWork。
 * 测试在每个 fixture 创建一份并注入 Orchestrator。
 */
export interface InMemoryStore extends TransactionalRepos {
  readonly unitOfWork: UnitOfWork;
}

export function createInMemoryStore(): InMemoryStore {
  const projectsTable = new SnapshotTable<Project>();
  const tasksTable = new SnapshotTable<Task>();
  const evidencePacksTable = new VersionedSnapshotTable<EvidencePack>();
  const evidenceRequestsTable = new SnapshotTable<EvidenceRequest>();
  const plansTable = new SnapshotTable<Plan>();
  const approvalsTable = new SnapshotTable<ApprovalRecord>();
  const worktreesTable = new SnapshotTable<Worktree>();
  const repairRecordsTable = new SnapshotTable<RepairRecord>();
  const auditTable = new AppendOnlySnapshotTable<AuditEvent>();
  const agentRunsTable = new AppendOnlySnapshotTable<AgentRunRecord>();
  const executionResultsTable = new AppendOnlySnapshotTable<ExecutionResult>();

  const allTables: SnapshotCapable[] = [
    projectsTable, tasksTable, evidencePacksTable, evidenceRequestsTable,
    plansTable, approvalsTable, worktreesTable, repairRecordsTable, auditTable,
    agentRunsTable, executionResultsTable
  ];

  const repos: TransactionalRepos = {
    projects: new InMemoryProjectRepository(projectsTable),
    tasks: new InMemoryTaskRepository(tasksTable),
    evidencePacks: new InMemoryEvidencePackRepository(evidencePacksTable),
    evidenceRequests: new InMemoryEvidenceRequestRepository(evidenceRequestsTable),
    plans: new InMemoryPlanRepository(plansTable),
    approvals: new InMemoryApprovalRepository(approvalsTable),
    worktrees: new InMemoryWorktreeRepository(worktreesTable),
    repairRecords: new InMemoryRepairRecordRepository(repairRecordsTable),
    audit: new InMemoryAuditRepository(auditTable),
    agentRuns: new InMemoryAgentRunRepository(agentRunsTable),
    executionResults: new InMemoryExecutionResultRepository(executionResultsTable)
  };

  const tables: InMemoryTables = {
    ...repos,
    repos,
    all: () => allTables
  };

  return {
    ...repos,
    unitOfWork: new InMemoryUnitOfWork(tables)
  };
}

// ---------------------------------------------------------------------------
// 审批失效标记（P1-02 配套）
// ---------------------------------------------------------------------------
//
// 失效状态直接持久化在 ApprovalRecord.invalidatedAt 字段上（见
// domain/task.ts）。Orchestrator 负责读取当前审批、写回带 invalidatedAt
// 的新版本，并追加 execution_approval_invalidated 审计事件。本文件不
// 再维护独立的失效标记 Map，避免回滚场景下标记残留。
//
// `isApprovalInvalidated` 从领域模型 re-export，便于适配器复用。
export { isApprovalInvalidated } from "../domain/task.js";
