/**
 * TracePilot API 入口。
 *
 * 在 TRACEPILOT_PORT（默认 7431）上启动 Fastify 服务，并执行 §3.1 / §5.2
 * 启动恢复：任何在启动时处于 EXECUTING 或 VALIDATING 的任务都被迁移到
 * INTERRUPTED —— 绝不静默标记为完成。
 */

import { buildCompositionRoot } from "./composition-root.js";

async function main(): Promise<void> {
  const { app, orchestrator, logger } = buildCompositionRoot();

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

  try {
    await app.listen({ port, host });
    logger.info({ port, host }, "TracePilot API 已监听");
  } catch (err) {
    logger.error({ err }, "TracePilot API 启动失败");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("致命启动错误：", err);
  process.exit(1);
});
