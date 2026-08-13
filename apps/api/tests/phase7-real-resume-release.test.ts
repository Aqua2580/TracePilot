/**
 * Phase 7 真实 Resume Release 门禁。
 *
 * 本文件不使用测试替身冒充真实 Omp/SAG。脚本只有在操作者显式确认模型费用
 * 与本地 SAG 已就绪后才会运行；缺少任一前置条件时必须失败关闭。
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnvFile(): void {
  try {
    const testsDirectory = fileURLToPath(new URL(".", import.meta.url));
    process.loadEnvFile?.(join(testsDirectory, "..", "..", "..", ".env"));
  } catch {
    // 缺失配置会由严格断言失败关闭，不能静默当作真实门禁通过。
  }
}

if (process.env.TRACEPILOT_PHASE7_REAL_ACK === "1") loadEnvFile();

const describeWhenExplicitlyAuthorized =
  process.env.TRACEPILOT_PHASE7_REAL_ACK === "1" ? describe : describe.skip;

describeWhenExplicitlyAuthorized("Phase 7 真实 Resume Release 前置门禁", () => {
  it("要求显式授权、两个真实 Omp 任务、本机 SAG Source 和 uv 调试环境", () => {
    expect(process.env.TRACEPILOT_PHASE7_REAL_ACK).toBe("1");
    expect(process.env.TRACEPILOT_OMP_REAL_STRICT).toBe("1");
    expect(process.env.TRACEPILOT_PHASE7_REAL_STRICT).toBe("1");
    expect(process.env.TRACEPILOT_OMP_PATH).toMatch(/.+/);
    expect(process.env.TRACEPILOT_SAG_BASE_URL).toMatch(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/);
    expect(process.env.TRACEPILOT_SAG_TOKEN).toMatch(/.+/);
    expect(process.env.TRACEPILOT_PHASE7_SAG_SOURCE_ID).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(process.env.TRACEPILOT_PHASE7_PYTHON).toMatch(/.+/);
    const python = process.env.TRACEPILOT_PHASE7_PYTHON!;
    expect(existsSync(python)).toBe(true);
    expect(() => execFileSync(python, ["-c", "import debugpy, pytest"], { stdio: "ignore", timeout: 5_000 }))
      .not.toThrow();
  });
});
