/**
 * Git 命令审计收集器与审计事件构造辅助（P1-03 / P1-05 共享）。
 *
 * 见规格 §7.3：真实 Git 命令的 argv、cwd、退出码、输出截断信息必须
 * 写入 SQLite audit_events。WorktreeManager 与 EvidenceCollector 都需要
 * 把 GitAdapter 上报的命令审计批量写入数据库，因此把这部分实现抽出
 * 为框架无关的内部辅助。
 *
 * 不导出到包外（仅 services 内部使用）。
 */

import type {
  GitAdapter,
  GitCommandAudit,
  GitCommandAuditSink
} from "../ports/adapters.js";
import type { UnitOfWork } from "../ports/repositories.js";
import type { AuditEvent, OutputTruncation } from "../domain/audit.js";
import { createAuditEvent } from "../domain/audit.js";

/**
 * 在内存中收集 GitCommandAudit，供应用层在 git 操作完成后一次性把
 * 所有命令审计写入 SQLite audit_events（P1-03）。
 *
 * 收集器本身不写库——它只是一个缓冲区；写库必须在调用方
 * （WorktreeManager / EvidenceCollector）的 UnitOfWork 事务内完成，
 * 避免与事务语义冲突。
 */
export class BufferedGitCommandAuditSink implements GitCommandAuditSink {
  private readonly buffer: GitCommandAudit[] = [];

  record(audit: GitCommandAudit): void {
    this.buffer.push(audit);
  }

  /** 取出收集到的所有命令审计（不清空，调用方负责不复用）。 */
  drain(): readonly GitCommandAudit[] {
    return [...this.buffer];
  }
}

/**
 * 把收集到的 GitCommandAudit 逐条写入 SQLite audit_events（P1-03）。
 *
 * 每条命令审计生成一个 `command_executed` 事件，包含 argv、cwd、
 * exitCode、outputTruncation。敏感环境变量值永不记录（由 Adapter
 * 上报时仅含 argv/cwd/exitCode/截断信息）。
 *
 * 用单独事务批量追加，避免与 attachWorktree / detachWorktree /
 * gatherEvidenceAndCreatePack 等事务交错；那些事务已提交，本事务只追加
 * 审计。
 */
export async function flushGitCommandAudits(
  unitOfWork: UnitOfWork,
  taskId: string,
  audits: readonly GitCommandAudit[]
): Promise<void> {
  if (audits.length === 0) return;
  await unitOfWork.run(async (tx) => {
    for (const audit of audits) {
      const event = buildCommandExecutedAuditEvent(taskId, audit);
      await tx.audit.append(event);
    }
  });
}

/**
 * 把单条 GitCommandAudit 转换为 `command_executed` 审计事件（P1-03）。
 *
 * reason 字段携带 argv 摘要与 cwd，便于在审计时间线中人类可读；
 * 结构化字段 executedArgv / executedCwd / exitCode / outputTruncation
 * 供程序化审计回溯。
 */
export function buildCommandExecutedAuditEvent(
  taskId: string,
  audit: GitCommandAudit
): AuditEvent {
  const argvSummary = audit.argv.join(" ");
  const truncation: OutputTruncation = {
    originalBytes: audit.outputTruncation.originalBytes,
    retainedBytes: audit.outputTruncation.retainedBytes,
    truncated: audit.outputTruncation.truncated
  };
  return createAuditEvent({
    taskId,
    type: "command_executed",
    executedArgv: audit.argv,
    executedCwd: audit.cwd,
    exitCode: audit.exitCode,
    outputTruncation: truncation,
    reason: `git 命令: ${argvSummary} (cwd=${audit.cwd}, exit=${audit.exitCode})`
  });
}

/**
 * GitAdapter 类型别名，便于在服务签名中引用（避免重复导入）。
 */
export type { GitAdapter };
