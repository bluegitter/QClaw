/**
 * @file types.ts
 * @description 本地消息适配器类型定义
 *
 * AGP 协议的基本类型（ContentBlock, ToolCall 等）已从 @tencent/agp-native 导入。
 * 此文件仅保留本地消息转换层的类型定义。
 */

import type {
  ContentBlock,
  ToolCall,
  PromptPayload,
  CancelPayload,
  PromptResponsePayload,
  AgpExtra,
} from "@tencent/agp-native";

// ============================================
// 本地消息适配器类型
// ============================================

/**
 * Re-export AGP 通用扩展字段
 * PromptPayload 和 PromptResponsePayload 均通过 extra?: AgpExtra 携带 trace_id
 */
export type { AgpExtra, PromptPayload, PromptResponsePayload } from "@tencent/agp-native";

/**
 * session.update 的更新类型
 * @description
 * 定义 session.update 消息中 update_type 字段的可选值：
 * - message_chunk: Agent 生成的增量文本片段（流式输出，每次只包含新增的部分）
 * - tool_call: Agent 开始调用一个工具（通知服务端展示工具调用状态）
 * - tool_call_update: 工具调用状态变更（执行中的中间结果，或执行完成/失败）
 */
export type UpdateType = "message_chunk" | "tool_call" | "tool_call_update";

/**
 * session.update 载荷 — 流式中间更新
 * @description
 * 在 Agent 处理 session.prompt 的过程中，通过此消息实时推送中间状态。
 * 服务端收到后转发给用户端，实现流式输出效果。
 *
 * 根据 update_type 的不同，使用不同的字段：
 *   - message_chunk: 使用 content 字段（单个 ContentBlock，非数组）
 *   - tool_call / tool_call_update: 使用 tool_call 字段
 */
export interface UpdatePayload {
  /** 所属 Session ID */
  session_id: string;
  /** 所属 Turn ID（与对应 session.prompt 的 prompt_id 一致） */
  prompt_id: string;
  /** 更新类型，决定使用 content 还是 tool_call 字段 */
  update_type: UpdateType;
  /**
   * 文本内容块（update_type=message_chunk 时使用）
   * 注意：这里是单个 ContentBlock 对象，而非数组
   */
  content?: ContentBlock;
  /** 工具调用信息（update_type=tool_call 或 tool_call_update 时使用） */
  tool_call?: ToolCall;
}

// ============================================
// AGP 消息类型（使用本地 AGPEnvelope 的便利别名）
// ============================================

/**
 * AGP 统一消息信封
 * 所有 WebSocket 消息（上行和下行）均使用此格式
 */
export interface AGPEnvelope<T = unknown> {
  /** 全局唯一消息 ID（UUID），用于幂等去重 */
  msg_id: string;
  /** 设备唯一标识（下行消息携带，上行消息需原样回传） */
  guid?: string;
  /** 用户 ID（下行消息携带，上行消息需原样回传） */
  user_id?: string;
  /** 消息类型 */
  method: string;
  /** 消息载荷 */
  payload: T;
}

/** 上行：session.update 消息 */
export type UpdateMessage = AGPEnvelope<UpdatePayload>;
