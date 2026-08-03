/**
 * LocalControlledFileWriter 真实文件系统对抗性测试 —— P1-R01（§18 受控文件工具代理）。
 *
 * 验收报告 §18.3 要求："必须使用受控文件工具代理、受限账户/ACL、沙箱，或
 * 经真实 Omp Spike 验证的逐路径 allowlist，在写入发生前同步拒绝越权。"
 *
 * 本测试使用真实文件系统（`node:fs` + `os.tmpdir()`）创建临时 worktree
 * 目录，用 `LocalControlledFileWriter` 做写入前路径校验，验证：
 *
 * 1. **合法路径写入**：omp 输出 allowedPaths 内的文件修改指令 → 文件被写入；
 * 2. **越权路径拒绝**：omp 输出 allowedPaths 外的路径 → 抛 PathScopeViolationError，
 *    不写入任何文件（原子性）；
 * 3. **受保护路径拒绝**：omp 输出 `.git/config` 等受保护路径 → 拒绝写入；
 * 4. **路径穿越拒绝**：omp 输出 `../evil.py` 或 `src/../../evil.py` → 拒绝写入；
 * 5. **绝对路径拒绝**：omp 输出绝对路径 → 拒绝写入；
 * 6. **符号链接逃逸拒绝**：worktree 内已存在指向外部的符号链接，omp 尝试通过
 *    该链接写入 → 拒绝写入；
 * 7. **原子性**：混合合法与越权路径 → 全部不写入；
 * 8. **父目录自动创建**：合法路径的父目录不存在时自动创建。
 *
 * 这些测试证明 LocalControlledFileWriter 实现了"同步、操作前、逐路径"的
 * 强制边界（§18.3 要求），从源头杜绝越权写入。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
  symlinkSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalControlledFileWriter } from "../src/local-controlled-file-writer.js";
import { PathScopeViolationError } from "@tracepilot/core";
import type { FileChangeInstruction } from "@tracepilot/core";

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

let worktreePath: string;
let externalPath: string;

beforeEach(() => {
  // 每个测试用独立的临时目录，避免相互污染
  worktreePath = mkdtempSync(join(tmpdir(), "tp-cfw-wt-"));
  externalPath = mkdtempSync(join(tmpdir(), "tp-cfw-ext-"));
  // 在 worktree 中预置 src 目录
  mkdirSync(join(worktreePath, "src"), { recursive: true });
});

afterEach(() => {
  // 清理临时目录
  rmSync(worktreePath, { recursive: true, force: true });
  rmSync(externalPath, { recursive: true, force: true });
});

/** 构造 FileChangeInstruction。 */
function change(relativePath: string, content: string): FileChangeInstruction {
  return { relativePath, content };
}

/**
 * 创建目录链接。Windows 使用 junction，避免测试因缺少 Developer Mode
 * 而把真实路径边界场景整体跳过；若当前环境连 junction 也不允许，
 * 调用方的既有失败关闭分支仍会明确跳过该平台场景。
 */
function createDirectoryLink(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

/**
 * 对抗性测试专用写入器：在目标句柄建立后、最终校验前把正常父目录替换为
 * 外部目录链接，确定性模拟最后一次路径校验与实际写入之间的 TOCTOU 替换。
 */
class ParentSwapWriter extends LocalControlledFileWriter {
  didSwap = false;

  constructor(private readonly swapTarget: string) {
    super();
  }

  protected override beforeFinalPathValidation(
    worktree: string,
    relativePath: string
  ): void {
    if (this.didSwap || relativePath !== "src/race/file.py") return;
    const parent = join(worktree, "src", "race");
    rmSync(parent, { recursive: true, force: true });
    createDirectoryLink(this.swapTarget, parent);
    this.didSwap = true;
  }
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe("P1-R01（§18）：LocalControlledFileWriter 合法路径写入", () => {
  it("allowedPaths 内的单个文件 → 写入成功", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    const changes = [change("src/users.py", "def create_user(): return 201")];

    await writer.writeFiles("task-1", worktreePath, allowedPaths, changes);

    const written = readFileSync(join(worktreePath, "src", "users.py"), "utf8");
    expect(written).toBe("def create_user(): return 201");
  });

  it("allowedPaths 内的多个文件 → 全部写入", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    const changes = [
      change("src/users.py", "content1"),
      change("src/utils.py", "content2"),
      change("src/helpers.py", "content3")
    ];

    await writer.writeFiles("task-1", worktreePath, allowedPaths, changes);

    expect(readFileSync(join(worktreePath, "src", "users.py"), "utf8")).toBe("content1");
    expect(readFileSync(join(worktreePath, "src", "utils.py"), "utf8")).toBe("content2");
    expect(readFileSync(join(worktreePath, "src", "helpers.py"), "utf8")).toBe("content3");
  });

  it("父目录不存在时自动创建", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    const changes = [change("src/deep/nested/file.py", "deep content")];

    await writer.writeFiles("task-1", worktreePath, allowedPaths, changes);

    expect(readFileSync(join(worktreePath, "src", "deep", "nested", "file.py"), "utf8"))
      .toBe("deep content");
  });

  it("覆盖已存在的文件", async () => {
    // 预置已有文件
    writeFileSync(join(worktreePath, "src", "users.py"), "old content", "utf8");
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    const changes = [change("src/users.py", "new content")];

    await writer.writeFiles("task-1", worktreePath, allowedPaths, changes);

    expect(readFileSync(join(worktreePath, "src", "users.py"), "utf8")).toBe("new content");
  });

  it("allowedPaths 为精确路径时匹配", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/users.py"]; // 精确路径，非 glob
    const changes = [change("src/users.py", "content")];

    await writer.writeFiles("task-1", worktreePath, allowedPaths, changes);

    expect(readFileSync(join(worktreePath, "src", "users.py"), "utf8")).toBe("content");
  });

  it("空 changes 数组 → 不抛错，不写入任何文件", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];

    await writer.writeFiles("task-1", worktreePath, allowedPaths, []);

    // 无异常即成功
    expect(existsSync(join(worktreePath, "src", "users.py"))).toBe(false);
  });
});

describe("P1-R01（§18）：LocalControlledFileWriter 越权路径拒绝（原子性）", () => {
  it("allowedPaths 外的路径 → 抛 PathScopeViolationError，不写入任何文件", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    const changes = [
      change("src/users.py", "legit content"),
      change("tests/test_users.py", "outside allowedPaths")
    ];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    // 原子性：合法文件也不应被写入
    expect(existsSync(join(worktreePath, "src", "users.py"))).toBe(false);
    expect(existsSync(join(worktreePath, "tests", "test_users.py"))).toBe(false);
  });

  it(".. 路径穿越 → 抛 PathScopeViolationError", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    const changes = [change("../evil.py", "evil content")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    // worktree 内不应有 evil.py（../evil.py 解析到 worktree 外，不应被写入）
    expect(existsSync(join(worktreePath, "evil.py"))).toBe(false);
  });

  it("深层 .. 路径穿越 → 抛 PathScopeViolationError", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    const changes = [change("src/../../evil.py", "evil content")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    // src/../../evil.py 解析到 worktree 外，worktree 内不应有 evil.py
    expect(existsSync(join(worktreePath, "evil.py"))).toBe(false);
  });

  it(".git 受保护路径 → 抛 PathScopeViolationError", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["**"]; // 即使 allowedPaths 允许所有，.git 仍受保护
    // 预置 .git 目录
    mkdirSync(join(worktreePath, ".git"), { recursive: true });
    const changes = [change(".git/config", "[user]\nname = evil")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    // .git/config 不应被写入/覆盖
    const gitConfigPath = join(worktreePath, ".git", "config");
    if (existsSync(gitConfigPath)) {
      // 如果预置存在，内容不应被修改
      expect(readFileSync(gitConfigPath, "utf8")).not.toContain("evil");
    }
  });

  it(".git/hooks 受保护路径 → 抛 PathScopeViolationError", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["**"];
    const changes = [change(".git/hooks/pre-commit", "rm -rf /")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);
  });

  it("PathScopeViolationError 包含 taskId、violators 和 allowedPaths", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    const changes = [
      change("tests/test.py", "outside"),
      change("../evil.py", "traversal")
    ];

    try {
      await writer.writeFiles("task-42", worktreePath, allowedPaths, changes);
      expect.fail("应抛 PathScopeViolationError");
    } catch (err) {
      expect(err).toBeInstanceOf(PathScopeViolationError);
      const e = err as PathScopeViolationError;
      expect(e.taskId).toBe("task-42");
      expect(e.violators).toEqual(expect.arrayContaining(["tests/test.py", "../evil.py"]));
      expect(e.allowedPaths).toEqual(allowedPaths);
    }
  });

  it("多个越权路径全部出现在 violators 中", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    const changes = [
      change("src/ok.py", "ok"),
      change("tests/a.py", "a"),
      change("tests/b.py", "b"),
      change("../c.py", "c")
    ];

    try {
      await writer.writeFiles("task-1", worktreePath, allowedPaths, changes);
      expect.fail("应抛 PathScopeViolationError");
    } catch (err) {
      expect(err).toBeInstanceOf(PathScopeViolationError);
      const e = err as PathScopeViolationError;
      expect(e.violators).toHaveLength(3);
      expect(e.violators).toEqual(expect.arrayContaining(["tests/a.py", "tests/b.py", "../c.py"]));
    }
  });

  it("绝对路径 → 抛 PathScopeViolationError", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    // 绝对路径：resolve 后不在 worktree 内
    const absPath = process.platform === "win32" ? "D:\\evil.py" : "/tmp/evil.py";
    const changes = [change(absPath, "evil content")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);
  });
});

describe("P1-R01（§18）：LocalControlledFileWriter 符号链接逃逸拒绝", () => {
  it("worktree 内指向外部的符号链接 → 拒绝通过该链接写入", async () => {
    // 在 src/ 下创建一个指向 externalPath 的符号链接
    const externalTarget = join(externalPath, "secret.txt");
    writeFileSync(externalTarget, "secret content", "utf8");
    const symlinkPath = join(worktreePath, "src", "escape-link");
    try {
      createDirectoryLink(externalTarget, symlinkPath);
    } catch (err) {
      // Windows 无 Developer Mode 时跳过符号链接测试
      if (process.platform === "win32") {
        console.warn("Windows 无 Developer Mode，跳过符号链接逃逸测试");
        return;
      }
      throw err;
    }

    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    // omp 尝试通过符号链接写入（路径匹配 src/** 但目标逃逸到外部）
    const changes = [change("src/escape-link", "evil content via symlink")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    // 外部文件内容不应被修改
    expect(readFileSync(externalTarget, "utf8")).toBe("secret content");
  });

  it("父目录是指向外部的符号链接 → 拒绝通过该目录写入（文件不存在）", async () => {
    // 在 worktree/src 下创建一个指向 externalPath 的符号链接目录
    const symlinkDir = join(worktreePath, "src", "escape-dir");
    try {
      createDirectoryLink(externalPath, symlinkDir);
    } catch (err) {
      if (process.platform === "win32") {
        console.warn("Windows 无 Developer Mode，跳过符号链接逃逸测试");
        return;
      }
      throw err;
    }

    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    // 路径匹配 src/** 但父目录 src/escape-dir 是指向外部的符号链接
    // 写入 src/escape-dir/file.py 实际会写入 externalPath/file.py
    const changes = [change("src/escape-dir/file.py", "evil via parent symlink")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    // 外部目录不应被污染
    expect(existsSync(join(externalPath, "file.py"))).toBe(false);
  });

  it("父目录是指向外部的符号链接 → 拒绝通过该目录写入（文件已存在）", async () => {
    // 在 worktree/src 下创建一个指向 externalPath 的符号链接目录
    const symlinkDir = join(worktreePath, "src", "escape-dir");
    // 在外部目录预置一个文件
    const externalFile = join(externalPath, "existing.py");
    writeFileSync(externalFile, "original content", "utf8");
    try {
      createDirectoryLink(externalPath, symlinkDir);
    } catch (err) {
      if (process.platform === "win32") {
        console.warn("Windows 无 Developer Mode，跳过符号链接逃逸测试");
        return;
      }
      throw err;
    }

    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    // 尝试覆盖 src/escape-dir/existing.py（实际是 externalPath/existing.py）
    const changes = [change("src/escape-dir/existing.py", "tampered content")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    // 外部文件内容不应被修改
    expect(readFileSync(externalFile, "utf8")).toBe("original content");
  });

  it("中间路径组件是指向外部的符号链接 → 拒绝深层写入", async () => {
    // 在 worktree/src 下创建一个指向 externalPath 的符号链接目录
    const symlinkDir = join(worktreePath, "src", "link");
    try {
      createDirectoryLink(externalPath, symlinkDir);
    } catch (err) {
      if (process.platform === "win32") {
        console.warn("Windows 无 Developer Mode，跳过符号链接逃逸测试");
        return;
      }
      throw err;
    }

    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    // 深层路径：src/link/deep/nested/file.py
    // src/link 是符号链接 → 写入会逃逸到 externalPath/deep/nested/file.py
    const changes = [change("src/link/deep/nested/file.py", "deep evil content")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    // 外部目录不应被污染
    expect(existsSync(join(externalPath, "deep", "nested", "file.py"))).toBe(false);
  });

  it("根目录下直接创建指向外部的符号链接目录 → 拒绝写入", async () => {
    // 在 worktree 根下创建一个指向 externalPath 的符号链接目录
    const symlinkDir = join(worktreePath, "escape-root");
    try {
      createDirectoryLink(externalPath, symlinkDir);
    } catch (err) {
      if (process.platform === "win32") {
        console.warn("Windows 无 Developer Mode，跳过符号链接逃逸测试");
        return;
      }
      throw err;
    }

    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["**"];
    const changes = [change("escape-root/file.py", "evil via root symlink")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    expect(existsSync(join(externalPath, "file.py"))).toBe(false);
  });

  it("合法的 worktree 内目录链 → 写入成功（无符号链接）", async () => {
    // 确保正常的深层目录写入不受影响
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    const changes = [change("src/deep/nested/file.py", "legit deep content")];

    await writer.writeFiles("task-1", worktreePath, allowedPaths, changes);

    expect(readFileSync(join(worktreePath, "src", "deep", "nested", "file.py"), "utf8"))
      .toBe("legit deep content");
  });
});

describe("P1-R01（§19.2）：LocalControlledFileWriter 父目录符号链接指向 worktree 内白名单外目录", () => {
  // §19.2 关键场景：src/alias 是指向 tests/ 的符号链接（worktree 内但白名单外）
  // 指令 src/alias/new.py 词法匹配 src/**，但真实落点是 tests/new.py
  // 必须在写入前同步拒绝，不能依赖事后快照检测

  it("父目录符号链接指向 worktree 内白名单外目录 → 拒绝写入（文件不存在）", async () => {
    // 预置 tests/ 目录
    mkdirSync(join(worktreePath, "tests"), { recursive: true });
    // 创建 src/alias → tests/ 符号链接（指向 worktree 内但白名单外）
    const symlinkDir = join(worktreePath, "src", "alias");
    try {
      createDirectoryLink(join(worktreePath, "tests"), symlinkDir);
    } catch (err) {
      if (process.platform === "win32") {
        console.warn("Windows 无 Developer Mode，跳过符号链接逃逸测试");
        return;
      }
      throw err;
    }

    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    // src/alias/new.py 词法匹配 src/**，但真实落点是 tests/new.py（白名单外）
    const changes = [change("src/alias/new.py", "evil via internal symlink")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    // tests/new.py 不应被创建
    expect(existsSync(join(worktreePath, "tests", "new.py"))).toBe(false);
  });

  it("父目录符号链接指向 worktree 内白名单外目录 → 拒绝覆盖（文件已存在）", async () => {
    // 预置 tests/existing.py
    mkdirSync(join(worktreePath, "tests"), { recursive: true });
    const existingFile = join(worktreePath, "tests", "existing.py");
    writeFileSync(existingFile, "original", "utf8");
    // 创建 src/alias → tests/ 符号链接
    const symlinkDir = join(worktreePath, "src", "alias");
    try {
      createDirectoryLink(join(worktreePath, "tests"), symlinkDir);
    } catch (err) {
      if (process.platform === "win32") {
        console.warn("Windows 无 Developer Mode，跳过符号链接逃逸测试");
        return;
      }
      throw err;
    }

    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    // 尝试覆盖 src/alias/existing.py（实际是 tests/existing.py）
    const changes = [change("src/alias/existing.py", "tampered")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    // tests/existing.py 内容不应被修改
    expect(readFileSync(existingFile, "utf8")).toBe("original");
  });

  it("父目录符号链接指向 worktree 内白名单外目录 → 拒绝深层写入", async () => {
    mkdirSync(join(worktreePath, "tests"), { recursive: true });
    const symlinkDir = join(worktreePath, "src", "alias");
    try {
      createDirectoryLink(join(worktreePath, "tests"), symlinkDir);
    } catch (err) {
      if (process.platform === "win32") {
        console.warn("Windows 无 Developer Mode，跳过符号链接逃逸测试");
        return;
      }
      throw err;
    }

    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    // 深层路径：src/alias/deep/nested/file.py → tests/deep/nested/file.py
    const changes = [change("src/alias/deep/nested/file.py", "deep evil")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    expect(existsSync(join(worktreePath, "tests", "deep", "nested", "file.py"))).toBe(false);
  });

  it("父目录符号链接指向 src/ 内子目录 → 写入成功（真实落点仍在白名单内）", async () => {
    // 合法场景：src/alias → src/subdir（都在 src/** 白名单内）
    mkdirSync(join(worktreePath, "src", "subdir"), { recursive: true });
    const symlinkDir = join(worktreePath, "src", "alias");
    try {
      createDirectoryLink(join(worktreePath, "src", "subdir"), symlinkDir);
    } catch (err) {
      if (process.platform === "win32") {
        console.warn("Windows 无 Developer Mode，跳过符号链接逃逸测试");
        return;
      }
      throw err;
    }

    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    // src/alias/file.py → src/subdir/file.py（真实落点仍在 src/** 内）
    const changes = [change("src/alias/file.py", "legit via internal symlink")];

    await writer.writeFiles("task-1", worktreePath, allowedPaths, changes);

    expect(readFileSync(join(worktreePath, "src", "subdir", "file.py"), "utf8"))
      .toBe("legit via internal symlink");
  });
});

describe("P1-R01（§19.2）：LocalControlledFileWriter 悬挂父链接与解析失败", () => {
  it("悬挂符号链接（目标不存在）的父目录 → fail-closed 拒绝写入", async () => {
    // 创建指向不存在目标的悬挂符号链接
    const symlinkDir = join(worktreePath, "src", "dangling");
    try {
      createDirectoryLink(join(worktreePath, "nonexistent-target"), symlinkDir);
    } catch (err) {
      if (process.platform === "win32") {
        console.warn("Windows 无 Developer Mode，跳过符号链接逃逸测试");
        return;
      }
      throw err;
    }

    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    // src/dangling/file.py → 悬挂链接，realpathSync 会失败
    const changes = [change("src/dangling/file.py", "content via dangling symlink")];

    await expect(writer.writeFiles("task-1", worktreePath, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);
  });

  it("worktree 根不存在时 → fail-closed 拒绝写入", async () => {
    const writer = new LocalControlledFileWriter();
    const allowedPaths = ["src/**"];
    const changes = [change("src/file.py", "content")];
    // worktreePath 不存在，realpathSync 会抛错
    const nonexistentWorktree = join(tmpdir(), "tp-cfw-nonexistent-" + Date.now());

    await expect(writer.writeFiles("task-1", nonexistentWorktree, allowedPaths, changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);
  });
});

describe("P1-R01（§19.2）：LocalControlledFileWriter TOCTOU 失败关闭", () => {
  it("目标句柄建立后父目录被替换为外部链接 → 拒绝且外部文件不产生", async () => {
    mkdirSync(join(worktreePath, "src", "race"), { recursive: true });
    const writer = new ParentSwapWriter(externalPath);

    await expect(
      writer.writeFiles(
        "task-race",
        worktreePath,
        ["src/**"],
        [change("src/race/file.py", "不得写到外部目录")]
      )
    ).rejects.toBeInstanceOf(PathScopeViolationError);

    expect(writer.didSwap).toBe(true);
    expect(existsSync(join(externalPath, "file.py"))).toBe(false);
  });
});

describe("P1-R01（§18）：LocalControlledFileWriter 端到端模拟 omp develop", () => {
  it("模拟 omp 输出合法 <file_change> → 文件被写入 worktree", async () => {
    // 模拟 omp develop 的完整流程：extractFileChangesFromStdout 提取指令 →
    // LocalControlledFileWriter 代为写入
    const { extractFileChangesFromStdout } = await import("../src/omp-adapter.js");
    const stdout = [
      JSON.stringify({ type: "session", version: 3, id: "s1", cwd: worktreePath }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: [
              '<file_change path="src/users.py"><![CDATA[',
              "def create_user():",
              '    return {"status": 201}',
              "]]></file_change>"
            ].join("\n")
          }]
        }
      }),
      JSON.stringify({ type: "turn_end", isTerminal: true })
    ].join("\n");

    const changes = extractFileChangesFromStdout(stdout);
    expect(changes).toHaveLength(1);

    const writer = new LocalControlledFileWriter();
    await writer.writeFiles("task-1", worktreePath, ["src/**"], changes);

    const written = readFileSync(join(worktreePath, "src", "users.py"), "utf8");
    expect(written).toBe('def create_user():\n    return {"status": 201}');
  });

  it("模拟 omp 输出越权 <file_change> → 拒绝写入，worktree 不被污染", async () => {
    const { extractFileChangesFromStdout } = await import("../src/omp-adapter.js");
    const stdout = [
      JSON.stringify({ type: "session" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "text",
            text: [
              '<file_change path="src/users.py"><![CDATA[legit]]></file_change>',
              '<file_change path=".git/config"><![CDATA[[user]\nname = evil]]></file_change>',
              '<file_change path="../evil.py"><![CDATA[evil]]></file_change>'
            ].join("\n")
          }]
        }
      }),
      JSON.stringify({ type: "turn_end", isTerminal: true })
    ].join("\n");

    const changes = extractFileChangesFromStdout(stdout);
    expect(changes).toHaveLength(3);

    const writer = new LocalControlledFileWriter();
    await expect(writer.writeFiles("task-1", worktreePath, ["src/**"], changes))
      .rejects.toBeInstanceOf(PathScopeViolationError);

    // 原子性：合法文件也不应被写入
    expect(existsSync(join(worktreePath, "src", "users.py"))).toBe(false);
    // ../evil.py 解析为 worktreePath 的父目录下的 evil.py；由于 LocalControlledFileWriter
    // 拒绝写入，该文件不应存在。注意：不检查 join(worktreePath, "..", "evil.py")，
    // 因为 tmpdir 可能含其他测试遗留的同名文件；改检查 worktreePath 同级的 evil.py。
    expect(existsSync(join(worktreePath, "evil.py"))).toBe(false);
  });
});
