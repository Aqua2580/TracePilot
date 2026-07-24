/**
 * Drizzle SQLite schema —— TracePilot 持久化层。
 *
 * 见 IMPLEMENTATION_SPEC §3.1、§5、§7.3 与 ADR-005。
 *
 * 设计原则：
 * - 复杂嵌套领域结构（commands、taskSnapshot、evidence、hypotheses 等）
 *   以 JSON 列存储。SQLite 的 JSON1 扩展始终可用，且 MVP 单进程无需
 *   在 SQL 层做复杂查询。
 * - 主键统一为 TEXT，由领域层生成（前缀 + 随机串）。
 * - 时间戳以 ISO 8601 字符串存储（领域层已使用此格式）。
 * - 审计与 agent_runs 为仅追加表，按 recordedAt 升序追加。
 * - foreign_keys=ON 在初始化时通过 PRAGMA 设置（见 sqlite-runtime.ts）。
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repositoryPath: text("repository_path").notNull(),
  defaultBranch: text("default_branch").notNull(),
  language: text("language", { enum: ["python", "typescript"] }).notNull(),
  /** ProjectCommands 的 JSON 序列化形式。 */
  commandsJson: text("commands_json").notNull(),
  knowledgeSourceId: text("knowledge_source_id"),
  createdAt: text("created_at").notNull()
});

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  /** TaskInput 的 JSON 序列化形式。 */
  inputJson: text("input_json").notNull(),
  currentEvidencePackId: text("current_evidence_pack_id"),
  currentEvidencePackVersion: integer("current_evidence_pack_version"),
  currentPlanId: text("current_plan_id"),
  worktreeId: text("worktree_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastTransitionReason: text("last_transition_reason")
});

// ---------------------------------------------------------------------------
// evidence_packs —— 按版本不可变（§5.3）。复合主键 (id, version)。
// ---------------------------------------------------------------------------

export const evidencePacks = sqliteTable("evidence_packs", {
  id: text("id").notNull(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  /** TaskInput 快照。 */
  taskSnapshotJson: text("task_snapshot_json").notNull(),
  /** evidence、hypotheses、constraints、acceptanceCriteria 的 JSON。 */
  evidenceJson: text("evidence_json").notNull(),
  hypothesesJson: text("hypotheses_json").notNull(),
  constraintsJson: text("constraints_json").notNull(),
  acceptanceCriteriaJson: text("acceptance_criteria_json").notNull(),
  createdAt: text("created_at").notNull(),
  contentHash: text("content_hash").notNull()
});

// ---------------------------------------------------------------------------
// evidence_requests
// ---------------------------------------------------------------------------

export const evidenceRequests = sqliteTable("evidence_requests", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  requesterRole: text("requester_role", {
    enum: ["planner", "developer", "reviewer"]
  }).notNull(),
  gapReason: text("gap_reason").notNull(),
  neededKindsJson: text("needed_kinds_json").notNull(),
  allowedScope: text("allowed_scope").notNull(),
  expectedPlanImpact: text("expected_plan_impact").notNull(),
  requestedAt: text("requested_at").notNull()
});

// ---------------------------------------------------------------------------
// plans
// ---------------------------------------------------------------------------

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  /** PlanNode[] 的 JSON 序列化形式。 */
  nodesJson: text("nodes_json").notNull(),
  inputEvidencePackId: text("input_evidence_pack_id").notNull(),
  inputEvidencePackVersion: integer("input_evidence_pack_version").notNull(),
  createdAt: text("created_at").notNull()
});

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["execution", "human"] }).notNull(),
  approver: text("approver").notNull(),
  decision: text("decision", { enum: ["approved", "rejected"] }).notNull(),
  reason: text("reason"),
  approvedAt: text("approved_at").notNull(),
  scopeHash: text("scope_hash").notNull(),
  /** P1-02：失效时间戳。NULL 表示未失效。 */
  invalidatedAt: text("invalidated_at"),
  invalidationReason: text("invalidation_reason")
});

// ---------------------------------------------------------------------------
// worktrees
// ---------------------------------------------------------------------------

export const worktrees = sqliteTable("worktrees", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  branch: text("branch").notNull(),
  baseCommitSha: text("base_commit_sha").notNull(),
  allowedPathsJson: text("allowed_paths_json").notNull(),
  createdAt: text("created_at").notNull()
});

// ---------------------------------------------------------------------------
// repair_records
// ---------------------------------------------------------------------------

export const repairRecords = sqliteTable("repair_records", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  status: text("status", {
    enum: ["DRAFT", "VERIFIED", "APPROVED", "DEPRECATED"]
  }).notNull(),
  symptom: text("symptom").notNull(),
  rootCause: text("root_cause").notNull(),
  fixSummary: text("fix_summary").notNull(),
  applicabilityConditionsJson: text("applicability_conditions_json").notNull(),
  failureReasonsJson: text("failure_reasons_json").notNull(),
  inputEvidencePackId: text("input_evidence_pack_id").notNull(),
  inputEvidencePackVersion: integer("input_evidence_pack_version").notNull(),
  diffHash: text("diff_hash"),
  verificationResultJson: text("verification_result_json"),
  reviewResultJson: text("review_result_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

// ---------------------------------------------------------------------------
// audit_events —— 仅追加（§7.3）。
// ---------------------------------------------------------------------------

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  evidencePackId: text("evidence_pack_id"),
  evidencePackVersion: integer("evidence_pack_version"),
  evidencePackHash: text("evidence_pack_hash"),
  planId: text("plan_id"),
  executedArgvJson: text("executed_argv_json"),
  executedCwd: text("executed_cwd"),
  exitCode: integer("exit_code"),
  outputTruncationJson: text("output_truncation_json"),
  diffHash: text("diff_hash"),
  approver: text("approver"),
  scopeHash: text("scope_hash"),
  reason: text("reason"),
  deniedAction: text("denied_action"),
  deniedReason: text("denied_reason"),
  recordedAt: text("recorded_at").notNull()
});

// ---------------------------------------------------------------------------
// agent_runs —— Runtime 事件批量追加（§3.1）。含大小上限截断。
// ---------------------------------------------------------------------------

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull(),
  role: text("role").notNull(),
  /** RuntimeEvent 的 JSON 序列化形式（批量，已按上限截断）。 */
  eventsJson: text("events_json").notNull(),
  /** 原始未截断字节数（即使被丢弃也计入）。 */
  totalBytes: integer("total_bytes").notNull(),
  /** 落库保留的字节数。 */
  retainedBytes: integer("retained_bytes").notNull(),
  truncated: integer("truncated", { mode: "boolean" }).notNull(),
  /** 原始事件序列的哈希，截断后仍可追溯。 */
  contentHash: text("content_hash").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at").notNull()
});

// ---------------------------------------------------------------------------
// schema_migrations —— 迁移版本追踪。
// ---------------------------------------------------------------------------

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  appliedAt: text("applied_at").notNull()
});
