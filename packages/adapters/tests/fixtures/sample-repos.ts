/**
 * 样例仓库夹具 —— Phase 3 任务 7.1。
 *
 * 在临时目录中用真实 git 二进制种出最小可用的 Python / TypeScript 仓库，
 * 供 LocalGitAdapter 集成测试与契约测试使用。夹具本身不受 ProcessRunner
 * 治理约束（它是测试基础设施），直接用 node:child_process 执行 git。
 *
 * Windows 路径全部用 node:path.join 拼接，不硬编码分隔符。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface SampleRepo {
  readonly repoPath: string;
  readonly worktreeRoot: string;
}

/**
 * 创建 Python 样例仓库。
 *
 * 在 tmpRoot 下创建 python-repo（含 pytest.ini / src/sample.py /
 * tests/test_sample.py）与 python-worktrees（worktree 受控根目录），
 * 用 git init -b main 初始化仓库并提交一次。
 */
export async function createPythonSampleRepo(tmpRoot: string): Promise<SampleRepo> {
  const repoPath = join(tmpRoot, "python-repo");
  const worktreeRoot = join(tmpRoot, "python-worktrees");

  mkdirSync(repoPath, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  runGit(["init", "-b", "main"], repoPath);
  runGit(["config", "user.email", "test@example.com"], repoPath);
  runGit(["config", "user.name", "Test User"], repoPath);
  // 关闭自动换行转换，保证 Windows / POSIX 下 diff 输出一致
  runGit(["config", "core.autocrlf", "false"], repoPath);

  writeFileSync(join(repoPath, "pytest.ini"), "[pytest]\ntestpaths = tests\n");
  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(join(repoPath, "src", "sample.py"), "def add(a, b):\n    return a + b\n");
  mkdirSync(join(repoPath, "tests"), { recursive: true });
  writeFileSync(
    join(repoPath, "tests", "test_sample.py"),
    "from src.sample import add\n\ndef test_add():\n    assert add(1, 2) == 3\n"
  );

  runGit(["add", "."], repoPath);
  runGit(["commit", "-m", "初始提交：python 样例仓库"], repoPath);

  return { repoPath, worktreeRoot };
}

/**
 * 创建 TypeScript 样例仓库。
 *
 * 在 tmpRoot 下创建 typescript-repo（含 package.json / tsconfig.json /
 * src/index.ts）与 typescript-worktrees（worktree 受控根目录），
 * 用 git init -b main 初始化仓库并提交一次。
 */
export async function createTypescriptSampleRepo(tmpRoot: string): Promise<SampleRepo> {
  const repoPath = join(tmpRoot, "typescript-repo");
  const worktreeRoot = join(tmpRoot, "typescript-worktrees");

  mkdirSync(repoPath, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });

  runGit(["init", "-b", "main"], repoPath);
  runGit(["config", "user.email", "test@example.com"], repoPath);
  runGit(["config", "user.name", "Test User"], repoPath);
  runGit(["config", "core.autocrlf", "false"], repoPath);

  writeFileSync(
    join(repoPath, "package.json"),
    '{"name": "sample-ts", "version": "1.0.0", "scripts": {"test": "vitest run"}}\n'
  );
  writeFileSync(
    join(repoPath, "tsconfig.json"),
    '{"compilerOptions": {"target": "ES2022", "strict": true}}\n'
  );
  mkdirSync(join(repoPath, "src"), { recursive: true });
  writeFileSync(
    join(repoPath, "src", "index.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n"
  );

  runGit(["add", "."], repoPath);
  runGit(["commit", "-m", "初始提交：typescript 样例仓库"], repoPath);

  return { repoPath, worktreeRoot };
}

/**
 * 清理临时仓库目录。
 *
 * Windows 下 git 进程可能短暂持有文件锁，因此重试最多 3 次。
 * 重试用尽后忽略错误——临时目录不阻塞测试结果。
 */
export function cleanupSampleRepo(tmpRoot: string): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
      return;
    } catch {
      if (attempt < 2) {
        // 同步短暂等待，缓解 Windows 文件锁
        const until = Date.now() + 100;
        while (Date.now() < until) {
          // busy-wait：避免引入额外依赖
        }
      }
    }
  }
}

/** 执行 git 命令（夹具专用，不经 ProcessRunner 治理）。 */
function runGit(args: readonly string[], cwd: string): void {
  execFileSync("git", [...args], {
    cwd,
    stdio: "ignore",
    encoding: "utf8"
  });
}
