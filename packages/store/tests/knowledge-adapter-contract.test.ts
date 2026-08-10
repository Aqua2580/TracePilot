/**
 * KnowledgeAdapter 共享契约测试 —— Phase 5 P2-01。
 *
 * FakeKnowledgeAdapter 与 SqliteRepairMemoryAdapter 必须遵守同一组召回规则：
 * 默认状态过滤、项目隔离、文本匹配、稳定排序、数量限制和 JSON 往返。
 * 契约只依赖 Core 端口，因此新 Adapter 也可以复用本文件的断言。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeKnowledgeAdapter } from "@tracepilot/adapters";
import {
  computePackContentHash,
  type KnowledgeAdapter,
  type EvidencePack,
  type ExecutionResult,
  type MemoryQuery,
  type Project,
  type RepairRecord,
  type TaskInput
} from "@tracepilot/core";
import { createSqliteStore } from "../src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface ContractContext {
  readonly adapter: KnowledgeAdapter;
  /** 返回实际写入的记录；SQLite 会把测试输入绑定到真实 Pack/ExecutionResult。 */
  readonly seed: (
    records: readonly RepairRecord[]
  ) => Promise<readonly RepairRecord[]>;
  readonly cleanup: () => void;
}

const taskInput: TaskInput = {
  objective: "修复契约测试中的失败任务",
  constraints: ["不得改变公开接口"],
  acceptanceCriteria: ["测试通过"],
  riskLevel: "low",
  rawSource: "契约测试输入",
  origin: "failed_test_log"
};

function sampleRecord(overrides: Partial<RepairRecord> = {}): RepairRecord {
  return {
    id: "record-default",
    projectId: "project-contract",
    taskId: "task-contract",
    status: "APPROVED",
    symptom: "接口测试失败",
    rootCause: "空值处理遗漏",
    rootCauseConfidence: 0.9,
    rootCauseEvidenceIds: ["evidence-contract"],
    fixSummary: "增加空值检查",
    applicabilityConditions: ["仅适用于当前接口"],
    applicabilityConditionEvidence: [
      {
        text: "仅适用于当前接口",
        evidenceIds: ["evidence-contract"],
        required: true
      }
    ],
    failureReasons: ["旧实现未处理空值"],
    inputEvidencePackId: "pack-contract",
    inputEvidencePackVersion: 1,
    inputEvidencePackContentHash: "fnv1a32-1234abcd",
    diffHash: "sha256-contract",
    verificationResult: {
      passed: true,
      ranCommands: ["pytest"],
      exitCodes: { pytest: 0 }
    },
    reviewResult: { verdict: "ship", findings: [] },
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...overrides
  };
}

function sampleProject(id: string): Project {
  return {
    id,
    name: `契约项目 ${id}`,
    repositoryPath: `D:/tracepilot-contract/${id}`,
    defaultBranch: "main",
    language: "python",
    commands: { test: { argv: ["pytest"], timeoutMs: 30000 } },
    createdAt: "2026-08-03T00:00:00.000Z"
  };
}

interface TrustedContractFixture {
  readonly record: RepairRecord;
  readonly evidencePack: EvidencePack;
  readonly executionResult: ExecutionResult;
}

/** 为 Fake 与 SQLite 生成完全相同、可重算的可信来源输入。 */
function createTrustedContractFixture(
  record: RepairRecord
): TrustedContractFixture {
  const sourceSuffix = `${record.id}-v${record.inputEvidencePackVersion}-${record.updatedAt.replace(/[^0-9]/g, "")}`;
  const packId = `${record.inputEvidencePackId}-${record.taskId}-${record.id}`;
  const diffHash = `${record.diffHash ?? "diff-contract"}-${sourceSuffix}`;
  const evidenceIds = new Set([
    ...record.rootCauseEvidenceIds,
    ...record.applicabilityConditionEvidence.flatMap(
      (condition) => condition.evidenceIds
    )
  ]);
  const evidence = [...evidenceIds].map((id) => ({
    id,
    kind: "code" as const,
    source: "contract-fixture",
    locator: `fixture:${id}`,
    capturedAt: record.createdAt,
    contentHash: `sha256-${id}`,
    summary: `契约测试证据 ${id}`,
    relevance: 1,
    trustLevel: "PRIMARY" as const
  }));
  const packWithoutHash = {
    id: packId,
    taskId: record.taskId,
    version: record.inputEvidencePackVersion,
    taskSnapshot: taskInput,
    evidence,
    hypotheses: [
      {
        text: record.rootCause,
        confidence: record.rootCauseConfidence ?? 0,
        evidenceIds: record.rootCauseEvidenceIds
      }
    ],
    constraints: record.applicabilityConditionEvidence,
    acceptanceCriteria: taskInput.acceptanceCriteria,
    createdAt: record.createdAt
  };
  const contentHash = computePackContentHash(packWithoutHash);
  return {
    record: {
      ...record,
      inputEvidencePackId: packId,
      inputEvidencePackContentHash: contentHash,
      diffHash
    },
    evidencePack: { ...packWithoutHash, contentHash },
    executionResult: {
      id: `execution-${sourceSuffix}`,
      taskId: record.taskId,
      runId: `run-${sourceSuffix}`,
      diffHash,
      diffPatch: "diff --git a/contract.ts b/contract.ts",
      diffChangedFiles: ["contract.ts"],
      diffBytes: 64,
      verificationExitCode: 0,
      verificationPassed: true,
      verificationStdout: "契约测试通过",
      verificationStderr: "",
      createdAt: record.updatedAt
    }
  };
}

function buildFakeContext(): ContractContext {
  const projects = new Set<string>();
  const taskProjects = new Map<string, string>();
  const adapter = new FakeKnowledgeAdapter({
    projectExists: (projectId) => projects.has(projectId),
    taskProjectId: (taskId) => taskProjects.get(taskId)
  });
  return {
    adapter,
    seed: async (records) => {
      for (const record of records) {
        projects.add(record.projectId);
        if (!taskProjects.has(record.taskId)) {
          taskProjects.set(record.taskId, record.projectId);
        }
      }
      const trustedRecords: RepairRecord[] = [];
      for (const record of records) {
        const fixture = createTrustedContractFixture(record);
        await adapter.write(fixture.record);
        trustedRecords.push(fixture.record);
      }
      return trustedRecords;
    },
    cleanup: () => undefined
  };
}

function buildSqliteContext(): ContractContext {
  const directory = mkdtempSync(join(tmpdir(), "tracepilot-knowledge-contract-"));
  const dbPath = join(directory, "contract.db");
  const store = createSqliteStore({ dbPath });
  const seededProjects = new Set<string>();
  const seededTasks = new Set<string>();

  return {
    adapter: store.knowledgeAdapter,
    seed: async (records) => {
      // 测试工厂只预建外键；Repair Record 必须全部通过被测的公开 write()。
      await store.unitOfWork.run(async (tx) => {
        for (const record of records) {
          if (!seededProjects.has(record.projectId)) {
            await tx.projects.save(sampleProject(record.projectId));
            seededProjects.add(record.projectId);
          }
          if (!seededTasks.has(record.taskId)) {
            await tx.tasks.save({
              id: record.taskId,
              projectId: record.projectId,
              status: "COMPLETED",
              input: taskInput,
              createdAt: "2026-08-03T00:00:00.000Z",
              updatedAt: "2026-08-03T00:00:00.000Z"
            });
            seededTasks.add(record.taskId);
          }
        }
      });
      const writtenRecords: RepairRecord[] = [];
      for (const record of records) {
        const fixture = createTrustedContractFixture(record);
        await store.unitOfWork.run(async (tx) => {
          await tx.evidencePacks.save(fixture.evidencePack);
          await tx.executionResults.save(fixture.executionResult);
        });
        await store.knowledgeAdapter.write(fixture.record);
        writtenRecords.push(fixture.record);
      }
      return writtenRecords;
    },
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function runKnowledgeAdapterContract(name: string, factory: () => ContractContext): void {
  describe(`${name} KnowledgeAdapter 契约`, () => {
    let context: ContractContext;

    beforeEach(() => {
      context = factory();
    });

    afterEach(() => {
      context.cleanup();
    });

    it("默认只召回 APPROVED 记录", async () => {
      await context.seed([
        sampleRecord({ id: "draft", status: "DRAFT" }),
        sampleRecord({ id: "verified", status: "VERIFIED" }),
        sampleRecord({ id: "approved", status: "APPROVED" }),
        sampleRecord({ id: "deprecated", status: "DEPRECATED" })
      ]);

      const results = await context.adapter.search({ projectId: "project-contract" });
      expect(results.map((record) => record.id)).toEqual(["approved"]);
    });

    it("minStatus=VERIFIED 召回 VERIFIED 和 APPROVED", async () => {
      await context.seed([
        sampleRecord({ id: "verified", status: "VERIFIED" }),
        sampleRecord({ id: "approved", status: "APPROVED" }),
        sampleRecord({ id: "draft", status: "DRAFT" })
      ]);

      const results = await context.adapter.search({
        projectId: "project-contract",
        minStatus: "VERIFIED"
      });
      expect(results.map((record) => record.id).sort()).toEqual(["approved", "verified"]);
    });

    it("按 projectId 隔离，并支持 symptom/rootCause 过滤", async () => {
      await context.seed([
        sampleRecord({
          id: "same-project",
          symptom: "登录失败",
          rootCause: "空指针"
        }),
        sampleRecord({
          id: "other-project",
          projectId: "project-other",
          taskId: "task-other",
          symptom: "登录失败",
          rootCause: "权限配置"
        })
      ]);

      const results = await context.adapter.search({
        projectId: "project-contract",
        symptom: "登录",
        rootCause: "空指针"
      });
      expect(results.map((record) => record.id)).toEqual(["same-project"]);
    });

    it("使用相同排序规则并尊重 maxResults", async () => {
      await context.seed([
        sampleRecord({ id: "record-b", updatedAt: "2026-08-03T00:00:01.000Z", symptom: "网络失败" }),
        sampleRecord({ id: "record-a", updatedAt: "2026-08-03T00:00:01.000Z", symptom: "网络失败" }),
        sampleRecord({ id: "record-c", updatedAt: "2026-08-03T00:00:02.000Z", symptom: "网络失败" })
      ]);

      const results = await context.adapter.search({
        projectId: "project-contract",
        symptom: "网络失败",
        maxResults: 2
      });
      expect(results.map((record) => record.id)).toEqual(["record-c", "record-a"]);
    });

    it("未指定 maxResults 时统一限制为 10 条", async () => {
      const records = Array.from({ length: 12 }, (_, index) =>
        sampleRecord({ id: `default-limit-${String(index).padStart(2, "0")}` })
      );
      await context.seed(records);

      const results = await context.adapter.search({ projectId: "project-contract" });
      expect(results).toHaveLength(10);
      expect(results.map((record) => record.id)).toEqual(
        records.slice(0, 10).map((record) => record.id)
      );
    });

    it("非法运行时查询以相同结构化错误失败关闭", async () => {
      const invalidQueries: unknown[] = [
        { projectId: "project-contract", minStatus: "DRAFT" },
        { projectId: "project-contract", maxResults: 0 },
        { projectId: "project-contract", maxResults: 101 },
        { projectId: "project-contract", maxResults: 1.5 }
      ];

      for (const query of invalidQueries) {
        await expect(
          context.adapter.search(query as MemoryQuery)
        ).rejects.toMatchObject({ name: "MemoryQueryValidationError" });
      }
    });

    it("重复 ID 可原子升级到同一任务的新 Pack 版本", async () => {
      await context.seed([
        sampleRecord({ id: "record-update", rootCause: "旧根因" })
      ]);
      await context.seed([
        sampleRecord({
          id: "record-update",
          rootCause: "新根因",
          fixSummary: "更新后的修复摘要",
          inputEvidencePackVersion: 2,
          updatedAt: "2026-08-03T00:00:05.000Z"
        })
      ]);

      const results = await context.adapter.search({
        projectId: "project-contract",
        rootCause: "新根因"
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: "record-update",
        rootCause: "新根因",
        fixSummary: "更新后的修复摘要",
        inputEvidencePackVersion: 2
      });
    });

    it("同来源状态更新保留完整来源并进入默认召回", async () => {
      const [verified] = await context.seed([
        sampleRecord({ id: "record-status", status: "VERIFIED" })
      ]);
      expect(verified).toBeDefined();
      await context.adapter.write({
        ...verified!,
        status: "APPROVED",
        updatedAt: "2026-08-03T00:00:06.000Z"
      });

      const results = await context.adapter.search({ projectId: verified!.projectId });
      expect(results).toMatchObject([
        {
          id: "record-status",
          status: "APPROVED",
          inputEvidencePackId: verified!.inputEvidencePackId,
          inputEvidencePackVersion: verified!.inputEvidencePackVersion
        }
      ]);
    });

    it("跨项目 Task 组合以 project_mismatch 失败且不产生记录", async () => {
      const [projectARecord] = await context.seed([
        sampleRecord({ id: "project-a-host" })
      ]);
      const [projectBRecord] = await context.seed([
        sampleRecord({
          id: "project-b-host",
          projectId: "project-b",
          taskId: "task-project-b"
        })
      ]);

      await expect(
        context.adapter.write({
          ...projectBRecord!,
          id: "record-cross-project",
          projectId: projectARecord!.projectId
        })
      ).rejects.toMatchObject({
        name: "RepairMemoryWriteError",
        code: "project_mismatch"
      });
      await expect(
        context.adapter.search({ projectId: projectARecord!.projectId })
      ).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "record-cross-project" })])
      );
    });

    it("重复 ID 跨任务或跨项目更新以 identity_mismatch 回滚", async () => {
      const [original] = await context.seed([
        sampleRecord({ id: "record-identity", rootCause: "原始根因" })
      ]);
      const [sameProjectOtherTask] = await context.seed([
        sampleRecord({
          id: "same-project-other-task-host",
          taskId: "task-contract-other"
        })
      ]);
      const [otherProject] = await context.seed([
        sampleRecord({
          id: "other-project-host",
          projectId: "project-other",
          taskId: "task-other"
        })
      ]);

      for (const replacement of [sameProjectOtherTask!, otherProject!]) {
        await expect(
          context.adapter.write({ ...replacement, id: original!.id })
        ).rejects.toMatchObject({
          name: "RepairMemoryWriteError",
          code: "identity_mismatch"
        });
      }

      const results = await context.adapter.search({
        projectId: original!.projectId,
        rootCause: "原始根因"
      });
      expect(results).toMatchObject([
        {
          id: "record-identity",
          projectId: original!.projectId,
          taskId: original!.taskId,
          rootCause: "原始根因"
        }
      ]);
    });

    it("结构非法和外键缺失写入均失败且不留下部分记录", async () => {
      await expect(
        context.adapter.write({ ...sampleRecord(), id: "" } as RepairRecord)
      ).rejects.toMatchObject({
        name: "RepairMemoryWriteError",
        code: "invalid_record"
      });
      await expect(
        context.adapter.write(
          sampleRecord({
            id: "missing-reference",
            projectId: "project-missing",
            taskId: "task-missing"
          })
        )
      ).rejects.toMatchObject({
        name: "RepairMemoryWriteError",
        code: "missing_reference"
      });

      await context.seed([sampleRecord({ id: "after-failure" })]);
      const validResults = await context.adapter.search({
        projectId: "project-contract"
      });
      expect(validResults.map((record) => record.id)).toEqual(["after-failure"]);
      const missingResults = await context.adapter.search({
        projectId: "project-missing"
      });
      expect(missingResults).toEqual([]);
    });

    it("写入后可读回 JSON 安全的验证退出码", async () => {
      await context.seed([sampleRecord({ id: "json-roundtrip" })]);

      const results = await context.adapter.search({ projectId: "project-contract" });
      expect(results[0]?.verificationResult?.exitCodes).toEqual({ pytest: 0 });
      expect(results[0]?.verificationResult?.exitCodes).not.toBeInstanceOf(Map);
      expect(results[0]?.inputEvidencePackContentHash).toMatch(
        /^fnv1a32-[0-9a-f]{8}$/
      );
      expect(results[0]?.rootCauseEvidenceIds).toEqual(["evidence-contract"]);
      expect(results[0]?.applicabilityConditionEvidence).toEqual([
        {
          text: "仅适用于当前接口",
          evidenceIds: ["evidence-contract"],
          required: true
        }
      ]);
    });
  });
}

runKnowledgeAdapterContract("Fake", buildFakeContext);
runKnowledgeAdapterContract("SQLite", buildSqliteContext);
