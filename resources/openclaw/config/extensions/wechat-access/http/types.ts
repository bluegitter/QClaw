// ============================================
// Agent 事件类型
// ============================================
/**
 * Agent 事件载荷
 * @description OpenClaw Agent 运行时产生的事件数据
 * @property runId - 运行 ID，标识一次完整的 Agent 执行
 * @property seq - 事件序列号，用于排序
 * @property stream - 事件流类型（assistant/tool/lifecycle）
 * @property ts - 时间戳（毫秒）
 * @property data - 事件数据，根据 stream 类型不同而不同
 * @property sessionKey - 会话键（可选）
 */
export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

// ============================================
// 消息类型
// ============================================
/**
 * 微信服务号消息格式
 * @description 兼容多种消息格式（加密/明文、不同字段命名）
 * @property msgtype - 消息类型（text/image/voice 等）
 * @property msgid - 消息 ID（小写）
 * @property MsgId - 消息 ID（大写，微信标准格式）
 * @property text - 文本消息对象（包含 content 字段）
 * @property Content - 文本内容（直接字段）
 * @property chattype - 聊天类型
 * @property chatid - 聊天 ID
 * @property userid - 用户 ID（小写）
 * @property FromUserName - 发送者 OpenID（微信标准格式）
 * @property ToUserName - 接收者 ID（服务号原始 ID）
 * @property CreateTime - 消息创建时间（Unix 时间戳，秒）
 */
export interface FuwuhaoMessage {
  msgtype?: string;
  msgid?: string;
  MsgId?: string;
  text?: {
    content?: string;
  };
  Content?: string;
  chattype?: string;
  chatid?: string;
  userid?: string;
  FromUserName?: string;
  ToUserName?: string;
  CreateTime?: number;
}

// ============================================
// 账号配置类型
// ============================================
/**
 * 微信服务号账号配置
 * @description 用于消息加密解密和签名验证
 * @property token - 微信服务号配置的 Token（用于签名验证）
 * @property encodingAESKey - 消息加密密钥（43位字符，Base64 编码）
 * @property receiveId - 接收方 ID（服务号的原始 ID，用于解密验证）
 */
export interface SimpleAccount {
  token: string;
  encodingAESKey: string;
  receiveId: string;
}

// ============================================
// 回调相关类型
// ============================================
/**
 * 后置回调数据载荷
 * @description 发送到外部回调服务的数据格式
 * @property userId - 用户唯一标识（OpenID）
 * @property messageId - 消息唯一标识
 * @property messageType - 消息类型（text/image/voice 等）
 * @property userMessage - 用户发送的原始消息内容
 * @property aiReply - AI 生成的回复内容（如果失败则为 null）
 * @property timestamp - 消息时间戳（毫秒）
 * @property sessionKey - 会话键，用于关联上下文
 * @property success - 处理是否成功
 * @property error - 错误信息（仅在失败时存在）
 */
export interface CallbackPayload {
  // 用户信息
  userId: string;
  // 消息信息
  messageId: string;
  messageType: string;
  // 用户发送的原始内容
  userMessage: string;
  // AI 回复的内容
  aiReply: string | null;
  // 时间戳
  timestamp: number;
  // 会话信息
  sessionKey: string;
  // 是否成功
  success: boolean;
  // 错误信息（如果有）
  error?: string;
}

// ============================================
// 流式消息类型
// ============================================
/**
 * 流式消息数据块
 * @description Server-Sent Events (SSE) 推送的数据格式
 * @property type - 数据块类型
 *   - block: 流式文本块（增量文本）
 *   - tool: 工具调用结果
 *   - tool_start: 工具开始执行
 *   - tool_update: 工具执行中间状态
 *   - tool_result: 工具执行完成
 *   - final: 最终完整回复
 *   - error: 错误信息
 *   - done: 流式传输完成
 * @property text - 文本内容（适用于 block/final/error）
 * @property toolName - 工具名称（适用于 tool_* 类型）
 * @property toolCallId - 工具调用 ID（用于关联同一次调用）
 * @property toolArgs - 工具调用参数（适用于 tool_start）
 * @property toolMeta - 工具元数据（适用于 tool_* 类型）
 * @property isError - 是否是错误（适用于 tool_result）
 * @property timestamp - 时间戳（毫秒）
 */
export interface StreamChunk {
  type: "block" | "tool" | "tool_start" | "tool_update" | "tool_result" | "final" | "error" | "done";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: Record<string, unknown>;
  toolMeta?: Record<string, unknown>;
  isError?: boolean;
  timestamp: number;
}

/**
 * 流式消息回调函数类型
 * @description 用于接收流式数据块的回调函数
 * @param chunk - 流式数据块
 */
export type StreamCallback = (chunk: StreamChunk) => void;
