/** Phase 7 SAG 装配测试：默认 SQLite 基线、半配置失败关闭与显式替身增强。 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCompositionRoot } from "../src/composition-root.js";
import type { SagMirrorTransport } from "@tracepilot/core";

const directories: string[] = [];
const originalSagBaseUrl = process.env.TRACEPILOT_SAG_BASE_URL;
const originalSagToken = process.env.TRACEPILOT_SAG_TOKEN;

afterEach(() => {
  if (originalSagBaseUrl === undefined) delete process.env.TRACEPILOT_SAG_BASE_URL;
  else process.env.TRACEPILOT_SAG_BASE_URL = originalSagBaseUrl;
  if (originalSagToken === undefined) delete process.env.TRACEPILOT_SAG_TOKEN;
  else process.env.TRACEPILOT_SAG_TOKEN = originalSagToken;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function dbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "tracepilot-phase7-sag-api-"));
  directories.push(directory);
  return join(directory, "tracepilot.db");
}

describe("Phase 7 SAG 可选装配", () => {
  it("未配置 SAG 时继续使用 SQLite Repair Memory 基线", async () => {
    const root = buildCompositionRoot({ dbPath: dbPath(), skipEnvFile: true });
    try {
      const response = await root.app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { knowledge: string }).knowledge).toBe("sqlite-memory");
    } finally {
      await root.close();
    }
  });

  it("仅配置 SAG 地址或 token 时失败关闭", () => {
    process.env.TRACEPILOT_SAG_BASE_URL = "http://127.0.0.1:8000/api/v1";
    expect(() => buildCompositionRoot({ dbPath: dbPath(), skipEnvFile: true }))
      .toThrow("SAG 配置不完整");
  });

  it("仅通过显式测试替身启用 SAG 增强模式", async () => {
    const transport: SagMirrorTransport = {
      upsertRepairRecord: async () => undefined,
      searchRepairRecordIds: async () => []
    };
    const root = buildCompositionRoot({
      dbPath: dbPath(),
      skipEnvFile: true,
      sagTransportOverride: transport
    });
    try {
      const response = await root.app.inject({ method: "GET", url: "/health" });
      expect((response.json() as { knowledge: string }).knowledge).toBe("sag-enhanced");
    } finally {
      await root.close();
    }
  });
});
