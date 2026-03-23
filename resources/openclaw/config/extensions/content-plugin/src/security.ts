import { SessionType, ResultCode } from "./types";
import type { MediaItem, SecurityCheckResult, SecurityConfig, SceneType } from "./types";
import type { CreateTaskClient } from "./client";
import { getTracer, getGalileoConfig, reportSecurityMetrics, ROOT_CONTEXT, SpanKind, SpanStatusCode } from "./service.js";
import { getExternalGuid, getExternalUid, getExternalAppVersion, getExternalSourceTerminal, getExternalPromptId, getExternalWechatSessionId, getOpenclawVersion } from "./state";
import type { Context } from "@opentelemetry/api";

let isDegraded = false;
let isProbing = false;
let consecutiveFailures = 0;
let lastRetryTime = 0;

let failureThreshold = 3;
let baseRetryIntervalMs = 60 * 1000;
let currentRetryIntervalMs = baseRetryIntervalMs;
let maxRetryIntervalMs = 3600 * 1000;
let blockLevel = 200;


export const setSecurityConfig = (config: SecurityConfig): void => {
  if (config.failureThreshold !== undefined) failureThreshold = config.failureThreshold;
  if (config.baseRetryIntervalMs !== undefined) {
    baseRetryIntervalMs = config.baseRetryIntervalMs;
    currentRetryIntervalMs = baseRetryIntervalMs;
  }
  if (config.maxRetryIntervalMs !== undefined) maxRetryIntervalMs = config.maxRetryIntervalMs;
  if (config.blockLevel !== undefined) blockLevel = config.blockLevel;
};

/**
 * 内容审核 Span 上报的最小耗时阈值（毫秒）。
 * 低于此阈值的审核请求不上报 Trace Span，减少低耗时请求的上报噪音。
 */
const SECURITY_SPAN_MIN_DURATION_MS = 400;

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
  parentCtx?: Context,
): Promise<SecurityCheckResult> => {
  const passResult: SecurityCheckResult = { blocked: false, labels: {} };
  const content = media.map((m) => m.Data).join("");

  // ==================== Span 上报准备（延迟创建） ====================
  // Span 不再在函数开头立即创建，而是在各分支计算出 durationMs 后，
  // 仅当耗时 ≥ SECURITY_SPAN_MIN_DURATION_MS 时才创建并上报。
  const tracer = getTracer();
  const galileoCfg = getGalileoConfig();
  const genAi = galileoCfg?.galileo.trace.genAi;

  // 根据 source（调用来源）映射为可读的阶段名，便于在后台 trace 中直接识别
  const stageNameMap: Record<string, string> = {
    before_tool_call: "security:tool_input",
    after_tool_call: "security:tool_output",
    llm_request: "security:llm_request",
    llm_response_json: "security:llm_response",
    llm_response_sse: "security:llm_response_stream",
  };
  const stageName = stageNameMap[source] ?? `security:${source}`;
  const resolvedParentCtx = parentCtx ?? ROOT_CONTEXT;

  /**
   * 条件上报：仅当 durationMs ≥ 阈值时创建 Span 并立即 end。
   * 传入 extraAttrs 和可选的 statusOverride 用于设置 Span 状态。
   */
  const emitSpanIfSlow = (
    durationMs: number,
    extraAttrs: Record<string, string | number | boolean>,
    statusOverride?: { code: typeof SpanStatusCode.ERROR; message: string },
  ): void => {
    if (durationMs < SECURITY_SPAN_MIN_DURATION_MS || !tracer) return;
    const span = tracer.startSpan(
      stageName,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "security.check.scene": scene,
          "security.check.source": source,
          "security.check.session_id": sessionId,
          "security.check.session_type": String(sessionType),
          "security.check.content_length": content.length,
          "gen_ai.app.name": genAi?.appName || "openclaw",
          "openclaw.guid": getExternalGuid() ?? "",
          "openclaw.uid": getExternalUid() ?? "",
          "openclaw.app_version": getExternalAppVersion() ?? "",
          "openclaw.source_terminal": getExternalSourceTerminal() ?? "",
          "openclaw.openclaw_version": getOpenclawVersion() ?? "",
          "openclaw.prompt_id": getExternalPromptId() ?? "",
          "openclaw.wechat_session_id": getExternalWechatSessionId() ?? "",
          ...extraAttrs,
        },
      },
      resolvedParentCtx,
    );
    if (statusOverride) {
      span.setStatus(statusOverride);
    }
    span.end();
  };

  const startTime = Date.now();

  // ==================== 降级模式处理 ====================
  if (isDegraded) {
    const now = Date.now();

    // 判断是否到了探测时机，且当前没有正在进行的探测请求
    if (now - lastRetryTime > currentRetryIntervalMs && !isProbing) {
      isProbing = true;

      try {
        // 发送最简探测请求（固定内容 "hello"），验证接口是否恢复
        await client.createTask(
          scene,
          [{ Data: "hello", MediaType: "Text" }],
          sessionId,
          SessionType.QUESTION,
        );

        isDegraded = false;
        isProbing = false;
        consecutiveFailures = 0;
        currentRetryIntervalMs = baseRetryIntervalMs;
      } catch {
        lastRetryTime = Date.now();
        isProbing = false;
        currentRetryIntervalMs = Math.min(currentRetryIntervalMs * 2, maxRetryIntervalMs);

        // trace: 降级探测失败
        const durationMs = Date.now() - startTime;
        emitSpanIfSlow(durationMs, {
          "security.check.blocked": false,
          "security.check.degraded": true,
          "security.check.duration_ms": durationMs,
          "security.check.probe_failed": true,
        });

        // metrics: 降级放行
        reportSecurityMetrics({
          scene,
          source,
          blocked: false,
          degraded: true,
          operationDuration: durationMs / 1000,
          errorType: "probe_failed",
          guid: getExternalGuid() ?? undefined,
          uid: getExternalUid() ?? undefined,
          appVersion: getExternalAppVersion() ?? undefined,
          sourceTerminal: getExternalSourceTerminal() ?? undefined,
          openclawVersion: getOpenclawVersion() ?? undefined,
        });

        return passResult;
      }
    } else {
      // 降级模式，未到探测时机，直接放行
      const durationMs = Date.now() - startTime;
      emitSpanIfSlow(durationMs, {
        "security.check.blocked": false,
        "security.check.degraded": true,
        "security.check.duration_ms": durationMs,
      });

      // metrics: 降级放行
      reportSecurityMetrics({
        scene,
        source,
        blocked: false,
        degraded: true,
        operationDuration: durationMs / 1000,
        guid: getExternalGuid() ?? undefined,
        uid: getExternalUid() ?? undefined,
        appVersion: getExternalAppVersion() ?? undefined,
        sourceTerminal: getExternalSourceTerminal() ?? undefined,
        openclawVersion: getOpenclawVersion() ?? undefined,
      });

      return passResult;
    }
  }

  let attempt = 0;
  const maxAttempts = 2; // 最多尝试 2 次（1 次正常 + 1 次重试）

  while (attempt < maxAttempts) {
    try {
      const { response, requestId } = await client.createTask(scene, media, sessionId, sessionType, qaid, undefined);

      consecutiveFailures = 0;
      currentRetryIntervalMs = baseRetryIntervalMs;

      const data = response.data;
      if (!data) {
        // 响应体中没有 data 字段（接口异常），默认放行
        const durationMs = Date.now() - startTime;
        emitSpanIfSlow(durationMs, {
          "security.check.blocked": false,
          "security.check.degraded": false,
          "security.check.duration_ms": durationMs,
          "security.check.empty_response": true,
          ...(requestId ? { "security.check.request_id": requestId } : {}),
        });

        reportSecurityMetrics({
          scene,
          source,
          blocked: false,
          degraded: false,
          operationDuration: durationMs / 1000,
          errorType: "empty_response",
          requestId,
          guid: getExternalGuid() ?? undefined,
          uid: getExternalUid() ?? undefined,
          appVersion: getExternalAppVersion() ?? undefined,
          sourceTerminal: getExternalSourceTerminal() ?? undefined,
          openclawVersion: getOpenclawVersion() ?? undefined,
        });

        return passResult;
      }

      let labels: Record<string, any> = {};
      if (data.ResultFirstLabel) {
        try {
          labels = JSON.parse(data.ResultFirstLabel);
        } catch {
          // 解析失败忽略，labels 保持空对象
        }
      }
      const blocked =
        data.ResultCode === ResultCode.BLOCK ||
        (data.ResultTypeLevel !== undefined && data.ResultTypeLevel > blockLevel);

      const result: SecurityCheckResult = {
        blocked,
        level: data.ResultTypeLevel,
        resultType: data.ResultType,
        resultCode: data.ResultCode,
        labels,
        traceId: data.TraceID,
        requestId,
      };

      // trace: 审核完成
      const durationMs = Date.now() - startTime;
      emitSpanIfSlow(
        durationMs,
        {
          "security.check.blocked": blocked,
          "security.check.degraded": false,
          "security.check.duration_ms": durationMs,
          "security.check.level": data.ResultTypeLevel ?? 0,
          "security.check.result_type": data.ResultType ?? "",
          "security.check.trace_id": data.TraceID ?? "",
          "security.check.result_code": data.ResultCode ?? "",
          ...(requestId ? { "security.check.request_id": requestId } : {}),
        },
        blocked ? { code: SpanStatusCode.ERROR, message: "content_blocked" } : undefined,
      );

      // metrics: 审核结果
      reportSecurityMetrics({
        scene,
        source,
        blocked,
        degraded: false,
        operationDuration: durationMs / 1000,
        level: data.ResultTypeLevel,
        resultType: data.ResultType,
        resultCode: data.ResultCode,
        securityTraceId: data.TraceID,
        requestId,
        guid: getExternalGuid() ?? undefined,
        uid: getExternalUid() ?? undefined,
        appVersion: getExternalAppVersion() ?? undefined,
        sourceTerminal: getExternalSourceTerminal() ?? undefined,
        openclawVersion: getOpenclawVersion() ?? undefined,
      });

      return result;
    } catch (error: any) {
      attempt++;

      const isTimeout = error?.name === "AbortError" || error?.message?.includes("timeout");
      const isTransient = isTimeout || (error?.status >= 500 && error?.status < 600);

      if (isTransient && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      consecutiveFailures++;

      if (consecutiveFailures >= failureThreshold) {
        isDegraded = true;
        lastRetryTime = Date.now();
      }

      // trace: 请求失败
      const durationMs = Date.now() - startTime;
      const errorMsg = error?.message || String(error);
      emitSpanIfSlow(
        durationMs,
        {
          "security.check.blocked": false,
          "security.check.degraded": false,
          "security.check.duration_ms": durationMs,
          "security.check.attempts": attempt,
          "security.check.entered_degraded": consecutiveFailures >= failureThreshold,
          "error.type": isTimeout ? "timeout" : "request_error",
        },
        { code: SpanStatusCode.ERROR, message: errorMsg },
      );

      // metrics: 请求失败
      reportSecurityMetrics({
        scene,
        source,
        blocked: false,
        degraded: false,
        operationDuration: durationMs / 1000,
        errorType: isTimeout ? "timeout" : "request_error",
        guid: getExternalGuid() ?? undefined,
        uid: getExternalUid() ?? undefined,
        appVersion: getExternalAppVersion() ?? undefined,
        sourceTerminal: getExternalSourceTerminal() ?? undefined,
        openclawVersion: getOpenclawVersion() ?? undefined,
      });

      // 错误时返回放行结果（降级策略：不打击）
      return passResult;
    }
  }

  // while 循环正常退出（理论上不会到达这里），兜底返回放行
  const fallbackDurationMs = Date.now() - startTime;
  emitSpanIfSlow(fallbackDurationMs, {
    "security.check.blocked": false,
    "security.check.degraded": false,
    "security.check.duration_ms": fallbackDurationMs,
    "security.check.fallback_exit": true,
  });
  return passResult;
};
