export async function populateSessionLabels({
  client,
  sessions,
  sessionLabelCache,
  sessionAgentNameCache,
  pendingSessionKeys,
  extractMessageText,
  isAgentSessionKey,
  buildAgentSessionLabel,
  normalizeSessionLabel,
  cacheSessionAgentName
}) {
  await cacheSessionAgentName(
    sessionAgentNameCache,
    client,
    sessions,
    sessionLabelCache,
    pendingSessionKeys,
    extractMessageText,
    isAgentSessionKey,
    buildAgentSessionLabel,
    normalizeSessionLabel
  );
}

export async function refreshChatSessionPanel({
  clientRef,
  connectionStateRef,
  connectedState,
  isSessionsLoadingRef,
  sessionsRef,
  sessionLabelCache,
  loadChatSessions,
  populateLabels
}) {
  if (!clientRef.value || connectionStateRef.value !== connectedState) {
    return;
  }

  isSessionsLoadingRef.value = true;

  try {
    sessionsRef.value = await loadChatSessions({
      client: clientRef.value,
      currentSessions: sessionsRef.value,
      sessionLabelCache
    });

    await populateLabels();
  } catch (error) {
    console.error("[Chat] 加载 sessions 失败:", error);
  } finally {
    isSessionsLoadingRef.value = false;
  }
}

export function toggleChatSidebar({
  sidebarVisibleRef,
  storageKey,
  refreshSessions
}) {
  sidebarVisibleRef.value = !sidebarVisibleRef.value;
  localStorage.setItem(storageKey, String(sidebarVisibleRef.value));

  if (sidebarVisibleRef.value) {
    refreshSessions();
  }
}
