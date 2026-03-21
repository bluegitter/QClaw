/**
 * content-security 插件入口
 *
 * 基于后端代理接口的内容安全审核插件。
 * 通过四个审核点对 AIGC 内容进行全链路审核：
 *   1. global.fetch 拦截（请求侧） — 审核用户发给 LLM 的 Prompt（Prompt ≤ 4000 字切片）
 *   2. global.fetch 拦截（响应侧） — 审核 LLM 返回的文本内容（Output ≤ 128 字切片）
 *   3. before_tool_call  — 审核 Agent 调用工具前的参数（含 thinking 内容）
 *   4. after_tool_call   — 审核工具调用返回的结果（输出侧，≤ 120 字切片）
 *
 * LLM 响应审核说明：
 *   - 非流式（JSON）：clone 响应体，后台异步提取 assistant 内容并按 ≤128 字切片送审
 *   - 流式（SSE）：tee() 分流，后台异步消费完整流后提取 assistant 内容并切片送审
 *   - 最后一片使用 SessionType=3（回答结束），中间片使用 SessionType=2（答）
 *   - 审核为事后（post-hoc）异步进行，不阻塞 LLM 响应返回
 *
 * 审核结果分三种处置：
 *   - 放行（ResultCode=0）：正常继续
 *   - 拦截（ResultCode=1）：阻断请求或替换工具结果
 *   - 降级（网络/超时/熔断）：C 端产品默认不放行，返回拦截
 */

import fs from "node:fs";
import path from "node:path";
import { SessionType } from "./src/types";
import type { PluginConfig } from "./src/types";
import { CreateTaskClient } from "./src/client";
import { setSecurityConfig, checkContentSecurity } from "./src/security";
import { setupFetchInterceptor } from "./src/interceptor";
import { getSessionId, getQAID } from "./src/session";
import { sliceText } from "./src/utils";

/** Output 最大长度（字）。CreateTask 接口限制单次 Output ≤ 128 字，超长需切片，留 8 字缓冲取 120 */
const OUTPUT_MAX_LENGTH = 120;

/** 日志前缀，方便在混合日志中快速过滤本插件输出 */
const LOG_TAG = "content-security";

const plugin = {
  id: "content-security",
  name: "内容安全审核",
  description: "内容安全审核插件，保护 LLM 和 Agent 生命周期免受有害内容侵害。",

  register(api: any) {
    if (api?.pluginConfig?.enabled === false) {
      return;
    }
    /** 从宿主注入的插件配置，未配置时取空对象作为默认值 */
    const pluginCfg: PluginConfig = api.pluginConfig ?? {};
    const {
      endpoint,   // CreateTask 接口完整地址
      token,      // OpenClaw Channel Token，用于鉴权
    } = pluginCfg;

    // ----------------------------------------------------------
    // 1. 读取功能开关配置
    //    logRecord          — 是否将审核请求/响应写入本地日志文件
    //    enableFetch        — 是否启用 fetch 拦截（默认开启）
    //    enableBeforeToolCall — 是否启用 before_tool_call hook（默认开启）
    //    enableAfterToolCall  — 是否启用 after_tool_call hook（默认开启）
    // ----------------------------------------------------------
    const logRecord = Boolean(pluginCfg.logRecord);
    const enableFetch = pluginCfg.enableFetch !== false;
    const enableBeforeToolCall = pluginCfg.enableBeforeToolCall !== false;
    const enableAfterToolCall = pluginCfg.enableAfterToolCall !== false;

    /**
     * 状态目录：用于读取 Agent 会话文件（sessions.json / session JSONL）。
     * 优先使用插件配置中显式指定的 openClawDir，
     * 其次通过 runtime API 动态解析，解析失败时置空（功能降级，不影响审核主流程）。
     */
    let stateDir: string;
    if (pluginCfg.openClawDir) {
      stateDir = pluginCfg.openClawDir;
    } else {
      try {
        stateDir = api.runtime.state.resolveStateDir();
        api.logger.info(`[${LOG_TAG}] 状态目录: ${stateDir}`);
      } catch {
        stateDir = "";
        api.logger.warn(`[${LOG_TAG}] 获取状态目录失败，部分功能可能受限`);
      }
    }

    // ----------------------------------------------------------
    // 2. 配置安全/降级参数
    //    failureThreshold   — 连续失败多少次后触发熔断
    //    baseRetryIntervalMs — 熔断后首次重试等待时间（ms）
    //    maxRetryIntervalMs  — 熔断重试最大等待上限（ms）
    //    blockLevel         — 审核结果 Level 阈值，超过则拦截
    // ----------------------------------------------------------
    setSecurityConfig({
      failureThreshold: pluginCfg.failureThreshold,
      baseRetryIntervalMs: pluginCfg.retryInterval
        ? pluginCfg.retryInterval * 1000
        : undefined,
      maxRetryIntervalMs: pluginCfg.maxRetryInterval
        ? pluginCfg.maxRetryInterval * 1000
        : undefined,
      blockLevel: pluginCfg.blockLevel,
    });

    // ----------------------------------------------------------
    // 3. 校验必填配置
    //    endpoint 和 token 缺一不可，任意为空则插件无法正常工作，直接退出注册。
    // ----------------------------------------------------------
    if (!endpoint || !token) {
      api.logger.error(
        `[${LOG_TAG}] 注册失败：缺少必要配置。` +
          `endpoint=${endpoint || "空"}, token=${token ? "已配置" : "空"}`,
      );
      return;
    }

    // ----------------------------------------------------------
    // 4. 创建 HTTP 客户端
    //    必须在 fetch 拦截器注册之前保存原始 fetch 引用，
    //    否则 CreateTaskClient 内部发出的请求也会被拦截，造成死循环。
    // ----------------------------------------------------------
    const originalFetch = globalThis.fetch;

    /**
     * 本地审核日志路径：~/Library/Logs/QClaw/openclaw/content-security-YYYY-MM-DD.log
     * 按天滚动，便于排查问题。仅在 logRecord=true 时实际写入。
     */
    const logDir = path.join(
      process.env.HOME || "~",
      "Library",
      "Logs",
      "QClaw",
      "openclaw",
    );
    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(logDir, `content-security-${today}.log`);

    const client = new CreateTaskClient({
      endpoint,
      openclawChannelToken: token,
      timeoutMs: pluginCfg.timeoutMs,
      fetchFn: originalFetch, // 使用原始 fetch，绕过拦截器
      logger: api.logger,
      logFile,
    });

    // ----------------------------------------------------------
    // 5. 注册 Hook
    //    跳过连通性预检，直接注册。
    //    网络不通时 checkContentSecurity 内部会触发熔断降级（不放行）。
    // ----------------------------------------------------------
    api.logger.info(`[${LOG_TAG}] 跳过连通性验证，直接注册 Hook（网络不通时自动降级放行）`);
    api.logger.info(`[${LOG_TAG}] 请求/响应日志将写入: ${logFile}`);

    (async () => {

      // ---------- Hook 1: fetch 拦截器 ----------
      // 拦截所有经过 globalThis.fetch 发出的请求，
      // 在请求发送前审核 Prompt（≤ 4000 字切片），
      // 在响应返回后异步审核 LLM 输出（≤ 128 字切片，SessionType=2/3）。
      // 具体逻辑封装在 setupFetchInterceptor 中。
      if (enableFetch) {
        setupFetchInterceptor(
          {
            api,
            client,
            enableLogging: logRecord,
            shieldEndpoint: endpoint, // 用于过滤掉审核接口自身的请求，避免递归
          },
          LOG_TAG,
        );
        api.logger.info(`[${LOG_TAG}] fetch 拦截器已注册 ✅`);
      }

      // ---------- Hook 2: before_tool_call ----------
      // 在 Agent 调用工具之前触发，审核工具名 + 参数。
      // 若会话文件中存在对应的 thinking 内容，则一并纳入审核，
      // 以捕获模型在推理阶段产生的潜在有害内容。
      if (enableBeforeToolCall) {
        api.on("before_tool_call", async (event: any, ctx: any) => {
          // agentId 和 sessionKey 是定位会话的必要信息，缺失则跳过
          if (!ctx?.agentId || !ctx?.sessionKey) return;

          const sessionKey = ctx.sessionKey;
          const sessionId = getSessionId(sessionKey); // 用于 CreateTask 的 SessionID
          const qaid = getQAID(sessionKey);           // 用于关联同一问答轮次的 QAID

          // 基础审核内容：工具名 + 序列化参数
          let content = `工具: ${event.toolName}, 参数: ${JSON.stringify(event.params)}`;

          /**
           * 尝试从会话 JSONL 文件中提取最近一条 assistant 消息里的 thinking 内容。
           * 路径结构：
           *   {stateDir}/agents/{agentId}/sessions/sessions.json
           *     → sessions.json[sessionKey].sessionFile → 具体的 JSONL 文件
           *
           * 从文件末尾向前遍历，找到与当前工具调用匹配的那条消息，
           * 取其 thinking 块拼接到审核内容前面。
           * 任何读取/解析失败都静默跳过，不影响主流程。
           */
          try {
            if (stateDir && ctx.agentId && ctx.sessionKey) {
              const sessionsJsonPath = path.join(
                stateDir,
                "agents",
                ctx.agentId,
                "sessions",
                "sessions.json",
              );

              if (fs.existsSync(sessionsJsonPath)) {
                const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf-8"));
                const sessionInfo = sessionsData[ctx.sessionKey];

                if (sessionInfo?.sessionFile) {
                  // sessionFile 可能是相对路径，需要相对于 sessions.json 所在目录解析
                  const fullSessionPath = path.isAbsolute(sessionInfo.sessionFile)
                    ? sessionInfo.sessionFile
                    : path.join(path.dirname(sessionsJsonPath), sessionInfo.sessionFile);

                  if (fs.existsSync(fullSessionPath)) {
                    const sessionContent = fs.readFileSync(fullSessionPath, "utf-8");
                    // JSONL 格式：每行一条 JSON 记录，过滤空行
                    const lines = sessionContent.split("\n").filter((l) => l.trim());

                    // 从末尾向前找，取最近一条匹配的 assistant 消息
                    for (let i = lines.length - 1; i >= 0; i--) {
                      try {
                        const item = JSON.parse(lines[i]);
                        if (
                          item.type === "message" &&
                          item.message?.role === "assistant" &&
                          Array.isArray(item.message.content)
                        ) {
                          // 确认该消息包含当前工具调用（名称 + 参数完全匹配）
                          const matchedToolCall = item.message.content.find(
                            (c: any) =>
                              c.type === "toolCall" &&
                              c.name === event.toolName &&
                              JSON.stringify(c.arguments) === JSON.stringify(event.params),
                          );
                          const thinking = item.message.content.find(
                            (c: any) => c.type === "thinking",
                          );
                          if (matchedToolCall && thinking) {
                            // 将 thinking 内容前置，让审核服务能感知模型的推理意图
                            content = `${thinking.thinking || ""}\n${content}`;
                            break;
                          }
                        }
                      } catch {
                        // 单行解析失败（如截断行），跳过继续
                      }
                    }
                  }
                }
              }
            }
          } catch (e) {
            api.logger.error(`[${LOG_TAG}] 提取会话历史失败: ${e}`);
          }

          // 截取前 4000 字符，避免超出审核接口的单次请求限制
          const contentToCheck = sliceText(content, 4000)[0];

          const result = await checkContentSecurity(
            api,
            client,
            "prompt",
            [{ Data: contentToCheck, MediaType: "Text" }],
            sessionId,
            SessionType.QUESTION, // 工具参数属于"问题侧"
            "before_tool_call",   // 用于日志标识来源 hook
            logRecord,
            LOG_TAG,
            qaid,
          );

          // 审核不通过：阻断工具调用，返回 block 信号
          if (result.blocked) {
            return { block: true, blockReason: "内容已被安全审核拦截。" };
          }
        });

        api.logger.info(`[${LOG_TAG}] before_tool_call hook 已注册 ✅`);
      }

      // ---------- Hook 3: after_tool_call ----------
      // 在工具调用完成后触发，审核工具返回的结果内容。
      // after_tool_call 会触发两次：第一次无 durationMs（结果刚返回），
      // 第二次有 durationMs（包含耗时统计）。只审核第一次，避免重复。
      if (enableAfterToolCall) {
        api.on("after_tool_call", async (event: any, ctx: any) => {
          // 有 durationMs 说明是第二次回调，跳过
          if (event.durationMs) return;

          const sessionKey = ctx?.sessionKey || "default";
          const sessionId = getSessionId(sessionKey);
          const qaid = getQAID(sessionKey);

          // 审核内容：工具名 + 入参 + 返回结果，完整上下文便于审核服务判断
          const content = `工具: ${event.toolName}\n参数: ${JSON.stringify(event.params)}\n结果: ${JSON.stringify(event.result)}`;

          // Output 侧限制单次 ≤ 120 字，需按 OUTPUT_MAX_LENGTH 切片逐片送审
          // 中间片用 SessionType.ANSWER，最后一片用 SessionType.ANSWER_END 关闭会话
          const slices = sliceText(content, OUTPUT_MAX_LENGTH);
          let blocked = false;

          for (let i = 0; i < slices.length; i++) {
            const isLastSlice = i === slices.length - 1;
            const sessionType = isLastSlice ? SessionType.ANSWER_END : SessionType.ANSWER;

            const result = await checkContentSecurity(
              api,
              client,
              "output",
              [{ Data: slices[i], MediaType: "Text" }],
              sessionId,
              sessionType,
              "after_tool_call",
              logRecord,
              LOG_TAG,
              qaid,
            );

            if (result.blocked) {
              blocked = true;
              break;
            }
          }

          // 审核不通过：替换工具结果为拦截提示，阻止有害内容流入后续 LLM 上下文
          if (blocked) {
            const interceptedData = {
              error: "Intercepted",
              message: "内容已被安全审核拦截。",
            };
            event.result.content = [{ type: "text", text: JSON.stringify(interceptedData, null, 2) }];
            event.result.details = interceptedData;
          }
        });

        api.logger.info(`[${LOG_TAG}] after_tool_call hook 已注册 ✅`);
      }

      api.logger.info(
        `[${LOG_TAG}] 插件初始化完成 ✅ ` +
          `fetch:${enableFetch}, beforeToolCall:${enableBeforeToolCall}, afterToolCall:${enableAfterToolCall}`,
      );
    })();
  },
};

export default plugin;
