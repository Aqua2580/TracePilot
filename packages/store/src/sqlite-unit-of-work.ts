/**
 * SQLite UnitOfWork —— 见 IMPLEMENTATION_SPEC §3.1、§5.2 与 ADR-005。
 *
 * 职责：
 * - 单写入串行队列：所有写事务通过 Promise 链串行化，避免 SQLite 写锁
 *   竞争（§3.1：MVP 仅支持单进程、单任务串行编排和单个 SQLite 写入队列）。
 * - 短事务：事务内只执行 SQL 写入，不得等待模型响应、运行测试或调用
 *   外部进程（§3.1）。
 * - 原子提交：事务回调抛错时 ROLLBACK，better-sqlite3 的 transaction()
 *   自动处理。
 *
 * 语义对齐 InMemory：`run(fn)` 内的写操作要么全部可见，要么全部回滚。
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type { UnitOfWork, TransactionalRepos } from "@tracepilot/core";
import { SqliteRepositories } from "./sqlite-repositories.js";

export interface SqliteUnitOfWorkDeps {
  readonly db: DatabaseType;
}

/**
 * SQLite 实现 UnitOfWork。
 *
 * 串行队列：`run` 返回的 Promise 链式串联，确保前一个事务提交后才开始
 * 下一个。读操作（非 `run` 上下文）可直接走 better-sqlite3 同步 API，
 * WAL 模式下读不阻塞写。
 */
export class SqliteUnitOfWork implements UnitOfWork {
  private readonly db: DatabaseType;
  /** 串行队列尾指针。 */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(deps: SqliteUnitOfWorkDeps) {
    this.db = deps.db;
  }

  /**
   * 在事务中运行 `fn`。`fn` 内通过 `tx` 执行的写操作原子提交。
   *
   * better-sqlite3 的 `transaction()` 在回调抛错时自动 ROLLBACK，
   * 满足“全部写入可见或全部回滚”的语义。
   */
  run<T>(fn: (tx: TransactionalRepos) => Promise<T>): Promise<T> {
    // 串行化：每个 run 排在前一个 run 之后。
    const runPromise = this.tail.then(() => this.executeInTransaction(fn));
    // 更新尾指针，但忽略 rejection（错误已传递给调用方）。
    this.tail = runPromise.then(
      () => undefined,
      () => undefined
    );
    return runPromise;
  }

  private async executeInTransaction<T>(
    fn: (tx: TransactionalRepos) => Promise<T>
  ): Promise<T> {
    const repos = new SqliteRepositories(this.db);
    // better-sqlite3 的 transaction 是同步的，但我们的 fn 是异步的。
    // 使用 BEGIN / COMMIT / ROLLBACK 手动管理，以支持异步回调。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(repos);
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ROLLBACK 失败（例如事务已自动回滚）忽略；原错误优先。
      }
      throw err;
    }
  }
}
