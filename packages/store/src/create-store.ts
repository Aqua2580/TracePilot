/**
 * SQLite Store 工厂 —— 集中创建完整的持久化栈。
 *
 * 见 IMPLEMENTATION_SPEC §3.1 与 ADR-005。
 *
 * 职责：
 * - 打开数据库并应用 PRAGMA + 迁移。
 * - 返回 UnitOfWork（供 TaskOrchestrator 使用）。
 * - 返回 KnowledgeAdapter（SqliteRepairMemoryAdapter）。
 * - 返回 db 句柄（供备份、健康检查等使用）。
 *
 * 调用方负责在关闭时调用 closeDatabase。
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type {
  KnowledgeAdapter,
  KnowledgeDocument,
  KnowledgeDocumentKind,
  UnitOfWork
} from "@tracepilot/core";
import { openDatabase, closeDatabase, type OpenDatabaseOptions } from "./sqlite-runtime.js";
import { SqliteUnitOfWork } from "./sqlite-unit-of-work.js";
import { SqliteRepairMemoryAdapter } from "./sqlite-repair-memory-adapter.js";
import { SqliteSagOutbox } from "./sqlite-sag-outbox.js";

export interface SqliteStore {
  readonly db: DatabaseType;
  readonly unitOfWork: UnitOfWork;
  readonly knowledgeAdapter: KnowledgeAdapter;
  /** Phase 7：SQLite 已提交记录的 SAG 异步镜像队列。 */
  readonly sagOutbox: SqliteSagOutbox;
  /** Phase 7：经 SQLite 核验的本机 SAG 来源文档登记。 */
  readonly sagSourceDocuments: SqliteSagSourceDocuments;
  /** 关闭数据库连接。 */
  close(): void;
}

/** SQLite 中保存的本地 SAG 来源文档元数据。 */
export interface SagSourceDocumentRegistration {
  readonly projectId: string;
  readonly knowledgeSourceId: string;
  readonly documentId: string;
  readonly kind: KnowledgeDocumentKind;
  readonly locator: string;
  readonly title: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * 来源登记仓储。
 *
 * 它只保存审核后的最小元数据，不保存文档正文；正文只留在操作者明确选择的
 * 本机 SAG Source 中。每次搜索结果返回后都需经此表再次核对。
 */
export class SqliteSagSourceDocuments {
  constructor(
    private readonly deps: { readonly db: DatabaseType; readonly unitOfWork: UnitOfWork }
  ) {}

  async register(input: SagSourceDocumentRegistration): Promise<void> {
    assertRegistration(input);
    await this.deps.unitOfWork.run(async () => {
      const project = this.deps.db.prepare(
        "SELECT knowledge_source_id FROM projects WHERE id = ?"
      ).get(input.projectId) as { knowledge_source_id: string | null } | undefined;
      if (!project || project.knowledge_source_id !== input.knowledgeSourceId) {
        throw new Error("SAG 来源登记的项目不存在或未绑定该 Source");
      }
      this.deps.db.prepare(
        `INSERT INTO sag_source_documents
          (project_id, knowledge_source_id, document_id, kind, locator, title, content_hash, created_at, updated_at)
         VALUES (@projectId, @knowledgeSourceId, @documentId, @kind, @locator, @title, @contentHash, @createdAt, @updatedAt)
         ON CONFLICT(project_id, document_id) DO UPDATE SET
           knowledge_source_id = @knowledgeSourceId,
           kind = @kind,
           locator = @locator,
           title = @title,
           content_hash = @contentHash,
           updated_at = @updatedAt`
      ).run(input);
    });
  }

  async verify(
    projectId: string,
    knowledgeSourceId: string,
    document: KnowledgeDocument
  ): Promise<boolean> {
    if (document.projectId !== projectId || !projectId || !knowledgeSourceId) return false;
    const row = this.deps.db.prepare(
      `SELECT 1 FROM sag_source_documents
       WHERE project_id = ? AND knowledge_source_id = ? AND document_id = ?
         AND kind = ? AND locator = ? AND title = ? AND content_hash = ?`
    ).get(
      projectId,
      knowledgeSourceId,
      document.id,
      document.kind,
      document.locator,
      document.title,
      document.contentHash
    );
    return Boolean(row);
  }

  list(projectId: string): readonly SagSourceDocumentRegistration[] {
    return this.deps.db.prepare(
      `SELECT project_id AS projectId, knowledge_source_id AS knowledgeSourceId,
              document_id AS documentId, kind, locator, title, content_hash AS contentHash,
              created_at AS createdAt, updated_at AS updatedAt
       FROM sag_source_documents WHERE project_id = ? ORDER BY kind ASC, locator ASC`
    ).all(projectId) as SagSourceDocumentRegistration[];
  }
}

function assertRegistration(input: SagSourceDocumentRegistration): void {
  if (!input.projectId.trim() || !input.knowledgeSourceId.trim() || !input.documentId.trim()) {
    throw new Error("SAG 来源登记缺少项目、Source 或文档 ID");
  }
  if (!(["adr", "issue", "pull_request", "repair_record"] as const).includes(input.kind)) {
    throw new Error("SAG 来源登记文档类别非法");
  }
  if (!input.locator.trim() || /[\r\n\0]/.test(input.locator) || !input.title.trim()) {
    throw new Error("SAG 来源登记 locator 或标题非法");
  }
  if (!/^sha256-[a-f0-9]{64}$/i.test(input.contentHash)) {
    throw new Error("SAG 来源登记内容哈希非法");
  }
}

/**
 * 创建 SQLite Store。
 *
 * 默认使用 %LOCALAPPDATA%/TracePilot/data/tracepilot.db；测试可传入
 * 临时路径。
 */
export function createSqliteStore(
  options: Pick<OpenDatabaseOptions, "dbPath"> & Partial<Omit<OpenDatabaseOptions, "dbPath">>
): SqliteStore {
  const db = openDatabase(options);
  const unitOfWork = new SqliteUnitOfWork({ db });
  // P1-04：KnowledgeAdapter 写入走 UnitOfWork 单写入队列，与任务/审计事务串行化。
  const knowledgeAdapter = new SqliteRepairMemoryAdapter({ db, unitOfWork });
  const sagOutbox = new SqliteSagOutbox({ db, unitOfWork });
  const sagSourceDocuments = new SqliteSagSourceDocuments({ db, unitOfWork });

  return {
    db,
    unitOfWork,
    knowledgeAdapter,
    sagOutbox,
    sagSourceDocuments,
    close: () => closeDatabase(db)
  };
}
