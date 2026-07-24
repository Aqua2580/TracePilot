/**
 * 固定基准任务 fixtures —— Phase 2 退出条件（§9）。
 *
 * 每个基准任务定义：TaskInput + 期望的 Evidence Pack 结构 + 期望的 Plan 结构。
 * Fake Adapter 闭环测试验证：相同输入始终产出相同结构的 Pack/计划/审计。
 *
 * 基准任务覆盖：
 * 1. pytest AssertionError（Python，low risk）
 * 2. pytest ImportError（Python，medium risk）
 * 3. Vitest 断言失败（TypeScript，low risk）
 * 4. Jest mock 缺失（TypeScript，medium risk）
 * 5. pytest 超时（Python，high risk）
 * 6. Issue 结构化输入（Python，low risk）
 * 7. pytest 多文件失败（Python，medium risk）
 * 8. Vitest 快照不匹配（TypeScript，low risk）
 */

import type { TaskInput, EvidencePack, EvidenceItem, Plan, PlanNode } from "@tracepilot/core";
import { computePackContentHash, randomId } from "@tracepilot/core";

export interface BenchmarkFixture {
  readonly id: string;
  readonly description: string;
  readonly taskInput: TaskInput;
  readonly expectedEvidenceCount: number;
  readonly expectedPlanNodeCount: number;
}

/** 8 个固定基准任务。 */
export const BENCHMARK_FIXTURES: readonly BenchmarkFixture[] = [
  {
    id: "bench-01-pytest-assertion",
    description: "pytest AssertionError：用户创建接口返回 400 而非 201",
    taskInput: {
      objective: "修复 test_users_create 返回 400 而非 201",
      constraints: ["不得修改 /api/users 的公开 API"],
      acceptanceCriteria: ["pytest tests/test_users.py 通过"],
      riskLevel: "low",
      rawSource: "FAILED test_users_create::test_returns_201 - assert 400 == 201",
      origin: "failed_test_log",
      failure: {
        testNames: ["test_users_create::test_returns_201"],
        errorTypes: ["AssertionError"],
        stackSummary: "assert response.status == 201, got 400"
      }
    },
    expectedEvidenceCount: 3,
    expectedPlanNodeCount: 4
  },
  {
    id: "bench-02-pytest-import",
    description: "pytest ImportError：模块路径变更导致导入失败",
    taskInput: {
      objective: "修复 services.auth 模块导入失败",
      constraints: ["保持向后兼容的公共导出"],
      acceptanceCriteria: ["pytest tests/test_auth.py 通过"],
      riskLevel: "medium",
      rawSource: "ERROR tests/test_auth.py - ImportError: cannot import name 'AuthService' from 'services.auth'",
      origin: "failed_test_log",
      failure: {
        testNames: ["tests/test_auth.py"],
        errorTypes: ["ImportError"],
        stackSummary: "cannot import name 'AuthService' from 'services.auth'"
      }
    },
    expectedEvidenceCount: 3,
    expectedPlanNodeCount: 4
  },
  {
    id: "bench-03-vitest-assertion",
    description: "Vitest 断言失败：组件未渲染预期文本",
    taskInput: {
      objective: "修复 UserCard 组件未渲染用户名",
      constraints: ["不得改变组件 props 接口"],
      acceptanceCriteria: ["vitest run src/components/UserCard.test.tsx 通过"],
      riskLevel: "low",
      rawSource: "FAIL UserCard.test.tsx > renders username\nExpected: 'Alice'\nReceived: ''",
      origin: "failed_test_log",
      failure: {
        testNames: ["UserCard.test.tsx::renders username"],
        errorTypes: ["AssertionError"],
        stackSummary: "Expected: 'Alice', Received: ''"
      }
    },
    expectedEvidenceCount: 3,
    expectedPlanNodeCount: 4
  },
  {
    id: "bench-04-jest-mock-missing",
    description: "Jest mock 缺失：API 调用未正确 mock",
    taskInput: {
      objective: "修复 fetchUser API 调用未 mock 导致的测试失败",
      constraints: ["不得发起真实网络请求"],
      acceptanceCriteria: ["jest src/api/user.test.ts 通过"],
      riskLevel: "medium",
      rawSource: "FAIL user.test.ts > fetchUser returns user\nTypeError: fetch is not a function",
      origin: "failed_test_log",
      failure: {
        testNames: ["user.test.ts::fetchUser returns user"],
        errorTypes: ["TypeError"],
        stackSummary: "TypeError: fetch is not a function"
      }
    },
    expectedEvidenceCount: 3,
    expectedPlanNodeCount: 4
  },
  {
    id: "bench-05-pytest-timeout",
    description: "pytest 超时：数据库查询耗时过长",
    taskInput: {
      objective: "修复 test_slow_query 超时失败",
      constraints: ["不得移除超时断言"],
      acceptanceCriteria: ["pytest tests/test_db.py::test_slow_query 通过，执行时间 < 2s"],
      riskLevel: "high",
      rawSource: "FAIL test_slow_query - TimeoutError: query took 5.2s, limit 2s",
      origin: "failed_test_log",
      failure: {
        testNames: ["test_slow_query"],
        errorTypes: ["TimeoutError"],
        stackSummary: "query took 5.2s, limit 2s"
      }
    },
    expectedEvidenceCount: 3,
    expectedPlanNodeCount: 4
  },
  {
    id: "bench-06-issue-structured",
    description: "Issue 结构化输入：登录页面 CSS 错位",
    taskInput: {
      objective: "修复登录页面在移动端按钮错位",
      constraints: ["不得改变按钮文案"],
      acceptanceCriteria: ["移动端 375px 视口下按钮居中"],
      riskLevel: "low",
      rawSource: "Issue #42: 登录页面在手机上按钮跑到左边了",
      origin: "issue"
    },
    expectedEvidenceCount: 3,
    expectedPlanNodeCount: 4
  },
  {
    id: "bench-07-pytest-multi-file",
    description: "pytest 多文件失败：共享的工具函数有 bug",
    taskInput: {
      objective: "修复 utils.format_date 导致多个测试失败",
      constraints: ["不得改变 format_date 的返回类型"],
      acceptanceCriteria: ["pytest tests/test_utils.py tests/test_models.py 通过"],
      riskLevel: "medium",
      rawSource: "FAIL test_utils.py::test_format_date, test_models.py::test_created_at",
      origin: "failed_test_log",
      failure: {
        testNames: ["test_utils.py::test_format_date", "test_models.py::test_created_at"],
        errorTypes: ["AssertionError"],
        stackSummary: "assert '2024-01-01' == '2024-1-1'"
      }
    },
    expectedEvidenceCount: 3,
    expectedPlanNodeCount: 4
  },
  {
    id: "bench-08-vitest-snapshot",
    description: "Vitest 快照不匹配：组件输出变更后未更新快照",
    taskInput: {
      objective: "更新 Header 组件快照以匹配新设计",
      constraints: ["不得回退设计变更"],
      acceptanceCriteria: ["vitest -u src/Header.test.tsx 后测试通过"],
      riskLevel: "low",
      rawSource: "FAIL Header.test.tsx > renders correctly\nSnapshot: <header>old</header>\nReceived: <header>new</header>",
      origin: "failed_test_log",
      failure: {
        testNames: ["Header.test.tsx::renders correctly"],
        errorTypes: ["SnapshotMismatch"],
        stackSummary: "Expected snapshot: <header>old</header>, Received: <header>new</header>"
      }
    },
    expectedEvidenceCount: 3,
    expectedPlanNodeCount: 4
  }
];

/**
 * 为基准任务生成确定性 Evidence Pack v1。
 *
 * 相同的 taskInput 始终产出相同的 evidence 数量、plan 节点数量和审计结构。
 * 时间戳使用固定值以保证可重复性。
 */
export function createBenchmarkEvidencePack(
  fixture: BenchmarkFixture,
  taskId: string
): EvidencePack {
  const evidence: EvidenceItem[] = [
    {
      id: `${fixture.id}-ev-code`,
      kind: "code",
      source: "fake-code-search",
      locator: "src/main.py:42",
      capturedAt: "2026-01-01T00:00:00.000Z",
      contentHash: `hash-code-${fixture.id}`,
      summary: `代码搜索结果：${fixture.taskInput.objective}`,
      relevance: 0.9,
      trustLevel: "PRIMARY"
    },
    {
      id: `${fixture.id}-ev-git`,
      kind: "git",
      source: "fake-git-history",
      locator: "commit:abc123",
      capturedAt: "2026-01-01T00:00:00.000Z",
      contentHash: `hash-git-${fixture.id}`,
      summary: `Git 历史：最近修改该文件的相关提交`,
      relevance: 0.7,
      trustLevel: "VERIFIED_MEMORY"
    },
    {
      id: `${fixture.id}-ev-memory`,
      kind: "memory",
      source: "fake-sqlite-memory",
      locator: "repair-record:rec-001",
      capturedAt: "2026-01-01T00:00:00.000Z",
      contentHash: `hash-memory-${fixture.id}`,
      summary: `历史经验：类似失败模式的修复记录`,
      relevance: 0.6,
      trustLevel: "VERIFIED_MEMORY"
    }
  ];

  return {
    id: `pack-${fixture.id}`,
    taskId,
    version: 1,
    taskSnapshot: fixture.taskInput,
    evidence: evidence.slice(0, fixture.expectedEvidenceCount),
    hypotheses: [
      {
        text: `根因假设：${fixture.taskInput.objective}`,
        confidence: 0.75,
        evidenceIds: evidence.slice(0, fixture.expectedEvidenceCount).map((e) => e.id)
      }
    ],
    constraints: fixture.taskInput.constraints.map((text, i) => ({
      text,
      evidenceIds: [evidence[0]!.id],
      required: i === 0
    })),
    acceptanceCriteria: [...fixture.taskInput.acceptanceCriteria],
    createdAt: "2026-01-01T00:00:00.000Z",
    contentHash: computePackContentHash({
      id: `pack-${fixture.id}`,
      taskId,
      version: 1,
      taskSnapshot: fixture.taskInput,
      evidence: evidence.slice(0, fixture.expectedEvidenceCount),
      hypotheses: [
        {
          text: `根因假设：${fixture.taskInput.objective}`,
          confidence: 0.75,
          evidenceIds: evidence.slice(0, fixture.expectedEvidenceCount).map((e) => e.id)
        }
      ],
      constraints: fixture.taskInput.constraints.map((text, i) => ({
        text,
        evidenceIds: [evidence[0]!.id],
        required: i === 0
      })),
      acceptanceCriteria: [...fixture.taskInput.acceptanceCriteria]
    })
  };
}

/**
 * 为基准任务生成确定性 Plan。
 *
 * 每个 plan 包含固定数量的节点：复现 → 定位 → 修改 → 验证。
 */
export function createBenchmarkPlan(
  fixture: BenchmarkFixture,
  taskId: string,
  evidencePackId: string
): Plan {
  const nodes: PlanNode[] = [
    {
      id: `${fixture.id}-node-1`,
      label: "复现",
      description: "运行失败测试确认问题存在",
      evidencePackId,
      evidencePackVersion: 1
    },
    {
      id: `${fixture.id}-node-2`,
      label: "定位",
      description: "基于证据定位根因",
      evidencePackId,
      evidencePackVersion: 1
    },
    {
      id: `${fixture.id}-node-3`,
      label: "修改",
      description: "在 worktree 中实施修复",
      evidencePackId,
      evidencePackVersion: 1
    },
    {
      id: `${fixture.id}-node-4`,
      label: "验证",
      description: "运行测试确认修复有效",
      evidencePackId,
      evidencePackVersion: 1
    }
  ];

  return {
    id: `plan-${fixture.id}-${randomId()}`,
    taskId,
    nodes: nodes.slice(0, fixture.expectedPlanNodeCount),
    inputEvidencePackId: evidencePackId,
    inputEvidencePackVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}
