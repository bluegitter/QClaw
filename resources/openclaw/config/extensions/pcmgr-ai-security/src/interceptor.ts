/**
 * 电脑管家 AI 全局 fetch 拦截器（LLM 请求审核）
 */

import { LOG_TAG } from "./constants";
import { LLMShieldClient, ContentType, DecisionType } from "./client";
import { MessageCache } from "./cache";
import { getModerateUrl } from "./endpoints";
import {
  normalizeMessage,
  robustExtractLastUserMessage,
  calculateContentHash,
  recordLogEvent,
  injectSecurityMarker,
  generateSecurityMessage,
  stripOpenClawMetadata,
} from "./utils";
import { getLabelName } from "./labels";
import { checkContentSecurity, writeLlmApiLog } from "./security";
import { reportAuditLog, AuditActionType, AuditRiskLevel, AuditResult } from "./audit-log-reporter";
import { getSwitches } from "./runtime-config";

export interface FetchInterceptorConfig {
  api: any;
  client: LLMShieldClient;
  sceneId: string;
  enableLogging: boolean;
  messageCache: MessageCache;
  modes?: string[];
}

export const setupFetchInterceptor = (config: FetchInterceptorConfig): void => {
  const { api, client, sceneId, enableLogging, messageCache, modes } = config;

  api.logger.debug(`[${LOG_TAG}] setupFetchInterceptor()`);

  // 从硬编码的审核 URL 中提取域名，用于跳过对审核服务自身的请求
  const shieldHost = new URL(getModerateUrl()).origin;

  const originalFetch = global.fetch;

  const newFetch = async function (this: any, ...args: Parameters<typeof fetch>) {
    const url = args[0]?.toString() || "";
    const options = args[1] || {};

    // Skip moderation for requests to the shield endpoint itself
    if (url.startsWith(shieldHost)) {
      return originalFetch.apply(this, args);
    }

    if (options.body) {
      let messagesToModerate: Array<{ role: string; content: string }> = [];
      let rawBody: string | undefined;
      let jsonBody: any;
      let bodyChanged = false;

      if (typeof options.body === "string") {
        rawBody = options.body;
      } else if (options.body instanceof Uint8Array || options.body instanceof ArrayBuffer) {
        rawBody = new TextDecoder().decode(options.body);
      }

      if (rawBody) {
        try {
          jsonBody = JSON.parse(rawBody);

          // Inject cached security markers into previously blocked messages
          if (jsonBody && Array.isArray(jsonBody.messages)) {
            jsonBody.messages.forEach((m: any, idx: number) => {
              const normalized = normalizeMessage(m, "openai");
              if (normalized.role === "user" && normalized.content) {
                const cacheKey = calculateContentHash(normalized.content, idx);
                if (cacheKey) {
                  const cached = messageCache.get(cacheKey);
                  if (cached) {
                    const newContent = injectSecurityMarker(
                      m.content,
                      cached.reason,
                      cached.decision
                    );
                    if (JSON.stringify(newContent) !== JSON.stringify(m.content)) {
                      m.content = newContent;
                      bodyChanged = true;
                    }
                  }
                }
              }
            });
          }

          messagesToModerate = robustExtractLastUserMessage(jsonBody);
        } catch (e) {
          recordLogEvent(
            api,
            LOG_TAG,
            "json_parse_failed",
            { url, error: String(e) },
            enableLogging
          );
        }
      }

      // Moderate the last user message
      if (messagesToModerate.length > 0 && getSwitches().enablePromptAudit) {
        const msg = messagesToModerate[0];

        // Extract recent history (last 5 non-system messages, excluding the current one)
        let historyV2: Array<{ Role: string; Content: string; ContentType: ContentType }> | undefined;
        if (jsonBody && Array.isArray(jsonBody.messages) && jsonBody.messages.length > 1) {
          const historyMessages = jsonBody.messages
            .slice(0, -1)
            .filter((m: any) => m.role !== "system")
            .slice(-5);

          historyV2 = historyMessages.map((m: any) => {
            const normalized = normalizeMessage(m, "openai");
            return {
              Role: normalized.role || "user",
              Content: normalized.content,
              ContentType: ContentType.TEXT,
            };
          });
        }

        const { decision, labels, risks } = await checkContentSecurity(
          api,
          client,
          sceneId,
          [
            {
              Content: msg.content,
              ContentType: ContentType.TEXT,
            },
          ],
          msg.role,
          "prompt_audit",
          enableLogging,
          historyV2,
          modes
        );

        // 上报审计日志到管家（BLOCK 和 ALLOW 都上报，MARK 不上报）
        // Strip OpenClaw-injected metadata (sender info, conversation info, timestamp prefix)
        if (decision !== DecisionType.MARK) {
          const rawPrompt = stripOpenClawMetadata(msg.content).replace(/\r\n|\n/g, " ");
          const isBlock = decision === DecisionType.BLOCK;
          // 取第一个 risk reason 作为 blockReason
          const firstReason = isBlock
            ? (risks[0]?.Reason || (labels[0] ? getLabelName(labels[0], "zh") : ""))
            : "";
          reportAuditLog({
            actiontype: AuditActionType.PROMPT_SECURITY_CHECK,
            detail: rawPrompt.slice(0, 500),
            risklevel: isBlock ? AuditRiskLevel.RISKY : AuditRiskLevel.SAFE,
            result: isBlock ? AuditResult.BLOCK : AuditResult.ALLOW,
            optpath: firstReason,
          }).catch(() => {});
        }

        if (decision === DecisionType.BLOCK || decision === DecisionType.MARK) {
          const securityReason = generateSecurityMessage(labels, decision, risks);

          // Cache the moderation result
          const lastIndex = (jsonBody?.messages?.length || 1) - 1;
          const cacheKey = calculateContentHash(msg.content, lastIndex);
          if (cacheKey) {
            messageCache.set(cacheKey, securityReason, decision);
          }

          const logPrefix = decision === DecisionType.BLOCK ? "block" : "mark";
          api.logger.error(`[${LOG_TAG}] prompt_audit ${logPrefix}: ${securityReason}`);
          recordLogEvent(
            api,
            LOG_TAG,
            `prompt_audit(${logPrefix})`,
            { securityReason, originalContent: msg.content },
            enableLogging
          );

          // Inject security marker into the request body
          if (jsonBody && Array.isArray(jsonBody.messages) && jsonBody.messages.length > 0) {
            const lastMsg = jsonBody.messages[jsonBody.messages.length - 1];
            lastMsg.content = injectSecurityMarker(lastMsg.content, securityReason, decision);
            bodyChanged = true;
          } else if (jsonBody && typeof jsonBody.prompt === "string") {
            jsonBody.prompt = injectSecurityMarker(jsonBody.prompt, securityReason, decision);
            bodyChanged = true;
          } else if (jsonBody && typeof jsonBody.input === "string") {
            jsonBody.input = injectSecurityMarker(jsonBody.input, securityReason, decision);
            bodyChanged = true;
          }
        }

        if (bodyChanged) {
          options.body = JSON.stringify(jsonBody);
        }
      }
    }

    // Log LLM API request (one-line summary)
    const reqBodyRaw = options.body
      ? typeof options.body === "string"
        ? options.body
        : options.body instanceof Uint8Array || options.body instanceof ArrayBuffer
          ? new TextDecoder().decode(options.body)
          : undefined
      : undefined;
    if (reqBodyRaw) {
      try {
        const parsed = JSON.parse(reqBodyRaw);
        const model = parsed.model ?? "?";
        const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
        const toolCount = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
        const stream = parsed.stream ? "stream" : "sync";
        const msgsSummary = msgs.map((m: any, i: number) => {
          const role = m.role ?? "?";
          const content = typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p: any) => p.text ?? `[${p.type}]`).join("")
              : JSON.stringify(m.content);
          const truncated = content.length > 200 ? content.slice(0, 200) + "..." : content;
          return `  [${i}] ${role}: ${truncated}`;
        }).reverse().join("\n");
        writeLlmApiLog(`[LLM] REQ  ${url} model=${model} msgs=${msgs.length} tools=${toolCount} ${stream}\n${msgsSummary}`);
      } catch {
        writeLlmApiLog(`[LLM] REQ  ${url} (parse failed, ${reqBodyRaw.length}b)`);
      }
    }

    const resp = await originalFetch.apply(this, args);

    // Log LLM API response (compact summary + message content)
    try {
      const cloned = resp.clone();
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        const reader = cloned.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let fullContent = "";
          let toolCalls: any[] = [];
          let model = "";
          let finishReason = "";
          let usage: any = null;
          let done = false;
          while (!done) {
            const { value, done: streamDone } = await reader.read();
            done = streamDone;
            if (value) {
              const chunk = decoder.decode(value, { stream: !done });
              for (const line of chunk.split("\n")) {
                if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
                try {
                  const data = JSON.parse(line.slice(6));
                  if (!model && data.model) model = data.model;
                  if (data.usage) usage = data.usage;
                  const delta = data.choices?.[0]?.delta;
                  if (delta?.content) fullContent += delta.content;
                  if (delta?.tool_calls) {
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index ?? toolCalls.length;
                      if (!toolCalls[idx]) toolCalls[idx] = { id: "", type: "", name: "", arguments: "" };
                      if (tc.id) toolCalls[idx].id = tc.id;
                      if (tc.type) toolCalls[idx].type = tc.type;
                      if (tc.function?.name) toolCalls[idx].name = tc.function.name;
                      if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
                    }
                  }
                  if (data.choices?.[0]?.finish_reason) finishReason = data.choices[0].finish_reason;
                } catch {}
              }
            }
          }
          const respSummary: any = { model, finish_reason: finishReason, content_length: fullContent.length };
          if (usage) respSummary.usage = usage;
          writeLlmApiLog(`[LLM] RESP ${url} (status:${resp.status}, stream) ${JSON.stringify(respSummary)}`);
          // Log assistant message content
          if (fullContent) {
            const truncated = fullContent.length > 2000 ? fullContent.slice(0, 2000) + "..." : fullContent;
            writeLlmApiLog(`[LLM] RESP message.content:\n${truncated}`);
          }
          if (toolCalls.length > 0) {
            const tcSummary = toolCalls.map((tc, i) => {
              const argsStr = tc.arguments.length > 500 ? tc.arguments.slice(0, 500) + "..." : tc.arguments;
              return `  [${i}] ${tc.name}(${argsStr})`;
            }).join("\n");
            writeLlmApiLog(`[LLM] RESP message.tool_calls:\n${tcSummary}`);
          }
        }
      } else {
        const respText = await cloned.text();
        const truncated = respText.length > 3000 ? respText.slice(0, 3000) + "..." : respText;
        writeLlmApiLog(`[LLM] RESP ${url} (status:${resp.status}, ${respText.length} bytes)\n${truncated}`);
      }
    } catch (_) {
      // ignore logging errors
    }

    return resp;
  };

  global.fetch = newFetch as typeof fetch;
};
