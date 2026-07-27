/**
 * EvidenceCollector —— Phase 3 P1-05 / P1-R02 修复。
 *
 * 见规格 §5.3、§7.3、§8.1 步骤 2-3、ADR-002。
 *
 * 这是证据收集的受控编排服务。它把"Router 生成证据请求规格"与
 * "调用 GitAdapter / KnowledgeAdapter / WorktreeManager 收集真实证据"
 * 组合成一条受控链路，确保所有写入 Evidence Pack 的证据都具备可回溯字段
 * （source、locator、contentHash、capturedAt），且对应的 Git 命令
 * 通过 auditSink 写入 SQLite audit_events（P1-03）。
 *
 * 职责：
 * 1. 调用 `EvidenceRouter.route(taskInput)` 生成 EvidenceRequestSpec[]。
 * 2. P1-R02：把 Router 请求规格（kind/source/allowedScope）作为
 *    `evidence_router_request` 审计事件追加到 SQLite，记录"实际查询范围"。
 * 3. 对每条 spec 调用对应 Adapter：
 *    - `kind=git, source=git-history` → `GitAdapter.getHistory`
 *    - `kind=memory, source=sqlite-memory` → `KnowledgeAdapter.search`
 *    - P1-R02：`worktreeId` 提供时，经 `WorktreeManager.captureDiffForTask`
 *      受控获取 Diff 并转换为 `git-diff` 证据
 *    - 其他（code/runtime/policy）在 Phase 3 不实现 —— Phase 4 由
 *      OmpAdapter.analyze 提供 runtime/code 证据；policy 直接来自
 *      `taskInput.constraints`，不需要单独收集。
 * 4. 把 Adapter 返回的结果转换为 `EvidenceItem[]`，每条带 source /
 *    locator / contentHash / capturedAt。
 * 5. 把 GitAdapter 执行 git 命令时上报的 GitCommandAudit 通过
 *    `flushGitCommandAudits` 写入 SQLite audit_events（P1-03）。
 *
 * EvidenceCollector 只依赖 core ports（EvidenceRouter、GitAdapter、
 * KnowledgeAdapter、UnitOfWork、WorktreeManager），不依赖 Fastify /
 * Drizzle / Git SDK。
 *
 * **不变量**：
 * - 永不在事务回调内执行 git I/O（§3.1）——`GitAdapter` 调用必须在
 *   事务外完成，事务内只做审计追加。
 * - 永不生成无 `source` / `locator` / `contentHash` 的 EvidenceItem
 *   （由 TaskOrchestrator.gatherEvidenceAndCreatePack 在 Pack 写入时
 *   二次校验，P1-05）。
 * - 永不把 Router 的 spec 直接当作 EvidenceItem —— spec 只描述"要什么"，
 *   EvidenceItem 描述"实际拿到了什么"，两者必须经 Adapter 转换。
 * - P1-R02：永不让调用方绕过 WorktreeManager 获取 Diff —— `worktreeId`
 *   由调用方提供，但 Diff 获取必须经 WorktreeManager.captureDiffForTask，
 *   以保证登记校验与审计链完整。
 */

import type {
  EvidenceItem,
  EvidenceKind,
  TrustLevel
} from "../domain/evidence.js";
import type { TaskInput } from "../domain/task.js";
import type { GitEvidence, KnowledgeAdapter } from "../ports/adapters.js";
import type { GitAdapter } from "../ports/adapters.js";
import type { UnitOfWork } from "../ports/repositories.js";
import type { EvidenceRouter, EvidenceRequestSpec } from "./evidence-router.js";
import type { WorktreeManager } from "./worktree-manager.js";
import { createAuditEvent } from "../domain/audit.js";
import {
  BufferedGitCommandAuditSink,
  flushGitCommandAudits
} from "./git-audit-sink.js";

/**
 * EvidenceCollector 依赖。
 *
 * `router` 生成证据请求规格（纯函数，无 I/O）；
 * `gitAdapter` 提供 git-history 证据（真实 git 命令，经治理闸门）；
 * `knowledgeAdapter` 提供 sqlite-memory 证据（SQLite Repair Memory）；
 * `unitOfWork` 用于把 git 命令审计与 Router 请求审计写入 SQLite
 * audit_events（P1-03 / P1-R02）。
 * `worktreeManager`（可选）提供受控 Diff 采集（P1-R02）；未提供时
 * 调用方传 `worktreeId` 将抛错。
 */
export interface EvidenceCollectorDeps {
  readonly router: EvidenceRouter;
  readonly gitAdapter: GitAdapter;
  readonly knowledgeAdapter: KnowledgeAdapter;
  readonly unitOfWork: UnitOfWork;
  /** P1-R02：受控 Diff 采集服务，可选。 */
  readonly worktreeManager?: WorktreeManager;
}

/**
 * EvidenceCollector 输入。
 *
 * `taskInput` 用于 Router 生成请求规格；
 * `projectId` 与 `repositoryPath` 用于 KnowledgeAdapter 与 GitAdapter 查询；
 * `blameFilePaths`（可选）用于在 git 证据之后补充 git-blame 证据，
 * 通常从 testNames 提取（Router 已在 spec.locator 中携带文件路径，
 * 但 blame 需要逐文件调用，因此由调用方提供去重后的文件列表）。
 * `worktreeId`（可选，P1-R02）用于经 WorktreeManager 受控获取 Diff 证据；
 * 若提供则 EvidenceCollector 必须有 `worktreeManager` 依赖。
 */
export interface EvidenceCollectorInput {
  readonly taskId: string;
  readonly taskInput: TaskInput;
  readonly projectId: string;
  readonly repositoryPath: string;
  /** 默认 10 条；测试可覆盖。 */
  readonly maxHistoryCount?: number;
  /** 可选：若提供，则对每个文件调用 getBlame 补充 blame 证据。 */
  readonly blameFilePaths?: readonly string[];
  /**
   * P1-R02：可选，已登记 worktree 的 ID。
   * 提供时经 WorktreeManager.captureDiffForTask 受控获取 Diff 证据。
   */
  readonly worktreeId?: string;
}

/**
 * 证据收集结果。除了 EvidenceItem[]，还返回本次收集到的命令审计数，
 * 供调用方在写 `evidence_pack_versioned` 审计时引用（P1-05）。
 */
export interface EvidenceCollectionResult {
  readonly evidence: readonly EvidenceItem[];
  /** 本次收集触发的 git 命令数（用于审计回溯）。 */
  readonly gitCommandCount: number;
}

/**
 * 证据收集服务（P1-05 / P1-R02）。
 *
 * 调用方（API / 编排层）典型用法：
 * ```ts
 * const result = await collector.collectEvidence({
 *   taskId: task.id,
 *   taskInput: task.input,
 *   projectId: project.id,
 *   repositoryPath: project.repositoryPath,
 *   blameFilePaths: extractFilePaths(task.input.failure?.testNames),
 *   worktreeId: task.worktreeId  // P1-R02：经 WorktreeManager 受控获取 Diff
 * });
 * const pack = await orchestrator.gatherEvidenceAndCreatePack({
 *   taskId: task.id,
 *   packId: `pack-${task.id}`,
 *   evidence: result.evidence,
 *   acceptanceCriteria: task.input.acceptanceCriteria
 * });
 * ```
 */
export class EvidenceCollector {
  constructor(private readonly deps: EvidenceCollectorDeps) {}

  /**
   * 收集证据并返回 EvidenceItem[]（P1-05 / P1-R02）。
   *
   * 流程：
   * 1. 调用 `router.route(taskInput)` 生成 EvidenceRequestSpec[]。
   * 2. P1-R02：把 Router 请求规格写入 SQLite audit_events
   *    （`evidence_router_request`，记录 kind/source/allowedScope）。
   * 3. 创建 `BufferedGitCommandAuditSink` 收集 git 命令审计。
   * 4. 对每条 spec 调用对应 Adapter 收集证据：
   *    - git-history → `gitAdapter.getHistory`，逐条转换为 EvidenceItem
   *    - sqlite-memory → `knowledgeAdapter.search`，逐条转换为 EvidenceItem
   * 5. 若提供 `blameFilePaths`，对每个文件调用 `gitAdapter.getBlame`
   *    补充 blame 证据。
   * 6. P1-R02：若提供 `worktreeId`，经 `WorktreeManager.captureDiffForTask`
   *    受控获取 Diff 并转换为 `git-diff` EvidenceItem。
   * 7. 把收集到的 git 命令审计写入 SQLite audit_events（P1-03）。
   *
   * @returns evidence 与 gitCommandCount（用于审计回溯）
   */
  async collectEvidence(
    args: EvidenceCollectorInput
  ): Promise<EvidenceCollectionResult> {
    const specs = this.deps.router.route(args.taskInput);

    // P1-R02：把 Router 请求规格写入审计时间线。
    await this.appendRouterRequestAudit(args.taskId, specs);

    const auditSink = new BufferedGitCommandAuditSink();
    const evidence: EvidenceItem[] = [];
    const capturedAt = new Date().toISOString();
    const maxHistoryCount = args.maxHistoryCount ?? 10;

    for (const spec of specs) {
      await this.collectForSpec(spec, args, capturedAt, maxHistoryCount, auditSink, evidence);
    }

    // 补充 blame 证据（若调用方提供了文件列表）。
    if (args.blameFilePaths && args.blameFilePaths.length > 0) {
      await this.collectBlameEvidence(
        args.blameFilePaths,
        args.repositoryPath,
        capturedAt,
        auditSink,
        evidence
      );
    }

    // P1-R02：经 WorktreeManager 受控获取 Diff 证据。
    if (args.worktreeId) {
      await this.collectDiffEvidence(
        args,
        capturedAt,
        evidence
      );
    }

    // 把 git 命令审计写入 SQLite audit_events（P1-03）。
    // 注意：captureDiffForTask 内部已自行 flush 自己的 command_executed
    // 与 diff_recorded 审计，因此这里只 flush blame/history 的命令审计。
    const audits = auditSink.drain();
    await flushGitCommandAudits(this.deps.unitOfWork, args.taskId, audits);

    return {
      evidence,
      gitCommandCount: audits.length
    };
  }

  /**
   * P1-R02：把 Router 请求规格作为审计事件追加到 SQLite。
   *
   * 每条 spec 生成一个 `evidence_router_request` 审计事件，reason 携带
   * kind/source/allowedScope/reason，便于审计回溯"实际查询了哪些范围"。
   *
   * 不记录敏感环境变量值（spec 本身来自纯函数 Router，无环境变量）。
   */
  private async appendRouterRequestAudit(
    taskId: string,
    specs: readonly EvidenceRequestSpec[]
  ): Promise<void> {
    await this.deps.unitOfWork.run(async (tx) => {
      for (const spec of specs) {
        await tx.audit.append(
          createAuditEvent({
            taskId,
            type: "evidence_router_request",
            reason: `Router 请求: kind=${spec.kind} source=${spec.source} scope=${spec.allowedScope} reason=${spec.reason}`
          })
        );
      }
    });
  }

  /**
   * 对单条 EvidenceRequestSpec 调用对应 Adapter 收集证据。
   *
   * Phase 3 实现的来源：
   * - `git-history`：调用 GitAdapter.getHistory
   * - `sqlite-memory`：调用 KnowledgeAdapter.search
   *
   * 未实现的来源（Phase 4+）：
   * - `code-search`：由 OmpAdapter.analyze 提供
   * - `test-runner`（runtime）：由 OmpAdapter.analyze 提供
   * - `project-constraints`（policy）：直接来自 taskInput.constraints，
   *   不需要单独收集（Constraints 在 Pack 中独立持久化）
   */
  private async collectForSpec(
    spec: EvidenceRequestSpec,
    args: EvidenceCollectorInput,
    capturedAt: string,
    maxHistoryCount: number,
    auditSink: BufferedGitCommandAuditSink,
    evidence: EvidenceItem[]
  ): Promise<void> {
    switch (spec.kind) {
      case "git":
        if (spec.source === "git-history") {
          await this.collectGitHistory(
            args,
            capturedAt,
            maxHistoryCount,
            auditSink,
            evidence
          );
        }
        break;
      case "memory":
        if (spec.source === "sqlite-memory") {
          await this.collectMemoryEvidence(
            args,
            spec,
            capturedAt,
            evidence
          );
        }
        break;
      case "code":
      case "runtime":
      case "policy":
        // Phase 3 不实现 —— 见类文档说明。
        break;
    }
  }

  /**
   * 调用 GitAdapter.getHistory 收集 git 历史证据（P1-05）。
   *
   * 每条 GitEvidence 转换为一个 EvidenceItem：
   * - source: "git-history"
   * - locator: `commit:<sha>`
   * - contentHash: 基于 sha+message 的稳定哈希（非安全用途）
   * - trustLevel: "PRIMARY"（git 历史是原始证据）
   */
  private async collectGitHistory(
    args: EvidenceCollectorInput,
    capturedAt: string,
    maxHistoryCount: number,
    auditSink: BufferedGitCommandAuditSink,
    evidence: EvidenceItem[]
  ): Promise<void> {
    let history: GitEvidence[];
    try {
      history = await this.deps.gitAdapter.getHistory(
        {
          repositoryPath: args.repositoryPath,
          maxCount: maxHistoryCount
        },
        auditSink
      );
    } catch {
      // git 命令失败时不上抛 —— 证据收集应尽力而为，失败由审计记录反映。
      // 调用方通过 audit_events 中的 command_executed 事件可以看到失败。
      return;
    }
    for (const entry of history) {
      evidence.push({
        id: `ev-git-${entry.commitSha}`,
        kind: "git" satisfies EvidenceKind,
        source: "git-history",
        locator: `commit:${entry.commitSha}`,
        capturedAt,
        contentHash: hashString(`${entry.commitSha}|${entry.message}`),
        summary: `${entry.author} @ ${entry.authoredAt}: ${entry.message}`,
        relevance: 0.8,
        trustLevel: "PRIMARY" satisfies TrustLevel
      });
    }
  }

  /**
   * 调用 KnowledgeAdapter.search 收集 Repair Memory 证据（P1-05）。
   *
   * 每条 RepairRecord 转换为一个 EvidenceItem：
   * - source: "sqlite-memory"
   * - locator: `record:<id>`
   * - contentHash: 基于 id+symptom+rootCause 的稳定哈希
   * - trustLevel: "VERIFIED_MEMORY"（Repair Memory 是验证过的历史经验）
   *
   * KnowledgeAdapter 不产生 git 命令审计，因此不传入 auditSink。
   */
  private async collectMemoryEvidence(
    args: EvidenceCollectorInput,
    spec: EvidenceRequestSpec,
    capturedAt: string,
    evidence: EvidenceItem[]
  ): Promise<void> {
    const records = await this.deps.knowledgeAdapter.search({
      projectId: args.projectId,
      symptom: spec.locator,
      minStatus: "APPROVED"
    });
    for (const r of records) {
      evidence.push({
        id: `ev-mem-${r.id}`,
        kind: "memory" satisfies EvidenceKind,
        source: "sqlite-memory",
        locator: `record:${r.id}`,
        capturedAt,
        contentHash: hashString(`${r.id}|${r.symptom}|${r.rootCause}`),
        summary: `症状:${r.symptom}; 根因:${r.rootCause}; 修复:${r.fixSummary}`,
        relevance: 0.6,
        trustLevel: "VERIFIED_MEMORY" satisfies TrustLevel
      });
    }
  }

  /**
   * 对每个文件调用 GitAdapter.getBlame 补充 blame 证据（P1-05）。
   *
   * 每条 BlameEvidence 转换为一个 EvidenceItem：
   * - source: "git-blame"
   * - locator: `blame:<path>:<startLine>-<endLine>@<sha>`
   * - contentHash: 基于 path+lineRange+sha 的稳定哈希
   * - trustLevel: "PRIMARY"
   */
  private async collectBlameEvidence(
    blameFilePaths: readonly string[],
    repositoryPath: string,
    capturedAt: string,
    auditSink: BufferedGitCommandAuditSink,
    evidence: EvidenceItem[]
  ): Promise<void> {
    for (const filePath of blameFilePaths) {
      let blame;
      try {
        blame = await this.deps.gitAdapter.getBlame(
          {
            repositoryPath,
            path: filePath
          },
          auditSink
        );
      } catch {
        // blame 失败不影响其他证据收集。
        return;
      }
      for (const entry of blame) {
        const [start, end] = entry.lineRange;
        evidence.push({
          id: `ev-blame-${filePath}-${start}-${end}-${entry.commitSha}`,
          kind: "git" satisfies EvidenceKind,
          source: "git-blame",
          locator: `blame:${filePath}:${start}-${end}@${entry.commitSha}`,
          capturedAt,
          contentHash: hashString(
            `${filePath}|${start}|${end}|${entry.commitSha}|${entry.lineContent}`
          ),
          summary: `${entry.author} @ ${entry.authoredAt}: ${entry.lineContent}`,
          relevance: 0.7,
          trustLevel: "PRIMARY" satisfies TrustLevel
        });
      }
    }
  }

  /**
   * P1-R02：经 WorktreeManager 受控获取 Diff 并转换为 EvidenceItem。
   *
   * 调用 `WorktreeManager.captureDiffForTask`：
   * - 内部从数据库校验 worktree 登记与任务归属（拒绝伪造 / 跨任务）
   * - 内部把 git diff 命令审计写入 SQLite（command_executed）
   * - 内部写 `diff_recorded` 审计事件（含 diffHash）
   *
   * 返回的 DiffArtifact 转换为一条 EvidenceItem：
   * - source: "git-diff"
   * - locator: `diff:<worktreeId>@<diffHash>`
   * - contentHash: 直接使用 DiffArtifact.hash（sha256）
   * - trustLevel: "PRIMARY"
   *
   * 失败时不上抛 —— Diff 采集失败由 WorktreeManager 内部审计记录反映，
   * 不影响其他证据收集。
   */
  private async collectDiffEvidence(
    args: EvidenceCollectorInput,
    capturedAt: string,
    evidence: EvidenceItem[]
  ): Promise<void> {
    if (!args.worktreeId) return;
    if (!this.deps.worktreeManager) {
      throw new Error(
        "EvidenceCollector 未注入 worktreeManager，无法受控获取 Diff 证据（P1-R02）"
      );
    }
    let diff;
    try {
      diff = await this.deps.worktreeManager.captureDiffForTask({
        taskId: args.taskId,
        worktreeId: args.worktreeId,
        reason: "EvidenceCollector 采集 Diff 证据"
      });
    } catch {
      // Diff 采集失败不影响其他证据收集；失败原因已通过
      // WorktreeManager 内部审计记录（command_executed / diff_recorded）。
      return;
    }

    evidence.push({
      id: `ev-diff-${args.worktreeId}`,
      kind: "git" satisfies EvidenceKind,
      source: "git-diff",
      locator: `diff:${args.worktreeId}@${diff.hash}`,
      capturedAt,
      // DiffArtifact.hash 已是 sha256 哈希，直接用作 contentHash。
      contentHash: diff.hash,
      summary: `Diff: ${diff.changedFiles.length} 个文件变更, ${diff.bytes} 字节, hash=${diff.hash}`,
      relevance: 0.9,
      trustLevel: "PRIMARY" satisfies TrustLevel
    });
  }
}

/**
 * 简单的字符串哈希（FNV-1a 32 位），用于证据 contentHash。
 *
 * 与 Pack contentHash 相同的纯 JS 实现，避免在 Core 引入 node:crypto。
 * 此哈希仅用于审计可追溯性，不用于任何安全目的。
 */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
