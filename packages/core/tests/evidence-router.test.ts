import { describe, expect, it } from "vitest";
import {
  EvidenceRouter,
  type EvidenceRequestSpec,
  type TaskInput
} from "../src/index.js";

function makeFailedTestInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    objective: "修复失败的 pytest 用例 test_users_create",
    constraints: ["不得修改 /api/users 的公开 API"],
    acceptanceCriteria: ["pytest tests/test_users.py 通过"],
    riskLevel: "low",
    rawSource: "FAILED test_users_create::test_returns_201 ...",
    origin: "failed_test_log",
    failure: {
      testNames: [
        "tests/test_users.py::test_create",
        "tests/test_users.py::test_update"
      ],
      errorTypes: ["AssertionError"],
      stackSummary: "assert response.status == 201, got 400"
    },
    ...overrides
  };
}

function makeIssueInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    objective: "Add user authentication endpoint with JWT tokens",
    constraints: ["Must not break existing API"],
    acceptanceCriteria: ["Auth endpoint returns 200"],
    riskLevel: "medium",
    rawSource: "issue-42",
    origin: "issue",
    ...overrides
  };
}

describe("EvidenceRouter（§8.1 步骤 2）", () => {
  const router = new EvidenceRouter();

  describe("origin=failed_test_log 且有 testNames", () => {
    it("输出 code/git/runtime/memory/policy 五类，顺序固定", () => {
      const specs = router.route(makeFailedTestInput());
      const kinds = specs.map((s) => s.kind);

      expect(kinds).toEqual(["code", "git", "runtime", "memory", "policy"]);
    });

    it("code 请求的 source 为 code-search，allowedScope 涵盖 worktree 内 test 文件", () => {
      const specs = router.route(makeFailedTestInput());
      const code = specs.find((s) => s.kind === "code");

      expect(code?.source).toBe("code-search");
      expect(code?.allowedScope).toBe("worktree 内 test 文件及被测代码");
    });

    it("runtime 请求的 locator 包含 testNames 列表", () => {
      const specs = router.route(makeFailedTestInput());
      const runtime = specs.find((s) => s.kind === "runtime");

      expect(runtime?.source).toBe("test-runner");
      expect(runtime?.locator).toContain("tests/test_users.py::test_create");
      expect(runtime?.locator).toContain("tests/test_users.py::test_update");
    });

    it("memory 请求的 locator 使用 stackSummary 作为 symptom", () => {
      const specs = router.route(makeFailedTestInput());
      const memory = specs.find((s) => s.kind === "memory");

      expect(memory?.source).toBe("sqlite-memory");
      expect(memory?.locator).toBe("assert response.status == 201, got 400");
    });

    it("policy 请求的 locator 包含 constraints 列表", () => {
      const specs = router.route(makeFailedTestInput());
      const policy = specs.find((s) => s.kind === "policy");

      expect(policy?.source).toBe("project-constraints");
      expect(policy?.locator).toContain("不得修改 /api/users 的公开 API");
    });

    it("code locator 从 testName 解析出 test 文件路径（tests/test_users.py::test_create → tests/test_users.py）", () => {
      const specs = router.route(makeFailedTestInput());
      const code = specs.find((s) => s.kind === "code");

      // 同一文件的多个测试去重后只出现一次
      expect(code?.locator).toBe("tests/test_users.py");
    });

    it("git 请求的 locator 同样使用 test 文件路径", () => {
      const specs = router.route(makeFailedTestInput());
      const git = specs.find((s) => s.kind === "git");

      expect(git?.source).toBe("git-history");
      expect(git?.locator).toBe("tests/test_users.py");
    });
  });

  describe("origin=failed_test_log 但 failure 为空", () => {
    it("fallback 用 objective 作为 memory symptom", () => {
      const input = makeFailedTestInput({ failure: undefined });
      const specs = router.route(input);
      const memory = specs.find((s) => s.kind === "memory");

      expect(memory?.locator).toBe(input.objective);
    });

    it("仍输出五类请求（含 runtime）", () => {
      const input = makeFailedTestInput({ failure: undefined });
      const specs = router.route(input);
      const kinds = specs.map((s) => s.kind);

      expect(kinds).toEqual(["code", "git", "runtime", "memory", "policy"]);
    });

    it("testNames 为空数组时也走 fallback 路径", () => {
      const input = makeFailedTestInput({
        failure: {
          testNames: [],
          errorTypes: [],
          stackSummary: ""
        }
      });
      const specs = router.route(input);
      const memory = specs.find((s) => s.kind === "memory");

      // testNames 为空时走 fallback，memory locator 使用 objective
      expect(memory?.locator).toBe(input.objective);
    });
  });

  describe("origin=issue", () => {
    it("输出 code/git/memory/policy 四类，不含 runtime", () => {
      const specs = router.route(makeIssueInput());
      const kinds = specs.map((s) => s.kind);

      expect(kinds).toEqual(["code", "git", "memory", "policy"]);
      expect(kinds).not.toContain("runtime");
    });

    it("code 请求的 locator 为从 objective 提取的关键词", () => {
      const specs = router.route(makeIssueInput());
      const code = specs.find((s) => s.kind === "code");

      // "Add user authentication endpoint with JWT tokens"
      // 分词后过滤停用词 "with"，取前 5 个
      expect(code?.locator).toBe("add, user, authentication, endpoint, jwt");
    });

    it("memory 请求的 locator 使用 objective 原文", () => {
      const specs = router.route(makeIssueInput());
      const memory = specs.find((s) => s.kind === "memory");

      expect(memory?.locator).toBe(
        "Add user authentication endpoint with JWT tokens"
      );
    });

    it("code allowedScope 为 worktree 内代码", () => {
      const specs = router.route(makeIssueInput());
      const code = specs.find((s) => s.kind === "code");

      expect(code?.allowedScope).toBe("worktree 内代码");
    });

    it("关键词超过 5 个时只取前 5 个", () => {
      const input = makeIssueInput({
        objective: "alpha beta gamma delta epsilon zeta eta theta"
      });
      const specs = router.route(input);
      const code = specs.find((s) => s.kind === "code");

      const keywords = code?.locator.split(", ") ?? [];
      expect(keywords).toHaveLength(5);
      expect(keywords).toEqual([
        "alpha", "beta", "gamma", "delta", "epsilon"
      ]);
    });
  });

  describe("确定性", () => {
    it("同一 TaskInput 两次 route 输出完全相同", () => {
      const input = makeFailedTestInput();
      const first: EvidenceRequestSpec[] = router.route(input);
      const second: EvidenceRequestSpec[] = router.route(input);

      expect(second).toEqual(first);
    });

    it("issue 输入两次 route 输出完全相同", () => {
      const input = makeIssueInput();
      const first = router.route(input);
      const second = router.route(input);

      expect(second).toEqual(first);
    });

    it("fallback 输入两次 route 输出完全相同", () => {
      const input = makeFailedTestInput({ failure: undefined });
      const first = router.route(input);
      const second = router.route(input);

      expect(second).toEqual(first);
    });
  });
});
