// ============================================
// WebSocket 模块导出
// ============================================

// 类型定义 - 从原生模块导入
export type {
  // Re-export AGP protocol types from native module
} from "@tencent/agp-native";
export {
  // Re-export ConnectionState enum
  ConnectionState,
} from "@tencent/agp-native";

// 本地定义的适配器类型（用于内部消息转换）
export type { UpdateMessage, UpdateType } from "./types.js";

// 消息处理器
export { handlePrompt, handleCancel } from "./message-handler.js";

// 消息适配器
export {
  extractTextFromContent,
  promptPayloadToFuwuhaoMessage,
  buildWebSocketMessageContext,
} from "./message-adapter.js";
