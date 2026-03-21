// ============================================
// Fuwuhao (微信服务号) 模块导出
// ============================================

// 类型定义
export type {
  AgentEventPayload,
  FuwuhaoMessage,
  SimpleAccount,
  CallbackPayload,
  StreamChunk,
  StreamCallback,
} from "./types.js";

// 加密解密工具
export type {
  VerifySignatureParams,
  DecryptMessageParams,
} from "./crypto-utils.js";
export {
  verifySignature,
  decryptMessage,
} from "./crypto-utils.js";

// HTTP 工具
export {
  parseQuery,
  readBody,
  isFuwuhaoWebhookPath,
} from "./http-utils.js";

// 回调服务
export {
  sendToCallbackService,
} from "./callback-service.js";

// 消息上下文
export type {
  MessageContext,
} from "./message-context.js";
export {
  buildMessageContext,
} from "./message-context.js";

// 消息处理器
export {
  handleMessage,
  handleMessageStream,
} from "./message-handler.js";

// Webhook 处理器（主入口）
export {
  handleSimpleWecomWebhook,
} from "./webhook.js";

// Runtime
export {
  getWecomRuntime,
} from "../common/runtime.js";
