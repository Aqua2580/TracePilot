/**
 * 受控项目登记集成测试。
 *
 * 测试只创建临时 Git 仓库和临时 SQLite；它验证登记不会执行项目命令，
 * 且非仓库、脏仓库、危险命令与重复登记均被拒绝。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompositionRoot, type CompositionRoot } from "../src/composition-root.js";
import {
  deriveProjectId,
  ProjectRegistrationError,
  registerProject
} from "../src/project-registration.js";

describe("受控项目登记", () => {
  let directory: string;
  let repositoryPath: string;
  let root: CompositionRoot;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "tracepilot-project-registration-"));
    repositoryPath = join(directory, "repository");
    mkdirSync(repositoryPath);
    writeFileSync(join(repositoryPath, "README.md"), "# 临时项目\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repositoryPath, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=TracePilot Test", "-c", "user.email=tracepilot@example.invalid", "commit", "-m", "initial"],
      { cwd: repositoryPath, stdio: "ignore" }
    );
    root = buildCompositionRoot({
      dbPath: join(directory, "tracepilot.db"),
      worktreeRoot: join(directory, "worktrees"),
      skipEnvFile: true
    });
  });

  afterEach(async () => {
    await root.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("只登记明确指定的干净 Git 根目录与固定白名单", async () => {
    const project = await registerProject(root.store, {
      name: "临时 TypeScript 项目",
      repositoryPath,
      language: "typescript",
      commands: {
        test: { argv: ["pnpm", "test"], timeoutMs: 300000 },
        lint: { argv: ["pnpm", "lint"], timeoutMs: 300000 },
        typecheck: { argv: ["pnpm", "typecheck"], timeoutMs: 300000 }
      }
    });

    expect(project.id).toBe(deriveProjectId(repositoryPath));
    expect(project.repositoryPath).toBe(repositoryPath);
    expect(project.defaultBranch).toBe("main");
    await expect(root.store.unitOfWork.run((tx) => tx.projects.findById(project.id))).resolves.toEqual(project);

    const listed = await root.app.inject({ method: "GET", url: "/projects" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ projects: [{ id: project.id, name: project.name }] });
  });

  it("拒绝重复路径、仓库子目录、脏仓库和危险命令", async () => {
    await registerProject(root.store, {
      name: "首次登记",
      repositoryPath,
      language: "typescript",
      commands: { test: { argv: ["pnpm", "test"], timeoutMs: 300000 } }
    });
    await expect(registerProject(root.store, {
      name: "重复路径",
      repositoryPath,
      language: "typescript",
      commands: { test: { argv: ["pnpm", "test"], timeoutMs: 300000 } }
    })).rejects.toThrow("该仓库已登记");

    const childPath = join(repositoryPath, "src");
    mkdirSync(childPath);
    await expect(registerProject(root.store, {
      name: "仓库子目录",
      repositoryPath: childPath,
      language: "typescript",
      commands: { test: { argv: ["pnpm", "test"], timeoutMs: 300000 } }
    })).rejects.toThrow("仓库根目录");

    writeFileSync(join(repositoryPath, "dirty.txt"), "dirty\n", "utf8");
    await expect(registerProject(root.store, {
      id: "other-project",
      name: "脏仓库",
      repositoryPath,
      language: "typescript",
      commands: { test: { argv: ["pnpm", "test"], timeoutMs: 300000 } }
    })).rejects.toThrow("未提交修改");
    rmSync(join(repositoryPath, "dirty.txt"));

    await expect(registerProject(root.store, {
      id: "dangerous-project",
      name: "危险命令",
      repositoryPath,
      language: "typescript",
      commands: { test: { argv: ["git", "push"], timeoutMs: 300000 } }
    })).rejects.toBeInstanceOf(ProjectRegistrationError);
  });
});
