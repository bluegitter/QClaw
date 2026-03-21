import type { CallbackPayload } from "./types.js";

// ============================================
// 后置回调服务
// ============================================
// 用于将消息处理结果发送到外部服务进行后续处理
// 例如：数据统计、日志记录、业务逻辑触发等

/**
 * 后置回调服务的 URL 地址
 * @description 
 * 可通过环境变量 WECHAT_ACCESS_CALLBACK_URL 配置
 * 默认值：http://localhost:3001/api/wechat-access/callback
 */
const CALLBACK_SERVICE_URL = process.env.WECHAT_ACCESS_CALLBACK_URL || "http://localhost:3001/api/wechat-access/callback";

/**
 * 发送消息处理结果到后置回调服务
 * @param payload - 回调数据载荷，包含用户消息、AI 回复、会话信息等
 * @returns Promise<void> 异步执行，不阻塞主流程
 * @description 
 * 后置回调的作用：
 * 1. 记录消息处理日志
 * 2. 统计用户交互数据
 * 3. 触发业务逻辑（如积分、通知等）
 * 4. 数据分析和监控
 * 
 * 特点：
 * - 异步执行，失败不影响主流程
 * - 支持自定义认证（通过 Authorization header）
 * - 自动处理错误，只记录日志
 * @example
 * await sendToCallbackService({
 *   userId: 'user123',
 *   messageId: 'msg456',
 *   userMessage: '你好',
 *   aiReply: '您好！有什么可以帮您？',
 *   success: true
 * });
 */
export const sendToCallbackService = async (payload: CallbackPayload): Promise<void> => {
  try {
    console.log("[wechat-access] 发送后置回调:", {
      url: CALLBACK_SERVICE_URL,
      userId: payload.userId,
      hasReply: !!payload.aiReply,
    });

    const response = await fetch(CALLBACK_SERVICE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 可以添加认证头
        // "Authorization": `Bearer ${process.env.CALLBACK_AUTH_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error("[wechat-access] 后置回调服务返回错误:", {
        status: response.status,
        statusText: response.statusText,
      });
      return;
    }

    const result = await response.json().catch(() => ({}));
    console.log("[wechat-access] 后置回调成功:", result);
  } catch (err) {
    // 后置回调失败不影响主流程，只记录日志
    console.error("[wechat-access] 后置回调失败:", err);
  }
};
