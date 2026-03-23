/**
 * 脚本审核模块
 *
 * 在 before_tool_call 中判断文件写入工具是否写入脚本文件，
 * 匹配时调用 /v2/moderate/script 进行审核。
 */

import path from "node:path";
import { LOG_TAG } from "./constants";
import {
  LLMShieldClient,
  ContentType,
  DecisionType,
  ScriptLanguage,
  ScriptAuditRequest,
  ScriptAuditResponse,
} from "./client";
import { getDeviceFingerprintValue } from "./security";
import { globalCircuitBreaker } from "./circuit-breaker";
import { generateRequestId, recordLogEvent } from "./utils";
import { getLabelName } from "./labels";
import { fileLog } from "./logger";

/** 写入文件的工具名集合 */
const WRITE_TOOLS = new Set(["write", "write_to_file", "replace_in_file"]);

/** 后缀 → 语言标识 */
const SCRIPT_EXT_MAP: Record<string, ScriptLanguage> = {
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".fish": "shell",
  ".bat": "batch",
  ".cmd": "batch",
  ".ps1": "powershell",
  ".vbs": "other",
  ".wsf": "other",
  ".py": "python",
  ".js": "javascript",
  ".ts": "typescript",
  ".rb": "ruby",
  ".pl": "perl",
  ".lua": "lua",
  ".c": "c",
  ".cpp": "cpp",
  ".rs": "rust",
  ".go": "go",
};

function getScriptLanguage(filePath: string): ScriptLanguage | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return SCRIPT_EXT_MAP[ext];
}

export interface ScriptAuditResult {
  handled: boolean;
  block?: boolean;
  blockReason?: string;
  reasonText?: string;
  resolvedPath?: string;
}

export async function tryScriptAudit(
  api: any,
  client: LLMShieldClient,
  sceneId: string,
  toolName: string,
  params: any,
  enableLogging: boolean,
  history?: Array<{ Role: string; Content: string; ContentType: ContentType }>
): Promise<ScriptAuditResult> {
  api.logger.debug(`[${LOG_TAG}] tryScriptAudit: ${toolName}`);
  fileLog(`[script_audit] tryScriptAudit: toolName=${toolName} params=${JSON.stringify(params)}`);

  if (!WRITE_TOOLS.has(toolName)) {
    fileLog(`[script_audit] not a write tool (${toolName}), skip → handled=false`);
    return { handled: false };
  }

  const rawFilePath = extractFilePath(params);
  if (!rawFilePath) {
    fileLog(`[script_audit] extractFilePath returned undefined, toolName=${toolName}, paramKeys=${Object.keys(params || {}).join(",")}`);
    return { handled: false };
  }

  const filePath = path.isAbsolute(rawFilePath) ? rawFilePath : path.resolve(process.cwd(), rawFilePath);

  const ext = path.extname(filePath).toLowerCase();
  const language = getScriptLanguage(filePath);
  if (!language) {
    fileLog(`[script_audit] unsupported extension "${ext}" for file "${filePath}" → handled=false`);
    return { handled: false };
  }

  const content = extractContent(toolName, params);
  if (!content) {
    fileLog(`[script_audit] extractContent returned undefined, toolName=${toolName}, paramKeys=${Object.keys(params || {}).join(",")}`);
    return { handled: false };
  }

  fileLog(`[script_audit] matched: filePath=${filePath}, ext=${ext}, language=${language}, contentLength=${content.length}, preview=${JSON.stringify(content.slice(0, 30))}`);

  const operation: "create" | "modify" = toolName === "replace_in_file" ? "modify" : "create";

  const requestId = generateRequestId();

  recordLogEvent(api, LOG_TAG, "script_audit(check)", {
    requestId, filePath, language, operation, contentLength: content.length,
  }, enableLogging);

  const request: ScriptAuditRequest = {
    Script: { Path: filePath, Language: language, Content: content, Operation: operation },
    Scene: sceneId,
    History: history,
  };

  fileLog(`[script_audit] REQ (${requestId}) FULL BODY: ${JSON.stringify(request)}`);

  let response: ScriptAuditResponse;
  try {
    if (globalCircuitBreaker.isOpen()) {
      const remaining = Math.round(globalCircuitBreaker.remainingCooldownMs() / 1000);
      api.logger.debug(`[${LOG_TAG}] Circuit-breaker is open, skipping script audit.`);
      fileLog(`[script_audit] SKIP (circuit-breaker open, remaining cooldown: ${remaining}s)`);
      return { handled: true, resolvedPath: filePath };
    }

    response = await client.moderateScript(request, {
      "X-Request-Id": requestId,
      "X-Device-Fingerprint": getDeviceFingerprintValue(),
    });

    globalCircuitBreaker.recordSuccess();
  } catch (error: any) {
    globalCircuitBreaker.recordFailure();
    api.logger.error(`[${LOG_TAG}] Script audit failed: ${error.message || error}`);
    return { handled: true, resolvedPath: filePath };
  }

  fileLog(`[script_audit] RESP (${requestId}) FULL BODY: ${JSON.stringify(response)}`);
  recordLogEvent(api, LOG_TAG, "script_audit(result)", { requestId, response }, enableLogging);

  const decision = response.Result?.Decision?.DecisionType;
  const risks = response.Result?.RiskInfo?.Risks ?? [];
  const labels = risks.map((r) => r.Label);

  if (decision === DecisionType.BLOCK) {
    const labelNames = Array.from(new Set(
      risks.map((r) => r.Reason || getLabelName(r.Label, "zh"))
    ));
    const reasonTextFull = labelNames.join(", ");
    const reasonText = labelNames[0] || "";

    const blockReason = `该脚本被安全策略拦截：${reasonTextFull}。请修改后重试`;

    recordLogEvent(api, LOG_TAG, "script_audit(block)", { requestId, blockReason }, enableLogging);

    return { handled: true, block: true, blockReason, reasonText, resolvedPath: filePath };
  }

  return { handled: true, resolvedPath: filePath };
}

function extractFilePath(params: any): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  return params.path ?? params.filePath ?? params.file_path ?? params.file ?? undefined;
}

function extractContent(toolName: string, params: any): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  if (params.content && typeof params.content === "string") return params.content;
  if (toolName === "replace_in_file" && typeof params.new_str === "string") return params.new_str;
  return undefined;
}
