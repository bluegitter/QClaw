import { SessionType } from "./types";
import type { InterceptorConfig } from "./types";
import {
  normalizeMessage,
  extractLastUserMessage,
  extractAssistantContent,
  sliceText,
  recordLogEvent,
  generateSecurityMessage,
} from "./utils";
import { parseFirstLabels } from "./labels";
import { checkContentSecurity } from "./security";
import { getSessionId, getQAID, startNewQA, markSessionBlocked, isSessionBlocked, clearSessionBlocked, addBlockedContent, sanitizeMessages, getBlockedReason } from "./session";

/** Prompt 最大长度（字）。CreateTask 接口限制单次文本 ≤ 4000 字 */
const PROMPT_MAX_LENGTH = 4000;

/** Output 最大长度（字）。CreateTask 接口限制单次 Output ≤ 128 字，超长需切片，留 8 字缓冲取 120 */
const OUTPUT_MAX_LENGTH = 120;

/**
 * 安装 fetch 拦截器
 *
 * 通过 monkey-patch `globalThis.fetch` 拦截所有经过全局 fetch 发出的 HTTP 请求。
 * 当检测到 LLM API 调用（请求体含 messages / prompt / input 字段）时：
 *   1. 提取最后一条 user 消息
 *   2. 调用 CreateTask 接口进行内容安全审核
 *   3. 若审核不通过（blocked=true），直接返回伪 error Response，
 *      不再将请求发给 LLM，避免触发 LLM 自身安全审核导致 model engine error
 *   4. 对于 LLM 响应中的模型错误（如 model engine error / content_filter），
 *      检测到后会在 SSE 流末尾追加内容审核拦截标记，让前端展示友好的拦截提示
 *
 * 注意：
 * - 必须在调用此函数前保存原始 fetch（`const originalFetch = globalThis.fetch`），
 *   并通过 `config.shieldEndpoint` 过滤掉审核接口自身的请求，避免死循环
 * - 此函数同时审核输入侧（Prompt）和输出侧（LLM 响应）
 * - SSE 流使用 TransformStream 模式（非 tee），可在流末尾追加拦截 chunk
 *
 * @param config - 拦截器配置（api / client / SID / 日志开关 / 屏蔽地址）
 * @param logTag - 日志标签前缀，用于在混合日志中快速过滤本插件输出
 */
export const setupFetchInterceptor = (config: InterceptorConfig, logTag: string = ""): void => {
  const { api, client, enableLogging, shieldEndpoint } = config;
  // 保存原始 fetch，用于：
  // 1. 实际发出请求（拦截处理完成后调用）
  // 2. 过滤审核接口自身的请求（通过 shieldEndpoint 判断）
  const originalFetch = globalThis.fetch;

  /**
   * 替换后的 fetch 函数
   *
   * 执行流程：
   * 1. 检查 URL 是否为审核接口自身 → 是则直接透传，跳过审核
   * 2. 解析请求体，提取最后一条 user 消息
   * 3. 对消息内容进行切片（≤ 4000 字），只审核第一片
   * 4. 调用 checkContentSecurity 发起审核
   * 5. 若被拦截，直接返回包含 CONTENT_SECURITY_BLOCK code 的伪 error Response
   * 6. 未被拦截时调用原始 fetch 发出请求
   * 7. 获取响应后，提取 LLM assistant 输出内容
   * 8. 按 ≤ 120 字切片异步送审（SessionType=2/3），不阻塞响应返回
   */
  const newFetch = async function (this: any, ...args: any[]) {
    const url = args[0]?.toString() || "";
    const options = args[1] || {};

    // 过滤审核接口自身的请求，避免死循环
    // shieldEndpoint 通常是 CreateTask 接口的 endpoint（域名部分）
    if (shieldEndpoint && url.includes(shieldEndpoint)) {
      return originalFetch.apply(this, args as any);
    }

    let jsonBody: any;

    if (options.body) {
      let rawBody: string | undefined;

      // 将请求体统一转为字符串，支持 string / Uint8Array / ArrayBuffer 三种格式
      if (typeof options.body === "string") {
        rawBody = options.body;
      } else if (options.body instanceof Uint8Array || options.body instanceof ArrayBuffer) {
        rawBody = new TextDecoder().decode(options.body);
      }

      if (rawBody) {
        try {
          jsonBody = JSON.parse(rawBody);
        } catch {
          // 不是 JSON 请求体（如 FormData、纯文本），跳过审核
        }
      }

      // 只处理包含 messages / prompt / input 字段的 JSON 请求体（LLM API 特征）
      if (jsonBody) {
        // [Prompt阶段-1] 打印发给 LLM 的完整 messages 摘要，帮助排查历史消息中是否残留敏感内容
        if (Array.isArray(jsonBody.messages)) {
          const messagesSummary = jsonBody.messages.map((m: any, i: number) => {
            const role = m.role || "unknown";
            const content = typeof m.content === "string"
              ? m.content.substring(0, 150)
              : (Array.isArray(m.content)
                ? JSON.stringify(m.content).substring(0, 150)
                : String(m.content || "").substring(0, 150));
            return `  [${i}] role=${role}, content="${content}"`;
          });
          api.logger.info(
            `[${logTag}] [Prompt阶段-1/请求拦截] messages 摘要 (共${jsonBody.messages.length}条), url=${url}:\n` +
            messagesSummary.join("\n")
          );
        }

        // extractLastUserMessage 会提取最后一条 role=user 的消息
        // 注意：必须在 sanitizeMessages 之前提取，否则最新消息可能已被替换为占位文本，
        // 导致 Prompt 审核送审的是占位文本而非用户真实输入，敏感内容绕过审核
        const messagesToModerate = extractLastUserMessage(jsonBody);

        // ======= B 方案：清洗历史消息中的敏感内容 =======
        // 在发送给 LLM 之前，检查 messages 中是否包含之前被拦截的敏感消息
        // 匹配到的消息会被替换为安全占位文本，防止 LLM 因历史敏感内容拒绝服务
        // 重要：排除最后一条 user 消息（它会走正式的 Prompt 审核流程，不应被提前清洗）
        if (Array.isArray(jsonBody.messages)) {
          // 找到最后一条 user 消息的索引，清洗时跳过它
          let lastUserMsgIndex = -1;
          for (let i = jsonBody.messages.length - 1; i >= 0; i--) {
            if (jsonBody.messages[i].role === "user") {
              lastUserMsgIndex = i;
              break;
            }
          }

          const sanitizedCount = sanitizeMessages(jsonBody.messages, lastUserMsgIndex);
          if (sanitizedCount > 0) {
            api.logger.warn(
              `[${logTag}] [Prompt阶段-2/清洗历史] 已清洗 ${sanitizedCount} 条历史敏感消息 (共${jsonBody.messages.length}条, 跳过最后一条user消息index=${lastUserMsgIndex}), url=${url}`
            );
            // 将清洗后的 messages 重新序列化回 options.body
            const newBody = JSON.stringify(jsonBody);
            if (typeof options.body === "string") {
              options.body = newBody;
            } else if (options.body instanceof Uint8Array) {
              options.body = new TextEncoder().encode(newBody);
            } else if (options.body instanceof ArrayBuffer) {
              const encoded = new TextEncoder().encode(newBody);
              options.body = encoded.buffer;
            }
            // 更新 args[1] 以确保修改生效
            args[1] = options;
          }
        }

        // fetch 拦截中无法获取 OpenClaw 的 sessionKey，
        // 使用 "fetch:{url}" 作为 sessionKey，确保同一 LLM 端点的请求共享同一个 SessionID
        const sessionKey = `fetch:${url}`;

        // 检查该 sessionKey 最近的 Prompt 是否已被拦截
        // 仅当请求中**没有新的 user 消息**时才拦截（即 Agent Runner 的重试请求）
        // 如果请求中包含新的 user 消息，说明是用户主动发的新问题，应清除拦截标记并走正常审核流程
        // 这样可以避免：用户发了一条敏感消息被拦截后，后续正常消息也被误拦截的问题
        if (isSessionBlocked(sessionKey)) {
          if (messagesToModerate.length > 0) {
            // 有新的 user 消息 → 用户发了新问题，清除拦截标记，放行走正常审核
            api.logger.info(`[${logTag}] [Prompt阶段-3/放行] 该会话曾被标记拦截，但检测到新的user消息，清除拦截标记并放行 | sessionKey=${sessionKey}, url=${url}`);
            clearSessionBlocked(sessionKey);
          } else {
            // 没有 user 消息 → Agent Runner 的重试请求，直接拦截
            const blockedReason = getBlockedReason(sessionKey);
            api.logger.warn(`[${logTag}] [Prompt阶段-3/重试拦截] 该会话已被标记拦截且无新user消息，直接返回伪SSE | sessionKey=${sessionKey}, reason=${blockedReason}, url=${url}`);
            const blockMessage = blockedReason === "model_error"
              ? `<!--CONTENT_SECURITY_BLOCK-->抱歉该任务处理异常，请更换任务再尝试，为保障使用，该问答将在3秒后被删除`
              : `<!--CONTENT_SECURITY_BLOCK-->抱歉该任务处理异常，请更换任务再尝试，为保障使用，该问答将在3秒后被删除。`;
            const sseChunk = JSON.stringify({
              id: `block-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "content-security",
              choices: [{
                index: 0,
                delta: { role: "assistant", content: blockMessage },
                finish_reason: "stop",
              }],
            });
            const sseBody = `data: ${sseChunk}\n\ndata: [DONE]\n\n`;
            return new Response(sseBody, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
              },
            });
          }
        }

        if (messagesToModerate.length > 0) {
          const msg = messagesToModerate[0];

          const sessionId = getSessionId(sessionKey);
          // 每次用户发起新请求时开启新的问答对（生成新的 QAID）
          const qaid = startNewQA(sessionKey);

          // 对 Prompt 进行切片（≤ 4000 字）
          // 超长 Prompt 通常包含大量上下文，只审核第一片（最新的用户输入）
          const slices = sliceText(msg.content, PROMPT_MAX_LENGTH);
          const contentToCheck = slices[0];

          // 记录审核前的日志（仅在 enableLogging=true 时输出）
          recordLogEvent(
            api,
            logTag,
            "[Prompt阶段-4/送审] 提取用户消息准备送审",
            {
              url,
              sessionKey,
              sessionId,
              qaid,
              contentLength: msg.content.length,
              sliceCount: slices.length,
              checkLength: contentToCheck.length,
              preview: contentToCheck.substring(0, 100),
            },
            enableLogging,
          );

          // 调用 CreateTask 接口进行内容安全审核
          // source="llm_request" 用于日志标识来源 hook
          const result = await checkContentSecurity(
            api,
            client,
            "prompt",
            [{ Data: contentToCheck, MediaType: "Text" }],
            sessionId,
            SessionType.QUESTION, // Prompt 属于"问"侧
            "llm_request",
            enableLogging,
            logTag,
            qaid,
          );

          if (result.blocked) {
            // 标记该 sessionKey 被拦截（原因：内容安全审核），后续重试请求将被直接拦截
            markSessionBlocked(sessionKey, "security");

            // 记录被拦截的消息内容指纹，用于后续清洗历史消息中的敏感内容
            addBlockedContent(msg.content);

            // 解析命中的一级标签（Level >= 200 的标签），生成人类可读的拦截原因
            const hitLabels = parseFirstLabels(
              JSON.stringify(result.labels),
              200,
            );
            const securityReason = generateSecurityMessage(hitLabels, true);

            api.logger.error(`[${logTag}] [Prompt阶段-5/拦截] Prompt审核被拦截，返回伪SSE | sessionKey=${sessionKey}, sessionId=${sessionId}, qaid=${qaid}, traceId=${result.traceId || "N/A"}, reason="${securityReason}"`);
            recordLogEvent(
              api,
              logTag,
              "[Prompt阶段-5/拦截] 详细信息",
              { sessionKey, sessionId, qaid, securityReason, traceId: result.traceId, labels: result.labels },
              enableLogging,
            );

            // 直接返回伪 SSE 200 Response，不再将请求发给 LLM
            // Gateway 会将其当作正常的 LLM 流式回复，转为 delta → final 事件传给前端
            // 内容中嵌入 <!--CONTENT_SECURITY_BLOCK--> 标记，供前端精确识别安全审核拦截
            // 注意：securityReason 是给 LLM 注入的安全指令，不能直接展示给用户
            // 这里使用固定的用户友好文案（安全审核拦截 → 有句号）
            const blockMessage = `<!--CONTENT_SECURITY_BLOCK-->抱歉该任务处理异常，请更换任务再尝试，为保障使用，该问答将在3秒后被删除。`;
            const sseChunk = JSON.stringify({
              id: `block-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "content-security",
              choices: [{
                index: 0,
                delta: { role: "assistant", content: blockMessage },
                finish_reason: "stop",
              }],
            });
            const sseBody = `data: ${sseChunk}\n\ndata: [DONE]\n\n`;
            return new Response(sseBody, {
              status: 200,
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
              },
            });
          }

          // Prompt 审核通过，清除拦截标记（说明用户发了新的合规消息）
          clearSessionBlocked(sessionKey);
        }
      }
    }

    // 标记当前请求是否为 LLM API 请求（包含 messages / prompt / input 字段）
    // 用于决定是否对响应体进行 LLM 输出审核
    const isLLMRequest = !!(jsonBody && (
      Array.isArray(jsonBody.messages) || typeof jsonBody.prompt === "string" || typeof jsonBody.input === "string"
    ));

    // 调用原始 fetch 发出请求（请求体可能已被修改）
    const resp = await originalFetch.apply(this, args as any);

    // 打印 LLM 响应状态，帮助排查 400 Content Exists Risk 等问题
    if (isLLMRequest) {
      api.logger.info(
        `[${logTag}] [Response阶段-1/响应状态] LLM 响应 status=${resp.status}, statusText="${resp.statusText}", ok=${resp.ok}, url=${url}`
      );

      // 如果响应不 ok（非 2xx），打印响应体帮助排查
      if (!resp.ok) {
        try {
          const errorClone = resp.clone();
          const errorText = await errorClone.text();
          api.logger.error(
            `[${logTag}] [Response阶段-1/响应异常] LLM 返回非2xx响应 | status=${resp.status}, url=${url}, body(前500字)="${errorText.substring(0, 500)}"`
          );
        } catch (e) {
          api.logger.error(`[${logTag}] [Response阶段-1/响应异常] 读取LLM错误响应体失败 | url=${url}, error=${e}`);
        }
      }
    }

    // ==================== LLM 响应输出审核（异步，不阻塞返回） ====================
    // 仅对 LLM API 请求的响应进行审核，非 LLM 请求直接跳过
    if (isLLMRequest && resp.ok) {
      // 获取当前请求的 session 信息（在请求侧已创建）
      const sessionKey = `fetch:${url}`;

      // 额外防御：如果该 sessionKey 的 Prompt 已被拦截，跳过 Output 审核
      // 正常情况下不会走到这里（因为 Prompt 拦截后已直接返回伪 SSE），但作为安全兜底
      if (isSessionBlocked(sessionKey)) {
        api.logger.warn(`[${logTag}] [Output阶段/跳过] 该会话Prompt已被拦截，跳过Output审核 | sessionKey=${sessionKey}, url=${url}`);
        return resp;
      }

      const sessionId = getSessionId(sessionKey);
      const qaid = getQAID(sessionKey);

      /**
       * 对提取到的 assistant 内容按 ≤ OUTPUT_MAX_LENGTH 字切片逐片送审。
       * SSE 和 JSON 两种响应格式共用此逻辑，仅 source 标识不同。
       *
       * @param assistantContent - 已提取的 assistant 完整文本
       * @param source           - 日志来源标识（"llm_response_sse" | "llm_response_json"）
       */
      const auditOutputSlices = async (assistantContent: string, source: string): Promise<void> => {
        // 即使内容为空，也必须发送 ANSWER_END 关闭会话
        // 原因：QUESTION 已在请求侧发出，若不发 ANSWER_END，审核服务的会话将永远不会关闭
        if (assistantContent.length === 0) {
          await checkContentSecurity(
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
          );
          return;
        }

        const slices = sliceText(assistantContent, OUTPUT_MAX_LENGTH);

        recordLogEvent(
          api,
          logTag,
          `[Output阶段-2/送审] ${source} 准备送审assistant输出`,
          {
            url,
            sessionId,
            qaid,
            contentLength: assistantContent.length,
            sliceCount: slices.length,
            preview: assistantContent.substring(0, 100),
          },
          enableLogging,
        );

        // 逐片送审：中间片用 SessionType=2（答），最后一片用 SessionType=3（回答结束）
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
            source,
            enableLogging,
            logTag,
            qaid,
          );

          if (result.blocked) {
            api.logger.warn(
              `[${logTag}] [Output阶段-2/拦截] ${source} 切片[${i + 1}/${slices.length}]被打击 | sessionId=${sessionId}, qaid=${qaid}, traceId=${result.traceId || "N/A"}, slicePreview="${slices[i].substring(0, 50)}"`,
            );
          }
        }
      };

      const contentType = resp.headers.get("content-type") || "";
      const isSSE = contentType.includes("text/event-stream");

      if (isSSE) {
        // ---------- 流式响应（SSE）审核：实时缓存 + 分 120 字送审 + 模型错误检测 ----------
        // 使用 TransformStream 作为中间层，在流传递给调用方的同时：
        //   1. 实时解析 SSE data 行中的 delta.content，按 ≤ 120 字切片送审
        //   2. 检测模型错误信号（finish_reason=content_filter/error、error 字段）
        //   3. 如果检测到模型因内容安全策略拒绝回答，**立即停止透传原始流**，
        //      将流内容替换为拦截 SSE chunk，使前端展示"内容安全审核拦截"提示
        //   关键：先解析再透传。检测到错误时丢弃包含错误信号的 chunk，直接输出拦截内容。
        const body = resp.body;
        if (body) {
          const reader = body.getReader();
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();

          // 流式缓冲区：累积 delta.content，满 120 字立即送审
          let auditBuffer = "";
          // 已送审的切片计数（用于日志）
          let sliceIndex = 0;
          // SSE 行缓冲：处理跨 chunk 的不完整行
          let lineBuf = "";
          // 模型错误检测状态
          let totalContent = "";       // 累积的全部 delta.content
          let detectedModelError = false; // 是否检测到模型错误信号
          let detectedFinishReason = ""; // 检测到的 finish_reason

          /**
           * 从 SSE data 行中解析 delta.content，同时检测模型错误信号
           * @param line - 单行 SSE 文本（如 "data: {\"choices\":[...]}"）
           * @returns delta.content 字符串，解析失败返回空字符串
           */
          const parseDeltaContent = (line: string): string => {
            if (!line.startsWith("data:")) return "";
            const dataStr = line.slice(5).trim();
            if (dataStr === "[DONE]") return "";
            try {
              const json = JSON.parse(dataStr);

              // 检测 SSE 中的 error 字段（某些模型会通过此字段返回错误）
              if (json.error) {
                detectedModelError = true;
                api.logger.warn(
                  `[${logTag}] [Output阶段-SSE/模型错误检测] 检测到SSE error字段 | sessionId=${sessionId}, qaid=${qaid}, error=${JSON.stringify(json.error)}`,
                );
              }

              if (Array.isArray(json.choices) && json.choices.length > 0) {
                const choice = json.choices[0];
                const delta = choice.delta;

                // 检测 finish_reason：content_filter / error 表示模型因安全策略拒绝
                if (choice.finish_reason) {
                  detectedFinishReason = choice.finish_reason;
                  if (choice.finish_reason === "content_filter" || choice.finish_reason === "error") {
                    detectedModelError = true;
                    api.logger.warn(
                      `[${logTag}] [Output阶段-SSE/模型错误检测] 检测到finish_reason=${choice.finish_reason} | sessionId=${sessionId}, qaid=${qaid}`,
                    );
                  }
                }

                if (delta && typeof delta.content === "string") {
                  return delta.content;
                }
              }
            } catch {
              // 单行解析失败（如空行、注释行），跳过
            }
            return "";
          };

          /**
           * 将缓冲区中满 120 字的部分逐片送审（SessionType.ANSWER）
           */
          const flushAuditBuffer = async (): Promise<void> => {
            while (auditBuffer.length >= OUTPUT_MAX_LENGTH) {
              const slice = auditBuffer.slice(0, OUTPUT_MAX_LENGTH);
              auditBuffer = auditBuffer.slice(OUTPUT_MAX_LENGTH);
              sliceIndex++;

              recordLogEvent(
                api,
                logTag,
                `[Output阶段-SSE/流式送审] 第${sliceIndex}片`,
                {
                  url,
                  sessionId,
                  qaid,
                  sliceIndex,
                  sliceLength: slice.length,
                  preview: slice.substring(0, 50),
                },
                enableLogging,
              );

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
              );

              if (result.blocked) {
                api.logger.warn(
                  `[${logTag}] [Output阶段-SSE/拦截] 流式切片[${sliceIndex}]被打击 | sessionId=${sessionId}, qaid=${qaid}, traceId=${result.traceId || "N/A"}, slicePreview="${slice.substring(0, 50)}"`,
                );
              }
            }
          };

          // 标记流是否已被拦截（检测到模型错误后设为 true，后续 chunk 不再透传）
          let streamIntercepted = false;

          /**
           * 生成拦截 SSE 内容并关闭流
           * 当检测到模型因内容安全策略拒绝回答时调用
           */
          const interceptStream = (controller: ReadableStreamDefaultController): void => {
            streamIntercepted = true;

            api.logger.warn(
              `[${logTag}] [Output阶段-SSE/模型错误拦截] 检测到大模型错误，替换原始流为内容审核拦截提示 | sessionId=${sessionId}, qaid=${qaid}, totalContentLength=${totalContent.length}, detectedModelError=${detectedModelError}, finishReason=${detectedFinishReason}, url=${url}`,
            );

            // 根据 finishReason 区分拦截原因：
            // content_filter → 模型层面的内容安全策略拦截（等同于安全审核）
            // 其他（error / model engine error 等）→ 模型运行时错误
            const isContentFilter = detectedFinishReason === "content_filter";
            const blockedReason = isContentFilter ? "security" : "model_error";
            markSessionBlocked(sessionKey, blockedReason);

            // 输出拦截 SSE chunk，替换原始的错误流
            // 内容审核拦截（content_filter）→ 有句号；模型错误 → 无句号
            const blockMessage = isContentFilter
              ? `<!--CONTENT_SECURITY_BLOCK-->抱歉该任务处理异常，请更换任务再尝试，为保障使用，该问答将在3秒后被删除。`
              : `<!--CONTENT_SECURITY_BLOCK-->抱歉该任务处理异常，请更换任务再尝试，为保障使用，该问答将在3秒后被删除`;
            const sseChunk = JSON.stringify({
              id: `block-model-error-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "content-security",
              choices: [{
                index: 0,
                delta: { role: "assistant", content: blockMessage },
                finish_reason: "stop",
              }],
            });
            const sseBody = `data: ${sseChunk}\n\ndata: [DONE]\n\n`;
            controller.enqueue(encoder.encode(sseBody));

            // 排空原始流的剩余数据（避免流未消费完导致连接泄露）
            (async () => {
              try {
                while (true) {
                  const { done } = await reader.read();
                  if (done) break;
                }
              } catch {
                // 读取失败忽略（流可能已关闭）
              }
            })();

            // 异步送审末片（ANSWER_END）关闭审核会话
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
            ).catch((e) => {
              api.logger.error(`[${logTag}] [Output阶段-SSE/末片异常] 拦截后末片送审失败 | sessionId=${sessionId}, qaid=${qaid}, error=${e}`);
            });

            controller.close();
          };

          // 创建一个可读流，同时处理审核和错误检测
          // 核心策略：先解析当前 chunk 中的每一行 SSE data，检测是否有模型错误信号。
          // 如果检测到错误，**不透传当前 chunk**，而是替换为拦截 SSE 并关闭流。
          // 如果未检测到错误，则正常透传 chunk 给调用方。
          const transformedStream = new ReadableStream({
            async pull(controller) {
              // 流已被拦截，不再处理
              if (streamIntercepted) return;

              try {
                const { done, value } = await reader.read();

                if (done) {
                  // 处理行缓冲区中可能残留的最后一行
                  if (lineBuf.trim()) {
                    const content = parseDeltaContent(lineBuf);
                    if (content) {
                      auditBuffer += content;
                      totalContent += content;
                    }
                  }

                  // ====== 流结束时的模型错误检测 ======
                  // 某些场景下错误信号可能在最后一个 chunk 的最后一行，
                  // 需要在流结束时再次检查
                  if (detectedModelError) {
                    interceptStream(controller);
                    return;
                  }

                  // 正常流结束：将剩余缓冲区内容作为最后一片送审（SessionType.ANSWER_END）
                  // 无论 auditBuffer 是否为空、sliceIndex 是多少，都必须发送 ANSWER_END 关闭会话。
                  sliceIndex++;

                  recordLogEvent(
                    api,
                    logTag,
                    `[Output阶段-SSE/流式结束] 发送ANSWER_END, 第${sliceIndex}片(末片)`,
                    {
                      url,
                      sessionId,
                      qaid,
                      sliceIndex,
                      sliceLength: auditBuffer.length,
                      preview: auditBuffer.substring(0, 50),
                    },
                    enableLogging,
                  );

                  // 异步送审末片（不阻塞流关闭）
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
                  ).then((endResult) => {
                    if (endResult.blocked) {
                      api.logger.warn(
                        `[${logTag}] [Output阶段-SSE/末片拦截] 流式末片[${sliceIndex}]被打击 | sessionId=${sessionId}, qaid=${qaid}, traceId=${endResult.traceId || "N/A"}, bufferPreview="${auditBuffer.substring(0, 50)}"`,
                      );
                    }
                  }).catch((e) => {
                    api.logger.error(`[${logTag}] [Output阶段-SSE/末片异常] 末片送审失败 | sessionId=${sessionId}, qaid=${qaid}, error=${e}`);
                  });

                  controller.close();
                  return;
                }

                // ====== 先解析当前 chunk，检测是否有模型错误信号 ======
                lineBuf += decoder.decode(value, { stream: true });
                const lines = lineBuf.split("\n");
                lineBuf = lines.pop() || "";

                for (const line of lines) {
                  const content = parseDeltaContent(line);
                  if (content) {
                    auditBuffer += content;
                    totalContent += content;
                  }
                }

                // 如果当前 chunk 中检测到了模型错误信号，立即拦截
                // 不透传包含错误信号的这个 chunk，直接替换为拦截 SSE
                if (detectedModelError) {
                  interceptStream(controller);
                  return;
                }

                // 未检测到错误，正常透传原始 chunk 给调用方
                controller.enqueue(value);

                // 缓冲区满 120 字时立即送审（异步，不阻塞流传递）
                await flushAuditBuffer();
              } catch (e) {
                api.logger.error(`[${logTag}] [Output阶段-SSE/异常] 流式审核过程发生异常 | sessionId=${sessionId}, qaid=${qaid}, url=${url}, error=${e}`);
                controller.close();
              }
            },
          });

          // 返回一个新的 Response，body 替换为带审核+错误检测的转换流
          return new Response(transformedStream, {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
          });
        }
      } else {
        // ---------- 非流式响应（JSON）审核 ----------
        // clone 一份响应用于读取 body，原始响应返回给调用方
        const clonedResp = resp.clone();

        // 后台异步审核（不阻塞响应返回）
        (async () => {
          try {
            const respBody = await clonedResp.json();
            await auditOutputSlices(extractAssistantContent(respBody), "llm_response_json");
          } catch (e) {
            api.logger.error(`[${logTag}] [Output阶段-JSON/异常] JSON响应审核过程发生异常 | sessionId=${sessionId}, qaid=${qaid}, url=${url}, error=${e}`);
          }
        })();
      }
    }

    return resp;
  };

  // 替换全局 fetch
  globalThis.fetch = newFetch as typeof fetch;
};
