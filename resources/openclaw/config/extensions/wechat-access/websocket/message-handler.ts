/**
 * @file message-handler.ts
 * @description WebSocket 消息处理器
 *
 * 负责处理从 AGP 服务端收到的下行消息，核心流程：
 *   1. 收到 session.prompt → 调用 OpenClaw Agent 处理用户指令
 *   2. 通过 runtime.events.onAgentEvent 监听 Agent 的流式输出
 *   3. 将流式输出实时通过 WebSocket 推送给服务端（session.update）
 *   4. Agent 处理完成后发送最终结果（session.promptResponse）
 *   5. 收到 session.cancel → 中断正在处理的 Turn
 */

import type {
  PromptMessage,
  CancelMessage,
  ContentBlock,
  ToolCall,
} from '@tencent/agp-native'
import { AgpWebSocketClient, ConnectionState } from '@tencent/agp-native'
import { onAgentEvent, type AgentEventPayload } from '../common/agent-events.js'
import { sendPromptResponseReliable } from './terminal-response-queue.js'

/** 安全拦截标记，由 content-security 的 fetch 拦截器嵌入伪 SSE 响应中 */
const SECURITY_BLOCK_MARKER = '<!--REDACT-->'

/** 安全拦截后返回给微信用户的通用提示文本（不暴露具体拦截原因） */
const SECURITY_BLOCK_USER_MESSAGE =
  '抱歉，我无法处理该任务，让我们换个任务试试看？'

/** Agent 处理完成但回复为空时的兜底提示 */
const EMPTY_REPLY_USER_MESSAGE =
  '抱歉，我暂时无法回答这个问题，请稍后再试～'

/** Agent 处理异常时返回给微信用户的错误提示 */
const ERROR_REPLY_USER_MESSAGE =
  '处理消息时遇到了问题，请稍后重试。'

/** 排队超时后返回给微信用户的提示 */
const QUEUED_TIMEOUT_USER_MESSAGE =
  '当前排队任务较多，处理超时了，请稍后再试～'

/**
 * 微信单条文本消息的安全长度上限（字符数）。
 * 微信文本消息的硬限制约为 2048 字符，这里留一些余量。
 */
const WECHAT_TEXT_MAX_LENGTH = 1800

/**
 * 将长文本按段落智能分割成多条消息，适配微信单条消息长度限制。
 *
 * 分割策略（优先级从高到低）：
 *   1. 按 Markdown 标题（## / ### 等）分段
 *   2. 按空行分段
 *   3. 按单行强制截断（极端情况）
 *
 * @param text - 待分割的文本
 * @param maxLength - 每段最大字符数，默认 WECHAT_TEXT_MAX_LENGTH
 * @returns 分割后的文本数组，每段不超过 maxLength 字符
 */
function splitLongText(
  text: string,
  maxLength: number = WECHAT_TEXT_MAX_LENGTH
): string[] {
  // 短文本无需分割
  if (text.length <= maxLength) {
    return [text]
  }

  const result: string[] = []

  // 按 Markdown 标题（##、### 等）或空行分段
  // 匹配标题行或连续空行作为分割点
  const paragraphs = text.split(/\n(?=#{1,6}\s)|\n{2,}/)

  let currentChunk = ''

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim()
    if (!trimmedParagraph) continue

    // 如果当前段落本身就超长，按行强制截断
    if (trimmedParagraph.length > maxLength) {
      // 先把之前累积的内容推入结果
      if (currentChunk.trim()) {
        result.push(currentChunk.trim())
        currentChunk = ''
      }
      // 按行分割超长段落
      const lines = trimmedParagraph.split('\n')
      let lineChunk = ''
      for (const line of lines) {
        if (lineChunk && (lineChunk + '\n' + line).length > maxLength) {
          result.push(lineChunk.trim())
          lineChunk = line
        } else {
          lineChunk = lineChunk ? lineChunk + '\n' + line : line
        }
      }
      if (lineChunk.trim()) {
        currentChunk = lineChunk
      }
      continue
    }

    // 尝试把段落追加到当前块
    const separator = currentChunk ? '\n\n' : ''
    if ((currentChunk + separator + trimmedParagraph).length > maxLength) {
      // 超出限制，先推入当前块，开始新块
      if (currentChunk.trim()) {
        result.push(currentChunk.trim())
      }
      currentChunk = trimmedParagraph
    } else {
      currentChunk = currentChunk + separator + trimmedParagraph
    }
  }

  // 推入最后一块
  if (currentChunk.trim()) {
    result.push(currentChunk.trim())
  }

  return result.length > 0 ? result : [text]
}

/**
 * `getWecomRuntime` 返回 OpenClaw 框架注入的运行时实例（PluginRuntime）。
 * 运行时提供了访问框架核心功能的统一入口，包括：
 *   - runtime.config.loadConfig()：读取 openclaw 配置文件（~/.openclaw/config.json）
 *   - runtime.events.onAgentEvent()：订阅 Agent 运行时事件（流式输出、工具调用等）
 *   - runtime.channel.session：会话元数据管理（记录用户会话信息）
 *   - runtime.channel.activity：渠道活动统计（记录收发消息次数）
 *   - runtime.channel.reply：消息回复调度（调用 Agent 并分发回复）
 */
import { getWecomRuntime } from '../common/runtime.js'
import { invokeReportData } from '../common/report-data.js'
import { buildWebSocketMessageContext } from './message-adapter.js'

// ============================================
// WebSocket 消息处理器
// ============================================
// 接收 AGP 下行消息 → 调用 OpenClaw Agent → 发送 AGP 上行消息

/**
 * 活跃的 Prompt Turn 追踪器
 * @description
 * 每个正在处理中的用户请求（Turn）都会在 activeTurns Map 中注册一条记录。
 * 用于支持取消操作：收到 session.cancel 时，通过 promptId 找到对应的 Turn，
 * 将其标记为已取消，并取消 Agent 事件订阅。
 */
interface ActiveTurn {
  sessionId: string
  promptId: string
  /** 是否已被取消（标志位，Agent 事件回调中检查此值决定是否继续处理） */
  cancelled: boolean
  /** 是否因安全拦截而取消（区分用户主动取消和安全拦截取消） */
  securityBlocked: boolean
  /**
   * Agent 事件取消订阅函数。
   * `runtime.events.onAgentEvent()` 返回一个函数，调用该函数可以取消订阅，
   * 停止接收后续的 Agent 事件（类似 EventEmitter 的 removeListener）。
   */
  unsubscribe?: () => void
}

/**
 * 当前活跃的 Turn 映射（promptId → ActiveTurn）
 * @description
 * 使用 Map 而非对象，因为 Map 的 key 可以是任意类型，且有更好的增删性能。
 * promptId 是服务端分配的唯一 Turn ID，用于关联 prompt 和 cancel 消息。
 */
const activeTurns = new Map<string, ActiveTurn>()

/**
 * 互斥标志：标记当前是否有 handlePrompt 正在执行中。
 * 使用独立的 isBusy 标志，在 handlePrompt 入口处同步设置、在 finally 中同步清除，
 * 确保忙碌检测在整个 handlePrompt 生命周期内可靠生效。
 */
let isBusy = false

const formatConnectionState = (state: ConnectionState): string => {
  switch (state) {
    case ConnectionState.Connected:
      return 'Connected'
    case ConnectionState.Connecting:
      return 'Connecting'
    case ConnectionState.Reconnecting:
      return 'Reconnecting'
    default:
      return 'Disconnected'
  }
}

const getClientStateLabel = (client: AgpWebSocketClient): string => {
  return formatConnectionState(client.getState())
}

const trySendRealtimeUpdate = (
  client: AgpWebSocketClient,
  label: string,
  send: () => void
): boolean => {
  try {
    send()
    return true
  } catch (err) {
    console.warn(
      `[wechat-access-ws] ${label} 发送失败，跳过本次实时更新: state=${getClientStateLabel(client)}`,
      err
    )
    return false
  }
}

const mergeOverlappedReplyText = (
  current: string,
  next: string
): string | null => {
  const max = Math.min(current.length, next.length)
  for (let size = max; size > 0; size -= 1) {
    if (current.endsWith(next.slice(0, size))) {
      return `${current}${next.slice(size)}`
    }
  }
  return null
}

const mergeFinalReplyText = (
  current: string | null,
  next: string
): string => {
  if (!current) return next
  if (!next) return current
  if (current === next) return current
  if (next.startsWith(current)) return next
  if (current.startsWith(next)) return current

  const merged = mergeOverlappedReplyText(current, next)
  if (merged) return merged

  const trimmedCurrent = current.trim()
  const trimmedNext = next.trim()
  const bothTokenLike =
    /^[A-Z_]+$/.test(trimmedCurrent) && /^[A-Z_]+$/.test(trimmedNext)
  const punctLike = /^[!！?？,，.。:：;；、_)}\]】）》」』]+/
  const nextWithoutLeadingSpace = next.replace(/^\s+/, '')

  if (bothTokenLike) {
    return `${current}${nextWithoutLeadingSpace}`
  }

  if (punctLike.test(trimmedNext)) {
    return `${current.replace(/\s+$/, '')}${nextWithoutLeadingSpace}`
  }

  return `${current}${next}`
}

/**
 * 处理 session.prompt 消息 — 接收用户指令并调用 Agent
 * @param message - AGP session.prompt 消息（包含用户指令内容）
 * @param client - WebSocket 客户端实例（用于发送上行消息回服务端）
 * @description
 * 完整处理流程：
 *
 * ```
 * 服务端 → session.prompt
 *   ↓
 * 1. 注册 ActiveTurn（支持后续取消）
 *   ↓
 * 2. getWecomRuntime() 获取运行时
 *   ↓
 * 3. runtime.config.loadConfig() 读取配置
 *   ↓
 * 4. buildWebSocketMessageContext() 构建消息上下文（路由、会话路径等）
 *   ↓
 * 5. runtime.channel.session.recordSessionMetaFromInbound() 记录会话元数据
 *   ↓
 * 6. runtime.channel.activity.record() 记录入站活动统计
 *   ↓
 * 7. runtime.events.onAgentEvent() 订阅 Agent 流式事件
 *   ↓
 * 8. runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher() 调用 Agent
 *   ↓ （Agent 运行期间，步骤 7 的回调持续触发）
 *   ├── assistant 流 → client.sendMessageChunk() → session.update(message_chunk)
 *   └── tool 流 → client.sendToolCall/sendToolCallUpdate() → session.update(tool_call)
 *   ↓
 * 9. client.sendPromptResponse() → session.promptResponse（最终结果）
 * ```
 */
export const handlePrompt = async (
  message: PromptMessage,
  client: AgpWebSocketClient
): Promise<void> => {
  const { payload } = message
  const { session_id: sessionId, prompt_id: promptId } = payload
  const userId = message.user_id ?? ''
  const guid = message.guid ?? ''
  const traceId =
    (message as PromptMessage & { extra?: { trace_id?: string } }).extra
      ?.trace_id ?? ''
  const turnTag = `${sessionId.slice(0, 8)}/${promptId.slice(0, 8)}`

  //message {
  //   msg_id: '9b842a47-c07d-4307-974f-42a4f8eeecb4',
  //       guid: '0ef9cc5e5dcb7ca068b0fb9982352c33',
  //       user_id: '3730000',
  //       method: 'session.prompt',
  //       payload: {
  //     session_id: '384f885b-4387-4f2b-9233-89a5fe6f94ee',
  //         prompt_id: 'ca694ac8-35e3-4e8b-9ecc-88efd4324515',
  //         agent_app: 'agent_demo',
  //         content: [ [Object] ]
  //   }
  // }
  console.log('[wechat-access-ws] 收到 prompt:', {
    turnTag,
    msgId: message.msg_id,
    sessionId,
    promptId,
    guid,
    userId,
    traceId,
    state: getClientStateLabel(client),
    contentBlocks: payload.content?.length ?? 0,
  })

  // ============================================
  // 0. 忙碌检测：同一时间只处理一条消息
  // ============================================
  // 使用 isBusy 互斥标志（而非 activeTurns.size）进行检测。
  // isBusy 在 handlePrompt 入口处同步设置，在 finally 中同步清除，
  // 覆盖整个异步处理生命周期，避免以下竞态：
  //   - AGP 服务端在收到 promptResponse 后立刻下发下一条 session.prompt
  //   - 新消息的 onPrompt 回调在 finally 清理代码之前执行
  //   - activeTurns 已被 delete 但 onAgentEvent 监听器尚未 unsubscribe
  if (isBusy) {
    const busyTurn = activeTurns.values().next().value
    console.log(
      `[wechat-access-ws] 当前有任务正在执行中，拒绝新消息 (新 promptId: ${promptId}, 正在执行的 promptId: ${busyTurn?.promptId ?? 'unknown'})`
    )
    sendPromptResponseReliable({
      client,
      label: `${turnTag} busy_response(${promptId})`,
      payload: {
        session_id: sessionId,
        prompt_id: promptId,
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: '⏳ 上一条消息正在处理中，请耐心等待处理完成后再发送新消息~',
          },
        ],
      },
      guid,
      userId,
    })
    return
  }

  // ============================================
  // 1. 设置互斥标志并注册活跃 Turn
  // ============================================
  // 同步设置 isBusy = true，确保后续到达的消息被忙碌检测拦住
  isBusy = true
  const turn: ActiveTurn = {
    sessionId,
    promptId,
    cancelled: false,
    securityBlocked: false,
  }
  activeTurns.set(promptId, turn)

  try {
    /**
     * getWecomRuntime() 返回 OpenClaw 框架的运行时实例（PluginRuntime）。
     * 这是一个单例，在插件初始化时由 setWecomRuntime(api.runtime) 注入。
     * 如果未初始化就调用会抛出错误。
     */
    const runtime = getWecomRuntime()

    /**
     * runtime.config.loadConfig() 同步读取 OpenClaw 配置文件。
     * 配置文件通常位于 ~/.openclaw/config.json，包含：
     *   - Agent 配置（模型、系统提示词等）
     *   - 渠道配置（各渠道的账号信息）
     *   - 会话存储路径等
     * 返回的 cfg 对象在后续的 dispatchReplyWithBufferedBlockDispatcher 中使用。
     */
    const cfg = runtime.config.loadConfig()

    // ============================================
    // 2. 构建消息上下文
    // ============================================
    /**
     * buildWebSocketMessageContext() 将 AGP 消息转换为 OpenClaw 内部的消息上下文格式。
     * 返回值包含：
     *   - ctx: MsgContext — 消息上下文（包含 From、To、SessionKey、AgentId 等字段）
     *   - route: 路由信息（agentId、accountId、sessionKey 等）
     *   - storePath: 会话存储文件路径（如 ~/.openclaw/sessions/agent-xxx.json）
     *
     * 这样可以复用 HTTP 通道的路由和会话管理逻辑，保持一致性。
     */
    const { ctx, route, storePath } = buildWebSocketMessageContext(
      payload,
      userId
    )

    // ============================================
    // 2.5 传递上报维度字段给 content-security
    // ============================================
    // 在调用 Agent 之前，先将 traceId、guid、uid 传递给 content-security，
    // 确保 content-security 的 before_agent_start / llm_input 等 hook 能获取到正确的维度字段。
    // 这等价于 Electron 客户端通过 WebSocket 调用 report.data 的效果。
    invokeReportData({
      trace_id: traceId,
      guid,
      uid: userId,
      source_terminal: 'wechat',
      prompt_id: promptId,
      wechat_session_id: sessionId,
    })

    // ============================================
    // 3. 记录会话元数据
    // ============================================
    /**
     * runtime.channel.session.recordSessionMetaFromInbound() 将本次消息的元数据
     * 写入会话存储文件（storePath 指向的 JSON 文件）。
     * 元数据包括：用户 ID、渠道类型、最后活跃时间等。
     * 这些数据用于会话管理、上下文恢复等功能。
     *
     * 使用 void + .catch() 的原因：
     *   - void: 明确表示不等待此 Promise（不阻塞主流程）
     *   - .catch(): 捕获错误并打印日志，避免未处理的 Promise rejection
     * 会话元数据写入失败不影响消息处理，所以不需要 await。
     */
    void runtime.channel.session
      .recordSessionMetaFromInbound({
        storePath,
        sessionKey: (ctx.SessionKey as string) ?? route.sessionKey,
        ctx,
      })
      .catch((err: unknown) => {
        console.log(`[wechat-access-ws] 记录会话元数据失败: ${String(err)}`)
      })

    // ============================================
    // 4. 记录入站活动
    // ============================================
    /**
     * runtime.channel.activity.record() 记录渠道活动统计数据。
     * direction: "inbound" 表示这是一条收到的消息（用户 → 系统）。
     * 这些统计数据用于 OpenClaw 控制台的活动监控面板。
     */
    runtime.channel.activity.record({
      channel: 'wechat-access',
      accountId: route.accountId ?? 'default',
      direction: 'inbound',
    })

    // ============================================
    // 5. 订阅 Agent 事件（流式输出）
    // ============================================
    /**
     * runtime.events.onAgentEvent() 注册一个全局 Agent 事件监听器。
     * 当 Agent 运行时，会通过事件总线（EventEmitter）广播各种事件。
     *
     * AgentEventPayload 结构：
     * {
     *   runId: string;      // Agent 运行实例 ID
     *   seq: number;        // 事件序号（严格递增，用于检测丢失事件）
     *   stream: string;     // 事件流类型（见下方说明）
     *   ts: number;         // 时间戳（毫秒）
     *   data: Record<string, unknown>; // 事件数据（不同 stream 有不同结构）
     *   sessionKey?: string; // 关联的会话 key
     * }
     *
     * stream 类型说明：
     *   - "assistant": AI 助手的文本输出流
     *     data.delta: 增量文本（本次新增的部分）
     *     data.text: 累积文本（从开始到现在的完整文本）
     *   - "tool": 工具调用流
     *     data.phase: 阶段（"start" | "update" | "result"）
     *     data.name: 工具名称（如 "read_file"、"write"）
     *     data.toolCallId: 工具调用唯一 ID
     *     data.args: 工具参数（phase=start 时）
     *     data.result: 工具执行结果（phase=result 时）
     *     data.isError: 是否执行失败（phase=result 时）
     *   - "lifecycle": 生命周期事件（start/end/error）
     *   - "compaction": 上下文压缩事件
     *
     * 返回值是取消订阅函数，调用后停止接收事件。
     * 注意：这是全局事件总线，所有 Agent 运行的事件都会触发此回调，
     * 需要通过 runId 过滤，确保只处理属于当前 Turn 的事件。
     */
    let lastEmittedText = '' // 记录已发送的累积文本，用于计算增量
    let toolCallCounter = 0 // 工具调用计数器，用于生成备用 toolCallId
    let assistantChunkCount = 0
    let toolEventCount = 0
    let finalDeliverCount = 0

    /**
     * 当前 Turn 对应的 Agent runId。
     * 由 lifecycle.start 事件设置，用于过滤后续 assistant/tool 事件。
     * 在 runId 捕获前（lifecycle.start 之前的事件），仅通过 sessionKey 过滤。
     */
    let turnRunId: string | null = null

    /**
     * dispatch 是否已返回。用于排队场景下的事件过滤。
     * 当 dispatchReplyWithBufferedBlockDispatcher 返回后设为 true。
     * 如果此时 turnRunId 仍为 null（消息被排队），则忽略非 lifecycle 事件，
     * 直到排队 run 的 lifecycle.start 到来设置新的 turnRunId。
     */
    let dispatchReturned = false

    /**
     * 排队等待回调：当消息被框架排队后，dispatchReplyWithBufferedBlockDispatcher
     * 会立即返回。我们通过此回调等待框架自动启动的 Agent run 完成。
     * lifecycle.end/error 事件会调用此回调，使 handlePrompt 知道何时发送最终响应。
     *
     * followup 模式下，框架为每条排队消息独立启动 Agent run，
     * 因此只需等待属于当前 handler 的 lifecycle.start → lifecycle.end 即可。
     */
    let resolveQueuedWait: (() => void) | null = null

    // 通过 PluginRuntime.events.onAgentEvent 注册全局事件监听器
    // 必须在 dispatchReply 之前注册，否则 Agent 产生的事件会丢失
    const unsubscribe = onAgentEvent((evt: AgentEventPayload) => {
      // 如果 Turn 已被取消，忽略后续事件（不再向服务端推送）
      if (turn.cancelled) return
      // 过滤非本 Turn 的事件，避免并发多个 prompt 时事件串流
      if (evt.sessionKey && evt.sessionKey !== route.sessionKey) return

      // --- 处理 lifecycle 事件 ---
      if (evt.stream === 'lifecycle') {
        const data = evt.data as Record<string, unknown>

        // 捕获 lifecycle.start 事件中的 runId
        if (data.phase === 'start' && evt.runId) {
          if (!turnRunId && !dispatchReturned) {
            // 正常场景：dispatch 还没返回，这是框架为当前 Prompt 启动的 run
            turnRunId = evt.runId
            console.log(
              `[wechat-access-ws] 捕获 runId: ${turnRunId} (promptId: ${promptId})`
            )
          } else if (dispatchReturned && !turnRunId) {
            // 排队场景（followup 模式）：dispatch 已返回但 turnRunId 未捕获，
            // 框架为当前排队消息启动了独立的 Agent run → 捕获 runId
            turnRunId = evt.runId
            lastEmittedText = ''
            toolCallCounter = 0
            console.log(
              `[wechat-access-ws] 排队 run 捕获 runId: ${turnRunId} (promptId: ${promptId})`
            )
          }
        }

        // 检测 lifecycle.end/error → 通知排队等待
        if (data.phase === 'end' || data.phase === 'error') {
          if (resolveQueuedWait && turnRunId && evt.runId === turnRunId) {
            // 当前 handler 的排队 run 已完成 → resolve 等待
            console.log(
              `[wechat-access-ws] 排队的 Agent run ${data.phase} (runId: ${evt.runId}, promptId: ${promptId})`
            )
            const resolve = resolveQueuedWait
            resolveQueuedWait = null
            setTimeout(() => resolve(), 300)
          }
        }

        return
      }

      // --- 排队场景的事件过滤 ---
      // dispatch 已返回但 turnRunId 尚未捕获（lifecycle.start 还没到来），
      // 此时的事件属于其他 prompt 的 Agent run，应忽略
      if (dispatchReturned && !turnRunId) return

      // --- 基于 runId 过滤事件 ---
      // 如果已捕获 runId，严格匹配；避免并发 prompt 时事件串流
      if (turnRunId && evt.runId && evt.runId !== turnRunId) return

      const data = evt.data as Record<string, unknown>

      // --- 处理流式文本（assistant 流）---
      if (evt.stream === 'assistant') {
        /**
         * Agent 生成文本时，事件总线会持续触发 assistant 流事件。
         * 每个事件包含：
         *   - data.delta: 本次新增的文本片段（增量）
         *   - data.text: 从开始到现在的完整文本（累积）
         *
         * 优先使用 delta（增量），因为它直接就是需要发送的内容。
         * 如果没有 delta（某些 AI 提供商只提供累积文本），
         * 则通过 text.slice(lastEmittedText.length) 手动计算增量。
         */
        const delta = data.delta as string | undefined
        const text = data.text as string | undefined

        let textToSend = delta
        if (!textToSend && text && text !== lastEmittedText) {
          // 手动计算增量：新的累积文本 - 已发送的累积文本 = 本次增量
          textToSend = text.slice(lastEmittedText.length)
          lastEmittedText = text
        } else if (delta) {
          lastEmittedText += delta
        }

        // 检测安全审核拦截标记：如果流式文本中包含拦截标记，停止向用户推送
        // 拦截标记由 content-security 的 fetch 拦截器注入伪 SSE 响应
        if (textToSend && textToSend.includes(SECURITY_BLOCK_MARKER)) {
          console.warn(
            '[wechat-access-ws] 流式文本中检测到安全审核拦截标记，停止推送'
          )
          turn.cancelled = true
          turn.securityBlocked = true
          return
        }
        if (lastEmittedText.includes(SECURITY_BLOCK_MARKER)) {
          console.warn(
            '[wechat-access-ws] 累积文本中检测到安全审核拦截标记，停止推送'
          )
          turn.cancelled = true
          turn.securityBlocked = true
          return
        }

        if (textToSend) {
          assistantChunkCount += 1
        }
        // 注意：不通过 session.update（sendMessageChunk）推送流式文本给服务端。
        // 服务端（AGP）将 promptResponse.content 作为最终回复推送给微信用户，
        // 如果同时发送 session.update 和 promptResponse，用户会收到重复消息。
        // 此处仅累积 lastEmittedText，供安全检测和最终 promptResponse 使用。
        return
      }

      // --- 处理工具调用事件（tool 流）---
      if (evt.stream === 'tool') {
        toolEventCount += 1
        /**
         * 工具调用有三个阶段（phase）：
         *   - "start": 工具开始执行（发送 tool_call，status=in_progress）
         *   - "update": 工具执行中有中间结果（发送 tool_call_update，status=in_progress）
         *   - "result": 工具执行完成（发送 tool_call_update，status=completed/failed）
         *
         * toolCallId 是工具调用的唯一标识，用于关联同一次工具调用的多个事件。
         * 如果 Agent 没有提供 toolCallId，则用计数器生成一个备用 ID。
         */
        const phase = data.phase as string | undefined
        const toolName = data.name as string | undefined
        const toolCallId =
          (data.toolCallId as string) || `tc-${++toolCallCounter}`

        if (phase === 'start') {
          // 工具开始执行：通知服务端展示工具调用状态（进行中）
          const toolCall: ToolCall = {
            tool_call_id: toolCallId,
            title: toolName,
            kind: mapToolKind(toolName), // 根据工具名推断工具类型（read/edit/search 等）
            status: 'in_progress',
          }
          trySendRealtimeUpdate(client, `${turnTag} tool_call(${toolCallId})`, () => {
            client.sendToolCall(sessionId, promptId, toolCall, guid, userId)
          })
        } else if (phase === 'update') {
          // 工具执行中有中间结果（如读取文件的部分内容）
          const toolCall: ToolCall = {
            tool_call_id: toolCallId,
            title: toolName,
            status: 'in_progress',
            content: data.text
              ? [{ type: 'text' as const, text: data.text as string }]
              : undefined,
          }
          trySendRealtimeUpdate(client, `${turnTag} tool_call_update(${toolCallId})`, () => {
            client.sendToolCallUpdate(
              sessionId,
              promptId,
              toolCall,
              guid,
              userId
            )
          })
        } else if (phase === 'result') {
          // 工具执行完成：更新状态为 completed 或 failed
          const isError = data.isError as boolean | undefined
          const toolCall: ToolCall = {
            tool_call_id: toolCallId,
            title: toolName,
            status: isError ? 'failed' : 'completed',
            // 将工具执行结果作为内容块附加（可选，用于展示）
            // data.result 可能是对象（如 web_fetch 返回），Rust 层要求 text 必须是纯字符串
            content: data.result
              ? [{ type: 'text' as const, text: typeof data.result === 'string' ? data.result : JSON.stringify(data.result) }]
              : undefined,
          }
          trySendRealtimeUpdate(client, `${turnTag} tool_call_result(${toolCallId})`, () => {
            client.sendToolCallUpdate(
              sessionId,
              promptId,
              toolCall,
              guid,
              userId
            )
          })
        }
        return
      }
    })

    // 将取消订阅函数保存到 Turn 记录中，以便 handleCancel 调用
    turn.unsubscribe = unsubscribe
    console.log('[wechat-access-ws] turn 监听已挂载:', {
      turnTag,
      sessionKey: route.sessionKey,
      accountId: route.accountId,
      state: getClientStateLabel(client),
    })

    // ============================================
    // 6. 调用 Agent 处理消息
    // ============================================
    /**
     * runtime.channel.reply.resolveEffectiveMessagesConfig() 解析当前 Agent 的消息配置。
     * 返回值包含：
     *   - responsePrefix: 回复前缀（如果配置了的话）
     *   - 其他消息格式配置
     * 参数 route.agentId 指定要查询哪个 Agent 的配置。
     */
    const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(
      cfg,
      route.agentId
    )

    let finalText: string | null = null
    const finalTextCandidates: string[] = []

    /**
     * runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher() 是核心调用。
     * 它完成以下工作：
     *   1. 根据 ctx（消息上下文）和 cfg（配置）确定使用哪个 Agent
     *   2. 加载该 Agent 的历史会话记录（上下文）
     *   3. 调用 AI 模型生成回复（流式）
     *   4. 在生成过程中，通过事件总线广播 assistant/tool 流事件（步骤 5 的回调会收到）
     *   5. 将生成的回复通过 dispatcherOptions.deliver 回调交付
     *   6. 保存本次对话到会话历史
     *
     * "BufferedBlockDispatcher" 的含义：
     *   - Buffered: 将流式输出缓冲后再交付（避免过于频繁的回调）
     *   - Block: 按块（段落/句子）分割回复
     *   - Dispatcher: 负责将回复分发给 deliver 回调
     *
     * 返回值 { queuedFinal } 包含最终排队的回复内容（此处未使用，通过 deliver 回调获取）。
     *
     * 注意：此函数是 async 的，会等待 Agent 完全处理完毕才 resolve。
     * 在等待期间，步骤 5 注册的 onAgentEvent 回调会持续被触发（流式推送）。
     */
    console.log('[wechat-access-ws] turn 开始 dispatch:', {
      turnTag,
      sessionKey: route.sessionKey,
      agentId: route.agentId,
      state: getClientStateLabel(client),
    })
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: messagesConfig.responsePrefix,
        /**
         * deliver 回调：当 Agent 生成了一个完整的回复块时调用。
         * @param payload - 回复内容（text、mediaUrl 等）
         * @param info - 回复元信息（kind: "final" | "chunk" | "error" 等）
         *
         * 这里主要用于：
         *   1. 捕获最终回复文本（finalText）
         *   2. 记录出站活动统计
         *
         * 注意：流式文本已经通过 onAgentEvent 的 assistant 流实时推送了，
         * 这里的 deliver 是最终汇总的回调，用于获取完整的最终文本。
         */
        deliver: async (
          payload: {
            text?: string
            mediaUrl?: string
            mediaUrls?: string[]
            isError?: boolean
            channelData?: unknown
          },
          info: { kind: string }
        ) => {
          if (turn.cancelled) return

          console.log(
            `[wechat-access-ws] Agent ${info.kind} 回复:`,
            payload.text ? JSON.stringify(payload.text.slice(0, 80)) : payload.text
          )

          // 安全拦截：任何 kind 的 deliver 都检测拦截标记
          if (payload.text?.includes(SECURITY_BLOCK_MARKER)) {
            console.warn(
              '[wechat-access-ws] deliver 回复中检测到拦截标记，替换为提示'
            )
            finalText = SECURITY_BLOCK_USER_MESSAGE
            turn.cancelled = true
            turn.securityBlocked = true
            return
          }

          // 只在 kind=final 时更新 finalText，block 类型不更新
          // BufferedBlockDispatcher 理论上 final 应该给完整文本，
          // 但线上观察到会出现 NO / _REPLY 这种分裂片段，
          // 这里按扩展/重叠/片段拼接规则合并，避免最后一个 final 把前面的文本覆盖掉。
          if (payload.text && info.kind === 'final') {
            finalDeliverCount += 1
            finalTextCandidates.push(payload.text)
            finalText = mergeFinalReplyText(finalText, payload.text)
            console.log('[wechat-access-ws] turn final deliver:', {
              turnTag,
              finalDeliverCount,
              candidateSize: payload.text.length,
              mergedSize: finalText.length,
              state: getClientStateLabel(client),
            })
          }

          // 记录出站活动统计（每次 deliver 都算一次出站）
          runtime.channel.activity.record({
            channel: 'wechat-access',
            accountId: route.accountId ?? 'default',
            direction: 'outbound',
          })
        },
        onError: (err: unknown, info: { kind: string }) => {
          console.error(`[wechat-access-ws] Agent ${info.kind} 回复失败:`, err)
        },
      },
      replyOptions: {},
    })

    // ============================================
    // 7. 检测排队情况并等待排队的 Agent run 完成
    // ============================================
    // 标记 dispatch 已返回，用于排队场景下的事件过滤
    dispatchReturned = true

    /**
     * 排队检测逻辑：
     * 当 dispatchReplyWithBufferedBlockDispatcher 返回时，如果 turnRunId 仍为 null
     * 且 deliver 未被调用（finalText === null）且流式事件未接收（lastEmittedText === ''），
     * 说明框架检测到同一 session 已有 Agent 在运行，将本次消息排队并立即返回。
     *
     * 排队的消息会在前一个 Agent run 完成后由框架自动启动新的 Agent run 处理。
     * 此时我们需要继续保持 onAgentEvent 监听，等待排队的 Agent run 完成，
     * 才能将结果发送回微信端。
     *
     * 超时设置 3 分钟（180 秒），避免无限等待。
     */
    const wasQueued =
      turnRunId === null && finalText === null && lastEmittedText === ''

    if (wasQueued && !turn.cancelled) {
      // --- 排队提示 ---
      // AGP 服务端对同一个 promptId 只接受一次 promptResponse，
      // 如果这里提前发了排队提示的 promptResponse，后面真正的回复就发不出去了。
      // 因此不在这里单独发送排队提示。

      console.log(
        `[wechat-access-ws] 消息被排队，等待框架自动启动的 Agent run (promptId: ${promptId})`
      )

      const QUEUED_TIMEOUT_MS = 300_000 // 5 分钟超时
      try {
        // followup 模式下，框架会为每条排队消息独立启动 Agent run。
        // 只需等待 lifecycle.start（捕获 runId）→ lifecycle.end（run 完成）即可。
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            resolveQueuedWait = null
            reject(
              new Error(
                `排队的 Agent run 超时 (${QUEUED_TIMEOUT_MS / 1000}s)`
              )
            )
          }, QUEUED_TIMEOUT_MS)

          // 设置回调，onAgentEvent 监听器中的 lifecycle.end/error 会调用它
          resolveQueuedWait = () => {
            clearTimeout(timeout)
            resolve()
          }
        })

        console.log(
          `[wechat-access-ws] 排队的 Agent run 完成 (promptId: ${promptId})`,
          {
            runId: turnRunId,
            hasFinalText: !!finalText,
            lastEmittedLength: lastEmittedText.length,
          }
        )
      } catch (err) {
        console.error(
          `[wechat-access-ws] 排队等待失败 (promptId: ${promptId}):`,
          err
        )
        // 排队超时或等待失败时，如果没有收集到任何回复文本，设置超时提示
        if (!finalText && !lastEmittedText.trim()) {
          finalText = QUEUED_TIMEOUT_USER_MESSAGE
        }
      }
    }

    // ============================================
    // 8. 发送最终结果
    // ============================================
    console.log('[wechat-access-ws] turn dispatch 完成:', {
      turnTag,
      state: getClientStateLabel(client),
      assistantChunkCount,
      toolEventCount,
      finalDeliverCount,
      lastEmittedTextLength: lastEmittedText.length,
    })

    if (turn.cancelled) {
      if (turn.securityBlocked) {
        // 安全拦截导致的取消：发送友好提示文本给用户，而非空的 cancelled
        const blockedText = finalText || SECURITY_BLOCK_USER_MESSAGE
        sendPromptResponseReliable({
          client,
          label: `${turnTag} prompt_response(${promptId})`,
          payload: {
            session_id: sessionId,
            prompt_id: promptId,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: blockedText }],
          },
          guid,
          userId,
        })
      } else {
        // 用户主动取消：发送 cancelled 响应
        sendPromptResponseReliable({
          client,
          label: `${turnTag} cancelled_response(${promptId})`,
          payload: {
            session_id: sessionId,
            prompt_id: promptId,
            stop_reason: 'cancelled',
          },
          guid,
          userId,
        })
      }
      return
    }

    // 构建最终内容块
    // promptResponse.content 必须携带完整的回复文本：
    //   - 服务端（AGP）依赖 promptResponse.content 将最终回复推送给微信用户
    //   - session.update（流式推送）仅用于服务端实时展示，不直接推送到微信端
    //   - 因此即使已通过流式推送过内容，promptResponse 仍需携带完整文本
    //
    // 优先用 deliver 回调收到的 finalText，兜底用流式事件累积的 lastEmittedText
    let replyText =
      finalText || (lastEmittedText.trim() ? lastEmittedText : null)

    // 最后一道防线：检查最终回复文本是否包含安全拦截标记
    // 正常情况下 deliver 回调和流式事件中已经处理过了，这里是兜底
    if (replyText && replyText.includes(SECURITY_BLOCK_MARKER)) {
      console.warn('[wechat-access-ws] 替换为安全提示')
      replyText = SECURITY_BLOCK_USER_MESSAGE
    }

    if (replyText?.trim() === 'NO_REPLY' || !replyText) {
      console.warn(
        `[wechat-access-ws] Agent 回复为空，使用兜底提示 (promptId: ${promptId})`,
        { wasQueued, finalText, lastEmittedLength: lastEmittedText.length }
      )
      replyText = EMPTY_REPLY_USER_MESSAGE
    }

    // 长文本自动分段：微信单条消息有长度限制，超长回复需要拆分为多个 ContentBlock。
    // AGP 服务端会将 content 数组中的每个 text block 作为独立消息推送给微信用户。
    const textChunks = splitLongText(replyText)
    const responseContent: ContentBlock[] = textChunks.map((chunk) => ({
      type: 'text' as const,
      text: chunk,
    }))

    if (textChunks.length > 1) {
      console.log(
        `[wechat-access-ws] 回复文本过长 (${replyText.length} 字符)，已分割为 ${textChunks.length} 段`,
        textChunks.map((c, i) => `[${i + 1}] ${c.length} 字符`)
      )
    }

    // 发送 session.promptResponse，告知服务端本次 Turn 已正常完成
    sendPromptResponseReliable({
      client,
      label: `${turnTag} prompt_response(${promptId})`,
      payload: {
        session_id: sessionId,
        prompt_id: promptId,
        stop_reason: 'end_turn',
        content: responseContent,
      },
      guid,
      userId,
    })

    console.log('[wechat-access-ws] prompt 处理完成:', {
      turnTag,
      promptId,
      state: getClientStateLabel(client),
      hasReply: !!replyText,
      finalText: !!finalText,
      finalCandidates: finalTextCandidates,
      mergedReplyText: replyText
        ? JSON.stringify(replyText)
        : null,
      rawReplyText: replyText ? JSON.stringify(replyText) : null,
      lastEmittedText: lastEmittedText.length,
      assistantChunkCount,
      toolEventCount,
      finalDeliverCount,
    })
  } catch (err) {
    // ============================================
    // 错误处理
    // ============================================
    console.error('[wechat-access-ws] prompt 处理失败:', err)

    // 发送错误响应：使用 end_turn + 友好提示文本，确保微信用户能看到错误提示
    sendPromptResponseReliable({
      client,
      label: `${turnTag} error_response(${promptId})`,
      payload: {
        session_id: sessionId,
        prompt_id: promptId,
        stop_reason: 'end_turn',
        content: [
          { type: 'text', text: ERROR_REPLY_USER_MESSAGE },
        ],
      },
      guid,
      userId,
    })
  } finally {
    // ============================================
    // 清理：无论成功、失败还是取消，都必须执行
    // ============================================
    // 1. 取消 Agent 事件订阅，防止残留监听器收到后续事件导致串流
    turn.unsubscribe?.()
    // 2. 从活跃 Turn Map 中移除（支持 cancel 查找）
    activeTurns.delete(promptId)
    // 3. 释放互斥锁，允许下一条消息进入处理
    isBusy = false
    console.log(`[wechat-access-ws] turn 清理完成，互斥锁已释放 (promptId: ${promptId})`)
  }
}

/**
 * 处理 session.cancel 消息 — 取消正在处理的 Prompt Turn
 * @param message - AGP session.cancel 消息
 * @param client - WebSocket 客户端实例
 * @description
 * 取消流程：
 * 1. 通过 promptId 在 activeTurns Map 中查找对应的 Turn
 * 2. 将 turn.cancelled 标记为 true（handlePrompt 中的 onAgentEvent 回调会检查此标志）
 * 3. 调用 turn.unsubscribe() 停止接收后续 Agent 事件
 * 4. 从 activeTurns 中移除此 Turn
 * 5. 发送 session.promptResponse（stop_reason: "cancelled"）
 *
 * 注意：取消操作是"尽力而为"的，Agent 可能已经处理完毕，
 * 此时 activeTurns 中找不到对应 Turn，但仍然发送 cancelled 响应。
 */
export const handleCancel = (
  message: CancelMessage,
  client: AgpWebSocketClient
): void => {
  const { session_id: sessionId, prompt_id: promptId } = message.payload

  console.log('[wechat-access-ws] 收到 cancel:', {
    turnTag: `${sessionId.slice(0, 8)}/${promptId.slice(0, 8)}`,
    sessionId,
    promptId,
    state: getClientStateLabel(client),
  })

  const turn = activeTurns.get(promptId)
  if (!turn) {
    console.warn(`[wechat-access-ws] 未找到活跃 Turn: ${promptId}`)
    // 即使找不到对应 Turn（可能已处理完毕），也发送 cancelled 响应
    // 确保服务端收到明确的结束信号
    sendPromptResponseReliable({
      client,
      label: `${sessionId.slice(0, 8)}/${promptId.slice(0, 8)} cancelled_response(${promptId})`,
      payload: {
        session_id: sessionId,
        prompt_id: promptId,
        stop_reason: 'cancelled',
      },
    })
    return
  }

  // 标记为已取消：handlePrompt 中的 onAgentEvent 回调会检查此标志，
  // 一旦为 true，后续的流式事件都会被忽略，不再向服务端推送
  turn.cancelled = true

  // 取消 Agent 事件订阅，停止接收后续事件
  // 可选链 ?.() 是因为 unsubscribe 可能还未赋值（Turn 刚注册但还未到步骤 5）
  turn.unsubscribe?.()
  activeTurns.delete(promptId)

  // 发送 cancelled 响应
  sendPromptResponseReliable({
    client,
    label: `${sessionId.slice(0, 8)}/${promptId.slice(0, 8)} cancelled_response(${promptId})`,
    payload: {
      session_id: sessionId,
      prompt_id: promptId,
      stop_reason: 'cancelled',
    },
  })

  console.log('[wechat-access-ws] Turn 已取消:', promptId)
}

// ============================================
// 辅助函数
// ============================================

/**
 * 将工具名称映射为 AGP 协议的 ToolCallKind
 * @param toolName - 工具名称（如 "read_file"、"write"、"grep_search" 等）
 * @returns ToolCallKind 枚举值，用于服务端展示不同类型的工具调用图标
 * @description
 * 通过关键词匹配推断工具类型，映射规则：
 *   - read/get/view → "read"（读取操作）
 *   - write/edit/replace → "edit"（编辑操作）
 *   - delete/remove → "delete"（删除操作）
 *   - search/find/grep → "search"（搜索操作）
 *   - fetch/request/http → "fetch"（网络请求）
 *   - think/reason → "think"（思考/推理）
 *   - exec/run/terminal → "execute"（执行命令）
 *   - 其他 → "other"
 */
const mapToolKind = (toolName?: string): ToolCall['kind'] => {
  if (!toolName) return 'other'

  const name = toolName.toLowerCase()
  if (name.includes('read') || name.includes('get') || name.includes('view'))
    return 'read'
  if (
    name.includes('write') ||
    name.includes('edit') ||
    name.includes('replace')
  )
    return 'edit'
  if (name.includes('delete') || name.includes('remove')) return 'delete'
  if (name.includes('search') || name.includes('find') || name.includes('grep'))
    return 'search'
  if (
    name.includes('fetch') ||
    name.includes('request') ||
    name.includes('http')
  )
    return 'fetch'
  if (name.includes('think') || name.includes('reason')) return 'think'
  if (
    name.includes('exec') ||
    name.includes('run') ||
    name.includes('terminal')
  )
    return 'execute'
  return 'other'
}
