/**
 * WorktreeFilesystemGuard 真实文件系统对抗性测试 —— P1-R01-C
 * （Phase 4 第三轮验收 §7.2 第 3 点）。
 *
 * 验收报告 §7.2 关闭要求第 3 点：「新增真实 Runtime 对抗性测试：在
 * `rawSource` 中注入绝对路径、`..`、符号链接逃逸、白名单外读写请求，
 * 断言副作用未发生，并能在审计中看到 `policy_denied`。该测试不能以
 * FakeGitAdapter 的手工 Diff 代替。」
 *
 * 本测试使用真实文件系统（`node:fs` + `os.tmpdir()`）创建临时 worktree
 * 目录，用 `LocalWorktreeFilesystemGuard` 做快照/检测/回滚，验证：
 *
 * 1. **白名单外文件新增**：Omp 在 allowedPaths 之外创建文件 → 检测为
 *    added 越界 → 回滚删除 → 副作用消失。
 * 2. **白名单外文件修改**：Omp 修改 allowedPaths 之外的已存在文件 →
 *    检测为 modified 越界 → 回滚恢复原内容。
 * 3. **白名单外文件删除**：Omp 删除 allowedPaths 之外的已存在文件 →
 *    检测为 deleted 越界 → 回滚恢复文件。
 * 4. **白名单外符号链接创建**：Omp 创建指向 worktree 外部的符号链接 →
 *    检测为 added 越界 → 回滚删除符号链接。
 * 5. **符号链接逃逸（type-changed）**：Omp 把 allowedPaths 内的常规文件
 *    替换为指向外部的符号链接 → 检测为 type-changed 越界 → 回滚恢复
 *    原始常规文件。
 * 6. **合法变更不受影响**：Omp 在 allowedPaths 内修改文件 → 不视为越界 →
 *    不回滚。
 * 7. **集成 ExecutionOrchestrator.runDevelop**：注入 LocalWorktreeFilesystemGuard
 *    后，真实文件系统越界写入触发 PathScopeViolationError + policy_denied 审计。
 *
 * 不使用 FakeGitAdapter 伪造 Diff —— 直接在真实文件系统上操作。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
  lstatSync,
  symlinkSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalWorktreeFilesystemGuard } from "../src/local-worktree-filesystem-guard.js";
import {
  ExecutionOrchestrator,
  TaskOrchestrator,
  WorktreeManager,
  createInMemoryStore,
  PathScopeViolationError,
  isProtectedPath,
  isSymlinkTargetOutsideWorktree,
  type TaskInput,
  type Project,
  type ProjectCommands,
  type PlanNode,
  type Worktree,
  type RuntimeEvent,
  type RuntimeAdapter,
  type RuntimeTaskInput,
  type ReviewTaskInput,
  type ReviewResult,
  type InMemoryStore,
  type AgentRunRecord,
  type ProcessPolicy,
  type WorktreeFilesystemGuard,
  type FilesystemSnapshot,
  type FilesystemChange,
  type ExecutionIsolationLease,
  type SymlinkEscapeWatcher,
  type SymlinkEscapeViolation
} from "@tracepilot/core";
import { FakeGitAdapter, FakeProcessRunner } from "../src/index.js";
import type { RuntimeEventSink } from "@tracepilot/core";

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function sampleTaskInput(): TaskInput {
  return {
    objective: "修复 createUser 返回错误状态码",
    constraints: ["仅修改 src/users.py"],
    acceptanceCriteria: ["pytest tests/test_users.py 通过"],
    riskLevel: "low",
    rawSource: "FAILED test_create_user_returns_201 ...",
    origin: "failed_test_log",
    failure: {
      testNames: ["test_create_user_returns_201"],
      errorTypes: ["AssertionError"],
      stackSummary: "assert result['status'] == 201, got 400"
    }
  };
}

const sampleCommands: ProjectCommands = {
  test: { argv: ["pytest"], timeoutMs: 30000 }
};

function sampleProject(): Project {
  return {
    id: "proj-fs-guard",
    name: "文件系统守卫测试项目",
    repositoryPath: "/tmp/tracepilot/repos/proj-fs-guard",
    defaultBranch: "main",
    language: "python",
    commands: sampleCommands,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function samplePlanNodes(packId: string): readonly PlanNode[] {
  return [
    {
      id: "node-1",
      label: "修复 createUser",
      description: "调整状态码",
      evidencePackId: packId,
      evidencePackVersion: 1
    }
  ];
}

/**
 * 创建真实临时 worktree 目录，含初始文件结构：
 * - src/users.py（allowedPaths 内）
 * - package.json（allowedPaths 外）
 * - tests/test_users.py（allowedPaths 外）
 */
function createRealWorktree(testDir: string, taskId: string): string {
  const worktreePath = join(testDir, "worktree-" + taskId);
  mkdirSync(join(worktreePath, "src"), { recursive: true });
  mkdirSync(join(worktreePath, "tests"), { recursive: true });
  writeFileSync(
    join(worktreePath, "src", "users.py"),
    "def create_user():\n    return {'status': 400}\n",
    "utf8"
  );
  writeFileSync(
    join(worktreePath, "package.json"),
    '{"name": "test-project"}\n',
    "utf8"
  );
  writeFileSync(
    join(worktreePath, "tests", "test_users.py"),
    "from src.users import create_user\n\ndef test():\n    assert create_user()['status'] == 201\n",
    "utf8"
  );
  return worktreePath;
}

function sampleWorktree(taskId: string, path: string): Worktree {
  return {
    id: "wt-fs-" + taskId,
    projectId: "proj-fs-guard",
    taskId,
    path,
    branch: "tracepilot/" + taskId,
    baseCommitSha: "abc123",
    allowedPaths: ["src/**"],
    createdAt: "2026-07-28T00:00:00.000Z"
  };
}

/**
 * 简单的 RuntimeEventSink 实现 —— 把事件收集到内存数组。
 */
class FakeRuntimeEventSink implements RuntimeEventSink {
  private readonly events = new Map<string, RuntimeEvent[]>();

  append(taskId: string, runId: string, role: string, event: RuntimeEvent): void {
    void role;
    const key = `${taskId}:${runId}`;
    const list = this.events.get(key) ?? [];
    list.push(event);
    this.events.set(key, list);
  }

  async flush(taskId: string, runId: string): Promise<AgentRunRecord | undefined> {
    const key = `${taskId}:${runId}`;
    const events = this.events.get(key) ?? [];
    if (events.length === 0) return undefined;
    const totalBytes = JSON.stringify(events).length;
    return {
      id: `ar-${runId}`,
      taskId,
      runId,
      role: "test",
      events,
      totalBytes,
      retainedBytes: totalBytes,
      truncated: false,
      contentHash: "fake-hash",
      startedAt: events[0]!.at ?? new Date().toISOString(),
      endedAt: events[events.length - 1]!.at ?? new Date().toISOString()
    };
  }
}

/**
 * 可编程的 RuntimeAdapter —— 在 develop 阶段执行自定义副作用（写文件等）。
 *
 * 用于模拟 Omp 在 worktree 中执行的真实文件系统操作。
 */
class ProgrammableRuntimeAdapter implements RuntimeAdapter {
  private developSideEffect?: (worktreePath: string, signal: AbortSignal) => Promise<void> | void;

  setDevelopSideEffect(fn: (worktreePath: string, signal: AbortSignal) => Promise<void> | void): void {
    this.developSideEffect = fn;
  }

  async *analyze(
    input: RuntimeTaskInput,
    _signal?: AbortSignal
  ): AsyncIterable<RuntimeEvent> {
    const runId = "analyze-" + Date.now();
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    yield { type: "completed", runId, at: new Date().toISOString(), summary: "analyze done" };
  }

  async *develop(
    input: RuntimeTaskInput,
    signal?: AbortSignal
  ): AsyncIterable<RuntimeEvent> {
    const runId = "develop-" + Date.now();
    yield { type: "started", runId, taskId: input.taskId, at: new Date().toISOString() };
    // 执行自定义副作用（模拟 Omp 的文件系统操作）
    // P1-R01 §11.2：执行期隔离使越界文件只读，writeFileSync 抛 EPERM。
    // 真实 Omp 的 edit/write 工具遇到 EPERM 会报告 tool_execution_end
    // with isError=true 但不终止会话。这里捕获错误模拟此行为，
    // 使 develop 会话继续，让事后快照/Diff 检测层能正常运行。
    //
    // §16 运行期符号链接逃逸监听：developSideEffect 现在是异步的，
    // 且接收 AbortSignal。测试可利用此信号在创建越界符号链接后
    // 等待 watcher 检测并 abort，然后检查 signal.aborted 决定是否
    // 继续后续操作（如通过链接写入外部目标）。
    if (this.developSideEffect) {
      try {
        await this.developSideEffect(input.worktreePath, signal ?? new AbortController().signal);
      } catch (err) {
        // 模拟 Omp 工具调用失败（如 EPERM）后会话继续
        void err;
      }
    }
    // 如果 signal 已 aborted（如 watcher 检测到符号链接逃逸），
    // 不产出 completed 事件 —— consumeStreamWithRegistration 和
    // assertStreamHealthy 会检测到未 completed 并失败关闭。
    if (signal?.aborted) {
      yield { type: "error", runId, at: new Date().toISOString(), message: "aborted by symlink escape watcher" };
      return;
    }
    yield { type: "completed", runId, at: new Date().toISOString(), summary: "develop done" };
  }

  async review(
    _input: ReviewTaskInput,
    _signal?: AbortSignal
  ): Promise<ReviewResult> {
    return {
      verdict: "ship",
      findings: [],
      summary: "review done"
    };
  }

  async cancel(_runId: string): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

interface RealFsTestFixture {
  readonly testDir: string;
  readonly store: InMemoryStore;
  readonly orchestrator: TaskOrchestrator;
  readonly runtime: ProgrammableRuntimeAdapter;
  readonly fakeGit: FakeGitAdapter;
  readonly fakeProcess: FakeProcessRunner;
  readonly guard: LocalWorktreeFilesystemGuard;
}

function createRealFsFixture(testDir: string): RealFsTestFixture {
  const store = createInMemoryStore();
  const orchestrator = new TaskOrchestrator({ unitOfWork: store.unitOfWork });
  const runtime = new ProgrammableRuntimeAdapter();
  const fakeGit = new FakeGitAdapter();
  const fakeProcess = new FakeProcessRunner();
  const guard = new LocalWorktreeFilesystemGuard();
  const worktreeManager = new WorktreeManager({
    gitAdapter: fakeGit,
    orchestrator,
    unitOfWork: store.unitOfWork
  });
  const sink = new FakeRuntimeEventSink();
  const processPolicy: ProcessPolicy = {
    allowedCwdRoots: [testDir],
    inheritEnv: false,
    maxOutputBytes: 1024 * 1024,
    timeoutMs: 30000,
    disallowCredentialVars: true
  };
  // 用闭包持有 exec，避免 this 引用问题
  const exec = new ExecutionOrchestrator({
    unitOfWork: store.unitOfWork,
    runtime,
    worktreeManager,
    eventSink: sink,
    processRunner: fakeProcess,
    processPolicy,
    filesystemGuard: guard
  });
  void exec;
  return { testDir, store, orchestrator, runtime, fakeGit, fakeProcess, guard };
}

/**
 * 把任务迁移到 EXECUTING 状态，并绑定真实 worktree 路径。
 */
async function moveToExecutingWithRealWorktree(
  fixture: RealFsTestFixture,
  taskId: string,
  worktreePath: string,
  allowedPaths: readonly string[]
): Promise<void> {
  const { orchestrator } = fixture;
  const worktree = sampleWorktree(taskId, worktreePath);
  // 覆盖 allowedPaths
  const wt: Worktree = { ...worktree, allowedPaths: [...allowedPaths] };
  await orchestrator.attachWorktree(taskId, wt);
  await orchestrator.transitionTask(taskId, "INTAKING");
  await orchestrator.transitionTask(taskId, "GATHERING_EVIDENCE");
  const packId = `pack-${taskId}`;
  await orchestrator.gatherEvidenceAndCreatePack({
    taskId,
    packId,
    evidence: [],
    acceptanceCriteria: []
  });
  await orchestrator.transitionTask(taskId, "PLANNED");
  await orchestrator.planTask({
    taskId,
    nodes: samplePlanNodes(packId),
    allowedPaths: [...allowedPaths],
    inputEvidencePackId: packId,
    inputEvidencePackVersion: 1
  });
  await orchestrator.transitionTask(taskId, "AWAITING_EXECUTION_APPROVAL");
  const scopeHash = await orchestrator.computeCurrentScopeHash(taskId);
  await orchestrator.recordApproval({
    taskId,
    kind: "execution",
    approver: "test-approver",
    decision: "approved",
    scopeHash
  });
  await orchestrator.beginExecutionIfApproved(taskId);
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe("LocalWorktreeFilesystemGuard P1-R01-C 真实文件系统对抗性测试", () => {
  let testDir: string;
  let fixture: RealFsTestFixture;

  beforeEach(async () => {
    // 每个测试用唯一临时目录
    testDir = join(tmpdir(), `tracepilot-fs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(testDir, { recursive: true });
    fixture = createRealFsFixture(testDir);
    await fixture.store.unitOfWork.run(async (tx) => {
      await tx.projects.save(sampleProject());
    });
  });

  afterEach(() => {
    // 清理临时目录
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // 直接测试 LocalWorktreeFilesystemGuard 的快照/检测/回滚能力
  // ==========================================================================
  describe("guard 直接测试：快照/检测/回滚", () => {
    it("白名单外文件新增：检测为 added 越界并回滚删除", async () => {
      const { guard } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-direct-1");

      const before = await guard.createSnapshot(worktreePath);
      // 模拟 Omp 在 allowedPaths 外创建文件
      writeFileSync(join(worktreePath, "evil.txt"), "malicious", "utf8");

      const after = await guard.createSnapshot(worktreePath);
      const changes = guard.detectChanges(before, after);

      // 断言：检测到 added 变更
      const added = changes.filter((c) => c.type === "added");
      expect(added.length).toBe(1);
      expect(added[0]!.relativePath).toBe("evil.txt");

      // 回滚
      await guard.rollback(before, added);

      // 断言：越界文件已被删除
      expect(existsSync(join(worktreePath, "evil.txt"))).toBe(false);

      await guard.dispose(before);
      await guard.dispose(after);
    });

    it("白名单外文件修改：检测为 modified 越界并回滚恢复原内容", async () => {
      const { guard } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-direct-2");
      const packageJsonPath = join(worktreePath, "package.json");
      const originalContent = readFileSync(packageJsonPath, "utf8");

      const before = await guard.createSnapshot(worktreePath);
      // 模拟 Omp 修改 allowedPaths 外的文件
      writeFileSync(packageJsonPath, '{"name": "tampered"}', "utf8");

      const after = await guard.createSnapshot(worktreePath);
      const changes = guard.detectChanges(before, after);

      // 断言：检测到 modified 变更
      const modified = changes.filter((c) => c.type === "modified");
      expect(modified.length).toBe(1);
      expect(modified[0]!.relativePath).toBe("package.json");

      // 回滚
      await guard.rollback(before, modified);

      // 断言：内容已恢复
      const restoredContent = readFileSync(packageJsonPath, "utf8");
      expect(restoredContent).toBe(originalContent);

      await guard.dispose(before);
      await guard.dispose(after);
    });

    it("白名单外文件删除：检测为 deleted 越界并回滚恢复文件", async () => {
      const { guard } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-direct-3");
      const packageJsonPath = join(worktreePath, "package.json");
      const originalContent = readFileSync(packageJsonPath, "utf8");

      const before = await guard.createSnapshot(worktreePath);
      // 模拟 Omp 删除 allowedPaths 外的文件
      rmSync(packageJsonPath);

      const after = await guard.createSnapshot(worktreePath);
      const changes = guard.detectChanges(before, after);

      // 断言：检测到 deleted 变更
      const deleted = changes.filter((c) => c.type === "deleted");
      expect(deleted.length).toBe(1);
      expect(deleted[0]!.relativePath).toBe("package.json");

      // 回滚
      await guard.rollback(before, deleted);

      // 断言：文件已恢复
      expect(existsSync(packageJsonPath)).toBe(true);
      const restoredContent = readFileSync(packageJsonPath, "utf8");
      expect(restoredContent).toBe(originalContent);

      await guard.dispose(before);
      await guard.dispose(after);
    });

    it("白名单外符号链接创建：检测为 added 越界并回滚删除", async () => {
      const { guard } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-direct-4");
      // 创建 worktree 外部目标文件（模拟逃逸目标）
      const externalTarget = join(testDir, "external-secret.txt");
      writeFileSync(externalTarget, "secret data", "utf8");

      const before = await guard.createSnapshot(worktreePath);
      // 模拟 Omp 创建指向 worktree 外部的符号链接
      const symlinkPath = join(worktreePath, "escape-link");
      try {
        symlinkSync(externalTarget, symlinkPath);
      } catch {
        // Windows 无 Developer Mode 时跳过符号链接测试
        await guard.dispose(before);
        return;
      }

      const after = await guard.createSnapshot(worktreePath);
      const changes = guard.detectChanges(before, after);

      // 断言：检测到 added 变更（符号链接）
      const added = changes.filter((c) => c.type === "added");
      expect(added.length).toBe(1);
      expect(added[0]!.relativePath).toBe("escape-link");
      expect(added[0]!.after?.isSymlink).toBe(true);

      // 回滚
      await guard.rollback(before, added);

      // 断言：符号链接已被删除
      expect(existsSync(symlinkPath)).toBe(false);

      await guard.dispose(before);
      await guard.dispose(after);
    });

    it("符号链接逃逸（type-changed）：常规文件被替换为符号链接时检测并回滚", async () => {
      const { guard } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-direct-5");
      const usersPyPath = join(worktreePath, "src", "users.py");
      const originalContent = readFileSync(usersPyPath, "utf8");
      const externalTarget = join(testDir, "external-evil.py");
      writeFileSync(externalTarget, "evil code", "utf8");

      const before = await guard.createSnapshot(worktreePath);
      // 模拟 Omp 把 allowedPaths 内的常规文件替换为指向外部的符号链接
      rmSync(usersPyPath);
      try {
        symlinkSync(externalTarget, usersPyPath);
      } catch {
        // Windows 无 Developer Mode 时跳过
        await guard.dispose(before);
        return;
      }

      const after = await guard.createSnapshot(worktreePath);
      const changes = guard.detectChanges(before, after);

      // 断言：检测到 type-changed 变更（常规文件 → 符号链接）
      const typeChanged = changes.filter((c) => c.type === "type-changed");
      expect(typeChanged.length).toBe(1);
      expect(typeChanged[0]!.relativePath).toBe("src/users.py");
      expect(typeChanged[0]!.before?.isSymlink).toBe(false);
      expect(typeChanged[0]!.after?.isSymlink).toBe(true);

      // 回滚
      await guard.rollback(before, typeChanged);

      // 断言：文件已恢复为常规文件，内容一致
      const lstat = lstatSync(usersPyPath);
      expect(lstat.isSymbolicLink()).toBe(false);
      expect(lstat.isFile()).toBe(true);
      const restoredContent = readFileSync(usersPyPath, "utf8");
      expect(restoredContent).toBe(originalContent);

      await guard.dispose(before);
      await guard.dispose(after);
    });

    it("合法变更（allowedPaths 内）不视为越界，不回滚", async () => {
      const { guard } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-direct-6");
      const usersPyPath = join(worktreePath, "src", "users.py");

      const before = await guard.createSnapshot(worktreePath);
      // 模拟 Omp 在 allowedPaths 内修改文件（合法变更）
      writeFileSync(usersPyPath, "def create_user():\n    return {'status': 201}\n", "utf8");

      const after = await guard.createSnapshot(worktreePath);
      const changes = guard.detectChanges(before, after);

      // 断言：检测到 modified 变更（合法）
      const modified = changes.filter((c) => c.type === "modified");
      expect(modified.length).toBe(1);
      expect(modified[0]!.relativePath).toBe("src/users.py");

      // 不回滚（合法变更）
      // 验证文件内容保持修改后的状态
      const content = readFileSync(usersPyPath, "utf8");
      expect(content).toContain("201");

      await guard.dispose(before);
      await guard.dispose(after);
    });

    it("未跟踪文件的新增也被检测（git diff 不会捕获，但快照会）", async () => {
      const { guard } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-direct-7");

      const before = await guard.createSnapshot(worktreePath);
      // 模拟 Omp 在 allowedPaths 外创建嵌套目录和未跟踪文件
      mkdirSync(join(worktreePath, "evil-dir"), { recursive: true });
      writeFileSync(join(worktreePath, "evil-dir", "evil.py"), "evil", "utf8");

      const after = await guard.createSnapshot(worktreePath);
      const changes = guard.detectChanges(before, after);

      // 断言：检测到未跟踪文件的新增
      const added = changes.filter((c) => c.type === "added");
      expect(added.length).toBe(1);
      expect(added[0]!.relativePath).toBe("evil-dir/evil.py");

      await guard.dispose(before);
      await guard.dispose(after);
    });

    // ========================================================================
    // P1-R01 §9.2：.git 保护测试
    // ========================================================================

    it("P1-R01 §9.2：.git 文件修改被检测（git worktree 的 .git gitdir 指针）", async () => {
      const { guard } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-git-1");
      // 模拟 git worktree 的 .git 文件（指向主仓库 gitdir）
      const gitFilePath = join(worktreePath, ".git");
      writeFileSync(gitFilePath, "gitdir: /tmp/main-repo/.git/worktrees/wt-1\n", "utf8");
      const originalContent = readFileSync(gitFilePath, "utf8");

      const before = await guard.createSnapshot(worktreePath);
      // 模拟 Omp 篡改 .git 文件，重定向到恶意 gitdir
      writeFileSync(gitFilePath, "gitdir: /tmp/evil-repo/.git\n", "utf8");

      const after = await guard.createSnapshot(worktreePath);
      const changes = guard.detectChanges(before, after);

      // 断言：.git 文件修改被检测
      const modified = changes.filter((c) => c.type === "modified" && c.relativePath === ".git");
      expect(modified.length).toBe(1);

      // 回滚
      await guard.rollback(before, modified);

      // 断言：.git 文件内容已恢复
      const restoredContent = readFileSync(gitFilePath, "utf8");
      expect(restoredContent).toBe(originalContent);

      await guard.dispose(before);
      await guard.dispose(after);
    });

    it("P1-R01 §9.2：.git 文件删除被检测", async () => {
      const { guard } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-git-2");
      const gitFilePath = join(worktreePath, ".git");
      writeFileSync(gitFilePath, "gitdir: /tmp/main-repo/.git/worktrees/wt-2\n", "utf8");

      const before = await guard.createSnapshot(worktreePath);
      // 模拟 Omp 删除 .git 文件
      rmSync(gitFilePath);

      const after = await guard.createSnapshot(worktreePath);
      const changes = guard.detectChanges(before, after);

      // 断言：.git 文件删除被检测
      const deleted = changes.filter((c) => c.type === "deleted" && c.relativePath === ".git");
      expect(deleted.length).toBe(1);

      // 回滚
      await guard.rollback(before, deleted);
      expect(existsSync(gitFilePath)).toBe(true);

      await guard.dispose(before);
      await guard.dispose(after);
    });

    it("P1-R01 §9.2：.gitignore 修改被检测为受保护路径违规", async () => {
      const { guard } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-git-3");
      const gitignorePath = join(worktreePath, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\n", "utf8");

      const before = await guard.createSnapshot(worktreePath);
      // 模拟 Omp 篡改 .gitignore（如添加 *.py 来隐藏恶意文件）
      writeFileSync(gitignorePath, "node_modules/\n*.py\nsecret.txt\n", "utf8");

      const after = await guard.createSnapshot(worktreePath);
      const changes = guard.detectChanges(before, after);

      // 断言：.gitignore 修改被检测
      const modified = changes.filter((c) => c.type === "modified" && c.relativePath === ".gitignore");
      expect(modified.length).toBe(1);

      await guard.dispose(before);
      await guard.dispose(after);
    });
  });

  // ==========================================================================
  // 集成 ExecutionOrchestrator.runDevelop 测试
  // ==========================================================================
  describe("集成 ExecutionOrchestrator.runDevelop：真实文件系统越界检测", () => {
    /**
     * 辅助：创建带 filesystemGuard 的 ExecutionOrchestrator。
     * 与 createRealFsFixture 不同，这里返回新的 exec 实例以便注入 guard。
     * 可选传入自定义 guard 用于测试（如 FailingWatcherGuard）。
     */
    function createExecWithGuard(fixture: RealFsTestFixture, guardOverride?: WorktreeFilesystemGuard): ExecutionOrchestrator {
      const worktreeManager = new WorktreeManager({
        gitAdapter: fixture.fakeGit,
        orchestrator: fixture.orchestrator,
        unitOfWork: fixture.store.unitOfWork
      });
      return new ExecutionOrchestrator({
        unitOfWork: fixture.store.unitOfWork,
        runtime: fixture.runtime,
        worktreeManager,
        eventSink: new FakeRuntimeEventSink(),
        processRunner: fixture.fakeProcess,
        processPolicy: {
          allowedCwdRoots: [fixture.testDir],
          inheritEnv: false,
          maxOutputBytes: 1024 * 1024,
          timeoutMs: 30000,
          disallowCredentialVars: true
        },
        filesystemGuard: guardOverride ?? fixture.guard
      });
    }

    it("Omp 在 allowedPaths 外创建文件时，runDevelop 抛 PathScopeViolationError 并回滚", async () => {
      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-int-1");
      const exec = createExecWithGuard(fixture);

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // 设置 Runtime 副作用：在 allowedPaths 外创建文件
      runtime.setDevelopSideEffect((wtPath) => {
        writeFileSync(join(wtPath, "evil-untracked.txt"), "malicious", "utf8");
      });

      // 核心断言：runDevelop 必须抛 PathScopeViolationError
      await expect(exec.runDevelop(task.id)).rejects.toBeInstanceOf(
        PathScopeViolationError
      );

      // 核心断言：越界文件已被回滚删除
      expect(existsSync(join(worktreePath, "evil-untracked.txt"))).toBe(false);

      // 核心断言：审计中有 policy_denied
      const auditEvents = await fixture.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = auditEvents.find(
        (e) => e.type === "policy_denied" && e.deniedAction === "runDevelop.filesystemScopeViolation"
      );
      expect(denied).toBeDefined();
      expect(denied!.deniedReason).toContain("evil-untracked.txt");
    });

    // ========================================================================
    // P1-R01（§7.2 符号链接逃逸）：allowedPaths 内创建/替换为指向外部的符号链接
    // 关闭"在白名单内创建指向外部的符号链接"逃逸路径。
    // 与第 461-496 行测试不同：那些是相对路径在白名单外（被
    // findPathScopeViolations 检测）；本组是相对路径在白名单内、但符号链接
    // 目标指向 worktree 外部（被 isSymlinkTargetOutsideWorktree 检测）。
    // Windows 无 Developer Mode 时跳过符号链接创建。
    // ========================================================================

    /**
     * 探测当前环境是否可创建符号链接（Windows 需 Developer Mode 或管理员）。
     * 不可用时返回 false，调用方 skip 本测试。
     */
    function canCreateSymlink(testDir: string): boolean {
      const probe = join(testDir, `.symlink-probe-${Date.now()}`);
      const target = join(testDir, "probe-target.txt");
      try {
        writeFileSync(target, "x", "utf8");
        symlinkSync(target, probe);
        rmSync(probe);
        rmSync(target);
        return true;
      } catch {
        return false;
      }
    }

    it("§7.2 符号链接逃逸（added）：allowedPaths 内新建符号链接指向 worktree 外部 → 抛 PathScopeViolationError 并回滚", async () => {
      if (!canCreateSymlink(testDir)) return; // Windows 无 Developer Mode 时跳过

      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-int-sym-added");
      const exec = createExecWithGuard(fixture);

      // worktree 外部目标（在 testDir 内但 worktree 外）
      const externalTarget = join(testDir, "external-secret-added.txt");
      writeFileSync(externalTarget, "secret", "utf8");

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // Runtime 副作用：在 allowedPaths 内（src/）创建指向外部的符号链接
      const symlinkPath = join(worktreePath, "src", "escape-link");
      runtime.setDevelopSideEffect((wtPath) => {
        symlinkSync(externalTarget, join(wtPath, "src", "escape-link"));
      });

      // 核心断言：runDevelop 必须抛 PathScopeViolationError
      // （即使 src/escape-link 相对路径落在 src/** 内，符号链接目标指向
      //  worktree 外部 → isSymlinkTargetOutsideWorktree 判定越界）
      await expect(exec.runDevelop(task.id)).rejects.toBeInstanceOf(
        PathScopeViolationError
      );

      // 核心断言：越界符号链接已被回滚删除
      expect(existsSync(symlinkPath)).toBe(false);

      // 核心断言：审计中有 policy_denied
      const auditEvents = await fixture.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = auditEvents.find(
        (e) => e.type === "policy_denied" && e.deniedAction === "runDevelop.filesystemScopeViolation"
      );
      expect(denied).toBeDefined();
      expect(denied!.deniedReason).toContain("escape-link");

      // 清理外部目标
      rmSync(externalTarget, { force: true });
    });

    it("§7.2 符号链接逃逸（type-changed）：allowedPaths 内常规文件被替换为指向外部的符号链接 → 抛 PathScopeViolationError 并回滚", async () => {
      if (!canCreateSymlink(testDir)) return; // Windows 无 Developer Mode 时跳过

      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-int-sym-tc");
      const exec = createExecWithGuard(fixture);
      const usersPyPath = join(worktreePath, "src", "users.py");
      const originalContent = readFileSync(usersPyPath, "utf8");

      // worktree 外部目标
      const externalTarget = join(testDir, "external-evil-tc.py");
      writeFileSync(externalTarget, "evil code", "utf8");

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // Runtime 副作用：删除 src/users.py（allowedPaths 内）并替换为指向外部的符号链接
      runtime.setDevelopSideEffect((wtPath) => {
        const target = join(wtPath, "src", "users.py");
        rmSync(target);
        symlinkSync(externalTarget, target);
      });

      // 核心断言：runDevelop 必须抛 PathScopeViolationError
      // （src/users.py 相对路径在 src/** 内，但被替换为指向外部的符号链接 →
      //  type-changed + isSymlinkTargetOutsideWorktree 判定越界）
      await expect(exec.runDevelop(task.id)).rejects.toBeInstanceOf(
        PathScopeViolationError
      );

      // 核心断言：文件已回滚为常规文件，内容恢复
      const lstat = lstatSync(usersPyPath);
      expect(lstat.isSymbolicLink()).toBe(false);
      expect(lstat.isFile()).toBe(true);
      expect(readFileSync(usersPyPath, "utf8")).toBe(originalContent);

      // 核心断言：审计中有 policy_denied
      const auditEvents = await fixture.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = auditEvents.find(
        (e) => e.type === "policy_denied" && e.deniedAction === "runDevelop.filesystemScopeViolation"
      );
      expect(denied).toBeDefined();
      expect(denied!.deniedReason).toContain("users.py");

      // 清理外部目标
      rmSync(externalTarget, { force: true });
    });

    // ========================================================================
    // P1-R01 §16 运行期符号链接逃逸监听：
    // §16.2 要求增加"动态外部链接后尝试写入外部目标并断言其内容未变"的
    // 对抗性测试。本测试验证 fs.watch 递归监听能在 Runtime 创建越界符号链接
    // 后近实时检测并 abort Runtime，阻止后续通过链接写入外部目标。
    //
    // 测试设计：
    // 1. developSideEffect 异步执行：创建越界符号链接 → 等待 → 检查
    //    signal.aborted → 如果未 aborted 则通过链接写入外部目标。
    // 2. watcher 在 developSideEffect 等待期间检测到符号链接创建，
    //    调用 onViolation 回调 → controller.abort()。
    // 3. developSideEffect 等待后检查 signal.aborted → 已 aborted →
    //    不执行写入 → 外部目标内容未变。
    //
    // 这模拟了真实 omp 场景：工具调用之间有 LLM 推理延迟（秒级），
    // watcher 有充足时间在 omp 下一次工具调用前检测并终止。
    // ========================================================================

    it("§16 运行期符号链接逃逸监听：Runtime 在 allowedPaths 内创建指向外部的符号链接 → watcher 近实时 abort Runtime，外部目标未被写入", async () => {
      if (!canCreateSymlink(testDir)) return; // Windows 无 Developer Mode 时跳过

      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-sym-watch-escape");
      const exec = createExecWithGuard(fixture);

      // worktree 外部目标
      const externalTarget = join(testDir, "external-escape-target.txt");
      writeFileSync(externalTarget, "original", "utf8");

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // Runtime 副作用（异步）：
      // 1. 在 allowedPaths 内（src/）创建指向外部目标的符号链接
      // 2. 等待 200ms（模拟 LLM 推理延迟，让 watcher 有时间检测）
      // 3. 检查 signal.aborted：如果已 aborted，不执行后续写入
      // 4. 如果未 aborted，通过符号链接写入外部目标
      let wroteToExternal = false;
      runtime.setDevelopSideEffect(async (wtPath: string, signal: AbortSignal) => {
        const symlinkPath = join(wtPath, "src", "escape-link");
        symlinkSync(externalTarget, symlinkPath);

        // 等待 200ms，让 fs.watch 有时间检测符号链接创建并 abort
        await new Promise<void>((resolve) => setTimeout(resolve, 200));

        // 检查 signal：watcher 检测到越界符号链接后应已 abort
        if (signal.aborted) {
          return; // 不执行后续写入
        }

        // 如果 watcher 未检测到（不应发生），尝试通过链接写入外部目标
        try {
          writeFileSync(symlinkPath, "evil content via symlink", "utf8");
          wroteToExternal = true;
        } catch {
          // 链接可能已被回滚
        }
      });

      // 核心断言：runDevelop 必须失败
      // （watcher abort → develop 产出 error 事件 → assertStreamHealthy 抛错，
      //  或 enforceFilesystemScope 检测到越界符号链接 → PathScopeViolationError）
      await expect(exec.runDevelop(task.id)).rejects.toThrow();

      // 核心断言：外部目标内容未变（watcher 在写入前 abort 了 Runtime）
      expect(wroteToExternal).toBe(false);
      expect(readFileSync(externalTarget, "utf8")).toBe("original");

      // 核心断言：越界符号链接已被回滚删除
      expect(existsSync(join(worktreePath, "src", "escape-link"))).toBe(false);

      // 核心断言：审计中有 policy_denied（enforceFilesystemScope 事后检测）
      const auditEvents = await fixture.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = auditEvents.find(
        (e) => e.type === "policy_denied" && e.deniedAction === "runDevelop.filesystemScopeViolation"
      );
      expect(denied).toBeDefined();

      // 清理外部目标
      rmSync(externalTarget, { force: true });
    });

    it("§16 运行期符号链接逃逸监听：allowedPaths 内符号链接指向 worktree 内部 → watcher 不 abort，develop 正常完成", async () => {
      if (!canCreateSymlink(testDir)) return; // Windows 无 Developer Mode 时跳过

      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-sym-watch-safe");
      const exec = createExecWithGuard(fixture);

      // worktree 内部目标（在 allowedPaths 内）
      const internalTarget = join(worktreePath, "src", "target.txt");
      writeFileSync(internalTarget, "safe target", "utf8");

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // Runtime 副作用：在 allowedPaths 内创建指向 worktree 内部目标的符号链接
      runtime.setDevelopSideEffect(async (wtPath: string, _signal: AbortSignal) => {
        const symlinkPath = join(wtPath, "src", "safe-link");
        symlinkSync(internalTarget, symlinkPath);
        // 短暂等待，确认 watcher 不会误报
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      });

      // 核心断言：runDevelop 正常完成（符号链接目标在 worktree 内，不越界）
      // 注意：develop 会修改 worktree（新增符号链接），但符号链接在 allowedPaths 内
      // 且目标也在 worktree 内，所以不触发 PathScopeViolationError。
      // 但由于 developSideEffect 修改了 allowedPaths 内的文件，develop 可能因为
      // 测试结果不通过而失败。我们只验证不抛 PathScopeViolationError。
      try {
        await exec.runDevelop(task.id);
      } catch (err) {
        // 如果抛错，不应是 PathScopeViolationError（符号链接指向 worktree 内部）
        expect(err).not.toBeInstanceOf(PathScopeViolationError);
      }

      // 清理
      rmSync(join(worktreePath, "src", "safe-link"), { force: true });
    });

    // ========================================================================
    // §17.2 fail-closed 测试：watcher 初始化失败时拒绝启动 Runtime
    // §17.3 要求"watcher 初始化/运行失败均拒绝启动的对抗性测试"
    // ========================================================================

    it("§17.2 fail-closed：watcher 初始化失败（fs.watch 不可用）→ 拒绝启动 Runtime，developSideEffect 未执行", async () => {
      const { orchestrator, runtime, guard } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-watcher-fail");
      // 使用 FailingWatcherGuard：watchForSymlinkEscapes 抛错
      const failingGuard = new FailingWatcherGuard(guard);
      const exec = createExecWithGuard(fixture, failingGuard);

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // 设置 developSideEffect —— 不应被执行（Runtime 不应启动）
      let sideEffectExecuted = false;
      runtime.setDevelopSideEffect(() => {
        sideEffectExecuted = true;
      });

      // 核心断言：runDevelop 抛错（watcher 初始化失败 → fail-closed）
      await expect(exec.runDevelop(task.id)).rejects.toThrow(/watcher 初始化失败/);

      // 核心断言：Runtime 未被启动（developSideEffect 未执行）
      expect(sideEffectExecuted).toBe(false);
    });

    // ========================================================================
    // §17.2 零等待对抗性测试：创建外部链接后立即同步写入外部目标
    // §17.3 要求"创建外部链接后零等待立即写入"的对抗性测试
    // 此测试验证：即使 watcher 来不及 abort（异步延迟），runDevelop 仍
    // 通过 enforceFilesystemScope 的事后检测失败关闭（抛错 + 回滚 + 审计）。
    // 诚实记录：外部目标可能已被写入——这是 fs.watch 异步方案的已知限制。
    // ========================================================================

    it("§17.2 零等待对抗：创建外部链接后立即同步写入外部目标 → runDevelop 仍失败关闭（事后检测兜底）", async () => {
      if (!canCreateSymlink(testDir)) return; // Windows 无 Developer Mode 时跳过

      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-zero-wait");
      const exec = createExecWithGuard(fixture);

      // worktree 外部目标
      const externalTarget = join(testDir, "external-zero-wait.txt");
      writeFileSync(externalTarget, "original", "utf8");

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // Runtime 副作用（同步，零等待）：
      // 1. 在 allowedPaths 内创建指向外部目标的符号链接
      // 2. 立即（不等待）通过链接写入外部目标
      // 这模拟对抗场景：Runtime 在 watcher 回调执行前就完成了写入
      runtime.setDevelopSideEffect((wtPath: string) => {
        const symlinkPath = join(wtPath, "src", "escape-link");
        symlinkSync(externalTarget, symlinkPath);
        // 零等待：立即通过链接写入外部目标
        // watcher 的回调在事件循环后续 tick 执行，来不及阻止此写入
        try {
          writeFileSync(symlinkPath, "evil content via zero-wait", "utf8");
        } catch {
          // 链接写入可能失败（权限等）
        }
      });

      // 核心断言：runDevelop 必须失败
      // （enforceFilesystemScope 事后检测到越界符号链接 → PathScopeViolationError）
      await expect(exec.runDevelop(task.id)).rejects.toThrow();

      // 核心断言：越界符号链接已被回滚删除
      expect(existsSync(join(worktreePath, "src", "escape-link"))).toBe(false);

      // 核心断言：审计中有 policy_denied
      const auditEvents = await fixture.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = auditEvents.find(
        (e) => e.type === "policy_denied" && e.deniedAction === "runDevelop.filesystemScopeViolation"
      );
      expect(denied).toBeDefined();

      // 诚实记录：外部目标可能已被写入（fs.watch 异步方案的已知限制）
      // 此测试验证的是"失败关闭"——runDevelop 抛错、回滚、审计，
      // 而非"完全阻止外部副作用"。完全阻止需要 OS 级隔离。
      // 外部目标内容可能是 "original" 或 "evil content via zero-wait"，
      // 取决于 watcher 是否来得及 abort。两种情况都 acceptable：
      // - 如果 watcher 来不及 abort：外部目标被写入，但 runDevelop 失败关闭
      // - 如果 watcher 来得及 abort：外部目标未变，runDevelop 也失败关闭

      // 清理外部目标
      rmSync(externalTarget, { force: true });
    });

    it("P1-R01 §11.2：Omp 修改 allowedPaths 外的 package.json 时，执行期隔离阻止写入（EPERM）", async () => {
      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-int-2");
      const packageJsonPath = join(worktreePath, "package.json");
      const originalContent = readFileSync(packageJsonPath, "utf8");
      const exec = createExecWithGuard(fixture);

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // 设置 Runtime 副作用：尝试修改 package.json
      // 执行期隔离已将 package.json 设为只读 → writeFileSync 抛 EPERM
      // → adapter 捕获后会话继续 → 事后快照检测无变更 → 不抛 PathScopeViolationError
      runtime.setDevelopSideEffect((wtPath) => {
        writeFileSync(join(wtPath, "package.json"), '{"name": "tampered"}', "utf8");
      });

      // 执行期隔离阻止了写入，package.json 未被修改
      // runDevelop 不会抛 PathScopeViolationError（因越界写入被阻止，无 violation 可检测）
      // 但可能因 FakeGit 未设置 diff 而抛错，这里只验证安全约束：
      // package.json 内容未被篡改
      try {
        await exec.runDevelop(task.id);
      } catch {
        // runDevelop 可能因 diff/验证步骤抛错，但安全约束是文件未被修改
      }

      // 核心断言：执行期隔离阻止了写入，package.json 内容未变
      const currentContent = readFileSync(packageJsonPath, "utf8");
      expect(currentContent).toBe(originalContent);

      // 核心断言：无 policy_denied 审计（因为 violation 被执行期隔离阻止，未发生）
      const auditEvents = await fixture.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = auditEvents.find(
        (e) => e.type === "policy_denied" && e.deniedAction === "runDevelop.filesystemScopeViolation"
      );
      expect(denied).toBeUndefined();
    });

    it("Omp 删除 allowedPaths 外的测试文件时，runDevelop 抛错并回滚恢复文件", async () => {
      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-int-3");
      const testFilePath = join(worktreePath, "tests", "test_users.py");
      const originalContent = readFileSync(testFilePath, "utf8");
      const exec = createExecWithGuard(fixture);

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // 设置 Runtime 副作用：删除测试文件
      runtime.setDevelopSideEffect((wtPath) => {
        rmSync(join(wtPath, "tests", "test_users.py"));
      });

      // 核心断言：必须抛 PathScopeViolationError
      await expect(exec.runDevelop(task.id)).rejects.toBeInstanceOf(
        PathScopeViolationError
      );

      // 核心断言：测试文件已回滚恢复
      expect(existsSync(testFilePath)).toBe(true);
      const restoredContent = readFileSync(testFilePath, "utf8");
      expect(restoredContent).toBe(originalContent);
    });

    it("Omp 在 allowedPaths 内修改文件时，runDevelop 正常完成不回滚", async () => {
      const { orchestrator, runtime, fakeGit, fakeProcess } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-int-4");
      const usersPyPath = join(worktreePath, "src", "users.py");
      const exec = createExecWithGuard(fixture);

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // 设置 Runtime 副作用：在 allowedPaths 内修改文件（合法）
      runtime.setDevelopSideEffect((wtPath) => {
        writeFileSync(
          join(wtPath, "src", "users.py"),
          "def create_user():\n    return {'status': 201}\n",
          "utf8"
        );
      });

      // FakeGit 返回合法 Diff
      const worktree = sampleWorktree(task.id, worktreePath);
      fakeGit.setDiff(worktree.path, "--- a/src/users.py\n+++ b/src/users.py\n");
      fakeGit.setChangedFiles(worktree.path, ["src/users.py"]);
      fakeProcess.setResult("pytest", {
        argv: ["pytest"],
        cwd: worktreePath,
        exitCode: 0,
        stdout: "1 passed",
        stderr: "",
        truncated: false,
        originalBytes: 0,
        retainedBytes: 0,
        timedOut: false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString()
      });

      // 核心断言：runDevelop 正常完成
      const result = await exec.runDevelop(task.id);
      expect(result.verificationPassed).toBe(true);

      // 核心断言：合法修改未被回滚
      const content = readFileSync(usersPyPath, "utf8");
      expect(content).toContain("201");

      // 核心断言：无 policy_denied 审计
      const auditEvents = await fixture.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = auditEvents.find((e) => e.type === "policy_denied");
      expect(denied).toBeUndefined();
    });

    it("P1-R01 §11.2：Omp 同时修改合法和越界文件时，执行期隔离仅阻止越界写入，合法修改成功", async () => {
      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-int-5");
      const usersPyPath = join(worktreePath, "src", "users.py");
      const packageJsonPath = join(worktreePath, "package.json");
      const originalPackageJson = readFileSync(packageJsonPath, "utf8");
      const exec = createExecWithGuard(fixture);

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // 设置 Runtime 副作用：同时修改合法文件和越界文件
      // package.json 只读 → EPERM → 被捕获 → 未修改
      // src/users.py 可写 → 修改成功
      runtime.setDevelopSideEffect((wtPath) => {
        writeFileSync(
          join(wtPath, "src", "users.py"),
          "def create_user():\n    return {'status': 201}\n",
          "utf8"
        );
        writeFileSync(join(wtPath, "package.json"), '{"name": "tampered"}', "utf8");
      });

      // runDevelop 可能因 FakeGit 未配置 diff 而抛错，但安全约束是：
      // 越界文件未被修改，合法文件被修改
      try {
        await exec.runDevelop(task.id);
      } catch {
        // 预期可能抛错（diff/验证步骤），不影响安全约束验证
      }

      // 核心断言：执行期隔离阻止了越界写入，package.json 内容未变
      const currentPackageJson = readFileSync(packageJsonPath, "utf8");
      expect(currentPackageJson).toBe(originalPackageJson);

      // 核心断言：合法修改成功（src/users.py 在 allowedPaths 内，可写）
      const usersContent = readFileSync(usersPyPath, "utf8");
      expect(usersContent).toContain("201");
    });

    // ========================================================================
    // P1-R01 §9.2：.git 保护集成测试
    // ========================================================================

    it("P1-R01 §11.2：.git 文件修改被执行期隔离阻止（EPERM），即使 allowedPaths 含 **", async () => {
      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-git-int-1");
      const gitFilePath = join(worktreePath, ".git");
      // 模拟 git worktree 的 .git 文件
      writeFileSync(gitFilePath, "gitdir: /tmp/main-repo/.git/worktrees/wt-int-1\n", "utf8");
      const originalContent = readFileSync(gitFilePath, "utf8");
      const exec = createExecWithGuard(fixture);

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      // 即使 allowedPaths 允许所有路径（**），.git 仍被无条件设为只读
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["**"]);

      // 设置 Runtime 副作用：尝试篡改 .git 文件
      // .git 被执行期隔离设为只读 → EPERM → 被捕获 → 未修改
      runtime.setDevelopSideEffect((wtPath) => {
        writeFileSync(join(wtPath, ".git"), "gitdir: /tmp/evil-repo/.git\n", "utf8");
      });

      // runDevelop 可能因 diff/验证步骤抛错，但安全约束是 .git 未被修改
      try {
        await exec.runDevelop(task.id);
      } catch {
        // 预期可能抛错，不影响安全约束验证
      }

      // 核心断言：执行期隔离阻止了 .git 篡改，内容未变
      const currentContent = readFileSync(gitFilePath, "utf8");
      expect(currentContent).toBe(originalContent);

      // 核心断言：无 policy_denied 审计（因为 violation 被执行期隔离阻止）
      const auditEvents = await fixture.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const denied = auditEvents.find(
        (e) => e.type === "policy_denied" && e.deniedAction === "runDevelop.filesystemScopeViolation"
      );
      expect(denied).toBeUndefined();
    });

    it("P1-R01 §11.2：.gitignore 修改被执行期隔离阻止（EPERM），即使 allowedPaths 含 **", async () => {
      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-git-int-2");
      const gitignorePath = join(worktreePath, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\n", "utf8");
      const originalContent = readFileSync(gitignorePath, "utf8");
      const exec = createExecWithGuard(fixture);

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["**"]);

      // 设置 Runtime 副作用：尝试篡改 .gitignore
      // .gitignore 被执行期隔离设为只读 → EPERM → 被捕获 → 未修改
      runtime.setDevelopSideEffect((wtPath) => {
        writeFileSync(join(wtPath, ".gitignore"), "*.py\nsecret.txt\n", "utf8");
      });

      // runDevelop 可能因 diff/验证步骤抛错，但安全约束是 .gitignore 未被修改
      try {
        await exec.runDevelop(task.id);
      } catch {
        // 预期可能抛错，不影响安全约束验证
      }

      // 核心断言：执行期隔离阻止了 .gitignore 篡改，内容未变
      const currentContent = readFileSync(gitignorePath, "utf8");
      expect(currentContent).toBe(originalContent);
    });
  });
});

// ---------------------------------------------------------------------------
// isProtectedPath 单元测试 —— P1-R01 §9.2
// ---------------------------------------------------------------------------

describe("isProtectedPath P1-R01 §9.2 单元测试", () => {
  it(".git 文件是受保护路径", () => {
    expect(isProtectedPath(".git")).toBe(true);
  });

  it(".git/ 子路径是受保护路径", () => {
    expect(isProtectedPath(".git/config")).toBe(true);
    expect(isProtectedPath(".git/refs/heads/main")).toBe(true);
  });

  it(".gitignore 和 .gitattributes 是受保护路径", () => {
    expect(isProtectedPath(".gitignore")).toBe(true);
    expect(isProtectedPath(".gitattributes")).toBe(true);
  });

  it(".omp 目录及其子路径是受保护路径", () => {
    expect(isProtectedPath(".omp")).toBe(true);
    expect(isProtectedPath(".omp/config.yml")).toBe(true);
  });

  it("普通源码路径不是受保护路径", () => {
    expect(isProtectedPath("src/users.py")).toBe(false);
    expect(isProtectedPath("package.json")).toBe(false);
    expect(isProtectedPath("tests/test_users.py")).toBe(false);
  });

  it("前导 ./ 被正确规范化", () => {
    expect(isProtectedPath("./.git")).toBe(true);
    expect(isProtectedPath("./src/users.py")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSymlinkTargetOutsideWorktree 单元测试 —— P1-R01 §7.2 符号链接逃逸
// 纯字符串解析，不访问文件系统，全平台稳定运行（不依赖 Developer Mode）。
// ---------------------------------------------------------------------------

describe("isSymlinkTargetOutsideWorktree P1-R01 §7.2 单元测试", () => {
  // POSIX worktree 路径
  const posixWorktree = "/tmp/tracepilot/worktrees/wt-1";

  it("绝对路径指向 worktree 外部 → 越界", () => {
    expect(
      isSymlinkTargetOutsideWorktree(posixWorktree, "src/link", "/etc/passwd")
    ).toBe(true);
    expect(
      isSymlinkTargetOutsideWorktree(posixWorktree, "src/link", "/tmp/secret.txt")
    ).toBe(true);
  });

  it("绝对路径指向 worktree 内部 → 不越界", () => {
    expect(
      isSymlinkTargetOutsideWorktree(
        posixWorktree,
        "src/link",
        "/tmp/tracepilot/worktrees/wt-1/src/target.py"
      )
    ).toBe(false);
    expect(
      isSymlinkTargetOutsideWorktree(posixWorktree, "link", posixWorktree)
    ).toBe(false);
  });

  it("相对路径 .. 穿越到 worktree 外部 → 越界", () => {
    // src/link 所在目录为 src，../../secret.txt 解析为
    // /tmp/tracepilot/worktrees/secret.txt（在 worktree 外）
    expect(
      isSymlinkTargetOutsideWorktree(posixWorktree, "src/link", "../../secret.txt")
    ).toBe(true);
    // src/sub/link 所在目录为 src/sub，../../../etc/passwd 解析为
    // /tmp/tracepilot/worktrees/etc/passwd（在 worktree 外）
    expect(
      isSymlinkTargetOutsideWorktree(posixWorktree, "src/sub/link", "../../../etc/passwd")
    ).toBe(true);
  });

  it("相对路径指向 worktree 内部 → 不越界", () => {
    // src/link 所在目录为 src，./target.py 解析为
    // /tmp/tracepilot/worktrees/wt-1/src/target.py（在 worktree 内）
    expect(
      isSymlinkTargetOutsideWorktree(posixWorktree, "src/link", "./target.py")
    ).toBe(false);
    // 根目录下的 link，../wt-1/other 解析回 worktree 内
    // （base = worktree 根，.. 回到父，wt-1/other 再进入 worktree）
    expect(
      isSymlinkTargetOutsideWorktree(posixWorktree, "link", "../wt-1/other")
    ).toBe(false);
  });

  it("相对路径 . 与空分量被正确跳过", () => {
    expect(
      isSymlinkTargetOutsideWorktree(posixWorktree, "src/link", "././target.py")
    ).toBe(false);
    expect(
      isSymlinkTargetOutsideWorktree(posixWorktree, "src/link", "target.py")
    ).toBe(false);
  });

  it("Windows 盘符绝对路径指向 worktree 外部 → 越界", () => {
    const winWorktree = "C:\\Users\\dev\\tracepilot\\worktrees\\wt-1";
    expect(
      isSymlinkTargetOutsideWorktree(winWorktree, "src/link", "C:\\Windows\\System32\\evil.dll")
    ).toBe(true);
    expect(
      isSymlinkTargetOutsideWorktree(winWorktree, "src/link", "D:\\secret.txt")
    ).toBe(true);
  });

  it("Windows 盘符绝对路径指向 worktree 内部 → 不越界", () => {
    const winWorktree = "C:\\Users\\dev\\tracepilot\\worktrees\\wt-1";
    expect(
      isSymlinkTargetOutsideWorktree(
        winWorktree,
        "src/link",
        "C:\\Users\\dev\\tracepilot\\worktrees\\wt-1\\src\\target.py"
      )
    ).toBe(false);
  });

  it("Windows 反斜杠相对路径 .. 穿越 → 越界", () => {
    const winWorktree = "C:\\Users\\dev\\tracepilot\\worktrees\\wt-1";
    // src/link 所在目录 C:/Users/dev/tracepilot/worktrees/wt-1/src
    // ..\\..\\secret.txt → C:/Users/dev/tracepilot/worktrees/secret.txt（外部）
    expect(
      isSymlinkTargetOutsideWorktree(winWorktree, "src/link", "..\\..\\secret.txt")
    ).toBe(true);
  });

  it("前缀相似但非子路径不误判（C:/wt 不应匹配 C:/wt-evil）", () => {
    expect(
      isSymlinkTargetOutsideWorktree(
        "C:\\wt",
        "src/link",
        "C:\\wt-evil\\secret.txt"
      )
    ).toBe(true);
  });

  it("UNC 路径指向 worktree 外部 → 越界", () => {
    const uncWorktree = "\\\\server\\share\\tracepilot\\worktrees\\wt-1";
    expect(
      isSymlinkTargetOutsideWorktree(uncWorktree, "src/link", "\\\\server\\share\\secret.txt")
    ).toBe(true);
  });

  it("盘符大小写不影响比较（C: 与 c: 等价）", () => {
    const winWorktree = "C:\\Users\\dev\\wt-1";
    expect(
      isSymlinkTargetOutsideWorktree(
        winWorktree,
        "src/link",
        "c:\\Users\\dev\\wt-1\\src\\target.py"
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1-R01 §11.2 applyExecutionIsolation 直接单元测试
// ---------------------------------------------------------------------------

describe("LocalWorktreeFilesystemGuard P1-R01 §11.2 applyExecutionIsolation 执行期隔离", () => {
  let testDir: string;
  let guard: LocalWorktreeFilesystemGuard;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `tracepilot-iso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    mkdirSync(testDir, { recursive: true });
    guard = new LocalWorktreeFilesystemGuard();
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  /**
   * 辅助：尝试写入文件，返回是否成功。
   * 只读文件写入会抛 EACCES/EPERM。
   */
  function tryWrite(filePath: string, content: string): boolean {
    try {
      writeFileSync(filePath, content, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  it("§11.2：allowedPaths 外的文件被设为只读，写入被拒绝", async () => {
    // 准备 worktree 结构
    mkdirSync(join(testDir, "src"), { recursive: true });
    writeFileSync(join(testDir, "src", "users.py"), "original", "utf8");
    writeFileSync(join(testDir, "package.json"), "original", "utf8");

    // 应用执行期隔离：仅允许 src/**
    const lease = await guard.applyExecutionIsolation(testDir, ["src/**"]);
    try {
      // allowedPaths 外的 package.json 应该只读
      expect(tryWrite(join(testDir, "package.json"), "tampered")).toBe(false);
    } finally {
      await lease.release();
    }
  });

  it("§11.2：allowedPaths 内的文件保持可写", async () => {
    mkdirSync(join(testDir, "src"), { recursive: true });
    writeFileSync(join(testDir, "src", "users.py"), "original", "utf8");

    const lease = await guard.applyExecutionIsolation(testDir, ["src/**"]);
    try {
      // allowedPaths 内的 src/users.py 应该可写
      expect(tryWrite(join(testDir, "src", "users.py"), "modified")).toBe(true);
    } finally {
      await lease.release();
    }
  });

  it("§11.2：.git 文件被无条件设为只读，即使 allowedPaths 含 **", async () => {
    writeFileSync(join(testDir, ".git"), "gitdir: /tmp/repo/.git/wt", "utf8");

    const lease = await guard.applyExecutionIsolation(testDir, ["**"]);
    try {
      // .git 即使 allowedPaths=["**"] 也应该只读
      expect(tryWrite(join(testDir, ".git"), "tampered")).toBe(false);
    } finally {
      await lease.release();
    }
  });

  it("§11.2：.gitignore 被无条件设为只读，即使 allowedPaths 含 **", async () => {
    writeFileSync(join(testDir, ".gitignore"), "node_modules/\n", "utf8");

    const lease = await guard.applyExecutionIsolation(testDir, ["**"]);
    try {
      expect(tryWrite(join(testDir, ".gitignore"), "*.py\n")).toBe(false);
    } finally {
      await lease.release();
    }
  });

  it("§11.2：lease.release() 恢复原始权限，文件再次可写", async () => {
    writeFileSync(join(testDir, "package.json"), "original", "utf8");

    const lease = await guard.applyExecutionIsolation(testDir, ["src/**"]);
    // 隔离期间只读
    expect(tryWrite(join(testDir, "package.json"), "tampered")).toBe(false);

    await lease.release();

    // 释放后恢复可写
    expect(tryWrite(join(testDir, "package.json"), "restored")).toBe(true);
  });

  it("§11.2：嵌套目录中 allowedPaths 外的文件也被设为只读", async () => {
    mkdirSync(join(testDir, "src", "sub"), { recursive: true });
    mkdirSync(join(testDir, "tests"), { recursive: true });
    writeFileSync(join(testDir, "src", "sub", "module.py"), "original", "utf8");
    writeFileSync(join(testDir, "tests", "test.py"), "original", "utf8");

    const lease = await guard.applyExecutionIsolation(testDir, ["src/**"]);
    try {
      // src/ 下可写
      expect(tryWrite(join(testDir, "src", "sub", "module.py"), "modified")).toBe(true);
      // tests/ 下只读
      expect(tryWrite(join(testDir, "tests", "test.py"), "modified")).toBe(false);
    } finally {
      await lease.release();
    }
  });

  it("§11.2：空 allowedPaths 时所有文件设为只读（fail-closed）", async () => {
    mkdirSync(join(testDir, "src"), { recursive: true });
    writeFileSync(join(testDir, "src", "users.py"), "original", "utf8");

    const lease = await guard.applyExecutionIsolation(testDir, []);
    try {
      // 空 allowedPaths → 所有文件只读
      expect(tryWrite(join(testDir, "src", "users.py"), "modified")).toBe(false);
    } finally {
      await lease.release();
    }
  });

  // ===== §14.2 失败关闭测试 =====

  it("§14.2：指向 worktree 外部的符号链接 → 抛 ExecutionIsolationError，拒绝启动 Runtime", async () => {
    // 创建 worktree 外部目标
    const externalTarget = join(tmpdir(), `tracepilot-external-${Date.now()}`);
    mkdirSync(externalTarget, { recursive: true });
    try {
      writeFileSync(join(externalTarget, "secret.txt"), "secret", "utf8");

      // 在 worktree 内创建指向外部的符号链接
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(join(testDir, "src", "users.py"), "original", "utf8");
      // Windows 需要开发者模式或管理员权限创建符号链接
      try {
        symlinkSync(externalTarget, join(testDir, "evil-link"));
      } catch {
        // Windows 无符号链接权限时跳过此测试
        return;
      }

      // 核心断言：检测到符号链接逃逸 → 抛 ExecutionIsolationError
      await expect(
        guard.applyExecutionIsolation(testDir, ["src/**"])
      ).rejects.toThrow(/符号链接逃逸/);
    } finally {
      rmSync(externalTarget, { recursive: true, force: true });
    }
  });

  it("§14.2：指向 worktree 内部的符号链接 → 不抛错，正常隔离", async () => {
    mkdirSync(join(testDir, "src"), { recursive: true });
    mkdirSync(join(testDir, "lib"), { recursive: true });
    writeFileSync(join(testDir, "src", "users.py"), "original", "utf8");
    writeFileSync(join(testDir, "lib", "helper.py"), "original", "utf8");
    // 创建指向 worktree 内部的符号链接（src → lib 的别名）
    try {
      symlinkSync(join(testDir, "lib"), join(testDir, "src", "lib-link"));
    } catch {
      // Windows 无符号链接权限时跳过此测试
      return;
    }

    // 核心断言：内部符号链接不触发逃逸错误
    const lease = await guard.applyExecutionIsolation(testDir, ["src/**"]);
    try {
      // lib/ 在 allowedPaths 外 → 只读
      expect(tryWrite(join(testDir, "lib", "helper.py"), "modified")).toBe(false);
    } finally {
      await lease.release();
    }
  });

  it("§14.2：断链符号链接（目标不存在）→ 抛 ExecutionIsolationError，拒绝启动 Runtime", async () => {
    mkdirSync(join(testDir, "src"), { recursive: true });
    writeFileSync(join(testDir, "src", "users.py"), "original", "utf8");
    try {
      symlinkSync(join(testDir, "nonexistent-target"), join(testDir, "broken-link"));
    } catch {
      // Windows 无符号链接权限时跳过此测试
      return;
    }

    // 核心断言：断链符号链接无法解析 → 失败关闭
    await expect(
      guard.applyExecutionIsolation(testDir, ["src/**"])
    ).rejects.toThrow(/无法解析符号链接/);
  });

  // ===== §14.2 Windows 平台限制文档化测试 =====

  it("§14.2 Windows 限制：白名单外目录内新建文件由快照检测层兜底（已记录限制）", async () => {
    // 此测试记录已知平台限制：Windows 目录 read-only 不阻止文件创建。
    // 白名单外目录内的新建文件由第二层（快照检测）和第三层（回滚恢复）处理。
    // 这不是安全漏洞——越界新建文件会在 Runtime 结束后被检测和回滚。
    mkdirSync(join(testDir, "src"), { recursive: true });
    mkdirSync(join(testDir, "tests"), { recursive: true });
    writeFileSync(join(testDir, "src", "users.py"), "original", "utf8");

    const lease = await guard.applyExecutionIsolation(testDir, ["src/**"]);
    try {
      // 验证：allowedPaths 内文件可写
      expect(tryWrite(join(testDir, "src", "users.py"), "modified")).toBe(true);

      // Windows 限制：tests/ 目录设为只读，但仍可能创建新文件
      // （Windows 目录 read-only 不阻止文件创建）
      // 此限制由快照检测层和回滚恢复层兜底。
      // 这里不验证新建是否成功（平台相关），只验证既有文件被保护。
      writeFileSync(join(testDir, "tests", "existing.py"), "original", "utf8");

      // 重新应用隔离（含新文件）
      await lease.release();
      const lease2 = await guard.applyExecutionIsolation(testDir, ["src/**"]);
      try {
        // tests/existing.py 现在应该只读
        expect(tryWrite(join(testDir, "tests", "existing.py"), "modified")).toBe(false);
      } finally {
        await lease2.release();
      }
    } finally {
      // 确保释放
    }
  });
});

// ---------------------------------------------------------------------------
// P1-R01 §10.2 失败关闭（fail-closed）测试
// ---------------------------------------------------------------------------

/**
 * 包装型 WorktreeFilesystemGuard —— rollback 为 no-op（不实际恢复文件）。
 *
 * 用于 §10.2 完整性校验测试：rollback "成功"但未实际恢复 →
 * enforceFilesystemScope 的完整性校验应检测到越界路径仍有变更 →
 * 写 rollbackIncomplete 审计并抛 PathScopeViolationError。
 */
class NoOpRollbackGuard implements WorktreeFilesystemGuard {
  constructor(private readonly inner: LocalWorktreeFilesystemGuard) {}

  async createSnapshot(worktreePath: string): Promise<FilesystemSnapshot> {
    return this.inner.createSnapshot(worktreePath);
  }

  detectChanges(
    before: FilesystemSnapshot,
    after: FilesystemSnapshot
  ): readonly FilesystemChange[] {
    return this.inner.detectChanges(before, after);
  }

  async rollback(
    _snapshot: FilesystemSnapshot,
    _changes: readonly FilesystemChange[]
  ): Promise<void> {
    // no-op —— 不实际恢复，模拟回滚不完整
  }

  async dispose(snapshot: FilesystemSnapshot): Promise<void> {
    return this.inner.dispose(snapshot);
  }

  async applyExecutionIsolation(
    worktreePath: string,
    allowedPaths: readonly string[]
  ): Promise<ExecutionIsolationLease> {
    return this.inner.applyExecutionIsolation(worktreePath, allowedPaths);
  }

  watchForSymlinkEscapes(
    worktreePath: string,
    allowedPaths: readonly string[],
    onViolation: (violation: SymlinkEscapeViolation) => void
  ): SymlinkEscapeWatcher {
    return this.inner.watchForSymlinkEscapes(worktreePath, allowedPaths, onViolation);
  }
}

/**
 * 包装型 WorktreeFilesystemGuard —— rollback 抛错。
 *
 * 用于 §10.2 回滚失败测试：rollback 抛错 →
 * enforceFilesystemScope 写 rollbackFailed 审计并抛 PathScopeViolationError。
 */
class ThrowingRollbackGuard implements WorktreeFilesystemGuard {
  constructor(private readonly inner: LocalWorktreeFilesystemGuard) {}

  async createSnapshot(worktreePath: string): Promise<FilesystemSnapshot> {
    return this.inner.createSnapshot(worktreePath);
  }

  detectChanges(
    before: FilesystemSnapshot,
    after: FilesystemSnapshot
  ): readonly FilesystemChange[] {
    return this.inner.detectChanges(before, after);
  }

  async rollback(
    _snapshot: FilesystemSnapshot,
    _changes: readonly FilesystemChange[]
  ): Promise<void> {
    throw new Error("模拟回滚失败：备份损坏或文件锁定");
  }

  async dispose(snapshot: FilesystemSnapshot): Promise<void> {
    return this.inner.dispose(snapshot);
  }

  async applyExecutionIsolation(
    worktreePath: string,
    allowedPaths: readonly string[]
  ): Promise<ExecutionIsolationLease> {
    return this.inner.applyExecutionIsolation(worktreePath, allowedPaths);
  }

  watchForSymlinkEscapes(
    worktreePath: string,
    allowedPaths: readonly string[],
    onViolation: (violation: SymlinkEscapeViolation) => void
  ): SymlinkEscapeWatcher {
    return this.inner.watchForSymlinkEscapes(worktreePath, allowedPaths, onViolation);
  }
}

/**
 * 包装型 WorktreeFilesystemGuard —— watchForSymlinkEscapes 抛错。
 *
 * 用于 §17.2 fail-closed 测试：watcher 初始化失败时拒绝启动 Runtime。
 * 其他方法委托给 inner guard（LocalWorktreeFilesystemGuard）。
 */
class FailingWatcherGuard implements WorktreeFilesystemGuard {
  constructor(private readonly inner: LocalWorktreeFilesystemGuard) {}

  async createSnapshot(worktreePath: string): Promise<FilesystemSnapshot> {
    return this.inner.createSnapshot(worktreePath);
  }

  detectChanges(
    before: FilesystemSnapshot,
    after: FilesystemSnapshot
  ): readonly FilesystemChange[] {
    return this.inner.detectChanges(before, after);
  }

  async rollback(
    snapshot: FilesystemSnapshot,
    changes: readonly FilesystemChange[]
  ): Promise<void> {
    return this.inner.rollback(snapshot, changes);
  }

  async dispose(snapshot: FilesystemSnapshot): Promise<void> {
    return this.inner.dispose(snapshot);
  }

  async applyExecutionIsolation(
    worktreePath: string,
    allowedPaths: readonly string[]
  ): Promise<ExecutionIsolationLease> {
    return this.inner.applyExecutionIsolation(worktreePath, allowedPaths);
  }

  watchForSymlinkEscapes(
    _worktreePath: string,
    _allowedPaths: readonly string[],
    _onViolation: (violation: SymlinkEscapeViolation) => void
  ): SymlinkEscapeWatcher {
    // §17.2 fail-closed：模拟 fs.watch 初始化失败
    throw new Error("模拟 watcher 初始化失败：fs.watch 不可用");
  }
}

describe("LocalWorktreeFilesystemGuard P1-R01 §10.2 失败关闭（fail-closed）", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `tracepilot-fs-failclosed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // guard 直接测试：fail-closed 行为
  // ==========================================================================

  it("P1-R01 §10.2：备份文件被删除后 rollback 抛错（fail-closed）", async () => {
    const guard = new LocalWorktreeFilesystemGuard();
    const worktreePath = createRealWorktree(testDir, "wt-fc-1");
    const packageJsonPath = join(worktreePath, "package.json");

    const before = await guard.createSnapshot(worktreePath);
    // 模拟 Omp 修改 allowedPaths 外的文件
    writeFileSync(packageJsonPath, '{"name": "tampered"}', "utf8");

    const after = await guard.createSnapshot(worktreePath);
    const changes = guard.detectChanges(before, after);
    const modified = changes.filter((c) => c.type === "modified");
    expect(modified.length).toBe(1);

    // 删除备份文件，模拟备份损坏
    const backupPath = join(before.backupDir!, "package.json");
    expect(existsSync(backupPath)).toBe(true);
    rmSync(backupPath, { force: true });

    // 核心断言：rollback 抛错（fail-closed），而非静默不恢复
    await expect(guard.rollback(before, modified)).rejects.toThrow(
      /备份文件不存在/
    );

    await guard.dispose(before);
    await guard.dispose(after);
  });

  it("P1-R01 §10.2：.git 目录被删除后 rollback 抛错（无备份，fail-closed）", async () => {
    const guard = new LocalWorktreeFilesystemGuard();
    const worktreePath = createRealWorktree(testDir, "wt-fc-2");

    // 创建 .git 目录（完整 clone 场景）
    mkdirSync(join(worktreePath, ".git"), { recursive: true });

    const before = await guard.createSnapshot(worktreePath);
    // 确认 .git 被纳入快照
    expect(before.entries.has(".git")).toBe(true);

    // 模拟 Omp 删除 .git 目录
    rmSync(join(worktreePath, ".git"), { recursive: true, force: true });

    const after = await guard.createSnapshot(worktreePath);
    const changes = guard.detectChanges(before, after);
    const gitChanges = changes.filter((c) => c.relativePath === ".git");
    expect(gitChanges.length).toBe(1);
    expect(gitChanges[0]!.type).toBe("deleted");

    // 核心断言：rollback 抛错（.git 目录未备份内部内容，fail-closed）
    await expect(guard.rollback(before, gitChanges)).rejects.toThrow(
      /备份文件不存在/
    );

    await guard.dispose(before);
    await guard.dispose(after);
  });

  it("P1-R01 §10.2：无 before 信息的变更 rollback 抛错（fail-closed）", async () => {
    const guard = new LocalWorktreeFilesystemGuard();
    const worktreePath = createRealWorktree(testDir, "wt-fc-3");

    const before = await guard.createSnapshot(worktreePath);

    // 构造一个无 before 信息的变更（模拟数据损坏）
    const fakeChange: FilesystemChange = {
      type: "modified",
      relativePath: "package.json",
      before: undefined,
      after: before.entries.get("package.json")
    };

    // 核心断言：rollback 抛错（无 before 信息，fail-closed）
    await expect(guard.rollback(before, [fakeChange])).rejects.toThrow(
      /无 before 信息/
    );

    await guard.dispose(before);
  });

  // ==========================================================================
  // 集成 ExecutionOrchestrator.runDevelop：fail-closed + 完整性校验
  // ==========================================================================

  describe("集成 enforceFilesystemScope：fail-closed + 回滚后完整性校验", () => {
    let fixture: RealFsTestFixture;

    beforeEach(async () => {
      fixture = createRealFsFixture(testDir);
      await fixture.store.unitOfWork.run(async (tx) => {
        await tx.projects.save(sampleProject());
      });
    });

    /**
     * 辅助：创建带自定义 guard 的 ExecutionOrchestrator。
     */
    function createExecWithCustomGuard(
      fixture: RealFsTestFixture,
      guard: WorktreeFilesystemGuard
    ): ExecutionOrchestrator {
      const worktreeManager = new WorktreeManager({
        gitAdapter: fixture.fakeGit,
        orchestrator: fixture.orchestrator,
        unitOfWork: fixture.store.unitOfWork
      });
      return new ExecutionOrchestrator({
        unitOfWork: fixture.store.unitOfWork,
        runtime: fixture.runtime,
        worktreeManager,
        eventSink: new FakeRuntimeEventSink(),
        processRunner: fixture.fakeProcess,
        processPolicy: {
          allowedCwdRoots: [testDir],
          inheritEnv: false,
          maxOutputBytes: 1024 * 1024,
          timeoutMs: 30000,
          disallowCredentialVars: true
        },
        filesystemGuard: guard
      });
    }

    it("P1-R01 §10.2：rollback 失败 → 写 rollbackFailed 审计并抛 PathScopeViolationError", async () => {
      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-int-fc-1");
      const guard = new ThrowingRollbackGuard(new LocalWorktreeFilesystemGuard());
      const exec = createExecWithCustomGuard(fixture, guard);

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // 设置 Runtime 副作用：在 allowedPaths 外创建文件
      runtime.setDevelopSideEffect((wtPath) => {
        writeFileSync(join(wtPath, "evil.txt"), "malicious", "utf8");
      });

      // 核心断言：runDevelop 抛 PathScopeViolationError（rollback 失败 → fail-closed）
      await expect(exec.runDevelop(task.id)).rejects.toBeInstanceOf(
        PathScopeViolationError
      );

      // 核心断言：审计中有 rollbackFailed 事件
      const audits = await fixture.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const rollbackFailedAudit = audits.find(
        (a) => a.deniedAction === "runDevelop.filesystemScopeViolation.rollbackFailed"
      );
      expect(rollbackFailedAudit).toBeDefined();
      expect(rollbackFailedAudit!.type).toBe("policy_denied");

      // 核心断言：越界文件仍然存在（rollback 失败未恢复）
      // 但任务已被拒绝，不会进入验证或 Review
      expect(existsSync(join(worktreePath, "evil.txt"))).toBe(true);
    });

    it("P1-R01 §10.2：rollback 不完整 → 完整性校验失败并抛 PathScopeViolationError", async () => {
      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-int-fc-2");
      // NoOpRollbackGuard：rollback 是 no-op，不实际恢复文件
      const guard = new NoOpRollbackGuard(new LocalWorktreeFilesystemGuard());
      const exec = createExecWithCustomGuard(fixture, guard);

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["src/**"]);

      // 设置 Runtime 副作用：在 allowedPaths 外创建文件
      runtime.setDevelopSideEffect((wtPath) => {
        writeFileSync(join(wtPath, "evil.txt"), "malicious", "utf8");
      });

      // 核心断言：runDevelop 抛 PathScopeViolationError
      // （rollback "成功"但未实际恢复 → 完整性校验检测到越界路径仍有变更）
      await expect(exec.runDevelop(task.id)).rejects.toBeInstanceOf(
        PathScopeViolationError
      );

      // 核心断言：审计中有 rollbackIncomplete 事件
      const audits = await fixture.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const incompleteAudit = audits.find(
        (a) =>
          a.deniedAction ===
          "runDevelop.filesystemScopeViolation.rollbackIncomplete"
      );
      expect(incompleteAudit).toBeDefined();
      expect(incompleteAudit!.type).toBe("policy_denied");

      // 核心断言：越界文件仍存在（rollback 是 no-op，完整性校验阻止了继续）
      expect(existsSync(join(worktreePath, "evil.txt"))).toBe(true);
    });

    it("P1-R01 §10.2：.git 被删除 → rollback 失败关闭（无备份无法恢复）", async () => {
      const { orchestrator, runtime } = fixture;
      const worktreePath = createRealWorktree(testDir, "wt-int-fc-3");
      // 创建 .git 目录（完整 clone 场景）
      mkdirSync(join(worktreePath, ".git"), { recursive: true });
      const guard = new LocalWorktreeFilesystemGuard();
      const exec = createExecWithCustomGuard(fixture, guard);

      const task = await orchestrator.createTask({
        projectId: "proj-fs-guard",
        input: sampleTaskInput()
      });
      await moveToExecutingWithRealWorktree(fixture, task.id, worktreePath, ["**"]);

      // 设置 Runtime 副作用：删除 .git 目录（受保护路径，无条件越界）
      runtime.setDevelopSideEffect((wtPath) => {
        rmSync(join(wtPath, ".git"), { recursive: true, force: true });
      });

      // 核心断言：runDevelop 抛 PathScopeViolationError
      // （.git 删除 → rollback 尝试恢复但无备份 → fail-closed）
      await expect(exec.runDevelop(task.id)).rejects.toBeInstanceOf(
        PathScopeViolationError
      );

      // 核心断言：审计中有 rollbackFailed 事件（.git 目录无备份，恢复抛错）
      const audits = await fixture.store.unitOfWork.run((tx) =>
        tx.audit.findByTask(task.id)
      );
      const rollbackFailedAudit = audits.find(
        (a) => a.deniedAction === "runDevelop.filesystemScopeViolation.rollbackFailed"
      );
      expect(rollbackFailedAudit).toBeDefined();
    });
  });
});
