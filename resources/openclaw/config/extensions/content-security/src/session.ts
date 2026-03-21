import crypto from "node:crypto";

/**
 * 会话管理器
 *
 * CreateTask 接口要求：
 * - **SessionID**：同一会话的连续对话必须使用同一个唯一 ID，
 *   用于让审核服务理解上下文（如多轮对话中的语义关联）
 * - **QAID**（Question-Answer ID）：同一轮问答的"问"和"答"使用同一个唯一 ID，
 *   用于关联输入侧和输出侧的审核结果
 *
 * 本模块维护 `OpenClaw sessionKey → SessionInfo` 的映射：
 * - `getSessionId`：获取或创建会话的 SessionID
 * - `getQAID`：获取当前问答对的 QAID
 * - `startNewQA`：开始新一轮问答（生成新的 QAID）
 * - `cleanupSessions`：清理过期会话，防止内存泄漏
 */

/** 会话信息（内部数据结构） */
interface SessionInfo {
  /** CreateTask 要求的 SessionID（UUID v4），同一会话保持不变 */
  sessionId: string;
  /** 当前问答对的 QAID（UUID v4），每次新问答时更新 */
  currentQAID: string;
  /** 会话创建时间（毫秒时间戳） */
  createdAt: number;
  /** 最后活跃时间（毫秒时间戳），用于过期清理 */
  lastActiveAt: number;
}

/**
 * 会话存储：OpenClaw sessionKey → SessionInfo
 *
 * sessionKey 格式示例：
 * - OpenClaw Agent 会话："agent:main:wechat-access:direct:3"
 * - fetch 拦截器（无 sessionKey）："fetch:https://api.example.com/v1/chat"
 */
const sessions = new Map<string, SessionInfo>();

/** 拦截原因类型：security = 内容安全审核拦截，model_error = 大模型返回错误 */
export type BlockedReason = "security" | "model_error";

/** 拦截记录 */
interface BlockedRecord {
  /** 被拦截时的时间戳 */
  blockedAt: number;
  /** 拦截原因 */
  reason: BlockedReason;
}

/**
 * 被拦截的 sessionKey 集合
 *
 * 当 Prompt 审核被拦截或大模型返回错误后，记录该 sessionKey、拦截时间戳和拦截原因。
 * 后续同一 sessionKey 的重试请求会被直接拦截，不再走审核也不发给 LLM。
 * 拦截标记有效期 60 秒，超时自动失效（防止永久拦截）。
 *
 * key: sessionKey, value: 拦截记录
 */
const blockedSessions = new Map<string, BlockedRecord>();

/** 拦截标记有效期（毫秒） */
const BLOCK_TTL_MS = 60_000;

/**
 * 被拦截消息内容的指纹集合
 *
 * 当 Prompt 审核被拦截时，将被拦截的消息核心文本存入此 Set。
 * 后续 fetch 请求的 messages 中如果包含与指纹匹配的历史消息，
 * 会被替换为安全占位文本，防止 LLM 因历史敏感内容拒绝服务。
 *
 * 结构：Set<{ content: string, createdAt: number }>
 * - content: 被拦截的消息核心文本（经 normalizeMessage 提取后的纯文本）
 * - createdAt: 记录时间戳，用于过期清理
 */
interface BlockedContentEntry {
  content: string;
  createdAt: number;
}
const blockedContents: BlockedContentEntry[] = [];

/** 被拦截消息指纹最大保留数量（防止内存泄漏） */
const MAX_BLOCKED_CONTENTS = 50;

/** 被拦截消息指纹有效期（毫秒），默认 24 小时 */
const BLOCKED_CONTENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 去除消息文本中的时间戳前缀
 *
 * Agent Runner 在用户消息前自动添加时间戳前缀，格式如：
 * "[Sat 2026-03-07 10:01 GMT+8] 六四事件"
 *
 * 不同时间发送的同一敏感内容会有不同的时间戳前缀，导致 includes 匹配失败。
 * 此函数去除时间戳前缀，只保留核心内容用于匹配。
 *
 * @param text - 原始消息文本
 * @returns 去除时间戳前缀后的文本
 */
const stripTimestampPrefix = (text: string): string => {
  // 匹配常见的时间戳前缀格式：
  // [Sat 2026-03-07 10:01 GMT+8]
  // [2026-03-07 10:01:23]
  // [Mon Jan 01 2026 10:01 GMT+0800]
  // 等各种日期时间格式，以 [ 开头、] 结尾
  return text.replace(/^\[.*?\]\s*/, "").trim();
};

/**
 * 生成 UUID v4
 * 使用 Node.js 内置的 crypto.randomUUID()，无需第三方依赖
 */
const generateUUID = (): string => {
  return crypto.randomUUID();
};

/**
 * 获取或创建会话的 SessionID
 *
 * - 若 sessionKey 对应的会话已存在，直接返回其 SessionID 并更新活跃时间
 * - 若不存在，自动创建新会话（同时初始化 QAID）
 *
 * @param sessionKey - OpenClaw 的 sessionKey（如 "agent:main:wechat-access:direct:3"）
 *                     或 fetch 拦截器生成的 "fetch:{url}"
 * @returns CreateTask 接口需要的 SessionID（UUID v4 格式）
 */
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

/**
 * 获取当前问答对的 QAID
 *
 * QAID 在同一轮问答的"问"（before_tool_call / llm_request）和
 * "答"（after_tool_call）中保持一致，让审核服务能关联上下文。
 *
 * 若会话不存在，会自动调用 getSessionId 创建。
 *
 * @param sessionKey - OpenClaw 的 sessionKey
 * @returns 当前问答对的 QAID（UUID v4 格式）
 */
export const getQAID = (sessionKey: string): string => {
  const session = sessions.get(sessionKey);
  if (!session) {
    // 没有会话时先创建（getSessionId 内部会初始化 QAID）
    getSessionId(sessionKey);
    return sessions.get(sessionKey)!.currentQAID;
  }
  return session.currentQAID;
};

/**
 * 开始新的一轮问答对（生成新的 QAID）
 *
 * 每次用户发起新的提问时调用，确保新一轮问答使用全新的 QAID，
 * 避免不同轮次的审核结果被错误关联。
 *
 * 调用时机：
 * - fetch 拦截器检测到新的 LLM 请求时（startNewQA 在 setupFetchInterceptor 中调用）
 * - before_tool_call hook 中不调用（使用 getQAID 获取当前轮次的 QAID）
 *
 * @param sessionKey - OpenClaw 的 sessionKey
 * @returns 新生成的 QAID（UUID v4 格式）
 */
export const startNewQA = (sessionKey: string): string => {
  const session = sessions.get(sessionKey);
  if (session) {
    session.currentQAID = generateUUID();
    session.lastActiveAt = Date.now();
    return session.currentQAID;
  }

  // 会话不存在时自动创建（getSessionId 内部会初始化 QAID）
  getSessionId(sessionKey);
  return sessions.get(sessionKey)!.currentQAID;
};

/**
 * 标记某个 sessionKey 被拦截
 *
 * 在 Prompt 审核被拦截或大模型返回错误时调用，记录拦截时间戳和原因。
 * 后续同一 sessionKey 的重试请求在 isSessionBlocked 检查时会被直接拦截。
 *
 * @param sessionKey - 被拦截的 sessionKey
 * @param reason - 拦截原因："security" = 内容安全审核拦截，"model_error" = 大模型返回错误
 */
export const markSessionBlocked = (sessionKey: string, reason: BlockedReason = "security"): void => {
  blockedSessions.set(sessionKey, { blockedAt: Date.now(), reason });
};

/**
 * 清除某个 sessionKey 的拦截标记
 *
 * 在 Prompt 审核通过时调用（说明用户发了新的合规消息），恢复正常审核流程。
 * 注意：不应在 startNewQA 中调用，因为 Agent Runner 的重试请求也会触发新的 fetch，
 * 如果在那里清除标记，重试请求又会绕过拦截。
 *
 * @param sessionKey - 要清除拦截标记的 sessionKey
 */
export const clearSessionBlocked = (sessionKey: string): void => {
  blockedSessions.delete(sessionKey);
};

/**
 * 检查某个 sessionKey 是否处于被拦截状态
 *
 * 拦截标记有效期为 60 秒，超时后自动失效。
 * 这样即使出现异常情况，也不会导致永久拦截，用户 60 秒后可以正常使用。
 *
 * @param sessionKey - 要检查的 sessionKey
 * @returns true 表示该 sessionKey 的 Prompt 已被拦截，应直接拦截后续请求
 */
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

/**
 * 获取某个 sessionKey 的拦截原因
 *
 * 在重试拦截时调用，根据不同的拦截原因返回不同的提示文案。
 *
 * @param sessionKey - 要查询的 sessionKey
 * @returns 拦截原因，如果未被拦截返回 undefined
 */
export const getBlockedReason = (sessionKey: string): BlockedReason | undefined => {
  const record = blockedSessions.get(sessionKey);
  if (!record) return undefined;
  return record.reason;
};

/**
 * 清理过期会话（防止内存泄漏）
 *
 * 遍历所有会话，删除超过 maxIdleMs 未活跃的会话。
 * 同时清理过期的拦截标记。
 * 建议在应用空闲时定期调用（如每小时一次）。
 *
 * @param maxIdleMs - 最大空闲时间（毫秒），默认 24 小时
 * @returns 本次清理删除的会话数量
 */
export const cleanupSessions = (maxIdleMs: number = 24 * 60 * 60 * 1000): number => {
  const now = Date.now();
  let removed = 0;

  for (const [key, session] of sessions) {
    if (now - session.lastActiveAt > maxIdleMs) {
      sessions.delete(key);
      removed++;
    }
  }

  // 同步清理过期的拦截标记
  for (const [key, record] of blockedSessions) {
    if (now - record.blockedAt > BLOCK_TTL_MS) {
      blockedSessions.delete(key);
    }
  }

  // 同步清理过期的被拦截消息指纹
  cleanupBlockedContents();

  return removed;
};

/**
 * 获取当前活跃会话数量
 *
 * 用于监控和调试，了解当前内存中维护了多少个会话。
 */
export const getActiveSessionCount = (): number => {
  return sessions.size;
};

// ==================== 被拦截消息内容指纹管理 ====================

/**
 * 记录被拦截的消息内容
 *
 * 当 Prompt 审核被拦截时调用，将被拦截的消息核心文本存入指纹集合。
 * 后续 sanitizeMessages 会使用这些指纹来清洗历史消息中的敏感内容。
 *
 * @param content - 被拦截的消息文本（经 normalizeMessage 提取后的纯文本）
 */
export const addBlockedContent = (content: string): void => {
  // 去除空白内容
  const trimmed = content.trim();
  if (!trimmed) return;

  // 去除时间戳前缀，只保留核心内容用于后续匹配
  // 例："[Sat 2026-03-07 11:55 GMT+8] 六四事件" → "六四事件"
  const coreContent = stripTimestampPrefix(trimmed);
  if (!coreContent) return;

  // 避免重复添加（精确匹配核心内容）
  const exists = blockedContents.some((entry) => entry.content === coreContent);
  if (exists) return;

  blockedContents.push({ content: coreContent, createdAt: Date.now() });

  // 超出最大数量时删除最早的记录
  while (blockedContents.length > MAX_BLOCKED_CONTENTS) {
    blockedContents.shift();
  }
};

/**
 * 检查某段文本是否包含被拦截的敏感内容
 *
 * 使用 includes 双向模糊匹配：
 * - 历史消息可能包含时间戳前缀等额外内容，所以用 text.includes(blocked)
 * - 被拦截的内容也可能是历史消息的子串，所以用 blocked.includes(text)
 *
 * @param text - 要检查的消息文本
 * @returns 是否匹配到被拦截的内容
 */
export const isBlockedContent = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // 去除时间戳前缀后再匹配
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
const SANITIZED_PLACEHOLDER = "[该消息已被内容安全审核移除]";

/**
 * 清洗 LLM 请求 messages 中的历史敏感消息
 *
 * 遍历 messages 数组中所有 role=user 的消息，将内容与被拦截指纹匹配的消息
 * 替换为安全占位文本。替换而非删除，是为了保持 messages 数组长度和顺序不变，
 * 避免影响 LLM 的上下文理解。
 *
 * 支持两种 content 格式：
 * 1. 字符串格式：直接替换整个 content
 * 2. 多模态数组格式：逐个检查 type=text 的部分，匹配到则替换该部分的 text
 *
 * @param messages - LLM 请求的 messages 数组（会被原地修改）
 * @param skipIndex - 要跳过的消息索引（通常是最后一条 user 消息的索引，它会走正式 Prompt 审核流程，不应被提前清洗）。传 -1 或不传则不跳过。
 * @returns 被清洗的消息数量
 */
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

/**
 * 清理过期的被拦截消息指纹
 *
 * 在 cleanupSessions 中自动调用，清除超过 24 小时的指纹记录。
 */
const cleanupBlockedContents = (): number => {
  const now = Date.now();
  let removed = 0;
  // 从后往前遍历，安全删除
  for (let i = blockedContents.length - 1; i >= 0; i--) {
    if (now - blockedContents[i].createdAt > BLOCKED_CONTENT_TTL_MS) {
      blockedContents.splice(i, 1);
      removed++;
    }
  }
  return removed;
};
