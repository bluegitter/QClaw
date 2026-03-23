export const enum SessionType {
  QUESTION = 1,
  ANSWER = 2,
  ANSWER_END = 3,
}

export type MediaType =
  | "Text"       // 纯文本
  | "Picture"    // 图片（URL）
  | "Video"      // 视频（URL）
  | "Audio"      // 音频（URL）
  | "OutLink"    // 外链
  | "Livevideo"  // 直播视频
  | "File";      // 文件


export const enum ResultCode {
  PASS = 0,
  BLOCK = 1,
  PASS_2 = 2,
}

export type SceneType = "prompt" | "output";

export interface MediaItem {
  Data: string;
  MediaType: MediaType;
}

export interface CreateTaskRequest {
  scene: SceneType;
  request_id: string;
  openclaw_channel_token: string;
  data: {
    Comm: {
      SendTime: number;
    };
    Content: {
      QAID?: string;
      SessionID: string;
      SessionType: SessionType;
      Msg: {
        Media: MediaItem[];
        MsgMap: Record<string, any>;
      };
    };
  };
}



export interface FirstLabelItem {
  uiLabel: number;
  uilevel: number;
  strMeaning: string;
}

export interface CreateTaskResponse {
  common: {
    code: number;
    message: string;
  };
  data: {
    ResultCode: number;
    ResultType?: number;
    ResultTypeLevel?: number;
    ResultMsg?: string;
    ResultFirstLabel?: string;
    ResultSecondLabel?: string;
    Operator?: string;
    WhiteBoxAnswer?: string;
    StdRetMsg?: string;
    StdRetCode?: number;
    TraceID?: string;
  } | null;
}



export interface CreateTaskClientOptions {
  endpoint: string;
  openclawChannelToken: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

// ==================== 插件配置 ====================

export interface PluginConfig {
  endpoint?: string;
  token?: string;
  openClawDir?: string;
  logRecord?: boolean;
  enableFetch?: boolean;
  enableBeforeToolCall?: boolean;
  enableAfterToolCall?: boolean;
  failureThreshold?: number;
  retryInterval?: number;
  maxRetryInterval?: number;
  timeoutMs?: number;
  blockLevel?: number;
  /** 上报用户 uid */
  uid?: string;
  /** 上报版本号 */
  version?: string;
  /** 上报设备号 */
  aid?: string;
  /** 上报环境 */
  env?: string;
}


export interface SecurityCheckResult {
  blocked: boolean;
  level?: number;
  resultType?: number;
  resultCode?: number;
  labels: Record<string, FirstLabelItem>;
  traceId?: string;
  /** 本次审核请求的唯一 request_id，用于链路追踪 */
  requestId?: string;
}

// ==================== 安全配置 ====================


export interface SecurityConfig {
  failureThreshold?: number;
  baseRetryIntervalMs?: number;
  maxRetryIntervalMs?: number;
  blockLevel?: number;
}

// ==================== 拦截器配置 ====================

/**
 * setupFetchInterceptor 函数的参数
 */
export interface InterceptorConfig {
  api: any;
  client: any;
  enableLogging: boolean;
  shieldEndpoint: string;
}

// ==================== 消息标准化 ====================

export interface NormalizedMessage {
  role: string;
  content: string;
}
