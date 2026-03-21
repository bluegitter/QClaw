export function cacheSessionAgentName(sessionAgentNameCache, sessionKey, agentName) {
  sessionAgentNameCache.set(sessionKey, agentName)
}

export function buildUniqueSessionLabel({
  baseLabel,
  sessionKey,
  sessions,
  sessionLabelCache,
}) {
  const normalizedBaseLabel = String(baseLabel || "").trim() || "新对话"
  const existingLabels = new Set()

  for (const session of sessions || []) {
    if (!session || session.key === sessionKey) continue
    const label = typeof session.label === "string" ? session.label.trim() : ""
    if (label) existingLabels.add(label)
  }

  if (sessionLabelCache instanceof Map) {
    for (const [key, label] of sessionLabelCache.entries()) {
      if (key === sessionKey) continue
      const normalizedLabel = typeof label === "string" ? label.trim() : ""
      if (normalizedLabel) existingLabels.add(normalizedLabel)
    }
  }

  if (!existingLabels.has(normalizedBaseLabel)) {
    return normalizedBaseLabel
  }

  let suffix = 2
  while (existingLabels.has(`${normalizedBaseLabel} ${suffix}`)) {
    suffix += 1
  }
  return `${normalizedBaseLabel} ${suffix}`
}

export async function autoFillMissingSessionLabels({
  client,
  sessions,
  sessionLabelCache,
  sessionAgentNameCache,
  pendingSessionKeys,
  extractMessageText,
  isAgentSessionKey,
  buildAgentSessionLabel,
  normalizeSessionLabel,
  batchSize = 5,
}) {
  if (!client) return

  const pendingSessions = sessions.filter(
    (session) => !session.label && !pendingSessionKeys.has(session.key),
  )

  if (pendingSessions.length === 0) return

  for (let index = 0; index < pendingSessions.length; index += batchSize) {
    const batch = pendingSessions.slice(index, index + batchSize)
    await Promise.allSettled(
      batch.map(async (session) => {
        pendingSessionKeys.add(session.key)
        try {
          const history = await client.getChatHistory({
            sessionKey: session.key,
            limit: 10,
          })
          if (!history?.messages) return

          const firstUserMessage = history.messages.find(
            (message) => message.role === "user",
          )
          if (!firstUserMessage) return

          const messageText = extractMessageText(firstUserMessage) || ""
          if (!messageText) return

          const truncatedText =
            messageText.length > 30 ? `${messageText.slice(0, 30)}...` : messageText
          const labelSource = isAgentSessionKey(session.key)
            ? buildAgentSessionLabel(truncatedText, sessionAgentNameCache.get(session.key))
            : truncatedText
          const nextLabel = buildUniqueSessionLabel({
            baseLabel: normalizeSessionLabel(labelSource, session.key),
            sessionKey: session.key,
            sessions,
            sessionLabelCache,
          })
          const targetSession = sessions.find((item) => item.key === session.key)

          if (targetSession) targetSession.label = nextLabel
          sessionLabelCache.set(session.key, nextLabel)

          try {
            await client.patchSession(session.key, { label: nextLabel })
          } catch (error) {
            console.warn("[Chat] 自动回填 session label 失败:", session.key, error)
          }
        } catch (error) {
          console.warn("[Chat] 获取 session 历史消息失败:", session.key, error)
        }
      }),
    )
  }
}

export async function loadChatSessions({
  client,
  currentSessions,
  sessionLabelCache,
}) {
  const response = await client.getSessionsList({
    limit: 120,
    includeGlobal: false,
    includeUnknown: false,
  })

  if (!response?.sessions) {
    return currentSessions
  }

  const currentLabelMap = new Map()
  for (const session of currentSessions) {
    if (session.label) currentLabelMap.set(session.key, session.label)
  }

  return response.sessions
    .filter((session) => session.kind !== "global")
    .map((session) => {
      if (session.label) {
        sessionLabelCache.delete(session.key)
        return session
      }
      if (sessionLabelCache.has(session.key)) {
        return { ...session, label: sessionLabelCache.get(session.key) }
      }
      if (currentLabelMap.has(session.key)) {
        return { ...session, label: currentLabelMap.get(session.key) }
      }
      return session
    })
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
}
