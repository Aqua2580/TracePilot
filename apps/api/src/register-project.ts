/**
 * `register-project` 命令行入口。
 *
 * 它只登记操作者明确输入的本地 Git 仓库；不会扫描磁盘、不会启动 Runtime、
 * 不会创建 worktree，也不会执行登记的测试命令。
 */

import type { ProjectCommands, ProjectLanguage } from "@tracepilot/core";
import { buildCompositionRoot } from "./composition-root.js";
import {
  ProjectRegistrationError,
  registerProject
} from "./project-registration.js";

interface ParsedArgs {
  readonly id?: string;
  readonly name: string;
  readonly repositoryPath: string;
  readonly language: ProjectLanguage;
  readonly commands: ProjectCommands;
  readonly knowledgeSourceId?: string;
}

const HELP = `
受控项目登记：先核验本地 Git 仓库，再把固定命令白名单写入 SQLite。

用法：
  pnpm --filter @tracepilot/api run register-project -- --path <绝对仓库路径> --name <项目名称> --language <python|typescript> --test-argv <JSON 数组> [可选命令]

必填参数：
  --path             Git 仓库根目录的绝对路径
  --name             Dashboard 中显示的项目名称
  --language         python 或 typescript
  --test-argv        固定测试 argv 的 JSON 数组，例如 '["pnpm","test"]'

可选参数：
  --id               项目 ID；缺省时按真实仓库路径生成稳定 ID
  --lint-argv        固定 lint argv 的 JSON 数组
  --typecheck-argv   固定类型检查 argv 的 JSON 数组
  --build-argv       固定构建 argv 的 JSON 数组
  --knowledge-source-id  Phase 7 可选：本地 SAG 中已创建的项目 Source ID
  --timeout-ms       每条登记命令的超时（毫秒，默认 300000，最大 600000）

限制：仓库必须干净；不接受仓库子目录、危险命令或重复登记。
`;

async function main(): Promise<void> {
  let root: ReturnType<typeof buildCompositionRoot> | undefined;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed === undefined) {
      process.stdout.write(HELP);
      return;
    }
    root = buildCompositionRoot();
    const project = await registerProject(root.store, parsed);
    process.stdout.write(
      `${JSON.stringify({
        message: "项目已受控登记，可刷新 Dashboard 开始创建任务",
        project
      }, null, 2)}\n`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    process.stderr.write(`项目登记失败：${message}\n`);
    process.exitCode = error instanceof ProjectRegistrationError ? 2 : 1;
  } finally {
    await root?.close();
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs | undefined {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return undefined;
  const values = new Map<string, string>();
  const accepted = new Set([
    "--id",
    "--path",
    "--name",
    "--language",
    "--test-argv",
    "--lint-argv",
    "--typecheck-argv",
    "--build-argv",
    "--knowledge-source-id",
    "--timeout-ms"
  ]);

  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option || !accepted.has(option) || value === undefined || values.has(option)) {
      throw new ProjectRegistrationError("参数无效；请使用 --help 查看受支持的成对参数");
    }
    values.set(option, value);
  }

  const name = required(values, "--name");
  const repositoryPath = required(values, "--path");
  const rawLanguage = required(values, "--language");
  if (rawLanguage !== "python" && rawLanguage !== "typescript") {
    throw new ProjectRegistrationError("--language 只能是 python 或 typescript");
  }
  const timeoutMs = parseTimeout(values.get("--timeout-ms"));
  const commands: ProjectCommands = {
    test: { argv: parseArgv(required(values, "--test-argv"), "--test-argv"), timeoutMs },
    ...(values.has("--lint-argv")
      ? { lint: { argv: parseArgv(required(values, "--lint-argv"), "--lint-argv"), timeoutMs } }
      : {}),
    ...(values.has("--typecheck-argv")
      ? { typecheck: { argv: parseArgv(required(values, "--typecheck-argv"), "--typecheck-argv"), timeoutMs } }
      : {}),
    ...(values.has("--build-argv")
      ? { build: { argv: parseArgv(required(values, "--build-argv"), "--build-argv"), timeoutMs } }
      : {})
  };
  return {
    ...(values.has("--id") ? { id: required(values, "--id") } : {}),
    name,
    repositoryPath,
    language: rawLanguage,
    commands,
    ...(values.has("--knowledge-source-id")
      ? { knowledgeSourceId: required(values, "--knowledge-source-id") }
      : {})
  };
}

function required(values: ReadonlyMap<string, string>, option: string): string {
  const value = values.get(option);
  if (!value) throw new ProjectRegistrationError(`${option} 为必填参数`);
  return value;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return 300_000;
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new ProjectRegistrationError("--timeout-ms 必须是 1 到 600000 的整数");
  }
  return timeoutMs;
}

function parseArgv(value: string, option: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part: unknown) => typeof part !== "string")) {
      throw new Error("不是非空字符串数组");
    }
    return parsed as string[];
  } catch {
    throw new ProjectRegistrationError(`${option} 必须是 JSON 字符串数组，例如 '["pnpm","test"]'`);
  }
}

void main();
