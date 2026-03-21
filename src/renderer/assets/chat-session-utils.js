const CHANNEL_SESSION_KEYS = new Set(["wechat-access"])

const CHANNEL_TITLES = {
  serviceAccount: "来自微信客服号",
}

export function isChannelSessionKey(sessionKey) {
  const channelKey = sessionKey.split(":")[2] || ""
  return CHANNEL_SESSION_KEYS.has(channelKey)
}

export function getChannelSessionTitle(fallbackTitle, channelSource) {
  if (channelSource && CHANNEL_TITLES[channelSource]) {
    return CHANNEL_TITLES[channelSource]
  }
  return fallbackTitle
}

export function getShortSessionId(sessionKey) {
  return sessionKey.slice(-6)
}

export function formatSessionLabel(label, sessionKey) {
  return `${label} [${getShortSessionId(sessionKey)}]`
}

export function resolveSessionChannel(sessionKey) {
  return isChannelSessionKey(sessionKey) ? sessionKey.split(":")[2] || undefined : undefined
}

export function isProtectedSessionKey(sessionKey) {
  const normalized = String(sessionKey || "").trim().toLowerCase()
  return normalized === "agent:main:main"
}

export function createLocalSessionKey() {
  const timestamp = Date.now()
  const randomSuffix = Math.random().toString(36).slice(2, 8)
  return `agent:main:session-${timestamp}-${randomSuffix}`
}
