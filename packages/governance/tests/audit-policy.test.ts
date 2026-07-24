import { describe, expect, it } from "vitest";
import { DefaultAuditPolicy } from "../src/audit-policy.js";

describe("DefaultAuditPolicy（§7.3）", () => {
  const policy = new DefaultAuditPolicy();

  describe("redactEnv", () => {
    it("对每个值进行脱敏——只记录名称，从不记录值", () => {
      const out = policy.redactEnv({
        PATH: "/usr/bin",
        API_TOKEN: "super-secret",
        HOME: "/home/alice"
      });
      expect(out.PATH).toBe("[redacted]");
      expect(out.API_TOKEN).toBe("[redacted]");
      expect(out.HOME).toBe("[redacted]");
    });

    it("保留所有变量名", () => {
      const out = policy.redactEnv({ FOO: "1", BAR: "2" });
      expect(Object.keys(out).sort()).toEqual(["BAR", "FOO"]);
    });
  });

  describe("truncateOutput", () => {
    it("未超出字节预算时原样返回输出", () => {
      const out = policy.truncateOutput("hello", 100);
      expect(out.retained).toBe("hello");
      expect(out.truncated).toBe(false);
      expect(out.originalBytes).toBe(5);
      expect(out.retainedBytes).toBe(5);
    });

    it("超出预算时进行截断并保留尾部", () => {
      const big = "x".repeat(10_000);
      const out = policy.truncateOutput(big, 1000);
      expect(out.truncated).toBe(true);
      expect(out.originalBytes).toBe(10_000);
      expect(out.retainedBytes).toBeLessThan(out.originalBytes);
      expect(out.retained).toMatch(/truncated/);
      // 尾部应是连续的 x（原始内容）。
      expect(out.retained).toMatch(/x+$/);
    });

    it("对多字节 UTF-8 字符精确保持字节计数", () => {
      // 每个 emoji 在 UTF-8 中占 4 字节。
      const out = policy.truncateOutput("😀".repeat(10), 8);
      expect(out.originalBytes).toBe(40);
      expect(out.truncated).toBe(true);
    });
  });

  describe("isSensitiveName", () => {
    it("标记常见的敏感环境变量名", () => {
      expect(policy.isSensitiveName("API_TOKEN")).toBe(true);
      expect(policy.isSensitiveName("DATABASE_PASSWORD")).toBe(true);
      expect(policy.isSensitiveName("PRIVATE_KEY")).toBe(true);
      expect(policy.isSensitiveName("AUTH_COOKIE")).toBe(true);
    });

    it("不标记良性名称", () => {
      expect(policy.isSensitiveName("PATH")).toBe(false);
      expect(policy.isSensitiveName("HOME")).toBe(false);
      expect(policy.isSensitiveName("LANG")).toBe(false);
    });
  });
});
