import crypto from "node:crypto";
import type { NormalizedMessage } from "./types";

/**
 * 生成 UUID v4 格式的 RequestID
 *
 * CreateTask 接口的 RequestID 字段建议使用 UUID 格式，
 * 用于链路追踪和排查问题（对应响应中的 TraceID）。
 */
export const generateRequestId = (): string => {
  return crypto.randomUUID();
};

/**
 * 获取当前 Unix 时间戳（秒级）
 *
 * CreateTask 接口的 `Data.Comm.SendTime` 字段要求秒级时间戳，
 * 而 Date.now() 返回毫秒级，需要除以 1000 并取整。
 */
export const getCurrentTimestamp = (): number => {
  return Math.floor(Date.now() / 1000);
};

/**
 * 标准化消息格式
 *
 * 将不同 LLM API 格式的 message 对象转为统一的 `{ role, content }` 结构，
 * 便于后续提取文本内容进行审核。
 *
 * 支持的格式：
 * - **openai**（默认）：content 可以是字符串或 `{ type: "text", text: string }[]` 数组
 *   （多模态消息中只提取 text 类型的部分，图片等非文本内容忽略）
 * - **其他格式**：content 直接转为字符串
 *
 * @param message - 原始消息对象（来自 LLM API 请求体的 messages 数组）
 * @param format - 消息格式，默认 "openai"
 * @returns 标准化后的 `{ role, content }` 对象
 */
export const normalizeMessage = (message: any, format: string = "openai"): NormalizedMessage => {
  if (format === "openai") {
    let content = "";
    if (typeof message.content === "string") {
      // 简单字符串格式（最常见）
      content = message.content;
    } else if (Array.isArray(message.content)) {
      // 多模态格式：提取所有 type=text 的部分，用换行拼接
      content = message.content
        .filter((part: any) => part.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n");
    }
    return {
      role: message.role || "",
      content,
    };
  }

  // 非 OpenAI 格式：content 直接转为字符串
  return {
    role: message.role || "",
    content:
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content || ""),
  };
};

/**
 * 提取请求体中最后一条 user 消息
 *
 * 用于 fetch 拦截器中识别 LLM API 请求并提取待审核内容。
 * 支持三种常见的 LLM API 请求格式：
 * - `messages[]`：OpenAI / Anthropic 格式，取最后一条 role=user 的消息
 * - `prompt`：旧版 Completion API 格式
 * - `input`：部分 Embedding / 自定义 API 格式
 *
 * 只返回 role=user 的消息，system / assistant 消息不审核（避免误拦截）。
 *
 * @param body - 已解析的 JSON 请求体
 * @returns 标准化后的消息数组（通常只有 0 或 1 个元素）
 */
export const extractLastUserMessage = (body: any): NormalizedMessage[] => {
  if (!body || typeof body !== "object") return [];

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const lastMessage = body.messages[body.messages.length - 1];
    const normalized = normalizeMessage(lastMessage, "openai");
    // 只审核 user 消息，跳过 system / assistant 消息
    if (normalized.role !== "user") {
      return [];
    }
    if (normalized.content.length > 0) {
      return [normalized];
    }
    return [];
  }

  // 旧版 Completion API：prompt 字段
  if (typeof body.prompt === "string") return [{ role: "user", content: body.prompt }];
  // 自定义 API：input 字段
  if (typeof body.input === "string") return [{ role: "user", content: body.input }];

  return [];
};

/**
 * 文本切片
 *
 * CreateTask 接口对单次审核内容有长度限制：
 * - Prompt（输入侧）：≤ 4000 字
 * - Output（输出侧）：≤ 128 字（当前插件未严格限制，统一用 4000）
 *
 * 超长内容需要按 maxLength 切片，调用方通常只审核第一片（最新的用户输入），
 * 后续片段通常是历史上下文，审核价值较低。
 *
 * @param text - 原始文本
 * @param maxLength - 每片最大长度（字符数）
 * @returns 切片后的文本数组，长度不超过 maxLength 时返回只含原文的单元素数组
 */
export const sliceText = (text: string, maxLength: number): string[] => {
  if (text.length <= maxLength) {
    return [text];
  }

  const slices: string[] = [];
  for (let i = 0; i < text.length; i += maxLength) {
    slices.push(text.substring(i, i + maxLength));
  }
  return slices;
};

/**
 * 记录日志事件（条件日志）
 *
 * 仅在 `logRecord=true` 时通过 `api.logger.info` 输出日志，
 * 避免在生产环境中产生过多日志噪音。
 *
 * @param api - OpenClaw 插件 API
 * @param tag - 日志标签前缀（如 "content-security"）
 * @param hook - 来源 hook 标识（如 "fetch_intercept(user_message)"）
 * @param data - 附加数据，会被 JSON.stringify 序列化
 * @param logRecord - 是否启用日志（对应插件配置的 logRecord 字段）
 */
export const recordLogEvent = (
  api: any,
  tag: string,
  hook: string,
  data: any,
  logRecord: boolean,
): void => {
  if (logRecord) {
    api.logger.info(`[${tag}] ${hook} ${JSON.stringify(data)}`);
  }
};

// ==================== 安全消息生成 ====================

/**
 * 用户输入被拦截时注入到消息中的提示前缀
 * LLM 收到此前缀后会理解这是一条安全拦截指令
 */
export const SECURITY_BLOCK_PREFIX =
  "用户的输入已被安全审核系统拦截，原因如下：";

/**
 * BLOCK（打击）时追加的指令
 * 告知 LLM 不得回应原始请求，并引导用户修改后重新发送
 */
export const BLOCK_INSTRUCTION =
  "你不得回应原始请求。请礼貌地告知用户其消息因违反安全策略被拦截，并请其修改后重新发送。[ 内容安全审核 ]";

/**
 * MARK（标记但放行）时追加的指令
 * 告知 LLM 提醒用户注意内容合规性，但不阻断回答
 */
export const MARK_INSTRUCTION =
  "请提醒用户注意内容合规性。[ 内容安全审核 ]";

/**
 * 生成安全提示消息
 *
 * 根据命中的标签和是否打击，生成注入到 LLM 消息中的安全提示文本。
 * 此文本会替换（BLOCK）或追加（MARK）到原始消息内容中。
 *
 * @param hitLabels - 命中的标签名称列表（由 parseFirstLabels 生成，如 ["政治(明确恶意)"]）
 * @param blocked - 是否被打击（true=替换消息, false=追加提示）
 * @returns 格式化的安全提示消息字符串
 */
export const generateSecurityMessage = (hitLabels: string[], blocked: boolean): string => {
  // 没有命中标签时使用通用描述
  const labelText = hitLabels.length > 0 ? hitLabels.join("、") : "不当内容";

  if (blocked) {
    // BLOCK：完整的拦截指令，包含原因和不得回应的指令
    return `${SECURITY_BLOCK_PREFIX}\n${labelText}\n${BLOCK_INSTRUCTION}`;
  }

  // MARK：较轻的提示，只提醒合规性
  return `${SECURITY_BLOCK_PREFIX}${labelText}。${MARK_INSTRUCTION}`;
};

/**
 * 将安全标记注入到消息内容中
 *
 * 支持两种注入模式：
 * - **BLOCK（打击）**：完全替换原始内容，LLM 只看到安全拦截指令
 * - **MARK（标记）**：在原始内容后追加安全提示，LLM 仍能看到原始内容
 *
 * 支持两种内容格式：
 * - **字符串**：直接替换或追加
 * - **数组**（OpenAI 多模态格式）：递归处理每个 `type=text` 的部分
 *
 * @param content - 原始消息内容（字符串或 OpenAI 多模态数组）
 * @param securityReason - 安全提示消息（由 generateSecurityMessage 生成）
 * @param blocked - true=替换（BLOCK），false=追加（MARK）
 * @returns 注入安全标记后的消息内容（类型与输入相同）
 */
export const injectSecurityMarker = (
  content: any,
  securityReason: string,
  blocked: boolean,
): any => {
  if (typeof content === "string") {
    if (blocked) {
      // BLOCK：完全替换，LLM 只看到安全拦截指令
      return securityReason;
    }
    // MARK：追加到原始内容后
    return `${content}\n${securityReason}`;
  }

  if (Array.isArray(content)) {
    // OpenAI 多模态格式：递归处理每个 type=text 的部分
    return content.map((part: any) => {
      if (part.type === "text" && typeof part.text === "string") {
        return {
          ...part,
          text: injectSecurityMarker(part.text, securityReason, blocked),
        };
      }
      // 非文本部分（图片、音频等）保持不变
      return part;
    });
  }

  // 其他类型（null、object 等）保持不变
  return content;
};

/**
 * 从非流式 LLM JSON 响应体中提取 assistant 文本内容
 *
 * 支持 OpenAI Chat Completion 格式：
 * - `choices[0].message.content`（字符串或多模态数组）
 *
 * @param body - 已解析的 JSON 响应体
 * @returns 提取到的 assistant 文本，未匹配到返回空字符串
 */
export const extractAssistantContent = (body: any): string => {
  if (!body || typeof body !== "object") return "";

  // OpenAI Chat Completion 格式
  if (Array.isArray(body.choices) && body.choices.length > 0) {
    const choice = body.choices[0];
    const message = choice.message;
    if (!message) return "";

    if (typeof message.content === "string") {
      return message.content;
    }
    // 多模态格式：提取所有 type=text 的部分
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part: any) => part.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n");
    }
  }

  return "";
};

/**
 * 从 SSE（Server-Sent Events）流式响应文本中提取 assistant 完整内容
 *
 * SSE 格式示例（OpenAI streaming）：
 * ```
 * data: {"choices":[{"delta":{"content":"你"}}]}
 * data: {"choices":[{"delta":{"content":"好"}}]}
 * data: [DONE]
 * ```
 *
 * 逐行解析每个 `data:` 行，提取 `choices[0].delta.content` 并拼接。
 *
 * @param sseText - 完整的 SSE 响应文本（所有 chunk 拼接后的字符串）
 * @returns 拼接后的 assistant 完整文本
 */
export const extractAssistantFromSSE = (sseText: string): string => {
  const lines = sseText.split("\n");
  let fullContent = "";

  for (const line of lines) {
    // SSE 格式：每行以 "data: " 开头
    if (!line.startsWith("data:")) continue;

    const dataStr = line.slice(5).trim();
    // 流结束标志
    if (dataStr === "[DONE]") break;

    try {
      const json = JSON.parse(dataStr);
      if (Array.isArray(json.choices) && json.choices.length > 0) {
        const delta = json.choices[0].delta;
        if (delta && typeof delta.content === "string") {
          fullContent += delta.content;
        }
      }
    } catch {
      // 单行解析失败（如空行、注释行），跳过
    }
  }

  return fullContent;
};