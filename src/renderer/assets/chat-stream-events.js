export function clearAbortedRunIfNeeded({ runId, state, aborted, abortedRunIds }) {
  if (!runId || !abortedRunIds.has(runId)) {
    return false
  }

  if (state === "final" || state === "aborted" || aborted) {
    abortedRunIds.delete(runId)
  }
  return true
}

export function handleStreamErrorEvent({
  text,
  resetStreamingState,
  resetPendingState,
  messages,
  scrollToBottom,
}) {
  resetStreamingState()
  const nextText = text || "发生错误"
  messages.push({
    role: "assistant",
    text: `❌ ${nextText}`,
    toolCards: [],
    isStreaming: false,
  })
  resetPendingState()
  scrollToBottom()
}

export function handleStreamAbortedEvent({
  resetStreamingState,
  resetPendingState,
}) {
  resetStreamingState()
  resetPendingState()
}

export function handleSecurityBlockedEvent({
  event,
  isSecurityBlockedProcessingRef,
  resetStreamingState,
  resetPendingState,
  messages,
  currentSessionKey,
  electronAPI,
  reloadChatHistory,
  scrollToBottom,
}) {
  if (isSecurityBlockedProcessingRef.value) {
    console.warn("[Chat] securityBlocked 已在处理中，跳过重复事件")
    return true
  }

  isSecurityBlockedProcessingRef.value = true
  resetStreamingState()

  const nextText =
    event.text ||
    "抱歉，我无法处理该任务，让我们换个任务试试看？为保证您的正常使用，该问答将在 3s 后删除。"

  messages.push({
    role: "assistant",
    text: nextText,
    toolCards: [],
    isStreaming: false,
    isSecurityBlocked: true,
  })
  resetPendingState()
  scrollToBottom()

  const sessionKey = currentSessionKey.value
  setTimeout(async () => {
    const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user")
    if (lastUserIndex !== -1) {
      messages.splice(lastUserIndex)
    }

    try {
      await electronAPI?.session?.trimLastExchange(sessionKey)
    } catch (error) {
      console.warn("[Chat] 删除 session 文件最后一轮问答失败:", error)
    }

    await reloadChatHistory()
    isSecurityBlockedProcessingRef.value = false
  }, 3000)

  return true
}

export function applyStreamingDelta({
  text,
  message,
  extractToolCards,
  mergeToolCards,
  activeAssistantMessageRef,
  messages,
  scrollToBottom,
  currentRunIdRef,
  runId,
  lastDeltaTextRef,
}) {
  const nextText = text || ""
  const nextToolCards = message ? extractToolCards(message) : []

  if (!currentRunIdRef.value && runId) {
    currentRunIdRef.value = runId
  }

  if (activeAssistantMessageRef.value) {
    activeAssistantMessageRef.value.text = nextText
    if (nextToolCards.length > 0) {
      mergeToolCards(activeAssistantMessageRef.value, nextToolCards)
    }
  } else {
    const nextAssistantMessage = {
      role: "assistant",
      text: nextText,
      toolCards: nextToolCards,
      isStreaming: true,
    }
    messages.push(nextAssistantMessage)
    activeAssistantMessageRef.value = messages[messages.length - 1]
  }

  if (lastDeltaTextRef) {
    lastDeltaTextRef.value = nextText
  }
  scrollToBottom()
}

export function applyStreamingFinal({
  text,
  message,
  extractToolCards,
  mergeToolCards,
  activeAssistantMessageRef,
  resetStreamingState,
  resetPendingState,
  refreshSessions,
  nextTick,
}) {
  const nextToolCards = message ? extractToolCards(message) : []

  if (activeAssistantMessageRef.value) {
    activeAssistantMessageRef.value.isStreaming = false
    if (text) {
      activeAssistantMessageRef.value.text = text
    }
    if (nextToolCards.length > 0) {
      mergeToolCards(activeAssistantMessageRef.value, nextToolCards)
    }
  }

  resetStreamingState()
  resetPendingState()
  nextTick(async () => {
    refreshSessions()
  })
}

export function applyMismatchedFinalEvent({
  text,
  message,
  currentRunIdRef,
  activeAssistantMessageRef,
  messages,
  extractToolCards,
  mergeToolCards,
  scrollToBottom,
  resetStreamingState,
  resetPendingState,
  refreshSessions,
}) {
  const nextText = text || message?.content || ""
  if (nextText && !currentRunIdRef.value) {
    if (activeAssistantMessageRef.value) {
      activeAssistantMessageRef.value.text = nextText
      const nextToolCards = message ? extractToolCards(message) : []
      if (nextToolCards.length > 0) {
        mergeToolCards(activeAssistantMessageRef.value, nextToolCards)
      }
    } else {
      messages.push({
        role: "assistant",
        text: nextText,
        toolCards: message ? extractToolCards(message) : [],
        isStreaming: false,
      })
    }
    scrollToBottom()
  }

  resetStreamingState()
  resetPendingState()
  refreshSessions()
}
