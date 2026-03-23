/**
 * Hook 注册模块
 *
 * 将 before_tool_call 的事件处理逻辑从 register() 中拆出，
 * 使主入口保持简洁。
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for commented-out prompt audit code
import { LLMShieldClient, ContentType, DecisionType } from "./client";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for commented-out prompt audit code
import {
  recordLogEvent,
  generateSecurityMessage,
} from "./utils";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for commented-out prompt audit code
import { checkContentSecurity } from "./security";
import { trySkillAudit } from "./skill-audit";
import { tryScriptAudit } from "./script-audit";
import { extractSessionContext } from "./session-history";
import {
  reportAuditLog,
  AuditActionType,
  AuditRiskLevel,
  AuditResult,
} from "./audit-log-reporter";
import { LOG_TAG } from "./constants";
import { getSwitches } from "./runtime-config";

export interface HookRegistrationConfig {
  api: any;
  client: LLMShieldClient;
  appId: string;
  stateDir: string;
  logRecord: boolean;
}

// ── before_tool_call ─────────────────────────────────────────────

export function registerBeforeToolCall(config: HookRegistrationConfig): void {
  const {
    api, client, appId, stateDir, logRecord,
  } = config;

  api.on("before_tool_call", async (event: any, ctx: any) => {
    api.logger.debug(`[${LOG_TAG}] before_tool_call: ${event.toolName}`);
    if (!ctx.agentId || !ctx.sessionKey) return;

    const { enableSkillAudit, enableScriptAudit } = getSwitches();

    // --- Extract session context (moved before all audits so history is available) ---
    const { historyV2, thinkingContent } = extractSessionContext(
      stateDir, ctx.agentId, ctx.sessionKey,
      event.toolName, event.params, api.logger
    );
    const historyParam = historyV2.length > 0 ? historyV2 : undefined;

    // --- Skill audit ---
    if (enableSkillAudit) {
      const skillResult = await trySkillAudit(api, client, appId, event.toolName, event.params, logRecord, historyParam);
      if (skillResult.handled) {
        const skillDetail = skillResult.skillName ?? String(event.params?.command ?? event.params?.name ?? event.toolName);
        if (skillResult.block) {
          reportAuditLog({
            actiontype: AuditActionType.SKILLS_SECURITY_CHECK,
            detail: skillDetail,
            risklevel: AuditRiskLevel.RISKY,
            result: AuditResult.BLOCK,
            optpath: skillResult.reasonText ?? "",
          }).catch(() => {});
          return { block: true, blockReason: skillResult.blockReason };
        }
        reportAuditLog({
            actiontype: AuditActionType.SKILLS_SECURITY_CHECK,
            detail: skillDetail,
          risklevel: AuditRiskLevel.SAFE,
          result: AuditResult.ALLOW,
          optpath: "",
        }).catch(() => {});
        return;
      }
    }

    // --- Script audit ---
    if (enableScriptAudit) {
      const scriptResult = await tryScriptAudit(
        api, client, appId, event.toolName, event.params, logRecord,
        historyParam
      );
      if (scriptResult.handled) {
        // 优先使用 scriptResult 中已解析好的绝对路径
        const scriptPath = scriptResult.resolvedPath
          ?? String(event.params?.filePath ?? event.params?.path ?? event.params?.file ?? "");
        if (scriptResult.block) {
          reportAuditLog({
            actiontype: AuditActionType.EXEC_SCRIPT_CHECK,
            detail: scriptPath,
            risklevel: AuditRiskLevel.RISKY,
            result: AuditResult.BLOCK,
            optpath: scriptResult.reasonText ?? "",
          }).catch(() => {});
          return { block: true, blockReason: scriptResult.blockReason };
        }
        reportAuditLog({
          actiontype: AuditActionType.EXEC_SCRIPT_CHECK,
          detail: scriptPath,
          risklevel: AuditRiskLevel.SAFE,
          result: AuditResult.ALLOW,
          optpath: "",
        }).catch(() => {});
        return;
      }
    }

    // NOTE: before_tool_call prompt audit is disabled for now (detail format TBD)
    // --- General prompt audit (fallback) ---
    // if (!enablePromptAudit) return;
    //
    // let content = `Tool: ${event.toolName}, Params: ${JSON.stringify(event.params)}`;
    // if (thinkingContent) {
    //   content = `${thinkingContent}\n${content}`;
    // }
    //
    // const { decision, labels, risks } = await checkContentSecurity(
    //   api, client, appId,
    //   [{ Content: content, ContentType: ContentType.TEXT }],
    //   "assistant",
    //   "before_tool_call:prompt",
    //   logRecord,
    //   historyParam
    // );
    //
    // if (decision === DecisionType.BLOCK) {
    //   const blockReason = generateSecurityMessage(labels, decision, risks);
    //   recordLogEvent(api, LOG_TAG, "before_tool_call(block)", { blockReason, originalContent: content }, logRecord);
    //   reportAuditLog({
    //     actiontype: AuditActionType.PROMPT_SECURITY_CHECK,
    //     detail: `${event.toolName}: ${JSON.stringify(event.params).slice(0, 500)}`,
    //     risklevel: AuditRiskLevel.RISKY,
    //     result: AuditResult.BLOCK,
    //     optpath: "",
    //   }, api.logger).catch(() => {});
    //   return { block: true, blockReason };
    // }
  });
}

// ── after_tool_call ──────────────────────────────────────────────

export function registerAfterToolCall(_config: HookRegistrationConfig): void {
  // NOTE: after_tool_call prompt audit is disabled for now (detail format TBD)
  // const { api, client, appId, logRecord, enablePromptAudit } = _config;
  //
  // api.on("after_tool_call", async (event: any, _ctx: any) => {
  //   if (!enablePromptAudit) return;
  //   api.logger.debug(`[${LOG_TAG}] after_tool_call(prompt): ${event.toolName}`);
  //
  //   const content = `ToolName:${event.toolName}\nParams: ${JSON.stringify(event.params)}\nResult: ${JSON.stringify(event.result ?? null)}`;
  //
  //   const { decision, labels, risks } = await checkContentSecurity(
  //     api, client, appId,
  //     [{ Content: content, ContentType: ContentType.TEXT }],
  //     "tool",
  //     "after_tool_call:prompt",
  //     logRecord
  //   );
  //
  //   if (decision === DecisionType.BLOCK) {
  //     const blockReason = generateSecurityMessage(labels, decision, risks);
  //     recordLogEvent(api, LOG_TAG, "after_tool_call(block)", { blockReason, originalContent: content }, logRecord);
  //     reportAuditLog({
  //       actiontype: AuditActionType.PROMPT_SECURITY_CHECK,
  //       detail: `${event.toolName}: ${JSON.stringify(event.params).slice(0, 500)}`,
  //       risklevel: AuditRiskLevel.RISKY,
  //       result: AuditResult.BLOCK,
  //       optpath: "",
  //     }, api.logger).catch(() => {});
  //
  //     const interceptedData = {
  //       error: "Intercepted",
  //       message: "The result has been intercepted.",
  //       reason: blockReason,
  //     };
  //
  //     if (!event.result) {
  //       event.result = {};
  //     }
  //     event.result.content = [
  //       { type: "text", text: JSON.stringify(interceptedData, null, 2) },
  //     ];
  //     event.result.details = interceptedData;
  //   }
  // });
}


