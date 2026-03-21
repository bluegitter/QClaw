// ==================== 枚举 ====================

/**
 * 会话类型：用于区分"问"和"答"
 *
 * CreateTask 接口必填字段（`Data.Content.SessionType`）。
 * 审核服务根据此字段区分输入侧（Prompt）和输出侧（LLM 响应），
 * 应用不同的审核策略。
 */
export const enum SessionType {
  /** 问（用户输入 / Prompt / 工具参数） */
  QUESTION = 1,
  /** 答（模型输出 / 工具返回结果） */
  ANSWER = 2,
  /** 回答结束（最后一次回答，用于标记会话结束） */
  ANSWER_END = 3,
}

/**
 * 媒体类型：CreateTask 接口支持的内容类型
 *
 * 当前插件只使用 "Text"，其他类型预留供未来扩展。
 */
export type MediaType =
  | "Text"       // 纯文本
  | "Picture"    // 图片（URL）
  | "Video"      // 视频（URL）
  | "Audio"      // 音频（URL）
  | "OutLink"    // 外链
  | "Livevideo"  // 直播视频
  | "File";      // 文件

/**
 * 审核结果码：CreateTask 响应中 `Data.ResultCode` 字段的值
 */
export const enum ResultCode {
  /** 放过（内容安全，正常继续） */
  PASS = 0,
  /** 打击（内容违规，需要拦截） */
  BLOCK = 1,
  /** 放过（等同于 0，部分场景下接口返回 2） */
  PASS_2 = 2,
}

/**
 * 恶意程度等级：CreateTask 响应中 `Data.ResultTypeLevel` 字段的值
 *
 * 数值越大表示恶意程度越高。插件默认在 Level >= 300（疑似恶意）时触发打击，
 * 可通过插件配置的 `blockLevel` 字段调整阈值。
 */
export const enum ResultLevel {
  /** 正常（未命中任何规则） */
  NORMAL = 100,
  /** 疑似相关（弱信号，建议关注） */
  SUSPECTED_RELATED = 200,
  /** 明确相关（中等信号） */
  CONFIRMED_RELATED = 250,
  /** 疑似恶意（强信号，政治标签时表示红一相关） */
  SUSPECTED_MALICIOUS = 300,
  /** 明确恶意（最高级别，直接拦截） */
  CONFIRMED_MALICIOUS = 400,
}

// ==================== CreateTask 请求 ====================

/**
 * 场景类型：用于区分输入审核和输出审核
 */
export type SceneType = "prompt" | "output";

/**
 * 媒体项：CreateTask 请求体中 `data.Content.Msg.Media` 数组的元素
 */
export interface MediaItem {
  /** 审核内容。文本类型填实际文本；图片/音频/视频填 URL */
  Data: string;
  /** 媒体类型 */
  MediaType: MediaType;
}

/**
 * CreateTask 请求体（走后端代理）
 *
 * 对应前端接入文档中的完整请求结构。
 * 由 `CreateTaskClient.createTask` 方法自动构造，调用方无需手动组装。
 */
export interface CreateTaskRequest {
  /** 场景标识："prompt"=输入审核, "output"=输出审核 */
  scene: SceneType;
  /** 链路追踪ID，建议 UUID，用于排查问题（由 generateRequestId 自动生成） */
  request_id: string;
  /** OpenClaw Channel Token，用于鉴权 */
  openclaw_channel_token: string;
  /** 审核数据对象，后台透传不解析 */
  data: {
    Comm: {
      /** 审核请求发出的时间，Unix 时间戳（秒级，由 getCurrentTimestamp 自动生成） */
      SendTime: number;
    };
    Content: {
      /** 一次问答对的唯一ID（复合审核场景必填，由 session.ts 的 startNewQA 生成） */
      QAID?: string;
      /** 会话ID，同一会话的连续对话使用同一个（由 session.ts 的 getSessionId 生成） */
      SessionID: string;
      /** 会话类型：1=问, 2=答, 3=回答结束 */
      SessionType: SessionType;
      Msg: {
        /** 审核内容数组（当前插件每次只传一个 Text 类型的元素） */
        Media: MediaItem[];
        /** 扩展字段，无特殊需求传 {} */
        MsgMap: Record<string, any>;
      };
    };
  };
}

// ==================== CreateTask 响应 ====================

/**
 * 一级标签项：ResultFirstLabel JSON 中每个 key 对应的值结构
 *
 * 注意：接口不同版本中字段名可能不同（uilevel vs Level，strMeaning vs Meaning），
 * labels.ts 中的 parseFirstLabels 函数已做兼容处理。
 */
export interface FirstLabelItem {
  /** 标签 code（旧版字段名） */
  uiLabel: number;
  /** 恶意程度等级（旧版字段名，新版为 Level） */
  uilevel: number;
  /** 标签中文含义（旧版字段名，新版为 Meaning） */
  strMeaning: string;
}

/**
 * CreateTask 同步响应体（走后端代理）
 *
 * 新接口返回 { common, data } 结构：
 * - `common.code`：0=成功，非0=失败
 * - `data.ResultCode`：0=放过, 1=打击, 2=放过
 * - `data.ResultTypeLevel`：恶意程度等级（100/200/250/300/400）
 * - `data.ResultFirstLabel`：一级标签 JSON 字符串（需手动解析）
 * - `data.TraceID`：信安排查用的链路 ID
 */
export interface CreateTaskResponse {
  /** 通用响应头 */
  common: {
    /** 业务状态码：0=成功，-1=服务内部错误，4=参数错误，21004=Token无效或过期 */
    code: number;
    /** 状态描述 */
    message: string;
  };
  /** 审核结果数据（common.code !== 0 时可能为 null） */
  data: {
    /** 审核结果码：0=放过, 1=打击, 2=放过 */
    ResultCode: number;
    /** 恶意类型 code（如 20001=政治, 20002=色情），见 labels.ts 的 ResultTypeMap */
    ResultType?: number;
    /** 恶意程度等级（100/200/250/300/400），见 labels.ts 的 ResultLevelMap */
    ResultTypeLevel?: number;
    /** 操作结果备注（通常为空） */
    ResultMsg?: string;
    /** 一级标签 JSON 字符串，需用 parseFirstLabels 解析 */
    ResultFirstLabel?: string;
    /** 二级标签 JSON 字符串（当前插件未使用） */
    ResultSecondLabel?: string;
    /** 信安处理人（人工审核时填写） */
    Operator?: string;
    /** 白库答案（命中白名单时返回） */
    WhiteBoxAnswer?: string;
    /** 标准返回消息（旁路模式） */
    StdRetMsg?: string;
    /** 标准返回码（旁路模式） */
    StdRetCode?: number;
    /** 信安消息ID，用于向信安团队排查问题 */
    TraceID?: string;
  } | null;
}

// ==================== 客户端配置 ====================

/**
 * CreateTaskClient 构造函数参数
 */
export interface CreateTaskClientOptions {
  /** CreateTask API 完整地址（如 "https://jprx.sparta.html5.qq.com/data/4064/forward"） */
  endpoint: string;
  /** OpenClaw Channel Token，用于鉴权 */
  openclawChannelToken: string;
  /** 单次请求超时（毫秒），默认 5000ms */
  timeoutMs?: number;
  /**
   * 自定义 fetch 函数
   * 必须传入拦截器注册前保存的原始 fetch，
   * 否则审核请求本身也会被拦截，造成死循环
   */
  fetchFn?: typeof fetch;
  /**
   * 日志记录器（来自 OpenClaw 插件 API 的 api.logger）
   * 为 null 时不输出控制台日志
   */
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  /**
   * 本地日志文件路径（可选）
   * 请求/响应数据将以追加模式写入此文件，便于离线排查
   */
  logFile?: string;
}

// ==================== 插件配置 ====================

/**
 * content-security 插件配置（对应 OpenClaw 插件配置文件中的 pluginConfig 字段）
 *
 * 所有字段均为可选，插件在 register 阶段会校验必填字段（endpoint / token）。
 */
export interface PluginConfig {
  /** CreateTask API 完整地址（必填，如 "https://jprx.sparta.html5.qq.com/data/4064/forward"） */
  endpoint?: string;
  /** OpenClaw Channel Token，用于鉴权（必填，从 pluginConfig 的 token 字段获取） */
  token?: string;
  /** OpenClaw 状态目录（用于读取会话文件，不填时自动检测） */
  openClawDir?: string;
  /** 是否将审核请求/响应写入本地日志文件，默认 false */
  logRecord?: boolean;
  /** 是否启用 fetch 拦截器（审核 LLM Prompt），默认 true */
  enableFetch?: boolean;
  /** 是否启用 before_tool_call hook（审核工具参数），默认 true */
  enableBeforeToolCall?: boolean;
  /** 是否启用 after_tool_call hook（审核工具返回结果），默认 true */
  enableAfterToolCall?: boolean;
  /** 触发熔断降级的连续失败次数阈值，默认 3 */
  failureThreshold?: number;
  /** 熔断后首次探测等待时间（秒），默认 60 秒 */
  retryInterval?: number;
  /** 探测等待时间上限（秒），默认 3600 秒（1 小时） */
  maxRetryInterval?: number;
  /** API 请求超时（毫秒），默认 5000ms */
  timeoutMs?: number;
  /** ResultTypeLevel >= 此值时判定为打击，默认 300（疑似恶意） */
  blockLevel?: number;
}

// ==================== 安全检查结果 ====================

/**
 * checkContentSecurity 函数的返回值
 */
export interface SecurityCheckResult {
  /** 是否被打击（true=拦截, false=放行） */
  blocked: boolean;
  /** 恶意程度等级（来自 ResultTypeLevel，降级时为 undefined） */
  level?: number;
  /** 恶意类型 code（来自 ResultType，降级时为 undefined） */
  resultType?: number;
  /** 一级标签解析结果（来自 ResultFirstLabel，降级时为空对象） */
  labels: Record<string, FirstLabelItem>;
  /** 信安 TraceID，用于向信安团队排查问题（降级时为 undefined） */
  traceId?: string;
}

// ==================== 安全配置 ====================

/**
 * setSecurityConfig 函数的参数，对应 security.ts 中的模块级状态变量
 */
export interface SecurityConfig {
  /** 触发熔断的连续失败次数阈值 */
  failureThreshold?: number;
  /** 熔断后首次探测等待时间（毫秒） */
  baseRetryIntervalMs?: number;
  /** 探测等待时间上限（毫秒） */
  maxRetryIntervalMs?: number;
  /** ResultTypeLevel >= blockLevel 时判定为打击 */
  blockLevel?: number;
}

// ==================== 拦截器配置 ====================

/**
 * setupFetchInterceptor 函数的参数
 */
export interface InterceptorConfig {
  /** OpenClaw 插件 API（提供 logger 等能力） */
  api: any;
  /** CreateTaskClient 实例 */
  client: any;
  /** 是否启用详细日志 */
  enableLogging: boolean;
  /**
   * 需要屏蔽的接口地址（通常是 CreateTask 的 endpoint）
   * 拦截器会跳过包含此字符串的 URL，避免审核请求被自身拦截
   */
  shieldEndpoint: string;
}

// ==================== 消息标准化 ====================

/**
 * 标准化后的消息格式（内部使用）
 * 将 OpenAI / Anthropic 等不同格式的消息统一为 { role, content } 结构
 */
export interface NormalizedMessage {
  /** 消息角色（"user" / "assistant" / "system"） */
  role: string;
  /** 消息内容（纯文本，多模态内容中的文本部分已被提取并拼接） */
  content: string;
}
