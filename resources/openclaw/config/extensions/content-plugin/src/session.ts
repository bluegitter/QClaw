import crypto from "node:crypto";

interface SessionInfo {
  sessionId: string;
  currentQAID: string;
  currentTurnKey?: string;
  createdAt: number;
  lastActiveAt: number;
}

const sessions = new Map<string, SessionInfo>();

interface BlockedRecord {
  blockedAt: number;
}

const blockedSessions = new Map<string, BlockedRecord>();

/** 拦截标记有效期（毫秒） */
const BLOCK_TTL_MS = 60_000;

interface BlockedContentEntry {
  content: string;
  createdAt: number;
}
const blockedContents: BlockedContentEntry[] = [];

const MAX_BLOCKED_CONTENTS = 50;

const BLOCKED_CONTENT_TTL_MS = 24 * 60 * 60 * 1000;

const stripTimestampPrefix = (text: string): string => {
  // 匹配常见的时间戳前缀格式：
  // [Sat 2026-03-07 10:01 GMT+8]
  // [2026-03-07 10:01:23]
  // [Mon Jan 01 2026 10:01 GMT+0800]
  return text.replace(/^\[.*?\]\s*/, "").trim();
};

const generateUUID = (): string => {
  return crypto.randomUUID();
};


export const getSessionId = (sessionKey: string): string => {
  let session = sessions.get(sessionKey);

  if (!session) {
    session = {
      sessionId: generateUUID(),
      currentQAID: generateUUID(),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    sessions.set(sessionKey, session);
  }

  // 每次访问都更新活跃时间，用于过期清理判断
  session.lastActiveAt = Date.now();
  return session.sessionId;
};


export const getQAID = (sessionKey: string): string => {
  const session = sessions.get(sessionKey);
  if (!session) {
    // 没有会话时先创建（getSessionId 内部会初始化 QAID）
    getSessionId(sessionKey);
    return sessions.get(sessionKey)!.currentQAID;
  }
  return session.currentQAID;
};


export const startNewQA = (sessionKey: string): string => {
  const session = sessions.get(sessionKey);
  if (session) {
    session.currentQAID = generateUUID();
    session.currentTurnKey = undefined;
    session.lastActiveAt = Date.now();
    return session.currentQAID;
  }

  // 会话不存在时自动创建（getSessionId 内部会初始化 QAID）
  getSessionId(sessionKey);
  return sessions.get(sessionKey)!.currentQAID;
};

export const ensureQAIDForTurn = (sessionKey: string, turnKey: string): string => {
  let session = sessions.get(sessionKey);
  if (!session) {
    session = {
      sessionId: generateUUID(),
      currentQAID: generateUUID(),
      currentTurnKey: turnKey,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    sessions.set(sessionKey, session);
    return session.currentQAID;
  }

  if (session.currentTurnKey !== turnKey) {
    session.currentQAID = generateUUID();
    session.currentTurnKey = turnKey;
  }
  session.lastActiveAt = Date.now();
  return session.currentQAID;
};

export const markSessionBlocked = (sessionKey: string): void => {
  blockedSessions.set(sessionKey, { blockedAt: Date.now() });
};


export const clearSessionBlocked = (sessionKey: string): void => {
  blockedSessions.delete(sessionKey);
};


export const isSessionBlocked = (sessionKey: string): boolean => {
  const record = blockedSessions.get(sessionKey);
  if (!record) return false;
  // 拦截标记有效期 60 秒，超时自动失效
  if (Date.now() - record.blockedAt > BLOCK_TTL_MS) {
    blockedSessions.delete(sessionKey);
    return false;
  }
  return true;
};




export const addBlockedContent = (content: string): void => {
  const trimmed = content.trim();
  if (!trimmed) return;

  const coreContent = stripTimestampPrefix(trimmed);
  if (!coreContent) return;

  const exists = blockedContents.some((entry) => entry.content === coreContent);
  if (exists) return;

  blockedContents.push({ content: coreContent, createdAt: Date.now() });

  while (blockedContents.length > MAX_BLOCKED_CONTENTS) {
    blockedContents.shift();
  }
};

export const isBlockedContent = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const coreText = stripTimestampPrefix(trimmed);
  if (!coreText) return false;

  const now = Date.now();
  for (const entry of blockedContents) {
    // 跳过已过期的指纹
    if (now - entry.createdAt > BLOCKED_CONTENT_TTL_MS) continue;
    // 双向 includes 匹配（此时两边都已去除时间戳前缀）
    if (coreText.includes(entry.content) || entry.content.includes(coreText)) {
      return true;
    }
  }
  return false;
};

/** 被替换后的安全占位文本 */
const SANITIZED_PLACEHOLDER = "[该消息已被移除]";

export const sanitizeMessages = (messages: any[], skipIndex: number = -1): number => {
  if (!Array.isArray(messages)) return 0;

  let sanitizedCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    // 跳过指定索引的消息（最后一条 user 消息会走正式 Prompt 审核，不在此清洗）
    if (i === skipIndex) continue;

    if (typeof msg.content === "string") {
      // 字符串格式的 content
      if (isBlockedContent(msg.content)) {
        msg.content = SANITIZED_PLACEHOLDER;
        sanitizedCount++;
      }
    } else if (Array.isArray(msg.content)) {
      // 多模态数组格式：[{ type: "text", text: "..." }, ...]
      let msgSanitized = false;
      for (const part of msg.content) {
        if (part.type === "text" && typeof part.text === "string") {
          if (isBlockedContent(part.text)) {
            part.text = SANITIZED_PLACEHOLDER;
            msgSanitized = true;
          }
        }
      }
      if (msgSanitized) sanitizedCount++;
    }
  }

  return sanitizedCount;
};

