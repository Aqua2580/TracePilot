/**
 * EvidenceRouter 领域服务 —— 见规格 §8.1 步骤 2、§5.3。
 *
 * 纯函数式路由器：根据 TaskInput 的来源与失败元数据，按确定性规则
 * 产出对各类证据的请求规格（EvidenceRequestSpec）。Router 不依赖任何
 * Adapter、不执行 I/O、不引入随机性或时间戳 —— 同一 TaskInput 永远
 * 产出完全相同的请求列表。
 *
 * 输出顺序固定：code → git → runtime（仅 failed_test_log）→ memory → policy。
 * 该顺序由 §8.1 步骤 2 的“代码、Git、运行时和历史经验”推导而来。
 */

import type { TaskInput } from "../domain/task.js";
import type { EvidenceKind } from "../domain/evidence.js";

/**
 * 对一类证据的请求规格（纯数据）。
 * 描述需要哪类证据、从哪里取、允许查询范围以及为什么需要。
 */
export interface EvidenceRequestSpec {
  readonly kind: EvidenceKind;
  /** 来源名称，如 "code-search"、"git-history"、"sqlite-memory"。 */
  readonly source: string;
  /** 定位参数，如 test 文件名、objective 关键词。 */
  readonly locator: string;
  /** 允许查询范围描述。 */
  readonly allowedScope: string;
  /** 为什么需要这类证据。 */
  readonly reason: string;
}

/** 常见英文停用词，分词时过滤。 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "of", "for", "with", "to", "in", "on",
  "and", "or", "is", "are", "fix", "bug", "test", "tests"
]);

/** 从 objective 文本中提取前 5 个非停用词作为关键词。 */
function tokenizeKeywords(text: string): string[] {
  // 按空格与标点分割（Unicode 感知）。
  const tokens = text.split(/[\s\p{P}]+/u).filter((t) => t.length > 0);
  const result: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.length < 3) continue;
    if (STOP_WORDS.has(lower)) continue;
    result.push(lower);
    if (result.length >= 5) break;
  }
  return result;
}

/**
 * 从 testName 提取文件路径。
 * pytest 风格 "tests/test_users.py::test_create" → "tests/test_users.py"；
 * 不含 "::" 时原样返回。
 */
function extractFilePath(testName: string): string {
  const idx = testName.indexOf("::");
  return idx >= 0 ? testName.slice(0, idx) : testName;
}

/** 从 testNames 列表提取去重后的文件路径。 */
function extractFilePaths(testNames: readonly string[]): string[] {
  const paths = testNames.map(extractFilePath);
  return [...new Set(paths)];
}

/** 将字符串列表拼接为定位字符串。 */
function joinList(items: readonly string[]): string {
  return items.join(", ");
}

/**
 * 证据路由器。根据 TaskInput 产出确定性的 EvidenceRequestSpec 列表。
 *
 * 路由规则：
 * - origin="failed_test_log" 且 failure.testNames 非空：5 类（code/git/runtime/memory/policy），
 *   locator 基于 testNames 与 stackSummary。
 * - origin="failed_test_log" 但 failure 缺失或 testNames 为空：仍输出 5 类，
 *   但 locator 回退为 objective（symptom 用 objective）。
 * - origin="issue"：4 类（code/git/memory/policy，不含 runtime），
 *   locator 基于 objective 关键词。
 */
export class EvidenceRouter {
  /**
   * 根据 TaskInput 路由产出证据请求规格列表。
   * 纯函数：同一输入永远产出同一输出。
   */
  route(taskInput: TaskInput): EvidenceRequestSpec[] {
    if (taskInput.origin === "failed_test_log") {
      const testNames = taskInput.failure?.testNames ?? [];
      if (testNames.length > 0) {
        return this.routeFailedTestWithNames(taskInput, testNames);
      }
      return this.routeFailedTestFallback(taskInput);
    }
    return this.routeIssue(taskInput);
  }

  /** failed_test_log 且有 testNames：基于测试名定位代码与运行时证据。 */
  private routeFailedTestWithNames(
    taskInput: TaskInput,
    testNames: readonly string[]
  ): EvidenceRequestSpec[] {
    const filePaths = extractFilePaths(testNames);
    const fileLocator = joinList(filePaths);
    const testNamesLocator = joinList(testNames);
    const symptom = taskInput.failure?.stackSummary ?? taskInput.objective;
    const constraintsLocator = joinList(taskInput.constraints);

    return [
      {
        kind: "code",
        source: "code-search",
        locator: fileLocator,
        allowedScope: "worktree 内 test 文件及被测代码",
        reason: "定位失败测试涉及的源码与测试文件"
      },
      {
        kind: "git",
        source: "git-history",
        locator: fileLocator,
        allowedScope: "仓库历史",
        reason: "检查测试文件的近期变更是否引入回归"
      },
      {
        kind: "runtime",
        source: "test-runner",
        locator: testNamesLocator,
        allowedScope: "运行测试捕获堆栈",
        reason: "复现失败并捕获运行时堆栈"
      },
      {
        kind: "memory",
        source: "sqlite-memory",
        locator: symptom,
        allowedScope: "项目级 Repair Memory",
        reason: "匹配历史修复经验中的相同症状"
      },
      {
        kind: "policy",
        source: "project-constraints",
        locator: constraintsLocator,
        allowedScope: "项目约束",
        reason: "确认修复不得违反的项目约束"
      }
    ];
  }

  /** failed_test_log 但无 testNames：回退用 objective 作为 symptom。 */
  private routeFailedTestFallback(taskInput: TaskInput): EvidenceRequestSpec[] {
    const keywords = tokenizeKeywords(taskInput.objective);
    const keywordLocator = joinList(keywords);
    const constraintsLocator = joinList(taskInput.constraints);

    return [
      {
        kind: "code",
        source: "code-search",
        locator: keywordLocator,
        allowedScope: "worktree 内 test 文件及被测代码",
        reason: "基于目标关键词定位相关源码"
      },
      {
        kind: "git",
        source: "git-history",
        locator: "最近 N 条历史",
        allowedScope: "仓库历史",
        reason: "检查近期变更是否引入回归"
      },
      {
        kind: "runtime",
        source: "test-runner",
        locator: taskInput.objective,
        allowedScope: "运行测试捕获堆栈",
        reason: "复现失败并捕获运行时堆栈"
      },
      {
        kind: "memory",
        source: "sqlite-memory",
        locator: taskInput.objective,
        allowedScope: "项目级 Repair Memory",
        reason: "用目标文本作为症状匹配历史修复经验"
      },
      {
        kind: "policy",
        source: "project-constraints",
        locator: constraintsLocator,
        allowedScope: "项目约束",
        reason: "确认修复不得违反的项目约束"
      }
    ];
  }

  /** issue 来源：不含 runtime，共 4 类。 */
  private routeIssue(taskInput: TaskInput): EvidenceRequestSpec[] {
    const keywords = tokenizeKeywords(taskInput.objective);
    const keywordLocator = joinList(keywords);
    const constraintsLocator = joinList(taskInput.constraints);

    return [
      {
        kind: "code",
        source: "code-search",
        locator: keywordLocator,
        allowedScope: "worktree 内代码",
        reason: "基于目标关键词定位相关源码"
      },
      {
        kind: "git",
        source: "git-history",
        locator: "最近 N 条历史",
        allowedScope: "仓库历史",
        reason: "了解相关代码的近期变更上下文"
      },
      {
        kind: "memory",
        source: "sqlite-memory",
        locator: taskInput.objective,
        allowedScope: "项目级 Repair Memory",
        reason: "匹配与目标相关的历史修复经验"
      },
      {
        kind: "policy",
        source: "project-constraints",
        locator: constraintsLocator,
        allowedScope: "项目约束",
        reason: "确认方案不得违反的项目约束"
      }
    ];
  }
}
