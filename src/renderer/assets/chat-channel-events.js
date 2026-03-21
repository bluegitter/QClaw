import { buildUniqueSessionLabel } from "./chat-session-list.js"

export async function ensureChannelSessionLabel({
  sessionKey,
  channelSource,
  sessionList,
  sessionLabelCache,
  formatSessionLabel,
  getChannelTitle,
}) {
  if (sessionLabelCache.has(sessionKey)) {
    return
  }

  const session = sessionList.find((item) => item.key === sessionKey)
  if (!session || session.label) {
    return
  }

  const nextLabel = buildUniqueSessionLabel({
    baseLabel: formatSessionLabel(getChannelTitle("", channelSource), sessionKey),
    sessionKey,
    sessions: sessionList,
    sessionLabelCache,
  })
  sessionLabelCache.set(sessionKey, nextLabel)
  session.label = nextLabel
}

export async function finalizeChannelSessionLabel({
  sessionKey,
  channelSource,
  cacheSessionAgentName,
  refreshSessions,
  sessionList,
  client,
  extractMessageText,
  formatSessionLabel,
  getChannelTitle,
  sessionLabelCache,
}) {
  if (channelSource) {
    cacheSessionAgentName(sessionKey, channelSource)
  }

  await refreshSessions()

  const session = sessionList.find((item) => item.key === sessionKey)
  if (!session || (session.label && session.label !== sessionKey)) {
    return
  }

  try {
    const history = await client?.getChatHistory({ sessionKey, limit: 10 })
    if (!history?.messages) return

    const firstUserMessage = history.messages.find((message) => message.role === "user")
    if (!firstUserMessage) return

    const messageText = extractMessageText(firstUserMessage) || ""
    if (!messageText) return

    const truncatedText =
      messageText.length > 30 ? `${messageText.slice(0, 30)}...` : messageText
    const nextLabel = buildUniqueSessionLabel({
      baseLabel: formatSessionLabel(getChannelTitle(truncatedText, channelSource), sessionKey),
      sessionKey,
      sessions: sessionList,
      sessionLabelCache,
    })

    session.label = nextLabel
    sessionLabelCache.set(sessionKey, nextLabel)

    try {
      await client?.patchSession(sessionKey, { label: nextLabel })
    } catch (error) {
      console.warn("[Chat] 设置渠道 session label 失败:", error)
    }
  } catch (error) {
    console.warn("[Chat] 获取渠道历史消息失败:", error)
  }
}

export async function handleChannelSessionEvent({
  sessionKey,
  event,
  isSwitchingSession,
  pendingEvents,
  ensureSessionLabel,
  refreshSessions,
  currentSessionKeyRef,
  isCreatingChat,
  finalizeSessionLabel,
  resetStreamingState,
  resetComposerState,
  resetCurrentRunId,
  clearMessages,
  clearInput,
  loadChatHistory,
  loadingRef,
  activeRunIdRef,
  pendingChannelSwitchRef,
  currentRunId,
  scrollToBottom,
  dispatchPendingEvent,
}) {
  const { state, runId } = event
  const channelSource = event.ChannelSource || event.channelSource

  if (isSwitchingSession.value) {
    pendingEvents.push(event)
    return true
  }

  await ensureSessionLabel(sessionKey, channelSource)

  refreshSessions()

  if (currentSessionKeyRef.value !== sessionKey) {
    if (isCreatingChat.value) {
      if (state === "final") {
        await finalizeSessionLabel(sessionKey, channelSource)
      }
      return true
    }

    currentSessionKeyRef.value = sessionKey
    clearMessages()
    clearInput()
    resetStreamingState()
    currentRunId.current = null

    isSwitchingSession.value = true
    pendingEvents.length = 0
    loadingRef.value = true
    try {
      await loadChatHistory()
    } finally {
      loadingRef.value = false
    }

    if (runId) {
      currentRunId.current = runId
    }
    pendingChannelSwitchRef.value = true
    resetCurrentRunId()
    finalizeSessionLabel(sessionKey, channelSource)
    isSwitchingSession.value = false

    const queuedEvents = pendingEvents.splice(0, pendingEvents.length)
    for (const queuedEvent of queuedEvents) {
      dispatchPendingEvent(queuedEvent)
    }
    return true
  }

  if (runId && runId !== currentRunId.current) {
    currentRunId.current = runId
    isSwitchingSession.value = true
    pendingEvents.length = 0
    await loadChatHistory()
    scrollToBottom()
    pendingChannelSwitchRef.value = true
    resetCurrentRunId()
    isSwitchingSession.value = false

    const queuedEvents = pendingEvents.splice(0, pendingEvents.length)
    for (const queuedEvent of queuedEvents) {
      dispatchPendingEvent(queuedEvent)
    }
  }

  if (state === "final") {
    await finalizeSessionLabel(sessionKey, channelSource)
  }

  return false
}

export function routeIncomingSessionEvent({
  event,
  isChannelSessionKey,
  handleChannelEvent,
  handleCurrentEvent,
  currentSessionKey,
}) {
  const sessionKey = event.sessionKey
  console.log(
    "[DEBUG] handleAIMessage sessionKey:",
    sessionKey,
    "state:",
    event.state,
    "runId:",
    event.runId,
  )

  if (sessionKey && isChannelSessionKey(sessionKey)) {
    handleChannelEvent(sessionKey, event).then((handled) => {
      if (!handled) {
        handleCurrentEvent(event)
      }
    })
    return
  }

  if (!sessionKey || sessionKey === currentSessionKey.value) {
    handleCurrentEvent(event)
  }
}
