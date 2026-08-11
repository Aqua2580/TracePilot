/**
 * Phase 6 浏览器与 SSE 测试共用的受控演示夹具。
 *
 * 夹具创建真实临时 Git 仓库与 SQLite 数据库，但 Runtime 使用显式注入的
 * `DashboardDemoRuntimeAdapter`。它只在测试组合根的 runtimeOverride 中
 * 生效，不会进入生产装配，也不会调用外部模型。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ReviewResult,
  ReviewTaskInput,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeTaskInput
} from "@tracepilot/core";
import { buildCompositionRoot, type CompositionRoot } from "../../src/composition-root.js";
import type { Project } from "@tracepilot/core";

export const DASHBOARD_DEMO_HUMAN_SECRET = "phase6-dashboard-human-approval-secret-32chars";

export interface DashboardDemoFixture {
  readonly root: CompositionRoot;
  readonly directory: string;
  readonly repositoryPath: string;
  readonly project: Project;
  cleanup(): Promise<void>;
}

/**
 * 仅用于 Phase 6 测试的明确降级 Runtime。
 *
 * 它把 `src/status.txt` 从 broken 改成 fixed，随后由真实 worktree Diff 和
 * 项目验证脚本确认结果。生产环境不会传入 runtimeOverride，仍按 Omp/降级
 * 装配规则运行。
 */
class DashboardDemoRuntimeAdapter implements RuntimeAdapter {
  async *analyze(input: RuntimeTaskInput): AsyncIterable<RuntimeEvent> {
    const runId = `dashboard-analyze-${input.taskId}`;
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    yield {
      type: "progress",
      runId,
      message: "Dashboard 测试替身已完成受控分析",
      at: new Date().toISOString()
    };
    yield { type: "completed", runId, summary: "测试替身分析完成", at: new Date().toISOString() };
  }

  async *develop(input: RuntimeTaskInput): AsyncIterable<RuntimeEvent> {
    const runId = `dashboard-develop-${input.taskId}`;
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    // 测试夹具只在 Plan.allowedPaths 中的 src/status.txt 写入，随后仍经过
    // 真实 worktree Diff、文件系统守卫和服务端验证，不能跳过这些边界。
    writeFileSync(join(input.worktreePath, "src", "status.txt"), "fixed\n", "utf8");
    yield {
      type: "progress",
      runId,
      message: "Dashboard 测试替身已写入允许路径",
      at: new Date().toISOString()
    };
    yield { type: "completed", runId, summary: "测试替身开发完成", at: new Date().toISOString() };
  }

  async review(input: ReviewTaskInput): Promise<ReviewResult> {
    const rootCause = input.evidencePack.hypotheses[0];
    if (!rootCause) throw new Error("测试演示必须先在 Dashboard 通过 Evidence Request 创建根因");
    return {
      verdict: "ship",
      findings: [],
      summary: "测试替身 Reviewer：受控 Diff 与验证均已通过",
      rootCause,
      fixSummary: "将状态文件改为 fixed，并由项目验证脚本确认",
      applicabilityConditions: [...input.evidencePack.constraints]
    };
  }

  async cancel(_runId: string): Promise<void> {
    // 该测试替身是短同步流程；接口仍完整实现，供取消路径安全调用。
  }
}

export async function createDashboardDemoFixture(options?: {
  readonly dashboardDistPath?: string;
}): Promise<DashboardDemoFixture> {
  const directory = mkdtempSync(join(tmpdir(), "tracepilot-phase6-dashboard-"));
  const repositoryPath = join(directory, "repository");
  mkdirSync(join(repositoryPath, "src"), { recursive: true });
  mkdirSync(join(repositoryPath, "scripts"), { recursive: true });
  writeFileSync(join(repositoryPath, "src", "status.txt"), "broken\n", "utf8");
  writeFileSync(
    join(repositoryPath, "scripts", "verify.mjs"),
    [
      'import { readFile } from "node:fs/promises";',
      'const value = await readFile(new URL("../src/status.txt", import.meta.url), "utf8");',
      'if (value !== "fixed\\n") {',
      '  console.error(`期望 fixed，实际为 ${JSON.stringify(value)}`);',
      '  process.exit(1);',
      '}',
      'console.log("验证通过：状态已修复");'
    ].join("\n"),
    "utf8"
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: repositoryPath, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repositoryPath, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=TracePilot Test", "-c", "user.email=tracepilot@example.invalid", "commit", "-m", "initial"],
    { cwd: repositoryPath, stdio: "ignore" }
  );

  const project: Project = {
    id: "proj-phase6-dashboard-demo",
    name: "Phase 6 Dashboard 合成项目",
    repositoryPath,
    defaultBranch: "main",
    language: "typescript",
    commands: {
      test: { argv: [process.execPath, "scripts/verify.mjs"], timeoutMs: 30000 }
    },
    createdAt: "2026-08-10T00:00:00.000Z"
  };
  const root = buildCompositionRoot({
    dbPath: join(directory, "dashboard.db"),
    worktreeRoot: join(directory, "worktrees"),
    dashboardDistPath: options?.dashboardDistPath,
    humanApprovalIdentity: "dashboard-product-owner",
    humanApprovalChannelSecret: DASHBOARD_DEMO_HUMAN_SECRET,
    runtimeOverride: new DashboardDemoRuntimeAdapter(),
    skipEnvFile: true
  });
  await root.store.unitOfWork.run((tx) => tx.projects.save(project));

  return {
    root,
    directory,
    repositoryPath,
    project,
    async cleanup(): Promise<void> {
      await root.close();
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Windows 短暂文件锁不影响测试结论。
      }
    }
  };
}
