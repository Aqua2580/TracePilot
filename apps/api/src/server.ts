/**
 * TracePilot API 入口。
 *
 * 在 TRACEPILOT_PORT（默认 7431）上启动 Fastify 服务，并执行 §3.1 / §5.2
 * 启动恢复：任何在启动时处于 EXECUTING 或 VALIDATING 的任务都被迁移到
 * INTERRUPTED —— 绝不静默标记为完成。
 *
 * Phase 2（P1-01）：组合根使用 SqliteStore，启动恢复在真实磁盘库上生效；
 * 进程退出时关闭 Fastify 与 SQLite 连接。
 */

import { buildCompositionRoot } from "./composition-root.js";

async function main(): Promise<void> {
  const root = buildCompositionRoot();
  const { app, orchestrator, logger } = root;

  // §5.2 启动恢复 —— 永远不为中断的流程声明成功。
  const recovered = await orchestrator.recoverInterruptedTasks();
  if (recovered.length > 0) {
    logger.warn(
      { count: recovered.length, taskIds: recovered.map((t) => t.id) },
      "启动时恢复中断任务（已迁移到 INTERRUPTED）"
    );
  }

  const port = Number(process.env.TRACEPILOT_PORT ?? 7431);
  const host = process.env.TRACEPILOT_HOST ?? "127.0.0.1";

  // 进程信号处理：关闭 Fastify 与 SQLite，避免 WAL 残留。
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "收到退出信号，开始关闭服务");
    try {
      await root.close();
    } catch (err) {
      logger.error({ err }, "关闭服务时出错");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port, host });
    logger.info({ port, host }, "TracePilot API 已监听");
  } catch (err) {
    logger.error({ err }, "TracePilot API 启动失败");
    await root.close();
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error("致命启动错误：", err);
  process.exit(1);
});
