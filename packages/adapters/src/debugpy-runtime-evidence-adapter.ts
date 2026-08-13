/**
 * debugpy 运行时证据 Adapter —— Phase 7。
 *
 * 这是一个只读、本机 loopback 专用的 DAP 客户端：它从 pytest 堆栈定位
 * worktree 内的 Python 文件，连接已由操作者受控启动的 debugpy，会话暂停
 * 后读取匹配帧的局部变量并产出 `runtime` EvidenceItem。它不会启动 Python、
 * 写文件、运行模型，也不会连接远程调试器。
 */

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Socket } from "node:net";
import type {
  EvidenceItem,
  PathPolicy,
  PythonRuntimeDebugCaptureInput,
  RuntimeDebugEvidenceAdapter
} from "@tracepilot/core";

const LOOPBACK_HOST = "127.0.0.1";
const DAP_TIMEOUT_MS = 8_000;
const DAP_CONNECT_RETRY_DELAY_MS = 50;
const MAX_VARIABLES = 20;
const MAX_VARIABLE_VALUE_LENGTH = 240;
const SENSITIVE_VARIABLE_NAME = /(?:api[_-]?key|authorization|credential|password|secret|token|private[_-]?key)/i;

export class RuntimeDebugEvidenceError extends Error {
  constructor(message: string) {
    super(`运行时调试证据采集失败：${message}`);
    this.name = "RuntimeDebugEvidenceError";
  }
}

export interface DebugpyRuntimeEvidenceAdapterOptions {
  readonly pathPolicy: PathPolicy;
  /** DAP 请求超时；只允许降低到 1 至 30 秒之间。 */
  readonly timeoutMs?: number;
}

/** Phase 7 的真实本机 DAP 实现。 */
export class DebugpyRuntimeEvidenceAdapter implements RuntimeDebugEvidenceAdapter {
  private readonly timeoutMs: number;

  constructor(private readonly options: DebugpyRuntimeEvidenceAdapterOptions) {
    const timeoutMs = options.timeoutMs ?? DAP_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
      throw new RuntimeDebugEvidenceError("timeoutMs 必须是 1000 到 30000 的整数");
    }
    this.timeoutMs = timeoutMs;
  }

  async capturePythonRuntimeEvidence(
    input: PythonRuntimeDebugCaptureInput
  ): Promise<EvidenceItem> {
    throwIfAborted(input.abortSignal);
    assertDapPort(input.dapPort);
    const stackLocation = locatePythonStackFrame(
      input.pytestStackTrace,
      input.worktreePath,
      this.options.pathPolicy
    );
    const client = new DapClient(LOOPBACK_HOST, input.dapPort, this.timeoutMs, input.abortSignal);
    let pausedThreadId: number | undefined;

    try {
      await client.connect();
      await client.request("initialize", {
        clientID: "tracepilot-phase7",
        clientName: "TracePilot Phase 7 Runtime Evidence",
        adapterID: "python",
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true
      });

      // debugpy 的真实握手顺序是 attach 后才发 initialized 事件。
      const attach = client.request("attach", {
        justMyCode: true,
        redirectOutput: false
      });
      await client.waitForEvent("initialized");
      await client.request("configurationDone", {});
      await attach;

      const stopped = await client.waitForEvent("stopped");
      pausedThreadId = readPositiveInteger(stopped.body, "threadId", "暂停线程");
      const frame = await this.readMatchingFrame(client, pausedThreadId, stackLocation);
      const variables = await this.readLocalVariables(client, frame.id);
      return toRuntimeEvidence(stackLocation, frame, variables, input);
    } catch (error) {
      if (error instanceof RuntimeDebugEvidenceError) throw error;
      // 不将 DAP 服务端返回的原文或变量内容带出，避免诊断意外泄漏。
      throw new RuntimeDebugEvidenceError("本机 debugpy 会话未能返回受限运行时证据");
    } finally {
      // 调用方已取消时 socket 已被立即销毁；不得为了礼貌断连再等待一轮
      // DAP 请求超时，否则取消会退化成等待 timeout。
      if (!client.isCancelled()) {
        await finishDebugSession(client, pausedThreadId);
      }
    }
  }

  private async readMatchingFrame(
    client: DapClient,
    threadId: number,
    stackLocation: PythonStackLocation
  ): Promise<DapFrame> {
    const response = await client.request("stackTrace", {
      threadId,
      startFrame: 0,
      levels: 20
    });
    const rawFrames = asRecord(response.body)?.stackFrames;
    if (!Array.isArray(rawFrames)) {
      throw new RuntimeDebugEvidenceError("DAP 未返回调用栈");
    }
    for (const rawFrame of rawFrames) {
      const frame = parseDapFrame(rawFrame);
      if (frame && sameLocalPath(frame.sourcePath, stackLocation.absolutePath)) {
        return frame;
      }
    }
    throw new RuntimeDebugEvidenceError("暂停帧与 pytest 堆栈定位的工作树文件不一致");
  }

  private async readLocalVariables(
    client: DapClient,
    frameId: number
  ): Promise<CapturedVariables> {
    const scopesResponse = await client.request("scopes", { frameId });
    const rawScopes = asRecord(scopesResponse.body)?.scopes;
    if (!Array.isArray(rawScopes)) {
      throw new RuntimeDebugEvidenceError("DAP 未返回作用域");
    }
    const locals = rawScopes.find((scope) => {
      const value = asRecord(scope);
      return value?.name === "Locals" && Number.isInteger(value.variablesReference);
    });
    const localReference = asRecord(locals)?.variablesReference;
    if (typeof localReference !== "number" || localReference < 1) {
      throw new RuntimeDebugEvidenceError("DAP 未返回局部变量作用域");
    }

    const variablesResponse = await client.request("variables", {
      variablesReference: localReference,
      start: 0,
      // 多读取一项仅用于确认列表是否截断；返回的证据仍严格保留前
      // MAX_VARIABLES 项，且每项均先完成脱敏。
      count: MAX_VARIABLES + 1
    });
    const rawVariables = asRecord(variablesResponse.body)?.variables;
    if (!Array.isArray(rawVariables)) {
      throw new RuntimeDebugEvidenceError("DAP 未返回局部变量");
    }
    const declaredVariables = asRecord(locals)?.namedVariables;
    const truncated = rawVariables.length > MAX_VARIABLES || (
      typeof declaredVariables === "number" &&
      Number.isInteger(declaredVariables) &&
      declaredVariables > MAX_VARIABLES
    );
    return {
      truncated,
      values: rawVariables
      .slice(0, MAX_VARIABLES)
      .flatMap((value) => {
        const variable = asRecord(value);
        if (!variable || typeof variable.name !== "string" || typeof variable.value !== "string") {
          return [];
        }
        return [{
          name: variable.name,
          value: sanitizeVariableValue(variable.name, variable.value)
        }];
      })
    };
  }
}

interface PythonStackLocation {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly line: number;
  readonly functionName?: string;
}

interface DapFrame {
  readonly id: number;
  readonly name: string;
  readonly sourcePath: string;
  readonly line: number;
}

interface SanitizedVariable {
  readonly name: string;
  readonly value: string;
}

interface CapturedVariables {
  readonly values: readonly SanitizedVariable[];
  readonly truncated: boolean;
}

interface DapResponse {
  readonly body?: unknown;
}

interface DapEvent {
  readonly event: string;
  readonly body?: unknown;
}

function locatePythonStackFrame(
  pytestStackTrace: string,
  worktreePath: string,
  pathPolicy: PathPolicy
): PythonStackLocation {
  if (typeof pytestStackTrace !== "string" || pytestStackTrace.trim().length === 0) {
    throw new RuntimeDebugEvidenceError("pytest 堆栈不能为空");
  }
  const matches = [...pytestStackTrace.matchAll(/File\s+"([^"\r\n]+\.py)",\s+line\s+(\d+)(?:,\s+in\s+([^\r\n]+))?/g)];
  const last = matches.at(-1);
  if (!last) {
    throw new RuntimeDebugEvidenceError("pytest 堆栈中没有可定位的 Python 文件行");
  }
  const rawPath = last[1]!;
  const line = Number(last[2]);
  if (!Number.isInteger(line) || line < 1) {
    throw new RuntimeDebugEvidenceError("pytest 堆栈中的行号无效");
  }

  const unresolvedPath = isAbsolute(rawPath)
    ? rawPath
    : resolve(worktreePath, rawPath);
  const decision = pathPolicy.decide(unresolvedPath, [worktreePath]);
  if (!decision.allowed || !decision.resolvedPath) {
    throw new RuntimeDebugEvidenceError("pytest 堆栈指向工作树外的 Python 文件");
  }

  const resolvedWorktree = pathPolicy.decide(worktreePath, [worktreePath]).resolvedPath;
  if (!resolvedWorktree) {
    throw new RuntimeDebugEvidenceError("工作树路径无法解析");
  }
  const relativePath = relative(resolvedWorktree, decision.resolvedPath)
    .replace(/\\/g, "/");
  if (!relativePath || relativePath.startsWith("../")) {
    throw new RuntimeDebugEvidenceError("pytest 堆栈指向的文件无法归属到工作树");
  }
  return {
    absolutePath: decision.resolvedPath,
    relativePath,
    line,
    functionName: last[3]?.trim() || undefined
  };
}

function parseDapFrame(value: unknown): DapFrame | undefined {
  const frame = asRecord(value);
  const source = asRecord(frame?.source);
  if (
    !frame ||
    typeof frame.id !== "number" ||
    !Number.isInteger(frame.id) ||
    typeof frame.name !== "string" ||
    typeof frame.line !== "number" ||
    !Number.isInteger(frame.line) ||
    !source ||
    typeof source.path !== "string"
  ) {
    return undefined;
  }
  return {
    id: frame.id,
    name: frame.name,
    sourcePath: source.path,
    line: frame.line
  };
}

function sameLocalPath(left: string, right: string): boolean {
  try {
    const normalizedLeft = realpathSync(left);
    const normalizedRight = realpathSync(right);
    return process.platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  } catch {
    return false;
  }
}

function toRuntimeEvidence(
  stackLocation: PythonStackLocation,
  frame: DapFrame,
  variables: CapturedVariables,
  input: PythonRuntimeDebugCaptureInput
): EvidenceItem {
  const locator = `pytest:${stackLocation.relativePath}:${stackLocation.line};dap:${stackLocation.relativePath}:${frame.line}`;
  const sourceCommand = normalizeSourceCommand(input.sourceCommand);
  const testLocator = normalizeTestLocator(input.testLocator);
  const variableSummary = variables.values.length === 0
    ? "未读取到可展示的局部变量"
    : variables.values.map((variable) => `${variable.name}=${variable.value}`).join(", ");
  const summary = [
    `pytest 堆栈定位 ${stackLocation.relativePath}:${stackLocation.line}`,
    `测试定位=${testLocator ?? "未提供"}`,
    `来源命令=${sourceCommand ?? "未提供"}`,
    "工作目录=已登记 worktree",
    `DAP 在 ${stackLocation.relativePath}:${frame.line} 的 ${frame.name} 暂停`,
    `局部变量列表截断=${variables.truncated ? "是" : "否"}`,
    `局部变量：${variableSummary}`
  ].join("；");
  const contentHash = createHash("sha256")
    .update(JSON.stringify({
      locator,
      frame: frame.name,
      variables: variables.values,
      variablesTruncated: variables.truncated,
      sourceCommand,
      testLocator
    }))
    .digest("hex");
  return {
    id: `runtime-debug-${randomUUID()}`,
    kind: "runtime",
    source: "debugpy-dap-loopback",
    locator,
    capturedAt: new Date().toISOString(),
    contentHash: `sha256-${contentHash}`,
    summary,
    relevance: 0.95,
    trustLevel: "PRIMARY"
  };
}

function normalizeSourceCommand(command: readonly string[] | undefined): string | undefined {
  if (!command) return undefined;
  if (command.length === 0 || command.length > 32) {
    throw new RuntimeDebugEvidenceError("来源测试命令无效");
  }
  const normalized = command.map((item) => {
    if (typeof item !== "string" || item.length === 0 || item.length > 512 || /[\r\n\0]/.test(item)) {
      throw new RuntimeDebugEvidenceError("来源测试命令无效");
    }
    return item;
  });
  return JSON.stringify(normalized);
}

function normalizeTestLocator(testLocator: string | undefined): string | undefined {
  if (testLocator === undefined) return undefined;
  const normalized = testLocator.trim();
  if (!normalized || normalized.length > 512 || /[\r\n\0]/.test(normalized)) {
    throw new RuntimeDebugEvidenceError("pytest 用例定位无效");
  }
  return normalized;
}

function sanitizeVariableValue(name: string, value: string): string {
  if (SENSITIVE_VARIABLE_NAME.test(name)) return "[redacted]";
  return value.length > MAX_VARIABLE_VALUE_LENGTH
    ? `${value.slice(0, MAX_VARIABLE_VALUE_LENGTH)}…[truncated]`
    : value;
}

function assertDapPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new RuntimeDebugEvidenceError("DAP 端口必须是 1024 到 65535 的整数");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RuntimeDebugEvidenceError("操作者已取消本机 debugpy 证据采集");
  }
}

function readPositiveInteger(body: unknown, key: string, label: string): number {
  const value = asRecord(body)?.[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RuntimeDebugEvidenceError(`${label}无效`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isConnectionRefused(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ECONNREFUSED"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function finishDebugSession(client: DapClient, threadId: number | undefined): Promise<void> {
  try {
    if (threadId) {
      await client.request("continue", { threadId });
    }
    await client.request("disconnect", { terminateDebuggee: false });
  } catch {
    // 清理失败不覆盖主采集错误；socket 关闭仍会回收本机客户端连接。
  } finally {
    client.close();
  }
}

class DapClient {
  private socket: Socket | undefined;
  private buffer = Buffer.alloc(0);
  private sequence = 1;
  private readonly pending = new Map<number, {
    readonly command: string;
    readonly resolve: (value: DapResponse) => void;
    readonly reject: (reason: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  private readonly events: DapEvent[] = [];
  private readonly eventWaiters = new Map<string, {
    readonly resolve: (value: DapEvent) => void;
    readonly reject: (reason: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
    private readonly abortSignal?: AbortSignal
  ) {
    if (abortSignal?.aborted) {
      this.aborted = true;
    } else {
      abortSignal?.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  private aborted = false;
  private readonly onAbort = () => {
    this.aborted = true;
    this.close("操作者已取消本机 debugpy 证据采集");
  };

  async connect(): Promise<void> {
    this.throwIfCancelled();
    if (this.socket) throw new RuntimeDebugEvidenceError("DAP 客户端已连接");
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      try {
        await this.connectOnce();
        this.throwIfCancelled();
        return;
      } catch (error) {
        this.close();
        this.throwIfCancelled();
        // 仅容忍本机 debugpy 子进程启动与监听之间的短暂竞态；其他连接
        // 错误仍立即失败关闭，且总时长受既有 DAP 超时上限约束。
        if (!isConnectionRefused(error) || Date.now() >= deadline) {
          throw new RuntimeDebugEvidenceError("无法连接本机 debugpy");
        }
        await delay(DAP_CONNECT_RETRY_DELAY_MS);
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const socket = new Socket();
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.failPending());
    socket.on("close", () => this.failPending());
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abortSignal?.removeEventListener("abort", abortConnection);
        callback();
      };
      const timer = setTimeout(() => {
        socket.destroy();
        settle(() => rejectPromise(new RuntimeDebugEvidenceError("连接本机 debugpy 超时")));
      }, this.timeoutMs);
      const abortConnection = () => {
        socket.destroy();
        settle(() => rejectPromise(new RuntimeDebugEvidenceError("操作者已取消本机 debugpy 证据采集")));
      };
      socket.once("connect", () => {
        settle(resolvePromise);
      });
      socket.once("error", (error) => {
        settle(() => rejectPromise(error));
      });
      if (this.isCancelled()) {
        abortConnection();
        return;
      }
      this.abortSignal?.addEventListener("abort", abortConnection, { once: true });
      socket.connect({ host: this.host, port: this.port });
    });
  }

  request(command: string, argumentsValue: Record<string, unknown>): Promise<DapResponse> {
    this.throwIfCancelled();
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new RuntimeDebugEvidenceError("本机 debugpy 连接不可用"));
    }
    const sequence = this.sequence++;
    const payload = Buffer.from(JSON.stringify({
      seq: sequence,
      type: "request",
      command,
      arguments: argumentsValue
    }), "utf8");
    const framed = Buffer.concat([
      Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"),
      payload
    ]);
    return new Promise<DapResponse>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequence);
        rejectPromise(new RuntimeDebugEvidenceError(`DAP 请求 ${command} 超时`));
      }, this.timeoutMs);
      this.pending.set(sequence, {
        command,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer
      });
      this.socket!.write(framed, (error) => {
        if (error) this.rejectRequest(sequence, command);
      });
    });
  }

  waitForEvent(eventName: string): Promise<DapEvent> {
    this.throwIfCancelled();
    const existingIndex = this.events.findIndex((event) => event.event === eventName);
    if (existingIndex >= 0) return Promise.resolve(this.events.splice(existingIndex, 1)[0]!);
    if (this.eventWaiters.has(eventName)) {
      return Promise.reject(new RuntimeDebugEvidenceError(`DAP 事件 ${eventName} 已在等待`));
    }
    return new Promise<DapEvent>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.eventWaiters.delete(eventName);
        rejectPromise(new RuntimeDebugEvidenceError(`DAP 事件 ${eventName} 超时`));
      }, this.timeoutMs);
      this.eventWaiters.set(eventName, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer
      });
    });
  }

  close(reason = "本机 debugpy 连接已关闭"): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.failPending(reason);
  }

  isCancelled(): boolean {
    return this.aborted || this.abortSignal?.aborted === true;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const header = this.buffer.subarray(0, separator).toString("ascii");
      const match = /^Content-Length:\s*(\d+)$/im.exec(header);
      if (!match) {
        this.close();
        return;
      }
      const bodyLength = Number(match[1]);
      const totalLength = separator + 4 + bodyLength;
      if (this.buffer.length < totalLength) return;
      const body = this.buffer.subarray(separator + 4, totalLength);
      this.buffer = this.buffer.subarray(totalLength);
      try {
        this.onMessage(JSON.parse(body.toString("utf8")));
      } catch {
        this.close();
        return;
      }
    }
  }

  private onMessage(value: unknown): void {
    const message = asRecord(value);
    if (!message || typeof message.type !== "string") return;
    if (message.type === "response") {
      const requestSequence = message.request_seq;
      if (typeof requestSequence !== "number") return;
      const pending = this.pending.get(requestSequence);
      if (!pending) return;
      this.pending.delete(requestSequence);
      clearTimeout(pending.timer);
      if (message.success === true) {
        pending.resolve({ body: message.body });
      } else {
        pending.reject(new RuntimeDebugEvidenceError(`DAP 请求 ${pending.command} 被拒绝`));
      }
      return;
    }
    if (message.type !== "event" || typeof message.event !== "string") return;
    const event: DapEvent = { event: message.event, body: message.body };
    const waiter = this.eventWaiters.get(event.event);
    if (!waiter) {
      this.events.push(event);
      return;
    }
    this.eventWaiters.delete(event.event);
    clearTimeout(waiter.timer);
    waiter.resolve(event);
  }

  private rejectRequest(sequence: number, command: string): void {
    const pending = this.pending.get(sequence);
    if (!pending) return;
    this.pending.delete(sequence);
    clearTimeout(pending.timer);
    pending.reject(new RuntimeDebugEvidenceError(`DAP 请求 ${command} 无法发送`));
  }

  private throwIfCancelled(): void {
    if (this.aborted || this.abortSignal?.aborted) {
      throw new RuntimeDebugEvidenceError("操作者已取消本机 debugpy 证据采集");
    }
  }

  private failPending(reason = "本机 debugpy 连接已关闭"): void {
    for (const [sequence, pending] of this.pending) {
      this.pending.delete(sequence);
      clearTimeout(pending.timer);
      pending.reject(new RuntimeDebugEvidenceError(reason));
    }
    for (const [name, waiter] of this.eventWaiters) {
      this.eventWaiters.delete(name);
      clearTimeout(waiter.timer);
      waiter.reject(new RuntimeDebugEvidenceError(
        reason === "本机 debugpy 连接已关闭" ? `DAP 事件 ${name} 未完成` : reason
      ));
    }
  }
}
