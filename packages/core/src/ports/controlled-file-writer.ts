/**
 * ControlledFileWriter 端口 —— P1-R01 §18 受控文件工具代理。
 *
 * §18.3 要求"必须使用受控文件工具代理、受限账户/ACL、沙箱，或经真实
 * Omp Spike 验证的逐路径 allowlist，在写入发生前同步拒绝越权"。
 *
 * 本端口是"受控文件工具代理"的核心：omp develop 阶段改为 `--tools
 * read,grep,glob`（只读，无 edit/write/bash），omp 无法直接修改文件。
 * omp 在文本输出中提供文件修改指令（XML 标签格式），由本端口代为写入。
 *
 * **安全边界**：`writeFiles` 在每次写入前同步校验路径：
 * 1. `relativePath` 必须落在 `allowedPaths` 白名单内（glob 匹配）；
 * 2. `relativePath` 不是受保护路径（`.git` 等）；
 * 3. 写入路径解析后不越界（无符号链接逃逸）。
 * 任一检查失败立即抛 `PathScopeViolationError`，**不写入任何文件**。
 *
 * 这是"同步、操作前、逐路径"的强制边界——与 omp 内置 edit/write 工具
 * 的事后检测（enforceFilesystemScope）互补，但本端口是主要安全边界：
 * omp 没有写入能力，所有文件写入都经过本端口的路径校验。
 *
 * 核心层定义接口；实现位于 `packages/adapters`（使用 `node:fs`）。
 * Core 不导入 `node:fs`。
 */

/**
 * 文件修改指令 —— omp 输出的文件修改建议。
 *
 * - `relativePath`：POSIX 风格相对路径（如 `src/users.py`），
 *   以 `/` 为分隔符，便于跨平台比较与 glob 匹配。
 * - `content`：文件的完整新内容。TracePilot 直接写入此内容，
 *   覆盖现有文件或创建新文件。
 */
export interface FileChangeInstruction {
  readonly relativePath: string;
  readonly content: string;
}

/**
 * 受控文件写入器 —— P1-R01 §18 受控文件工具代理。
 *
 * `OmpAdapter.develop` 在 omp 事件流结束后，从 stdout 中提取文件修改
 * 指令，调用本端口代为写入。本端口在每次写入前同步校验路径。
 *
 * **失败关闭**：如果任何文件的路径越界（不在 allowedPaths 内、是受保护
 * 路径、或存在符号链接逃逸），整个 `writeFiles` 调用失败，不写入任何
 * 文件。调用方（OmpAdapter）捕获后产出 `error` 事件。
 */
export interface ControlledFileWriter {
  /**
   * 代为写入文件修改指令。
   *
   * 在写入前对每个文件做路径校验：
   * 1. `relativePath` 必须匹配 `allowedPaths` 中的至少一个 glob 模式；
   * 2. `relativePath` 不是受保护路径（`.git`、`.git/*` 等）；
   * 3. 写入路径（`worktreePath/relativePath`）解析后不越界。
   *
   * 如果任何文件校验失败，立即抛 `PathScopeViolationError`，不写入任何
   * 文件（原子性：全部通过才写入，任一失败全部不写）。
   *
   * @param taskId 任务 ID（用于错误信息）
   * @param worktreePath worktree 根目录的绝对路径
   * @param allowedPaths Plan.allowedPaths 白名单（POSIX glob 风格）
   * @param changes 文件修改指令列表
   * @throws {PathScopeViolationError} 任何文件路径越界时抛出
   */
  writeFiles(
    taskId: string,
    worktreePath: string,
    allowedPaths: readonly string[],
    changes: readonly FileChangeInstruction[]
  ): Promise<void>;
}
