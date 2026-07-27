/**
 * SQLite Evidence Pack 不可变性测试 —— Phase 3 P1-04。
 *
 * 覆盖规格 §5.3、AGENTS.md 规则 10、P1-04 修复要求：
 * - 同一 (id, version) 二次写入被拒绝，原内容/哈希不变；
 * - 跨任务 EvidenceRequest 升级 Pack 被拒绝；
 * - 合法 Request 仅生成 v(n+1) 并保留全部旧版本。
 *
 * 这些测试仅在 SQLite 真源上运行（InMemory 已有等价测试），确保
 * SQLite 仓储的 `ON CONFLICT(id, version) DO NOTHING` + 显式
 * `EvidencePackVersionError` 与领域规则一致。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSqliteStore,
  type SqliteStore
} from "../src/index.js";
import {
  TaskOrchestrator,
  EvidencePackVersionError,
  type TaskInput,
  type Project,
  type EvidenceItem,
  type EvidencePack
} from "@tracepilot/core";

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tracepilot-p1-04-"));
  return join(dir, "test.db");
}

function safeCleanup(dbPath: string): void {
  const dir = join(dbPath, "..");
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略：Windows 文件锁残留不影响测试结论
  }
}

function sampleProject(id = "proj-p1-04"): Project {
  return {
    id,
    name: "P1-04 测试项目",
    repositoryPath: "D:/fake-repo-p1-04",
    defaultBranch: "main",
    language: "python",
    commands: {
      test: { argv: ["pytest"], timeoutMs: 30000 }
    },
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function sampleTaskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    objective: "修复失败的 pytest 用例 test_users_create",
    constraints: ["不得修改 /api/users 的公开 API"],
    acceptanceCriteria: ["pytest tests/test_users.py 通过"],
    riskLevel: "low",
    rawSource: "FAILED test_users_create::test_returns_201 ...",
    origin: "failed_test_log",
    failure: {
      testNames: ["test_users_create::test_returns_201"],
      errorTypes: ["AssertionError"],
      stackSummary: "assert response.status == 201, got 400"
    },
    ...overrides
  };
}

function sampleEvidence(prefix: string): EvidenceItem[] {
  return [
    {
      id: `${prefix}-ev-1`,
      kind: "code",
      source: "fake-git-validate",
      locator: `commit:${prefix}-sha`,
      capturedAt: "2026-01-01T00:00:00.000Z",
      contentHash: `hash-${prefix}-1`,
      summary: `${prefix} 证据 1`,
      relevance: 0.8,
      trustLevel: "PRIMARY"
    },
    {
      id: `${prefix}-ev-2`,
      kind: "git",
      source: "fake-git-history",
      locator: `commit:${prefix}-sha-2`,
      capturedAt: "2026-01-01T00:00:01.000Z",
      contentHash: `hash-${prefix}-2`,
      summary: `${prefix} 证据 2`,
      relevance: 0.7,
      trustLevel: "VERIFIED_MEMORY"
    }
  ];
}

/** 在 store 中创建项目（满足外键约束）。 */
async function seedProject(store: SqliteStore, project: Project = sampleProject()): Promise<void> {
  await store.unitOfWork.run(async (tx) => {
    await tx.projects.save(project);
  });
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe("SQLite Evidence Pack 不可变性 (P1-04)", () => {
  let dbPath: string;
  let store: SqliteStore;

  beforeEach(() => {
    dbPath = tempDbPath();
    store = createSqliteStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    safeCleanup(dbPath);
  });

  // -------------------------------------------------------------------------
  // 测试 1：同一 (id, version) 二次写入被拒绝，原内容/哈希不变
  // -------------------------------------------------------------------------

  it("同一 (id, version) 二次写入被拒绝，原内容/哈希不变", async () => {
    await seedProject(store);
    const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
    const task = await orchestrator.createTask({
      projectId: "proj-p1-04",
      input: sampleTaskInput()
    });

    // 把任务迁移到 GATHERING_EVIDENCE（生成 Pack v1 的前置条件）
    await orchestrator.transitionTask(task.id, "INTAKING");
    await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE");

    const packV1 = await orchestrator.gatherEvidenceAndCreatePack({
      taskId: task.id,
      packId: "pack-p1-04-immutable",
      evidence: sampleEvidence("v1"),
      hypotheses: [
        {
          text: "v1 假设",
          confidence: 0.7,
          evidenceIds: ["v1-ev-1", "v1-ev-2"]
        }
      ],
      constraints: [
        { text: "v1 约束", evidenceIds: ["v1-ev-1"], required: true }
      ],
      acceptanceCriteria: ["v1 验收标准"]
    });

    const originalHash = packV1.contentHash;
    const originalEvidenceCount = packV1.evidence.length;

    // 尝试用相同的 (id, version) 再次写入，但内容不同 —— 必须被拒绝
    const tamperedPack: EvidencePack = {
      ...packV1,
      evidence: [
        {
          id: "tampered-ev",
          kind: "code",
          source: "tampered-source",
          locator: "tampered-locator",
          capturedAt: "2026-01-02T00:00:00.000Z",
          contentHash: "tampered-hash",
          summary: "篡改证据",
          relevance: 0.1,
          trustLevel: "UNVERIFIED"
        }
      ],
      contentHash: "tampered-overall-hash",
      createdAt: "2026-01-02T00:00:00.000Z"
    };

    await expect(
      store.unitOfWork.run(async (tx) => {
        await tx.evidencePacks.save(tamperedPack);
      })
    ).rejects.toThrow(EvidencePackVersionError);

    // 验证原内容未变：从数据库重新读取，确认 evidence / hash / createdAt 不变
    const reloaded = await store.unitOfWork.run((tx) =>
      tx.evidencePacks.findLatestVersion("pack-p1-04-immutable")
    );
    expect(reloaded).toBeDefined();
    expect(reloaded!.contentHash).toBe(originalHash);
    expect(reloaded!.evidence.length).toBe(originalEvidenceCount);
    expect(reloaded!.evidence[0]!.id).toBe("v1-ev-1");
    expect(reloaded!.createdAt).toBe(packV1.createdAt);

    // 版本列表中只有 v1
    const versions = await store.unitOfWork.run((tx) =>
      tx.evidencePacks.findVersions("pack-p1-04-immutable")
    );
    expect(versions.map((p) => p.version)).toEqual([1]);
  });

  // -------------------------------------------------------------------------
  // 测试 2：跨任务 EvidenceRequest 升级 Pack 被拒绝
  // -------------------------------------------------------------------------

  it("跨任务 EvidenceRequest 升级 Pack 被拒绝", async () => {
    await seedProject(store);
    const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });

    // 任务 A：创建并生成 Pack v1
    const taskA = await orchestrator.createTask({
      projectId: "proj-p1-04",
      input: sampleTaskInput({ objective: "任务 A 的目标" }),
      taskId: "task-a"
    });
    await orchestrator.transitionTask(taskA.id, "INTAKING");
    await orchestrator.transitionTask(taskA.id, "GATHERING_EVIDENCE");
    const packA = await orchestrator.gatherEvidenceAndCreatePack({
      taskId: taskA.id,
      packId: "pack-task-a",
      evidence: sampleEvidence("taskA")
    });
    // 任务 A 迁移到 PLANNED，再迁移到 EXECUTING 前先到 AWAITING_EXECUTION_APPROVAL
    await orchestrator.transitionTask(taskA.id, "PLANNED");
    await orchestrator.transitionTask(taskA.id, "AWAITING_EXECUTION_APPROVAL");

    // 任务 B：创建并生成 Pack v1
    const taskB = await orchestrator.createTask({
      projectId: "proj-p1-04",
      input: sampleTaskInput({ objective: "任务 B 的目标" }),
      taskId: "task-b"
    });
    await orchestrator.transitionTask(taskB.id, "INTAKING");
    await orchestrator.transitionTask(taskB.id, "GATHERING_EVIDENCE");
    await orchestrator.gatherEvidenceAndCreatePack({
      taskId: taskB.id,
      packId: "pack-task-b",
      evidence: sampleEvidence("taskB")
    });

    // 任务 B 提交一个 EvidenceRequest
    const requestFromB = await orchestrator.submitEvidenceRequest({
      taskId: taskB.id,
      requesterRole: "developer",
      gapReason: "任务 B 需要更多证据",
      neededKinds: ["git", "runtime"],
      allowedScope: "src/",
      expectedPlanImpact: "补充运行时证据"
    });

    // 尝试用任务 B 的 Request 升级任务 A 的 Pack —— 必须被拒绝
    await expect(
      orchestrator.evolvePackWithNewEvidence({
        taskId: taskA.id,
        requestId: requestFromB.id,
        additions: {
          evidence: sampleEvidence("crossTask")
        }
      })
    ).rejects.toThrow(/属于任务/);

    // 验证任务 A 的 Pack 仍是 v1，未被跨任务 Request 升级
    const versionsA = await store.unitOfWork.run((tx) =>
      tx.evidencePacks.findVersions(packA.id)
    );
    expect(versionsA.map((p) => p.version)).toEqual([1]);
  });

  // -------------------------------------------------------------------------
  // 测试 3：合法 Request 生成 v(n+1) 并保留全部旧版本
  // -------------------------------------------------------------------------

  it("合法 Request 生成 v(n+1) 并保留全部旧版本", async () => {
    await seedProject(store);
    const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });

    const task = await orchestrator.createTask({
      projectId: "proj-p1-04",
      input: sampleTaskInput(),
      taskId: "task-evolve"
    });
    await orchestrator.transitionTask(task.id, "INTAKING");
    await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE");

    // 生成 Pack v1
    const packV1 = await orchestrator.gatherEvidenceAndCreatePack({
      taskId: task.id,
      packId: "pack-evolve",
      evidence: sampleEvidence("v1"),
      acceptanceCriteria: ["v1 验收"]
    });
    expect(packV1.version).toBe(1);

    // 任务迁移到 PLANNED → AWAITING_EXECUTION_APPROVAL → EXECUTING → EVIDENCE_GAP
    await orchestrator.transitionTask(task.id, "PLANNED");

    // P1-R04：必须在 PLANNED 状态记录 Plan，更新 task.currentPlanId，
    // 否则 beginExecutionIfApproved 在事务内重算 scopeHash 时会因
    // currentPlanId 为空而失败。
    await orchestrator.planTask({
      taskId: task.id,
      nodes: [
        {
          id: "node-evolve-1",
          label: "修改 users.py",
          description: "调整 createUser 实现",
          evidencePackId: packV1.id,
          evidencePackVersion: packV1.version
        }
      ],
      allowedPaths: ["src/"],
      inputEvidencePackId: packV1.id,
      inputEvidencePackVersion: packV1.version
    });

    await orchestrator.transitionTask(task.id, "AWAITING_EXECUTION_APPROVAL");

    // P1-R04：scopeHash 必须从 task.currentPlanId + Project.commands 重算，
    // 不得使用伪造值。beginExecutionIfApproved 会在事务内再次重算并比对。
    const scopeHash = await orchestrator.computeCurrentScopeHash(task.id);
    await orchestrator.recordApproval({
      taskId: task.id,
      kind: "execution",
      approver: "approver-1",
      decision: "approved",
      scopeHash
    });

    await orchestrator.beginExecutionIfApproved(task.id);

    // EXECUTING 状态发现证据缺口，提交 EvidenceRequest
    const request = await orchestrator.submitEvidenceRequest({
      taskId: task.id,
      requesterRole: "developer",
      gapReason: "需要补充运行时证据",
      neededKinds: ["runtime"],
      allowedScope: "src/",
      expectedPlanImpact: "增加运行时验证步骤"
    });

    // 任务迁移到 EVIDENCE_GAP → GATHERING_EVIDENCE
    await orchestrator.transitionTask(task.id, "GATHERING_EVIDENCE", {
      widenScope: true,
      reason: "扩大范围收集运行时证据"
    });

    // 用合法 Request 升级 Pack
    const packV2 = await orchestrator.evolvePackWithNewEvidence({
      taskId: task.id,
      requestId: request.id,
      additions: {
        evidence: [
          {
            id: "v2-ev-runtime",
            kind: "runtime",
            source: "fake-runtime-analyze",
            locator: "run:run-001",
            capturedAt: "2026-01-02T00:00:00.000Z",
            contentHash: "hash-v2-runtime",
            summary: "运行时证据：异常堆栈",
            relevance: 0.9,
            trustLevel: "PRIMARY"
          }
        ],
        acceptanceCriteria: ["v2 新增验收：运行时验证"]
      }
    });

    expect(packV2.version).toBe(2);
    expect(packV2.evidence.length).toBe(packV1.evidence.length + 1);
    expect(packV2.evidence.some((e) => e.id === "v2-ev-runtime")).toBe(true);
    // v2 的 acceptanceCriteria 应包含 v1 的和新加的
    expect(packV2.acceptanceCriteria).toContain("v1 验收");
    expect(packV2.acceptanceCriteria).toContain("v2 新增验收：运行时验证");

    // 旧版本 v1 仍保留在数据库中
    const versions = await store.unitOfWork.run((tx) =>
      tx.evidencePacks.findVersions("pack-evolve")
    );
    expect(versions.map((p) => p.version)).toEqual([1, 2]);

    // v1 的内容未变
    const v1FromDb = versions[0]!;
    expect(v1FromDb.evidence.length).toBe(packV1.evidence.length);
    expect(v1FromDb.contentHash).toBe(packV1.contentHash);
    expect(v1FromDb.acceptanceCriteria).toEqual(["v1 验收"]);

    // v2 的内容是新版本
    const v2FromDb = versions[1]!;
    expect(v2FromDb.evidence.length).toBe(packV1.evidence.length + 1);
    expect(v2FromDb.contentHash).toBe(packV2.contentHash);

    // latest 版本是 v2
    const latest = await store.unitOfWork.run((tx) =>
      tx.evidencePacks.findLatestVersion("pack-evolve")
    );
    expect(latest!.version).toBe(2);

    // 任务关联的 currentEvidencePackVersion 已更新为 2
    const reloadedTask = await store.unitOfWork.run((tx) =>
      tx.tasks.findById(task.id)
    );
    expect(reloadedTask!.currentEvidencePackVersion).toBe(2);
  });
});
