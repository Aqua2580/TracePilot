/**
 * AuditPolicy — §7.3。
 *
 * 决定为命令执行记录什么内容。敏感环境变量只记录
 * 名称，绝不记录值。输出按字节预算截断并保留可读的尾部。
 * 依据 §7.3：记录 argv、cwd、退出码、截断信息、
 * diff hash、审批人、评审结论 —— 但绝不记录超过配置上限的
 * 原始运行时输出。
 */

import type { AuditPolicy } from "@tracepilot/core";

/**
 * 启发式列表：值可能敏感的环境变量名。我们在审计中默认
 * 脱敏所有环境变量（§7.3 规定"敏感变量只记录名称，不记录值"）；
 * 此列表只是补充显式原因。
 */
const KNOWN_SENSITIVE_PATTERNS = [
  /token/i, /secret/i, /password/i, /passwd/i, /key/i, /credential/i,
  /auth/i, /api[_-]?key/i, /private/i, /cert/i, /cookie/i, /session/i
];

export class DefaultAuditPolicy implements AuditPolicy {
  /**
   * 将每个环境变量值脱敏为 "[redacted]"。依据 §7.3，我们绝不记录值 ——
   * 只记录名称。这是有意为之的严格策略：即使是
   * 非敏感值在审计中也会被脱敏，因为敏感性的判定
   * 容易出错。
   */
  redactEnv(env: Readonly<Record<string, string>>): Readonly<Record<string, "[redacted]" | string>> {
    const out: Record<string, "[redacted]" | string> = {};
    for (const [name, _value] of Object.entries(env)) {
      void _value;
      // 始终记录变量名，绝不记录值。
      out[name] = "[redacted]";
    }
    return out;
  }

  /**
   * 将输出截断为 `maxBytes`，保留可读的尾部。返回
   * 保留的字符串和审计事件所需的截断元数据。
   */
  truncateOutput(output: string, maxBytes: number): {
    readonly retained: string;
    readonly originalBytes: number;
    readonly retainedBytes: number;
    readonly truncated: boolean;
  } {
    // 编码为 UTF-8 以按字节计数（而非字符数）。
    const originalBytes = Buffer.byteLength(output, "utf8");
    if (originalBytes <= maxBytes) {
      return {
        retained: output,
        originalBytes,
        retainedBytes: originalBytes,
        truncated: false
      };
    }
    // 保留头部（10% 或 1KB，取较小者）和尾部（剩余部分）。
    const headBudget = Math.min(1024, Math.floor(maxBytes * 0.1));
    const tailBudget = maxBytes - headBudget - 32; // 32 字节用于分隔符
    const headBuf = Buffer.from(output, "utf8").subarray(0, headBudget);
    const tailBuf = Buffer.from(output, "utf8").subarray(
      Buffer.byteLength(output, "utf8") - tailBudget
    );
    const separator = `\n... [truncated ${originalBytes - maxBytes} bytes] ...\n`;
    const retained = Buffer.concat([
      headBuf,
      Buffer.from(separator, "utf8"),
      tailBuf
    ]).toString("utf8");
    return {
      retained,
      originalBytes,
      retainedBytes: Buffer.byteLength(retained, "utf8"),
      truncated: true
    };
  }

  /**
   * 供调用方/测试使用的辅助方法：给定环境变量名是否被视为敏感？
   * 用于决定是只记录名称还是同时标记。
   */
  isSensitiveName(name: string): boolean {
    return KNOWN_SENSITIVE_PATTERNS.some((p) => p.test(name));
  }
}
