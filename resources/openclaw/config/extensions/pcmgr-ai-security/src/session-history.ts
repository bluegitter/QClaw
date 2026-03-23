/**
 * 会话历史提取模块
 *
 * 从 CodeBuddy 会话文件中提取最近的用户消息和 assistant thinking 内容，
 * 用于 before_tool_call 时的上下文审计。
 */

import fs from "node:fs";
import path from "node:path";
import { ContentType } from "./client";
import { normalizeMessage } from "./utils";
import { LOG_TAG } from "./constants";

export interface SessionContext {
  historyV2: Array<{ Role: string; Content: string; ContentType: ContentType }>;
  thinkingContent: string;
}

export function extractSessionContext(
  stateDir: string,
  agentId: string,
  sessionKey: string,
  toolName: string,
  toolParams: any,
  logger: any
): SessionContext {
  const empty: SessionContext = { historyV2: [], thinkingContent: "" };

  try {
    const sessionsJsonPath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");

    if (!fs.existsSync(sessionsJsonPath)) return empty;

    const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf-8"));
    const sessionInfo = sessionsData[sessionKey];
    if (!sessionInfo?.sessionFile) return empty;

    const sessionFile = sessionInfo.sessionFile;
    const fullSessionPath = path.isAbsolute(sessionFile)
      ? sessionFile
      : path.join(path.dirname(sessionsJsonPath), sessionFile);

    if (!fs.existsSync(fullSessionPath)) return empty;

    const sessionContent = fs.readFileSync(fullSessionPath, "utf-8");
    const lines = sessionContent.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return empty;

    let lastUserText = "";
    let thinkingContent = "";

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (item.type !== "message" || !item.message) continue;

        const msg = item.message;

        if (!lastUserText) {
          const normalized = normalizeMessage(msg, "openai");
          if (normalized.role === "user") {
            lastUserText = normalized.content;
          }
        }

        if (
          !thinkingContent &&
          msg.role === "assistant" &&
          Array.isArray(msg.content)
        ) {
          const matchedToolCall = msg.content.find(
            (c: any) =>
              c.type === "toolCall" &&
              c.name === toolName &&
              JSON.stringify(c.arguments) === JSON.stringify(toolParams)
          );
          const thinking = msg.content.find(
            (c: any) => c.type === "thinking"
          );
          if (matchedToolCall && thinking) {
            thinkingContent = thinking.thinking || "";
          }
        }

        if (lastUserText && thinkingContent) break;
      } catch {
        // Skip invalid lines
      }
    }

    const historyV2: SessionContext["historyV2"] = lastUserText
      ? [{ Role: "user", Content: lastUserText, ContentType: ContentType.TEXT }]
      : [];

    return { historyV2, thinkingContent };
  } catch (e) {
    logger.error(`[${LOG_TAG}] Failed to extract session history: ${e}`);
    return empty;
  }
}
