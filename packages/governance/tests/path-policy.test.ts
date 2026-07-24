import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import { join } from "node:path";
import { DefaultPathPolicy } from "../src/path-policy.js";

const canCreateSymlinks = (() => {
  // 在 Windows 上，创建 symlink 需要管理员权限或开发者模式。在模块
  // 加载时探测一次，如果不可用则跳过 symlink 测试，以便在受限环境
  // 中保持测试套件为绿色。允许 symlink 的平台仍会执行策略代码本身。
  if (platform() === "win32") {
    try {
      const probe = mkdtempSync(join(tmpdir(), "tp-sym-probe-"));
      try {
        symlinkSync(probe, join(probe, "probe-link"));
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
      return true;
    } catch {
      return false;
    }
  }
  return true;
})();

describe("DefaultPathPolicy", () => {
  const policy = new DefaultPathPolicy();
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "tp-path-"));
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  describe("基本包含", () => {
    it("允许位于根目录内的路径", () => {
      const root = sandbox;
      const file = join(root, "src", "foo.ts");
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(file, "x");
      const d = policy.decide(file, [root]);
      expect(d.allowed).toBe(true);
      expect(d.resolvedPath).toBe(file);
    });

    it("允许根目录本身", () => {
      const d = policy.decide(sandbox, [sandbox]);
      expect(d.allowed).toBe(true);
    });

    it("拒绝位于所有根目录之外的路径", () => {
      const outside = mkdtempSync(join(tmpdir(), "tp-out-"));
      try {
        const d = policy.decide(outside, [sandbox]);
        expect(d.allowed).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("路径遍历（§7.2）", () => {
    it("拒绝逃逸根目录的 ../ 遍历", () => {
      // 构造一个向上逃逸根目录的字面绝对路径。
      const escaping = join(sandbox, "..", "..", "etc", "passwd");
      const d = policy.decide(escaping, [sandbox]);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/traversal|outside|escap/i);
    });

    it("当真实路径仍在根目录内时允许根目录内的 .. ", () => {
      const root = sandbox;
      mkdirSync(join(root, "a", "b"), { recursive: true });
      const realFile = join(root, "a", "b", "file.txt");
      writeFileSync(realFile, "x");
      // /root/a/b/../b/file.txt 解析为 /root/a/b/file.txt——位于根目录内。
      const tricky = join(root, "a", "b", "..", "b", "file.txt");
      const d = policy.decide(tricky, [root]);
      expect(d.allowed).toBe(true);
    });
  });

  describe("symlink 逃逸（§7.2）", () => {
    const itSymlink = canCreateSymlinks ? it : it.skip;
    itSymlink("拒绝根目录内指向根目录外的 symlink", () => {
      const root = sandbox;
      const outside = mkdtempSync(join(tmpdir(), "tp-out-"));
      try {
        const link = join(root, "escape-link");
        symlinkSync(outside, link);
        const d = policy.decide(link, [root]);
        // symlink 目标的真实路径位于根目录之外。
        expect(d.allowed).toBe(false);
        expect(d.reason).toMatch(/outside|symlink/i);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    if (!canCreateSymlinks) {
      it("记录此平台跳过 symlink 测试（Windows 需开发者模式）", () => {
        // 占位断言，确保在 symlink 不可用时该 describe 块至少报告一个通过的断言。
        expect(canCreateSymlinks).toBe(false);
      });
    }
  });

  describe("输入校验", () => {
    it("拒绝空路径", () => {
      const d = policy.decide("", [sandbox]);
      expect(d.allowed).toBe(false);
    });

    it("拒绝相对路径（调用方必须先解析）", () => {
      const d = policy.decide("src/foo.ts", [sandbox]);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/relative/i);
    });

    it("未提供任何根目录时拒绝", () => {
      const d = policy.decide(sandbox, []);
      expect(d.allowed).toBe(false);
    });
  });
});
