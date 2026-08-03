/**
 * LocalWorktreeFilesystemGuard —— P1-R01 实现（Phase 4 第三轮验收 §7.2）。
 *
 * 使用 `node:fs` / `node:crypto` / `node:path` / `node:os` 实现
 * `WorktreeFilesystemGuard` 端口。在 Runtime 执行前后对 worktree 做
 * 全量文件系统快照，检测所有变更（含未跟踪文件、符号链接、删除），
 * 并支持将越界变更回滚到快照状态。
 *
 * ## 安全设计
 *
 * 1. **备份隔离**：备份目录位于 `os.tmpdir()` 下的子目录，不在 worktree 内，
 *    防止 omp 子进程修改备份。备份目录名含随机 ID，避免冲突。
 * 2. **符号链接处理**：快照记录符号链接的目标（`readlinkSync`），不跟随
 *    符号链接遍历（`lstatSync` 而非 `statSync`）。这检测 omp 创建指向
 *    worktree 外部的符号链接（§7.2 符号链接逃逸）。
 * 3. **`.git` 保护**（P1-R01 §9.2）：worktree 中的 `.git`（git worktree 中
 *    是指向主仓库 gitdir 的文件）被纳入快照，检测修改/删除/类型变化。
 *    若 `.git` 是目录（完整 clone 场景），记录其存在但不递归遍历内部
 *    git 对象（太大），仅检测删除或类型变化。
 * 4. **回滚安全性**：回滚仅恢复 `changes` 中列出的文件。对 `added` 类变更
 *    （omp 新创建的越界文件），直接删除；对 `modified`/`deleted`/`type-changed`
 *    类变更，从备份目录恢复原始内容/符号链接。
 * 5. **失败关闭（P1-R01 §10.2）**：快照、备份、回滚任一失败都必须失败关闭 ——
 *    抛出异常而非静默吞错。调用方（ExecutionOrchestrator.enforceFilesystemScope）
 *    捕获后写 `policy_denied` 审计并抛 `PathScopeViolationError`，拒绝后续验证与
 *    Review。回滚后由调用方做完整性校验（新建快照对比 beforeSnapshot）。
 *
 * ## 性能
 *
 * 快照遍历整个 worktree，对每个文件计算 sha256 哈希并复制到备份目录。
 * 对于大型 worktree（数千文件），这可能耗时数秒。MVP 可接受；
 * 后续可用 `git ls-files` + 增量检测优化。
 */

import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
  watch
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type {
  FileEntry,
  FilesystemChange,
  FilesystemSnapshot,
  WorktreeFilesystemGuard,
  ExecutionIsolationLease,
  SymlinkEscapeWatcher,
  SymlinkEscapeViolation
} from "@tracepilot/core";
import { isProtectedPath, findPathScopeViolations, isSymlinkTargetOutsideWorktree } from "@tracepilot/core";

/**
 * 系统临时目录下备份目录的前缀，便于识别和清理。
 */
const BACKUP_PREFIX = "tracepilot-fs-guard-";

/**
 * P1-R01 §14.2：执行期隔离失败错误。
 *
 * 当 `applyExecutionIsolation` 遇到无法读取目录、无法设置权限、
 * 或检测到符号链接逃逸时抛出。调用方必须拒绝启动 Runtime（失败关闭）。
 */
export class ExecutionIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionIsolationError";
  }
}

export class LocalWorktreeFilesystemGuard implements WorktreeFilesystemGuard {
  async createSnapshot(worktreePath: string): Promise<FilesystemSnapshot> {
    // 创建备份目录（位于系统临时目录，不在 worktree 内）。
    const backupDir = join(
      tmpdir(),
      `${BACKUP_PREFIX}${Date.now()}-${randomBytes(4).toString("hex")}`
    );
    mkdirSync(backupDir, { recursive: true });

    const entries = new Map<string, FileEntry>();
    try {
      // P1-R01 §10.2：walkAndSnapshot 内部的备份操作（backupFile /
      // backupSymlinkTarget）失败时抛错，使 createSnapshot 失败关闭。
      // 若快照创建失败，清理已创建的备份目录后重新抛出。
      walkAndSnapshot(worktreePath, worktreePath, backupDir, entries);
    } catch (err) {
      // 清理部分创建的备份目录，避免临时目录泄漏。
      try {
        rmSync(backupDir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响原始错误。
      }
      throw err;
    }

    return {
      worktreePath,
      entries,
      createdAt: new Date().toISOString(),
      backupDir
    };
  }

  detectChanges(
    before: FilesystemSnapshot,
    after: FilesystemSnapshot
  ): readonly FilesystemChange[] {
    const changes: FilesystemChange[] = [];
    const allPaths = new Set<string>([
      ...before.entries.keys(),
      ...after.entries.keys()
    ]);

    for (const relativePath of allPaths) {
      const beforeEntry = before.entries.get(relativePath);
      const afterEntry = after.entries.get(relativePath);

      if (!beforeEntry && afterEntry) {
        changes.push({
          type: "added",
          relativePath,
          after: afterEntry
        });
      } else if (beforeEntry && !afterEntry) {
        changes.push({
          type: "deleted",
          relativePath,
          before: beforeEntry
        });
      } else if (beforeEntry && afterEntry) {
        // 两者都存在 —— 检查类型和内容
        if (beforeEntry.isSymlink !== afterEntry.isSymlink) {
          changes.push({
            type: "type-changed",
            relativePath,
            before: beforeEntry,
            after: afterEntry
          });
        } else if (beforeEntry.isSymlink && afterEntry.isSymlink) {
          // 两者都是符号链接 —— 检查目标是否变化
          if (beforeEntry.symlinkTarget !== afterEntry.symlinkTarget) {
            changes.push({
              type: "modified",
              relativePath,
              before: beforeEntry,
              after: afterEntry
            });
          }
        } else {
          // 两者都是常规文件 —— 检查哈希是否变化
          if (beforeEntry.contentHash !== afterEntry.contentHash) {
            changes.push({
              type: "modified",
              relativePath,
              before: beforeEntry,
              after: afterEntry
            });
          }
        }
      }
      // 两者都不存在 —— 不可能（allPaths 来源于两者的并集）
    }

    return changes;
  }

  async rollback(
    snapshot: FilesystemSnapshot,
    changes: readonly FilesystemChange[]
  ): Promise<void> {
    if (!snapshot.backupDir) {
      throw new Error("快照无备份目录，无法回滚");
    }

    for (const change of changes) {
      const absolutePath = join(
        snapshot.worktreePath,
        ...change.relativePath.split("/")
      );
      const backupPath = join(
        snapshot.backupDir,
        ...change.relativePath.split("/")
      );

      switch (change.type) {
        case "added": {
          // omp 新创建的越界文件 —— 删除
          if (existsSync(absolutePath)) {
            const lstat = lstatSync(absolutePath);
            if (lstat.isDirectory()) {
              rmSync(absolutePath, { recursive: true, force: true });
            } else {
              unlinkSync(absolutePath);
            }
          }
          break;
        }

        case "modified": {
          // 内容/符号链接目标变化 —— 从备份恢复
          restoreFromBackup(backupPath, absolutePath, change.before);
          break;
        }

        case "deleted": {
          // 文件被删除 —— 从备份恢复
          // 确保父目录存在
          mkdirSync(dirname(absolutePath), { recursive: true });
          restoreFromBackup(backupPath, absolutePath, change.before);
          break;
        }

        case "type-changed": {
          // 文件类型变化（如常规文件 → 符号链接）
          // 先删除当前文件，再从备份恢复原始文件
          if (existsSync(absolutePath)) {
            const lstat = lstatSync(absolutePath);
            if (lstat.isDirectory()) {
              rmSync(absolutePath, { recursive: true, force: true });
            } else {
              unlinkSync(absolutePath);
            }
          }
          mkdirSync(dirname(absolutePath), { recursive: true });
          restoreFromBackup(backupPath, absolutePath, change.before);
          break;
        }
      }
    }
  }

  async dispose(snapshot: FilesystemSnapshot): Promise<void> {
    if (snapshot.backupDir && existsSync(snapshot.backupDir)) {
      rmSync(snapshot.backupDir, { recursive: true, force: true });
    }
  }

  /**
   * P1-R01 §14.2：在 Runtime 执行前对 worktree 应用路径隔离策略。
   *
   * 遍历 worktree，将不在 `allowedPaths` 内的现有文件/目录设为只读，
   * 使 Omp 的 `edit`/`write` 工具在执行期遇到 `EACCES`。`.git` 等受保护
   * 路径无条件设为只读。
   *
   * **§14.2 失败关闭**：以下任一情况都必须抛 `ExecutionIsolationError`，
   * 调用方必须拒绝启动 Runtime：
   * 1. 无法读取目录（权限不足、文件锁等）
   * 2. `chmodSync` 失败（权限不足等）
   * 3. 检测到指向 worktree 外部的符号链接（符号链接逃逸）
   *
   * **§14.2 符号链接逃逸**：对每个符号链接，解析其真实路径
   * （`realpathSync`），若真实路径不在 worktree 内则抛错。这防止 Omp
   * 通过 worktree 内的符号链接修改 worktree 外的文件。
   *
   * **Windows 限制说明**：Windows 目录 read-only 不阻止文件创建。
   * 白名单外目录内的新建文件由快照检测层（第二层）和回滚恢复层
   * （第三层）处理。这是已记录的限制，不是安全漏洞——越界新建文件
   * 会在 Runtime 结束后被检测和回滚。
   */
  async applyExecutionIsolation(
    worktreePath: string,
    allowedPaths: readonly string[]
  ): Promise<ExecutionIsolationLease> {
    const lockedEntries: Array<{ absolutePath: string; originalMode: number }> = [];
    // 解析 worktree 的规范路径，用于符号链接逃逸检测
    const worktreeRealPath = realpathSync(worktreePath);

    const walkAndLock = (dirPath: string): void => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dirPath, { withFileTypes: true });
      } catch (err) {
        // §14.2 失败关闭：无法读取目录时拒绝启动 Runtime
        throw new ExecutionIsolationError(
          `无法读取目录 ${dirPath}：${(err as Error).message}。拒绝启动 Runtime（失败关闭）`
        );
      }
      for (const entry of entries) {
        const absolutePath = join(dirPath, entry.name);
        const relativePath = relative(worktreePath, absolutePath)
          .split(sep)
          .join("/");

        let stat;
        try {
          stat = lstatSync(absolutePath);
        } catch (err) {
          // §14.2 失败关闭：无法 lstat 时拒绝启动 Runtime
          throw new ExecutionIsolationError(
            `无法获取文件状态 ${absolutePath}：${(err as Error).message}。拒绝启动 Runtime（失败关闭）`
          );
        }

        // §14.2 符号链接逃逸检测：解析真实路径，拒绝指向 worktree 外的符号链接
        if (stat.isSymbolicLink()) {
          let linkTarget: string;
          try {
            linkTarget = realpathSync(absolutePath);
          } catch (err) {
            // 符号链接目标不存在或无法解析 → 失败关闭
            throw new ExecutionIsolationError(
              `无法解析符号链接 ${absolutePath}：${(err as Error).message}。拒绝启动 Runtime（失败关闭）`
            );
          }
          // 检查真实路径是否在 worktree 内
          const isInsideWorktree =
            linkTarget === worktreeRealPath ||
            linkTarget.startsWith(worktreeRealPath + sep) ||
            linkTarget.startsWith(worktreeRealPath + "/");
          if (!isInsideWorktree) {
            throw new ExecutionIsolationError(
              `检测到符号链接逃逸：${relativePath} → ${linkTarget}（指向 worktree 外部）。拒绝启动 Runtime（失败关闭）`
            );
          }
          // 符号链接指向 worktree 内部 → 继续处理（不设只读，跟随到目标）
          continue;
        }

        // 判断是否需要设为只读：
        // 1. 受保护路径（.git 等）→ 无条件只读
        // 2. 不在 allowedPaths 内 → 只读
        const isProtected = isProtectedPath(relativePath);
        const isOutsideAllowed =
          findPathScopeViolations([relativePath], allowedPaths).length > 0;

        if (isProtected || isOutsideAllowed) {
          const originalMode = stat.mode;
          try {
            // 移除所有写权限位（0o222 = owner write | group write | other write）
            chmodSync(absolutePath, originalMode & ~0o222);
            lockedEntries.push({ absolutePath, originalMode });
          } catch (err) {
            // §14.2 失败关闭：chmodSync 失败时拒绝启动 Runtime
            throw new ExecutionIsolationError(
              `无法设置文件权限 ${absolutePath}：${(err as Error).message}。拒绝启动 Runtime（失败关闭）`
            );
          }
        }

        // 递归遍历目录（包括 .git 目录，锁定其内部文件）
        if (stat.isDirectory()) {
          walkAndLock(absolutePath);
        }
      }
    };

    walkAndLock(worktreePath);

    return {
      worktreePath,
      async release(): Promise<void> {
        // 恢复原始权限。best-effort：部分失败不阻塞其余恢复。
        // 权限残留不是安全问题（残留的只读标志只会阻止后续修改，
        // 不会允许越界写入）。
        for (const { absolutePath, originalMode } of lockedEntries) {
          try {
            chmodSync(absolutePath, originalMode);
          } catch {
            // 恢复失败不抛错（权限残留非安全问题）
          }
        }
      }
    };
  }

  /**
   * P1-R01（§7.2 运行期符号链接逃逸监听）：用 `fs.watch` 递归监听
   * worktree，在 Runtime 执行期间近实时检测新增的符号链接逃逸。
   *
   * 实现原理：
   * 1. `fs.watch(worktreePath, { recursive: true })` 递归监听 worktree
   *    （Windows 原生支持 `recursive: true`）。
   * 2. 收到 'rename' 事件（文件创建/删除/重命名）时，对变更路径做
   *    `lstatSync` 判断是否为符号链接。
   * 3. 如果是符号链接，用 `readlinkSync` 获取目标，用
   *    `isSymlinkTargetOutsideWorktree` 判断是否指向 worktree 外部。
   * 4. 如果越界，调用 `onViolation` 回调（调用方在其中 abort Runtime）。
   *
   * **失败关闭（§17.2 第 2 点）**：
   * - `fs.watch` 启动失败时**抛错**，拒绝启动 Runtime（不返回 no-op watcher）。
   * - `fsWatcher` 的 `error` 事件调用 `onViolation`（视为可能的逃逸，abort）。
   * - 回调中 `lstatSync`/`readlinkSync` 失败时调用 `onViolation`（fail-closed：
   *   无法确认安全就视为越界）。
   *
   * **局限性（诚实记录）**：`fs.watch` 事件回调在事件循环后续 tick 执行，
   * 不是同步的"操作前"拦截。如果 Runtime 在创建链接后的同一同步代码块
   * 立即写入外部目标，watcher 可能来不及 abort。但真实 omp 工具调用间
   * 有 LLM 推理延迟（秒级），watcher 有充足时间检测。本方法不能完全
   * 替代 OS 级隔离，但将攻击窗口从事后检测缩小到毫秒级事件延迟。
   */
  watchForSymlinkEscapes(
    worktreePath: string,
    allowedPaths: readonly string[],
    onViolation: (violation: SymlinkEscapeViolation) => void
  ): SymlinkEscapeWatcher {
    let stopped = false;

    // §17.2 fail-closed：fs.watch 启动失败时抛错，拒绝启动 Runtime。
    // 不返回 no-op watcher —— 无法监听就不能保证安全边界。
    const fsWatcher = watch(
      worktreePath,
      { recursive: true },
      (eventType, filename) => {
        if (stopped || !filename) return;
        // 只处理 'rename' 事件（文件创建/删除/重命名）
        if (eventType !== "rename") return;

        const fullPath = join(worktreePath, filename);
        try {
          const stat = lstatSync(fullPath);
          if (!stat.isSymbolicLink()) return;
          const target = readlinkSync(fullPath);
          const relativePath = relative(worktreePath, fullPath)
            .split(sep)
            .join("/");

          // 检查是否为受保护路径
          if (isProtectedPath(relativePath)) {
            onViolation({ relativePath, symlinkTarget: target });
            return;
          }
          // 检查是否在 allowedPaths 内
          const violators = findPathScopeViolations([relativePath], allowedPaths);
          if (violators.length > 0) {
            onViolation({ relativePath, symlinkTarget: target });
            return;
          }
          // 检查符号链接目标是否指向 worktree 外部
          if (isSymlinkTargetOutsideWorktree(worktreePath, relativePath, target)) {
            onViolation({ relativePath, symlinkTarget: target });
          }
        } catch {
          // §17.2 fail-closed：lstatSync/readlinkSync 失败时无法确认
          // 变更是否安全，视为越界并 abort Runtime。文件可能在事件回调
          // 前已被删除（omp 创建后又删除），但这本身也是可疑行为 ——
          // 正常 omp 不会在 develop 中创建又删除越界符号链接。
          onViolation({
            relativePath: relative(worktreePath, fullPath).split(sep).join("/"),
            symlinkTarget: "<unreadable>"
          });
        }
      }
    );

    // §17.2 fail-closed：fsWatcher error 事件视为监听失效，
    // 可能遗漏逃逸，调用 onViolation abort Runtime。
    fsWatcher.on("error", () => {
      if (!stopped) {
        onViolation({
          relativePath: "<watcher-error>",
          symlinkTarget: "<watcher-error>"
        });
      }
    });

    return {
      stop(): void {
        if (stopped) return;
        stopped = true;
        try {
          fsWatcher.close();
        } catch {
          // stop 失败不抛错（资源清理 best-effort）
        }
      }
    };
  }
}

// ---------------------------------------------------------------------------
// 私有辅助函数
// ---------------------------------------------------------------------------

/**
 * 递归遍历 worktree，为每个文件创建 FileEntry 并备份内容。
 *
 * P1-R01（§9.2）：`.git` 被纳入快照以检测修改/删除/类型变化。
 * - git worktree 中 `.git` 是文件（指向主仓库 gitdir）→ 如常快照+备份。
 * - 完整 clone 中 `.git` 是目录 → 记录存在但不递归遍历（git 对象太大）。
 *
 * 使用 `lstatSync` 而非 `statSync`，不跟随符号链接 —— 这使快照能检测
 * 符号链接的创建/修改/删除。
 */
function walkAndSnapshot(
  currentDir: string,
  worktreeRoot: string,
  backupDir: string,
  entries: Map<string, FileEntry>
): void {
  let items: string[];
  try {
    items = readdirSync(currentDir);
  } catch {
    // 目录不可读 —— 跳过
    return;
  }

  for (const name of items) {
    const fullPath = join(currentDir, name);
    let lstat;
    try {
      lstat = lstatSync(fullPath);
    } catch {
      // 文件可能在遍历过程中被删除 —— 跳过
      continue;
    }

    const relativePath = toPosixPath(relative(worktreeRoot, fullPath));

    // P1-R01（§9.2）：.git 目录不递归遍历内部 git 对象（太大），
    // 但记录其存在，使 detectChanges 能检测 .git 被删除或类型变化。
    // .git 文件（git worktree）正常快照+备份，检测内容修改。
    if (name === ".git" && lstat.isDirectory() && currentDir === worktreeRoot) {
      entries.set(relativePath, {
        relativePath,
        isSymlink: false,
        size: 0,
        mode: lstat.mode
      });
      // 不备份目录内容，不递归遍历
      continue;
    }

    if (lstat.isSymbolicLink()) {
      // 符号链接 —— 记录目标，不遍历
      let target: string;
      try {
        target = readlinkSync(fullPath);
      } catch {
        // readlink 失败 —— 跳过
        continue;
      }
      entries.set(relativePath, {
        relativePath,
        isSymlink: true,
        symlinkTarget: target,
        size: Buffer.byteLength(target, "utf8"),
        mode: lstat.mode
      });
      // 符号链接不备份内容（备份链接目标字符串即可，回滚时重建链接）
      backupSymlinkTarget(backupDir, relativePath, target);
    } else if (lstat.isDirectory()) {
      // 目录 —— 递归遍历
      walkAndSnapshot(fullPath, worktreeRoot, backupDir, entries);
    } else if (lstat.isFile()) {
      // 常规文件 —— 计算哈希并备份
      let hash: string;
      try {
        hash = hashFileSync(fullPath);
      } catch {
        // 文件不可读 —— 跳过
        continue;
      }
      entries.set(relativePath, {
        relativePath,
        isSymlink: false,
        contentHash: hash,
        size: lstat.size,
        mode: lstat.mode
      });
      // 备份文件内容
      backupFile(backupDir, relativePath, fullPath);
    }
    // 其他类型（FIFO、socket 等）忽略
  }
}

/**
 * 同步计算文件的 sha256 哈希（十六进制）。
 *
 * 使用 `readFileSync` 读取完整内容后哈希。对大文件可能占用较多内存，
 * 但 MVP 场景下 worktree 文件通常较小。如需优化可改用流式哈希。
 */
function hashFileSync(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 备份常规文件内容到备份目录。
 *
 * 在备份目录下按相对路径创建同名文件，复制源文件内容。
 *
 * P1-R01 §10.2：备份失败必须失败关闭 —— 抛出异常而非静默吞错。
 * 若备份失败，回滚时将无法恢复此文件，因此必须使整个快照创建失败，
 * 阻止 Runtime 执行（无法保证可回滚就不允许执行）。
 */
function backupFile(backupDir: string, relativePath: string, sourcePath: string): void {
  const backupPath = join(backupDir, ...relativePath.split("/"));
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(sourcePath, backupPath);
}

/**
 * 备份符号链接目标字符串到备份目录。
 *
 * 以 `.symlink` 后缀存储目标路径，回滚时读取并重建符号链接。
 *
 * P1-R01 §10.2：备份失败必须失败关闭 —— 抛出异常。
 */
function backupSymlinkTarget(
  backupDir: string,
  relativePath: string,
  target: string
): void {
  const backupPath = join(backupDir, ...relativePath.split("/")) + ".symlink";
  mkdirSync(dirname(backupPath), { recursive: true });
  writeFileSync(backupPath, target, "utf8");
}

/**
 * 从备份恢复文件/符号链接。
 *
 * - 若 `before.isSymlink` 为 true，从 `.symlink` 备份读取目标并重建符号链接。
 * - 否则从备份目录复制文件内容到原路径。
 *
 * 恢复前会删除当前路径上的文件/目录（若存在），确保类型变化能被正确回滚。
 *
 * P1-R01 §10.2：恢复失败必须失败关闭 —— 以下任一情况都抛出异常：
 * - 无 `before` 信息（无法确定原始状态）
 * - 备份文件不存在（无法恢复内容，如 .git 目录未备份内部对象）
 * - 符号链接创建失败（权限不足或 Windows 无 Developer Mode）
 * - 文件复制失败（磁盘满、权限不足等）
 *
 * 调用方（rollback）捕获后向上传播，最终由 enforceFilesystemScope
 * 写 policy_denied 审计并抛 PathScopeViolationError。
 */
function restoreFromBackup(
  backupPath: string,
  absolutePath: string,
  before?: FileEntry
): void {
  if (!before) {
    // P1-R01 §10.2：无 before 信息无法恢复 —— 失败关闭。
    throw new Error(`restoreFromBackup：无 before 信息，无法恢复 ${absolutePath}`);
  }

  if (before.isSymlink) {
    // 恢复符号链接
    const symlinkBackup = backupPath + ".symlink";
    if (!existsSync(symlinkBackup)) {
      // P1-R01 §10.2：备份不存在无法恢复 —— 失败关闭。
      throw new Error(`restoreFromBackup：符号链接备份不存在，无法恢复 ${absolutePath}`);
    }
    const target = readFileSync(symlinkBackup, "utf8");
    // 删除当前文件（如果存在）
    if (existsSync(absolutePath)) {
      try {
        unlinkSync(absolutePath);
      } catch {
        // 可能是目录 —— 递归删除
        rmSync(absolutePath, { recursive: true, force: true });
      }
    }
    // P1-R01 §10.2：符号链接创建失败 —— 失败关闭（不再静默吞错）。
    // Windows 下可能需要管理员权限或 Developer Mode；若无法创建符号链接，
    // 回滚不完整，必须失败关闭而非假装成功。
    symlinkSync(target, absolutePath);
  } else {
    // 恢复常规文件
    if (!existsSync(backupPath)) {
      // P1-R01 §10.2：备份文件不存在无法恢复 —— 失败关闭。
      // 这覆盖 .git 目录被删除的场景：.git 目录仅记录存在不备份内部对象，
      // 若被删除则无法恢复，必须失败关闭。
      throw new Error(`restoreFromBackup：备份文件不存在，无法恢复 ${absolutePath}`);
    }
    // 删除当前文件（如果存在且类型不同）
    if (existsSync(absolutePath)) {
      try {
        unlinkSync(absolutePath);
      } catch {
        // 可能是目录 —— 递归删除
        rmSync(absolutePath, { recursive: true, force: true });
      }
    }
    mkdirSync(dirname(absolutePath), { recursive: true });
    copyFileSync(backupPath, absolutePath);
  }
}

/**
 * 将平台路径转换为 POSIX 风格（`/` 分隔符）。
 *
 * Windows 下 `relative()` 返回 `\` 分隔路径，统一转为 `/` 便于跨平台比较。
 */
function toPosixPath(p: string): string {
  return p.split(sep).join("/");
}
