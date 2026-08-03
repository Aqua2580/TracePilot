/**
 * LocalControlledFileWriter —— P1-R01 §18 受控文件工具代理实现。
 *
 * 详见 `packages/core/src/ports/controlled-file-writer.ts` 的接口文档。
 *
 * 本实现使用 `node:fs` 在 worktree 中写入文件。在写入前对每个文件做
 * 路径校验（allowedPaths glob 匹配 + 受保护路径检查 + 符号链接逃逸
 * 检查）。任一文件在批量预检阶段失败，整个 `writeFiles` 调用失败，
 * 不写入任何文件。实际写入期间若发生 I/O 错误，由上层 worktree 快照
 * 与回滚机制恢复，不能把普通文件系统 API 误称为事务性写入。
 */

import {
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
  ftruncateSync,
  lstatSync,
  existsSync,
  readlinkSync,
  realpathSync,
  statSync
} from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import type { ControlledFileWriter, FileChangeInstruction } from "@tracepilot/core";
import {
  PathScopeViolationError,
  isProtectedPath,
  findPathScopeViolations,
  isSymlinkTargetOutsideWorktree
} from "@tracepilot/core";

export class LocalControlledFileWriter implements ControlledFileWriter {
  /**
   * 代为写入文件修改指令。
   *
   * 预检原子性：先校验所有文件路径，全部通过后才写入。任一文件在
   * 预检阶段越界，抛 `PathScopeViolationError`，不写入任何文件。
   */
  async writeFiles(
    taskId: string,
    worktreePath: string,
    allowedPaths: readonly string[],
    changes: readonly FileChangeInstruction[]
  ): Promise<void> {
    // 阶段 1：校验所有文件路径
    const violators: string[] = [];
    for (const change of changes) {
      const violation = this.checkPathViolation(
        worktreePath,
        change.relativePath,
        allowedPaths
      );
      if (violation) {
        violators.push(change.relativePath);
      }
    }

    if (violators.length > 0) {
      throw new PathScopeViolationError(taskId, violators, allowedPaths);
    }

    // 阶段 2：全部校验通过，逐个写入文件。
    // 每次实际写入前重新解析路径，覆盖“批量预检查后父目录被替换”的窗口。
    for (const change of changes) {
      this.assertSafeChange(taskId, worktreePath, change, allowedPaths);
      this.ensureParentDirectory(taskId, worktreePath, change.relativePath, allowedPaths);

      // 先打开并持有目标文件句柄，再执行最后一次路径校验。后续写入只使用
      // 句柄，不再重新按字符串路径解析，从而关闭“最终校验后、写入前”的
      // 父目录替换窗口。若最后校验发现路径已被替换，句柄会在不写入的情况
      // 下关闭。
      const initialTargetPath = this.assertSafeChange(
        taskId,
        worktreePath,
        change,
        allowedPaths
      );
      const targetHandle = this.openTargetHandle(initialTargetPath);
      try {
        this.beforeFinalPathValidation(worktreePath, change.relativePath);
        this.assertSafeChange(taskId, worktreePath, change, allowedPaths);

        // 使用已打开的句柄写入，不再通过可能被替换的词法链接路径二次寻址。
        // 上层文件系统守卫仍负责快照、检测和失败回滚。
        ftruncateSync(targetHandle, 0);
        writeFileSync(targetHandle, change.content, "utf8");
      } finally {
        closeSync(targetHandle);
      }
    }
  }

  /**
   * 最终真实路径校验前的故障注入点。
   *
   * 生产实现保持空操作；对抗性测试通过子类在这里模拟“批量预检完成后、
   * 实际写入前父目录被替换为符号链接”的竞态。无论子类如何修改路径，
   * 调用方随后都会执行不可跳过的最终校验。
   */
  protected beforeFinalPathValidation(
    _worktreePath: string,
    _relativePath: string
  ): void {}

  /**
   * 在实际写入前再次执行完整路径校验。
   */
  private assertSafeChange(
    taskId: string,
    worktreePath: string,
    change: FileChangeInstruction,
    allowedPaths: readonly string[]
  ): string {
    const safeTargetPath = this.resolveValidatedTargetPath(
      worktreePath,
      change.relativePath,
      allowedPaths
    );
    if (!safeTargetPath) {
      throw new PathScopeViolationError(taskId, [change.relativePath], allowedPaths);
    }
    return safeTargetPath;
  }

  /**
   * 在最终校验前绑定目标文件句柄。
   *
   * 已有文件使用 `r+`，避免在最终校验前截断原内容；新文件使用 `wx`，
   * 避免把并发出现的已有文件误当成新目标。后续内容写入只通过该句柄完成。
   */
  private openTargetHandle(targetPath: string): number {
    try {
      lstatSync(targetPath);
      return openSync(targetPath, "r+");
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      return openSync(targetPath, "wx");
    }
  }

  /**
   * 逐段创建父目录，并在每段创建或解析后确认其真实路径仍在 worktree 内。
   *
   * 不能使用 `mkdirSync(parent, { recursive: true })` 后再相信词法路径，
   * 因为递归创建可能跟随已被替换的父目录符号链接。每一段都单独检查，
   * 解析失败或落到 worktree 外时立即失败关闭。
   */
  private ensureParentDirectory(
    taskId: string,
    worktreePath: string,
    relativePath: string,
    allowedPaths: readonly string[]
  ): void {
    try {
      const realWorktree = realpathSync(worktreePath);
      const lexicalWorktree = resolve(worktreePath);
      const lexicalParent = resolve(worktreePath, dirname(relativePath));
      const parentRelative = relative(lexicalWorktree, lexicalParent);

      if (parentRelative.startsWith("..") || isAbsolute(parentRelative)) {
        throw new Error("父目录词法路径越出 worktree");
      }

      const segments = parentRelative.split(/[\\/]+/).filter(Boolean);
      let lexicalCurrent = worktreePath;
      for (const segment of segments) {
        const lexicalNext = join(lexicalCurrent, segment);
        try {
          lstatSync(lexicalNext);
        } catch (error) {
          if (!isMissingPathError(error)) {
            throw error;
          }
          // 父级已逐段确认，使用非递归 mkdir，避免一次性跟随未知链接。
          mkdirSync(lexicalNext);
        }

        const realNext = realpathSync(lexicalNext);
        const realRelative = relative(realWorktree, realNext).replace(/\\/g, "/");
        if (
          realRelative.startsWith("..") ||
          isAbsolute(realRelative) ||
          isProtectedPath(realRelative) ||
          !statSync(realNext).isDirectory()
        ) {
          throw new Error(`父目录真实路径越界或不是目录：${realRelative}`);
        }
        lexicalCurrent = lexicalNext;
      }
    } catch {
      throw new PathScopeViolationError(taskId, [relativePath], allowedPaths);
    }
  }

  /**
   * 检查单个文件路径是否越界。
   *
   * 实施规格 §7.2 要求"实际操作前解析真实路径"。本方法分两阶段：
   *
   * **词法阶段**（快速拒绝明显越权）：
   * 1. 受保护路径检查（`.git` 等）
   * 2. 词法路径穿越检查（`..` 逃逸到 worktree 外）
   * 3. 词法 allowedPaths glob 匹配
   *
   * **真实路径阶段**（§19.2 要求：解析符号链接后验证真实落点）：
   * 4. 解析父目录链真实路径（逐级向上找到已存在祖先，realpathSync 解析，
   *    拼接剩余不存在部分）
   * 5. 解析最终文件真实路径（若已存在）
   * 6. 验证真实落点：(a) 在 worktree 内；(b) 相对 worktree 的真实 POSIX
   *    路径匹配 allowedPaths
   *
   * 这覆盖了 `src/alias → tests/`（worktree 内但白名单外）和
   * `src/ → /external/`（worktree 外）两类符号链接逃逸。
   *
   * @returns true 表示越界（应拒绝写入）
   */
  private checkPathViolation(
    worktreePath: string,
    relativePath: string,
    allowedPaths: readonly string[]
  ): boolean {
    return this.resolveValidatedTargetPath(worktreePath, relativePath, allowedPaths) === undefined;
  }

  /**
   * 校验逻辑路径与真实落点，并在通过时返回应直接写入的真实目标路径。
   * 返回 `undefined` 表示失败关闭。
   */
  private resolveValidatedTargetPath(
    worktreePath: string,
    relativePath: string,
    allowedPaths: readonly string[]
  ): string | undefined {
    // 1. 受保护路径检查（.git 等）
    if (isProtectedPath(relativePath)) {
      return undefined;
    }

    // 2. 词法路径穿越检查：resolve + relative 规范化路径，
    //    捕获任何以合法前缀开头但中间用 `..` 逃逸到 worktree 外的路径。
    const resolvedFull = resolve(worktreePath, relativePath);
    const resolvedWorktree = resolve(worktreePath);
    const relFromWorktree = relative(resolvedWorktree, resolvedFull);
    if (relFromWorktree.startsWith("..") || isAbsolute(relFromWorktree)) {
      return undefined;
    }

    // 3. 词法 allowedPaths glob 匹配检查
    const lexicalViolators = findPathScopeViolations([relativePath], allowedPaths);
    if (lexicalViolators.length > 0) {
      return undefined;
    }

    const fullPath = join(worktreePath, relativePath);

    // 4-6. 真实路径解析与验证（§19.2：解析符号链接后验证真实落点）
    try {
      const realWorktree = realpathSync(worktreePath);
      const realTarget = this.resolveRealTargetPath(worktreePath, realWorktree, fullPath);

      // 6a. 真实落点必须在 worktree 内
      const relFromReal = relative(realWorktree, realTarget);
      if (relFromReal.startsWith("..") || isAbsolute(relFromReal)) {
        return undefined; // 真实落点逃逸到 worktree 外（外部符号链接）
      }

      // 6b. 真实落点的相对 POSIX 路径必须匹配 allowedPaths
      //     这覆盖 src/alias → tests/（worktree 内但白名单外）
      const realRelPosix = relFromReal.replace(/\\/g, "/");
      if (isProtectedPath(realRelPosix)) {
        return undefined;
      }
      const realViolators = findPathScopeViolations([realRelPosix], allowedPaths);
      if (realViolators.length > 0) {
        return undefined;
      }

      // 7. 最终文件本身的符号链接逃逸检查：如果目标路径已存在且是符号链接，
      //    检查其目标是否指向 worktree 外部（writeFileSync 会跟随符号链接）。
      if (existsSync(fullPath)) {
        const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink()) {
          const target = readlinkSync(fullPath);
          if (isSymlinkTargetOutsideWorktree(worktreePath, relativePath, target)) {
            return undefined;
          }
        }
      }
      return realTarget;
    } catch {
      // realpathSync 或任何文件系统操作失败：fail-closed，视为越界
      return undefined;
    }
  }

  /**
   * 解析目标文件的真实路径（解析所有符号链接）。
   *
   * 对最终文件路径逐级处理：
   * - 从 worktree 根开始，逐段向下遍历
   * - 对每段已存在的路径，用 realpathSync 解析符号链接
   * - 不存在的路径段直接拼接（不可能是符号链接）
   *
   * 这样即使父目录是符号链接（如 src/alias → tests/），也能得到
   * 真实落点（tests/new.py），用于 allowedPaths 验证。
   *
   * @param worktreePath worktree 根的词法路径
   * @param realWorktree worktree 根的真实路径（已 realpathSync）
   * @param fullPath 目标文件的完整路径
   * @returns 目标文件的真实路径
   */
  private resolveRealTargetPath(
    worktreePath: string,
    realWorktree: string,
    fullPath: string
  ): string {
    // 用词法 worktree 计算相对段，再用 lexical path 做 lstat/realpath；
    // 这样 worktree 本身即使经过链接，也不会把绝对路径误当作相对段。
    const lexicalWorktree = resolve(worktreePath);
    const lexicalFull = resolve(fullPath);
    const relPath = relative(lexicalWorktree, lexicalFull);
    if (relPath.startsWith("..") || isAbsolute(relPath)) {
      throw new Error("目标路径越出 worktree");
    }

    const segments = relPath.split(/[\\/]+/).filter(Boolean);
    let lexicalCurrent = worktreePath;
    let realCurrent = realWorktree;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      const lexicalNext = join(lexicalCurrent, segment);
      try {
        lstatSync(lexicalNext);
      } catch (error) {
        // 只有明确的“路径不存在”才允许把剩余部分视为待创建路径。
        // 悬挂链接、权限错误、路径类型错误等必须失败关闭。
        if (!isMissingPathError(error)) {
          throw error;
        }
        return join(realCurrent, ...segments.slice(i));
      }

      const realNext = realpathSync(lexicalNext);
      const realRelative = relative(realWorktree, realNext);
      if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
        return realNext;
      }

      lexicalCurrent = lexicalNext;
      realCurrent = realNext;
    }

    return realCurrent;
  }
}

/** 只有明确的 ENOENT 才表示可创建的新路径段。 */
function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
