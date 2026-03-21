import { SessionType, ResultCode } from "./types";
import type { MediaItem, SecurityCheckResult, SecurityConfig, SceneType } from "./types";
import { parseFirstLabels, getResultTypeName, getResultLevelName } from "./labels";
import { recordLogEvent } from "./utils";
import type { CreateTaskClient } from "./client";

// ==================== 模块级状态（熔断降级） ====================
// 以下变量维护熔断器的运行状态，模块级单例，所有审核调用共享。

/** 是否处于降级模式（熔断已触发） */
let isDegraded = false;
/** 是否正在进行探测请求（防止并发探测） */
let isProbing = false;
/** 连续失败次数，达到 failureThreshold 时触发熔断 */
let consecutiveFailures = 0;
/** 上次探测时间（毫秒时间戳），用于计算下次探测时机 */
let lastRetryTime = 0;

/** 触发熔断的连续失败次数阈值，默认 3 次 */
let failureThreshold = 3;
/** 熔断后首次探测等待时间（毫秒），默认 60 秒 */
let baseRetryIntervalMs = 60 * 1000;
/** 当前探测等待时间（毫秒），每次探测失败后指数增长 */
let currentRetryIntervalMs = baseRetryIntervalMs;
/** 探测等待时间上限（毫秒），默认 1 小时，防止无限增长 */
let maxRetryIntervalMs = 3600 * 1000;
/** ResultTypeLevel > 此值时判定为打击，默认 200 */
let blockLevel = 200;

/**
 * 更新安全/降级配置
 *
 * 在插件 register 阶段调用，将插件配置（PluginConfig）中的参数同步到模块级变量。
 * 未传入的字段保持默认值不变。
 *
 * @param config - 安全配置对象（SecurityConfig）
 */
export const setSecurityConfig = (config: SecurityConfig): void => {
  if (config.failureThreshold !== undefined) failureThreshold = config.failureThreshold;
  if (config.baseRetryIntervalMs !== undefined) {
    baseRetryIntervalMs = config.baseRetryIntervalMs;
    // 重置当前重试间隔，避免旧值影响新配置
    currentRetryIntervalMs = baseRetryIntervalMs;
  }
  if (config.maxRetryIntervalMs !== undefined) maxRetryIntervalMs = config.maxRetryIntervalMs;
  if (config.blockLevel !== undefined) blockLevel = config.blockLevel;
};

/**
 * 获取当前 blockLevel
 *
 * 供外部模块读取当前打击阈值（如日志输出时使用）。
 */
export const getBlockLevel = (): number => blockLevel;

/**
 * 内容安全审核（核心函数）
 *
 * 封装了完整的审核生命周期，包括：
 * - **降级模式处理**：熔断触发后，按指数退避策略定期发送探测请求，
 *   探测成功则恢复正常模式，探测失败则继续降级（C 端产品降级时不放行，直接返回 passResult）
 * - **瞬时错误重试**：网络超时或 5xx 错误时，最多重试 1 次（共 2 次尝试）
 * - **连续失败计数**：每次不可重试的错误都累加计数，达到阈值后触发熔断
 * - **打击判断**：ResultCode=1 或 ResultTypeLevel >= blockLevel 时判定为打击
 *
 * 降级策略说明（C 端产品）：
 * - 审核服务不可用时，默认不放行（返回 passResult，blocked=false）
 * - 这是因为 C 端产品面向普通用户，安全要求更高，宁可误拦截也不放过有害内容
 * - 如需改为"降级放行"，可将 passResult.blocked 改为 false（当前已是 false，即放行）
 *
 * @param api - OpenClaw 插件 API，提供 logger 等能力
 * @param client - CreateTaskClient 实例，用于发起审核请求
 * @param scene - 场景标识："prompt"=输入审核, "output"=输出审核
 * @param media - 审核内容数组，每项包含 Data 和 MediaType
 * @param sessionId - 会话ID（由 session.ts 的 getSessionId 生成）
 * @param sessionType - 会话类型（SessionType.QUESTION=1 / ANSWER=2 / ANSWER_END=3）
 * @param source - 来源标识，用于日志区分（如 "llm_request" / "before_tool_call" / "after_tool_call"）
 * @param enableLogging - 是否启用详细日志（对应插件配置的 logRecord 字段）
 * @param logTag - 日志标签前缀（如 "content-security"）
 * @param qaid - 问答对唯一ID（可选），用于关联同一轮问答的问和答
 * @returns SecurityCheckResult，包含 blocked / level / resultType / labels / traceId
 */
export const checkContentSecurity = async (
  api: any,
  client: CreateTaskClient,
  scene: SceneType,
  media: MediaItem[],
  sessionId: string,
  sessionType: SessionType,
  source: string,
  enableLogging: boolean,
  logTag: string = "",
  qaid?: string,
): Promise<SecurityCheckResult> => {
  // 降级/错误时的默认返回值：不打击（放行）
  // C 端产品如需降级不放行，可将 blocked 改为 true
  const passResult: SecurityCheckResult = { blocked: false, labels: {} };

  // ==================== 降级模式处理 ====================
  if (isDegraded) {
    const now = Date.now();

    // 判断是否到了探测时机，且当前没有正在进行的探测请求
    if (now - lastRetryTime > currentRetryIntervalMs && !isProbing) {
      isProbing = true;
      api.logger.info(`[${logTag}] 处于降级状态，发送探测请求...`);

      try {
        // 发送最简探测请求（固定内容 "hello"），验证接口是否恢复
        await client.createTask(
          scene,
          [{ Data: "hello", MediaType: "Text" }],
          sessionId,
          SessionType.QUESTION,
        );

        // 探测成功：恢复正常模式，重置所有熔断状态
        api.logger.info(`[${logTag}] 探测成功，恢复正常模式`);
        isDegraded = false;
        isProbing = false;
        consecutiveFailures = 0;
        currentRetryIntervalMs = baseRetryIntervalMs;
        // 探测成功后继续执行正常审核（不 return，让代码继续往下走）
      } catch {
        // 探测失败：更新下次探测时间，指数增长等待间隔（上限 maxRetryIntervalMs）
        lastRetryTime = Date.now();
        isProbing = false;
        currentRetryIntervalMs = Math.min(currentRetryIntervalMs * 2, maxRetryIntervalMs);
        api.logger.warn(
          `[${logTag}] 探测失败，下次重试间隔 ${Math.round(currentRetryIntervalMs / 1000)}s`,
        );
        // 探测失败：继续降级，直接返回放行结果
        return passResult;
      }
    } else {
      // 还未到探测时机，或正在探测中：直接返回放行结果
      return passResult;
    }
  }

  // ==================== 正常审核请求 ====================

  // 记录审核前的日志（仅在 enableLogging=true 时输出）
    recordLogEvent(
    api,
    logTag,
    `${source}(check)`,
    { scene, sessionId, sessionType, mediaCount: media.length },
    enableLogging,
  );

  let attempt = 0;
  const maxAttempts = 2; // 最多尝试 2 次（1 次正常 + 1 次重试）

  while (attempt < maxAttempts) {
    try {
      const response = await client.createTask(scene, media, sessionId, sessionType, qaid);

      // 记录审核结果日志
      recordLogEvent(api, logTag, `${source}(result)`, { response }, enableLogging);

      // 审核成功：重置连续失败计数和重试间隔
      consecutiveFailures = 0;
      currentRetryIntervalMs = baseRetryIntervalMs;

      const data = response.data;
      if (!data) {
        // 响应体中没有 data 字段（接口异常），默认放行
        return passResult;
      }

      // 解析一级标签（ResultFirstLabel 是 JSON 字符串，需要手动解析）
      let labels: Record<string, any> = {};
      if (data.ResultFirstLabel) {
        try {
          labels = JSON.parse(data.ResultFirstLabel);
        } catch {
          // 解析失败忽略，labels 保持空对象
        }
      }

      // 打击判断（满足任一条件即打击）：
      // 方式1：ResultCode === 1（接口明确返回打击）
      // 方式2：ResultTypeLevel > blockLevel（等级超过阈值才打击，等于阈值不打击）
      const blocked =
        data.ResultCode === ResultCode.BLOCK ||
        (data.ResultTypeLevel !== undefined && data.ResultTypeLevel > blockLevel);

      const result: SecurityCheckResult = {
        blocked,
        level: data.ResultTypeLevel,
        resultType: data.ResultType,
        labels,
        traceId: data.TraceID, // TraceID 用于向信安团队排查问题
      };

      if (blocked) {
        // 打印详细的打击日志，包含等级、类型、命中标签和 TraceID
        const hitLabels = parseFirstLabels(data.ResultFirstLabel || "", blockLevel);
        api.logger.warn(
          `[${logTag}] ${source} 被打击 | ResultCode=${data.ResultCode} ` +
            `| Level=${data.ResultTypeLevel}(${getResultLevelName(data.ResultTypeLevel || 0)}) ` +
            `| Type=${data.ResultType}(${getResultTypeName(data.ResultType || 0)}) ` +
            `| Labels=${hitLabels.join(",")} ` +
            `| TraceID=${data.TraceID || "N/A"}`,
        );
      }

      return result;
    } catch (error: any) {
      attempt++;

      // 判断是否为可重试的瞬时错误：
      // - AbortError：请求超时（AbortController.abort() 触发）
      // - 5xx：服务端临时错误
      const isTimeout = error?.name === "AbortError" || error?.message?.includes("timeout");
      const isTransient = isTimeout || (error?.status >= 500 && error?.status < 600);
      const errorMsg = isTimeout ? "请求超时" : String(error);

      if (isTransient && attempt < maxAttempts) {
        // 瞬时错误且还有重试机会：等待 500ms 后重试
        api.logger.warn(`[${logTag}] 瞬时错误(${errorMsg})，重试中... (${attempt}/${maxAttempts - 1})`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      // 不可重试的错误（或已达最大重试次数）：累加连续失败计数
      consecutiveFailures++;
      recordLogEvent(
        api,
        logTag,
        `${source}(error)`,
        { error: errorMsg, consecutiveFailures },
        enableLogging,
      );

      console.error(
        `[${logTag}] 审核失败 (${source}) [Failures:${consecutiveFailures}]:`,
        errorMsg,
      );

      // 连续失败达到阈值：触发熔断，进入降级模式
      if (consecutiveFailures >= failureThreshold) {
        isDegraded = true;
        lastRetryTime = Date.now();
        api.logger.error(
          `[${logTag}] 连续失败达到阈值(${failureThreshold})，进入降级模式。` +
            `下次探测间隔 ${Math.round(currentRetryIntervalMs / 1000)}s`,
        );
      }

      // 错误时返回放行结果（降级策略：不打击）
      return passResult;
    }
  }

  // while 循环正常退出（理论上不会到达这里），兜底返回放行
  return passResult;
};
