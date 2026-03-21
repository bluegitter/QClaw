export async function abortCurrentStreamingSession({
  isStreaming,
  runIdRef,
  abortedRunIds,
  resetStreamingState,
  resetPendingState,
  client,
  connectionState,
  connectedState,
  sessionKeyRef,
  reloadChatHistory
}) {
  if (!isStreaming.value) {
    return;
  }

  const activeRunId = runIdRef.value;

  if (activeRunId) {
    abortedRunIds.add(activeRunId);
  }

  resetStreamingState();
  resetPendingState();

  if (client.value && connectionState.value === connectedState) {
    try {
      await client.value.abortChatRun(sessionKeyRef.value, activeRunId);
      await reloadChatHistory();
    } catch {
      if (activeRunId) {
        abortedRunIds.delete(activeRunId);
      }
    }
  }
}

export function createPendingLocalSession({
  createSessionKey,
  setPendingSessionFlag,
  resetStreamingState,
  resetPendingState,
  currentSessionKeyRef,
  messagesRef,
  messageInputRef,
  sessionsRef
}) {
  const sessionKey = createSessionKey();

  setPendingSessionFlag(true);
  resetStreamingState();
  resetPendingState();
  currentSessionKeyRef.value = sessionKey;
  messagesRef.value = [];
  messageInputRef.value = "";
  sessionsRef.value.unshift({
    key: sessionKey,
    label: "新对话",
    updatedAt: Date.now()
  });
}

export async function switchChatSession({
  sessionKey,
  setPendingSessionFlag,
  currentSessionKeyRef,
  messagesRef,
  messageInputRef,
  resetStreamingState,
  resetPendingState,
  isChannelSessionKey,
  clearChannelSessionState,
  isHistoryLoadingRef,
  loadChatHistory
}) {
  setPendingSessionFlag(true);
  currentSessionKeyRef.value = sessionKey;
  messagesRef.value = [];
  messageInputRef.value = "";
  resetStreamingState();
  resetPendingState();

  if (isChannelSessionKey(sessionKey)) {
    clearChannelSessionState();
    setPendingSessionFlag(false);
  }

  isHistoryLoadingRef.value = true;

  try {
    await loadChatHistory();
  } finally {
    isHistoryLoadingRef.value = false;
  }
}

export function handleNewChatRequest({
  confirm,
  guardInvocation,
  isStreaming,
  abortCurrentSession,
  createPendingSession
}) {
  if (!guardInvocation()) {
    return;
  }

  if (isStreaming.value) {
    confirm({
      title: "新建对话",
      content: "当前对话正在进行中，是否终止当前对话并新建？",
      okText: "确认",
      cancelText: "取消",
      centered: true,
      onOk: async () => {
        await abortCurrentSession();
        createPendingSession();
      }
    });
    return;
  }

  createPendingSession();
}

export async function handleSessionSelectRequest({
  nextSessionKey,
  currentSessionKeyRef,
  guardInvocation,
  confirm,
  isStreaming,
  abortCurrentSession,
  switchSession
}) {
  if (nextSessionKey === currentSessionKeyRef.value) {
    return;
  }

  if (!guardInvocation()) {
    return;
  }

  if (isStreaming.value) {
    confirm({
      title: "切换对话",
      content: "当前对话正在进行中，是否终止当前对话并切换？",
      okText: "确认",
      cancelText: "取消",
      centered: true,
      onOk: async () => {
        await abortCurrentSession();
        await switchSession(nextSessionKey);
      }
    });
    return;
  }

  await switchSession(nextSessionKey);
}
