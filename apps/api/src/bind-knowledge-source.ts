/**
 * 已登记项目的 SAG Source 绑定入口。
 *
 * 此命令不会连接 SAG。它只把操作者显式提供的 Source ID 写入 SQLite，供
 * 后续人工批准的 Repair Record 通过 outbox 异步镜像；因此失败不会影响
 * 既有 Repair Memory 或任务状态。
 */

import { buildCompositionRoot } from "./composition-root.js";
import {
  bindProjectKnowledgeSource,
  ProjectRegistrationError
} from "./project-registration.js";

const HELP = `
绑定本地 SAG Source：只更新已登记项目的可选知识源配置，不连接 SAG。

用法：
  pnpm --filter @tracepilot/api run bind-knowledge-source -- --project-id <项目 ID> --knowledge-source-id <SAG Source ID>

参数：
  --project-id           已登记项目的 ID
  --knowledge-source-id  本机 SAG 中手工创建的项目独立 Source ID
`;

async function main(): Promise<void> {
  let root: ReturnType<typeof buildCompositionRoot> | undefined;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (!parsed) {
      process.stdout.write(HELP);
      return;
    }
    root = buildCompositionRoot();
    const project = await bindProjectKnowledgeSource(root.store, parsed);
    process.stdout.write(`${JSON.stringify({ message: "SAG Source 已绑定", project }, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    process.stderr.write(`绑定 SAG Source 失败：${message}\n`);
    process.exitCode = error instanceof ProjectRegistrationError ? 2 : 1;
  } finally {
    await root?.close();
  }
}

function parseArgs(argv: readonly string[]): { readonly projectId: string; readonly knowledgeSourceId: string } | undefined {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return undefined;
  if (argv.length !== 4) throw new ProjectRegistrationError("参数无效；请使用 --help 查看受支持的成对参数");
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      (option !== "--project-id" && option !== "--knowledge-source-id") ||
      !value ||
      values.has(option)
    ) {
      throw new ProjectRegistrationError("参数无效；请使用 --help 查看受支持的成对参数");
    }
    values.set(option, value);
  }
  const projectId = values.get("--project-id");
  const knowledgeSourceId = values.get("--knowledge-source-id");
  if (!projectId || !knowledgeSourceId) {
    throw new ProjectRegistrationError("--project-id 与 --knowledge-source-id 均为必填参数");
  }
  return { projectId, knowledgeSourceId };
}

void main();
