/**
 * PathPolicy — §7.2。
 *
 * 将 `unresolvedPath` 解析为 real path，并验证它位于
 * `roots` 之一内部。拒绝路径穿越（`..`）和 symlink 逃逸。real path
 * 会在决策中返回，以便 orchestrator 在后续操作中
 * 使用而无需重新解析。
 *
 * 使用 `node:path` 和 `node:fs` —— 两者均为 Node 内置模块，非外部 SDK，
 * 因此与 §3 的依赖方向保持一致。
 */

import { resolve, relative, isAbsolute, sep } from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import type { PathPolicy, PathPolicyDecision } from "@tracepilot/core";

export class DefaultPathPolicy implements PathPolicy {
  decide(unresolvedPath: string, roots: readonly string[]): PathPolicyDecision {
    if (!unresolvedPath || typeof unresolvedPath !== "string") {
      return { allowed: false, reason: "path must be a non-empty string" };
    }
    if (!isAbsolute(unresolvedPath)) {
      // 相对路径必须由调用方先针对某个 root 解析。
      // 我们拒绝猜测应绑定到哪个 root。
      return {
        allowed: false,
        reason: "relative paths must be resolved against a root before policy check"
      };
    }
    if (roots.length === 0) {
      return { allowed: false, reason: "no allowed roots provided" };
    }

    // 在接触文件系统之前先拒绝明显的穿越。
    if (unresolvedPath.includes("..")) {
      // ".." 在绝对路径中只有在解析后的 real path
      // 仍然落在某个 root 内时才是合法的。我们在下方交由 realpath 处理；
      // 但若字面路径逃出了所有 root，则在此提前拒绝。
      const normalised = resolve(unresolvedPath);
      let escapes = true;
      for (const root of roots) {
        if (isInside(normalised, root)) {
          escapes = false;
          break;
        }
      }
      if (escapes) {
        return {
          allowed: false,
          reason: `path traversal escapes all roots: ${unresolvedPath}`
        };
      }
    }

    // 解析 real path，跟随 symlink。如果路径不存在，
    // 我们仍然解析父目录并对其进行检查。
    let resolved: string;
    try {
      resolved = realpathSafe(unresolvedPath);
    } catch (err) {
      return {
        allowed: false,
        reason: `cannot resolve real path: ${(err as Error).message}`
      };
    }

    for (const root of roots) {
      let resolvedRoot: string;
      try {
        resolvedRoot = realpathSafe(root);
      } catch {
        // 如果某个 root 不存在，跳过它 —— 它不可能包含任何内容。
        continue;
      }
      if (isInside(resolved, resolvedRoot)) {
        return {
          allowed: true,
          reason: `path lies inside root ${resolvedRoot}`,
          resolvedPath: resolved
        };
      }
    }

    // Symlink 逃逸检查：即使未解析路径看起来在某个 root 内，
    // real path 也可能指向外部。我们在上面已经验证
    // real path 是否在某个 root 内；如果执行到这里，说明不在。
    return {
      allowed: false,
      reason: `resolved real path ${resolved} is outside all roots (possible symlink escape)`
    };
  }
}

/**
 * 若 `candidate` 等于 `root` 或是 `root` 的后代则返回 true。
 * 使用路径组件比较，而非字符串前缀，因此 `/foo/bar` 不算
 * 位于 `/foo/b` 内部。
 */
function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  if (rel === "") return true;
  // 如果相对路径以 ".." 开头或是绝对路径（Windows
  // 盘符切换），则 candidate 在 root 之外。
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * realpath 的回退实现：如果目标不存在，则向上走到
 * 最近的存在的祖先，解析它，再重新拼接缺失的尾部。
 * 这让我们能够验证尚未创建的文件路径
 * （例如 Developer 即将写入 worktree 内的文件）。
 */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // 向上走。
    let existingAncestor = p;
    const missingTail: string[] = [];
    while (existingAncestor && existingAncestor !== sep && existingAncestor !== ".") {
      try {
        const real = realpathSync(existingAncestor);
        return missingTail.length === 0
          ? real
          : [real, ...missingTail].join(sep);
      } catch {
        missingTail.unshift(existingAncestor.split(sep).pop() ?? "");
        const idx = existingAncestor.lastIndexOf(sep);
        if (idx <= 0) break;
        existingAncestor = existingAncestor.slice(0, idx);
      }
    }
    throw new Error(`无法解析真实路径：${p}`);
  }
}

// 抑制 lstatSync 的未使用导入告警 —— 保留以备将来
// 逐组件 symlink 检查使用。
void lstatSync;
