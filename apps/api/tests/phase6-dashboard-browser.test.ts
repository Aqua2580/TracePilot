/**
 * Phase 6 真实浏览器闭环。
 *
 * 该测试通过 Dashboard 的可见控件，从预置已登记项目创建任务，依次完成
 * Evidence Pack、Plan、执行审批、受控 worktree、测试替身 Runtime 的真实
 * Diff/验证、Review、Phase 5 人工挑战和 Repair Memory 查询。它不会调用
 * 外部模型；测试替身只在 CompositionRoot.runtimeOverride 中明确注入。
 */

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  createDashboardDemoFixture,
  DASHBOARD_DEMO_HUMAN_SECRET,
  type DashboardDemoFixture
} from "./fixtures/dashboard-demo.js";

function repositoryRoot(): string {
  return resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
}

/** 每次浏览器测试均用当前源码构建 Dashboard，避免引用陈旧 dist。 */
function buildDashboardForBrowserTest(): string {
  const root = repositoryRoot();
  const webDirectory = join(root, "apps", "web");
  const viteBin = join(webDirectory, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    throw new Error("缺少 Vite 依赖；请先执行 pnpm install --frozen-lockfile");
  }
  execFileSync(process.execPath, [viteBin, "build"], {
    cwd: webDirectory,
    stdio: "pipe"
  });
  return join(webDirectory, "dist");
}

async function waitForButton(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).waitFor({ state: "visible", timeout: 15000 });
}

/**
 * Chromium 或 Playwright 协议异常时，单个定位器的 timeout 可能无法及时把
 * 控制权交回测试进程。额外使用 Node 计时器形成独立截止时间，保证失败时
 * 能输出资源加载诊断，而不是只得到 Vitest 的全局超时。
 */
async function withHardTimeout<T>(operation: Promise<T>, timeoutMs: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message())), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("Phase 6 Dashboard 真实浏览器闭环", () => {
  let fixture: DashboardDemoFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    await fixture?.cleanup();
    browser = undefined;
    fixture = undefined;
  });

  it("非开发者可仅通过 UI 完成受控演示，且没有绕过审批、质量门或人工挑战", async () => {
    const reportStage = (stage: string): void => console.info(`[Phase 6 浏览器闭环] ${stage}`);
    reportStage("构建 Dashboard 并启动受控演示服务");
    const dashboardDistPath = buildDashboardForBrowserTest();
    fixture = await createDashboardDemoFixture({ dashboardDistPath });
    const address = await fixture.root.app.listen({ host: "127.0.0.1", port: 0 });
    // 先从 Node 侧确认真实监听端口和静态入口可用，再启动浏览器。这样若
    // Chromium 访问失败，可以明确区分服务端故障与系统代理问题。
    const dashboardResponse = await fetch(`${address}/dashboard`);
    expect(dashboardResponse.status).toBe(200);
    const dashboardHtml = await dashboardResponse.text();
    const resourcePaths = [...dashboardHtml.matchAll(/(?:src|href)="(\/dashboard\/[^"]+)"/g)]
      .map((match) => match[1])
      .filter((path): path is string => path !== undefined);
    expect(resourcePaths.length).toBeGreaterThanOrEqual(3);
    for (const resourcePath of resourcePaths) {
      const resourceResponse = await fetch(new URL(resourcePath, address));
      expect(resourceResponse.status, `${resourcePath} 应可从真实监听端口读取`).toBe(200);
      await resourceResponse.arrayBuffer();
    }
    browser = await chromium.launch({ headless: true, args: ["--no-proxy-server"] });
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    const networkEvents: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("request", (request) => networkEvents.push(`请求 ${request.method()} ${request.url()}`));
    page.on("response", (response) => networkEvents.push(`响应 ${response.status()} ${response.url()}`));
    page.on("requestfailed", (request) => {
      networkEvents.push(`失败 ${request.url()} ${request.failure()?.errorText ?? "未知原因"}`);
    });

    // Dashboard 会立即建立持续 SSE 连接；部分浏览器在同源长连接初始化时
    // 也可能延后 domcontentloaded。这里只等待响应提交，再显式等待页面标题，
    // 才能同时验证真实实时连接与页面渲染。
    reportStage("打开 Dashboard");
    await page.goto(`${address}/dashboard`, { waitUntil: "commit", timeout: 10000 });
    reportStage("Dashboard 响应已提交，等待 React 渲染");
    try {
      await withHardTimeout(
        page.getByRole("heading", { name: "受控修复看板" }).waitFor({ state: "visible", timeout: 5000 }),
        6000,
        () =>
          `Dashboard 首屏等待超过 6 秒；当前地址=${page.url()}；` +
          `浏览器错误=${consoleErrors.join(" | ") || "无"}；` +
          `网络事件=${networkEvents.join(" | ") || "无"}`
      );
    } catch (error) {
      reportStage("React 渲染等待失败，准备输出诊断");
      throw new Error(
        error instanceof Error
          ? error.message
          : `Dashboard 未完成渲染；当前地址=${page.url()}；浏览器错误=${consoleErrors.join(" | ") || "无"}`,
        { cause: error }
      );
    }
    reportStage("React 首屏已渲染，等待已登记项目");
    await page
      .getByRole("button", { name: fixture.project.name, exact: true })
      .waitFor({ state: "visible", timeout: 5000 });

    // CREATED 状态只允许从证据收集开始，页面不存在跳过审批的执行按钮。
    expect(await page.getByRole("button", { name: "运行受控开发与验证", exact: true }).count()).toBe(0);
    reportStage("创建任务");
    await page.getByText("新建修复任务", { exact: true }).click();
    await page.getByLabel("要解决什么问题").fill("修复合成项目状态文件");
    await page.getByLabel("来源说明").fill("状态校验返回 broken");
    await page.getByRole("button", { name: "创建受控任务", exact: true }).click();

    reportStage("收集 Evidence Pack");
    await waitForButton(page, "开始收集证据");
    await page.getByRole("button", { name: "开始收集证据", exact: true }).click();
    await page.getByLabel("待验证根因").waitFor({ state: "visible", timeout: 15000 });
    await page.getByLabel("待验证根因").fill("状态文件仍保留 broken 值");
    await page.getByLabel("适用条件（可选）").fill("仅适用于当前合成项目");
    await page.getByRole("button", { name: "提交受控结论", exact: true }).click();

    reportStage("提交受控结论并记录 Plan");
    await page.getByLabel("允许修改的路径（逗号分隔）").waitFor({ state: "visible", timeout: 15000 });
    await page.getByLabel("允许修改的路径（逗号分隔）").fill("src/**");
    await page.getByRole("button", { name: "记录 Plan 并请求执行审批", exact: true }).click();

    reportStage("记录执行审批");
    await page.getByLabel("审批人").waitFor({ state: "visible", timeout: 15000 });
    await page.getByLabel("审批人").fill("演示工程负责人");
    await page.getByRole("button", { name: "记录执行批准", exact: true }).click();
    await waitForButton(page, "创建 worktree 并开始执行");
    await page.getByRole("button", { name: "创建 worktree 并开始执行", exact: true }).click();

    reportStage("创建 worktree 并开始执行");
    await waitForButton(page, "运行分析");
    reportStage("运行分析与受控开发");
    await page.getByRole("button", { name: "运行分析", exact: true }).click();
    await page.getByText("分析已完成，请继续受控开发。", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
    await page.getByRole("button", { name: "运行受控开发与验证", exact: true }).click();
    await waitForButton(page, "进入 Review");
    await page.getByRole("button", { name: "进入 Review", exact: true }).click();

    reportStage("提交 Review");
    await page.getByRole("heading", { name: "最后确认", exact: true }).waitFor({ state: "visible", timeout: 15000 });
    reportStage("人工最终确认与 Repair Memory 查询");
    await page.getByLabel("人工审批通道凭证（只保存在本次页面内存）").fill(DASHBOARD_DEMO_HUMAN_SECRET);
    await page.getByRole("button", { name: "确认批准", exact: true }).click();
    await page.getByText("已完成", { exact: true }).first().waitFor({ state: "visible", timeout: 15000 });

    // 结束时所有关键视图均来自页面已经走过的真实受控链路。
    expect(await page.getByText(/版本 2/).count()).toBeGreaterThan(0);
    expect(await page.getByText(/变更文件：.*src\/status\.txt/).count()).toBeGreaterThan(0);
    const reviewPanel = page.locator(".panel").filter({
      has: page.getByRole("heading", { name: "审查与修复记录", exact: true })
    });
    await reviewPanel.getByText(/APPROVED/).first().waitFor({ state: "visible", timeout: 5000 });
    await page.getByLabel("Repair Memory 查询").fill("修复合成项目状态文件");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    const memoryPanel = page.locator(".panel").filter({
      has: page.getByRole("heading", { name: "Repair Memory", exact: true })
    });
    await memoryPanel.getByText(/APPROVED/).first().waitFor({ state: "visible", timeout: 5000 });
    expect(await memoryPanel.textContent()).toContain("APPROVED");
    expect(consoleErrors).toEqual([]);
  }, 30000);
});
