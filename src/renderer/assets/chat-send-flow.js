import { buildUniqueSessionLabel } from "./chat-session-list.js"

export function scrollMessagesToBottom({ nextTick, messagesAreaRef }) {
  nextTick(() => {
    if (messagesAreaRef.value) {
      messagesAreaRef.value.scrollTop = messagesAreaRef.value.scrollHeight
    }
  })
}

export function buildOutgoingChatContent({ text, attachments }) {
  const content = []
  if (text) {
    content.push({ type: "text", text })
  }
  if (attachments.length > 0) {
    for (const attachment of attachments) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: attachment.dataUrl,
        },
      })
    }
  }
  return content
}

export async function sendConnectedChatMessage({
  client,
  sessionKey,
  text,
  attachments,
  isFirstUserMessage,
  messages,
  activeAssistantMessageRef,
  activeRunIdRef,
  sessionList,
  sessionLabelCache,
  normalizeSessionLabel,
  resetStreamingState,
  scrollToBottom,
  resetPendingState,
}) {
  resetStreamingState()
  const assistantMessage = {
    role: "assistant",
    text: "",
    toolCards: [],
    isStreaming: true,
  }
  messages.push(assistantMessage)
  activeAssistantMessageRef.value = messages[messages.length - 1]
  scrollToBottom()
  activeRunIdRef.value = null

  const idempotencyKey = `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  try {
    await client.sendChatMessage(text, {
      sessionKey,
      idempotencyKey,
      attachments: attachments.length > 0 ? attachments : undefined,
    })

    if (isFirstUserMessage) {
      const titleSource = text || `图片 (${attachments.length})`
      const nextLabel = normalizeSessionLabel(
        titleSource.length > 30 ? `${titleSource.slice(0, 30)}...` : titleSource,
        sessionKey,
      )
      const uniqueLabel = buildUniqueSessionLabel({
        baseLabel: nextLabel,
        sessionKey,
        sessions: sessionList,
        sessionLabelCache,
      })
      const session = sessionList.find((item) => item.key === sessionKey)
      if (session) {
        session.label = uniqueLabel
      }
      sessionLabelCache.set(sessionKey, uniqueLabel)
      client.patchSession(sessionKey, { label: uniqueLabel }).catch((error) => {
        console.warn("[Chat] 设置 session label 失败:", error)
      })
    }
  } catch (error) {
    console.error("[Chat] 发送消息失败:", error)
    messages.push({
      role: "assistant",
      text: `❌ 发送失败: ${error.message}`,
      isStreaming: false,
    })
    resetStreamingState()
    resetPendingState()
  }
}

export function handleDisconnectedChatSend({
  text,
  attachments,
  isFirstUserMessage,
  sessionKey,
  sessionList,
  scrollToBottom,
  appendSystemMessage,
}) {
  if (isFirstUserMessage) {
    const titleSource = text || `图片 (${attachments.length})`
    const nextLabel = buildUniqueSessionLabel({
      baseLabel:
        titleSource.length > 30 ? `${titleSource.slice(0, 30)}...` : titleSource,
      sessionKey,
      sessions: sessionList,
      sessionLabelCache: new Map(),
    })
    const session = sessionList.find((item) => item.key === sessionKey)
    if (session) {
      session.label = nextLabel
    }
  }

  setTimeout(() => {
    appendSystemMessage({
      role: "assistant",
      text: "未连接到 OpenClaw Gateway，请先启动本地 Gateway 服务。",
      isStreaming: false,
    })
    scrollToBottom()
  }, 500)
}

export async function abortActiveChatRun({
  client,
  connectionState,
  connectedState,
  sessionKey,
  runIdRef,
  abortedRunIds,
  resetStreamingState,
  resetPendingState,
  reloadChatHistory,
}) {
  if (!client || connectionState.value !== connectedState) {
    return
  }

  const runId = runIdRef.value
  if (runId) {
    abortedRunIds.add(runId)
  }

  resetStreamingState()
  resetPendingState()

  try {
    await client.abortChatRun(sessionKey.value, runId)
    await reloadChatHistory()
  } catch {
    if (runId) {
      abortedRunIds.delete(runId)
    }
  }
}
