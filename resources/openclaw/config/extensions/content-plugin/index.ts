
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SessionType } from "./src/types";
import type { PluginConfig } from "./src/types";
import { CreateTaskClient } from "./src/client";
import { setSecurityConfig, checkContentSecurity } from "./src/security";
import { setupFetchInterceptor } from "./src/interceptor";
import { getSessionId, ensureQAIDForTurn } from "./src/session";
import { sliceText, checkSlicesParallel } from "./src/utils";
const { encryptPayload } = require("./src/crypto");
import { createTraceLoggerService, getTracer, getGalileoConfig, spanKey, setActiveSpan, getActiveSpanEntry, removeActiveSpan, nextLlmSeq, safeAttr, stripPromptMetadata, reportChatMetrics, ROOT_CONTEXT, SpanKind, reportAgentMetrics, SpanStatusCode } from './src/service.js';
import { reportToolMetrics, reportSkillMetrics, reportWsConnectionLog, parseSkillsFromSystemPrompt } from './src/service.js';

// ==================== Token 传输解密 ====================
// 与客户端 (openclaw-client.ts) 约定的 AES-256-GCM 加密协议。
// 密钥由相同的固定种子通过 SHA-256 派生。

/** 双方约定的密钥派生种子（必须与客户端完全一致） */
const TOKEN_ENCRYPTION_SEED = "openclaw:content-security:token-transport:v1";

/** Session JSONL 文件大小上限: 50MB（防内存耗尽） */
const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024;

/** 从种子派生 AES-256 密钥（SHA-256 → 256-bit key） */
function deriveTokenDecryptionKey(): Buffer {
  return crypto.createHash("sha256").update(TOKEN_ENCRYPTION_SEED).digest();
}

/**
 * AES-256-GCM 解密 token
 * 输入格式: base64( iv(12 bytes) + ciphertext + authTag(16 bytes) )
 */
function decryptToken(encryptedBase64: string): string {
  const combined = Buffer.from(encryptedBase64, "base64");
  const iv = combined.subarray(0, 12);
  // AES-GCM authTag 固定 16 字节，位于末尾
  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(12, combined.length - 16);

  const key = deriveTokenDecryptionKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf-8");
}

const OUTPUT_MAX_LENGTH = 120;

const LOG_TAG = "content-security";

// ============================================================================
// Skill 文件检测工具函数
// ============================================================================

/**
 * 从 SKILL.md 内容中提取 YAML frontmatter 中的 name 和 description。
 *
 * 支持的 description 格式：
 * 1. 单行: `description: Use this skill whenever...`
 * 2. 单行带引号: `description: "Use this skill whenever..."`
 * 3. YAML 多行块（`|` 或 `>`）:
 *    ```
 *    description: |
 *      First line of description
 *      Second line of description
 *    ```
 */
function parseSkillFrontmatter(content: string): { name?: string; description?: string } | null {
  if (!content || typeof content !== "string") return null;

  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match?.[1]) return null;

  const frontmatter = match[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);

  if (!nameMatch) return null;

  // 解析 description，支持单行和多行（YAML block scalar: | 或 >）
  let description: string | undefined;
  const descMatch = frontmatter.match(/^description:\s*(.*)$/m);
  if (descMatch) {
    const firstLine = descMatch[1].trim();
    if (firstLine === "|" || firstLine === ">" || firstLine === "|+" || firstLine === ">+" || firstLine === "|-" || firstLine === ">-") {
      // YAML 多行块：收集后续缩进行
      const descStartIdx = frontmatter.indexOf(descMatch[0]) + descMatch[0].length;
      const remainingLines = frontmatter.slice(descStartIdx).split("\n");
      const multilineparts: string[] = [];
      for (const line of remainingLines) {
        // 多行块中，缩进行属于当前字段；空行也保留；非缩进的非空行表示下一个字段
        if (line === "" || /^\s+/.test(line)) {
          multilineparts.push(line.replace(/^\s+/, ""));
        } else {
          break;
        }
      }
      const joined = firstLine.startsWith(">")
        ? multilineparts.join(" ").replace(/\s+/g, " ").trim()
        : multilineparts.join("\n").trim();
      if (joined) {
        description = joined;
      }
    } else if (firstLine) {
      // 单行值（可能带引号）
      description = firstLine.replace(/^["']|["']$/g, "");
    }
  }

  return {
    name: nameMatch[1].trim().replace(/^["']|["']$/g, ""),
    description,
  };
}

// ============================================================================
// 插件内自行统计的数据结构（方案 B：不依赖核心 hook 事件中缺失的字段）
// ============================================================================

/** LLM 调用开始时间记录。key = llmKey ("llm:runId:seq") */
const llmStartTimeMap = new Map<string, number>();

/** LLM 调用时的用户 prompt 缓存。key = llmKey，在 llm_output 中取出用于 Log 加密上报 */
const llmPromptMap = new Map<string, string>();

/** Agent 级别累加的 token 用量。key = agentKey ("agent:sessionKey") */
interface AccumulatedUsage {
  inputTokens: number;
  outputTokens: number;
}
const agentUsageMap = new Map<string, AccumulatedUsage>();

/** 当前会话可用的 skill 列表（从 systemPrompt 解析） */
let availableSkills: Array<{ name: string; description: string }> = [];

/** sessionKey → runId 映射。在 llm_input 中写入，供 agent_end / subagent_spawned 等缺少 runId 的钩子查表使用 */
const sessionRunIdMap = new Map<string, string>();

let token: any = null;

import { setExternalTraceId, setExternalGuid, getExternalGuid, setExternalUid, getExternalUid, setExternalAppVersion, getExternalAppVersion, setExternalSourceTerminal, getExternalSourceTerminal, setExternalPromptId, getExternalPromptId, setExternalWechatSessionId, getExternalWechatSessionId, setCurrentAgentCtx, setCurrentAgentSpanId, clearCurrentAgentCtx, setPendingChatSpanCallback, clearPendingChatSpanCallback, setOpenclawVersion, getOpenclawVersion, setCurrentLlmAuditContext, clearCurrentLlmAuditContext, extractInspirationTag, setCurrentInspirationTag, getCurrentInspirationTag } from "./src/state";

const CONTENT_PLUGIN_REPORT_BRIDGE = Symbol.for('openclaw.contentPluginReportBridge');

function syncExternalReportState(params: Record<string, unknown>): void {
  if (typeof params.trace_id === 'string' && params.trace_id) {
    setExternalTraceId(params.trace_id);
  }
  if (typeof params.guid === 'string' && params.guid) {
    setExternalGuid(params.guid);
  }
  if (typeof params.uid === 'string' && params.uid) {
    setExternalUid(params.uid);
  }
  if (typeof params.app_version === 'string' && params.app_version) {
    setExternalAppVersion(params.app_version);
  }
  setExternalSourceTerminal(
    typeof params.source_terminal === 'string' && params.source_terminal
      ? params.source_terminal
      : 'client'
  );
  if (typeof params.prompt_id === 'string' && params.prompt_id) {
    setExternalPromptId(params.prompt_id);
  }
  if (typeof params.wechat_session_id === 'string' && params.wechat_session_id) {
    setExternalWechatSessionId(params.wechat_session_id);
  }
}

function buildWsConnectionLogData(
  params: Record<string, unknown>,
) {
  return {
    guid: typeof params.guid === 'string' ? params.guid : '',
    uid: typeof params.uid === 'string' ? params.uid : '',
    serverip: typeof params.serverip === 'string' ? params.serverip : '',
    eventStatus: typeof params.event_status === 'string' ? params.event_status : 'unknown',
    eventTime: typeof params.event_time === 'string' ? params.event_time : undefined,
    reason: typeof params.reason === 'string' ? params.reason : undefined,
    errorDetail:
      typeof params.error_detail === 'string' ? params.error_detail : undefined,
    reconnectAttempt:
      typeof params.reconnect_attempt === 'number' ? params.reconnect_attempt : undefined,
    reconnectDelayMs:
      typeof params.reconnect_delay_ms === 'number' ? params.reconnect_delay_ms : undefined,
    appVersion: typeof params.app_version === 'string' ? params.app_version : undefined,
    sourceTerminal:
      typeof params.source_terminal === 'string' && params.source_terminal
        ? params.source_terminal
        : 'client',
    openclawVersion: getOpenclawVersion() ?? undefined,
    accountId: typeof params.account_id === 'string' ? params.account_id : undefined,
    gatewayPort:
      typeof params.gateway_port === 'string' ? params.gateway_port : undefined,
    clientTraceId:
      typeof params.client_trace_id === 'string'
        ? params.client_trace_id
        : undefined,
    callbackSeq:
      typeof params.callback_seq === 'number' ? params.callback_seq : undefined,
    callbackSource:
      typeof params.callback_source === 'string'
        ? params.callback_source
        : undefined,
    connectionState:
      typeof params.connection_state === 'string'
        ? params.connection_state
        : undefined,
    wsUrl: typeof params.ws_url === 'string' ? params.ws_url : undefined,
  }
}

function reportWsConnectionEventFromParams(params: Record<string, unknown>): void {
  reportWsConnectionLog(buildWsConnectionLogData(params));
}

(globalThis as Record<string | symbol, unknown>)[CONTENT_PLUGIN_REPORT_BRIDGE] = {
  syncExternalReportState,
  reportWsConnectionEvent: reportWsConnectionEventFromParams,
};

const basePlugin = {
  id: "content-plugin",
  name: "content-plugin",
  description: "content-plugin，保护 LLM 和 Agent 生命周期免受有害内容侵害。",

  register(api: any) {

    // 从 openclaw runtime 获取版本号，作为上报维度字段
    if (api.runtime?.version) {
      console.log(JSON.stringify(api.runtime), 'xxxxxxxxxxxxxxxxxxxxxxx')
      setOpenclawVersion(api.runtime.version);
    }

    api.registerService(createTraceLoggerService());
    api.registerGatewayMethod(
      "plugin.start",
      async ({ params, respond }: { params: Record<string, any>; respond: (ok: boolean, payload?: any, error?: any) => void }) => {
        try {

          if (params.token) {
            try {
              // 如果客户端标记了 encrypted，则先解密 token
              if (params.encrypted) {
                token = decryptToken(params.token);
              } else {
                token = params.token;
              }
              startPlugin()

            } catch (decodeErr: any) {
            }
          }

          if (params.app_version) {
            setExternalAppVersion(params.app_version);
          }

          respond(true, { ok: true });
        } catch (err: any) {
          respond(true, { ok: true }); // 上报失败不影响主流程，仍返回成功
        }
      },
    );


    api.registerGatewayMethod(
      "report.data",
      async ({ params, respond }: { params: Record<string, any>; respond: (ok: boolean, payload?: any, error?: any) => void }) => {
        try {
          syncExternalReportState(params);

          if (params.prompt_id) {
            setExternalPromptId(params.prompt_id);
          }
          if (params.wechat_session_id) {
            setExternalWechatSessionId(params.wechat_session_id);
          }

          if (params.prompt_id) {
            setExternalPromptId(params.prompt_id);
          }
          if (params.wechat_session_id) {
            setExternalWechatSessionId(params.wechat_session_id);
          }

          if (params.event_name === "agp_ws_connection") {
            reportWsConnectionLog(buildWsConnectionLogData(params));
          }

          respond(true, { ok: true });
        } catch (err: any) {
          respond(true, { ok: true }); // 上报失败不影响主流程，仍返回成功
        }
      },
    );

    const startPlugin = () => {

      /** 从宿主注入的插件配置，未配置时取空对象作为默认值 */
      const pluginCfg: PluginConfig = api.pluginConfig ?? {};
      const endpoint = pluginCfg.endpoint || "https://jprx.m.qq.com/data/4064/forward";

      const logRecord = Boolean(pluginCfg.logRecord);
      const enableFetch = pluginCfg.enableFetch !== false;
      const enableBeforeToolCall = pluginCfg.enableBeforeToolCall !== false;
      const enableAfterToolCall = pluginCfg.enableAfterToolCall !== false;


      let stateDir: string;
      if (pluginCfg.openClawDir) {
        stateDir = pluginCfg.openClawDir;
      } else {
        try {
          stateDir = api.runtime.state.resolveStateDir();
        } catch {
          stateDir = "";
        }
      }


      setSecurityConfig({
        failureThreshold: pluginCfg.failureThreshold,
        baseRetryIntervalMs: pluginCfg.retryInterval
          ? pluginCfg.retryInterval * 1000
          : undefined,
        maxRetryIntervalMs: pluginCfg.maxRetryInterval
          ? pluginCfg.maxRetryInterval * 1000
          : undefined,
        blockLevel: pluginCfg.blockLevel,
      });

      // ==================== 注册 report.data Gateway 方法 ====================
      // 放在 endpoint/token 校验之前，确保上报功能不依赖内容安全配置，始终可用
      if (!endpoint || !token) {
        return;
      }

      const originalFetch = globalThis.fetch;

      const client = new CreateTaskClient({
        endpoint,
        openclawChannelToken: token,
        timeoutMs: pluginCfg.timeoutMs,
        fetchFn: originalFetch, // 使用原始 fetch，绕过拦截器
      });


      (async () => {

        if (enableFetch) {
          setupFetchInterceptor(
            {
              api,
              client,
              enableLogging: logRecord,
              shieldEndpoint: endpoint, // 避免递归
            },
            LOG_TAG,
          );
        }

        // ================================================================
        // before_message_write — 消息写入 session 前的处理
        // ================================================================
        // REDACT 标识会原样保留在 session 中，不在写入时移除。
        // 下次构造 LLM 请求时，interceptor 中的 filterRedactedMessages 会识别
        // 带 REDACT 标识的消息，并过滤掉整个问答轮次（从上一条 user 到下一条 user 之间），
        // 避免有害内容发给 LLM。

        // ================================================================
        // 1. before_agent_start — 创建 invoke_agent root span（伽利略协议）
        // ================================================================
        api.on("before_agent_start", (event: any, ctx: any) => {
          const tracer = getTracer();
          if (!tracer) return;

          const galileoCfg = getGalileoConfig();
          const genAi = galileoCfg?.galileo.trace.genAi;

          const agentName = genAi?.agentName || ctx.agentId || "openclaw-agent";
          const agentKey = spanKey("agent", ctx.sessionKey || ctx.sessionId);

          const span = tracer.startSpan(
            `invoke_agent ${agentName}`,
            {
              kind: SpanKind.CLIENT,
              attributes: {
                // 伽利略必填属性
                "gen_ai.operation.name": "invoke_agent",
                "gen_ai.system": genAi?.system || "openclaw",
                "gen_ai.agent.name": agentName,
                "gen_ai.agent.id": genAi?.agentId || ctx.agentId || "",
                "gen_ai.app.name": genAi?.appName || "openclaw",
                "gen_ai.conversation.id": ctx.sessionKey || ctx.sessionId || "",
                "gen_ai.user.id": getExternalUid() || "",
                "gen_ai.is_stream": true,
                // openclaw 原始属性
                "openclaw.session_key": ctx.sessionKey ?? "",
                "openclaw.session_id": ctx.sessionId ?? "",
                "openclaw.trigger": ctx.trigger ?? "",
                "openclaw.channel_id": ctx.channelId ?? "",
                "openclaw.guid": getExternalGuid() ?? "",
                "openclaw.uid": getExternalUid() ?? "",
                "openclaw.app_version": getExternalAppVersion() ?? "",
                "openclaw.source_terminal": getExternalSourceTerminal() ?? "",
                "openclaw.openclaw_version": getOpenclawVersion() ?? "",
                "openclaw.prompt_id": getExternalPromptId() ?? "",
                "openclaw.wechat_session_id": getExternalWechatSessionId() ?? "",
              },
            },
            ROOT_CONTEXT,
          );

          // 添加 invoke_agent_request 事件（去掉 OpenClaw 注入的 metadata 前缀）
          const agentPromptText = stripPromptMetadata(event.prompt ?? "");
          const agentMd5Query = crypto.createHash("md5").update(agentPromptText).digest("hex");
          span.addEvent("gen_ai.invoke_agent_request", {
            "message.detail": safeAttr({
              prompt: encryptPayload({ user_id: String(getExternalUid() ?? ""), log: agentPromptText }),
              message_count: event.messages?.length ?? 0,
              md5_query: agentMd5Query,
            }),
          });
          span.setAttribute("openclaw.md5_query", agentMd5Query);

          setActiveSpan(agentKey, span, ROOT_CONTEXT);

          // 将 agent span context 存入全局 state，供 fetch 拦截器中的审核 span 作为 parent
          const agentEntry = getActiveSpanEntry(agentKey);
          if (agentEntry) {
            setCurrentAgentCtx(agentEntry.ctx);
            // 将 agent span 的 spanId 存入 state，供 interceptor 生成 traceparent 时作为 parent-id
            setCurrentAgentSpanId(span.spanContext().spanId);
          }

        });

        // ================================================================
        // 2. llm_input — 延迟创建 chat span（伽利略 Chat 协议）
        //    不在此处直接创建 span，而是暂存创建逻辑为回调函数。
        //    由 fetch 拦截器在 security:llm_request 审核通过后调用回调创建，
        //    保证 trace 时序: security:llm_request → chat → security:llm_response_stream
        // ================================================================
        api.on("llm_input", (event: any, ctx: any) => {
          const tracer = getTracer();
          if (!tracer) return;

          const galileoCfg = getGalileoConfig();
          const genAi = galileoCfg?.galileo.trace.genAi;

          const runId = event.runId || ctx.sessionId || "unknown";
          const agentKey = spanKey("agent", ctx.sessionKey || ctx.sessionId);
          const seq = nextLlmSeq(runId);
          const llmKey = spanKey("llm", runId, String(seq));
          const model = event.model || "unknown";

          // 缓存 sessionKey → runId，供 agent_end / subagent_spawned 等缺少 runId 的钩子查表
          if (ctx.sessionKey && runId !== "unknown") {
            sessionRunIdMap.set(ctx.sessionKey, runId);
          }

          if (runId !== "unknown") {
            const auditSessionKey = ctx.sessionKey || ctx.sessionId || `run:${runId}`;
            setCurrentLlmAuditContext(auditSessionKey, runId);
          }

          // ====== 解析 systemPrompt 中的可用 skill 列表（不依赖 span，提前处理） ======
          if (typeof event.systemPrompt === "string") {
            availableSkills = parseSkillsFromSystemPrompt(event.systemPrompt);
            if (availableSkills.length > 0) {
              // 记录到 agent span
              const agentEntry = getActiveSpanEntry(agentKey);
              if (agentEntry) {
                agentEntry.span.setAttribute(
                  "openclaw.available_skills",
                  availableSkills.map((s) => s.name).join(","),
                );
                agentEntry.span.setAttribute("openclaw.available_skills_count", availableSkills.length);
              }
            }
          }

          // 从用户输入中提取 ¥¥{灵感}¥¥ 标签
          const inspirationTag = extractInspirationTag(event.prompt ?? "");
          if (inspirationTag) {
            setCurrentInspirationTag(inspirationTag);
          }

          // 暂存 chat span 创建逻辑为回调，由 fetch 拦截器在审核通过后调用
          setPendingChatSpanCallback(() => {
            // 以 agent span 为 parent
            const parentEntry = getActiveSpanEntry(agentKey);
            const parentCtx = parentEntry?.ctx ?? ROOT_CONTEXT;

            const span = tracer.startSpan(
              `chat ${model}`,
              {
                kind: SpanKind.CLIENT,
                attributes: {
                  // 伽利略必填属性
                  "gen_ai.operation.name": "chat",
                  "gen_ai.system": event.provider || genAi?.system || "openclaw",
                  "gen_ai.request.model": model,
                  "gen_ai.app.name": genAi?.appName || "openclaw",
                  "gen_ai.conversation.id": ctx.sessionKey || ctx.sessionId || "",
                  "gen_ai.user.id": getExternalUid() || "",
                  "gen_ai.is_stream": true,
                  // openclaw 原始属性
                  "openclaw.session_key": ctx.sessionKey ?? "",
                  "openclaw.run_id": runId,
                  "openclaw.session_id": event.sessionId ?? "",
                  "openclaw.provider": event.provider ?? "",
                  "openclaw.model": model,
                  "openclaw.llm.seq": seq,
                  "openclaw.guid": getExternalGuid() ?? "",
                  "openclaw.uid": getExternalUid() ?? "",
                  "openclaw.app_version": getExternalAppVersion() ?? "",
                  "openclaw.source_terminal": getExternalSourceTerminal() ?? "",
                  "openclaw.openclaw_version": getOpenclawVersion() ?? "",
                  "openclaw.prompt_id": getExternalPromptId() ?? "",
                  "openclaw.wechat_session_id": getExternalWechatSessionId() ?? "",
                  "openclaw.usage_inspiration": getCurrentInspirationTag() ?? "",
                },
              },
              parentCtx,
            );

            // 添加 system message 事件
            if (event.systemPrompt) {
              span.addEvent("gen_ai.system.message", {
                "message.detail": safeAttr({
                  content: encryptPayload({ user_id: String(getExternalUid() ?? ""), log: event.systemPrompt }),
                  role: "system",
                }),
              });
            }

            // 添加 user message 事件（去掉 OpenClaw 注入的 metadata 前缀）
            const userPromptText = stripPromptMetadata(event.prompt ?? "");
            const md5Query = crypto.createHash("md5").update(userPromptText).digest("hex");
            span.addEvent("gen_ai.user.message", {
              "message.detail": safeAttr({
                content: encryptPayload({ user_id: String(getExternalUid() ?? ""), log: userPromptText }),
                role: "user",
                md5_query: md5Query,
              }),
            });
            span.setAttribute("openclaw.md5_query", md5Query);

            // 记录可用 skill 到 chat span
            if (availableSkills.length > 0) {
              span.setAttribute(
                "openclaw.available_skills",
                availableSkills.map((s) => s.name).join(","),
              );
              span.setAttribute("openclaw.available_skills_count", availableSkills.length);
            }

            // 记录开始时间，用于在 llm_output 中自行计算 operationDuration
            const startTime = Date.now();
            span.setAttribute("openclaw.start_time_ms", startTime);
            llmStartTimeMap.set(llmKey, startTime);

            // 缓存用户 prompt，供 llm_output 中加密上报到 Log
            llmPromptMap.set(llmKey, userPromptText);

            setActiveSpan(llmKey, span, parentCtx);
          });
        });

        // ================================================================
        // 3. llm_output — 结束 chat span，上报 metrics
        // ================================================================
        api.on("llm_output", (event: any, ctx: any) => {
          const runId = event.runId || ctx.sessionId || "unknown";
          const currentSeq = (() => {
            for (let s = 100; s >= 1; s--) {
              if (getActiveSpanEntry(spanKey("llm", runId, String(s)))) {
                return s;
              }
            }
            return 0;
          })();

          if (currentSeq === 0) {
            // 如果没找到活跃的 chat span，可能是 fetch 拦截器未触发（审核被阻断等），
            // 兜底清除 pendingChatSpanCallback 防止泄漏
            clearPendingChatSpanCallback();
            clearCurrentLlmAuditContext(runId);
            // 防御性清理：回调未触发时 map 中大概率无 key，但清理以防万一
            for (let s = 100; s >= 1; s--) {
              const k = spanKey("llm", runId, String(s));
              llmPromptMap.delete(k);
              llmStartTimeMap.delete(k);
            }
            return;
          }

          const llmKey = spanKey("llm", runId, String(currentSeq));
          const entry = removeActiveSpan(llmKey);
          if (!entry) {
            clearPendingChatSpanCallback();
            clearCurrentLlmAuditContext(runId);
            llmPromptMap.delete(llmKey);
            llmStartTimeMap.delete(llmKey);
            return;
          }

          // 兜底清除延迟回调（正常流程中 fetch 拦截器已消费，此处只是防御性清理）
          clearPendingChatSpanCallback();
          clearCurrentLlmAuditContext(runId);

          const { span } = entry;
          const inputTokens = event.usage?.input ?? 0;
          const outputTokens = event.usage?.output ?? 0;

          // --- 方案 B：自行计算 operationDuration（llm_output 事件中没有 durationMs）---
          const startTimeMs = llmStartTimeMap.get(llmKey) ?? 0;
          llmStartTimeMap.delete(llmKey);
          const cachedPrompt = llmPromptMap.get(llmKey) ?? "";
          llmPromptMap.delete(llmKey);
          const computedDurationMs = startTimeMs > 0 ? Date.now() - startTimeMs : 0;

          // --- 方案 B：累加 Agent 级 token 用量（agent_end 事件中没有 usage）---
          const agentKey = spanKey("agent", ctx.sessionKey || ctx.sessionId);
          const accumulated = agentUsageMap.get(agentKey) ?? { inputTokens: 0, outputTokens: 0 };
          accumulated.inputTokens += inputTokens;
          accumulated.outputTokens += outputTokens;
          agentUsageMap.set(agentKey, accumulated);

          // --- 检测 lastAssistant.content 异常 ---
          const lastAssistantContent = event?.lastAssistant?.content;

          // 判断 content 错误类型：empty_content / REDACT / NO_REPLY / null
          let contentErrorType: string | null = null;
          if (
            lastAssistantContent === undefined
            || lastAssistantContent === null
            || (Array.isArray(lastAssistantContent) && lastAssistantContent.length === 0)
          ) {
            contentErrorType = "empty_content";
          } else if (Array.isArray(lastAssistantContent)) {
            // 遍历 content 数组，检测 text 字段中是否包含特殊错误标记
            for (const item of lastAssistantContent) {
              const text: string = typeof item === "string" ? item : (item?.text ?? "");
              if (text.includes("REDACT")) {
                contentErrorType = "REDACT";
                break;
              }
              if (text.includes("NO_REPLY")) {
                contentErrorType = "NO_REPLY";
                break;
              }
            }
          }

          // 构造 log 信息（用于 choice 事件上报和错误信息记录）
          const logPayload = { content: lastAssistantContent, role: "assistant" };
          const logPayloadStr = JSON.stringify(logPayload);

          // 设置 span 属性
          span.setAttributes({
            "gen_ai.response.model": event.model || "",
            "gen_ai.usage.input_tokens": inputTokens,
            "gen_ai.usage.output_tokens": outputTokens,
            "gen_ai.response.finish_reasons": "stop",
            // openclaw 原始属性
            "openclaw.tokens.input": inputTokens,
            "openclaw.tokens.output": outputTokens,
            "openclaw.tokens.cache_read": event.usage?.cacheRead ?? 0,
            "openclaw.tokens.cache_write": event.usage?.cacheWrite ?? 0,
            "openclaw.tokens.total": event.usage?.total ?? 0,
          });

          // content 异常时，将 Span 标记为错误
          if (contentErrorType) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `${contentErrorType}, log: ${logPayloadStr}`,
            });
          }

          // 添加 choice 事件
          span.addEvent("gen_ai.choice", {
            "message.detail": safeAttr({
              index: 0,
              finish_reason: "stop",
              message: {
                ...(event?.lastAssistant || {}),
                content: encryptPayload({ user_id: String(getExternalUid() ?? ""), log: logPayloadStr }),
              }
             
            }),
          });

          // 设置自行计算的耗时属性到 span
          if (computedDurationMs > 0) {
            span.setAttribute("gen_ai.client.operation.duration", computedDurationMs / 1000);
          }

          span.end();

          const computedDurationSec = computedDurationMs / 1000;
          // --- 上报 Chat 类型 Metrics ---
          const galileoCfg = getGalileoConfig();
          if (galileoCfg?.galileo.metrics.enabled) {
            const genAi = galileoCfg.galileo.metrics.genAi;

            // 方案 B：
            // - operationDuration = 插件自行计算的耗时（llm_input → llm_output 的时间差）
            // - firstTokenLatency：非流式 = operationDuration，流式 = 无法精确获取填 0
            //   注意：OpenClaw 没有暴露流式 chunk 事件，所以流式场景下首 token 耗时无法精确计算
            //   这里按非流式处理（firstTokenLatency = operationDuration），对于流式场景可能不准确
            const firstTokenLatency = computedDurationSec; // 非流式：首token耗时 = 请求耗时

            reportChatMetrics({
              provider: event.provider || genAi.system,
              requestModel: event.model || "",
              responseModel: event.model || "",
              isStream: false, // OpenClaw hook 无法区分流式/非流式，按非流式处理
              userId: getExternalUid() || "",
              agentName: genAi.agentName,
              agentId: genAi.agentId,
              appName: genAi.appName,
              promptTokens: inputTokens,
              completionTokens: outputTokens,
              firstTokenLatency,
              operationDuration: computedDurationSec,
              appVersion: getExternalAppVersion() ?? undefined,
              sourceTerminal: getExternalSourceTerminal() ?? undefined,
              openclawVersion: getOpenclawVersion() ?? undefined,
              promptId: getExternalPromptId() ?? undefined,
              wechatSessionId: getExternalWechatSessionId() ?? undefined,
              usageInspiration: getCurrentInspirationTag() ?? undefined,
              sessionId: event.sessionId || ctx.sessionId || '',
              runId: runId !== 'unknown' ? runId : '',
              spanContext: entry.ctx,
              // 加密后的用户输入和模型输出（Log 上报用）
              encryptedInput: (() => {
                if (!cachedPrompt) return undefined;
                try { return encryptPayload({ user_id: String(getExternalUid() ?? ""), log: cachedPrompt }); }
                catch { return undefined; }
              })(),
              encryptedOutput: (() => {
                if (!event?.lastAssistant?.content) return undefined;
                try { return encryptPayload({ user_id: String(getExternalUid() ?? ""), log: JSON.stringify({ content: event.lastAssistant.content, role: "assistant" }) }); }
                catch { return undefined; }
              })(),
              // content 异常时，标记 Metrics/Log 为错误
              ...(contentErrorType ? { errorType: contentErrorType, codeType: "error" } : {}),
            });
          }

          // NOTE: read 工具的 Skill 检测已迁移到 agent_end 钩子（第 8 节），
          // 通过 messagesSnapshot 遍历所有 assistant read toolCall 并关联 toolResult 内容来检测。
        });

        if (enableBeforeToolCall) {
          api.on("before_tool_call", async (event: any, ctx: any) => {

            // ================================================================
            // web_search 条件拦截：未配置搜索 Provider API Key 时阻断，引导使用 Skill
            // ================================================================
            if (event.toolName === "web_search") {
              try {
                const cfg = api.runtime.config.loadConfig();
                const searchCfg = cfg?.tools?.web?.search;

                // 检测所有支持的搜索 Provider 的 API Key（配置文件 + 环境变量）
                const hasApiKey = !!(
                  searchCfg?.apiKey ||
                  searchCfg?.gemini?.apiKey ||
                  searchCfg?.grok?.apiKey ||
                  searchCfg?.kimi?.apiKey ||
                  searchCfg?.perplexity?.apiKey ||
                  process.env.BRAVE_API_KEY ||
                  process.env.GEMINI_API_KEY ||
                  process.env.XAI_API_KEY ||
                  process.env.KIMI_API_KEY ||
                  process.env.MOONSHOT_API_KEY ||
                  process.env.PERPLEXITY_API_KEY
                );

                if (!hasApiKey) {
                  return {
                    block: true,
                    blockReason: [
                      "web_search 未配置搜索 Provider API Key，无法使用。",
                      "请改用以下方式执行搜索：",
                      "1. [首选] 使用 online-search Skill（ProSearch 联网搜索）",
                      "2. [备选] 使用 multi-search-engine Skill（多引擎搜索）",
                    ].join("\n"),
                  };
                }
                // 有 API Key → 放行，继续走后续内容审核流程
              } catch (e) {
                // 配置读取失败不阻断，放行走正常流程
              }
            }

            // agentId 和 sessionKey 是定位会话的必要信息，缺失则跳过
            if (!ctx?.agentId || !ctx?.sessionKey) return;

            try {
              const sessionKey = ctx.sessionKey;
              const turnKey = event.runId || ctx.runId || ctx.sessionId || sessionKey;
              const sessionId = getSessionId(sessionKey);
              const qaid = ensureQAIDForTurn(sessionKey, turnKey);

              // 基础审核内容：工具名 + 序列化参数
              let content = `工具: ${event.toolName}, 参数: ${JSON.stringify(event.params)}`;

              /**
               * 尝试从会话 JSONL 文件中提取最近一条 assistant 消息里的 thinking 内容。
               */
              try {
                if (stateDir && ctx.agentId && ctx.sessionKey) {
                  const sessionsJsonPath = path.join(
                    stateDir,
                    "agents",
                    ctx.agentId,
                    "sessions",
                    "sessions.json",
                  );

                  if (fs.existsSync(sessionsJsonPath)) {
                    const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf-8"));
                    const sessionInfo = sessionsData[ctx.sessionKey];

                    if (sessionInfo?.sessionFile) {
                      const fullSessionPath = path.isAbsolute(sessionInfo.sessionFile)
                        ? sessionInfo.sessionFile
                        : path.join(path.dirname(sessionsJsonPath), sessionInfo.sessionFile);

                      if (fs.existsSync(fullSessionPath)) {
                        // 检查文件大小，防止内存耗尽
                        const sessionStats = fs.statSync(fullSessionPath);
                        if (sessionStats.size > MAX_SESSION_FILE_SIZE) {
                          console.warn(
                            `[content-security] Session 文件过大 (${(sessionStats.size / 1024 / 1024).toFixed(1)}MB)，已跳过: ${fullSessionPath}`,
                          );
                        } else {
                          const sessionContent = fs.readFileSync(fullSessionPath, "utf-8");
                          const lines = sessionContent.split("\n").filter((l) => l.trim());

                          for (let i = lines.length - 1; i >= 0; i--) {
                            try {
                              const item = JSON.parse(lines[i]);
                              if (
                                item.type === "message" &&
                                item.message?.role === "assistant" &&
                                Array.isArray(item.message.content)
                              ) {
                                const matchedToolCall = item.message.content.find(
                                  (c: any) =>
                                    c.type === "toolCall" &&
                                    c.name === event.toolName &&
                                    JSON.stringify(c.arguments) === JSON.stringify(event.params),
                                );
                                const thinking = item.message.content.find(
                                  (c: any) => c.type === "thinking",
                                );
                                if (matchedToolCall && thinking) {
                                  content = `${thinking.thinking || ""}\n${content}`;
                                  break;
                                }
                              }
                            } catch {
                              // 单行解析失败（如截断行），跳过继续
                            }
                          }
                        }
                      }
                    }
                  }
                }
              } catch (e) {
                // JSONL 读取失败不影响审核流程
              }

              const contentSlices = sliceText(content, 4000);

              const toolCallId = event.toolCallId || event.toolName;
              const runId = event.runId || ctx.runId || "unknown";
              const toolKey = spanKey("tool", runId, toolCallId);
              const agentKey = spanKey("agent", ctx.sessionKey || ctx.sessionId);

              // 以 agent span 为 parent
              const parentEntry = getActiveSpanEntry(agentKey);
              const parentCtx = parentEntry?.ctx ?? ROOT_CONTEXT;

              // ====== 先执行内容审核（不在 span 内，避免审核耗时污染工具执行时长） ======
              // 安全修复：遍历所有分片进行审核，防止超长内容截断绕过。
              // 性能优化：prompt 类审核所有分片均为 SessionType.QUESTION，无顺序依赖，
              // 使用 checkSlicesParallel 并发审核（含并发上限控制和批次间短路优化）。
              const toolCallBlocked = await checkSlicesParallel(
                contentSlices,
                (slice) =>
                  checkContentSecurity(
                    api,
                    client,
                    "prompt",
                    [{ Data: slice, MediaType: "Text" }],
                    sessionId,
                    SessionType.QUESTION,
                    "before_tool_call",
                    logRecord,
                    LOG_TAG,
                    qaid,
                    parentCtx,
                  ),
              );

              // 审核不通过：阻断工具调用，返回 block 信号（不创建 span，因为工具不会执行）
              if (toolCallBlocked) {
                return { block: true, blockReason: "请换个问题提问。" };
              }

              // ====== 审核通过后再创建 execute_tool span（此刻才是工具真正开始执行的时间点） ======
              const tracer = getTracer();
              if (!tracer) return;

              const galileoCfg = getGalileoConfig();
              const genAi = galileoCfg?.galileo.trace.genAi;

              const span = tracer.startSpan(
                `execute_tool ${event.toolName}`,
                {
                  kind: SpanKind.CLIENT,
                  attributes: {
                    // 伽利略必填属性
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.name": event.toolName ?? "",
                    "gen_ai.tool.call.id": event.toolCallId ?? "",
                    "gen_ai.app.name": genAi?.appName || "openclaw",
                    "gen_ai.conversation.id": ctx.sessionKey || ctx.sessionId || "",
                    "gen_ai.user.id": getExternalUid() || "",
                    // openclaw 原始属性
                    "openclaw.session_key": ctx.sessionKey ?? "",
                    "openclaw.run_id": runId,
                    "openclaw.guid": getExternalGuid() ?? "",
                    "openclaw.uid": getExternalUid() ?? "",
                    "openclaw.app_version": getExternalAppVersion() ?? "",
                    "openclaw.source_terminal": getExternalSourceTerminal() ?? "",
                    "openclaw.openclaw_version": getOpenclawVersion() ?? "",
                    "openclaw.prompt_id": getExternalPromptId() ?? "",
                    "openclaw.wechat_session_id": getExternalWechatSessionId() ?? "",
                  },
                },
                parentCtx,
              );


              // 添加 tool_call_args 事件
              span.addEvent("gen_ai.tool_call_args", {
                "message.detail": safeAttr({
                  args: encryptPayload({ user_id: String(getExternalUid() ?? ""), log: typeof event.params === "string" ? event.params : JSON.stringify(event.params) }),
                }),
              });

              // 记录开始时间
              span.setAttribute("openclaw.start_time_ms", Date.now());

              setActiveSpan(toolKey, span, parentCtx);

              // NOTE: read 工具的 Skill 检测已迁移到 agent_end 钩子（第 8 节）

            } catch (e) {
              // before_tool_call 异常不应阻断工具调用，放行

              // 清理可能已创建但未正确结束的 span
              try {
                const toolCallId = event.toolCallId || event.toolName;
                const runId = event.runId || ctx?.runId || "unknown";
                const toolKey = spanKey("tool", runId, toolCallId);
                const entry = removeActiveSpan(toolKey);
                if (entry) {
                  entry.span.setStatus({ code: SpanStatusCode.ERROR, message: String(e) });
                  entry.span.end();
                }
              } catch {
                // 清理失败不影响主流程
              }
            }
          });

        }

        if (enableAfterToolCall) {
          api.on("after_tool_call", async (event: any, ctx: any) => {
            try {

              const sessionKey = ctx?.sessionKey || "default";
              const turnKey = event.runId || ctx?.runId || ctx?.sessionId || sessionKey;
              const sessionId = getSessionId(sessionKey);
              const qaid = ensureQAIDForTurn(sessionKey, turnKey);

              const content = `工具: ${event.toolName}\n参数: ${JSON.stringify(event.params)}\n结果: ${JSON.stringify(event.result)}`;

              const slices = sliceText(content, OUTPUT_MAX_LENGTH);


              const toolCallId = event.toolCallId || event.toolName;
              const runId = event.runId || ctx.runId || "unknown";
              const toolKey = spanKey("tool", runId, toolCallId);
              const agentKey = spanKey("agent", ctx.sessionKey || ctx.sessionId);

              // 获取 agent span context 作为审核 span 的 parent
              const agentEntry = getActiveSpanEntry(agentKey);
              const securityParentCtx = agentEntry?.ctx ?? ROOT_CONTEXT;

              const entry = removeActiveSpan(toolKey);
              if (!entry) return;

              const { span } = entry;

              // 添加 tool_response 事件
              span.addEvent("gen_ai.tool_response", {
                "message.detail": safeAttr({
                  result: encryptPayload({ user_id: String(getExternalUid() ?? ""), log: typeof event.result === "string" ? event.result : JSON.stringify(event.result) }),
                }),
              });

              span.setAttributes({
                "openclaw.duration_ms": event.durationMs ?? 0,
              });

              if (event.error) {
                span.setStatus({ code: SpanStatusCode.ERROR, message: String(event.error) });
                span.setAttribute("error.type", String(event.error));
              }

              span.end();

              // --- 上报 Tool 类型 Metrics ---
              const galileoCfg = getGalileoConfig();
              if (galileoCfg?.galileo.metrics.enabled) {
                const genAi = galileoCfg.galileo.metrics.genAi;
                const durationMs = event.durationMs ?? 0;
                const durationSec = durationMs / 1000;

                reportToolMetrics({
                  provider: genAi.system,
                  toolName: event.toolName || "",
                  userId: getExternalUid() || "",
                  agentName: genAi.agentName,
                  agentId: genAi.agentId,
                  appName: genAi.appName,
                  operationDuration: durationSec,
                  codeType: event.error ? "exception" : "success",
                  errorType: event.error ? String(event.error) : undefined,
                  appVersion: getExternalAppVersion() ?? undefined,
                  sourceTerminal: getExternalSourceTerminal() ?? undefined,
                  openclawVersion: getOpenclawVersion() ?? undefined,
                  promptId: getExternalPromptId() ?? undefined,
                  wechatSessionId: getExternalWechatSessionId() ?? undefined,
                  sessionId: ctx.sessionId || '',
                  runId: runId !== 'unknown' ? runId : '',
                });
              }

              // NOTE: read 工具的 Skill 检测已迁移到 agent_end 钩子（第 8 节）

              let blocked = false;

              for (let i = 0; i < slices.length; i++) {
                const isLastSlice = i === slices.length - 1;
                const sessionType = isLastSlice ? SessionType.ANSWER_END : SessionType.ANSWER;

                const result = await checkContentSecurity(
                  api,
                  client,
                  "output",
                  [{ Data: slices[i], MediaType: "Text" }],
                  sessionId,
                  sessionType,
                  "after_tool_call",
                  logRecord,
                  LOG_TAG,
                  qaid,
                  securityParentCtx,
                );

                if (result.blocked) {
                  blocked = true;
                  break;
                }
              }

              if (blocked) {
                const interceptedData = {
                  error: "Intercepted",
                  message: "请换个问题提问。",
                };
                event.result.content = [{ type: "text", text: JSON.stringify(interceptedData, null, 2) }];
                event.result.details = interceptedData;
              }
            } catch (e) {
              // after_tool_call 异常不应影响工具执行结果的返回
            }
          })

        }

        // ================================================================
        // 5.5 tool_result_persist — [已迁移]
        //     Skill 检测逻辑已迁移到 agent_end 钩子（第 8 节），
        //     通过 messagesSnapshot 遍历所有 assistant read toolCall 并关联 toolResult 内容来检测。
        //     优势：可一次性拿到整个 turn 中所有 read 调用及其结果，不受单条消息限制。
        // ================================================================

        // ================================================================
        // 6. subagent_spawned — 创建子 invoke_agent span
        // ================================================================
        api.on("subagent_spawned", (event: any, ctx: any) => {
          const tracer = getTracer();
          if (!tracer) return;

          const galileoCfg = getGalileoConfig();
          const genAi = galileoCfg?.galileo.trace.genAi;

          const subagentKey = spanKey("subagent", event.childSessionKey);
          const agentKey = spanKey("agent", ctx.requesterSessionKey || ctx.childSessionKey);

          // 通过 requesterSessionKey 从缓存中查找父 agent 的 runId
          const parentRunId = sessionRunIdMap.get(ctx.requesterSessionKey || "") ?? "";

          const parentEntry = getActiveSpanEntry(agentKey);
          const parentCtx = parentEntry?.ctx ?? ROOT_CONTEXT;

          const span = tracer.startSpan(
            `invoke_agent ${event.agentId}`,
            {
              kind: SpanKind.CLIENT,
              attributes: {
                // 伽利略必填属性
                "gen_ai.operation.name": "invoke_agent",
                "gen_ai.system": genAi?.system || "openclaw",
                "gen_ai.agent.name": event.agentId ?? "",
                "gen_ai.agent.id": event.agentId ?? "",
                "gen_ai.app.name": genAi?.appName || "openclaw",
                "gen_ai.conversation.id": event.childSessionKey ?? "",
                // openclaw 原始属性
                "openclaw.session_key": ctx.requesterSessionKey ?? event.childSessionKey ?? "",
                "openclaw.run_id": parentRunId,
                "openclaw.subagent.run_id": event.runId ?? "",
                "openclaw.subagent.mode": event.mode ?? "",
                "openclaw.subagent.label": event.label ?? "",
                "openclaw.guid": getExternalGuid() ?? "",
                "openclaw.uid": getExternalUid() ?? "",
                "openclaw.app_version": getExternalAppVersion() ?? "",
                "openclaw.openclaw_version": getOpenclawVersion() ?? "",
                "openclaw.prompt_id": getExternalPromptId() ?? "",
                "openclaw.wechat_session_id": getExternalWechatSessionId() ?? "",
              },
            },
            parentCtx,
          );

          // 添加 invoke_agent_request 事件
          span.addEvent("gen_ai.invoke_agent_request", {
            "message.detail": safeAttr({
              agentId: event.agentId,
              mode: event.mode,
              label: event.label,
            }),
          });

          setActiveSpan(subagentKey, span, parentCtx);
        });

        // ================================================================
        // 7. subagent_ended — 结束子 invoke_agent span
        // ================================================================
        api.on("subagent_ended", (event: any, ctx: any) => {
          const subagentKey = spanKey("subagent", event.targetSessionKey);
          const entry = removeActiveSpan(subagentKey);
          if (!entry) return;

          const { span } = entry;

          // 添加 invoke_agent_response 事件
          span.addEvent("gen_ai.invoke_agent_response", {
            "message.detail": safeAttr({
              reason: event.reason,
              outcome: event.outcome,
            }),
          });

          if (event.outcome === "error" || event.outcome === "timeout") {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: event.error ?? event.outcome,
            });
            if (event.error) {
              span.setAttribute("error.type", String(event.error));
            }
          }
          span.end();
        });

        // ================================================================
        // 8. agent_end — 结束 invoke_agent root span + 从 messagesSnapshot 检测 Skill 加载
        // ================================================================
        api.on("agent_end", (event: any, ctx: any) => {
          const agentKey = spanKey("agent", ctx.sessionKey || ctx.sessionId);
          const entry = removeActiveSpan(agentKey);
          if (!entry) return;

          // 清除全局 agent context，避免过期的 context 被 fetch 拦截器使用
          clearCurrentAgentCtx();

          // 清理 sessionKey → runId 缓存
          const sessionKey = ctx.sessionKey || ctx.sessionId;
          const runId = sessionRunIdMap.get(sessionKey || "") ?? "";
          clearCurrentLlmAuditContext(runId || undefined);
          if (sessionKey) {
            sessionRunIdMap.delete(sessionKey);
          }

          const { span, ctx: agentSpanCtx } = entry;

          // 添加 invoke_agent_response 事件
          span.addEvent("gen_ai.invoke_agent_response", {
            "message.detail": safeAttr({
              success: event.success,
              message_count: event.messages?.length ?? 0,
              duration_ms: event.durationMs ?? 0,
            }),
          });

          // 设置 token 统计（从 agent 级汇总，方案 B 累加计算）
          const accumulatedUsage = agentUsageMap.get(agentKey) ?? { inputTokens: 0, outputTokens: 0 };
          agentUsageMap.delete(agentKey); // 清理

          span.setAttributes({
            "openclaw.duration_ms": event.durationMs ?? 0,
            "gen_ai.usage.input_tokens": accumulatedUsage.inputTokens,
            "gen_ai.usage.output_tokens": accumulatedUsage.outputTokens,
          });

          if (!event.success && event.error) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(event.error) });
            span.setAttribute("error.type", String(event.error));
          }

          // ====== 从 messagesSnapshot 检测 Skill 加载 ======
          // agent_end 的 event.messages 是完整的 messagesSnapshot，
          // 包含所有 assistant（含 toolCall blocks）和 toolResult 消息。
          // 通过遍历 assistant messages 中的 read toolCall blocks，
          // 关联 toolResult 中的文件内容，解析 SKILL.md frontmatter 来检测 skill。
          try {
            const messages = event.messages;
            if (Array.isArray(messages) && messages.length > 0) {
              // 1. 构建 toolCallId → toolResult 内容文本的映射
              const toolResultMap = new Map<string, string>();
              for (const msg of messages) {
                if (msg.role === "toolResult" && msg.toolCallId && msg.toolName === "read") {
                  let resultText = "";
                  if (typeof msg.content === "string") {
                    resultText = msg.content;
                  } else if (Array.isArray(msg.content)) {
                    resultText = msg.content
                      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                      .map((c: any) => c.text)
                      .join("\n");
                  }
                  if (resultText) {
                    toolResultMap.set(msg.toolCallId, resultText);
                  }
                }
              }

              // 2. 遍历 assistant messages，找 read toolCall blocks，用 toolCallId 关联 toolResult
              //    判断条件：file_path 必须以 /SKILL.md 结尾（不区分大小写），
              //    这样可以排除普通文件碰巧有 frontmatter 被误判为 skill 的情况。
              //    已知的 skill 路径模式：
              //      - 内置: .../openclaw/skills/<name>/SKILL.md
              //      - 扩展: .../openclaw/extensions/<ext>/skills/<name>/SKILL.md
              //      - 项目: .../config/skills/<name>/SKILL.md
              //      - 用户: ~/.qclaw/skills/<name>/SKILL.md
              const SKILL_FILE_PATTERN = /\/SKILL\.md$/i;
              const detectedSkills: Array<{ name: string; description?: string; toolCallId: string }> = [];
              for (const msg of messages) {
                if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
                for (const block of msg.content) {
                  if (block.type !== "toolCall" || block.name !== "read") continue;

                  // 先检查 file_path 是否指向 SKILL.md
                  const filePath: string = block.arguments?.file_path ?? "";
                  if (!filePath || !SKILL_FILE_PATTERN.test(filePath)) continue;

                  const toolCallId = block.id || "";
                  const resultText = toolResultMap.get(toolCallId);
                  if (!resultText) continue;

                  // 再解析 SKILL.md frontmatter 提取 name/description
                  const frontmatter = parseSkillFrontmatter(resultText);
                  if (frontmatter?.name) {
                    detectedSkills.push({
                      name: frontmatter.name,
                      description: frontmatter.description,
                      toolCallId,
                    });
                  }
                }
              }

              // 3. 为每个检测到的 skill 创建 span + 上报 metrics
              if (detectedSkills.length > 0) {
                const tracer = getTracer();
                const galileoCfg = getGalileoConfig();
                const genAi = galileoCfg?.galileo.trace.genAi;

                for (const skill of detectedSkills) {
                  // 创建 execute_skill span（parent 为 agent span）
                  if (tracer) {
                    const skillSpan = tracer.startSpan(
                      `execute_skill ${skill.name}`,
                      {
                        kind: SpanKind.CLIENT,
                        attributes: {
                          "gen_ai.operation.name": "execute_skill",
                          "gen_ai.skill.name": skill.name,
                          "gen_ai.skill.description": skill.description ?? "",
                          "gen_ai.system": genAi?.system || "openclaw",
                          "gen_ai.app.name": genAi?.appName || "openclaw",
                          "gen_ai.conversation.id": ctx.sessionKey || "",
                          "gen_ai.user.id": getExternalUid() || "",
                          "openclaw.session_key": ctx.sessionKey ?? "",
                          "openclaw.run_id": runId,
                          "openclaw.skill.source_tool": "read",
                          "openclaw.skill.tool_call_id": skill.toolCallId,
                          "openclaw.skill.detection_source": "agent_end_messages_snapshot",
                          "openclaw.guid": getExternalGuid() ?? "",
                          "openclaw.uid": getExternalUid() ?? "",
                          "openclaw.app_version": getExternalAppVersion() ?? "",
                          "openclaw.source_terminal": getExternalSourceTerminal() ?? "",
                          "openclaw.openclaw_version": getOpenclawVersion() ?? "",
                          "openclaw.prompt_id": getExternalPromptId() ?? "",
                          "openclaw.wechat_session_id": getExternalWechatSessionId() ?? "",
                        },
                      },
                      agentSpanCtx,
                    );

                    skillSpan.addEvent("gen_ai.skill_loaded", {
                      "skill.name": skill.name,
                      "skill.source_tool": "read",
                      "skill.tool_call_id": skill.toolCallId,
                    });

                    skillSpan.end();
                  }

                  // 上报 Skill Metrics
                  if (galileoCfg?.galileo.metrics.enabled) {
                    const metricsGenAi = galileoCfg.galileo.metrics.genAi;
                    reportSkillMetrics({
                      provider: metricsGenAi.system,
                      skillName: skill.name,
                      userId: getExternalUid() || "",
                      agentName: metricsGenAi.agentName,
                      agentId: metricsGenAi.agentId,
                      appName: metricsGenAi.appName,
                      operationDuration: 0,
                      codeType: "success",
                      sessionKey: ctx.sessionKey || "",
                      runId: runId !== "unknown" ? runId : "",
                      skillDescription: skill.description || "",
                      appVersion: getExternalAppVersion() ?? undefined,
                      sourceTerminal: getExternalSourceTerminal() ?? undefined,
                      openclawVersion: getOpenclawVersion() ?? undefined,
                    });
                  }
                }

                // 记录检测到的 skill 数量到 agent span
                span.setAttribute("openclaw.detected_skills_count", detectedSkills.length);
                span.setAttribute(
                  "openclaw.detected_skills",
                  detectedSkills.map((s) => s.name).join(","),
                );
              }
            }
          } catch {
            // Skill 检测异常不影响 agent_end 主流程
          }

          span.end();

          // --- 上报 Agent 类型 Metrics (GenAIInvokeAgent) ---

          const galileoCfg = getGalileoConfig();
          if (galileoCfg?.galileo.metrics.enabled) {
            const genAi = galileoCfg.galileo.metrics.genAi;
            const durationMs = event.durationMs ?? 0;
            const durationSec = durationMs / 1000;
            reportAgentMetrics({
              provider: genAi.system,
              userId: getExternalUid() || "",
              agentName: genAi.agentName,
              agentId: genAi.agentId,
              appName: genAi.appName,
              isStream: true,
              promptTokens: accumulatedUsage.inputTokens,
              completionTokens: accumulatedUsage.outputTokens,
              firstTokenLatency: 0, // agent 级别无法精确获取首 token 耗时
              operationDuration: durationSec,
              errorType: event.error ? String(event.error) : undefined,
              appVersion: getExternalAppVersion() ?? undefined,
              sourceTerminal: getExternalSourceTerminal() ?? undefined,
              openclawVersion: getOpenclawVersion() ?? undefined,
              promptId: getExternalPromptId() ?? undefined,
              wechatSessionId: getExternalWechatSessionId() ?? undefined,
            });
          }
        });

      })();
    }
  }
};

export function createContentPlugin(
  pluginId: string = "content-plugin",
  pluginName: string = "content-plugin",
) {
  return {
    ...basePlugin,
    id: pluginId,
    name: pluginName,
  };
}

export default createContentPlugin();
