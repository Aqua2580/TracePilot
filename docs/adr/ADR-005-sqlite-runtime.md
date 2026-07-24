# ADR-005：SQLite 运行时约束

> 状态：已接受  
> 日期：2026-07-24  
> 关联规格：IMPLEMENTATION_SPEC §3.1、§9 Phase 2、§10

## 背景

TracePilot MVP 以 SQLite 作为唯一持久化依赖。规格 §3.1 明确要求：
- 数据库位置固定在 `%LOCALAPPDATA%/TracePilot/data/tracepilot.db`
- 启用 `foreign_keys=ON`、WAL journal mode 和有限的 `busy_timeout`
- 业务状态变更与审计事件使用短事务
- 不得在数据库事务中等待模型响应、运行测试、创建 worktree 或调用外部进程
- MVP 仅支持单进程、单任务串行编排和单个 SQLite 写入队列
- 启动时必须执行数据库可用性检查；迁移前创建可恢复备份
- 导出/备份失败不得删除原数据库

本 ADR 记录 SQLite 运行时的具体约束与实现决策。

## 决策

### 1. 数据位置

- **默认路径**：`%LOCALAPPDATA%/TracePilot/data/tracepilot.db`
- **非 Windows 兜底**：`~/.local/share/TracePilot/data/tracepilot.db`（测试/WSL）
- 数据库文件不得提交到 Git；仓库中只保存源码、迁移定义与示例配置
- 测试使用临时路径（`mkdtempSync`），不触碰用户数据目录

### 2. PRAGMA 设置

| PRAGMA | 值 | 理由 |
| --- | --- | --- |
| `foreign_keys` | `ON` | 启用外键约束，保证引用完整性 |
| `journal_mode` | `WAL` | WAL 模式，读不阻塞写，提升并发读性能 |
| `busy_timeout` | `5000`（默认，可配置） | 写锁等待上限，避免 SQLITE_BUSY 立即失败 |
| `synchronous` | `NORMAL` | WAL 模式下的安全/性能折中 |

PRAGMA 必须在事务外设置。

### 3. 迁移机制

- 采用内联 SQL 迁移定义（`packages/store/src/migrations.ts`），不依赖 drizzle-kit
- 迁移版本在 `schema_migrations` 表中追踪
- 每条迁移在独立事务中执行，版本号单调递增
- 迁移 SQL 必须是幂等安全的 DDL（`CREATE TABLE IF NOT EXISTS`）
- 新增迁移只能追加，不得修改已发布的迁移
- 启动时自动运行未应用的迁移

### 4. 短事务与单写入队列

- **UnitOfWork**（`SqliteUnitOfWork`）：所有写事务通过 Promise 链串行化
- 事务内只执行 SQL 写入，不得等待模型响应、运行测试或调用外部进程
- 事务回调抛错时 ROLLBACK，满足"全部写入可见或全部回滚"语义
- 读操作（非 `run` 上下文）可直接走 better-sqlite3 同步 API，WAL 模式下读不阻塞写

### 5. 安全备份

- 使用 SQLite 的 Online Backup API（`db.backup`）保证一致性
- 备份目标目录会先创建
- **备份失败时抛出异常，原库不受影响**（§3.1：导出/备份失败不得删除原数据库）

### 6. 日志截断

- `audit_events` 和 `agent_runs` 为仅追加表
- Runtime 原始输出不得无上限写入 SQLite：保存截断摘要、哈希、字节数与必要的可读尾部
- 完整调试日志只在受控本地日志目录短期保留
- 单条输出和单任务总日志设置大小上限（由 ProcessPolicy 的 `maxOutputBytes` 控制）

### 7. 单进程边界

- MVP 不支持多进程、多实例调度或并发任务
- 不得通过多个 API 实例、多个写入进程或并发任务来规避 SQLite 写锁
- 横向扩展、多实例调度或高频实时日志存储属于 PostgreSQL 等后续架构决策

## 实现位置

| 组件 | 文件 |
| --- | --- |
| 数据位置解析、PRAGMA、备份 | `packages/store/src/sqlite-runtime.ts` |
| 迁移定义与执行 | `packages/store/src/migrations.ts` |
| UnitOfWork（单写入队列 + 短事务） | `packages/store/src/sqlite-unit-of-work.ts` |
| Repository 实现 | `packages/store/src/sqlite-repositories.ts` |
| Repair Memory Adapter | `packages/store/src/sqlite-repair-memory-adapter.ts` |
| Store 工厂 | `packages/store/src/create-store.ts` |
| Drizzle schema | `packages/store/src/schema.ts` |

## 后果

- **正面**：单进程简单、无外部依赖、WAL 提供良好读性能、迁移机制轻量
- **负面**：单写入队列限制并发吞吐；不支持多实例；复杂查询需在应用层处理
- **后续**：Phase 7+ 的 SAG 作为可选异步镜像，不替代 SQLite 真源；横向扩展需引入 PostgreSQL（后续 ADR）
