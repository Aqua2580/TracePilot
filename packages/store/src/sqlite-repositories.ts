/**
 * SQLite Repository 实现 —— 见 IMPLEMENTATION_SPEC §5、§6 与 ADR-005。
 *
 * 每个仓储对应 schema.ts 中的一张表。复杂嵌套领域结构以 JSON 列存储，
 * 序列化/反序列化在此处集中处理。
 *
 * 所有写操作通过 prepared statement 执行，避免 SQL 注入。Repository
 * 实例在 UnitOfWork 事务内创建，复用同一 db 句柄；事务由 UnitOfWork
 * 管理，Repository 不自行 BEGIN/COMMIT。
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { Project, ProjectCommands, CommandSpec } from "@tracepilot/core";
import type { Task, TaskInput, TaskStatus, ApprovalRecord, Plan, PlanNode } from "@tracepilot/core";
import {
  EvidencePackVersionError,
  type EvidencePack,
  type EvidenceItem,
  type Hypothesis,
  type EvidenceConstraint,
  type EvidenceRequest,
  type EvidenceKind
} from "@tracepilot/core";
import type { RepairRecord, VerificationSummary, ReviewSummary, ReviewFinding } from "@tracepilot/core";
import type { AuditEvent, AuditEventType, OutputTruncation } from "@tracepilot/core";
import type { AgentRunRecord } from "@tracepilot/core";
import type { RuntimeEvent } from "@tracepilot/core";
import type { Worktree } from "@tracepilot/core";
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
  TransactionalRepos
} from "@tracepilot/core";

/**
 * 事务内仓储集合。在 UnitOfWork.run 回调中创建，复用同一 db 句柄。
 * 事务边界由 UnitOfWork 管理。
 */
export class SqliteRepositories implements TransactionalRepos {
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

  constructor(private readonly db: DatabaseType) {
    this.projects = new SqliteProjectRepository(db);
    this.tasks = new SqliteTaskRepository(db);
    this.evidencePacks = new SqliteEvidencePackRepository(db);
    this.evidenceRequests = new SqliteEvidenceRequestRepository(db);
    this.plans = new SqlitePlanRepository(db);
    this.approvals = new SqliteApprovalRepository(db);
    this.worktrees = new SqliteWorktreeRepository(db);
    this.repairRecords = new SqliteRepairRecordRepository(db);
    this.audit = new SqliteAuditRepository(db);
    this.agentRuns = new SqliteAgentRunRepository(db);
  }
}

// ---------------------------------------------------------------------------
// 序列化辅助
// ---------------------------------------------------------------------------

function parseJson<T>(s: string): T {
  return JSON.parse(s) as T;
}

function toJson(v: unknown): string {
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// ProjectRepository
// ---------------------------------------------------------------------------

class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly db: DatabaseType) {}

  async save(project: Project): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, repository_path, default_branch, language, commands_json, knowledge_source_id, created_at)
         VALUES (@id, @name, @repositoryPath, @defaultBranch, @language, @commandsJson, @knowledgeSourceId, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           name = @name,
           repository_path = @repositoryPath,
           default_branch = @defaultBranch,
           language = @language,
           commands_json = @commandsJson,
           knowledge_source_id = @knowledgeSourceId`
      )
      .run({
        id: project.id,
        name: project.name,
        repositoryPath: project.repositoryPath,
        defaultBranch: project.defaultBranch,
        language: project.language,
        commandsJson: toJson(project.commands),
        knowledgeSourceId: project.knowledgeSourceId ?? null,
        createdAt: project.createdAt
      });
  }

  async findById(id: string): Promise<Project | undefined> {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    return row ? projectFromRow(row) : undefined;
  }

  async findAll(): Promise<Project[]> {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY created_at ASC")
      .all() as ProjectRow[];
    return rows.map(projectFromRow);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
}

interface ProjectRow {
  id: string;
  name: string;
  repository_path: string;
  default_branch: string;
  language: "python" | "typescript";
  commands_json: string;
  knowledge_source_id: string | null;
  created_at: string;
}

function projectFromRow(row: ProjectRow): Project {
  const commands = parseJson<ProjectCommands>(row.commands_json);
  return {
    id: row.id,
    name: row.name,
    repositoryPath: row.repository_path,
    defaultBranch: row.default_branch,
    language: row.language,
    commands,
    knowledgeSourceId: row.knowledge_source_id ?? undefined,
    createdAt: row.created_at
  };
}

// ---------------------------------------------------------------------------
// TaskRepository
// ---------------------------------------------------------------------------

class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly db: DatabaseType) {}

  async save(task: Task): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, status, input_json, current_evidence_pack_id, current_evidence_pack_version, current_plan_id, worktree_id, created_at, updated_at, last_transition_reason)
         VALUES (@id, @projectId, @status, @inputJson, @currentEvidencePackId, @currentEvidencePackVersion, @currentPlanId, @worktreeId, @createdAt, @updatedAt, @lastTransitionReason)
         ON CONFLICT(id) DO UPDATE SET
           status = @status,
           input_json = @inputJson,
           current_evidence_pack_id = @currentEvidencePackId,
           current_evidence_pack_version = @currentEvidencePackVersion,
           current_plan_id = @currentPlanId,
           worktree_id = @worktreeId,
           updated_at = @updatedAt,
           last_transition_reason = @lastTransitionReason`
      )
      .run({
        id: task.id,
        projectId: task.projectId,
        status: task.status,
        inputJson: toJson(task.input),
        currentEvidencePackId: task.currentEvidencePackId ?? null,
        currentEvidencePackVersion: task.currentEvidencePackVersion ?? null,
        currentPlanId: task.currentPlanId ?? null,
        worktreeId: task.worktreeId ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        lastTransitionReason: task.lastTransitionReason ?? null
      });
  }

  async findById(id: string): Promise<Task | undefined> {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  async findByProject(projectId: string): Promise<Task[]> {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC")
      .all(projectId) as TaskRow[];
    return rows.map(taskFromRow);
  }

  async findInNonTerminalStatuses(): Promise<Task[]> {
    const terminal = [
      "COMPLETED", "REJECTED", "FAILED", "CANCELLED", "INTERRUPTED"
    ];
    const placeholders = terminal.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status NOT IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...terminal) as TaskRow[];
    return rows.map(taskFromRow);
  }
}

interface TaskRow {
  id: string;
  project_id: string;
  status: string;
  input_json: string;
  current_evidence_pack_id: string | null;
  current_evidence_pack_version: number | null;
  current_plan_id: string | null;
  worktree_id: string | null;
  created_at: string;
  updated_at: string;
  last_transition_reason: string | null;
}

function taskFromRow(row: TaskRow): Task {
  const input = parseJson<TaskInput>(row.input_json);
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status as TaskStatus,
    input,
    currentEvidencePackId: row.current_evidence_pack_id ?? undefined,
    currentEvidencePackVersion: row.current_evidence_pack_version ?? undefined,
    currentPlanId: row.current_plan_id ?? undefined,
    worktreeId: row.worktree_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTransitionReason: row.last_transition_reason ?? undefined
  };
}

// ---------------------------------------------------------------------------
// EvidencePackRepository
// ---------------------------------------------------------------------------

class SqliteEvidencePackRepository implements EvidencePackRepository {
  constructor(private readonly db: DatabaseType) {}

  async save(pack: EvidencePack): Promise<void> {
    // P1-04：Pack 按版本不可变（§5.3、AGENTS.md 规则 10）。
    // 重复 (id, version) 必须拒绝，禁止 upsert 覆盖。
    // 与 InMemory 仓储行为一致，抛出领域错误 EvidencePackVersionError。
    const insert = this.db
      .prepare(
        `INSERT INTO evidence_packs (id, task_id, version, task_snapshot_json, evidence_json, hypotheses_json, constraints_json, acceptance_criteria_json, created_at, content_hash)
         VALUES (@id, @taskId, @version, @taskSnapshotJson, @evidenceJson, @hypothesesJson, @constraintsJson, @acceptanceCriteriaJson, @createdAt, @contentHash)
         ON CONFLICT(id, version) DO NOTHING`
      )
      .run({
        id: pack.id,
        taskId: pack.taskId,
        version: pack.version,
        taskSnapshotJson: toJson(pack.taskSnapshot),
        evidenceJson: toJson(pack.evidence),
        hypothesesJson: toJson(pack.hypotheses),
        constraintsJson: toJson(pack.constraints),
        acceptanceCriteriaJson: toJson(pack.acceptanceCriteria),
        createdAt: pack.createdAt,
        contentHash: pack.contentHash
      });
    if (insert.changes === 0) {
      throw new EvidencePackVersionError(
        `EvidencePack ${pack.id} 版本 ${pack.version} 已存在 —— Pack 按版本不可变。`
      );
    }
  }

  async findById(id: string): Promise<EvidencePack | undefined> {
    // findById 返回最新版本（与 InMemory 行为一致）。
    return this.findLatestVersion(id);
  }

  async findVersions(id: string): Promise<EvidencePack[]> {
    const rows = this.db
      .prepare("SELECT * FROM evidence_packs WHERE id = ? ORDER BY version ASC")
      .all(id) as EvidencePackRow[];
    return rows.map(evidencePackFromRow);
  }

  async findLatestVersion(id: string): Promise<EvidencePack | undefined> {
    const row = this.db
      .prepare("SELECT * FROM evidence_packs WHERE id = ? ORDER BY version DESC LIMIT 1")
      .get(id) as EvidencePackRow | undefined;
    return row ? evidencePackFromRow(row) : undefined;
  }
}

interface EvidencePackRow {
  id: string;
  task_id: string;
  version: number;
  task_snapshot_json: string;
  evidence_json: string;
  hypotheses_json: string;
  constraints_json: string;
  acceptance_criteria_json: string;
  created_at: string;
  content_hash: string;
}

function evidencePackFromRow(row: EvidencePackRow): EvidencePack {
  return {
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    taskSnapshot: parseJson<TaskInput>(row.task_snapshot_json),
    evidence: parseJson<readonly EvidenceItem[]>(row.evidence_json),
    hypotheses: parseJson<readonly Hypothesis[]>(row.hypotheses_json),
    constraints: parseJson<readonly EvidenceConstraint[]>(row.constraints_json),
    acceptanceCriteria: parseJson<readonly string[]>(row.acceptance_criteria_json),
    createdAt: row.created_at,
    contentHash: row.content_hash
  };
}

// ---------------------------------------------------------------------------
// EvidenceRequestRepository
// ---------------------------------------------------------------------------

class SqliteEvidenceRequestRepository implements EvidenceRequestRepository {
  constructor(private readonly db: DatabaseType) {}

  async save(req: EvidenceRequest): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO evidence_requests (id, task_id, requester_role, gap_reason, needed_kinds_json, allowed_scope, expected_plan_impact, requested_at)
         VALUES (@id, @taskId, @requesterRole, @gapReason, @neededKindsJson, @allowedScope, @expectedPlanImpact, @requestedAt)
         ON CONFLICT(id) DO UPDATE SET
           gap_reason = @gapReason,
           needed_kinds_json = @neededKindsJson,
           allowed_scope = @allowedScope,
           expected_plan_impact = @expectedPlanImpact`
      )
      .run({
        id: req.id,
        taskId: req.taskId,
        requesterRole: req.requesterRole,
        gapReason: req.gapReason,
        neededKindsJson: toJson(req.neededKinds),
        allowedScope: req.allowedScope,
        expectedPlanImpact: req.expectedPlanImpact,
        requestedAt: req.requestedAt
      });
  }

  async findById(id: string): Promise<EvidenceRequest | undefined> {
    const row = this.db
      .prepare("SELECT * FROM evidence_requests WHERE id = ?")
      .get(id) as EvidenceRequestRow | undefined;
    return row ? evidenceRequestFromRow(row) : undefined;
  }

  async findByTask(taskId: string): Promise<EvidenceRequest[]> {
    const rows = this.db
      .prepare("SELECT * FROM evidence_requests WHERE task_id = ? ORDER BY requested_at ASC")
      .all(taskId) as EvidenceRequestRow[];
    return rows.map(evidenceRequestFromRow);
  }
}

interface EvidenceRequestRow {
  id: string;
  task_id: string;
  requester_role: "planner" | "developer" | "reviewer";
  gap_reason: string;
  needed_kinds_json: string;
  allowed_scope: string;
  expected_plan_impact: string;
  requested_at: string;
}

function evidenceRequestFromRow(row: EvidenceRequestRow): EvidenceRequest {
  return {
    id: row.id,
    taskId: row.task_id,
    requesterRole: row.requester_role,
    gapReason: row.gap_reason,
    neededKinds: parseJson<readonly EvidenceKind[]>(row.needed_kinds_json),
    allowedScope: row.allowed_scope,
    expectedPlanImpact: row.expected_plan_impact,
    requestedAt: row.requested_at
  };
}

// ---------------------------------------------------------------------------
// PlanRepository
// ---------------------------------------------------------------------------

class SqlitePlanRepository implements PlanRepository {
  constructor(private readonly db: DatabaseType) {}

  async save(plan: Plan): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO plans (id, task_id, nodes_json, input_evidence_pack_id, input_evidence_pack_version, created_at, allowed_paths_json)
         VALUES (@id, @taskId, @nodesJson, @inputEvidencePackId, @inputEvidencePackVersion, @createdAt, @allowedPathsJson)
         ON CONFLICT(id) DO UPDATE SET
           nodes_json = @nodesJson,
           input_evidence_pack_id = @inputEvidencePackId,
           input_evidence_pack_version = @inputEvidencePackVersion,
           allowed_paths_json = @allowedPathsJson`
      )
      .run({
        id: plan.id,
        taskId: plan.taskId,
        nodesJson: toJson(plan.nodes),
        inputEvidencePackId: plan.inputEvidencePackId,
        inputEvidencePackVersion: plan.inputEvidencePackVersion,
        createdAt: plan.createdAt,
        allowedPathsJson: toJson(plan.allowedPaths)
      });
  }

  async findById(id: string): Promise<Plan | undefined> {
    const row = this.db
      .prepare("SELECT * FROM plans WHERE id = ?")
      .get(id) as PlanRow | undefined;
    return row ? planFromRow(row) : undefined;
  }

  async findByTask(taskId: string): Promise<Plan[]> {
    const rows = this.db
      .prepare("SELECT * FROM plans WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as PlanRow[];
    return rows.map(planFromRow);
  }
}

interface PlanRow {
  id: string;
  task_id: string;
  nodes_json: string;
  input_evidence_pack_id: string;
  input_evidence_pack_version: number;
  created_at: string;
  allowed_paths_json: string;
}

function planFromRow(row: PlanRow): Plan {
  return {
    id: row.id,
    taskId: row.task_id,
    nodes: parseJson<readonly PlanNode[]>(row.nodes_json),
    inputEvidencePackId: row.input_evidence_pack_id,
    inputEvidencePackVersion: row.input_evidence_pack_version,
    createdAt: row.created_at,
    allowedPaths: parseJson<readonly string[]>(row.allowed_paths_json)
  };
}

// ---------------------------------------------------------------------------
// ApprovalRepository
// ---------------------------------------------------------------------------

class SqliteApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: DatabaseType) {}

  async save(approval: ApprovalRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO approvals (id, task_id, kind, approver, decision, reason, approved_at, scope_hash, invalidated_at, invalidation_reason)
         VALUES (@id, @taskId, @kind, @approver, @decision, @reason, @approvedAt, @scopeHash, @invalidatedAt, @invalidationReason)
         ON CONFLICT(id) DO UPDATE SET
           decision = @decision,
           reason = @reason,
           invalidated_at = @invalidatedAt,
           invalidation_reason = @invalidationReason`
      )
      .run({
        id: approval.id,
        taskId: approval.taskId,
        kind: approval.kind,
        approver: approval.approver,
        decision: approval.decision,
        reason: approval.reason ?? null,
        approvedAt: approval.approvedAt,
        scopeHash: approval.scopeHash,
        invalidatedAt: approval.invalidatedAt ?? null,
        invalidationReason: approval.invalidationReason ?? null
      });
  }

  async findByTask(taskId: string): Promise<ApprovalRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE task_id = ? ORDER BY approved_at ASC")
      .all(taskId) as ApprovalRow[];
    return rows.map(approvalFromRow);
  }

  async findLatestExecutionApproval(taskId: string): Promise<ApprovalRecord | undefined> {
    // P1-02：过滤已失效记录。最新未失效的 approved 执行审批。
    const row = this.db
      .prepare(
        `SELECT * FROM approvals
         WHERE task_id = ? AND kind = 'execution' AND decision = 'approved' AND invalidated_at IS NULL
         ORDER BY approved_at DESC LIMIT 1`
      )
      .get(taskId) as ApprovalRow | undefined;
    return row ? approvalFromRow(row) : undefined;
  }
}

interface ApprovalRow {
  id: string;
  task_id: string;
  kind: "execution" | "human";
  approver: string;
  decision: "approved" | "rejected";
  reason: string | null;
  approved_at: string;
  scope_hash: string;
  invalidated_at: string | null;
  invalidation_reason: string | null;
}

function approvalFromRow(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    approver: row.approver,
    decision: row.decision,
    reason: row.reason ?? undefined,
    approvedAt: row.approved_at,
    scopeHash: row.scope_hash,
    invalidatedAt: row.invalidated_at ?? undefined,
    invalidationReason: row.invalidation_reason ?? undefined
  };
}

// ---------------------------------------------------------------------------
// WorktreeRepository
// ---------------------------------------------------------------------------

class SqliteWorktreeRepository implements WorktreeRepository {
  constructor(private readonly db: DatabaseType) {}

  async save(worktree: Worktree): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO worktrees (id, project_id, task_id, path, branch, base_commit_sha, allowed_paths_json, created_at)
         VALUES (@id, @projectId, @taskId, @path, @branch, @baseCommitSha, @allowedPathsJson, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           path = @path,
           branch = @branch,
           base_commit_sha = @baseCommitSha,
           allowed_paths_json = @allowedPathsJson`
      )
      .run({
        id: worktree.id,
        projectId: worktree.projectId,
        taskId: worktree.taskId,
        path: worktree.path,
        branch: worktree.branch,
        baseCommitSha: worktree.baseCommitSha,
        allowedPathsJson: toJson(worktree.allowedPaths),
        createdAt: worktree.createdAt
      });
  }

  async findById(id: string): Promise<Worktree | undefined> {
    const row = this.db
      .prepare("SELECT * FROM worktrees WHERE id = ?")
      .get(id) as WorktreeRow | undefined;
    return row ? worktreeFromRow(row) : undefined;
  }

  async findByTask(taskId: string): Promise<Worktree | undefined> {
    const row = this.db
      .prepare("SELECT * FROM worktrees WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as WorktreeRow | undefined;
    return row ? worktreeFromRow(row) : undefined;
  }

  async findAll(): Promise<Worktree[]> {
    const rows = this.db
      .prepare("SELECT * FROM worktrees ORDER BY created_at ASC")
      .all() as WorktreeRow[];
    return rows.map(worktreeFromRow);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM worktrees WHERE id = ?").run(id);
  }
}

interface WorktreeRow {
  id: string;
  project_id: string;
  task_id: string;
  path: string;
  branch: string;
  base_commit_sha: string;
  allowed_paths_json: string;
  created_at: string;
}

function worktreeFromRow(row: WorktreeRow): Worktree {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    path: row.path,
    branch: row.branch,
    baseCommitSha: row.base_commit_sha,
    allowedPaths: parseJson<readonly string[]>(row.allowed_paths_json),
    createdAt: row.created_at
  };
}

// ---------------------------------------------------------------------------
// RepairRecordRepository
// ---------------------------------------------------------------------------

class SqliteRepairRecordRepository implements RepairRecordRepository {
  constructor(private readonly db: DatabaseType) {}

  async save(record: RepairRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO repair_records (id, project_id, task_id, status, symptom, root_cause, fix_summary, applicability_conditions_json, failure_reasons_json, input_evidence_pack_id, input_evidence_pack_version, diff_hash, verification_result_json, review_result_json, created_at, updated_at)
         VALUES (@id, @projectId, @taskId, @status, @symptom, @rootCause, @fixSummary, @applicabilityConditionsJson, @failureReasonsJson, @inputEvidencePackId, @inputEvidencePackVersion, @diffHash, @verificationResultJson, @reviewResultJson, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           status = @status,
           symptom = @symptom,
           root_cause = @rootCause,
           fix_summary = @fixSummary,
           applicability_conditions_json = @applicabilityConditionsJson,
           failure_reasons_json = @failureReasonsJson,
           diff_hash = @diffHash,
           verification_result_json = @verificationResultJson,
           review_result_json = @reviewResultJson,
           updated_at = @updatedAt`
      )
      .run({
        id: record.id,
        projectId: record.projectId,
        taskId: record.taskId,
        status: record.status,
        symptom: record.symptom,
        rootCause: record.rootCause,
        fixSummary: record.fixSummary,
        applicabilityConditionsJson: toJson(record.applicabilityConditions),
        failureReasonsJson: toJson(record.failureReasons),
        inputEvidencePackId: record.inputEvidencePackId,
        inputEvidencePackVersion: record.inputEvidencePackVersion,
        diffHash: record.diffHash ?? null,
        verificationResultJson: record.verificationResult
          ? toJson(record.verificationResult)
          : null,
        reviewResultJson: record.reviewResult ? toJson(record.reviewResult) : null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      });
  }

  async findById(id: string): Promise<RepairRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM repair_records WHERE id = ?")
      .get(id) as RepairRecordRow | undefined;
    return row ? repairRecordFromRow(row) : undefined;
  }

  async findByProject(projectId: string): Promise<RepairRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM repair_records WHERE project_id = ? ORDER BY updated_at DESC")
      .all(projectId) as RepairRecordRow[];
    return rows.map(repairRecordFromRow);
  }

  async findByTask(taskId: string): Promise<RepairRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM repair_records WHERE task_id = ? ORDER BY updated_at DESC")
      .all(taskId) as RepairRecordRow[];
    return rows.map(repairRecordFromRow);
  }
}

export interface RepairRecordRow {
  id: string;
  project_id: string;
  task_id: string;
  status: "DRAFT" | "VERIFIED" | "APPROVED" | "DEPRECATED";
  symptom: string;
  root_cause: string;
  fix_summary: string;
  applicability_conditions_json: string;
  failure_reasons_json: string;
  input_evidence_pack_id: string;
  input_evidence_pack_version: number;
  diff_hash: string | null;
  verification_result_json: string | null;
  review_result_json: string | null;
  created_at: string;
  updated_at: string;
}

export function repairRecordFromRow(row: RepairRecordRow): RepairRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    status: row.status,
    symptom: row.symptom,
    rootCause: row.root_cause,
    fixSummary: row.fix_summary,
    applicabilityConditions: parseJson<readonly string[]>(row.applicability_conditions_json),
    failureReasons: parseJson<readonly string[]>(row.failure_reasons_json),
    inputEvidencePackId: row.input_evidence_pack_id,
    inputEvidencePackVersion: row.input_evidence_pack_version,
    diffHash: row.diff_hash ?? undefined,
    verificationResult: row.verification_result_json
      ? parseJson<VerificationSummary>(row.verification_result_json)
      : undefined,
    reviewResult: row.review_result_json
      ? parseJson<ReviewSummary>(row.review_result_json)
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ---------------------------------------------------------------------------
// AuditRepository
// ---------------------------------------------------------------------------

class SqliteAuditRepository implements AuditRepository {
  constructor(private readonly db: DatabaseType) {}

  async append(event: AuditEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO audit_events (id, task_id, type, from_status, to_status, evidence_pack_id, evidence_pack_version, evidence_pack_hash, plan_id, executed_argv_json, executed_cwd, exit_code, output_truncation_json, diff_hash, approver, scope_hash, reason, denied_action, denied_reason, recorded_at)
         VALUES (@id, @taskId, @type, @fromStatus, @toStatus, @evidencePackId, @evidencePackVersion, @evidencePackHash, @planId, @executedArgvJson, @executedCwd, @exitCode, @outputTruncationJson, @diffHash, @approver, @scopeHash, @reason, @deniedAction, @deniedReason, @recordedAt)`
      )
      .run({
        id: event.id,
        taskId: event.taskId,
        type: event.type,
        fromStatus: event.fromStatus ?? null,
        toStatus: event.toStatus ?? null,
        evidencePackId: event.evidencePackId ?? null,
        evidencePackVersion: event.evidencePackVersion ?? null,
        evidencePackHash: event.evidencePackHash ?? null,
        planId: event.planId ?? null,
        executedArgvJson: event.executedArgv ? toJson(event.executedArgv) : null,
        executedCwd: event.executedCwd ?? null,
        exitCode: event.exitCode ?? null,
        outputTruncationJson: event.outputTruncation
          ? toJson(event.outputTruncation)
          : null,
        diffHash: event.diffHash ?? null,
        approver: event.approver ?? null,
        scopeHash: event.scopeHash ?? null,
        reason: event.reason ?? null,
        deniedAction: event.deniedAction ?? null,
        deniedReason: event.deniedReason ?? null,
        recordedAt: event.recordedAt
      });
  }

  async findByTask(taskId: string): Promise<AuditEvent[]> {
    const rows = this.db
      .prepare("SELECT * FROM audit_events WHERE task_id = ? ORDER BY recorded_at ASC, rowid ASC")
      .all(taskId) as AuditEventRow[];
    return rows.map(auditEventFromRow);
  }

  async findAll(limit?: number): Promise<AuditEvent[]> {
    const sql = limit
      ? "SELECT * FROM audit_events ORDER BY recorded_at DESC, rowid DESC LIMIT ?"
      : "SELECT * FROM audit_events ORDER BY recorded_at DESC, rowid DESC";
    const rows = (limit
      ? this.db.prepare(sql).all(limit)
      : this.db.prepare(sql).all()) as AuditEventRow[];
    return rows.map(auditEventFromRow);
  }
}

interface AuditEventRow {
  id: string;
  task_id: string;
  type: string;
  from_status: string | null;
  to_status: string | null;
  evidence_pack_id: string | null;
  evidence_pack_version: number | null;
  evidence_pack_hash: string | null;
  plan_id: string | null;
  executed_argv_json: string | null;
  executed_cwd: string | null;
  exit_code: number | null;
  output_truncation_json: string | null;
  diff_hash: string | null;
  approver: string | null;
  scope_hash: string | null;
  reason: string | null;
  denied_action: string | null;
  denied_reason: string | null;
  recorded_at: string;
}

function auditEventFromRow(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type as AuditEventType,
    fromStatus: (row.from_status ?? undefined) as AuditEvent["fromStatus"],
    toStatus: (row.to_status ?? undefined) as AuditEvent["toStatus"],
    evidencePackId: row.evidence_pack_id ?? undefined,
    evidencePackVersion: row.evidence_pack_version ?? undefined,
    evidencePackHash: row.evidence_pack_hash ?? undefined,
    planId: row.plan_id ?? undefined,
    executedArgv: row.executed_argv_json
      ? parseJson<readonly string[]>(row.executed_argv_json)
      : undefined,
    executedCwd: row.executed_cwd ?? undefined,
    exitCode: row.exit_code ?? undefined,
    outputTruncation: row.output_truncation_json
      ? parseJson<OutputTruncation>(row.output_truncation_json)
      : undefined,
    diffHash: row.diff_hash ?? undefined,
    approver: row.approver ?? undefined,
    scopeHash: row.scope_hash ?? undefined,
    reason: row.reason ?? undefined,
    deniedAction: row.denied_action ?? undefined,
    deniedReason: row.denied_reason ?? undefined,
    recordedAt: row.recorded_at
  };
}

// ---------------------------------------------------------------------------
// AgentRunRepository —— Runtime 事件批量落库（§3.1、§7.3，P1-03）
// ---------------------------------------------------------------------------

class SqliteAgentRunRepository implements AgentRunRepository {
  constructor(private readonly db: DatabaseType) {}

  async save(record: AgentRunRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, task_id, run_id, role, events_json, total_bytes, retained_bytes, truncated, content_hash, started_at, ended_at)
         VALUES (@id, @taskId, @runId, @role, @eventsJson, @totalBytes, @retainedBytes, @truncated, @contentHash, @startedAt, @endedAt)
         ON CONFLICT(id) DO UPDATE SET
           events_json = @eventsJson,
           total_bytes = @totalBytes,
           retained_bytes = @retainedBytes,
           truncated = @truncated,
           content_hash = @contentHash,
           ended_at = @endedAt`
      )
      .run({
        id: record.id,
        taskId: record.taskId,
        runId: record.runId,
        role: record.role,
        eventsJson: toJson(record.events),
        totalBytes: record.totalBytes,
        retainedBytes: record.retainedBytes,
        truncated: record.truncated ? 1 : 0,
        contentHash: record.contentHash,
        startedAt: record.startedAt,
        endedAt: record.endedAt
      });
  }

  async findByTask(taskId: string): Promise<AgentRunRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM agent_runs WHERE task_id = ? ORDER BY started_at ASC, rowid ASC")
      .all(taskId) as AgentRunRow[];
    return rows.map(agentRunFromRow);
  }

  async findByRunId(taskId: string, runId: string): Promise<AgentRunRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM agent_runs WHERE task_id = ? AND run_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(taskId, runId) as AgentRunRow | undefined;
    return row ? agentRunFromRow(row) : undefined;
  }
}

interface AgentRunRow {
  id: string;
  task_id: string;
  run_id: string;
  role: string;
  events_json: string;
  total_bytes: number;
  retained_bytes: number;
  truncated: number;
  content_hash: string;
  started_at: string;
  ended_at: string;
}

function agentRunFromRow(row: AgentRunRow): AgentRunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    role: row.role,
    events: parseJson<readonly RuntimeEvent[]>(row.events_json),
    totalBytes: row.total_bytes,
    retainedBytes: row.retained_bytes,
    truncated: row.truncated === 1,
    contentHash: row.content_hash,
    startedAt: row.started_at,
    endedAt: row.ended_at
  };
}

// 保留未使用的类型引用以备未来 CommandSpec 查询扩展。
export type { CommandSpec, ReviewFinding };
