/**
 * git 输出解析器单元测试 —— Phase 3 任务 4。
 *
 * 覆盖 parseGitLog / parseGitBlame / parseGitDiffChangedFiles /
 * parseGitStatusPorcelain 的正常、边界与中文场景。
 */

import { describe, expect, it } from "vitest";
import {
  parseGitLog,
  parseGitBlame,
  parseGitDiffChangedFiles,
  parseGitStatusPorcelain
} from "../src/git-parsers.js";

// 控制字符常量，与 git-parsers.ts 保持一致，便于构造测试输入。
const US = "\x1f"; // 字段分隔符
const RS = "\x1e"; // 记录分隔符

describe("parseGitLog", () => {
  it("解析多个 commit 的输出", () => {
    const stdout = [
      `abc123${US}张三${US}2026-07-01T10:00:00+08:00${US}首次提交${RS}`,
      `def456${US}李四${US}2026-07-02T11:30:00+08:00${US}修复 bug${RS}`
    ].join("\n");
    const result = parseGitLog(stdout);
    expect(result).toHaveLength(2);
    expect(result[0]!.commitSha).toBe("abc123");
    expect(result[0]!.author).toBe("张三");
    expect(result[0]!.authoredAt).toBe("2026-07-01T10:00:00+08:00");
    expect(result[0]!.message).toBe("首次提交");
    expect(result[0]!.files).toEqual([]);
    expect(result[1]!.commitSha).toBe("def456");
    expect(result[1]!.message).toBe("修复 bug");
  });

  it("空输出返回空数组", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog("   ")).toEqual([]);
  });

  it("含中文 message 正确解析", () => {
    const stdout = `abc123${US}王五${US}2026-07-03T00:00:00Z${US}中文：修复【特殊】字符 & 符号${RS}`;
    const result = parseGitLog(stdout);
    expect(result).toHaveLength(1);
    expect(result[0]!.message).toBe("中文：修复【特殊】字符 & 符号");
    expect(result[0]!.author).toBe("王五");
  });

  it("忽略字段不足的无效记录", () => {
    // 缺少字段的记录应被跳过，不抛错。
    const stdout = `abc123${US}author${RS}def456${US}李四${US}2026-07-01T00:00:00Z${US}ok${RS}`;
    const result = parseGitLog(stdout);
    expect(result).toHaveLength(1);
    expect(result[0]!.commitSha).toBe("def456");
  });

  it("files 字段默认为空数组", () => {
    const stdout = `abc123${US}author${US}2026-07-01T00:00:00Z${US}msg${RS}`;
    const result = parseGitLog(stdout);
    expect(result[0]!.files).toEqual([]);
  });
});

describe("parseGitBlame", () => {
  it("解析多行输出并聚合连续相同 commit", () => {
    // 构造 --line-porcelain 输出：两行来自 abc123，一行来自 def456。
    const stdout = [
      "abc123 1 1",
      "author 张三",
      "author-mail <zhang@example.com>",
      "author-time 1751328000",
      "author-tz +0800",
      "summary 首次提交",
      "\t第一行内容",
      "abc123 2 2",
      "author 张三",
      "author-mail <zhang@example.com>",
      "author-time 1751328000",
      "author-tz +0800",
      "summary 首次提交",
      "\t第二行内容",
      "def456 3 3",
      "author 李四",
      "author-mail <li@example.com>",
      "author-time 1751414400",
      "author-tz +0800",
      "summary 修复",
      "\t第三行内容"
    ].join("\n");
    const result = parseGitBlame(stdout);
    expect(result).toHaveLength(2);
    // 第一段：abc123 聚合为 [1,2]
    expect(result[0]!.commitSha).toBe("abc123");
    expect(result[0]!.author).toBe("张三");
    expect(result[0]!.lineRange).toEqual([1, 2]);
    expect(result[0]!.lineContent).toBe("第一行内容");
    // authoredAt 由 unix 时间戳 1751328000 转换为 ISO 8601（UTC）
    expect(result[0]!.authoredAt).toBe(new Date(1751328000 * 1000).toISOString());
    // 第二段：def456 单行 [3,3]
    expect(result[1]!.commitSha).toBe("def456");
    expect(result[1]!.author).toBe("李四");
    expect(result[1]!.lineRange).toEqual([3, 3]);
    expect(result[1]!.lineContent).toBe("第三行内容");
  });

  it("解析单行输出", () => {
    const stdout = [
      "abc123 1 1",
      "author 张三",
      "author-mail <zhang@example.com>",
      "author-time 1751328000",
      "author-tz +0000",
      "summary 单行",
      "\t唯一一行"
    ].join("\n");
    const result = parseGitBlame(stdout);
    expect(result).toHaveLength(1);
    expect(result[0]!.lineRange).toEqual([1, 1]);
    expect(result[0]!.lineContent).toBe("唯一一行");
  });

  it("空输出返回空数组", () => {
    expect(parseGitBlame("")).toEqual([]);
    expect(parseGitBlame("   \n  ")).toEqual([]);
  });

  it("同 commit 连续行聚合为 lineRange", () => {
    // 三行连续来自同一 commit，应聚合为 [1,3]。
    const stdout = [
      "abc123 1 1", "author A", "author-mail <a@x>", "author-time 100",
      "author-tz +0000", "summary s", "\tline1",
      "abc123 2 2", "author A", "author-mail <a@x>", "author-time 100",
      "author-tz +0000", "summary s", "\tline2",
      "abc123 3 3", "author A", "author-mail <a@x>", "author-time 100",
      "author-tz +0000", "summary s", "\tline3"
    ].join("\n");
    const result = parseGitBlame(stdout);
    expect(result).toHaveLength(1);
    expect(result[0]!.lineRange).toEqual([1, 3]);
    // lineContent 保留 range 第一行内容。
    expect(result[0]!.lineContent).toBe("line1");
  });

  it("非连续的相同 commit 不合并", () => {
    // abc123, def456, abc123 —— 首尾虽同 commit 但中间被隔开，不合并。
    const stdout = [
      "abc123 1 1", "author A", "author-mail <a@x>", "author-time 100",
      "author-tz +0000", "summary s", "\tline1",
      "def456 2 2", "author B", "author-mail <b@x>", "author-time 200",
      "author-tz +0000", "summary s", "\tline2",
      "abc123 3 3", "author A", "author-mail <a@x>", "author-time 100",
      "author-tz +0000", "summary s", "\tline3"
    ].join("\n");
    const result = parseGitBlame(stdout);
    expect(result).toHaveLength(3);
    expect(result[0]!.lineRange).toEqual([1, 1]);
    expect(result[1]!.lineRange).toEqual([2, 2]);
    expect(result[2]!.lineRange).toEqual([3, 3]);
  });

  it("author-time 为 0 时转换为 epoch ISO 时间", () => {
    const stdout = [
      "0000000000000000000000000000000000000000 1 1",
      "author Nobody",
      "author-mail <nobody@example.com>",
      "author-time 0",
      "author-tz +0000",
      "summary 未提交",
      "\tuncommitted line"
    ].join("\n");
    const result = parseGitBlame(stdout);
    expect(result).toHaveLength(1);
    expect(result[0]!.authoredAt).toBe("1970-01-01T00:00:00.000Z");
    expect(result[0]!.commitSha).toBe("0000000000000000000000000000000000000000");
  });
});

describe("parseGitDiffChangedFiles", () => {
  it("解析多个文件路径", () => {
    const stdout = "src/index.ts\nsrc/utils.ts\nREADME.md\n";
    const result = parseGitDiffChangedFiles(stdout);
    expect(result).toEqual(["src/index.ts", "src/utils.ts", "README.md"]);
  });

  it("空输出返回空数组", () => {
    expect(parseGitDiffChangedFiles("")).toEqual([]);
    expect(parseGitDiffChangedFiles("\n\n")).toEqual([]);
  });

  it("含中文文件名正确解析", () => {
    const stdout = "src/工具.ts\n测试/用例.ts\n";
    const result = parseGitDiffChangedFiles(stdout);
    expect(result).toEqual(["src/工具.ts", "测试/用例.ts"]);
  });

  it("兼容 CRLF 行尾", () => {
    const stdout = "src/a.ts\r\nsrc/b.ts\r\n";
    const result = parseGitDiffChangedFiles(stdout);
    expect(result).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("parseGitStatusPorcelain", () => {
  it("空输出返回 true（仓库干净）", () => {
    expect(parseGitStatusPorcelain("")).toBe(true);
    expect(parseGitStatusPorcelain("   ")).toBe(true);
    expect(parseGitStatusPorcelain("\n")).toBe(true);
  });

  it("有内容返回 false（仓库不干净）", () => {
    expect(parseGitStatusPorcelain(" M src/index.ts\n")).toBe(false);
    expect(parseGitStatusPorcelain("?? src/new.ts\n")).toBe(false);
    expect(parseGitStatusPorcelain("A  src/added.ts\n")).toBe(false);
  });

  it("多行改动返回 false", () => {
    const stdout = " M src/a.ts\n M src/b.ts\n?? src/c.ts\n";
    expect(parseGitStatusPorcelain(stdout)).toBe(false);
  });
});
