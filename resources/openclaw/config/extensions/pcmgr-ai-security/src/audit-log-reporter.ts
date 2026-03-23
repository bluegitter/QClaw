/**
 * 审计日志模块
 *
 * 提供审计日志的类型定义、常量和记录能力。
 * - 本地：通过 fileLog 写入日志文件
 * - 外部：如果 auditReportUrl 非空，fire-and-forget POST 到外部 HTTP Server
 */

import { LOG_TAG } from "./constants";
import { fileLog } from "./logger";
import { getSwitches } from "./runtime-config";

/**
 * 保存原始 fetch 引用（在 interceptor 安装之前）。
 * 模块加载时 global.fetch 尚未被 setupFetchInterceptor 劫持，
 * 因此 nativeFetch 始终指向 Node.js 原始实现。
 */
const nativeFetch = global.fetch;

// 审计日志 ActionType（与 C++ 端 AIToolActionType 一致）
export const AuditActionType = {
  PROMPT_SECURITY_CHECK: 8,
  SKILLS_SECURITY_CHECK: 9,
  EXEC_SCRIPT_CHECK: 10,
} as const;

// 审计日志风险等级
export const AuditRiskLevel = {
  SAFE: 0,
  RISKY: 1,
} as const;

// 审计日志拦截结果
export const AuditResult = {
  ALLOW: 1,
  BLOCK: 2,
} as const;

export interface AuditLogEntry {
  softid?: number;
  actiontype: number;
  detail: string;
  risklevel: number;
  result: number;
  optpath: string;
}

/**
 * 记录审计日志（fire-and-forget）
 *
 * 1. 写本地日志文件
 * 2. 如果 auditReportUrl 已配置，POST 到外部 HTTP Server（使用原始 fetch，5s 超时）
 */
export async function reportAuditLog(entry: AuditLogEntry): Promise<void> {
  // 本地日志
  const logParts = [`action=${entry.actiontype}`, `risk=${entry.risklevel}`, `result=${entry.result}`];
  if (entry.optpath) logParts.push(`reason=${entry.optpath}`);
  logParts.push(`detail=${entry.detail.slice(0, 200)}`);
  fileLog(`[${LOG_TAG}] audit-log: ${logParts.join(", ")}`);

  // 外部上报
  const { auditReportUrl } = getSwitches();
  if (auditReportUrl) {
    nativeFetch(auditReportUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(5000),
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      fileLog(`[${LOG_TAG}] audit-log report failed: ${message}`);
    });
  }
}
