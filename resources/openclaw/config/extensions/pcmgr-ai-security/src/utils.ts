/**
 * 电脑管家 AI 安全插件工具函数 (PCMgr AI Security Plugin Utilities)
 */

import os from "node:os";
import crypto from "node:crypto";
import { machineIdSync } from "node-machine-id";
import { getLabelName } from "./labels";
import { DecisionType, RiskItem } from "./client";
import { fileLog } from "./logger";

export function getDeviceFingerprint(): string {
  return machineIdSync();
}

export function getLocalIP12(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address
          .split(".")
          .map((part) => part.padStart(3, "0"))
          .join("");
      }
    }
  }
  return "000000000000";
}

export function generateRequestId(): string {
  const now = new Date();
  const dateStr =
    now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, "0") +
    now.getDate().toString().padStart(2, "0") +
    now.getHours().toString().padStart(2, "0") +
    now.getMinutes().toString().padStart(2, "0") +
    now.getSeconds().toString().padStart(2, "0");

  const ipStr = getLocalIP12();
  const msStr = now.getMilliseconds().toString().padStart(3, "0");
  const randStr = Math.floor(Math.random() * 4095)
    .toString(16)
    .toUpperCase()
    .padStart(3, "0");

  return dateStr + ipStr + msStr + randStr;
}

export interface NormalizedMessage {
  role: string;
  content: string;
}

export function normalizeMessage(
  message: any,
  format: "openai" | string = "openai"
): NormalizedMessage {
  if (format === "openai") {
    let content = "";
    if (typeof message.content === "string") {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      content = message.content
        .filter((part: any) => part.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n");
    }
    return { role: message.role || "", content };
  }

  return {
    role: message.role || "",
    content:
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content || ""),
  };
}

export function robustExtractLastUserMessage(body: any): NormalizedMessage[] {
  if (!body || typeof body !== "object") return [];

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const messages = body.messages;
    const lastMessage = messages[messages.length - 1];
    const normalized = normalizeMessage(lastMessage, "openai");

    if (normalized.role !== "user") return [];
    if (normalized.content.length > 0) return [normalized];
    return [];
  }

  if (typeof body.prompt === "string") return [{ role: "user", content: body.prompt }];
  if (typeof body.input === "string") return [{ role: "user", content: body.input }];
  return [];
}

const INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

const TIMESTAMP_ENVELOPE_RE = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}.*?\]\s*/;

export function stripOpenClawMetadata(text: string): string {
  if (!text) return text;

  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length && lines[index].trim() === "") { index++; }

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!INBOUND_META_SENTINELS.some((s) => s === trimmed)) break;
    index++;
    if (index < lines.length && lines[index].trim() === "```json") {
      index++;
      while (index < lines.length && lines[index].trim() !== "```") { index++; }
      if (index < lines.length && lines[index].trim() === "```") { index++; }
    }
    while (index < lines.length && lines[index].trim() === "") { index++; }
  }

  let remaining = lines.slice(index).join("\n").trim();
  remaining = remaining.replace(TIMESTAMP_ENVELOPE_RE, "");
  return remaining;
}

export function calculateContentHash(content: string, index: number): string {
  if (typeof content !== "string") return "";
  const md5 = crypto.createHash("md5").update(content).digest("hex");
  return `${md5}_${index}`;
}

export function recordLogEvent(
  api: any, tag: string, hook: string, data: unknown, _logRecord?: boolean
): void {
  const message = `[${tag}] ${hook} ${JSON.stringify(data)}`;
  api.logger.info(message);
  fileLog(message);
}

export const SECURITY_MESSAGE_PREFIX = "用户之前的输入因以下原因被拦截：";
export const BLOCK_MESSAGE_SUFFIX = "你不得回应原始请求。请礼貌地告知用户其消息因安全策略被拦截，并要求用户修改后重新提交，不得违反安全策略。[ 管家 AI 安全 ]";
export const MARK_MESSAGE_SUFFIX = "请提示用户确认此操作。[ 管家 AI 安全 ]";

export function injectSecurityMarker(
  content: any, securityReason: string, decision: DecisionType
): any {
  if (typeof content === "string") {
    const suffixRegex = /(\n\[message_id:.*?\])+$/i;
    const match = content.match(suffixRegex);
    const suffix = match ? match[0] : "";

    if (decision === DecisionType.BLOCK) {
      return `${securityReason}${suffix}`;
    }

    if (match) {
      const prefix = content.slice(0, content.length - suffix.length);
      return `${prefix}\n${securityReason}${suffix}`;
    }
    return `${content}\n${securityReason}`;
  }

  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (part.type === "text" && typeof part.text === "string") {
        return { ...part, text: injectSecurityMarker(part.text, securityReason, decision) };
      }
      return part;
    });
  }

  return content;
}

export function generateSecurityMessage(
  labels: string[], decision: DecisionType, risks?: RiskItem[]
): string {
  const lang = "zh";
  const labelNames: string[] = [];
  if (risks && risks.length > 0) {
    for (const risk of risks) {
      labelNames.push(risk.Reason || getLabelName(risk.Label, lang));
    }
  } else {
    for (const l of labels) {
      labelNames.push(getLabelName(l, lang));
    }
  }
  const uniqueLabelNames = Array.from(new Set(labelNames));
  const labelText = uniqueLabelNames.join("、");

  if (decision === DecisionType.MARK) {
    return `${SECURITY_MESSAGE_PREFIX} ：${labelText} 。${MARK_MESSAGE_SUFFIX}`;
  }
  return `${SECURITY_MESSAGE_PREFIX}\n${labelText}\n${BLOCK_MESSAGE_SUFFIX}`;
}
