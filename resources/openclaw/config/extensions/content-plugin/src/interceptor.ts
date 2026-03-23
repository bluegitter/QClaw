import { SessionType } from "./types";
import type { InterceptorConfig } from "./types";
import {
  extractLastUserMessage,
  extractAssistantContent,
  sliceText,
  checkSlicesParallel,
  generateTraceparent,
  generateTraceId,
} from "./utils";
import { stripPromptMetadata } from "./service";
import { checkContentSecurity } from "./security";
import {
  getSessionId,
  ensureQAIDForTurn,
  isSessionBlocked,
  clearSessionBlocked,
  addBlockedContent,
  sanitizeMessages,
} from "./session";
import {
  getExternalTraceId,
  getCurrentAgentCtx,
  getCurrentAgentSpanId,
  getCurrentLlmAuditContext,
  consumePendingChatSpanCallback,
} from "./state";


const PROMPT_MAX_LENGTH = 4000;

const OUTPUT_MAX_LENGTH = 120;

// ==================== 拦截器全局状态管理 ====================

const FETCH_INTERCEPTOR_STATE = Symbol.for("openclaw.contentSecurity.fetchInterceptorState");

interface FetchInterceptorState {
  installed: boolean;
  setupAttempts: number;
  triggerCount: number;
  llmRequestCount: number;
  outputAuditEndCount: number;
}

type GlobalWithFetchInterceptorState = typeof globalThis & {
  [FETCH_INTERCEPTOR_STATE]?: FetchInterceptorState;
};

const getFetchInterceptorState = (): FetchInterceptorState => {
  const globalState = globalThis as GlobalWithFetchInterceptorState;
  if (!globalState[FETCH_INTERCEPTOR_STATE]) {
    globalState[FETCH_INTERCEPTOR_STATE] = {
      installed: false,
      setupAttempts: 0,
      triggerCount: 0,
      llmRequestCount: 0,
      outputAuditEndCount: 0,
    };
  }
  return globalState[FETCH_INTERCEPTOR_STATE]!;
};

const logInterceptorDebug = (phase: string, data: Record<string, unknown>): void => {
  console.log(`[content-security] ${phase}`, data);
};
// ==================== 日志工具 ====================

// ==================== REDACT 区间过滤 ====================

/** 检测消息内容中是否包含 <!--REDACT--> 标识 */
const messageHasRedact = (msg: any): boolean => {
  if (!msg) return false;
  if (typeof msg.content === "string") {
    return msg.content.includes("<!--REDACT-->");
  }
  if (Array.isArray(msg.content)) {
    return msg.content.some(
        (part: any) => part.type === "text" && typeof part.text === "string" && part.text.includes("<!--REDACT-->"),
    );
  }
  return false;
};

const filterRedactedMessages = (messages: any[]): any[] => {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // 标记需要移除的索引
  const indicesToRemove = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (!messageHasRedact(messages[i])) continue;

    // 找到该消息向前最近的 user 消息（含自身）
    let rangeStart = i;
    for (let j = i; j >= 0; j--) {
      if (messages[j].role === "user") {
        rangeStart = j;
        break;
      }
    }

    // 找到该消息向后下一条 user 消息（不含）
    let rangeEnd = messages.length; // 默认到末尾
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === "user") {
        rangeEnd = j;
        break;
      }
    }

    // 标记区间内所有消息为需要移除
    for (let j = rangeStart; j < rangeEnd; j++) {
      indicesToRemove.add(j);
    }
  }

  if (indicesToRemove.size === 0) return messages;

  return messages.filter((_, idx) => !indicesToRemove.has(idx));
};

// ==================== 外部安全插件拒绝话术检测 ====================

const EXTERNAL_BLOCK_PATTERNS: RegExp[] = [
  /安全系统拦截/,
  /安全策略/,
  /敏感内容[，,].*无法响应/,
  /无法回应.*请求/,
  /信息存在敏感内容/,
  /因安全原因.*拦截/,
  /消息.*被.*拦截/,
  /违反.*安全/,
  /内容审核.*未通过/,
  /输入.*不合规/,
  /安全原因.*无法/,
  /无法.*处理.*请求/,
  /涉及敏感/,
  /不当内容/,
  /不适当.*内容/,
];

const isExternalBlockedResponse = (content: string): boolean => {
  if (!content || content.length === 0) return false;
  return EXTERNAL_BLOCK_PATTERNS.some((pattern) => pattern.test(content));
};

// ==================== 核心：fetch 拦截器安装函数 ====================

export const setupFetchInterceptor = (config: InterceptorConfig, logTag: string = ""): void => {
  const interceptorState = getFetchInterceptorState();
  interceptorState.setupAttempts += 1;

  if (interceptorState.installed) {
    return;
  }

  const { api, client, enableLogging, shieldEndpoint } = config;

  const originalFetch = globalThis.fetch;

  const newFetch = async function (this: any, ...args: any[]) {
    const triggerSeq = interceptorState.triggerCount + 1;
    interceptorState.triggerCount = triggerSeq;

    const url = args[0]?.toString() || "";
    const options = args[1] || {};


    const parentCtx = getCurrentAgentCtx() ?? undefined;

    if (shieldEndpoint && url.includes(shieldEndpoint)) {
      return originalFetch.apply(this, args as any);
    }

    // ==================== 生成链路追踪信息 ====================

    const roundTraceId = getExternalTraceId() || generateTraceId();

    const currentSpanId = getCurrentAgentSpanId() ?? undefined;

    const { traceparent } = generateTraceparent(roundTraceId, currentSpanId);

    // ==================== 获取审核上下文 ====================

    const runtimeAuditCtx = getCurrentLlmAuditContext();
    const sessionKey = runtimeAuditCtx?.sessionKey || `fetch:${url}`;
    const turnKey = runtimeAuditCtx?.turnKey || roundTraceId;

    // ==================== 请求体解析与输入审核 ====================

    let jsonBody: any;  // 解析后的 JSON 请求体（如果是 JSON 格式的话）

    if (options.body) {
      let rawBody: string | undefined;

      // 将请求体统一转为字符串，支持 string / Uint8Array / ArrayBuffer 三种格式
      if (typeof options.body === "string") {
        rawBody = options.body;
      } else if (options.body instanceof Uint8Array || options.body instanceof ArrayBuffer) {
        rawBody = new TextDecoder().decode(options.body);
      }

      // 尝试将原始字符串解析为 JSON
      if (rawBody) {
        try {
          jsonBody = JSON.parse(rawBody);
        } catch {
          // 不是 JSON 请求体（如 FormData、纯文本），跳过审核
        }
      }

      // 如果成功解析为 JSON，开始进行输入侧的处理
      if (jsonBody) {
        // 提取最后一条用户消息（即当前轮次用户的输入）
        const messagesToModerate = extractLastUserMessage(jsonBody);

        if (Array.isArray(jsonBody.messages)) {
          // 找到最后一条 user 消息的索引，清洗时跳过它（当前输入不需要清洗）
          let lastUserMsgIndex = -1;
          for (let i = jsonBody.messages.length - 1; i >= 0; i--) {
            if (jsonBody.messages[i].role === "user") {
              lastUserMsgIndex = i;
              break;
            }
          }

          // 第一步：过滤掉 REDACT 标记区间的消息
          // 找到带有 REDACT 标识的消息，从该消息的上一条 user 到下一条 user 之间的所有消息全部移除
          const redactFilteredMessages = filterRedactedMessages(jsonBody.messages);
          const redactRemovedCount = jsonBody.messages.length - redactFilteredMessages.length;

          if (redactRemovedCount > 0) {
            jsonBody.messages = redactFilteredMessages;
            // 重新计算 lastUserMsgIndex
            lastUserMsgIndex = -1;
            for (let i = jsonBody.messages.length - 1; i >= 0; i--) {
              if (jsonBody.messages[i].role === "user") {
                lastUserMsgIndex = i;
                break;
              }
            }
          }

          // 第二步：指纹匹配清洗（sanitizeMessages 会将历史消息中曾被阻断的内容替换为安全占位符）
          const sanitizedCount = sanitizeMessages(jsonBody.messages, lastUserMsgIndex);

          if (redactRemovedCount > 0 || sanitizedCount > 0) {
            // 清洗后需要将修改后的 messages 重新序列化回 options.body
            const newBody = JSON.stringify(jsonBody);

            // 根据原始 body 的类型，用对应格式写回
            if (typeof options.body === "string") {
              options.body = newBody;
            } else if (options.body instanceof Uint8Array) {
              options.body = new TextEncoder().encode(newBody);
            } else if (options.body instanceof ArrayBuffer) {
              const encoded = new TextEncoder().encode(newBody);
              options.body = encoded.buffer;
            }

            // 更新 args[1] 以确保修改生效（因为 options 可能是 args[1] 的浅拷贝）
            args[1] = options;
          }
        }

        if (isSessionBlocked(sessionKey)) {
          if (messagesToModerate.length > 0) {
            clearSessionBlocked(sessionKey);
          } else {
            // session 已被标记为阻断状态，且本轮没有新的用户消息，直接放行（后续 sanitizeMessages 会清洗历史）
          }
        }

        if (messagesToModerate.length > 0) {
          const msg = messagesToModerate[0];

          const sessionId = getSessionId(sessionKey);
          const qaid = ensureQAIDForTurn(sessionKey, turnKey);

          const slices = sliceText(msg.content, PROMPT_MAX_LENGTH);

          // 安全修复：遍历所有分片进行审核，防止超长内容截断绕过。
          // 只对第一个分片做 stripPromptMetadata（元数据前缀只存在于消息开头）。
          // 性能优化：prompt 类审核所有分片均为 SessionType.QUESTION，无顺序依赖，
          // 使用 checkSlicesParallel 并发审核（含并发上限控制和批次间短路优化）。
          const inputBlocked = await checkSlicesParallel(
              slices,
              async (slice, i) => {
                const contentToCheck = i === 0 ? stripPromptMetadata(slice) : slice;
                const result = await checkContentSecurity(
                    api,
                    client,
                    "prompt",
                    [{ Data: contentToCheck, MediaType: "Text" }],
                    sessionId,
                    SessionType.QUESTION,
                    "llm_request",
                    enableLogging,
                    logTag,
                    qaid,
                    parentCtx,
                );
                return result;
              },
          );

          if (inputBlocked) {

            // 输入有害：不发给 LLM，直接构造一个带 REDACT 标识的 SSE 响应返回给框架
            // 框架会将这条 assistant 消息写入 session，before_message_write 钩子会处理 REDACT 标记
            const blockedReplyText = "<!--REDACT-->抱歉，这个问题我暂时无法解答，让我们换个话题吧~\n\n你可以试试让我帮你： 🔍 搜索与查询 · ✍️ 内容创作 · ⏰ 定时提醒 · ⚙️ 系统操作<!--/REDACT-->";
            const sseChunk = JSON.stringify({
              id: `blocked-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "content-security",
              choices: [{
                index: 0,
                delta: { role: "assistant", content: blockedReplyText },
                finish_reason: "stop",
              }],
            });
            const sseBody = `data: ${sseChunk}\n\ndata: [DONE]\n\n`;
            const encoder = new TextEncoder();

            return new Response(encoder.encode(sseBody), {
              status: 200,
              statusText: "OK",
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              },
            });
          }

          clearSessionBlocked(sessionKey);
        }
      }
    }

    const isLLMRequest = !!(jsonBody && (
        Array.isArray(jsonBody.messages) || typeof jsonBody.prompt === "string" || typeof jsonBody.input === "string"
    ));

    if (isLLMRequest) {
      interceptorState.llmRequestCount += 1;
    }

    // ==================== 触发延迟创建的 chat span ====================
    if (isLLMRequest) {
      consumePendingChatSpanCallback();
    }

    // ==================== 注入 traceparent header ====================

    if (!options.headers) {
      options.headers = {};
    }

    const conversationId = getSessionId(sessionKey);
    const conversationRequestId = roundTraceId;

    if (options.headers instanceof Headers) {
      options.headers.set("traceparent", traceparent);
      options.headers.set("X-Conversation-ID", conversationId);
      options.headers.set("X-Conversation-Request-ID", conversationRequestId);
    } else if (Array.isArray(options.headers)) {
      options.headers.push(["traceparent", traceparent]);
      options.headers.push(["X-Conversation-ID", conversationId]);
      options.headers.push(["X-Conversation-Request-ID", conversationRequestId]);
    } else {
      options.headers["traceparent"] = traceparent;
      options.headers["X-Conversation-ID"] = conversationId;
      options.headers["X-Conversation-Request-ID"] = conversationRequestId;
    }
    args[1] = options;

    // ==================== 调用原始 fetch 发出请求 ====================
    let resp: Response;
    try {
      resp = await originalFetch.apply(this, args as any);
    } catch (fetchError: any) {
      throw fetchError;
    }

    // ==================== 输出内容安全审核 ====================
    if (isLLMRequest && resp.ok) {
      if (isSessionBlocked(sessionKey)) {
        return resp;
      }

      const sessionId = getSessionId(sessionKey);
      const qaid = ensureQAIDForTurn(sessionKey, turnKey);

      const auditOutputSlices = async (assistantContent: string, source: string): Promise<void> => {
        if (assistantContent.length === 0) {
          interceptorState.outputAuditEndCount += 1;
          const emptyResult = await checkContentSecurity(
              api,
              client,
              "output",
              [{ Data: "", MediaType: "Text" }],
              sessionId,
              SessionType.ANSWER_END,
              source,
              enableLogging,
              logTag,
              qaid,
              parentCtx,
          );
          return;
        }

        const slices = sliceText(assistantContent, OUTPUT_MAX_LENGTH);

        for (let i = 0; i < slices.length; i++) {
          const isLastSlice = i === slices.length - 1;
          const sessionType = isLastSlice ? SessionType.ANSWER_END : SessionType.ANSWER;

          if (isLastSlice) {
            interceptorState.outputAuditEndCount += 1;
          }

          const result = await checkContentSecurity(
              api,
              client,
              "output",
              [{ Data: slices[i], MediaType: "Text" }],
              sessionId,
              sessionType,
              source,
              enableLogging,
              logTag,
              qaid,
              parentCtx,
          );
        }
      };

      const contentType = resp.headers.get("content-type") || "";
      const isSSE = contentType.includes("text/event-stream");

      if (isSSE) {

        const body = resp.body;
        if (body) {
          const reader = body.getReader();
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();

          let auditBuffer = "";
          let sliceIndex = 0;
          let lineBuf = "";
          // 输出审核发现有害时，标记为 true，后续会中止流并替换为 REDACT 提示
          let outputBlocked = false;
          // 是否已经发送了替代响应（避免重复发送）
          let blockedResponseSent = false;
          // 诊断计数器：追踪透传了多少个 chunk 后才检测到拒绝话术
          let pullCallCount = 0;
          let enqueuedChunkCount = 0;
          const streamStartTime = performance.now();

          const parseDeltaContent = (line: string): string => {
            if (!line.startsWith("data:")) return "";
            const dataStr = line.slice(5).trim();
            if (dataStr === "[DONE]") return "";
            try {
              const json = JSON.parse(dataStr);
              if (Array.isArray(json.choices) && json.choices.length > 0) {
                const choice = json.choices[0];
                const delta = choice.delta;
                if (delta && typeof delta.content === "string") {
                  return delta.content;
                }
              }
            } catch {
              // JSON 解析失败，忽略这一行
            }
            return "";
          };

          /** 解析 SSE 行中的 finish_reason 字段 */
          const parseFinishReason = (line: string): string | null => {
            if (!line.startsWith("data:")) return null;
            const dataStr = line.slice(5).trim();
            if (dataStr === "[DONE]") return null;
            try {
              const json = JSON.parse(dataStr);
              if (Array.isArray(json.choices) && json.choices.length > 0) {
                const finishReason = json.choices[0]?.finish_reason;
                if (finishReason) return finishReason;
              }
              // 兼容顶层 stopReason / stop_reason 字段
              if (json.stopReason) return json.stopReason;
              if (json.stop_reason) return json.stop_reason;
            } catch {
              // 忽略
            }
            return null;
          };

          const flushAuditBuffer = async (): Promise<void> => {
            while (auditBuffer.length >= OUTPUT_MAX_LENGTH) {
              // 取出一个切片
              const slice = auditBuffer.slice(0, OUTPUT_MAX_LENGTH);
              auditBuffer = auditBuffer.slice(OUTPUT_MAX_LENGTH);
              sliceIndex++;

              // 发送中间切片的审核请求（类型为 ANSWER，非 ANSWER_END）
              const result = await checkContentSecurity(
                  api,
                  client,
                  "output",
                  [{ Data: slice, MediaType: "Text" }],
                  sessionId,
                  SessionType.ANSWER,
                  "llm_response_sse",
                  enableLogging,
                  logTag,
                  qaid,
                  parentCtx,
              );

              if (result.blocked) {
                // 输出有害：标记为阻断，后续会中止原始流并发送替代响应
                outputBlocked = true;
                addBlockedContent(slice);
                // 跳出循环，不再继续审核后续切片
                break;
              }
            }
          };

          const enqueueBlockedMarker = (controller: ReadableStreamDefaultController): void => {
            if (blockedResponseSent) return;
            blockedResponseSent = true;

            // 发送一个带 REDACT 标识的 SSE chunk 作为替代响应
            // session 中的 assistant 消息会包含 REDACT 标记，下次请求时会被 filterRedactedMessages 清洗
            const blockedReplyText = "<!--REDACT-->抱歉，这个问题我暂时无法解答，让我们换个话题吧~\n\n你可以试试让我帮你： 🔍 搜索与查询 · ✍️ 内容创作 · ⏰ 定时提醒 · ⚙️ 系统操作<!--/REDACT-->";
            const redactChunk = JSON.stringify({
              id: `output-blocked-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "content-security",
              choices: [{
                index: 0,
                delta: { content: blockedReplyText },
                finish_reason: "stop",
              }],
            });
            controller.enqueue(encoder.encode(`data: ${redactChunk}\n\n`));
            // 发送 [DONE] 信号，通知消费者流已结束
            controller.enqueue(encoder.encode(`data: [DONE]\n\n`));

            const blockedAtMs = (performance.now() - streamStartTime).toFixed(1);

            // 立即关闭 controller，确保前端流结束，不再 loading
            try {
              controller.close();
            } catch {
              // controller 可能已经关闭（比如上游已 done），忽略
            }

            // 立即取消上游 reader，停止接收 SSE 流，释放连接资源
            try {
              reader.cancel();
            } catch {
              // reader 可能已关闭，忽略
            }
          };

          // ==================== 创建转换后的可读流 ====================
          const transformedStream = new ReadableStream({
            start(_controller) {
              // no-op
            },
            async pull(controller) {
              try {
                const { done, value } = await reader.read();

                if (done) {
                  // ===== 流结束处理 =====

                  // 如果 enqueueBlockedMarker 已经关闭了 controller，直接返回
                  if (blockedResponseSent) {
                    return;
                  }

                  if (lineBuf.trim()) {
                    const content = parseDeltaContent(lineBuf);
                    if (content) {
                      auditBuffer += content;
                    }
                  }

                  sliceIndex++;

                  // 流结束时，检测完整的 auditBuffer 是否匹配外部安全插件（如 pcmgr-ai-security）的拒绝话术
                  if (!outputBlocked && isExternalBlockedResponse(auditBuffer)) {
                    outputBlocked = true;
                    // 追加 REDACT 标记并关闭流
                    enqueueBlockedMarker(controller);
                    return; // controller 已关闭，不再继续
                  }

                  // 如果之前检测到输出有害但还未发送 REDACT 标记，在关闭前发送
                  if (outputBlocked) {
                    enqueueBlockedMarker(controller);
                    return; // controller 已关闭，不再继续
                  }

                  controller.close();

                  // 流正常结束，对剩余缓冲区做最后一次审核（ANSWER_END）
                  setTimeout(() => {
                    interceptorState.outputAuditEndCount += 1;

                    checkContentSecurity(
                        api,
                        client,
                        "output",
                        [{ Data: auditBuffer, MediaType: "Text" }],
                        sessionId,
                        SessionType.ANSWER_END,
                        "llm_response_sse",
                        enableLogging,
                        logTag,
                        qaid,
                        parentCtx,
                    ).then((endResult) => {
                      if (endResult.blocked) {
                        // 末尾切片也有害，标记 session 阻断（后续请求会被 sanitizeMessages 清洗）
                        addBlockedContent(auditBuffer);
                      }
                    }).catch((e) => {
                    });
                  }, 0);

                  return;
                }

                // ===== 处理正常的流数据 chunk =====

                // 如果已经检测到输出有害且 REDACT 已发送，
                // enqueueBlockedMarker 已经在后台异步消耗 reader，直接返回
                if (outputBlocked) {
                  // 由于 enqueueBlockedMarker 已经 close 了 controller，
                  // 这个 pull 不应该再被调用。但作为防御性编程，直接返回。
                  return;
                }

                lineBuf += decoder.decode(value, { stream: true });

                const lines = lineBuf.split("\n");
                lineBuf = lines.pop() || "";

                for (const line of lines) {
                  const content = parseDeltaContent(line);
                  if (content) {
                    auditBuffer += content;
                  }
                  // 检测 finish_reason，content_filter / error 均视为 LLM 主动截断
                  const finishReason = parseFinishReason(line);
                  if (finishReason === "content_filter" || finishReason === "error") {
                    // logInterceptorDebug("llm_finish_reason_blocked", {
                    //   sessionKey,
                    //   finishReason,
                    //   auditBufferPreview: auditBuffer.slice(0, 50),
                    // });
                    outputBlocked = true;
                    addBlockedContent(auditBuffer);
                    enqueueBlockedMarker(controller);
                    return;
                  }
                }

                // ==================== 实时拒绝话术检测（透传前） ====================
                // 先检测 auditBuffer 是否匹配拦截话术，若命中则不透传当前 chunk，
                // 直接注入 REDACT 替代响应，避免拦截消息被 Agent 接收后导致 stopReason: "error"
                pullCallCount++;
                if (isExternalBlockedResponse(auditBuffer)) {
                  outputBlocked = true;
                  addBlockedContent(auditBuffer);
                  enqueueBlockedMarker(controller);
                  return;
                }

                // 未命中拦截话术，透传当前 chunk
                enqueuedChunkCount++;
                controller.enqueue(value);

                // 审核缓冲区，如果发现有害会设置 outputBlocked = true
                await flushAuditBuffer();

                // 审核后如果发现有害，追加 REDACT 标记并关闭流
                if (outputBlocked) {
                  enqueueBlockedMarker(controller);
                  return;
                }
              } catch (e) {
                // 流处理出错，关闭流
                controller.close();
              }
            },
          });

          return new Response(transformedStream, {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
          });
        }
      } else {
        // ==================== JSON 格式响应审核 ====================
        const clonedResp = resp.clone();

        try {
          const respBody = await clonedResp.json();

          // 检测 stopReason === "error"，说明 LLM 因 content_filter 等原因异常终止
          // 直接返回带 REDACT 标识的替代响应，避免 Agent 收到异常消息后报 "An unknown error occurred"
          if (respBody?.stopReason === "error" || respBody?.stop_reason === "error") {
            // logInterceptorDebug("json_stop_reason_error_blocked", {
            //   sessionKey,
            //   stopReason: respBody?.stopReason ?? respBody?.stop_reason,
            // });
            addBlockedContent(JSON.stringify(respBody));
            const blockedReplyText = "<!--REDACT-->抱歉，这个问题我暂时无法解答，让我们换个话题吧~\n\n你可以试试让我帮你： 🔍 搜索与查询 · ✍️ 内容创作 · ⏰ 定时提醒 · ⚙️ 系统操作<!--/REDACT-->";
            const encoder = new TextEncoder();
            const sseChunk = JSON.stringify({
              id: `blocked-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "content-security",
              choices: [{
                index: 0,
                delta: { role: "assistant", content: blockedReplyText },
                finish_reason: "stop",
              }],
            });
            const sseBody = `data: ${sseChunk}\n\ndata: [DONE]\n\n`;
            return new Response(encoder.encode(sseBody), {
              status: 200,
              statusText: "OK",
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              },
            });
          }

          const assistantContent = extractAssistantContent(respBody);
          auditOutputSlices(assistantContent, "llm_response_json").catch(() => {});
        } catch (e) {
          // JSON 解析失败或审核出错，忽略（不影响响应返回）
        }
      }
    }

    return resp;
  };

  globalThis.fetch = newFetch as typeof fetch;

  interceptorState.installed = true;
};