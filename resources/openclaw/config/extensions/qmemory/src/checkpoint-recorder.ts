import type { WalStore } from "./wal-store";
import type { Logger } from "./types";

const LOG_TAG = "qmemory:checkpoint";

/** 钩子事件上下文基础接口 */
interface HookContext {
  sessionKey?: string;
  agentId?: string;
  [key: string]: unknown;
}

/** session_start / session_end 事件 */
interface SessionEvent {
  sessionId?: string;
  sessionKey?: string;
  [key: string]: unknown;
}

/** agent_end 事件 */
interface AgentEndEvent {
  success?: boolean;
  messages?: unknown[];
  [key: string]: unknown;
}

/** before_prompt_build 事件 */
interface PromptBuildEvent {
  prompt?: string;
  messages?: unknown[];
  [key: string]: unknown;
}

/** before_tool_call / after_tool_call 事件 */
interface ToolCallEvent {
  toolName: string;
  toolCallId?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/** 钩子 API 接口（避免 any） */
interface HookAPI {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(eventName: string, callback: (...args: any[]) => unknown): void;
}

/**
 * Checkpoint 记录器
 *
 * 监听 OpenClaw 的钩子事件，将任务执行过程中的每一步工具调用
 * 记录到 WAL 中，作为 crash 恢复的依据。
 *
 * 注意：各钩子事件的 event/ctx 参数结构各不相同：
 * - session_start: event={sessionId, sessionKey}, ctx={sessionId, sessionKey, agentId}
 * - session_end:   event={sessionId, sessionKey}, ctx={sessionId, sessionKey, agentId}
 * - agent_end:     event={messages, success, ...}, ctx={agentId, sessionKey, sessionId, ...}
 * - before_tool_call: event={toolName, params, toolCallId?}, ctx={toolName, agentId?, sessionKey?, ...}
 * - after_tool_call:  event={toolName, params, result, toolCallId, ...}, ctx={toolName, agentId, sessionKey, ...}
 * - message_received: event={from, content, ...}, ctx={channelId, accountId, conversationId} ← 无 sessionKey！
 * - before_prompt_build: event={prompt, messages}, ctx={agentId, sessionKey, sessionId, ...}
 */
export class CheckpointRecorder {
  private readonly walStore: WalStore;
  private readonly logger: Logger;

  constructor(walStore: WalStore, logger: Logger) {
    this.walStore = walStore;
    this.logger = logger;
  }

  /**
   * 注册所有钩子到插件 API
   */
  registerHooks(api: HookAPI): void {
    // 会话开始 → 创建任务
    api.on("session_start", (event: SessionEvent, ctx: HookContext) => {
      try {
        this.onSessionStart(event, ctx);
      } catch (error) {
        this.logger.error(`[${LOG_TAG}] 钩子处理器错误:`, error, 'session=', ctx?.sessionKey);
      }
    });

    // 会话结束 → 完成任务
    api.on("session_end", (event: SessionEvent, ctx: HookContext) => {
      try {
        this.onSessionEnd(event, ctx);
      } catch (error) {
        this.logger.error(`[${LOG_TAG}] 钩子处理器错误:`, error, 'session=', ctx?.sessionKey);
      }
    });

    // Agent 完成 → 完成任务
    api.on("agent_end", (event: AgentEndEvent, ctx: HookContext) => {
      try {
        this.onAgentEnd(event, ctx);
      } catch (error) {
        this.logger.error(`[${LOG_TAG}] 钩子处理器错误:`, error, 'session=', ctx?.sessionKey);
      }
    });

    // before_prompt_build → 捕获用户 prompt（此钩子有 sessionKey）
    api.on("before_prompt_build", (event: PromptBuildEvent, ctx: HookContext) => {
      try {
        this.onBeforePromptBuild(event, ctx);
      } catch (error) {
        this.logger.error(`[${LOG_TAG}] 钩子处理器错误:`, error, 'session=', ctx?.sessionKey);
      }
    });

    // 工具调用前 → 记录步骤开始（也兜底创建任务）
    api.on("before_tool_call", (event: ToolCallEvent, ctx: HookContext) => {
      try {
        return this.onBeforeToolCall(event, ctx);
      } catch (error) {
        this.logger.error(`[${LOG_TAG}] 钩子处理器错误:`, error, 'session=', ctx?.sessionKey);
      }
    });

    // 工具调用后 → 记录步骤完成
    api.on("after_tool_call", (event: ToolCallEvent, ctx: HookContext) => {
      try {
        this.onAfterToolCall(event, ctx);
      } catch (error) {
        this.logger.error(`[${LOG_TAG}] 钩子处理器错误:`, error, 'session=', ctx?.sessionKey);
      }
    });
  }

  // ─── 钩子处理器 ───

  private onSessionStart(_event: SessionEvent, ctx: HookContext): void {
    const sessionKey = ctx?.sessionKey;
    const agentId = ctx?.agentId;
    if (!sessionKey || !agentId) {
      return;
    }

    // 如果该会话已有活跃任务，先结束旧任务
    const existing = this.walStore.getActiveTask(sessionKey);
    if (existing) {
      this.walStore.finishTask(sessionKey, "completed");
    }

    this.walStore.createTask(sessionKey, agentId);
  }

  /**
   * session_end 钩子：仅从内存移除活跃任务，永远不删 WAL 文件。
   *
   * 原因：session_end 在程序正常退出时也会触发，此时任务可能没有真正完成
   * （工具调用都执行了但 AI 还没输出最终回复）。真正的任务完成标记
   * 由 agent_end (success=true) 负责。
   */
  private onSessionEnd(_event: SessionEvent, ctx: HookContext): void {
    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) return;

    const task = this.walStore.getActiveTask(sessionKey);
    if (!task) {
      return;
    }

    // 只从内存移除，保留磁盘 WAL 文件
    this.walStore.removeActiveTask(sessionKey);
  }

  /**
   * agent_end 钩子：只有 event.success === true 时才标记任务完成并删除 WAL。
   *
   * agent_end 在 AI 真正完成回复后触发（success=true），此时才能确认任务完成。
   * 如果 success 不为 true（比如被取消、出错、程序退出），保留 WAL 以便恢复。
   */
  private onAgentEnd(event: AgentEndEvent, ctx: HookContext): void {
    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) return;

    const task = this.walStore.getActiveTask(sessionKey);
    if (!task) {
      return;
    }

    if (event?.success === true) {
      this.walStore.finishTask(sessionKey, "completed");
    } else {
      // AI 未成功完成（取消/错误/程序退出），保留 WAL
      this.walStore.removeActiveTask(sessionKey);
    }
  }

  /**
   * before_prompt_build 钩子 — 捕获用户 prompt
   *
   * message_received 的 ctx 中没有 sessionKey，无法关联到具体会话。
   * before_prompt_build 的 ctx 有完整的 sessionKey 和 agentId，
   * 且 event.prompt 就是用户输入的内容，用它来记录 originalPrompt。
   */
  private onBeforePromptBuild(event: PromptBuildEvent, ctx: HookContext): void {
    const sessionKey = ctx?.sessionKey;
    const agentId = ctx?.agentId;
    if (!sessionKey) return;

    const prompt = typeof event?.prompt === "string" ? event.prompt : undefined;
    if (!prompt) return;

    let task = this.walStore.getActiveTask(sessionKey);
    if (!task) {
      // session_start 可能未触发（非新会话），这里兜底创建
      task = this.walStore.createTask(sessionKey, agentId || "unknown", prompt);
    } else if (!task.originalPrompt) {
      task.originalPrompt = prompt;
      task.updatedAt = Date.now();
      this.walStore.syncTask(sessionKey);
    }
  }

  private onBeforeToolCall(event: ToolCallEvent, ctx: HookContext): void {
    const sessionKey = ctx?.sessionKey;
    const agentId = ctx?.agentId;
    if (!sessionKey) {
      return;
    }

    let task = this.walStore.getActiveTask(sessionKey);
    if (!task) {
      // 兜底：如果 session_start 和 before_prompt_build 都没创建任务
      task = this.walStore.createTask(sessionKey, agentId || "unknown");
    }

    this.walStore.addStep(sessionKey, {
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      params: event.params ?? {},
    });
  }

  private onAfterToolCall(event: ToolCallEvent, ctx: HookContext): void {
    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) return;

    let result: Record<string, unknown> | undefined;
    if (typeof event.result === 'object' && event.result !== null) {
      result = event.result as Record<string, unknown>;
    } else {
      result = undefined;
    }
    const isError = (typeof result === 'object' && result !== null && result.isError === true) || Boolean(event.error);

    this.walStore.completeStep(
      sessionKey,
      event.toolCallId,
      event.toolName,
      this.summarizeResult(result),
      isError,
    );
  }

  // ─── 辅助方法 ───

  /**
   * 精简工具调用结果，避免 WAL 文件过大
   * 只保留关键信息，截断过长内容
   */
  private summarizeResult(result: unknown): unknown {
    if (!result) return null;

    const MAX_RESULT_LENGTH = 500;

    // 提取文本内容
    if (typeof result === "object" && result !== null) {
      const resultObj = result as Record<string, unknown>;
      if (resultObj.content && Array.isArray(resultObj.content)) {
        const texts = resultObj.content
          .filter((c: Record<string, unknown>) => c.type === "text" && typeof c.text === "string")
          .map((c: Record<string, unknown>) => c.text as string);
        const combined = texts.join("\n");
        return combined.length > MAX_RESULT_LENGTH
          ? combined.slice(0, MAX_RESULT_LENGTH) + "...(truncated)"
          : combined;
      }
    }

    // 字符串结果
    if (typeof result === "string") {
      return result.length > MAX_RESULT_LENGTH
        ? result.slice(0, MAX_RESULT_LENGTH) + "...(truncated)"
        : result;
    }

    // 其他类型尝试序列化
    try {
      const str = JSON.stringify(result);
      return str.length > MAX_RESULT_LENGTH
        ? str.slice(0, MAX_RESULT_LENGTH) + "...(truncated)"
        : str;
    } catch {
      return "[unserializable]";
    }
  }
}
