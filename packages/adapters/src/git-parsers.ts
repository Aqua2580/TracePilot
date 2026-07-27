/**
 * git 输出解析器 —— Phase 3 任务 4。
 *
 * 纯字符串解析函数，无外部依赖。LocalGitAdapter 调用 git 命令后，
 * 把 stdout 交给这些解析器转换为结构化证据。
 *
 * 格式约定（见任务 4 规格）：
 * - `git log`：LocalGitAdapter 调用 `git log --format=%H%x1f%an%x1f%aI%x1f%s%x1e`
 *   （`\x1f` 单元分隔符分字段，`\x1e` 记录分隔符分 commit）。files 字段
 *   由调用方按需单独获取，parser 默认填充空数组。
 * - `git blame`：使用 `--line-porcelain` 输出格式。
 * - `git diff --name-only`：每行一个相对路径。
 * - `git status --porcelain`：输出为空表示干净。
 */

import type { GitEvidence, BlameEvidence } from "@tracepilot/core";

// 控制字符常量，提升可读性。
const UNIT_SEPARATOR = "\x1f"; // 字段分隔符
const RECORD_SEPARATOR = "\x1e"; // 记录分隔符

/**
 * 解析 `git log --format=%H%x1f%an%x1f%aI%x1f%s%x1e` 的输出。
 *
 * 每个 commit 用 `\x1e` 分隔，commit 内字段用 `\x1f` 分隔。
 * files 字段默认为空数组，由 LocalGitAdapter 在需要时单独调用
 * `git show --name-only` 填充。
 */
export function parseGitLog(stdout: string): GitEvidence[] {
  if (!stdout) return [];
  const records = stdout.split(RECORD_SEPARATOR);
  const results: GitEvidence[] = [];
  for (const record of records) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(UNIT_SEPARATOR);
    if (fields.length < 4) continue;
    const commitSha = fields[0] ?? "";
    const author = fields[1] ?? "";
    const authoredAt = fields[2] ?? "";
    const message = fields[3] ?? "";
    // 缺少 commitSha 视为无效记录，跳过。
    if (!commitSha) continue;
    results.push({
      commitSha,
      author,
      authoredAt,
      message,
      files: []
    });
  }
  return results;
}

/**
 * 解析 `git blame --line-porcelain` 输出。
 *
 * 格式（每个被 blame 的行都重复完整 header）：
 * ```
 * <commitSha> <origLine> <finalLine>
 * author <author>
 * author-mail <<email>>
 * author-time <unixTimestamp>
 * author-tz <+0000>
 * summary <summary>
 * \t<lineContent>
 * ```
 *
 * 连续相同 commitSha 的条目聚合为一个 BlameEvidence，
 * lineRange=[首行, 末行]，lineContent 保留该 range 第一行内容。
 *
 * authoredAt 简化处理：用 `new Date(unixSeconds * 1000).toISOString()`
 * 转换为 ISO 8601（按 UTC，忽略 author-tz）。
 */
export function parseGitBlame(stdout: string): BlameEvidence[] {
  if (!stdout || !stdout.trim()) return [];
  const lines = stdout.split(/\r?\n/);

  // 第一阶段：逐条解析为扁平条目。
  interface BlameEntry {
    readonly commitSha: string;
    readonly author: string;
    readonly authoredAt: string;
    readonly finalLine: number;
    readonly lineContent: string;
  }
  const entries: BlameEntry[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // 匹配 `<commitSha> <origLine> <finalLine>` 起始行。
    const match = /^([0-9a-f]+) (\d+) (\d+)$/.exec(line);
    if (!match) {
      i++;
      continue;
    }
    const commitSha = match[1]!;
    const finalLine = parseInt(match[3]!, 10);

    // 收集 header 行，直到遇到 `\t` 开头的内容行。
    let author = "";
    let authorTime = 0;
    let lineContent = "";
    i++;
    while (i < lines.length) {
      const hline = lines[i]!;
      // 内容行以 Tab 开头，取 Tab 之后的部分。
      if (hline.startsWith("\t")) {
        lineContent = hline.slice(1);
        i++;
        break;
      }
      // 遇到下一个条目的起始行，提前退出（防御性：内容行缺失）。
      const nextMatch = /^([0-9a-f]+) (\d+) (\d+)$/.exec(hline);
      if (nextMatch) {
        break;
      }
      if (hline.startsWith("author ")) {
        author = hline.slice("author ".length);
      } else if (hline.startsWith("author-time ")) {
        // parseInt 失败返回 NaN，用 || 0 兜底为 0。
        authorTime = parseInt(hline.slice("author-time ".length), 10) || 0;
      }
      // author-mail / author-tz / summary 等行不解析，跳过。
      i++;
    }

    entries.push({
      commitSha,
      author,
      authoredAt: new Date(authorTime * 1000).toISOString(),
      finalLine,
      lineContent
    });
  }

  // 第二阶段：聚合连续相同 commitSha 的条目。
  const aggregated: BlameEvidence[] = [];
  for (const entry of entries) {
    const last = aggregated[aggregated.length - 1];
    if (last && last.commitSha === entry.commitSha) {
      // 连续相同 commitSha，扩展 lineRange 末行。
      aggregated[aggregated.length - 1] = {
        commitSha: last.commitSha,
        author: last.author,
        authoredAt: last.authoredAt,
        lineRange: [last.lineRange[0], entry.finalLine],
        lineContent: last.lineContent
      };
    } else {
      aggregated.push({
        commitSha: entry.commitSha,
        author: entry.author,
        authoredAt: entry.authoredAt,
        lineRange: [entry.finalLine, entry.finalLine],
        lineContent: entry.lineContent
      });
    }
  }

  return aggregated;
}

/**
 * 解析 `git diff --name-only` 输出，提取变更文件相对路径。
 *
 * 每行一个路径，过滤空行。兼容 `\r\n` 与 `\n` 行尾。
 */
export function parseGitDiffChangedFiles(stdout: string): string[] {
  if (!stdout) return [];
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

/**
 * 解析 `git status --porcelain` 输出，返回 `isClean`。
 *
 * 输出为空或仅空白 → 仓库干净（true）；否则有未提交改动（false）。
 */
export function parseGitStatusPorcelain(stdout: string): boolean {
  return stdout.trim().length === 0;
}
