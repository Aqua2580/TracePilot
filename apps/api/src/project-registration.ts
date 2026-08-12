/**
 * 受控项目登记服务。
 *
 * Dashboard 只能读取 SQLite 中已经登记的项目，不能扫描操作者电脑。本服务
 * 是唯一的登记入口：操作者在本机命令行明确指定仓库和固定命令白名单后，
 * 服务先用受治理的只读 Git Adapter 核验仓库，再写入 SQLite。
 */

import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  createProject,
  type Project,
  type ProjectCommands,
  type ProjectLanguage
} from "@tracepilot/core";
import { LocalGitAdapter, LocalProcessRunner } from "@tracepilot/adapters";
import { defaultGovernancePolicies } from "@tracepilot/governance";
import type { SqliteStore } from "@tracepilot/store";

const REGISTRATION_TIMEOUT_MS = 60_000;
const REGISTRATION_OUTPUT_LIMIT = 256 * 1024;
const MAX_COMMAND_TIMEOUT_MS = 10 * 60_000;

export interface ProjectRegistrationInput {
  readonly id?: string;
  readonly name: string;
  readonly repositoryPath: string;
  readonly language: ProjectLanguage;
  readonly commands: ProjectCommands;
  /** Phase 7：操作者在本地 SAG 中预先创建并明确绑定的项目 Source。 */
  readonly knowledgeSourceId?: string;
}

/** 供 CLI 把可读错误返回给操作者，避免暴露未处理异常栈。 */
export class ProjectRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRegistrationError";
  }
}

/**
 * 核验并登记单个本地 Git 项目。
 *
 * 这里特意不复用已经登记项目的服务缓存：在登记前，仓库尚不在数据库中。
 * 只把操作者显式给出的、已解析的目录作为本次只读 Git Adapter 的唯一根目录；
 * 成功写入后，后续 worktree、证据与 Runtime 才会从 SQLite 重新取得该授权。
 */
export async function registerProject(
  store: SqliteStore,
  input: ProjectRegistrationInput
): Promise<Project> {
  const repositoryPath = resolveRepositoryPath(input.repositoryPath);
  const name = validateName(input.name);
  validateCommands(input.commands);

  const policies = defaultGovernancePolicies();
  for (const command of Object.values(input.commands)) {
    if (!command) continue;
    const decision = policies.command.decide(command.argv, input.commands);
    if (!decision.allowed) {
      throw new ProjectRegistrationError(`命令不允许登记：${decision.reason}`);
    }
  }

  const gitAdapter = new LocalGitAdapter({
    processRunner: new LocalProcessRunner(),
    commandPolicy: policies.command,
    pathPolicy: policies.path,
    processPolicy: {
      timeoutMs: REGISTRATION_TIMEOUT_MS,
      maxOutputBytes: REGISTRATION_OUTPUT_LIMIT,
      allowedCwdRoots: [repositoryPath],
      inheritEnv: false
    },
    allowedWorktreeRoots: [],
    allowedRepositoryRoots: [repositoryPath],
    projectCommands: input.commands
  });
  const repository = await gitAdapter.validateRepository(repositoryPath);
  if (normalizePathIdentity(repository.repositoryPath) !== normalizePathIdentity(repositoryPath)) {
    throw new ProjectRegistrationError(
      "登记路径必须是 Git 仓库根目录，不能填写仓库内的子目录"
    );
  }
  if (!repository.isClean) {
    throw new ProjectRegistrationError("仓库存在未提交修改；请先提交或 stash 后再登记");
  }

  const project = createProject({
    id: validateProjectId(input.id ?? defaultProjectId(repositoryPath)),
    name,
    repositoryPath,
    defaultBranch: repository.defaultBranch,
    language: input.language,
    commands: input.commands,
    ...(input.knowledgeSourceId
      ? { knowledgeSourceId: validateKnowledgeSourceId(input.knowledgeSourceId) }
      : {})
  });

  await store.unitOfWork.run(async (tx) => {
    const existingByPath = (await tx.projects.findAll()).find(
      (candidate) => candidate.repositoryPath === project.repositoryPath
    );
    if (existingByPath) {
      throw new ProjectRegistrationError(
        `该仓库已登记为项目：${existingByPath.name}（${existingByPath.id}）`
      );
    }
    const existingById = await tx.projects.findById(project.id);
    if (existingById) {
      throw new ProjectRegistrationError(`项目 ID 已存在：${project.id}`);
    }
    await tx.projects.save(project);
  });

  return project;
}

function resolveRepositoryPath(value: string): string {
  if (!value || typeof value !== "string" || !isAbsolute(value)) {
    throw new ProjectRegistrationError("--path 必须是已存在的绝对本地路径");
  }
  let resolved: string;
  try {
    resolved = realpathSync(value);
  } catch {
    throw new ProjectRegistrationError("--path 不存在或无法解析真实路径");
  }
  try {
    if (!statSync(resolved).isDirectory()) {
      throw new ProjectRegistrationError("--path 必须指向目录");
    }
  } catch (error) {
    if (error instanceof ProjectRegistrationError) throw error;
    throw new ProjectRegistrationError("--path 无法读取目录信息");
  }
  return resolved;
}

function validateName(value: string): string {
  const name = value?.trim();
  if (!name || name.length > 120) {
    throw new ProjectRegistrationError("--name 必须是 1 到 120 个字符");
  }
  return name;
}

function validateProjectId(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new ProjectRegistrationError("--id 只能使用小写字母、数字和连字符，长度为 1 到 64");
  }
  return value;
}

/**
 * 为已经受控登记的项目绑定本地 SAG Source。
 *
 * 该操作只更新 SQLite 中的项目配置，不访问 SAG、不会补写历史记录，也不会
 * 改变项目的路径、分支或固定命令白名单。后续新批准的 Repair Record 才会进入
 * 对应 Source 的异步 outbox。
 */
export async function bindProjectKnowledgeSource(
  store: Pick<SqliteStore, "unitOfWork">,
  input: { readonly projectId: string; readonly knowledgeSourceId: string }
): Promise<Project> {
  const projectId = input.projectId.trim();
  if (!projectId) throw new ProjectRegistrationError("项目 ID 不能为空");
  const knowledgeSourceId = validateKnowledgeSourceId(input.knowledgeSourceId);

  return store.unitOfWork.run(async (tx) => {
    const project = await tx.projects.findById(projectId);
    if (!project) throw new ProjectRegistrationError("项目不存在，不能绑定 SAG Source");
    const updated: Project = { ...project, knowledgeSourceId };
    await tx.projects.save(updated);
    return updated;
  });
}

function validateKnowledgeSourceId(value: string): string {
  const sourceId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sourceId)) {
    throw new ProjectRegistrationError(
      "--knowledge-source-id 只能使用字母、数字、点、下划线、连字符和冒号，长度为 1 到 128"
    );
  }
  return sourceId;
}

function validateCommands(commands: ProjectCommands): void {
  for (const [name, command] of Object.entries(commands)) {
    if (!command) continue;
    if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.length > 32) {
      throw new ProjectRegistrationError(`${name} 命令的 argv 必须是 1 到 32 项的数组`);
    }
    if (command.argv.some((part: string) => part.length === 0 || part.length > 1024)) {
      throw new ProjectRegistrationError(`${name} 命令的 argv 元素必须是 1 到 1024 个字符`);
    }
    if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
      throw new ProjectRegistrationError(`${name} 命令的 timeoutMs 必须是 1 到 600000 的整数`);
    }
  }
}

function defaultProjectId(repositoryPath: string): string {
  const normalized = normalizePathIdentity(repositoryPath);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `proj-${digest}`;
}

/** 仅供测试断言默认 ID 对同一真实仓库稳定。 */
export function deriveProjectId(repositoryPath: string): string {
  return defaultProjectId(repositoryPath);
}

/** Git 在 Windows 常返回 `/`，Node realpath 常返回 `\\`；两者都按同一目录比较。 */
function normalizePathIdentity(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}
