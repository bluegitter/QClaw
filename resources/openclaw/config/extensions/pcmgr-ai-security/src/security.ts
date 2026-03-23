/**
 * 电脑管家 AI 内容安全检查
 *
 * 熔断降级由全局 CircuitBreaker 统一管理，所有审核接口共享。
 */

import { LOG_TAG } from "./constants";
import { LLMShieldClient, ContentType, DecisionType, RiskItem } from "./client";
import { generateRequestId, recordLogEvent } from "./utils";
import { fileLog } from "./logger";
import { globalCircuitBreaker, CircuitBreakerConfig } from "./circuit-breaker";

export { fileLog };

// Device fingerprint
let deviceFingerprint = "";

export function getDeviceFingerprintValue(): string {
  return deviceFingerprint;
}

export interface SecurityConfig {
  failureThreshold?: number;
  cooldownMs?: number;
  deviceFingerprint?: string;
}

export function setSecurityConfig(config: SecurityConfig): void {
  const cbConfig: CircuitBreakerConfig = {};
  if (config.failureThreshold !== undefined) cbConfig.failureThreshold = config.failureThreshold;
  if (config.cooldownMs !== undefined) cbConfig.cooldownMs = config.cooldownMs;
  if (Object.keys(cbConfig).length > 0) globalCircuitBreaker.configure(cbConfig);

  if (config.deviceFingerprint !== undefined) deviceFingerprint = config.deviceFingerprint;
}

function writeModerateLog(entry: string): void {
  fileLog(entry);
}

export function writeLlmApiLog(entry: string): void {
  fileLog(entry);
}

export interface CheckResult {
  decision?: DecisionType;
  labels: string[];
  risks: RiskItem[];
}

interface HistoryItem {
  Role: string;
  Content: string;
  ContentType: ContentType;
}

interface MultiPart {
  Content: string;
  ContentType: ContentType;
}

export async function checkContentSecurity(
  api: any,
  client: LLMShieldClient,
  sceneId: string,
  multiPart: MultiPart[],
  role: string,
  source: string,
  enableLogging: boolean,
  history?: HistoryItem[],
  modes?: string[]
): Promise<CheckResult> {
  globalCircuitBreaker.setLogger(api.logger);
  if (globalCircuitBreaker.isOpen()) {
    const remaining = Math.round(globalCircuitBreaker.remainingCooldownMs() / 1000);
    api.logger.debug(`[${LOG_TAG}] Circuit-breaker is open, skipping moderation. Remaining cooldown: ${remaining}s`);
    writeModerateLog(`[${source}] SKIP (circuit-breaker open, remaining cooldown: ${remaining}s)`);
    return { labels: [], risks: [] };
  }

  const requestId = generateRequestId();

  const moderateBody = {
    Message: { Role: role, MultiPart: multiPart },
    Scene: sceneId,
    Modes: modes,
    History: history,
  };

  const contentPreview = multiPart.map((p) => p.Content.length).join("+");
  writeModerateLog(`[${source}] REQ  (${requestId}) role=${role} scene=${sceneId} parts=${contentPreview}b history=${history?.length ?? 0}`);
  writeModerateLog(`[${source}] REQ  (${requestId}) FULL BODY: ${JSON.stringify(moderateBody)}`);

  let attempt = 0;
  const maxAttempts = 2;

  while (attempt < maxAttempts) {
    try {
      const response = await client.moderate(moderateBody, {
        "X-Request-Id": requestId,
        "X-Device-Fingerprint": deviceFingerprint,
      });

      globalCircuitBreaker.recordSuccess();

      const decision = response.Result?.Decision?.DecisionType;
      const risks = response.Result?.RiskInfo?.Risks ?? [];
      const labels = risks.map((r) => r.Label);

      writeModerateLog(`[${source}] RESP (${requestId}) decision=${decision ?? "pass"} labels=[${labels.join(",")}]`);
      writeModerateLog(`[${source}] RESP (${requestId}) FULL BODY: ${JSON.stringify(response)}`);

      return { decision, labels, risks };
    } catch (error: any) {
      attempt++;

      const isTimeout = error?.name === "AbortError" || error?.message?.includes("timeout");
      const isTransient = isTimeout || (error?.status >= 500 && error?.status < 600);
      const errorMsg = isTimeout ? "Moderation timed out" : String(error);

      if (isTransient && attempt < maxAttempts) {
        api.logger.warn(
          `[${LOG_TAG}] Transient error (${errorMsg}), retrying... (${attempt}/${maxAttempts - 1})`
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }

      globalCircuitBreaker.recordFailure();
      writeModerateLog(`[${source}] ERR  (${requestId}) ${errorMsg}`);
      recordLogEvent(
        api, LOG_TAG, `${source}(error)`,
        { error: errorMsg, requestId, consecutiveFailures: globalCircuitBreaker.consecutiveFailures },
        enableLogging
      );

      fileLog(
        `[${LOG_TAG}] Moderation failed (${source}) [RID:${requestId}] [Failures:${globalCircuitBreaker.consecutiveFailures}]: ${errorMsg}`
      );

      return { labels: [], risks: [] };
    }
  }

  return { labels: [], risks: [] };
}
