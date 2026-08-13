/**
 * OmpAdapter 单元测试 —— Phase 4（ADR-007）。
 *
 * 不依赖真实 omp 二进制或 LLM API key。所有 omp 调用通过 stub
 * ProcessRunner 模拟，验证：
 *
 * 1. argv 组装与治理（validateOmpArgv 等价 CommandPolicy）
 * 2. NDJSON 流式事件解析（parseOmpNdjsonEvents）
 * 3. ReviewResult 严格提取（extractReviewResult）
 * 4. analyze/develop/review/cancel 端到端行为
 *
 * 真实 omp + LLM 闭环测试待 API key 配置后由专门集成测试覆盖，
 * 见 ADR-007 §待解决问题。
 */

import { describe, expect, it } from "vitest";
import {
  OmpAdapter,
  OmpUnavailableError,
  OmpArgvValidationError,
  PolicyDeniedError,
  parseOmpNdjsonEvents,
  extractAssistantTextFromOmpNdjson,
  buildReviewResultOutputExample,
  extractReviewResult,
  extractFileChangesFromStdout,
  extractFileChangesFromText
} from "../src/index.js";
import type {
  ProcessRunner,
  CommandResult,
  ProcessPolicy,
  ProjectCommands,
  PathPolicy,
  PathPolicyDecision,
  RuntimeEvent,
  ReviewTaskInput,
  RuntimeTaskInput,
  ControlledFileWriter,
  FileChangeInstruction
} from "@tracepilot/core";
import { PathScopeViolationError } from "@tracepilot/core";

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

const FAKE_OMP = "/fake/omp";
const FAKE_WT = "/fake/wt";

/**
 * 测试专用 PathPolicy：不调用 realpathSync，只做字符串前缀检查。
 *
 * OmpAdapter 测试聚焦 OmpAdapter 自身逻辑（argv 组装、NDJSON 解析、
 * ReviewResult 提取）。PathPolicy 的真实行为（symlink 解析、祖先回退）
 * 由 governance 包的 path-policy 单元测试覆盖。真实闭环测试（待 API key）
 * 使用 DefaultPathPolicy + 真实 worktree。
 */
class FakeStringPathPolicy implements PathPolicy {
  decide(unresolvedPath: string, roots: readonly string[]): PathPolicyDecision {
    if (!unresolvedPath || typeof unresolvedPath !== "string") {
      return { allowed: false, reason: "path must be a non-empty string" };
    }
    for (const root of roots) {
      if (unresolvedPath === root ||
          unresolvedPath.startsWith(root + "/") ||
          unresolvedPath.startsWith(root + "\\")) {
        return { allowed: true, reason: `inside root ${root}`, resolvedPath: unresolvedPath };
      }
    }
    return { allowed: false, reason: `path ${unresolvedPath} outside roots ${roots.join(", ")}` };
  }
}

function sampleTaskInput() {
  return {
    objective: "修复 create_user 返回 400 的 bug",
    constraints: ["不得改动 tests/ 目录"],
    acceptanceCriteria: ["test_create_user_returns_201 通过"],
    riskLevel: "low" as const,
    rawSource: "FAILED tests/test_users.py::test_create_user_returns_201\nassert 201 == 400",
    origin: "failed_test_log" as const
  };
}

function sampleProjectCommands(): ProjectCommands {
  return {
    test: { argv: ["pytest", "-x"], timeoutMs: 60000 },
    lint: { argv: ["ruff", "check"], timeoutMs: 30000 }
  };
}

function sampleProcessPolicy(allowedRoots: readonly string[] = [FAKE_WT]): ProcessPolicy {
  return {
    timeoutMs: 10000,
    maxOutputBytes: 64 * 1024,
    allowedCwdRoots: [...allowedRoots],
    inheritEnv: false
  };
}

function sampleRuntimeInput(overrides: Partial<RuntimeTaskInput> = {}): RuntimeTaskInput {
  return {
    taskId: "task-1",
    worktreePath: FAKE_WT,
    allowedPaths: ["src/**"],
    evidencePackId: "pack-1",
    evidencePackVersion: 1,
    taskInput: sampleTaskInput(),
    projectCommands: {
      test: { argv: ["python", "-m", "pytest"], timeoutMs: 60000 }
    },
    ...overrides
  };
}

function sampleEvidencePack(): ReviewTaskInput["evidencePack"] {
  return {
    id: "pack-1",
    taskId: "task-1",
    version: 1,
    taskSnapshot: sampleTaskInput(),
    evidence: [{
      id: "e-1",
      kind: "code",
      source: "code-search",
      locator: "src/users.py:1",
      capturedAt: "2026-08-03T00:00:00.000Z",
      contentHash: "fnv1a32-evidence",
      summary: "旧版返回结构来源",
      relevance: 1,
      trustLevel: "PRIMARY"
    }],
    hypotheses: [
      {
        text: "旧版返回结构被新实现覆盖",
        confidence: 0.9,
        evidenceIds: ["e-1"]
      }
    ],
    constraints: [
      {
        text: "必须兼容旧版客户端",
        evidenceIds: ["e-1"],
        required: true
      }
    ],
    acceptanceCriteria: ["test_create_user_returns_201 通过"],
    createdAt: "2026-08-03T00:00:00.000Z",
    contentHash: "fnv1a32-test"
  };
}

function sampleReviewInput(overrides: Partial<ReviewTaskInput> = {}): ReviewTaskInput {
  return {
    taskId: "task-1",
    worktreePath: FAKE_WT,
    evidencePackId: "pack-1",
    evidencePackVersion: 1,
    evidencePack: sampleEvidencePack(),
    taskInput: sampleTaskInput(),
    diff: {
      worktreePath: FAKE_WT,
      patch: "diff --git a/src/users.py b/src/users.py\n-return {\"status\": 400}\n+return {\"status\": 201}\n",
      hash: "sha256-abc",
      changedFiles: ["src/users.py"],
      bytes: 100
    },
    verificationResult: { passed: true, exitCode: 0 },
    acceptanceCriteria: ["test_create_user_returns_201 通过"],
    ...overrides
  };
}

/** 构造 stub ProcessRunner，按需返回预设 CommandResult。 */
function makeStubRunner(result: Partial<CommandResult> = {}): ProcessRunner & { invoked: number; lastArgv?: readonly string[]; lastAbortSignal?: AbortSignal } {
  let invoked = 0;
  let lastArgv: readonly string[] | undefined;
  let lastAbortSignal: AbortSignal | undefined;
  const runner: ProcessRunner = {
    async run(spec, _cwd, _policy, abortSignal?) {
      invoked++;
      lastArgv = spec.argv;
      lastAbortSignal = abortSignal;
      return {
        argv: spec.argv,
        cwd: FAKE_WT,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
        originalBytes: 0,
        retainedBytes: 0,
        timedOut: false,
        startedAt: "2026-07-27T00:00:00.000Z",
        endedAt: "2026-07-27T00:00:01.000Z",
        ...result
      };
    }
  };
  return {
    ...runner,
    get invoked() { return invoked; },
    get lastArgv() { return lastArgv; },
    get lastAbortSignal() { return lastAbortSignal; }
  } as ProcessRunner & { invoked: number; lastArgv?: readonly string[]; lastAbortSignal?: AbortSignal };
}

/**
 * 测试专用 ControlledFileWriter：记录所有调用，可注入拒绝行为。
 *
 * 默认接受所有写入并记录；若 `rejectPaths` 非空，则当 changes 中任一路径
 * 命中 `rejectPaths` 时抛 PathScopeViolationError（模拟路径越界）。
 */
class FakeControlledFileWriter implements ControlledFileWriter {
  readonly writes: Array<{
    taskId: string;
    worktreePath: string;
    allowedPaths: readonly string[];
    changes: readonly FileChangeInstruction[];
  }> = [];
  readonly rejectPaths: ReadonlySet<string>;

  constructor(opts: { rejectPaths?: readonly string[] } = {}) {
    this.rejectPaths = new Set(opts.rejectPaths ?? []);
  }

  async writeFiles(
    taskId: string,
    worktreePath: string,
    allowedPaths: readonly string[],
    changes: readonly FileChangeInstruction[]
  ): Promise<void> {
    this.writes.push({ taskId, worktreePath, allowedPaths, changes });
    const violators = changes
      .filter((c) => this.rejectPaths.has(c.relativePath))
      .map((c) => c.relativePath);
    if (violators.length > 0) {
      throw new PathScopeViolationError(taskId, violators, allowedPaths);
    }
  }
}

function makeOmpAdapter(opts: {
  processRunner?: ProcessRunner;
  allowedRoots?: readonly string[];
  ompPath?: string;
  model?: string;
  extraReadonlyDirs?: readonly string[];
  defaultTimeoutMs?: number;
  controlledFileWriter?: ControlledFileWriter;
}) {
  const roots = opts.allowedRoots ?? [FAKE_WT];
  return new OmpAdapter({
    processRunner: opts.processRunner ?? makeStubRunner(),
    pathPolicy: new FakeStringPathPolicy(),
    processPolicy: sampleProcessPolicy(roots),
    projectCommands: sampleProjectCommands(),
    allowedWorktreeRoots: roots,
    ompPath: opts.ompPath ?? FAKE_OMP,
    // P1-R01（§18 受控文件工具代理）：develop 必须注入 ControlledFileWriter。
    // 默认使用 FakeControlledFileWriter（接受所有写入）。测试可注入自定义实例。
    controlledFileWriter: opts.controlledFileWriter ?? new FakeControlledFileWriter(),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.extraReadonlyDirs ? { extraReadonlyDirs: opts.extraReadonlyDirs } : {}),
    ...(opts.defaultTimeoutMs ? { defaultTimeoutMs: opts.defaultTimeoutMs } : {})
  });
}

// ---------------------------------------------------------------------------
// 1. argv 组装与治理
// ---------------------------------------------------------------------------

describe("OmpAdapter argv 组装与治理（validateOmpArgv）", () => {
  it("analyze 调用 ProcessRunner 时 argv 结构符合 ADR-007 §决策 2", async () => {
    const runner = makeStubRunner({ stdout: "" });
    const omp = makeOmpAdapter({ processRunner: runner });
    const events: RuntimeEvent[] = [];
    for await (const ev of omp.analyze(sampleRuntimeInput())) {
      events.push(ev);
    }
    expect(runner.invoked).toBe(1);
    const argv = runner.lastArgv!;
    expect(argv[0]).toBe(FAKE_OMP);
    expect(argv[1]).toBe("-p");
    expect(argv).toContain("--mode");
    expect(argv[argv.indexOf("--mode") + 1]).toBe("json");
    expect(argv).toContain("--cwd");
    expect(argv[argv.indexOf("--cwd") + 1]).toBe(FAKE_WT);
    expect(argv).toContain("--approval-mode=write");
    // P1-R01：禁止 yolo 模式（绕过工作区写入边界）
    expect(argv).not.toContain("--auto-approve");
    expect(argv).not.toContain("--approval-mode=yolo");
    expect(argv).toContain("--no-session");
    expect(argv).toContain("--max-time");
    // 最后一个元素是 prompt（非空字符串）
    const prompt = argv[argv.length - 1];
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    // prompt 应包含任务目标
    expect(prompt).toContain("修复 create_user");
  });

  it("defaultTimeoutMs 注入 --max-time（毫秒转秒）", async () => {
    const runner = makeStubRunner({ stdout: "" });
    const omp = makeOmpAdapter({ processRunner: runner, defaultTimeoutMs: 60000 });
    for await (const _ev of omp.analyze(sampleRuntimeInput())) void _ev;
    const argv = runner.lastArgv!;
    const maxTimeIdx = argv.indexOf("--max-time");
    expect(argv[maxTimeIdx + 1]).toBe("60");
  });

  it("model 选项注入 --model 参数", async () => {
    const runner = makeStubRunner({ stdout: "" });
    const omp = makeOmpAdapter({ processRunner: runner, model: "claude-sonnet-4" });
    for await (const _ev of omp.analyze(sampleRuntimeInput())) void _ev;
    const argv = runner.lastArgv!;
    const modelIdx = argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(argv[modelIdx + 1]).toBe("claude-sonnet-4");
  });

  it("extraReadonlyDirs 注入 --add-dir（每个目录都经 PathPolicy 校验）", async () => {
    const runner = makeStubRunner({ stdout: "" });
    const omp = makeOmpAdapter({
      processRunner: runner,
      // 把 /fake/readonly 也加入允许根目录，否则 --add-dir 会被 PathPolicy 拒绝
      allowedRoots: [FAKE_WT, "/fake/readonly"],
      extraReadonlyDirs: ["/fake/readonly"]
    });
    for await (const _ev of omp.analyze(sampleRuntimeInput())) void _ev;
    const argv = runner.lastArgv!;
    const addDirIdx = argv.indexOf("--add-dir");
    expect(addDirIdx).toBeGreaterThan(-1);
    expect(argv[addDirIdx + 1]).toBe("/fake/readonly");
  });

  it("analyze 在 worktree 路径越界时不调用 ProcessRunner 且产出 error", async () => {
    const runner = makeStubRunner();
    const omp = makeOmpAdapter({
      processRunner: runner,
      allowedRoots: ["/allowed/wt"]
    });
    const events: RuntimeEvent[] = [];
    for await (const ev of omp.analyze(sampleRuntimeInput({ worktreePath: "/outside/wt" }))) {
      events.push(ev);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("error");
    expect(types).not.toContain("completed");
    expect(runner.invoked).toBe(0);
  });

  it("review 在 worktree 路径越界时抛 PolicyDeniedError", async () => {
    const runner = makeStubRunner();
    const omp = makeOmpAdapter({
      processRunner: runner,
      allowedRoots: ["/allowed/wt"]
    });
    await expect(
      omp.review(sampleReviewInput({ worktreePath: "/outside/wt" }))
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(runner.invoked).toBe(0);
  });

  // P1-01：--tools 标志按阶段限制 omp 可用工具集（CLI 级强制安全边界）
  it("P1-01：analyze 阶段 argv 包含 --tools read,grep,glob（只读工具）", async () => {
    const runner = makeStubRunner({ stdout: "" });
    const omp = makeOmpAdapter({ processRunner: runner });
    for await (const _ev of omp.analyze(sampleRuntimeInput())) void _ev;
    const argv = runner.lastArgv!;
    const toolsIdx = argv.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(argv[toolsIdx + 1]).toBe("read,grep,glob");
    // 不应包含 bash/browser 等高风险工具
    const toolsValue = argv[toolsIdx + 1] as string;
    expect(toolsValue).not.toContain("bash");
    expect(toolsValue).not.toContain("browser");
    expect(toolsValue).not.toContain("network");
  });

  it("P1-R01（§18）：develop 阶段 argv 包含 --tools read,grep,glob（只读，无 edit/write/bash）", async () => {
    const runner = makeStubRunner({ stdout: "" });
    const omp = makeOmpAdapter({ processRunner: runner });
    for await (const _ev of omp.develop(sampleRuntimeInput())) void _ev;
    const argv = runner.lastArgv!;
    const toolsIdx = argv.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    // P1-R01 §18：omp develop 没有写入能力，所有文件修改通过 <file_change>
    // XML 指令输出，由 ControlledFileWriter 代为写入并在写入前同步校验路径。
    expect(argv[toolsIdx + 1]).toBe("read,grep,glob");
    const toolsValue = argv[toolsIdx + 1] as string;
    expect(toolsValue).not.toContain("bash");
    expect(toolsValue).not.toContain("browser");
    expect(toolsValue).not.toContain("edit");
    expect(toolsValue).not.toContain("write");
  });

  it("P1-01：review 阶段 argv 包含 --no-tools（无任何工具）", async () => {
    const runner = makeStubRunner({
      stdout: JSON.stringify({ verdict: "ship", findings: [], summary: "ok" })
    });
    const omp = makeOmpAdapter({ processRunner: runner });
    await omp.review(sampleReviewInput());
    const argv = runner.lastArgv!;
    const modeIdx = argv.indexOf("--mode");
    expect(argv[modeIdx + 1]).toBe("json");
    expect(argv).toContain("--no-tools");
    expect(argv).not.toContain("--tools");
    expect(argv).toContain("--system-prompt");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toContain("tracepilot_review_result");
    expect(argv[argv.indexOf("--thinking") + 1]).toBe("off");
    expect(argv[argv.length - 1]).toContain('"locator": "src/users.py:1"');
    expect(argv[argv.length - 1]).toContain('"contentHash": "fnv1a32-test"');
  });

  it("P1-01：validateOmpArgv 拒绝不含 --tools 或 --no-tools 的 argv", () => {
    // 直接构造一个不含工具限制的 argv，验证 validateOmpArgv 拒绝
    const omp = makeOmpAdapter({});
    // 通过内部 buildOmpArgv 构造合法 argv，然后移除 --tools 部分模拟绕过
    // 这里用反射访问私有方法验证
    const buildArgv = (omp as unknown as {
      buildOmpArgv: (wt: string, prompt: string, ms: number, phase: "analyze" | "develop" | "review") => string[];
    }).buildOmpArgv;
    const argv = buildArgv.call(omp, FAKE_WT, "prompt", 10000, "analyze");
    // 移除 --tools 及其值，模拟 omp 被以默认全工具集启动
    const toolsIdx = argv.indexOf("--tools");
    const argvWithoutTools = [...argv.slice(0, toolsIdx), ...argv.slice(toolsIdx + 2)];
    const validate = (omp as unknown as { validateOmpArgv: (a: readonly string[]) => void }).validateOmpArgv;
    expect(() => validate.call(omp, argvWithoutTools)).toThrow(/missing-tools-restriction/);
  });

  it("P1-01：validateOmpArgv 拒绝 --tools 含 bash 的 argv", () => {
    const omp = makeOmpAdapter({});
    const buildArgv = (omp as unknown as {
      buildOmpArgv: (wt: string, prompt: string, ms: number, phase: "analyze" | "develop" | "review") => string[];
    }).buildOmpArgv;
    const argv = buildArgv.call(omp, FAKE_WT, "prompt", 10000, "develop");
    // 把 --tools 值改为含 bash 的列表
    const toolsIdx = argv.indexOf("--tools");
    const argvWithBash = [...argv.slice(0, toolsIdx + 1), "read,bash,write", ...argv.slice(toolsIdx + 2)];
    const validate = (omp as unknown as { validateOmpArgv: (a: readonly string[]) => void }).validateOmpArgv;
    expect(() => validate.call(omp, argvWithBash)).toThrow(/forbidden-tool-in-whitelist/);
  });

  it("P1-R01（§18）：validateOmpArgv 拒绝 --tools 含 edit 或 write 的 argv（受控文件工具代理）", () => {
    const omp = makeOmpAdapter({});
    const buildArgv = (omp as unknown as {
      buildOmpArgv: (wt: string, prompt: string, ms: number, phase: "analyze" | "develop" | "review") => string[];
    }).buildOmpArgv;
    const validate = (omp as unknown as { validateOmpArgv: (a: readonly string[]) => void }).validateOmpArgv;
    // 测试 edit 被拒绝
    const argvBase = buildArgv.call(omp, FAKE_WT, "prompt", 10000, "develop");
    const toolsIdx = argvBase.indexOf("--tools");
    const argvWithEdit = [...argvBase.slice(0, toolsIdx + 1), "read,grep,glob,edit", ...argvBase.slice(toolsIdx + 2)];
    expect(() => validate.call(omp, argvWithEdit)).toThrow(/forbidden-tool-in-whitelist/);
    // 测试 write 被拒绝
    const argvWithWrite = [...argvBase.slice(0, toolsIdx + 1), "read,grep,glob,write", ...argvBase.slice(toolsIdx + 2)];
    expect(() => validate.call(omp, argvWithWrite)).toThrow(/forbidden-tool-in-whitelist/);
  });

  it("P1-R01：validateOmpArgv 拒绝含 --auto-approve 的 argv（yolo 模式绕过工作区边界）", () => {
    const omp = makeOmpAdapter({});
    const buildArgv = (omp as unknown as {
      buildOmpArgv: (wt: string, prompt: string, ms: number, phase: "analyze" | "develop" | "review") => string[];
    }).buildOmpArgv;
    const argv = buildArgv.call(omp, FAKE_WT, "prompt", 10000, "develop");
    // 把 --approval-mode=write 替换为 --auto-approve
    const modeIdx = argv.indexOf("--approval-mode=write");
    const argvWithYolo = [...argv.slice(0, modeIdx), "--auto-approve", ...argv.slice(modeIdx + 1)];
    const validate = (omp as unknown as { validateOmpArgv: (a: readonly string[]) => void }).validateOmpArgv;
    expect(() => validate.call(omp, argvWithYolo)).toThrow(/forbidden-yolo-mode/);
  });

  it("P1-R01：validateOmpArgv 拒绝不含 --approval-mode=write 的 argv", () => {
    const omp = makeOmpAdapter({});
    const buildArgv = (omp as unknown as {
      buildOmpArgv: (wt: string, prompt: string, ms: number, phase: "analyze" | "develop" | "review") => string[];
    }).buildOmpArgv;
    const argv = buildArgv.call(omp, FAKE_WT, "prompt", 10000, "develop");
    // 移除 --approval-mode=write
    const modeIdx = argv.indexOf("--approval-mode=write");
    const argvWithoutMode = [...argv.slice(0, modeIdx), ...argv.slice(modeIdx + 1)];
    const validate = (omp as unknown as { validateOmpArgv: (a: readonly string[]) => void }).validateOmpArgv;
    expect(() => validate.call(omp, argvWithoutMode)).toThrow(/missing-approval-mode-write/);
  });

  // P1-R01 §11.2（第七次复验）：--no-extensions / --no-skills / --no-rules
  // 必需固定拓扑契约测试。缺失任一都必须失败关闭。
  it("P1-R01 §11.2：validateOmpArgv 拒绝缺失 --no-extensions 的 argv", () => {
    const omp = makeOmpAdapter({});
    const buildArgv = (omp as unknown as {
      buildOmpArgv: (wt: string, prompt: string, ms: number, phase: "analyze" | "develop" | "review") => string[];
    }).buildOmpArgv;
    const argv = buildArgv.call(omp, FAKE_WT, "prompt", 10000, "develop");
    const idx = argv.indexOf("--no-extensions");
    const argvMissing = [...argv.slice(0, idx), ...argv.slice(idx + 1)];
    const validate = (omp as unknown as { validateOmpArgv: (a: readonly string[]) => void }).validateOmpArgv;
    expect(() => validate.call(omp, argvMissing)).toThrow(/missing-no-auto-discovery-flag/);
  });

  it("P1-R01 §11.2：validateOmpArgv 拒绝缺失 --no-skills 的 argv", () => {
    const omp = makeOmpAdapter({});
    const buildArgv = (omp as unknown as {
      buildOmpArgv: (wt: string, prompt: string, ms: number, phase: "analyze" | "develop" | "review") => string[];
    }).buildOmpArgv;
    const argv = buildArgv.call(omp, FAKE_WT, "prompt", 10000, "analyze");
    const idx = argv.indexOf("--no-skills");
    const argvMissing = [...argv.slice(0, idx), ...argv.slice(idx + 1)];
    const validate = (omp as unknown as { validateOmpArgv: (a: readonly string[]) => void }).validateOmpArgv;
    expect(() => validate.call(omp, argvMissing)).toThrow(/missing-no-auto-discovery-flag/);
  });

  it("P1-R01 §11.2：validateOmpArgv 拒绝缺失 --no-rules 的 argv", () => {
    const omp = makeOmpAdapter({});
    const buildArgv = (omp as unknown as {
      buildOmpArgv: (wt: string, prompt: string, ms: number, phase: "analyze" | "develop" | "review") => string[];
    }).buildOmpArgv;
    const argv = buildArgv.call(omp, FAKE_WT, "prompt", 10000, "review");
    const idx = argv.indexOf("--no-rules");
    const argvMissing = [...argv.slice(0, idx), ...argv.slice(idx + 1)];
    const validate = (omp as unknown as { validateOmpArgv: (a: readonly string[]) => void }).validateOmpArgv;
    expect(() => validate.call(omp, argvMissing)).toThrow(/missing-no-auto-discovery-flag/);
  });

  it("P1-R01 §11.2：validateOmpArgv 拒绝同时缺失三项 --no-* 的 argv", () => {
    const omp = makeOmpAdapter({});
    const buildArgv = (omp as unknown as {
      buildOmpArgv: (wt: string, prompt: string, ms: number, phase: "analyze" | "develop" | "review") => string[];
    }).buildOmpArgv;
    const argv = buildArgv.call(omp, FAKE_WT, "prompt", 10000, "develop");
    const argvMissing = argv.filter(
      (a) => a !== "--no-extensions" && a !== "--no-skills" && a !== "--no-rules"
    );
    const validate = (omp as unknown as { validateOmpArgv: (a: readonly string[]) => void }).validateOmpArgv;
    expect(() => validate.call(omp, argvMissing)).toThrow(/missing-no-auto-discovery-flag/);
  });

  it("P1-R01 §11.2：正常 argv（含三项 --no-*）通过 validateOmpArgv", () => {
    const omp = makeOmpAdapter({});
    const buildArgv = (omp as unknown as {
      buildOmpArgv: (wt: string, prompt: string, ms: number, phase: "analyze" | "develop" | "review") => string[];
    }).buildOmpArgv;
    const argv = buildArgv.call(omp, FAKE_WT, "prompt", 10000, "develop");
    // buildOmpArgv 应自动包含三项 --no-*
    expect(argv).toContain("--no-extensions");
    expect(argv).toContain("--no-skills");
    expect(argv).toContain("--no-rules");
    // validateOmpArgv 不抛错
    const validate = (omp as unknown as { validateOmpArgv: (a: readonly string[]) => void }).validateOmpArgv;
    expect(() => validate.call(omp, argv)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. NDJSON 解析
// ---------------------------------------------------------------------------

describe("parseOmpNdjsonEvents", () => {
  it("空 stdout 返回空数组", () => {
    expect(parseOmpNdjsonEvents("", "run-1")).toEqual([]);
  });

  it("已知事件类型映射到对应 RuntimeEvent", () => {
    // 使用真实 omp --mode json 的事件类型（经 Phase 4 闭环验证）：
    // session → started; message_update.toolcall_end → tool_call;
    // tool_execution_end → tool_result; message_update.thinking_end → progress;
    // turn_end.isTerminal=true → completed
    const stdout = [
      JSON.stringify({ type: "session", at: "2026-07-27T00:00:00.000Z" }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          toolCall: { name: "git", intent: "status", arguments: { cwd: "/wt" } }
        },
        at: "2026-07-27T00:00:01.000Z"
      }),
      JSON.stringify({
        type: "tool_execution_end",
        isError: false,
        result: { content: [{ type: "text", text: "x".repeat(100) }] },
        at: "2026-07-27T00:00:02.000Z"
      }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", content: "分析中…" },
        at: "2026-07-27T00:00:03.000Z"
      }),
      JSON.stringify({ type: "turn_end", isTerminal: true, at: "2026-07-27T00:00:04.000Z" })
    ].join("\n");
    const events = parseOmpNdjsonEvents(stdout, "run-1");
    expect(events.map((e) => e.type)).toEqual([
      "started",
      "tool_call",
      "tool_result",
      "progress",
      "completed"
    ]);
    expect(events[0]).toMatchObject({ type: "started", runId: "run-1" });
    expect(events[1]).toMatchObject({ type: "tool_call", tool: "git", argv: ["status"], cwd: "/wt" });
    expect(events[2]).toMatchObject({ type: "tool_result", exitCode: 0, truncated: false });
    expect((events[2] as { bytes: number }).bytes).toBe(100);
    expect(events[3]).toMatchObject({ type: "progress", message: "[thinking] 分析中…" });
    expect(events[4]).toMatchObject({ type: "completed", summary: "omp 会话已结束（isTerminal=true）" });
  });

  it("error 事件映射到 RuntimeEvent.error", () => {
    const stdout = JSON.stringify({ type: "error", message: "API key 无效", at: "2026-07-27T00:00:00.000Z" });
    const events = parseOmpNdjsonEvents(stdout, "run-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", message: "API key 无效", runId: "run-1" });
  });

  it("未知事件类型降级为 progress（保留原始 type 与摘要）", () => {
    const stdout = JSON.stringify({ type: "custom.event", foo: "bar", at: "2026-07-27T00:00:00.000Z" });
    const events = parseOmpNdjsonEvents(stdout, "run-1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("progress");
    const progress = events[0] as { type: "progress"; message: string };
    expect(progress.message).toContain("custom.event");
    expect(progress.message).toContain("foo");
  });

  it("非 JSON 行降级为 progress 事件（标注 non-json-line）", () => {
    const stdout = "this is not json\n{\"type\":\"progress\",\"message\":\"ok\"}";
    const events = parseOmpNdjsonEvents(stdout, "run-1");
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("progress");
    const progress0 = events[0] as { type: "progress"; message: string };
    expect(progress0.message).toContain("non-json-line");
    expect(events[1].type).toBe("progress");
  });

  it("多行 NDJSON 解析顺序保留", () => {
    // 使用真实 omp 事件类型（session / message_update.thinking_end / turn_end）
    const stdout = [
      JSON.stringify({ type: "session", at: "t0" }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", content: "step 1" },
        at: "t1"
      }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", content: "step 2" },
        at: "t2"
      }),
      JSON.stringify({ type: "turn_end", isTerminal: true, at: "t3" })
    ].join("\n");
    const events = parseOmpNdjsonEvents(stdout, "run-1");
    expect(events.map((e) => e.type)).toEqual(["started", "progress", "progress", "completed"]);
  });
});

// ---------------------------------------------------------------------------
// 3. ReviewResult 提取
// ---------------------------------------------------------------------------

describe("extractReviewResult", () => {
  function reviewJson(category: "compatibility" | "regression_test"): string {
    return JSON.stringify({
      verdict: "block",
      findings: [{
        priority: "P1",
        confidence: 0.99,
        category,
        message: category === "compatibility" ? "破坏既有返回契约" : "缺少回归测试"
      }],
      summary: "需要阻断并人工复核"
    });
  }

  function ndjsonMessage(
    message: Record<string, unknown>
  ): string {
    return JSON.stringify({ type: "message_end", message });
  }

  it("Review prompt 示例使用可被严格 schema 接受的 JSON 类型", () => {
    const example = buildReviewResultOutputExample();
    const result = extractReviewResult(example, sampleReviewInput());
    expect(result.verdict).toBe("ship_with_fixes");
    expect(result.findings[0]).toMatchObject({
      priority: "P2",
      confidence: 0.95,
      category: "correctness"
    });
    expect(example).not.toContain('"confidence": "0.0-1.0"');
    expect(example).toContain('"confidence": 0.95');
  });

  it("按 session → message_end → turn_end 提取 assistant compatibility Review", () => {
    const stdout = [
      JSON.stringify({ type: "session", id: "session-1" }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", content: "不得把 thinking 当作结论" }
      }),
      ndjsonMessage({
        role: "assistant",
        content: [
          { type: "thinking", text: "忽略这段 thinking" },
          { type: "text", text: reviewJson("compatibility") }
        ]
      }),
      JSON.stringify({ type: "turn_end", isTerminal: true })
    ].join("\n");

    const extracted = extractAssistantTextFromOmpNdjson(stdout);
    expect(extracted.text).toBe(reviewJson("compatibility"));
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]).toMatchObject({ category: "compatibility" });
  });

  it("按多个 assistant 消息和多个 text block 顺序重组 regression_test Review", () => {
    const review = reviewJson("regression_test");
    const splitAt = Math.floor(review.length / 2);
    const stdout = [
      JSON.stringify({ type: "session", id: "session-2" }),
      ndjsonMessage({
        role: "toolResult",
        content: [{ type: "text", text: review }]
      }),
      ndjsonMessage({
        role: "assistant",
        content: [
          { type: "thinking", text: "忽略" },
          { type: "text", text: review.slice(0, splitAt) }
        ]
      }),
      ndjsonMessage({
        role: "assistant",
        content: [{ type: "text", text: review.slice(splitAt) }]
      }),
      JSON.stringify({ type: "turn_end", isTerminal: true })
    ].join("\n");

    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.findings[0]).toMatchObject({ category: "regression_test" });
  });

  it("超过 256 KiB 的真实形状 NDJSON 仍能读取尾部 ReviewResult", () => {
    const filler = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: { path: "src/users.py" } }]
      }
    });
    const stdout = [
      JSON.stringify({ type: "session", id: "session-large" }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", content: "前部 thinking" }
      }),
      ...Array.from({ length: 5000 }, () => filler),
      ndjsonMessage({
        role: "assistant",
        content: [{ type: "text", text: reviewJson("compatibility") }]
      }),
      JSON.stringify({ type: "turn_end", isTerminal: true })
    ].join("\n");

    expect(Buffer.byteLength(stdout, "utf8")).toBeGreaterThan(256 * 1024);
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.findings[0]).toMatchObject({ category: "compatibility" });
  });

  it("assistant 文本不是完整 JSON 时失败关闭并保留 fallback 原因", () => {
    const stdout = [
      JSON.stringify({ type: "session", id: "session-3" }),
      ndjsonMessage({
        role: "assistant",
        content: [
          { type: "text", text: "这不是 " },
          { type: "text", text: "JSON" }
        ]
      }),
      JSON.stringify({ type: "turn_end", isTerminal: true })
    ].join("\n");

    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]).toMatchObject({ priority: "P1", category: "other" });
    expect(result.findings[0]?.message).toContain("assistant 文本不是完整 ReviewResult JSON");
    expect(result.findings[0]?.message).toContain('"outputMode":"ndjson"');
    expect(result.findings[0]?.message).toContain('"textSegmentCount":2');
  });

  it("缺少 terminal assistant message 时失败关闭", () => {
    const stdout = [
      JSON.stringify({ type: "session", id: "session-4" }),
      JSON.stringify({ type: "turn_end", isTerminal: true })
    ].join("\n");

    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]?.category).toBe("other");
    expect(result.findings[0]?.message).toContain("未找到 terminal assistant message");
  });

  it("整段 stdout 是合法 JSON 时直接解析", () => {
    const stdout = JSON.stringify({
      verdict: "ship",
      findings: [{ priority: "P3", confidence: 0.4, category: "maintainability", message: "建议补充测试" }],
      rootCause: {
        text: "旧版返回结构被新实现覆盖",
        confidence: 0.9,
        evidenceIds: ["e-1"]
      },
      applicabilityConditions: [
        {
          text: "必须兼容旧版客户端",
          evidenceIds: ["e-1"],
          required: true
        }
      ],
      summary: "可以发布"
    });
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("ship");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ priority: "P3", confidence: 0.4, message: "建议补充测试" });
    expect(result.summary).toBe("可以发布");
  });

  it("stdout 包含前后说明文字时失败关闭且不泄露原文", () => {
    const stdout = `Here is my review:\n${reviewJson("compatibility")}\n机密模型原文`;
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ priority: "P1", category: "other" });
    expect(result.findings[0]?.message).toContain("jsonErrorCategory");
    expect(result.findings[0]?.message).not.toContain("机密模型原文");
  });

  it("单层完整 Markdown JSON 围栏按确定性规则通过", () => {
    const stdout = `\`\`\`json\n${reviewJson("regression_test")}\n\`\`\``;
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]).toMatchObject({ category: "regression_test" });
  });

  it("完整 TracePilot 审查信封按确定性规则通过", () => {
    const stdout = `<tracepilot_review_result>\n${reviewJson("compatibility")}\n</tracepilot_review_result>`;
    const result = extractReviewResult(stdout, sampleReviewInput());

    expect(result.verdict).toBe("block");
    expect(result.findings[0]).toMatchObject({ category: "compatibility" });
  });

  it("TracePilot 审查信封外存在说明文字时失败关闭", () => {
    const secretText = "模型不应泄露的附加说明";
    const stdout = `${secretText}\n<tracepilot_review_result>\n${reviewJson("compatibility")}\n</tracepilot_review_result>`;
    const result = extractReviewResult(stdout, sampleReviewInput());

    expect(result.verdict).toBe("block");
    expect(result.findings[0]).toMatchObject({ priority: "P1", category: "other" });
    expect(result.findings[0]?.message).not.toContain(secretText);
  });

  it("仅结束 Markdown 围栏且正文是完整 JSON 时通过", () => {
    const stdout = `${reviewJson("regression_test")}\n\`\`\``;
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]).toMatchObject({ category: "regression_test" });
  });

  it("仅起始 Markdown 围栏且正文是完整 JSON 时通过", () => {
    const stdout = `\`\`\`json\n${reviewJson("compatibility")}`;
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]).toMatchObject({ category: "compatibility" });
  });

  it("说明文字加结束围栏时失败关闭", () => {
    const stdout = `说明文字\n${reviewJson("compatibility")}\n\`\`\``;
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]?.category).toBe("other");
    const message = result.findings[0]?.message ?? "";
    expect(message).toContain('"normalizationForm":"invalid_fence"');
    expect(message).toContain('"closingFenceOnLastLine":true');
    expect(message).toContain('"objectStartsWithBrace":false');
    expect(message).toContain('"objectEndsWithBrace":true');
    expect(message).toContain('"internalFence":false');
    expect(message).toContain('"outputMode":"text"');
    expect(message).toContain('"textSegmentCount":1');
  });

  it("结束围栏不在最后一行时失败关闭并记录边界形态", () => {
    const stdout = `${reviewJson("compatibility")}\n\`\`\`\n尾部说明`;
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]?.category).toBe("other");
    const message = result.findings[0]?.message ?? "";
    expect(message).toContain('"normalizationForm":"invalid_fence"');
    expect(message).toContain('"closingFenceOnLastLine":false');
    expect(message).toContain('"objectStartsWithBrace":true');
    expect(message).toContain('"objectEndsWithBrace":false');
    expect(message).toContain('"internalFence":true');
    expect(message).toContain('"outputMode":"text"');
    expect(message).toContain('"textSegmentCount":1');
  });

  it("起始围栏后附加说明文字时失败关闭", () => {
    const stdout = `\`\`\`json\n${reviewJson("regression_test")}\n说明文字`;
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]?.category).toBe("other");
    expect(result.findings[0]?.message).toContain('"normalizationForm":"invalid_fence"');
  });

  it("合法 schema JSON 内嵌三反引号时仍失败关闭且不泄露原文", () => {
    const secretText = "机密```模型原文";
    const stdout = JSON.stringify({
      verdict: "block",
      findings: [
        {
          priority: "P1",
          confidence: 0.9,
          category: "compatibility",
          message: secretText
        }
      ],
      summary: `摘要 ${secretText}`
    });
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]).toMatchObject({ priority: "P1", category: "other" });
    expect(result.findings[0]?.message).toContain('"normalizationForm":"invalid_fence"');
    expect(result.findings[0]?.message).toContain("markdown_fence_invalid");
    expect(result.findings[0]?.message).toContain('"internalFence":true');
    expect(result.findings[0]?.message).toContain('"outputMode":"text"');
    expect(result.findings[0]?.message).toContain('"textSegmentCount":1');
    expect(result.findings[0]?.message).not.toContain(secretText);
    expect(result.summary).not.toContain(secretText);
  });

  it("双层 Markdown 围栏失败关闭", () => {
    const inner = `\`\`\`json\n${reviewJson("compatibility")}\n\`\`\``;
    const stdout = `\`\`\`json\n${inner}\n\`\`\``;
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]?.category).toBe("other");
    expect(result.findings[0]?.message).toContain("markdown_fence_invalid");
    expect(result.findings[0]?.message).toContain('"normalizationForm":"invalid_fence"');
  });

  it("不完整 JSON 失败关闭并报告形态类别", () => {
    const stdout = '{"verdict":"block","findings":[';
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]?.category).toBe("other");
    expect(result.findings[0]?.message).toContain("incomplete_json");
  });

  it("合法 JSON 内的嵌套花括号不影响严格解析", () => {
    const stdout = JSON.stringify({
      verdict: "ship_with_fixes",
      findings: [
        {
          priority: "P2",
          confidence: 0.7,
          category: "maintainability",
          message: "obj {nested}",
          locator: "a.ts:10"
        }
      ],
      rootCause: {
        text: "旧版返回结构被新实现覆盖",
        confidence: 0.9,
        evidenceIds: ["e-1"]
      },
      applicabilityConditions: [
        {
          text: "必须兼容旧版客户端",
          evidenceIds: ["e-1"],
          required: true
        }
      ],
      summary: "ok"
    });
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("ship_with_fixes");
    expect(result.findings[0]).toMatchObject({ priority: "P2", message: "obj {nested}", locator: "a.ts:10" });
  });

  it("verdict 字段非法时保守视为 block", () => {
    const stdout = JSON.stringify({ verdict: "unknown", findings: [], summary: "x" });
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
  });

  it("findings 字段缺失时失败关闭", () => {
    const stdout = JSON.stringify({ verdict: "ship", summary: "ok" });
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]).toMatchObject({ priority: "P1", category: "other" });
  });

  it("解析 Phase 5 Review finding 分类和 Repair Memory 字段", () => {
    const stdout = JSON.stringify({
      verdict: "ship",
      findings: [
        {
          priority: "P2",
          confidence: 0.8,
          category: "regression_test",
          message: "缺少回归测试",
          locator: "tests/users.test.js:12"
        }
      ],
      rootCause: {
        text: "旧版字段被新实现覆盖",
        confidence: 0.9,
        evidenceIds: ["e-1"]
      },
      fixSummary: "恢复字段并增加测试",
      applicabilityConditions: [
        {
          text: "旧版客户端仍存在",
          evidenceIds: ["e-1"],
          required: true
        }
      ],
      summary: "需要人工关注回归测试"
    });
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.findings[0]).toMatchObject({ category: "regression_test" });
    expect(result.rootCause).toEqual({
      text: "旧版字段被新实现覆盖",
      confidence: 0.9,
      evidenceIds: ["e-1"]
    });
    expect(result.fixSummary).toBe("恢复字段并增加测试");
    expect(result.applicabilityConditions).toEqual([
      {
        text: "旧版客户端仍存在",
        evidenceIds: ["e-1"],
        required: true
      }
    ]);
  });

  it("finding 缺少或非法 category 时失败关闭", () => {
    const stdout = JSON.stringify({
      verdict: "ship",
      findings: [
        { priority: "P1", confidence: 0.5, category: "correctness", message: "ok" },
        { priority: "P5", message: "invalid priority" },
        { message: "missing priority" }
      ],
      summary: "ok"
    });
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]).toMatchObject({ priority: "P1", category: "other" });
  });

  it("confidence 越界时失败关闭", () => {
    const stdout = JSON.stringify({
      verdict: "block",
      findings: [
        { priority: "P0", confidence: 1.5, category: "security", message: "high" },
        { priority: "P1", confidence: -0.3, category: "correctness", message: "low" }
      ],
      summary: "x"
    });
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]!.category).toBe("other");
  });

  it("完全无法解析时回退到 block + P1 finding", () => {
    const stdout = "no json here at all";
    const result = extractReviewResult(stdout, sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.priority).toBe("P1");
    expect(result.findings[0]!.message).toContain("无法解析");
  });
});

// ---------------------------------------------------------------------------
// 4. analyze / develop / review / cancel 端到端
// ---------------------------------------------------------------------------

describe("OmpAdapter analyze/develop/review/cancel 行为", () => {
  it("analyze 在 omp 成功返回 NDJSON 后产出完整事件流", async () => {
    const ndjson = [
      JSON.stringify({ type: "session.start", taskId: "task-1", at: "2026-07-27T00:00:00.000Z" }),
      JSON.stringify({ type: "assistant.message", message: "正在分析…", at: "2026-07-27T00:00:01.000Z" }),
      JSON.stringify({ type: "session.end", message: "分析完成", at: "2026-07-27T00:00:02.000Z" })
    ].join("\n");
    const runner = makeStubRunner({ stdout: ndjson, retainedBytes: ndjson.length });
    const omp = makeOmpAdapter({ processRunner: runner });

    const events: RuntimeEvent[] = [];
    for await (const ev of omp.analyze(sampleRuntimeInput())) {
      events.push(ev);
    }
    const types = events.map((e) => e.type);
    // started → tool_call → tool_result → started(omp) → progress → completed(omp) → completed(OmpAdapter)
    expect(types[0]).toBe("started");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("progress");
    expect(types[types.length - 1]).toBe("completed");
  });

  it("analyze 在 omp 退出码非零时产出 error 而非 completed", async () => {
    const runner = makeStubRunner({ exitCode: 2, stderr: "omp: API key missing" });
    const omp = makeOmpAdapter({ processRunner: runner });
    const events: RuntimeEvent[] = [];
    for await (const ev of omp.analyze(sampleRuntimeInput())) {
      events.push(ev);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("error");
    expect(types).not.toContain("completed");
    const err = events.find((e) => e.type === "error") as { type: "error"; message: string };
    expect(err.message).toContain("omp 退出码 2");
    expect(err.message).toContain("API key missing");
  });

  it("analyze 在 omp 超时时产出 error", async () => {
    const runner = makeStubRunner({ timedOut: true, exitCode: 124 });
    const omp = makeOmpAdapter({ processRunner: runner });
    const events: RuntimeEvent[] = [];
    for await (const ev of omp.analyze(sampleRuntimeInput())) {
      events.push(ev);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("error");
    expect(types).not.toContain("completed");
    const err = events.find((e) => e.type === "error") as { type: "error"; message: string };
    expect(err.message).toContain("超时");
  });

  it("develop 在 omp 成功返回后产出 completed（需 getDiff 验证实际改动）", async () => {
    const runner = makeStubRunner({ stdout: "" });
    const omp = makeOmpAdapter({ processRunner: runner });
    const events: RuntimeEvent[] = [];
    for await (const ev of omp.develop(sampleRuntimeInput())) {
      events.push(ev);
    }
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("started");
    expect(types[types.length - 1]).toBe("completed");
  });

  it("review 在 omp 成功返回合法 JSON 时返回 ReviewResult", async () => {
    const stdout = JSON.stringify({
      verdict: "ship",
      findings: [{ priority: "P3", confidence: 0.6, category: "maintainability", message: "建议补充测试", locator: "src/users.py:10" }],
      rootCause: {
        text: "旧版返回结构被新实现覆盖",
        confidence: 0.9,
        evidenceIds: ["e-1"]
      },
      applicabilityConditions: [
        {
          text: "必须兼容旧版客户端",
          evidenceIds: ["e-1"],
          required: true
        }
      ],
      summary: "修复正确，测试通过"
    });
    const runner = makeStubRunner({ stdout });
    const omp = makeOmpAdapter({ processRunner: runner });
    const result = await omp.review(sampleReviewInput());
    const modeIdx = runner.lastArgv!.indexOf("--mode");
    expect(runner.lastArgv![modeIdx + 1]).toBe("json");
    expect(result.verdict).toBe("ship");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ priority: "P3", locator: "src/users.py:10" });
    expect(result.summary).toBe("修复正确，测试通过");
  });

  it("review 通过真实 argv 传递 TracePilot 严格审查信封协议", async () => {
    const runner = makeStubRunner({
      stdout: JSON.stringify({ verdict: "block", findings: [], summary: "需要人工复核" })
    });
    const omp = makeOmpAdapter({ processRunner: runner });

    await omp.review(sampleReviewInput());

    const argv = runner.lastArgv!;
    const prompt = argv[argv.length - 1]!;
    const outputRequirementsStart = prompt.indexOf("## 输出要求");
    const reviewPointsStart = prompt.indexOf("## 评审要点");
    expect(outputRequirementsStart).toBeGreaterThanOrEqual(0);
    expect(reviewPointsStart).toBeGreaterThan(outputRequirementsStart);

    const outputRequirements = prompt.slice(outputRequirementsStart, reviewPointsStart);
    expect(outputRequirements).not.toContain("```");
    expect(outputRequirements).toContain(buildReviewResultOutputExample());
    expect(outputRequirements).toContain("<tracepilot_review_result>");
    expect(outputRequirements).toContain("信封外不得有任何字符");
    expect(outputRequirements).toContain("信封内容必须是一个 JSON 对象");
    expect(outputRequirements).toContain("首字符必须是 <tracepilot_review_result>");
    expect(outputRequirements).toContain("末字符必须是 </tracepilot_review_result>");
    expect(outputRequirements).toContain("不要输出 Markdown JSON 围栏");
    expect(prompt).not.toContain("```json");
    expect(prompt).not.toContain("```diff");
  });

  it("review 在 omp 返回非 JSON 文本时回退到 block", async () => {
    const runner = makeStubRunner({ stdout: "I cannot review this." });
    const omp = makeOmpAdapter({ processRunner: runner });
    const result = await omp.review(sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]!.priority).toBe("P1");
  });

  it("review 发现输出截断时失败关闭并保留截断指标", async () => {
    const runner = makeStubRunner({
      stdout: JSON.stringify({ verdict: "ship", findings: [], summary: "ok" }),
      truncated: true,
      originalBytes: 1037301,
      retainedBytes: 262144
    });
    const omp = makeOmpAdapter({ processRunner: runner });
    const result = await omp.review(sampleReviewInput());
    expect(result.verdict).toBe("block");
    expect(result.findings[0]).toMatchObject({ priority: "P1", category: "other" });
    expect(result.findings[0]?.message).toContain("truncated=true");
    expect(result.findings[0]?.message).toContain("originalBytes=1037301");
    expect(result.findings[0]?.message).toContain("retainedBytes=262144");
    expect(result.findings[0]?.message).toContain("stdoutBytes=");
    expect(result.findings[0]?.message).toContain("markdownFenceStart=false");
    expect(result.findings[0]?.message).toContain("markdownFenceEnd=false");
  });

  it("review 截断但尾部保留完整 terminal assistant 消息时可严格解析", async () => {
    const review = JSON.stringify({
      verdict: "ship",
      findings: [],
      rootCause: {
        text: "旧版返回结构被新实现覆盖",
        confidence: 0.9,
        evidenceIds: ["e-1"]
      },
      summary: "终端审查结果完整"
    });
    const stdout = [
      JSON.stringify({ type: "thinking_end", message: "已截断的前序事件不参与 Review 解析" }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: review }] }
      }),
      JSON.stringify({ type: "turn_end", isTerminal: true })
    ].join("\n");
    const runner = makeStubRunner({
      stdout,
      truncated: true,
      originalBytes: 524288,
      retainedBytes: Buffer.byteLength(stdout, "utf8")
    });
    const omp = makeOmpAdapter({ processRunner: runner });

    const result = await omp.review(sampleReviewInput());

    expect(result.verdict).toBe("ship");
    expect(result.summary).toBe("终端审查结果完整");
  });

  it("review 在 omp 超时时抛 OmpUnavailableError", async () => {
    const runner = makeStubRunner({ timedOut: true, exitCode: 124 });
    const omp = makeOmpAdapter({ processRunner: runner });
    await expect(omp.review(sampleReviewInput())).rejects.toBeInstanceOf(OmpUnavailableError);
  });

  it("cancel 在 analyze 流期间调用后，下一次事件循环前产出 error", async () => {
    // 让 stub runner 返回多个事件，使 cancel 有机会在事件流中插入
    const ndjson = [
      JSON.stringify({ type: "session.start", taskId: "task-1", at: "t0" }),
      JSON.stringify({ type: "assistant.message", message: "msg1", at: "t1" }),
      JSON.stringify({ type: "assistant.message", message: "msg2", at: "t2" }),
      JSON.stringify({ type: "session.end", message: "done", at: "t3" })
    ].join("\n");
    const runner = makeStubRunner({ stdout: ndjson });
    const omp = makeOmpAdapter({ processRunner: runner });

    const events: RuntimeEvent[] = [];
    let cancelled = false;
    for await (const ev of omp.analyze(sampleRuntimeInput())) {
      events.push(ev);
      if (!cancelled && ev.type === "tool_result") {
        // 在 omp 返回后、事件流迭代前取消
        const runId = (ev as { runId: string }).runId;
        await omp.cancel(runId);
        cancelled = true;
      }
    }
    // 由于 parseOmpNdjsonEvents 是同步返回全部事件，cancel 检查只在
    // 迭代每个事件前发生。第一个事件后 cancel 应触发 error。
    expect(cancelled).toBe(true);
    const types = events.map((e) => e.type);
    expect(types).toContain("error");
  });

  it("cancel 对未知 runId 安全（不抛错）", async () => {
    const omp = makeOmpAdapter({});
    await expect(omp.cancel("unknown")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. 错误类
// ---------------------------------------------------------------------------

describe("OmpArgvValidationError", () => {
  it("携带 violatedRule 与 detail 供审计使用", () => {
    const err = new OmpArgvValidationError("ompPath-mismatch", "argv[0] 不一致");
    expect(err.violatedRule).toBe("ompPath-mismatch");
    expect(err.detail).toBe("argv[0] 不一致");
    expect(err.name).toBe("OmpArgvValidationError");
    expect(err.message).toContain("ompPath-mismatch");
  });
});

describe("OmpUnavailableError", () => {
  it("默认消息提示 API key 配置", () => {
    const err = new OmpUnavailableError();
    expect(err.name).toBe("OmpUnavailableError");
    expect(err.message).toContain("API key");
  });

  it("支持自定义消息", () => {
    const err = new OmpUnavailableError("custom reason");
    expect(err.message).toBe("custom reason");
  });
});

// ---------------------------------------------------------------------------
// 6. P1-05：cancel 通过 AbortController 终止进程树
// ---------------------------------------------------------------------------

describe("P1-05：OmpAdapter cancel 通过 AbortController 终止进程", () => {
  it("analyze 调用 ProcessRunner 时透传 AbortSignal", async () => {
    // 验证 OmpAdapter 把 AbortController.signal 传给 ProcessRunner.run
    const runner = makeStubRunner({ stdout: "" });
    const omp = makeOmpAdapter({ processRunner: runner });
    for await (const _ev of omp.analyze(sampleRuntimeInput())) void _ev;
    expect(runner.lastAbortSignal).toBeInstanceOf(AbortSignal);
  });

  it("develop 调用 ProcessRunner 时透传 AbortSignal", async () => {
    const runner = makeStubRunner({ stdout: "" });
    const omp = makeOmpAdapter({ processRunner: runner });
    for await (const _ev of omp.develop(sampleRuntimeInput())) void _ev;
    expect(runner.lastAbortSignal).toBeInstanceOf(AbortSignal);
  });

  it("review 调用 ProcessRunner 时透传 AbortSignal", async () => {
    const runner = makeStubRunner({
      stdout: JSON.stringify({ verdict: "ship", findings: [], summary: "ok" })
    });
    const omp = makeOmpAdapter({ processRunner: runner });
    await omp.review(sampleReviewInput());
    expect(runner.lastAbortSignal).toBeInstanceOf(AbortSignal);
  });

  it("cancel 调用后 AbortSignal 被 abort（terminated=true）", async () => {
    // 构造一个能检测 abortSignal 状态的 stub runner。
    // 当 abortSignal 已 aborted 时，立即返回非零退出码。
    let capturedSignal: AbortSignal | undefined;
    const runner: ProcessRunner = {
      async run(spec, _cwd, _policy, abortSignal?) {
        capturedSignal = abortSignal;
        // 如果 signal 已 aborted，立即返回非零退出码
        if (abortSignal?.aborted) {
          return {
            argv: spec.argv, cwd: FAKE_WT, exitCode: 130, stdout: "", stderr: "aborted",
            truncated: false, originalBytes: 0, retainedBytes: 0, timedOut: false,
            startedAt: "2026-07-27T00:00:00.000Z", endedAt: "2026-07-27T00:00:01.000Z"
          };
        }
        // 如果 signal 未 aborted，返回成功（本测试应在 aborted 状态下被调用）
        return {
          argv: spec.argv, cwd: FAKE_WT, exitCode: 0, stdout: "", stderr: "",
          truncated: false, originalBytes: 0, retainedBytes: 0, timedOut: false,
          startedAt: "2026-07-27T00:00:00.000Z", endedAt: "2026-07-27T00:00:01.000Z"
        };
      }
    };
    const omp = makeOmpAdapter({ processRunner: runner });

    // analyze generator 流程：
    // 1. yield started → 获取 runId
    // 2. 检查 cancelled → 若已取消则提前 return（不调用 runOmpGoverned）
    // 3. yield tool_call → 此后 generator 进入 runOmpGoverned
    //
    // 我们需要在 yield tool_call 之后、runOmpGoverned 执行之前 cancel，
    // 这样 runOmpGoverned 执行时 abortSignal 已 aborted。
    // 但 cancelled 标记会导致步骤 2 提前 return —— 所以必须在 tool_call 后 cancel。
    const iter = omp.analyze(sampleRuntimeInput());

    // 第一次 next：拿到 started 事件
    const started = await iter.next();
    expect(started.value.type).toBe("started");
    const runId = (started.value as { runId: string }).runId;

    // 第二次 next：拿到 tool_call 事件（此时 cancelled 检查已通过，runOmpGoverned 尚未执行）
    const toolCall = await iter.next();
    expect(toolCall.value.type).toBe("tool_call");

    // 在 runOmpGoverned 执行前 cancel —— 下一次 next 会执行 runOmpGoverned，
    // 此时 abortSignal.aborted=true
    await omp.cancel(runId);

    // 第三次 next：执行 runOmpGoverned，stub runner 看到 abortSignal.aborted=true
    // 立即返回 exitCode=130，generator 产出 tool_result + error
    const rest: RuntimeEvent[] = [];
    for await (const ev of iter) {
      rest.push(ev);
    }

    // 验证 AbortSignal 被传递且处于 aborted 状态
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
    // omp 退出码非 0 时应产出 error 而非 completed
    const types = rest.map((e) => e.type);
    expect(types).toContain("error");
    expect(types).not.toContain("completed");
  });

  it("cancel 对未知 runId 不抛错且不影响其他 run", async () => {
    const runner = makeStubRunner({ stdout: "" });
    const omp = makeOmpAdapter({ processRunner: runner });
    // 对不存在的 runId 调用 cancel 应安全返回
    await expect(omp.cancel("nonexistent-run-id")).resolves.toBeUndefined();
    // 正常启动 analyze 仍应工作
    const events: RuntimeEvent[] = [];
    for await (const ev of omp.analyze(sampleRuntimeInput())) {
      events.push(ev);
    }
    expect(events[events.length - 1]!.type).toBe("completed");
  });

  it("多次 cancel 同一 runId 安全（幂等）", async () => {
    const runner = makeStubRunner({ stdout: "" });
    const omp = makeOmpAdapter({ processRunner: runner });
    let runId = "";
    const iter = omp.analyze(sampleRuntimeInput());
    for await (const ev of iter) {
      if (ev.type === "started" && "runId" in ev) {
        runId = ev.runId;
        break;
      }
    }
    // 多次 cancel 同一 runId 应全部安全返回
    await omp.cancel(runId);
    await omp.cancel(runId);
    await omp.cancel(runId);
  });
});

// ---------------------------------------------------------------------------
// 5. P1-R01（§18 受控文件工具代理）：extractFileChangesFromStdout / Text 解析
// ---------------------------------------------------------------------------

describe("P1-R01（§18）：extractFileChangesFromText 解析 <file_change> XML 指令", () => {
  it("解析单个 <file_change> 块（CDATA 包裹）", () => {
    const text = [
      "我分析了 bug，需要修改 users.py：",
      "<file_change path=\"src/users.py\">",
      "<![CDATA[",
      "def create_user():",
      "    return {\"status\": 201}",
      "]]>",
      "</file_change>",
      "完成。"
    ].join("\n");
    const changes = extractFileChangesFromText(text);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.relativePath).toBe("src/users.py");
    expect(changes[0]!.content).toBe("def create_user():\n    return {\"status\": 201}");
  });

  it("解析多个 <file_change> 块", () => {
    const text = [
      "<file_change path=\"src/users.py\">",
      "<![CDATA[",
      "content1",
      "]]>",
      "</file_change>",
      "中间说明文本",
      "<file_change path=\"src/utils.py\">",
      "<![CDATA[",
      "content2",
      "]]>",
      "</file_change>"
    ].join("\n");
    const changes = extractFileChangesFromText(text);
    expect(changes).toHaveLength(2);
    expect(changes[0]!.relativePath).toBe("src/users.py");
    expect(changes[0]!.content).toBe("content1");
    expect(changes[1]!.relativePath).toBe("src/utils.py");
    expect(changes[1]!.content).toBe("content2");
  });

  it("解析无 CDATA 的块（XML 实体转义）", () => {
    const text = "<file_change path=\"src/x.py\">def f(): pass &amp; return &lt;nil&gt;</file_change>";
    const changes = extractFileChangesFromText(text);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.content).toBe("def f(): pass & return <nil>");
  });

  it("无 <file_change> 块时返回空数组", () => {
    expect(extractFileChangesFromText("没有任何修改指令")).toEqual([]);
    expect(extractFileChangesFromText("")).toEqual([]);
  });

  it("path 属性为空时跳过该块", () => {
    const text = "<file_change path=\"\">content</file_change>";
    const changes = extractFileChangesFromText(text);
    // path 为空字符串，正则匹配到 path="" 后捕获组为空，循环内 continue 跳过
    expect(changes).toHaveLength(0);
  });

  it("内容含特殊字符 < > 时不被误判（CDATA 包裹）", () => {
    const text = [
      "<file_change path=\"src/code.py\">",
      "<![CDATA[",
      "if a < b and b > c:",
      "    print('hello & goodbye')",
      "]]>",
      "</file_change>"
    ].join("\n");
    const changes = extractFileChangesFromText(text);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.content).toContain("if a < b and b > c:");
    expect(changes[0]!.content).toContain("print('hello & goodbye')");
  });

  it("未闭合的 <file_change> 块不匹配（非贪婪正则）", () => {
    const text = "<file_change path=\"src/x.py\">content without closing tag";
    const changes = extractFileChangesFromText(text);
    expect(changes).toHaveLength(0);
  });
});

describe("P1-R01（§18）：extractFileChangesFromStdout 从 NDJSON 提取修改指令", () => {
  /** 构造一条 message_end NDJSON 行（assistant 文本消息）。 */
  function assistantMessageEnd(text: string): string {
    return JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }]
      }
    });
  }

  it("从单条 assistant 消息中提取 <file_change> 块", () => {
    const stdout = [
      JSON.stringify({ type: "session", version: 3, id: "s1", cwd: FAKE_WT }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "message_start", message: { role: "assistant" } }),
      assistantMessageEnd([
        "分析完成，修改如下：",
        "<file_change path=\"src/users.py\">",
        "<![CDATA[",
        "def create_user(): return 201",
        "]]>",
        "</file_change>"
      ].join("\n")),
      JSON.stringify({ type: "turn_end", isTerminal: true })
    ].join("\n");
    const changes = extractFileChangesFromStdout(stdout);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.relativePath).toBe("src/users.py");
    expect(changes[0]!.content).toBe("def create_user(): return 201");
  });

  it("拼接多条 assistant 消息后提取 <file_change> 块", () => {
    // 模拟 omp 把 <file_change> 跨多条 message_end 输出（罕见但需容错）
    const stdout = [
      assistantMessageEnd("<file_change path=\"src/a.py\"><![CDATA[content_a]]></file_change>"),
      assistantMessageEnd("<file_change path=\"src/b.py\"><![CDATA[content_b]]></file_change>")
    ].join("\n");
    const changes = extractFileChangesFromStdout(stdout);
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.relativePath)).toEqual(["src/a.py", "src/b.py"]);
  });

  it("无 assistant 消息时返回空数组", () => {
    const stdout = [
      JSON.stringify({ type: "session" }),
      JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false }),
      JSON.stringify({ type: "turn_end", isTerminal: true })
    ].join("\n");
    expect(extractFileChangesFromStdout(stdout)).toEqual([]);
  });

  it("非 JSON 行不影响解析", () => {
    const stdout = [
      "this is not json",
      assistantMessageEnd("<file_change path=\"x.py\"><![CDATA[c]]></file_change>"),
      "also not json"
    ].join("\n");
    const changes = extractFileChangesFromStdout(stdout);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.relativePath).toBe("x.py");
  });

  it("空 stdout 返回空数组", () => {
    expect(extractFileChangesFromStdout("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. P1-R01（§18 受控文件工具代理）：OmpAdapter.develop 与 ControlledFileWriter 集成
// ---------------------------------------------------------------------------

describe("P1-R01（§18）：OmpAdapter.develop 与 ControlledFileWriter 集成", () => {
  /** 构造 NDJSON：包含一条 assistant 消息，内含 <file_change> 块。 */
  function buildStdoutWithChanges(changes: Array<{ path: string; content: string }>): string {
    const blocks = changes.map((c) =>
      `<file_change path="${c.path}"><![CDATA[${c.content}]]></file_change>`
    ).join("\n");
    return [
      JSON.stringify({ type: "session", version: 3, id: "s1", cwd: FAKE_WT }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: blocks }]
        }
      }),
      JSON.stringify({ type: "turn_end", isTerminal: true })
    ].join("\n");
  }

  it("omp 输出合法 <file_change> → ControlledFileWriter.writeFiles 被调用", async () => {
    const stdout = buildStdoutWithChanges([
      { path: "src/users.py", content: "def create_user(): return 201" }
    ]);
    const runner = makeStubRunner({ stdout });
    const writer = new FakeControlledFileWriter();
    const omp = makeOmpAdapter({ processRunner: runner, controlledFileWriter: writer });

    const events: RuntimeEvent[] = [];
    for await (const ev of omp.develop(sampleRuntimeInput())) {
      events.push(ev);
    }

    // 验证 writeFiles 被调用一次，包含正确的 taskId / worktreePath / allowedPaths / changes
    expect(writer.writes).toHaveLength(1);
    const write = writer.writes[0]!;
    expect(write.taskId).toBe("task-1");
    expect(write.worktreePath).toBe(FAKE_WT);
    expect(write.allowedPaths).toEqual(["src/**"]);
    expect(write.changes).toHaveLength(1);
    expect(write.changes[0]!.relativePath).toBe("src/users.py");
    expect(write.changes[0]!.content).toBe("def create_user(): return 201");

    // 事件流应包含 progress（准备写入 + 写入完成）和 completed
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("started");
    expect(types[types.length - 1]).toBe("completed");
    expect(types).toContain("progress");
  });

  it("omp 输出多个 <file_change> 块 → 全部传给 ControlledFileWriter", async () => {
    const stdout = buildStdoutWithChanges([
      { path: "src/users.py", content: "content1" },
      { path: "src/utils.py", content: "content2" },
      { path: "src/helpers.py", content: "content3" }
    ]);
    const runner = makeStubRunner({ stdout });
    const writer = new FakeControlledFileWriter();
    const omp = makeOmpAdapter({ processRunner: runner, controlledFileWriter: writer });

    for await (const _ev of omp.develop(sampleRuntimeInput())) void _ev;

    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]!.changes).toHaveLength(3);
    expect(writer.writes[0]!.changes.map((c) => c.relativePath)).toEqual([
      "src/users.py",
      "src/utils.py",
      "src/helpers.py"
    ]);
  });

  it("omp 未输出 <file_change> → writeFiles 不被调用，仍 completed", async () => {
    const stdout = [
      JSON.stringify({ type: "session" }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "无需修改" }] }
      }),
      JSON.stringify({ type: "turn_end", isTerminal: true })
    ].join("\n");
    const runner = makeStubRunner({ stdout });
    const writer = new FakeControlledFileWriter();
    const omp = makeOmpAdapter({ processRunner: runner, controlledFileWriter: writer });

    const events: RuntimeEvent[] = [];
    for await (const ev of omp.develop(sampleRuntimeInput())) {
      events.push(ev);
    }

    expect(writer.writes).toHaveLength(0);
    const types = events.map((e) => e.type);
    expect(types[types.length - 1]).toBe("completed");
  });

  it("ControlledFileWriter 抛 PathScopeViolationError → 产出 error 事件，develop 不产出最终 completed", async () => {
    // 模拟 omp 输出越权路径（src/users.py 在 allowedPaths 内，但 ../evil.py 越界）
    const stdout = buildStdoutWithChanges([
      { path: "src/users.py", content: "ok" },
      { path: "../evil.py", content: "evil" }
    ]);
    const runner = makeStubRunner({ stdout });
    // FakeControlledFileWriter 配置为拒绝 ../evil.py
    const writer = new FakeControlledFileWriter({ rejectPaths: ["../evil.py"] });
    const omp = makeOmpAdapter({ processRunner: runner, controlledFileWriter: writer });

    const events: RuntimeEvent[] = [];
    for await (const ev of omp.develop(sampleRuntimeInput())) {
      events.push(ev);
    }

    // writeFiles 被调用一次（含两个 changes），但抛 PathScopeViolationError
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]!.changes).toHaveLength(2);

    // 事件流应包含 error，且最后一个事件是 error（develop 自身的 completed 不应产出）
    // 注意：omp 事件流可能包含 turn_end 产生的 completed，但 develop 方法在
    // writeFiles 失败后不再产出自己的 completed，并以 error 结尾。
    const types = events.map((e) => e.type);
    expect(types).toContain("error");
    expect(types[types.length - 1]).toBe("error");
    const errEvent = events.find((e) => e.type === "error" && (e as { message?: string }).message?.includes("受控文件工具代理拒绝写入")) as { type: "error"; message: string };
    expect(errEvent).toBeDefined();
    expect(errEvent.message).toContain("受控文件工具代理拒绝写入");
  });

  it("未注入 ControlledFileWriter → develop 立即失败关闭（不启动 omp）", async () => {
    const runner = makeStubRunner({ stdout: "" });
    const omp = new OmpAdapter({
      processRunner: runner,
      pathPolicy: new FakeStringPathPolicy(),
      processPolicy: sampleProcessPolicy(),
      projectCommands: sampleProjectCommands(),
      allowedWorktreeRoots: [FAKE_WT],
      ompPath: FAKE_OMP
      // 故意不注入 controlledFileWriter
    });

    const events: RuntimeEvent[] = [];
    for await (const ev of omp.develop(sampleRuntimeInput())) {
      events.push(ev);
    }

    // omp 未被调用
    expect(runner.invoked).toBe(0);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("started");
    expect(types).toContain("error");
    expect(types).not.toContain("completed");
    const errEvent = events.find((e) => e.type === "error") as { type: "error"; message: string };
    expect(errEvent.message).toContain("ControlledFileWriter");
  });

  it("omp 退出码非 0 → 不调用 ControlledFileWriter，产出 error", async () => {
    const runner = makeStubRunner({ stdout: "", stderr: "omp error", exitCode: 1 });
    const writer = new FakeControlledFileWriter();
    const omp = makeOmpAdapter({ processRunner: runner, controlledFileWriter: writer });

    const events: RuntimeEvent[] = [];
    for await (const ev of omp.develop(sampleRuntimeInput())) {
      events.push(ev);
    }

    expect(writer.writes).toHaveLength(0);
    const types = events.map((e) => e.type);
    expect(types).toContain("error");
    expect(types).not.toContain("completed");
  });

  it("omp 超时 → 不调用 ControlledFileWriter，产出 error", async () => {
    const runner = makeStubRunner({ stdout: "", timedOut: true, exitCode: 124 });
    const writer = new FakeControlledFileWriter();
    const omp = makeOmpAdapter({ processRunner: runner, controlledFileWriter: writer });

    const events: RuntimeEvent[] = [];
    for await (const ev of omp.develop(sampleRuntimeInput())) {
      events.push(ev);
    }

    expect(writer.writes).toHaveLength(0);
    const types = events.map((e) => e.type);
    expect(types).toContain("error");
    expect(types).not.toContain("completed");
    const errEvent = events.find((e) => e.type === "error") as { type: "error"; message: string };
    expect(errEvent.message).toContain("超时");
  });

  it("develop prompt 包含 <file_change> XML 输出格式说明", async () => {
    const runner = makeStubRunner({ stdout: "" });
    const omp = makeOmpAdapter({ processRunner: runner });
    for await (const _ev of omp.develop(sampleRuntimeInput())) void _ev;
    const argv = runner.lastArgv!;
    const prompt = argv[argv.length - 1] as string;
    // prompt 应包含 XML 输出格式说明
    expect(prompt).toContain("<file_change");
    expect(prompt).toContain("CDATA");
    expect(prompt).toContain("allowedPaths");
    // prompt 应明确告知 omp 没有写入能力
    expect(prompt).toContain("read,grep,glob");
    expect(prompt).toContain("无法直接修改");
  });
});
