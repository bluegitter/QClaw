export function describeToolCall(toolName, toolArgs) {
  if (!toolArgs) return ""

  if (
    toolName === "read" ||
    toolName === "read_file" ||
    toolName === "write" ||
    toolName === "write_file"
  ) {
    return toolArgs.path || toolArgs.file || ""
  }

  if (toolName === "bash" || toolName === "execute" || toolName === "shell" || toolName === "exec") {
    const command = toolArgs.command || toolArgs.cmd || ""
    return command.length > 50 ? `${command.slice(0, 50)}...` : command
  }

  if (toolName === "search" || toolName === "grep") {
    return toolArgs.query || toolArgs.pattern || ""
  }

  const keys = Object.keys(toolArgs)
  if (keys.length > 0 && keys[0] !== undefined) {
    const firstValue = toolArgs[keys[0]]
    if (typeof firstValue === "string") {
      return firstValue.length > 50 ? `${firstValue.slice(0, 50)}...` : firstValue
    }
  }

  return ""
}

export function extractToolCardsFromMessage(message, extractMessageText, isToolResultMessage) {
  const toolCards = []
  const content = message.content

  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue
      const itemType = (typeof item.type === "string" ? item.type : "").toLowerCase()
      if (
        ["toolcall", "tool_call", "tooluse", "tool_use"].includes(itemType) ||
        (typeof item.name === "string" && (item.arguments != null || item.args != null))
      ) {
        const args = item.arguments || item.args
        toolCards.push({
          kind: "call",
          name: item.name || "tool",
          args,
          detail: describeToolCall(item.name, args),
          completed: false,
          aborted: false,
          toolCallId:
            item.toolCallId ||
            item.tool_call_id ||
            item.id ||
            item.callId ||
            undefined,
        })
      }
    }

    for (const item of content) {
      if (typeof item !== "object" || item === null) continue
      const itemType = (typeof item.type === "string" ? item.type : "").toLowerCase()
      if (itemType !== "toolresult" && itemType !== "tool_result") continue

      const resultText = item.text || item.content || ""
      const toolName = item.name || "tool"
      const existingCall = toolCards.find(
        (toolCard) => toolCard.kind === "call" && toolCard.name === toolName,
      )

      if (existingCall) {
        existingCall.completed = true
        existingCall.text = resultText
        existingCall.toolCallId =
          existingCall.toolCallId ||
          item.toolCallId ||
          item.tool_call_id ||
          item.id ||
          item.callId ||
          undefined
      } else {
        toolCards.push({
          kind: "result",
          name: toolName,
          text: resultText,
          completed: true,
          aborted: false,
          toolCallId:
            item.toolCallId ||
            item.tool_call_id ||
            item.id ||
            item.callId ||
            undefined,
        })
      }
    }
  }

  if (isToolResultMessage(message) && !toolCards.some((toolCard) => toolCard.kind === "result")) {
    const toolName =
      (typeof message.toolName === "string" && message.toolName) ||
      (typeof message.tool_name === "string" && message.tool_name) ||
      "tool"
    const resultText = extractMessageText(message) || undefined
    toolCards.push({
      kind: "result",
      name: toolName,
      text: resultText,
      completed: true,
      aborted: false,
      toolCallId:
        message.toolCallId ||
        message.tool_call_id ||
        message.id ||
        undefined,
    })
  }

  return toolCards
}

export function mergeToolCardsIntoMessage(message, nextToolCards) {
  if (!message.toolCards) {
    message.toolCards = []
  }

  for (const toolCard of nextToolCards) {
    if (toolCard.kind === "result") {
      const existingCall = message.toolCards.find(
        (existingToolCard) =>
          existingToolCard.kind === "call" &&
          existingToolCard.name === toolCard.name &&
          !existingToolCard.completed,
      )
      if (existingCall) {
        existingCall.completed = true
        existingCall.text = toolCard.text
      } else {
        message.toolCards.push(toolCard)
      }
      continue
    }

    if (
      message.toolCards.findIndex(
        (existingToolCard) =>
          existingToolCard.name === toolCard.name &&
          existingToolCard.kind === "call" &&
          toolCard.kind === "call",
      ) === -1
    ) {
      message.toolCards.push(toolCard)
    }
  }
}

export function normalizeChatHistoryMessages({
  sessionKey,
  historyMessages,
  mapRole,
  extractMessageText,
  extractToolCards,
  resolveSessionChannel,
}) {
  const channel = resolveSessionChannel(sessionKey)
  const normalizedMessages = historyMessages
    .map((message) => {
      const role = mapRole(message.role || "")
      const text = extractMessageText(message) || ""
      const toolCards = extractToolCards(message)
      let content = message.content

      if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        const existingContent = Array.isArray(content) ? content : []
        if (
          !existingContent.some(
            (item) => item && (item.type === "image" || item.type === "image_url"),
          )
        ) {
          const imageAttachments = message.attachments
            .filter((attachment) => attachment && attachment.type === "image")
            .map((attachment) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: attachment.mimeType || attachment.media_type || "image/png",
                data: attachment.content || attachment.data || "",
              },
            }))

          if (imageAttachments.length > 0) {
            content = [
              ...(text ? [{ type: "text", text }] : []),
              ...existingContent.filter((item) => item?.type !== "text" || !text),
              ...imageAttachments,
            ]
          }
        }
      }

      return {
        role,
        text,
        toolCards,
        timestamp: message.timestamp,
        content,
        ...(role === "user" && channel ? { channel } : {}),
      }
    })
    .filter(
      (message) =>
        !!(
          message.text ||
          (message.toolCards && message.toolCards.length > 0) ||
          (Array.isArray(message.content) &&
            message.content.some(
              (item) => item && (item.type === "image" || item.type === "image_url"),
            ))
        ),
    )

  for (let index = normalizedMessages.length - 1; index > 0; index -= 1) {
    const currentMessage = normalizedMessages[index]
    const previousMessage = normalizedMessages[index - 1]
    if (
      currentMessage.role === "assistant" &&
      previousMessage.role === "assistant" &&
      currentMessage.text &&
      currentMessage.text === previousMessage.text
    ) {
      normalizedMessages.splice(index - 1, 1)
    }
  }

  for (let index = 0; index < normalizedMessages.length; index += 1) {
    const currentMessage = normalizedMessages[index]
    if (currentMessage.role !== "tool" || !currentMessage.toolCards) continue

    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      const previousMessage = normalizedMessages[previousIndex]
      if (previousMessage.role === "user") break
      if (previousMessage.role !== "assistant" || !previousMessage.toolCards) continue

      for (const toolCard of currentMessage.toolCards) {
        if (toolCard.kind !== "result") continue
        const existingCall = previousMessage.toolCards.find(
          (existingToolCard) =>
            existingToolCard.kind === "call" &&
            !existingToolCard.completed &&
            existingToolCard.name === toolCard.name,
        )
        if (existingCall) {
          existingCall.completed = true
          existingCall.text = toolCard.text
        }
      }
      break
    }
  }

  return normalizedMessages
}
