/**
 * 电脑管家 AI 安全审核 HTTP 客户端 (PCMgr LLM Shield Client)
 */

import { getModerateUrl, getModerateSkillUrl, getModerateScriptUrl, getModerateSkillPackageUrl } from "./endpoints";
import { buildJprxCtxHeader } from "./jprx-sign";
import { fileLog } from "./logger";

export class HttpError extends Error {
  status: number;
  statusText: string;
  body: unknown;

  constructor(message: string, status: number, statusText: string, body: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export interface LLMShieldClientOptions {
  /** @deprecated 不再使用，端点地址已硬编码在 endpoints.ts 中 */
  baseUrl?: string;
  /** 客户端设备标识（gid），用于 JPrx 防重放签名 */
  gid?: string;
  timeoutMs?: number;
  fetchFn?: typeof globalThis.fetch;
  /** AES-128-CBC 加密后的用户 token（由 Electron 主进程加密后通过环境变量传入） */
  encryptedUserToken?: string;
}

export interface ModerateRequest {
  Message: {
    Role: string;
    MultiPart: Array<{
      Content: string;
      ContentType: ContentType;
    }>;
  };
  Scene: string;
  Modes?: string[];
  History?: Array<{
    Role: string;
    Content: string;
    ContentType: ContentType;
  }>;
}

export const enum ContentType {
  TEXT = 1,
}

export interface RiskItem {
  Label: string;
  Reason?: string;
}

export interface ModerateResponse {
  Result?: {
    Decision?: {
      DecisionType?: DecisionType;
    };
    RiskInfo?: {
      Risks?: RiskItem[];
    };
  };
}

// -------- Skill Audit --------

export interface SkillAuditRequest {
  Skill: {
    Name: string;
    Dir: string;
    Source?: string;
  };
  File: {
    Path: string;
    RelPath: string;
    Type: "definition" | "reference" | "script" | "asset";
    Content?: string;
  };
  Scene?: string;
  History?: Array<{
    Role: string;
    Content: string;
    ContentType: ContentType;
  }>;
}

export interface SkillAuditResponse {
  Result?: {
    Decision?: {
      DecisionType?: DecisionType;
    };
    RiskInfo?: {
      Risks?: RiskItem[];
    };
    SkillInfo?: {
      Trusted?: boolean;
      Reason?: string;
    };
  };
}

// -------- Script Audit --------

export type ScriptLanguage =
  | "python" | "javascript" | "shell" | "powershell" | "batch"
  | "ruby" | "perl" | "lua" | "typescript" | "c" | "cpp" | "rust" | "go" | "other";

export interface ScriptAuditRequest {
  Script: {
    Path: string;
    Language: ScriptLanguage;
    Content: string;
    Operation: "create" | "modify";
  };
  Scene?: string;
  History?: Array<{
    Role: string;
    Content: string;
    ContentType: ContentType;
  }>;
}

export interface ScriptAuditResponse {
  Result?: {
    Decision?: {
      DecisionType?: DecisionType;
    };
    RiskInfo?: {
      Risks?: RiskItem[];
    };
    ScriptInfo?: {
      DangerousApis?: string[];
      Reason?: string;
    };
  };
}

// -------- Skill Package Audit --------

export interface SkillPackageAuditRequest {
  Skill: {
    Name: string;
    Dir?: string;
    Source?: string;
  };
  Package: {
    Content: string;   // zip Base64
    FileName: string;
    Size: number;       // zip 原始字节数
    Hash?: string;      // SHA-256
  };
  Scene?: string;
}

export interface SkillPackageAuditResponse {
  Result?: {
    Decision?: {
      DecisionType?: DecisionType;
    };
    RiskInfo?: {
      Risks?: RiskItem[];
    };
    SkillInfo?: {
      Trusted?: boolean;
      Reason?: string;
    };
  };
}

export const enum DecisionType {
  BLOCK = 2,
  MARK = 3,
}

export class LLMShieldClient {
  private gid_: string;
  private timeout_ms_: number;
  private fetch_fn_: typeof globalThis.fetch;
  private encrypted_user_token_: string;

  constructor(options: LLMShieldClientOptions = {}) {
    this.gid_ = options.gid ?? "";
    this.timeout_ms_ = options.timeoutMs ?? 8000;
    this.encrypted_user_token_ = options.encryptedUserToken ?? "";

    const fn = options.fetchFn ?? globalThis.fetch;
    if (!fn) {
      throw new Error(
        "global fetch is unavailable. Please provide a fetch polyfill in your environment or pass an implementation via fetchFn."
      );
    }
    this.fetch_fn_ = fn.bind(globalThis);
  }

  /** 更新 gid（设备指纹可能在初始化后才获取到） */
  setGid(gid: string): void {
    this.gid_ = gid;
  }

  /** 动态更新加密后的用户 token（用于登录后由主进程推送更新） */
  setEncryptedUserToken(token: string): void {
    this.encrypted_user_token_ = token;
  }

  // -------- Internal utility methods --------

  private async postJson(
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    timeoutOverrideMs?: number
  ): Promise<unknown> {
    const controller = new AbortController();
    const effectiveTimeout = timeoutOverrideMs ?? this.timeout_ms_;
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

    const bodyStr = JSON.stringify(body ?? {});

    fileLog(`[postJson] >>> ${url} | timeout=${effectiveTimeout}ms`);
    fileLog(`[postJson] >>> REQUEST BODY:\n${bodyStr}`);
    const startTime = Date.now();

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...extraHeaders,
      };

      // JPrx 签名：sign = md5(data + key + rnd + date + gid)
      headers["JPrx-Ctx"] = buildJprxCtxHeader(bodyStr, this.gid_);

      // product id
      headers["productID"] = "1001";

      // 用户登录 token（已由 Electron 主进程 AES-128-CBC 加密，直接透传密文）
      if (this.encrypted_user_token_) {
        headers["userToken"] = this.encrypted_user_token_;
        fileLog(`[token] encrypted user token updated`);
      }

      const resp = await this.fetch_fn_(url, {
        method: "POST",
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      const text = await resp.text();
      const elapsed = Date.now() - startTime;
      fileLog(`[postJson] <<< ${url} | status=${resp.status} | ${elapsed}ms`);
      fileLog(`[postJson] <<< RESPONSE BODY:\n${text}`);

      if (resp.status !== 200) {
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : text;
        } catch {}
        throw new HttpError(
          `Request failed with status ${resp.status}`,
          resp.status,
          resp.statusText,
          parsed
        );
      }

      try {
        return text ? JSON.parse(text) : {};
      } catch (e: any) {
        throw new Error(`JSON parsing failed: ${e.message}`, { cause: e });
      }
    } catch (e: any) {
      if (e instanceof HttpError) {
        const bodyStr = typeof e.body === "string" ? e.body : JSON.stringify(e.body ?? null);
        const elapsed = Date.now() - startTime;
        fileLog(`[postJson] !!! ${url} | ${elapsed}ms | status=${e.status} | body=${bodyStr.slice(0, 500)}`);
        throw e;
      }
      const elapsed = Date.now() - startTime;
      fileLog(`[postJson] !!! ${url} | ${elapsed}ms | error.name=${e.name} | error.message=${e.message} | cause=${e.cause?.message ?? "N/A"}`);
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // -------- Public methods --------

  /**
   * Check endpoint connectivity
   */
  async ping(): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const resp = await this.fetch_fn_(getModerateUrl(), {
        method: "OPTIONS",
        signal: controller.signal,
      });
      return !!resp.status;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Non-streaming moderation request.
   */
  async moderate(
    request?: ModerateRequest,
    extraHeaders?: Record<string, string>
  ): Promise<ModerateResponse> {
    const body = request ?? {};
    return this.postJson(getModerateUrl(), body, extraHeaders) as Promise<ModerateResponse>;
  }

  /**
   * Skill audit request.
   */
  async moderateSkill(
    request: SkillAuditRequest,
    extraHeaders?: Record<string, string>
  ): Promise<SkillAuditResponse> {
    return this.postJson(getModerateSkillUrl(), request, extraHeaders) as Promise<SkillAuditResponse>;
  }

  /**
   * Script audit request.
   */
  async moderateScript(
    request: ScriptAuditRequest,
    extraHeaders?: Record<string, string>
  ): Promise<ScriptAuditResponse> {
    return this.postJson(getModerateScriptUrl(), request, extraHeaders) as Promise<ScriptAuditResponse>;
  }

  /**
   * Skill package audit request.
   * 超时放宽到 60s（zip 包体积较大，Base64 编码后膨胀 ~33%）。
   */
  async moderateSkillPackage(
    request: SkillPackageAuditRequest,
    extraHeaders?: Record<string, string>
  ): Promise<SkillPackageAuditResponse> {
    return this.postJson(
      getModerateSkillPackageUrl(),
      request,
      extraHeaders,
      30_000
    ) as Promise<SkillPackageAuditResponse>;
  }
}
