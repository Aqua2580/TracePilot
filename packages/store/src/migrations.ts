/**
 * 迁移机制 —— 见 IMPLEMENTATION_SPEC §3.1 与 ADR-005。
 *
 * 采用内联 SQL 迁移定义；需要按领域规则读取旧数据时允许附加事务内 apply，
 * 不依赖 drizzle-kit 的生成器。原因：
 * - MVP 单进程，schema 变更频率低。
 * - 避免引入额外的构建工具链依赖。
 * - schema.ts 仍作为 Drizzle 类型安全查询的来源。
 *
 * 迁移版本在 `schema_migrations` 表中追踪。每次迁移在独立事务中执行；
 * 版本号单调递增。启动时自动运行未应用的迁移。
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { RepairRecordRow } from "./sqlite-repositories.js";
import { createTrustedRepairRecordResolver } from "./trusted-repair-record.js";

/** 单条迁移定义：版本号 + SQL 语句。 */
interface Migration {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
  /** 需要读取旧数据并执行领域校验时使用；与 sql 位于同一事务。 */
  readonly apply?: (db: DatabaseType) => void;
}

/**
 * 已登记的迁移列表。新增迁移只能追加，不得修改已发布的迁移。
 *
 * 迁移 SQL 必须是幂等安全的 DDL（`CREATE TABLE IF NOT EXISTS`、
 * `CREATE INDEX IF NOT EXISTS`）；数据迁移 apply 也必须可重复执行且失败关闭。
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "初始 schema：projects、tasks、evidence_packs、evidence_requests、plans、approvals、worktrees、repair_records、audit_events、agent_runs、schema_migrations",
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        language TEXT NOT NULL,
        commands_json TEXT NOT NULL,
        knowledge_source_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        current_evidence_pack_id TEXT,
        current_evidence_pack_version INTEGER,
        current_plan_id TEXT,
        worktree_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_transition_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

      CREATE TABLE IF NOT EXISTS evidence_packs (
        id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        task_snapshot_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        hypotheses_json TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_packs_task ON evidence_packs(task_id);

      CREATE TABLE IF NOT EXISTS evidence_requests (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        requester_role TEXT NOT NULL,
        gap_reason TEXT NOT NULL,
        needed_kinds_json TEXT NOT NULL,
        allowed_scope TEXT NOT NULL,
        expected_plan_impact TEXT NOT NULL,
        requested_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evidence_requests_task ON evidence_requests(task_id);

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        nodes_json TEXT NOT NULL,
        input_evidence_pack_id TEXT NOT NULL,
        input_evidence_pack_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plans_task ON plans(task_id);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        approver TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT,
        approved_at TEXT NOT NULL,
        scope_hash TEXT NOT NULL,
        invalidated_at TEXT,
        invalidation_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);

      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_commit_sha TEXT NOT NULL,
        allowed_paths_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worktrees_task ON worktrees(task_id);

      CREATE TABLE IF NOT EXISTS repair_records (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        symptom TEXT NOT NULL,
        root_cause TEXT NOT NULL,
        fix_summary TEXT NOT NULL,
        applicability_conditions_json TEXT NOT NULL,
        failure_reasons_json TEXT NOT NULL,
        input_evidence_pack_id TEXT NOT NULL,
        input_evidence_pack_version INTEGER NOT NULL,
        diff_hash TEXT,
        verification_result_json TEXT,
        review_result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_repair_records_project ON repair_records(project_id);
      CREATE INDEX IF NOT EXISTS idx_repair_records_task ON repair_records(task_id);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        evidence_pack_id TEXT,
        evidence_pack_version INTEGER,
        evidence_pack_hash TEXT,
        plan_id TEXT,
        executed_argv_json TEXT,
        executed_cwd TEXT,
        exit_code INTEGER,
        output_truncation_json TEXT,
        diff_hash TEXT,
        approver TEXT,
        scope_hash TEXT,
        reason TEXT,
        denied_action TEXT,
        denied_reason TEXT,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_task ON audit_events(task_id);
      CREATE INDEX IF NOT EXISTS idx_audit_events_recorded ON audit_events(recorded_at);

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        events_json TEXT NOT NULL,
        total_bytes INTEGER NOT NULL,
        truncated INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    description: "agent_runs 增加 retained_bytes 与 content_hash 列（P1-03 Runtime 事件截断与可追溯）",
    sql: `
      ALTER TABLE agent_runs ADD COLUMN retained_bytes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agent_runs ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
    `
  },
  {
    version: 3,
    description: "plans 增加 allowed_paths_json 列（P1-R03 Plan 持久化 allowedPaths 以支持执行审批 scopeHash 校验）",
    sql: `
      ALTER TABLE plans ADD COLUMN allowed_paths_json TEXT NOT NULL DEFAULT '[]';
    `
  },
  {
    version: 4,
    description: "execution_results 表（P1-03：持久化 runDevelop 的 Diff 哈希与验证产物，供 runReview 受控读取）",
    sql: `
      CREATE TABLE IF NOT EXISTS execution_results (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        diff_patch TEXT NOT NULL,
        diff_changed_files_json TEXT NOT NULL,
        diff_bytes INTEGER NOT NULL,
        verification_exit_code INTEGER NOT NULL,
        verification_passed INTEGER NOT NULL,
        verification_stdout TEXT NOT NULL,
        verification_stderr TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_results_task ON execution_results(task_id);
    `
  },
  {
    version: 5,
    description: "repair_records 记录 Evidence Pack 内容哈希，绑定 Review 与 Repair Memory 来源",
    sql: `
      ALTER TABLE repair_records ADD COLUMN input_evidence_pack_content_hash TEXT;
    `
  },
  {
    version: 6,
    description: "repair_records 持久化根因与适用条件的具体 Evidence ID 绑定",
    sql: `
      ALTER TABLE repair_records ADD COLUMN root_cause_confidence REAL;
      ALTER TABLE repair_records ADD COLUMN root_cause_evidence_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE repair_records ADD COLUMN applicability_evidence_json TEXT NOT NULL DEFAULT '[]';
    `
  },
  {
    version: 7,
    description: "失败关闭隔离无法重新验证来源链的历史高可信 Repair Record",
    sql: "",
    apply: (db) => {
      const rows = db
        .prepare(
          "SELECT * FROM repair_records WHERE status IN ('VERIFIED', 'APPROVED')"
        )
        .all() as RepairRecordRow[];
      const resolveTrustedRecord = createTrustedRepairRecordResolver(db);
      const deprecate = db.prepare(
        `UPDATE repair_records
         SET status = 'DEPRECATED', failure_reasons_json = ?, updated_at = ?
         WHERE id = ? AND status IN ('VERIFIED', 'APPROVED')`
      );
      const migratedAt = new Date().toISOString();

      for (const row of rows) {
        if (resolveTrustedRecord(row).record) continue;
        const failureReasons = parseFailureReasons(row.failure_reasons_json);
        const migrationReason =
          "迁移 7 隔离：历史高可信记录无法重新验证完整 Evidence Pack、Diff 与验证来源链";
        if (!failureReasons.includes(migrationReason)) {
          failureReasons.push(migrationReason);
        }
        deprecate.run(JSON.stringify(failureReasons), migratedAt, row.id);
      }
    }
  },
  {
    version: 8,
    description: "隔离 Task 项目归属与 Repair Record 项目不一致的历史高可信记录",
    sql: "",
    apply: (db) => {
      const rows = db
        .prepare(
          "SELECT * FROM repair_records WHERE status IN ('VERIFIED', 'APPROVED')"
        )
        .all() as RepairRecordRow[];
      const resolveTrustedRecord = createTrustedRepairRecordResolver(db);
      const deprecate = db.prepare(
        `UPDATE repair_records
         SET status = 'DEPRECATED', failure_reasons_json = ?, updated_at = ?
         WHERE id = ? AND status IN ('VERIFIED', 'APPROVED')`
      );
      const migratedAt = new Date().toISOString();

      for (const row of rows) {
        if (resolveTrustedRecord(row).record) continue;
        const failureReasons = parseFailureReasons(row.failure_reasons_json);
        const migrationReason =
          "迁移 8 隔离：高可信记录的 Task 项目归属或完整来源链无法重新验证";
        if (!failureReasons.includes(migrationReason)) {
          failureReasons.push(migrationReason);
        }
        deprecate.run(JSON.stringify(failureReasons), migratedAt, row.id);
      }
    }
  },
  {
    version: 9,
    description: "Phase 7 SAG 可重试镜像 outbox（不阻塞 SQLite 真源）",
    sql: `
      CREATE TABLE IF NOT EXISTS sag_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        repair_record_id TEXT NOT NULL REFERENCES repair_records(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (repair_record_id, content_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_sag_outbox_pending
        ON sag_outbox(status, next_attempt_at, created_at);
    `
  },
  {
    version: 10,
    description: "Phase 7 SAG 跨文档来源登记（项目隔离与可回溯 locator）",
    sql: `
      CREATE TABLE IF NOT EXISTS sag_source_documents (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        knowledge_source_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        locator TEXT NOT NULL,
        title TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, document_id),
        UNIQUE (project_id, knowledge_source_id, kind, locator)
      );
      CREATE INDEX IF NOT EXISTS idx_sag_source_documents_source
        ON sag_source_documents(project_id, knowledge_source_id, kind);
    `
  },
  {
    version: 11,
    description: "Phase 7 SAG outbox 显式处理租约到期时间，防止并发 Worker 重复领取",
    sql: `
      ALTER TABLE sag_outbox ADD COLUMN lease_expires_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_sag_outbox_lease
        ON sag_outbox(status, lease_expires_at);
    `
  }
];

function parseFailureReasons(serialized: string): string[] {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (reason): reason is string =>
            typeof reason === "string" && reason.trim().length > 0
        )
      : [];
  } catch {
    return [];
  }
}

export interface RunMigrationsOptions {
  /** 仅供真实升级集成测试构造历史版本；生产启动始终省略并升级到最新。 */
  readonly throughVersion?: number;
}

/**
 * 运行未应用的迁移。每条迁移在独立事务中执行。
 *
 * 返回已应用的迁移版本列表（按版本升序）。
 */
export function runMigrations(
  db: DatabaseType,
  options: RunMigrationsOptions = {}
): number[] {
  // 确保 schema_migrations 表存在（首次启动时可能还没有）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = getAppliedVersions(db);
  const appliedSet = new Set(applied);
  const throughVersion = options.throughVersion ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(throughVersion) && throughVersion !== Number.POSITIVE_INFINITY) {
    throw new Error("迁移目标版本必须是整数");
  }
  if (
    throughVersion !== Number.POSITIVE_INFINITY &&
    (throughVersion < 1 || throughVersion > getLatestMigrationVersion())
  ) {
    throw new Error(`迁移目标版本超出范围：${throughVersion}`);
  }

  const newlyApplied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version > throughVersion) continue;
    if (appliedSet.has(migration.version)) continue;
    const tx = db.transaction(() => {
      if (migration.sql.trim().length > 0) {
        db.exec(migration.sql);
      }
      migration.apply?.(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
      ).run(migration.version, new Date().toISOString());
    });
    tx();
    newlyApplied.push(migration.version);
  }

  return newlyApplied;
}

/** 查询已应用的迁移版本列表（按版本升序）。 */
export function getAppliedVersions(db: DatabaseType): number[] {
  const rows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as Array<{ version: number }>;
  return rows.map((r) => r.version);
}

/** 当前最新迁移版本号。 */
export function getLatestMigrationVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
}
