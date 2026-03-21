import type { FuwuhaoMessage, CallbackPayload, StreamCallback } from "./types.js";
import { onAgentEvent, type AgentEventPayload } from "../common/agent-events.js";
import { getWecomRuntime } from "../common/runtime.js";
import { buildMessageContext } from "./message-context.js";

/** 内容安全审核拦截标记，由 content-security 插件的 fetch 拦截器嵌入伪 SSE 响应中 */
const SECURITY_BLOCK_MARKER = "<!--CONTENT_SECURITY_BLOCK-->";

/** 安全拦截后返回给微信用户的通用提示文本（不暴露具体拦截原因） */
const SECURITY_BLOCK_USER_MESSAGE = "抱歉，我无法处理该任务，让我们换个任务试试看？";

// ============================================
// 工具函数
// ============================================

/**
 * 移除 LLM 输出中泄漏的 thinking 标签及其内容
 * 兼容 kimi-k2.5 等模型在 streaming 时 <think>...</think> 边界不稳定的问题
 */
const stripThinkingTags = (text: string): string => {
  return text
    .replace(/<\s*think(?:ing)?\s*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi, "")
    .replace(/<\s*\/\s*think(?:ing)?\s*>/gi, "") // 移除孤立的结束标签
    .trim();
};

// ============================================
// 消息处理器
// ============================================
// 负责处理微信服务号消息并调用 OpenClaw Agent
// 支持同步和流式两种处理模式

/**
 * 处理消息并转发给 Agent（同步模式）
 * @param message - 微信服务号的原始消息对象
 * @returns Promise<string | null> Agent 生成的回复文本，失败时返回 null
 * @description 
 * 同步处理流程：
 * 1. 提取消息基本信息（用户 ID、消息 ID、内容等）
 * 2. 构建消息上下文（调用 buildMessageContext）
 * 3. 记录会话元数据和频道活动
 * 4. 调用 Agent 处理消息（dispatchReplyWithBufferedBlockDispatcher）
 * 5. 收集 Agent 的回复（通过 deliver 回调）
 * 6. 返回最终回复文本
 * 
 * 内部关键方法：
 * - runtime.channel.session.recordSessionMetaFromInbound: 记录会话元数据
 * - runtime.channel.activity.record: 记录频道活动统计
 * - runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher: 分发消息到 Agent
 * - deliver 回调: 接收 Agent 的回复（block/tool/final 三种类型）
 */
export const handleMessage = async (message: FuwuhaoMessage): Promise<string | null> => {
  const runtime = getWecomRuntime();
  const cfg = runtime.config.loadConfig();
  
  // ============================================
  // 1. 提取消息基本信息
  // ============================================
  const content = message.Content || message.text?.content || "";
  const userId = message.FromUserName || message.userid || "unknown";
  const messageId = String(message.MsgId || message.msgid || Date.now());
  const messageType = message.msgtype || "text";
  const timestamp = message.CreateTime || Date.now();
  
  console.log("[wechat-access] 收到消息:", {
    类型: messageType,
    消息ID: messageId,
    内容: content,
    用户ID: userId,
    时间戳: timestamp
  });

  // ============================================
  // 2. 构建消息上下文
  // ============================================
  // buildMessageContext 将微信消息转换为 OpenClaw 标准格式
  // 返回：ctx（消息上下文）、route（路由信息）、storePath（存储路径）
  const { ctx, route, storePath } = buildMessageContext(message);
  
  console.log("[wechat-access] 路由信息:", {
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    accountId: route.accountId,
  });
  
  // ============================================
  // 3. 记录会话元数据
  // ============================================
  // runtime.channel.session.recordSessionMetaFromInbound 记录会话的元数据
  // 包括：最后活跃时间、消息计数、用户信息等
  // 用于会话管理、超时检测、数据统计等
  void runtime.channel.session.recordSessionMetaFromInbound({
    storePath,                                          // 会话存储路径
    sessionKey: ctx.SessionKey as string ?? route.sessionKey,  // 会话键
    ctx,                                                // 消息上下文
  }).catch((err: unknown) => {
    console.log(`[wechat-access] 记录会话元数据失败: ${String(err)}`);
  });
  
  // ============================================
  // 4. 记录频道活动统计
  // ============================================
  // runtime.channel.activity.record 记录频道的活动统计
  // 用于监控、分析、计费等场景
  runtime.channel.activity.record({
    channel: "wechat-access",      // 频道标识
    accountId: "default",    // 账号 ID
    direction: "inbound",    // 方向：inbound=入站（用户发送），outbound=出站（Bot 回复）
  });
  
  // ============================================
  // 5. 调用 OpenClaw Agent 处理消息
  // ============================================
  try {
    let responseText: string | null = null;
    
    // 获取响应前缀配置（例如：是否显示"正在思考..."等提示）
    // runtime.channel.reply.resolveEffectiveMessagesConfig 解析消息配置
    const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);
    
    console.log("[wechat-access] 开始调用 Agent...");
    
    // ============================================
    // runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher
    // 这是 OpenClaw 的核心消息分发方法
    // ============================================
    // 功能：
    // 1. 将消息发送给 Agent 进行处理
    // 2. 通过 deliver 回调接收 Agent 的回复
    // 3. 支持流式回复（block）和最终回复（final）
    // 4. 支持工具调用（tool）的结果
    // 
    // 参数说明：
    // - ctx: 消息上下文（包含用户消息、会话信息等）
    // - cfg: 全局配置
    // - dispatcherOptions: 分发器选项
    //   - responsePrefix: 响应前缀（例如："正在思考..."）
    //   - deliver: 回调函数，接收 Agent 的回复
    //   - onError: 错误处理回调
    // - replyOptions: 回复选项（可选）
    // 
    // deliver 回调的 info.kind 类型：
    // - "block": 流式分块回复（增量文本）
    // - "tool": 工具调用结果（如 read_file、write 等）
    // - "final": 最终完整回复
    const { queuedFinal } = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: messagesConfig.responsePrefix,
        deliver: async (
          payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; isError?: boolean; channelData?: unknown },
          info: { kind: string }
        ) => {
          console.log(`[wechat-access] Agent ${info.kind} 回复:`, payload, info);

          if (info.kind === "tool") {
            // ============================================
            // 工具调用结果
            // ============================================
            // Agent 调用工具（如 write、read_file 等）后的结果
            // 通常不需要直接返回给用户，仅记录日志
            console.log("[wechat-access] 工具调用结果:", payload);
          } else if (info.kind === "block") {
            // ============================================
            // 流式分块回复
            // ============================================
            // Agent 生成的增量文本（流式输出）
            // 累积到 responseText 中
            if (payload.text) {
              // 检测安全审核拦截标记：替换为通用安全提示，不暴露具体拦截原因
              if (payload.text.includes(SECURITY_BLOCK_MARKER)) {
                console.warn("[wechat-access] block 回复中检测到安全审核拦截标记，替换为安全提示");
                responseText = SECURITY_BLOCK_USER_MESSAGE;
              } else {
                responseText = payload.text;
              }
            }
          } else if (info.kind === "final") {
            // ============================================
            // 最终完整回复
            // ============================================
            // Agent 生成的完整回复文本
            // 这是最终返回给用户的内容
            if (payload.text) {
              // 检测安全审核拦截标记：替换为通用安全提示
              if (payload.text.includes(SECURITY_BLOCK_MARKER)) {
                console.warn("[wechat-access] final 回复中检测到安全审核拦截标记，替换为安全提示");
                responseText = SECURITY_BLOCK_USER_MESSAGE;
              } else {
                responseText = payload.text;
              }
            }
            console.log("[wechat-access] 最终回复:", payload);
          }

          // 记录出站活动统计（Bot 回复）
          runtime.channel.activity.record({
            channel: "wechat-access",
            accountId: "default",
            direction: "outbound",  // 出站：Bot 发送给用户
          });
        },
        onError: (err: unknown, info: { kind: string }) => {
          console.error(`[wechat-access] ${info.kind} 回复失败:`, err);
        },
      },
      replyOptions: {},
    });
    
    if (!queuedFinal) {
      console.log("[wechat-access] Agent 没有生成回复");
    }
    
    // ============================================
    // 后置处理：将结果发送到回调服务
    // ============================================
    const callbackPayload: CallbackPayload = {
      userId,
      messageId,
      messageType,
      userMessage: content,
      aiReply: responseText,
      timestamp,
      sessionKey: route.sessionKey,
      success: true,
    };
    
    // 异步发送，不阻塞返回
    // void sendToCallbackService(callbackPayload);
    
    return responseText;
  } catch (err) {
    console.error("[wechat-access] 消息分发失败:", err);
    
    // 即使失败也发送回调（带错误信息）
    const callbackPayload: CallbackPayload = {
      userId,
      messageId,
      messageType,
      userMessage: content,
      aiReply: null,
      timestamp,
      sessionKey: route.sessionKey,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
    
    // void sendToCallbackService(callbackPayload);
    
    return null;
  }
};

/**
 * 处理消息并流式返回结果（SSE 模式）
 * @param message - 微信服务号的原始消息对象
 * @param onChunk - 流式数据块回调函数，每次有新数据时调用
 * @returns Promise<void> 异步执行，通过 onChunk 回调返回数据
 * @description 
 * 流式处理流程：
 * 1. 提取消息基本信息
 * 2. 构建消息上下文
 * 3. 记录会话元数据和频道活动
 * 4. 订阅全局 Agent 事件（onAgentEvent）
 * 5. 调用 Agent 处理消息
 * 6. 通过 onChunk 回调实时推送数据
 * 7. 发送完成信号
 * 
 * 流式数据类型：
 * - block: 流式文本块（增量文本）
 * - tool_start: 工具开始执行
 * - tool_update: 工具执行中间状态
 * - tool_result: 工具执行完成
 * - final: 最终完整回复
 * - error: 错误信息
 * - done: 流式传输完成
 * 
 * 内部关键方法：
 * - runtime.events.onAgentEvent: 订阅 Agent 事件（assistant/tool/lifecycle 流）
 * - runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher: 分发消息到 Agent
 */
export const handleMessageStream = async (
  message: FuwuhaoMessage,
  onChunk: StreamCallback
): Promise<void> => {
  const runtime = getWecomRuntime();
  const cfg = runtime.config.loadConfig();
  
  // ============================================
  // 1. 提取消息基本信息
  // ============================================
  const content = message.Content || message.text?.content || "";
  const userId = message.FromUserName || message.userid || "unknown";
  const messageId = String(message.MsgId || message.msgid || Date.now());
  const messageType = message.msgtype || "text";

  console.log("[wechat-access] 流式处理消息:", {
    类型: messageType,
    消息ID: messageId,
    内容: content,
    用户ID: userId,
  });

  // ============================================
  // 2. 构建消息上下文
  // ============================================
  const { ctx, route, storePath } = buildMessageContext(message);
  
  // ============================================
  // 3. 记录会话元数据
  // ============================================
  void runtime.channel.session.recordSessionMetaFromInbound({
    storePath,
    sessionKey: ctx.SessionKey as string ?? route.sessionKey,
    ctx,
  }).catch((err: unknown) => {
    console.log(`[wechat-access] 记录会话元数据失败: ${String(err)}`);
  });
  
  // ============================================
  // 4. 记录频道活动统计
  // ============================================
  runtime.channel.activity.record({
    channel: "wechat-access",
    accountId: "default",
    direction: "inbound",
  });
  
  // ============================================
  // 5. 订阅全局 Agent 事件
  // ============================================
  // runtime.events.onAgentEvent 订阅 Agent 运行时产生的所有事件
  // 用于捕获流式文本、工具调用、生命周期等信息
  // 
  // 事件流类型：
  // - assistant: 助手流（流式文本输出）
  // - tool: 工具流（工具调用的各个阶段）
  // - lifecycle: 生命周期流（start/end/error 等）
  console.log("[wechat-access] 注册 onAgentEvent 监听器...");
  let lastEmittedText = ""; // 用于去重，只发送增量文本
  
const unsubscribeAgentEvents = onAgentEvent((evt: AgentEventPayload) => {
    // 记录所有事件（调试用）
    console.log(`[wechat-access] 收到 AgentEvent: stream=${evt.stream}, runId=${evt.runId}`);
    
    const data = evt.data as Record<string, unknown>;
    
    // ============================================
    // 处理流式文本（assistant 流）
    // ============================================
    // evt.stream === "assistant" 表示这是助手的文本输出流
    // data.delta: 增量文本（新增的部分）
    // data.text: 累积文本（从开始到现在的完整文本）
    if (evt.stream === "assistant") {
      const delta = data.delta as string | undefined;
      const text = data.text as string | undefined;
      
      // 优先使用 delta（增量文本），如果没有则计算增量
      let textToSend = delta;
      if (!textToSend && text && text !== lastEmittedText) {
        // 计算增量：新文本 - 已发送文本
        textToSend = text.slice(lastEmittedText.length);
        lastEmittedText = text;
      } else if (delta) {
        lastEmittedText += delta;
      }
      
      // 检测安全审核拦截标记：流式文本中包含拦截标记时，停止继续推送
      if (textToSend && textToSend.includes(SECURITY_BLOCK_MARKER)) {
        console.warn("[wechat-access] 流式文本中检测到安全审核拦截标记，停止推送");
        return;
      }
      if (lastEmittedText.includes(SECURITY_BLOCK_MARKER)) {
        console.warn("[wechat-access] 累积文本中检测到安全审核拦截标记，停止推送");
        return;
      }

      if (textToSend) {
        const cleanedText = stripThinkingTags(textToSend);
        if (!cleanedText) return; // 过滤后为空则跳过
        console.log(`[wechat-access] 流式文本:`, cleanedText.slice(0, 50) + (cleanedText.length > 50 ? "..." : ""));
        // 通过 onChunk 回调发送增量文本
        onChunk({
          type: "block",
          text: cleanedText,
          timestamp: evt.ts,
        });
      }
      return;
    }
    
    // ============================================
    // 处理工具调用事件（tool 流）
    // ============================================
    // evt.stream === "tool" 表示这是工具调用流
    // data.phase: 工具调用的阶段（start/update/result）
    // data.name: 工具名称（如 read_file、write 等）
    // data.toolCallId: 工具调用 ID（用于关联同一次调用的多个事件）
    if (evt.stream === "tool") {
      const phase = data.phase as string | undefined;
      const toolName = data.name as string | undefined;
      const toolCallId = data.toolCallId as string | undefined;
      
      console.log(`[wechat-access] 工具事件 [${phase}]:`, toolName, toolCallId);
      
      if (phase === "start") {
        // ============================================
        // 工具开始执行
        // ============================================
        // 发送工具开始事件，包含工具名称和参数
        onChunk({
          type: "tool_start",
          toolName,
          toolCallId,
          toolArgs: data.args as Record<string, unknown> | undefined,
          toolMeta: data.meta as Record<string, unknown> | undefined,
          timestamp: evt.ts,
        });
      } else if (phase === "update") {
        // ============================================
        // 工具执行中间状态更新
        // ============================================
        // 某些工具（如长时间运行的任务）会发送中间状态
        onChunk({
          type: "tool_update",
          toolName,
          toolCallId,
          text: data.text as string | undefined,
          toolMeta: data.meta as Record<string, unknown> | undefined,
          timestamp: evt.ts,
        });
      } else if (phase === "result") {
        // ============================================
        // 工具执行完成
        // ============================================
        // 发送工具执行结果，包含返回值和是否出错
        onChunk({
          type: "tool_result",
          toolName,
          toolCallId,
          text: data.result as string | undefined,
          isError: data.isError as boolean | undefined,
          toolMeta: data.meta as Record<string, unknown> | undefined,
          timestamp: evt.ts,
        });
      }
      return;
    }
    
    // ============================================
    // 处理生命周期事件（lifecycle 流）
    // ============================================
    // evt.stream === "lifecycle" 表示这是生命周期事件
    // data.phase: 生命周期阶段（start/end/error）
    if (evt.stream === "lifecycle") {
      const phase = data.phase as string | undefined;
      console.log(`[wechat-access] 生命周期事件 [${phase}]`);
      // 可以在这里处理 start/end/error 事件，例如：
      // if (phase === "error") { 
      //   onChunk({ type: "error", text: data.error as string, timestamp: evt.ts }); 
      // }
    }
  });
  
  try {
    // 获取响应前缀配置
    const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);
    
    console.log("[wechat-access] 开始流式调用 Agent...");
    console.log("[wechat-access] ctx:", JSON.stringify(ctx));
    
    const dispatchResult = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: messagesConfig.responsePrefix,
        deliver: async (
          payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; isError?: boolean; channelData?: unknown },
          info: { kind: string }
        ) => {
          console.log(`[wechat-access] 流式 ${info.kind} 回复:`, payload, info);

          if (info.kind === "tool") {
            // 工具调用结果
            onChunk({
              type: "tool",
              text: payload.text,
              isError: payload.isError,
              timestamp: Date.now(),
            });
          } else if (info.kind === "block") {
            // 流式分块回复
            // 检测安全审核拦截标记：替换为通用安全提示
            let blockText = payload.text ? stripThinkingTags(payload.text) : payload.text;
            if (blockText && blockText.includes(SECURITY_BLOCK_MARKER)) {
              console.warn("[wechat-access] 流式 block deliver 中检测到安全审核拦截标记，替换为安全提示");
              blockText = SECURITY_BLOCK_USER_MESSAGE;
            }
            onChunk({
              type: "block",
              text: blockText,
              timestamp: Date.now(),
            });
          } else if (info.kind === "final") {
            // 最终完整回复
            // 检测安全审核拦截标记：替换为通用安全提示
            let finalText = payload.text ? stripThinkingTags(payload.text) : payload.text;
            if (finalText && finalText.includes(SECURITY_BLOCK_MARKER)) {
              console.warn("[wechat-access] 流式 final deliver 中检测到安全审核拦截标记，替换为安全提示");
              finalText = SECURITY_BLOCK_USER_MESSAGE;
            }
            onChunk({
              type: "final",
              text: finalText,
              timestamp: Date.now(),
            });
          }

          // 记录出站活动
          runtime.channel.activity.record({
            channel: "wechat-access",
            accountId: "default",
            direction: "outbound",
          });
        },
        onError: (err: unknown, info: { kind: string }) => {
          console.error(`[wechat-access] 流式 ${info.kind} 回复失败:`, err);
          onChunk({
            type: "error",
            text: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          });
        },
      },
      replyOptions: {},
    });
    
    console.log("[wechat-access] dispatchReplyWithBufferedBlockDispatcher 完成, 结果:", dispatchResult);
    
    // 取消订阅 Agent 事件
    unsubscribeAgentEvents();
    
    // 发送完成信号
    onChunk({
      type: "done",
      timestamp: Date.now(),
    });
    
  } catch (err) {
    // 确保在异常时也取消订阅
    unsubscribeAgentEvents();
    console.error("[wechat-access] 流式消息分发失败:", err);
    onChunk({
      type: "error",
      text: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    });
  }
};
