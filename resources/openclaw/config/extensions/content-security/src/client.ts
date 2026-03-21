import fs from "node:fs";
import path from "node:path";
import type {
  CreateTaskClientOptions,
  CreateTaskRequest,
  CreateTaskResponse,
  MediaItem,
  SessionType,
  SceneType,
} from "./types";
import { generateRequestId, getCurrentTimestamp } from "./utils";

/**
 * HTTP 错误
 *
 * 当 CreateTask 接口返回非 200 状态码，或业务层返回 common.code !== 0 时抛出。
 * 调用方可通过 `instanceof HttpError` 区分网络/超时错误与 HTTP 错误。
 */
export class HttpError extends Error {
  /** HTTP 状态码，如 400、500 */
  status: number;
  /** HTTP 状态文本，如 "Bad Request" */
  statusText: string;
  /** 响应体（已尝试 JSON 解析，失败则为原始字符串） */
  body: any;

  constructor(message: string, status: number, statusText: string, body: any) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

/**
 * CreateTask API 客户端
 *
 * 封装对后端代理接口的调用，提供：
 * - 请求构造（scene / request_id / openclaw_channel_token / data）
 * - 超时控制（AbortController）
 * - 请求/响应日志（控制台 + 本地文件双写）
 * - 连通性探测（ping）
 *
 * 注意：构造时必须传入 `originalFetch`（拦截器注册前保存的原始 fetch），
 * 否则审核请求本身也会被 fetch 拦截器捕获，造成死循环。
 */
export class CreateTaskClient {
  /** CreateTask 接口的完整 URL */
  private endpoint: string;
  /** OpenClaw Channel Token，用于鉴权 */
  private openclawChannelToken: string;
  /** 单次请求超时时间（毫秒），默认 5000ms */
  private timeoutMs: number;
  /**
   * 实际使用的 fetch 函数。
   * 必须是拦截器注册前保存的原始 fetch，避免审核请求被自身拦截。
   */
  private fetchFn: typeof fetch;
  /** 日志记录器（来自 OpenClaw 插件 API），为 null 时不输出控制台日志 */
  private logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void } | null;
  /** 本地日志文件路径，为 null 时不写文件 */
  private logFile: string | null;

  constructor(options: CreateTaskClientOptions) {
    this.endpoint = options.endpoint;
    this.openclawChannelToken = options.openclawChannelToken;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.logger = options.logger ?? null;
    this.logFile = options.logFile ?? null;

    // 优先使用调用方传入的 fetchFn（通常是拦截器注册前保存的原始 fetch）
    // 若未传则使用 globalThis.fetch，但此时需确保拦截器尚未注册
    const fn = options.fetchFn ?? globalThis.fetch;
    if (!fn) {
      throw new Error("global fetch 不可用，请提供 fetchFn 参数");
    }
    // bind(globalThis) 确保 fetch 在正确的 this 上下文中执行
    this.fetchFn = fn.bind(globalThis);
  }

  /**
   * 将日志同时写入控制台（api.logger）和本地文件（追加模式）
   *
   * @param level - 日志级别：INFO / WARN / ERROR
   * @param tag - 日志标签，如 "CreateTask"
   * @param message - 日志消息
   * @param data - 附加数据（可选），会被 JSON.stringify 格式化输出
   */
  private writeLog(level: string, tag: string, message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    const dataStr = data !== undefined ? `\n${JSON.stringify(data, null, 2)}` : "";
    const line = `${timestamp} [${level}] [${tag}]${message}${dataStr}`;

    // 输出到控制台（通过 api.logger）
    if (this.logger) {
      if (level === "ERROR") this.logger.error(line);
      else if (level === "WARN") this.logger.warn(line);
      else this.logger.info(line);
    }

    // 同时写入日志文件（目录不存在时自动创建）
    if (this.logFile) {
      try {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
        fs.appendFileSync(this.logFile, line + "\n", "utf-8");
      } catch {
        // 写文件失败不影响主流程，静默忽略
      }
    }
  }

  /**
   * 调用 CreateTask 接口进行内容审核（同步模式）
   *
   * 接口地址：POST {endpoint}（完整 URL，如 https://jprx.sparta.html5.qq.com/data/4064/forward）
   *
   * 请求流程：
   * 1. 构造 CreateTaskRequest（含 scene / request_id / openclaw_channel_token / data）
   * 2. 设置 AbortController 超时
   * 3. 发送 POST 请求，等待响应
   * 4. 解析响应体，检查 HTTP 状态码和 common.code
   * 5. 返回 CreateTaskResponse
   *
   * @param scene - 场景标识："prompt"=输入审核, "output"=输出审核
   * @param media - 审核内容数组，每项包含 Data（文本或 URL）和 MediaType
   * @param sessionId - 会话ID，同一会话的连续对话使用同一个（由 session.ts 管理）
   * @param sessionType - 会话类型：1=问, 2=答, 3=回答结束（SessionType 枚举）
   * @param qaid - 问答对唯一ID（可选），用于关联同一轮问答的问和答
   * @returns CreateTask 同步响应，包含 common + data（审核结果）
   * @throws HttpError - HTTP 非 200 或业务层 common.code !== 0
   * @throws Error - 网络超时、JSON 解析失败等
   */
  async createTask(
    scene: SceneType,
    media: MediaItem[],
    sessionId: string,
    sessionType: SessionType,
    qaid?: string,
  ): Promise<CreateTaskResponse> {
    // 每次请求生成唯一的 request_id，用于链路追踪
    const requestId = generateRequestId();

    const request: CreateTaskRequest = {
      scene,
      request_id: requestId,
      openclaw_channel_token: this.openclawChannelToken,
      data: {
        Comm: {
          // SendTime 要求秒级 Unix 时间戳
          SendTime: getCurrentTimestamp(),
        },
        Content: {
          SessionID: sessionId,
          SessionType: sessionType,
          Msg: {
            Media: media,
            MsgMap: {},
          },
          // QAID 仅在有值时传入，避免接口报参数错误
          ...(qaid ? { QAID: qaid } : {}),
        },
      },
    };

    const url = this.endpoint;
    // AbortController 用于实现请求超时：超时后 abort() 会让 fetch 抛出 AbortError
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    // 打印请求数据（含完整 URL 和请求体，便于排查问题）
    this.writeLog("INFO", "CreateTask", ` → 请求 [${request.request_id}]`, {
      url,
      request,
    });

    try {
      const resp = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      const text = await resp.text();

      // HTTP 状态码非 200 时，尝试解析响应体后抛出 HttpError
      if (resp.status !== 200) {
        let parsed: any = text;
        try {
          parsed = text ? JSON.parse(text) : text;
        } catch {
          // JSON 解析失败，保留原始文本作为 body
        }
        this.writeLog("ERROR", "CreateTask", ` ← 响应错误 [${request.request_id}] status=${resp.status}`, parsed);
        throw new HttpError(
          `CreateTask 请求失败，状态码 ${resp.status}`,
          resp.status,
          resp.statusText,
          parsed,
        );
      }

      try {
        const rawResponse = text ? JSON.parse(text) : {};

        // 打印原始响应（含完整嵌套结构，便于排查）
        this.writeLog("INFO", "CreateTask", ` ← 响应 [${request.request_id}]`, rawResponse);

        // 后端代理接口返回 { ret, data: { resp: { common, data } } } 嵌套结构，
        // 需要提取 data.resp 层才能映射到 CreateTaskResponse（{ common, data }）
        const response: CreateTaskResponse = rawResponse?.data?.resp ?? rawResponse;

        // 检查业务层面的错误（HTTP 200 但 common.code !== 0）
        if (response.common && response.common.code !== 0) {
          throw new HttpError(
            `CreateTask 业务错误: code=${response.common.code} - ${response.common.message}`,
            400,
            "Business Error",
            response,
          );
        }

        return response;
      } catch (e: any) {
        if (e instanceof HttpError) throw e;
        throw new Error(`JSON 解析失败: ${e.message}`, { cause: e });
      }
    } catch (e: any) {
      if (!(e instanceof HttpError)) {
        // 网络错误、超时（AbortError）等非 HTTP 错误，统一打印日志
        this.writeLog("ERROR", "CreateTask", ` ← 请求异常 [${request.request_id}]: ${e.message || e}`);
      }
      throw e;
    } finally {
      // 无论成功还是失败，都要清除超时定时器，避免内存泄漏
      clearTimeout(timeoutId);
    }
  }

  /**
   * 连通性探测：发送一个最简请求检测接口是否可用
   *
   * 用于熔断降级后的恢复探测：
   * - 发送固定内容 "hello" 作为探测请求
   * - 成功返回 true，任何错误返回 false
   * - 不抛出异常，调用方无需 try/catch
   *
   * @param scene - 场景标识（使用 "prompt" 即可）
   * @param sessionId - 会话ID
   * @returns 接口是否可用
   */
  async ping(scene: SceneType, sessionId: string): Promise<boolean> {
    try {
      await this.createTask(
        scene,
        [{ Data: "hello", MediaType: "Text" }],
        sessionId,
        1 as SessionType, // SessionType.QUESTION
      );
      return true;
    } catch {
      return false;
    }
  }
}
