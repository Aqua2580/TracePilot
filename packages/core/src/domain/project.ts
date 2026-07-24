/**
 * Project 领域模型 —— 详见 IMPLEMENTATION_SPEC §5.1。
 *
 * 一个已注册的本地 Git 仓库，TracePilot 被允许在其上执行操作。
 * repositoryPath 在注册时被解析和校验；argv 数组是固定的白名单，
 * 绝不能从 issue 文本、失败日志或模型输出拼接而来（见 §5.1、§7.2）。
 */

export type ProjectLanguage = "python" | "typescript";

/**
 * 命令规格始终是 argv 数组，绝不是 shell 字符串。
 * `timeoutMs` 由 ProcessRunner 强制执行，而非由调用方强制。
 */
export interface CommandSpec {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

export interface ProjectCommands {
  readonly lint?: CommandSpec;
  readonly typecheck?: CommandSpec;
  readonly test: CommandSpec;
  readonly build?: CommandSpec;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  /** 已解析、已校验的本地 Git 工作树绝对路径。 */
  readonly repositoryPath: string;
  readonly defaultBranch: string;
  readonly language: ProjectLanguage;
  readonly commands: ProjectCommands;
  /** 可选的 SAG 知识源引用 —— 仅从 Phase 7+ 开始使用。 */
  readonly knowledgeSourceId?: string;
  readonly createdAt: string;
}

/**
 * 由 GitAdapter.validateRepository 返回的最小仓库信息。
 * 在项目注册时使用，用于确认路径是真实的 Git 仓库，并捕获当前分支 /
 * commit 以供审计。
 */
export interface RepositoryInfo {
  readonly repositoryPath: string;
  readonly defaultBranch: string;
  readonly headCommitSha: string;
  readonly isClean: boolean;
}

/**
 * Project 构造的校验错误。这些是程序员 / 配置错误，而非领域状态流转 ——
 * 它们同步抛出异常，而不是生成 Result 类型。
 */
export class ProjectValidationError extends Error {
  constructor(
    message: string,
    readonly field: keyof Project | "commands" | "argv"
  ) {
    super(message);
    this.name = "ProjectValidationError";
  }
}

/**
 * Project 的纯工厂。将构造集中在此处可使 "argv 是固定白名单"
 * 这一不变式保持在唯一位置 —— 调用方无法在不经过此工厂的情况下
 * 将动态字符串偷运进 CommandSpec。
 */
export function createProject(input: {
  id: string;
  name: string;
  repositoryPath: string;
  defaultBranch: string;
  language: ProjectLanguage;
  commands: ProjectCommands;
  knowledgeSourceId?: string;
  createdAt?: string;
}): Project {
  if (!input.id) throw new ProjectValidationError("id 为必填", "id");
  if (!input.name) throw new ProjectValidationError("name 为必填", "name");
  if (!input.repositoryPath)
    throw new ProjectValidationError("repositoryPath 为必填", "repositoryPath");
  if (!input.defaultBranch)
    throw new ProjectValidationError("defaultBranch 为必填", "defaultBranch");

  validateCommandSpec(input.commands.test, "test");
  if (input.commands.lint) validateCommandSpec(input.commands.lint, "lint");
  if (input.commands.typecheck)
    validateCommandSpec(input.commands.typecheck, "typecheck");
  if (input.commands.build) validateCommandSpec(input.commands.build, "build");

  return {
    id: input.id,
    name: input.name,
    repositoryPath: input.repositoryPath,
    defaultBranch: input.defaultBranch,
    language: input.language,
    commands: input.commands,
    knowledgeSourceId: input.knowledgeSourceId,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}

function validateCommandSpec(
  spec: CommandSpec | undefined,
  label: string
): void {
  if (!spec) throw new ProjectValidationError(`${label} 命令缺失`, "commands");
  if (!Array.isArray(spec.argv) || spec.argv.length === 0)
    throw new ProjectValidationError(`${label}.argv 必须是非空数组`, "argv");
  for (const a of spec.argv) {
    if (typeof a !== "string" || a.length === 0)
      throw new ProjectValidationError(
        `${label}.argv 元素必须是非空字符串`,
        "argv"
      );
  }
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0)
    throw new ProjectValidationError(
      `${label}.timeoutMs 必须是正有限数`,
      "commands"
    );
}
