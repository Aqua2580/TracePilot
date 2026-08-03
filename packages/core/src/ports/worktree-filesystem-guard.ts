/**
 * WorktreeFilesystemGuard 端口 —— P1-R01（Phase 4 第三轮验收 §7.2）。
 *
 * 见 IMPLEMENTATION_SPEC §7.2：「所有路径在实际操作前解析真实路径，验证
 * 其处于项目根或登记 worktree 内，并拒绝路径穿越和符号链接逃逸。」
 *
 * OmpAdapter 的 `--tools read,grep,glob,edit,write --approval-mode=write` 启动
 * omp 后，omp CLI 级工作区写入边界拒绝 worktree 外写入；但 worktree 内
 * 的 `allowedPaths` 外写入仍由本守卫检测与回滚（恢复层）。
 *
 * 本端口在 Runtime 执行前后对 worktree 文件系统做**全量快照对比**，
 * 检测所有文件系统变更（含未跟踪文件、符号链接、删除），并支持将
 * 越界变更**回滚到快照状态**。这是 §7.2 第 2 点要求的"隔离/恢复策略"：
 * 越权改动在进入后续操作（验证、Review）前被检测并回滚。
 *
 * 核心层定义接口；实现位于 `packages/adapters`（使用 `node:fs`）。
 * Core 不导入 `node:fs`。
 */

/**
 * 单个文件条目 —— 快照中记录的文件元信息。
 *
 * - `relativePath`：POSIX 风格相对路径（如 `src/users.py`），
 *   以 `/` 为分隔符，便于跨平台比较与 glob 匹配。
 * - `isSymlink`：是否为符号链接。true 时 `symlinkTarget` 记录链接目标
 *   （可能指向 worktree 外部 —— 这是潜在的逃逸路径）。
 * - `contentHash`：常规文件的 sha256 哈希（十六进制）。符号链接无哈希。
 * - `size`：常规文件的字节数。符号链接为 `target.length`。
 * - `mode`：文件权限模式（`lstat.mode`），用于检测权限变更。
 */
export interface FileEntry {
  readonly relativePath: string;
  readonly isSymlink: boolean;
  readonly symlinkTarget?: string;
  readonly contentHash?: string;
  readonly size: number;
  readonly mode: number;
}

/**
 * 文件系统快照 —— 某一时刻 worktree 中所有文件的元信息。
 *
 * `entries` 以 `relativePath` 为键，便于 O(1) 查找。
 * `backupDir` 是实现创建的临时备份目录路径，用于 `rollback` 时
 * 恢复文件内容。调用方负责在快照不再需要时调用 `dispose` 清理。
 */
export interface FilesystemSnapshot {
  readonly worktreePath: string;
  readonly entries: ReadonlyMap<string, FileEntry>;
  readonly createdAt: string;
  /**
   * 实现创建的临时备份目录（位于系统临时目录，不在 worktree 内）。
   * `rollback` 从此目录恢复文件内容。`dispose` 清理此目录。
   * 若实现选择不备份（如仅检测不回滚），此字段为 `undefined`。
   */
  readonly backupDir?: string;
}

export type FilesystemChangeType =
  | "added" // 快照前不存在，快照后新增
  | "modified" // 内容哈希变化
  | "deleted" // 快照前存在，快照后消失
  | "type-changed"; // 文件类型变化（如常规文件 → 符号链接）

/**
 * 单个文件系统变更。
 *
 * - `added`：`after` 存在，`before` 不存在。
 * - `modified`：`before` 和 `after` 都存在，但 `contentHash` 不同。
 * - `deleted`：`before` 存在，`after` 不存在。
 * - `type-changed`：`before` 和 `after` 都存在，但文件类型（常规/符号链接）变化。
 */
export interface FilesystemChange {
  readonly type: FilesystemChangeType;
  readonly relativePath: string;
  readonly before?: FileEntry;
  readonly after?: FileEntry;
}

/**
 * Worktree 文件系统守卫 —— P1-R01。
 *
 * 三层防御（§11.2 关闭要求第 1 点）：
 *
 * 1. **执行期隔离**（`applyExecutionIsolation`）：在 Runtime 执行前，将
 *    不在 `Plan.allowedPaths` 内的现有文件/目录设为只读。Omp 的 `edit`/
 *    `write` 工具在执行期遇到 `EACCES`，实现"实际操作前"的路径校验。
 *    这是从 prompt/审批模式/事后回滚升级到**可强制的执行期边界**的关键。
 * 2. **快照检测**（`createSnapshot` + `detectChanges`）：Runtime 执行后
 *    对比前后快照，检测所有文件系统变更（含新文件创建、符号链接逃逸等
 *    只读标志无法完全阻止的场景）。
 * 3. **回滚恢复**（`rollback`）：将越界变更恢复到快照状态，失败关闭。
 *
 * 使用方法（由 ExecutionOrchestrator.runDevelop 调用）：
 *
 * ```ts
 * const before = await guard.createSnapshot(worktreePath);
 * const lease = await guard.applyExecutionIsolation(worktreePath, allowedPaths);
 * try {
 *   await runtime.develop(input, signal);
 * } finally {
 *   await lease.release(); // 恢复原始权限
 * }
 * const after = await guard.createSnapshot(worktreePath);
 * const changes = guard.detectChanges(before, after);
 * const violations = changes.filter(c => !matchesAllowedPaths(c.relativePath, allowedPaths));
 * if (violations.length > 0) {
 *   await guard.rollback(before, violations);
 *   // 写 policy_denied 审计 + 抛 PathScopeViolationError
 * }
 * ```
 *
 * 实现必须：
 * 1. **快照完整性**：遍历 worktree 中所有文件（含未跟踪文件、符号链接、
 *    隐藏文件、`.git` 文件）。`.git` 文件（git worktree 指向主仓库 gitdir）
 *    被纳入快照以检测修改/删除/类型变化。`.git` 目录（完整 clone）仅记录
 *    存在，不递归遍历内部 git 对象。每个文件记录元信息 + 备份内容。
 * 2. **变更检测**：对比前后快照，返回所有变更（added/modified/deleted/
 *    type-changed）。不遗漏未跟踪文件的新增或删除。
 * 3. **回滚安全性**：仅恢复 `changes` 中列出的文件。不触碰未变更的文件。
 *    回滚后 worktree 中越界路径的文件状态与 `before` 快照一致。
 * 4. **备份隔离**：备份目录必须位于 worktree 外部（系统临时目录），
 *    防止 omp 修改备份内容。备份目录路径记录在 `snapshot.backupDir`。
 * 5. **资源清理**：`dispose` 必须删除备份目录，避免临时目录累积。
 * 6. **执行期隔离**（§11.2）：`applyExecutionIsolation` 必须在 Runtime
 *    执行前将非 allowedPaths 路径设为只读。`.git` 无条件设为只读。
 *    `lease.release()` 必须恢复原始权限，即使部分恢复失败也继续尝试
 *    恢复其余文件。release 失败不阻塞主流程（权限残留非安全问题）。
 */
export interface WorktreeFilesystemGuard {
  /**
   * 创建 worktree 文件系统快照。
   *
   * 遍历 `worktreePath` 下所有文件（含 `.git` 文件），记录元信息并备份
   * 文件内容到临时目录。备份目录路径记录在返回值的 `backupDir` 字段。
   *
   * @param worktreePath worktree 根目录的绝对路径
   * @returns 文件系统快照
   */
  createSnapshot(worktreePath: string): Promise<FilesystemSnapshot>;

  /**
   * 对比两个快照，返回所有文件系统变更。
   *
   * @param before 先前快照（`createSnapshot` 返回值）
   * @param after 当前快照
   * @returns 变更列表（可能为空）
   */
  detectChanges(
    before: FilesystemSnapshot,
    after: FilesystemSnapshot
  ): readonly FilesystemChange[];

  /**
   * 将 `changes` 中列出的文件回滚到 `snapshot` 快照时的状态。
   *
   * - `added`：删除新增的文件/目录。
   * - `modified`：从备份恢复文件内容。
   * - `deleted`：从备份恢复被删除的文件。
   * - `type-changed`：先删除当前文件，再从备份恢复原始文件/符号链接。
   *
   * P1-R01 §10.2：回滚是**失败关闭**的 —— 如果备份损坏、文件被外部进程
   * 锁定或符号链接创建失败，回滚抛出异常而非静默吞错。调用方
   * （`enforceFilesystemScope`）捕获后写 `policy_denied` 审计并抛
   * `PathScopeViolationError`。此外，调用方在回滚后必须新建快照做
   * 完整性校验，确保越界路径已完全恢复。
   *
   * @param snapshot 先前快照（含备份目录路径）
   * @param changes 需要回滚的变更列表
   * @throws {Error} 备份不存在、文件锁定、符号链接创建失败等恢复错误
   */
  rollback(
    snapshot: FilesystemSnapshot,
    changes: readonly FilesystemChange[]
  ): Promise<void>;

  /**
   * 清理快照关联的临时资源（备份目录）。
   *
   * 调用方应在快照不再需要时（无论是否回滚）调用此方法。
   * 多次调用安全（幂等）。
   */
  dispose(snapshot: FilesystemSnapshot): Promise<void>;

  /**
   * P1-R01 §11.2：在 Runtime 执行前对 worktree 应用路径隔离策略。
   *
   * 将不在 `allowedPaths` 内的现有文件/目录设为只读，使 Omp 的 `edit`/
   * `write` 工具在执行期遇到 `EACCES` 错误，实现"实际操作前"的路径校验。
   * `.git` 路径无条件设为只读（防止篡改 git 元数据）。
   *
   * 这是三层防御的第一层（执行期隔离），与快照检测（第二层）和回滚恢复
   * （第三层）互补。执行期隔离阻止对**已存在**文件的修改；快照检测处理
   * 新文件创建等只读标志无法完全阻止的场景。
   *
   * 调用方必须在 Runtime 执行前调用此方法，并在 Runtime 结束后（无论
   * 成功或失败）调用 `lease.release()` 恢复原始权限。
   *
   * @param worktreePath worktree 根目录的绝对路径
   * @param allowedPaths Plan.allowedPaths 白名单（POSIX glob 风格）
   * @returns 隔离租约，`release()` 恢复原始权限
   */
  applyExecutionIsolation(
    worktreePath: string,
    allowedPaths: readonly string[]
  ): Promise<ExecutionIsolationLease>;

  /**
   * P1-R01（§7.2 运行期符号链接逃逸监听）：启动文件系统监听器，在
   * Runtime 执行期间近实时检测新增的符号链接逃逸。
   *
   * `applyExecutionIsolation` 仅检测 Runtime 启动**前**已存在的符号链接；
   * `enforceFilesystemScope` 仅在 Runtime **结束后**检测新增符号链接。
   * 本方法填补两者之间的窗口：Runtime 执行**期间**创建的指向 worktree
   * 外部的符号链接会被近实时检测，并立即调用 `onViolation` 回调（调用方
   * 通常在其中 `abortController.abort()` 终止 Runtime）。
   *
   * **局限性（诚实记录）：** 本方法使用 `fs.watch` 递归监听，事件回调在
   * 事件循环的后续 tick 中执行。如果 Runtime 在创建链接后的同一同步代码
   * 块中立即通过链接写入外部目标，watcher 可能来不及在写入前 abort。
   * 但在真实 omp 场景中，工具调用之间有 LLM 推理延迟（秒级），watcher
   * 有充足时间检测并终止。本方法不能完全替代 OS 级隔离，但将攻击窗口从
   * "整个 Runtime 执行期"缩小到"毫秒级事件延迟"。
   *
   * @param worktreePath worktree 根目录的绝对路径
   * @param allowedPaths Plan.allowedPaths 白名单（POSIX glob 风格）
   * @param onViolation 检测到越界符号链接时的回调
   * @returns 监听器句柄，`stop()` 停止监听并释放资源
   */
  watchForSymlinkEscapes(
    worktreePath: string,
    allowedPaths: readonly string[],
    onViolation: (violation: SymlinkEscapeViolation) => void
  ): SymlinkEscapeWatcher;
}

/**
 * 符号链接逃逸监听器句柄。
 *
 * 由 `watchForSymlinkEscapes` 返回。`stop()` 停止监听并释放底层资源
 * （`fs.watch` 句柄）。多次调用安全（幂等）。
 */
export interface SymlinkEscapeWatcher {
  stop(): void;
}

/**
 * 符号链接逃逸违规（运行期检测）。
 *
 * - `relativePath`：符号链接相对 worktree 根的 POSIX 路径
 * - `symlinkTarget`：`readlinkSync` 返回的符号链接目标字符串
 */
export interface SymlinkEscapeViolation {
  readonly relativePath: string;
  readonly symlinkTarget: string;
}

/**
 * 执行期路径隔离租约。
 *
 * 由 `applyExecutionIsolation` 返回，`release()` 恢复 `applyExecutionIsolation`
 * 设置的只读权限到原始状态。
 *
 * `release()` 必须在 Runtime 结束后调用（在 `finally` 块中）。即使部分
 * 文件恢复失败，也继续尝试恢复其余文件。恢复失败不抛错（权限残留不是
 * 安全问题 —— 残留的只读标志只会阻止后续修改，不会允许越界写入）。
 */
export interface ExecutionIsolationLease {
  readonly worktreePath: string;
  release(): Promise<void>;
}
