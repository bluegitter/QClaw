import type { WalStore } from "./wal-store";
import type { TaskRecord, TaskStep, RecoveryContext, Logger } from "./types";

const LOG_TAG = "qmemory:recovery";

/** 钩子事件上下文接口 */
interface HookContext {
  sessionKey?: string;
  agentId?: string;
  [key: string]: unknown;
}

/**
 * 任务恢复引擎
 *
 * 在 OpenClaw crash 重启后：
 * 1. 扫描未完成的 WAL 任务
 * 2. 构造恢复上下文（已完成步骤摘要）
 * 3. 通过 fetch 拦截器直接修改发给 LLM 的 messages，注入恢复指令
 *
 * 核心策略：拦截 globalThis.fetch，当检测到 LLM 请求（含 messages 数组）且
 * 恢复模式激活时，在最后一条 user 消息前注入恢复指令。这样：
 * - LLM 一定能看到恢复指令（作为 user 消息的一部分）
 * - UI 完全不受影响（UI 在 fetch 前已渲染）
 * - 不依赖 before_prompt_build 的 prependContext/prependSystemContext
 */

/** 已 arm 但尚未被 fetch 消费的注入上下文 */
interface ArmedInjection {
  /** 恢复任务描述（注入到 LLM 的内容） */
  taskDesc: string;
  /** 原始中断任务的 taskId */
  taskId: string;
}

export class RecoveryEngine {
  private readonly walStore: WalStore;
  private readonly logger: Logger;

  /** 待恢复的任务上下文列表 */
  private pendingRecoveries: RecoveryContext[] = [];

  /** 全局恢复模式标记（有未完成任务时激活） */
  private recoveryMode = false;

  /**
   * 按 sessionKey 存储的 armed 注入上下文
   *
   * before_prompt_build 为某个 session arm 后，fetch 拦截器根据
   * 请求中的 messages 匹配对应的 session。这样多 session 并发时互不覆盖。
   */
  private armedInjections = new Map<string, ArmedInjection>();

  /** 已注入恢复上下文的 sessionKey 集合，避免重复注入 */
  private injectedSessions = new Set<string>();

  /** 已注入但尚未确认完成的旧任务 taskId，等 agent_end(success=true) 后再删 WAL */
  private pendingWalCleanup: string[] = [];

  /** 调试信息：记录最近一次注入的详细情况 */
  private lastInjectionDebug: {
    timestamp: string;
    sessionKey: string;
    taskId: string;
    method: string;
    injectedContent: string;
    messageIndex: number;
    originalContentPreview: string;
  } | null = null;

  /**
   * 判断用户输入是否表达了"继续执行中断任务"的意图。
   * 只有匹配到明确的继续/恢复关键词时才返回 true。
   */
  private isUserRequestingResume(userInput: string): boolean {
    if (!userInput) return false;
    const normalized = userInput.trim().toLowerCase();
    // 关键词列表：覆盖常见的"想继续中断任务"的表述
    const resumeKeywords = [
      "继续",
      "继续任务",
      "继续执行",
      "继续上次",
      "继续之前",
      "继续中断",
      "继续未完成",
      "恢复任务",
      "恢复执行",
      "恢复中断",
      "执行中断任务",
      "执行中断的任务",
      "做未完成的任务",
      "做上次的任务",
      "接着做",
      "接着上次",
      "上次没做完",
      "没做完的",
      "未完成的任务",
      "中断的任务",
      "resume",
      "continue",
    ];
    return resumeKeywords.some((kw) => normalized.includes(kw));
  }

  constructor(opts: {
    walStore: WalStore;
    logger: Logger;
  }) {
    this.walStore = opts.walStore;
    this.logger = opts.logger;
  }

  // ─── 恢复流程 ───

  /**
   * 初始化恢复：扫描中断任务，每个 session 保留最近一个用于恢复。
   *
   * Session 隔离：不同 session 的中断任务互不影响，
   * 每个 session 只保留时间最近的一个，清理同 session 的旧任务。
   */
  initialize(): TaskRecord[] {
    const interrupted = this.walStore.collectInterruptedTasks();
    if (interrupted.length === 0) {
      return [];
    }

    // 按中断时间排序，最新的在前
    interrupted.sort((a, b) => {
      const bTime = b.endedAt !== undefined ? b.endedAt : (b.updatedAt ?? 0);
      const aTime = a.endedAt !== undefined ? a.endedAt : (a.updatedAt ?? 0);
      return bTime - aTime;
    });

    // 按 sessionKey 分组，每个 session 只保留最新的一个
    const latestBySession = new Map<string, TaskRecord>();
    const toCleanup: TaskRecord[] = [];

    for (const task of interrupted) {
      if (!latestBySession.has(task.sessionKey)) {
        latestBySession.set(task.sessionKey, task);
      } else {
        // 同 session 的旧任务，清理
        toCleanup.push(task);
      }
    }

    // 保留每个 session 最新的中断任务
    const kept: TaskRecord[] = [];
    for (const [, task] of latestBySession) {
      const context = this.buildRecoveryContext(task);
      this.pendingRecoveries.push(context);
      kept.push(task);
    }

    this.recoveryMode = true;

    // 清理同 session 下的旧中断任务 WAL
    for (const task of toCleanup) {
      this.walStore.markRecovered(task.taskId);
    }

    return kept;
  }

  /** 获取所有待恢复的任务（兼容 HTTP 路由和命令） */
  getPendingRecoveries(): Map<string, RecoveryContext> {
    const map = new Map<string, RecoveryContext>();
    for (const ctx of this.pendingRecoveries) {
      map.set(ctx.task.sessionKey, ctx);
    }
    return map;
  }

  /** 获取指定会话的恢复上下文（按旧 sessionKey 查找） */
  getRecoveryContext(sessionKey: string): RecoveryContext | undefined {
    return this.pendingRecoveries.find((r) => r.task.sessionKey === sessionKey);
  }

  /** 标记恢复完成，清理上下文（按旧 sessionKey） */
  markRecovered(sessionKey: string): void {
    this.pendingRecoveries = this.pendingRecoveries.filter(
      (r) => r.task.sessionKey !== sessionKey,
    );
    if (this.pendingRecoveries.length === 0) {
      this.recoveryMode = false;
    }
  }

  /** 放弃恢复单个任务：清理内存上下文 + 删除磁盘 WAL */
  dismissOne(sessionKey: string): void {
    const recovery = this.pendingRecoveries.find((r) => r.task.sessionKey === sessionKey);
    if (recovery) {
      this.walStore.markRecovered(recovery.task.taskId);
    }
    this.pendingRecoveries = this.pendingRecoveries.filter(
      (r) => r.task.sessionKey !== sessionKey,
    );
    if (this.pendingRecoveries.length === 0) {
      this.recoveryMode = false;
    }
  }

  /** 清空所有待恢复任务，并清理暂存的 WAL */
  clearAll(): void {
    // 清理暂存的待删除 WAL（用户放弃恢复时）
    for (const taskId of this.pendingWalCleanup) {
      this.walStore.markRecovered(taskId);
    }
    this.pendingWalCleanup = [];
    // 清理尚未注入的待恢复任务的 WAL
    for (const recovery of this.pendingRecoveries) {
      this.walStore.markRecovered(recovery.task.taskId);
    }
    this.pendingRecoveries = [];
    this.recoveryMode = false;
    this.injectedSessions.clear();
    this.armedInjections.clear();
  }

  /** 是否处于恢复模式 */
  isRecoveryMode(): boolean {
    return this.recoveryMode;
  }

  /** 获取最近一次注入的调试信息 */
  getLastInjectionDebug(): typeof this.lastInjectionDebug {
    return this.lastInjectionDebug;
  }

  /** 已注入恢复上下文的会话数量 */
  getInjectedSessionsCount(): number {
    return this.injectedSessions.size;
  }

  /** 是否有暂存的待清理 WAL（恢复上下文已注入但尚未确认完成） */
  hasPendingWalCleanup(): boolean {
    return this.pendingWalCleanup.length > 0;
  }

  /** 确认恢复任务已完成，真正删除旧的 WAL 文件 */
  confirmRecoveryComplete(): void {
    if (this.pendingWalCleanup.length === 0) return;
    for (const taskId of this.pendingWalCleanup) {
      this.walStore.markRecovered(taskId);
    }
    this.pendingWalCleanup = [];
  }

  // ─── Hook 处理器 ───

  /**
   * before_prompt_build 钩子：标记 fetch 拦截器激活
   *
   * 不再通过 prependSystemContext/appendSystemContext 注入（AI 会忽略），
   * 而是在此处准备恢复数据，由 fetch 拦截器在实际 LLM 请求中注入。
   *
   * 🔑 Session 隔离：只有当前 sessionKey 与中断任务的 sessionKey 匹配时
   * 才激活恢复，其他 session 的消息完全不影响恢复状态。
   */
  onBeforePromptBuild(_event: Record<string, unknown>, ctx: HookContext): void {
    if (!this.recoveryMode || this.pendingRecoveries.length === 0) {
      return;
    }

    const sessionKey = ctx?.sessionKey;
    if (!sessionKey) {
      return;
    }

    if (this.injectedSessions.has(sessionKey)) {
      return;
    }

    // 🔑 Session 隔离：查找与当前 sessionKey 匹配的中断任务
    const recovery = this.pendingRecoveries.find(
      (r) => r.task.sessionKey === sessionKey,
    );
    if (!recovery) {
      // 当前 session 没有对应的中断任务，跳过，不影响恢复状态
      return;
    }

    const userInput = this.extractUserInput(recovery.task.originalPrompt || "");
    const taskDesc = userInput || recovery.task.originalPrompt || "未知任务";

    this.injectedSessions.add(sessionKey);

    // 暂存待清理的 taskId
    this.pendingWalCleanup.push(recovery.task.taskId);

    // 按 sessionKey 存储 armed 注入上下文（多 session 互不覆盖）
    this.armedInjections.set(sessionKey, {
      taskDesc,
      taskId: recovery.task.taskId,
    });

    // 记录调试信息（fetch 拦截时会更新）
    this.lastInjectionDebug = {
      timestamp: new Date().toISOString(),
      sessionKey,
      taskId: recovery.task.taskId,
      method: "fetch-interceptor-armed",
      injectedContent: "(pending fetch)",
      messageIndex: -1,
      originalContentPreview: "",
    };

    // 只移除当前匹配的恢复任务，保留其他 session 的恢复任务
    this.pendingRecoveries = this.pendingRecoveries.filter(
      (r) => r.task.sessionKey !== sessionKey,
    );
    if (this.pendingRecoveries.length === 0 && this.armedInjections.size === 0) {
      this.recoveryMode = false;
    }
  }

  // ─── Fetch 拦截器 ───

  /**
   * 安装 fetch 拦截器，直接修改发给 LLM 的 messages
   *
   * 原理同 content-security 插件：拦截 globalThis.fetch，解析请求体，
   * 在最后一条 user 消息中注入恢复指令，然后重新序列化。
   * UI 在 fetch 之前已渲染，不受影响。
   *
   * 🔑 多 session 安全：遍历 armedInjections Map，逐个尝试匹配。
   * 每个 armed session 独立消费，互不影响。
   */
  setupFetchInterceptor(): void {
    const originalFetch = globalThis.fetch;
    const self = this;

    const interceptedFetch = async function (this: typeof globalThis, ...args: Parameters<typeof fetch>) {
      // 快速路径：没有 armed 注入时直接透传
      if (self.armedInjections.size === 0) {
        return originalFetch.apply(this, args);
      }

      const options: RequestInit = (args[1] as RequestInit) || {};
      let jsonBody: Record<string, unknown> | undefined;

      if (options.body) {
        let rawBody: string | undefined;

        if (typeof options.body === "string") {
          rawBody = options.body;
        } else if (options.body instanceof Uint8Array || options.body instanceof ArrayBuffer) {
          rawBody = new TextDecoder().decode(options.body);
        }

        if (rawBody) {
          try {
            jsonBody = JSON.parse(rawBody) as Record<string, unknown>;
          } catch {
            // 非 JSON，跳过
          }
        }
      }

      // 检测是否为 LLM 请求（含 messages 数组）
      if (jsonBody && Array.isArray(jsonBody.messages) && jsonBody.messages.length > 0) {
        try {
          // 找到最后一条 user 消息
          let lastUserIdx = -1;
          for (let i = jsonBody.messages.length - 1; i >= 0; i--) {
            if (jsonBody.messages[i].role === "user") {
              lastUserIdx = i;
              break;
            }
          }

          if (lastUserIdx >= 0) {
            const msg = jsonBody.messages[lastUserIdx];
            // 提取用户原始消息内容
            let userOriginalContent = "";
            if (typeof msg.content === "string") {
              userOriginalContent = msg.content;
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === "text" && typeof part.text === "string") {
                  userOriginalContent = part.text;
                  break;
                }
              }
            }

            // 提取用户输入的核心文本（去掉 Sender 元数据和时间戳前缀）
            const userCoreInput = self.extractUserInput(userOriginalContent);

            // 🔑 尝试消费一个 armed 注入
            // 由于 fetch 请求中无 sessionKey 信息，采用 FIFO 策略：
            // 取最早 arm 的那个。before_prompt_build → fetch 是顺序的，
            // 先 arm 的 session 的 fetch 请求必然先到达。
            const matchedSessionKey = self.findEarliestArmedSession();
            if (!matchedSessionKey) {
              return originalFetch.apply(this, args);
            }

            const armed = self.armedInjections.get(matchedSessionKey)!;

            // 🔑 关键判断：只有用户明确表达了"继续中断任务"的意图时才恢复
            // 否则放弃中断任务，正常处理用户的新请求
            if (!self.isUserRequestingResume(userCoreInput)) {
              // 用户没有表达继续意图，放弃恢复，透传原始消息
              self.consumeArmedInjection(matchedSessionKey, "dismissed");

              // 清理待恢复的 WAL
              self.walStore.markRecovered(armed.taskId);
              self.pendingWalCleanup = self.pendingWalCleanup.filter(
                (id) => id !== armed.taskId,
              );

              // 不修改消息，直接透传
              return originalFetch.apply(this, args);
            }

            // 用户明确请求继续中断任务，构造恢复指令
            const recoveryContent = [
              `[TASK RECOVERY] 上次执行中断，用户没有看到任何结果。`,
              `用户请求恢复中断的任务。请重新执行以下被中断的任务：`,
              ``,
              `任务：${armed.taskDesc}`,
              ``,
              `请只执行上述被中断的任务，完整展示结果。在回复开头简要说明"上次执行中断，现在恢复执行"（不要提及"崩溃"或"crash"等字眼）。`,
            ].join("\n");

            let originalPreview = "";

            // 替换 user 消息的 content
            if (typeof msg.content === "string") {
              originalPreview = msg.content.slice(0, 100);
              msg.content = recoveryContent;
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === "text" && typeof part.text === "string") {
                  originalPreview = part.text.slice(0, 100);
                  part.text = recoveryContent;
                  break;
                }
              }
            }

            // 重新序列化
            const newBody = JSON.stringify(jsonBody);
            if (typeof options.body === "string") {
              options.body = newBody;
            } else if (options.body instanceof Uint8Array) {
              options.body = new TextEncoder().encode(newBody);
            } else if (options.body instanceof ArrayBuffer) {
              const encoded = new TextEncoder().encode(newBody);
              options.body = encoded.buffer as ArrayBuffer;
            }
            // 更新 Content-Length 头，防止服务器因长度不匹配拒绝请求
            if (!options.headers) {
              options.headers = {};
            }
            const newContentLength = new TextEncoder().encode(newBody).byteLength.toString();
            if (options.headers instanceof Headers) {
              options.headers.set('Content-Length', newContentLength);
            } else if (Array.isArray(options.headers)) {
              const idx = options.headers.findIndex(([k]) => k.toLowerCase() === 'content-length');
              if (idx >= 0) {
                options.headers[idx] = ['Content-Length', newContentLength];
              } else {
                options.headers.push(['Content-Length', newContentLength]);
              }
            } else {
              const headerObj = options.headers as Record<string, string>;
              const key = Object.keys(headerObj).find(k => k.toLowerCase() === 'content-length');
              headerObj[key || 'Content-Length'] = newContentLength;
            }
            args[1] = options;

            // 消费这个 armed 注入
            self.consumeArmedInjection(matchedSessionKey, "injected");

            // 更新调试信息
            self.lastInjectionDebug = {
              timestamp: new Date().toISOString(),
              sessionKey: matchedSessionKey,
              taskId: armed.taskId,
              method: "fetch-interceptor-injected",
              injectedContent: recoveryContent,
              messageIndex: lastUserIdx,
              originalContentPreview: originalPreview,
            };
          }
        } catch (error) {
          // 捕获解析错误，防止请求失败，可根据需要记录错误或设置默认值
          self.logger.error(`[${LOG_TAG}] fetch 拦截器注入失败，原始请求将不受影响:`, error);
        }
      }

      return originalFetch.apply(this, args);
    };

    globalThis.fetch = interceptedFetch as typeof fetch;
  }

  /** 查找最早 arm 的 session（Map 迭代按插入顺序，即 FIFO） */
  private findEarliestArmedSession(): string | undefined {
    const first = this.armedInjections.keys().next();
    return first.done ? undefined : first.value;
  }

  /** 消费一个 armed 注入：从 Map 中移除 */
  private consumeArmedInjection(sessionKey: string, reason: "injected" | "dismissed"): void {
    const armed = this.armedInjections.get(sessionKey);
    if (!armed) return;

    this.armedInjections.delete(sessionKey);

    this.logger.info(
      `[${LOG_TAG}] armed 注入已消费 (sessionKey=${sessionKey}, reason=${reason})`,
    );

    // 检查是否所有恢复任务都已处理完
    if (this.pendingRecoveries.length === 0 && this.armedInjections.size === 0) {
      this.recoveryMode = false;
    }
  }

  // ─── 上下文构建 ───

  private buildRecoveryContext(task: TaskRecord): RecoveryContext {
    const completedSteps = task.steps.filter((s) => s.status === "completed");
    const summary = this.buildStepsSummary(completedSteps);

    return {
      task,
      completedSummary: summary,
    };
  }

  private buildStepsSummary(steps: TaskStep[]): string {
    if (steps.length === 0) return "  (无已完成步骤)";

    return steps
      .map((step) => {
        const params = this.summarizeParams(step.params);
        const resultStr = step.result
          ? ` → ${typeof step.result === "string" ? step.result.slice(0, 200) : JSON.stringify(step.result).slice(0, 200)}`
          : "";
        return `  ${step.seq}. [已完成] ${step.toolName}(${params})${resultStr}`;
      })
      .join("\n");
  }

  private summarizeParams(params: Record<string, unknown>): string {
    const MAX_PARAM_LENGTH = 100;
    const entries = Object.entries(params);
    if (entries.length === 0) return "";

    const parts = entries.map(([key, value]) => {
      const valStr = typeof value === "string" ? value : JSON.stringify(value);
      const truncated =
        valStr.length > MAX_PARAM_LENGTH ? valStr.slice(0, MAX_PARAM_LENGTH) + "..." : valStr;
      return `${key}=${truncated}`;
    });

    return parts.join(", ");
  }

  /**
   * 从原始 prompt 中提取用户真实输入
   * 原始 prompt 格式形如:
   *   Sender (untrusted metadata):
   *   ```json
   *   {"label":"openclaw-control-ui","id":"openclaw-control-ui"}
   *   ```
   *   [Thu 2026-03-12 22:43 GMT+8] 输出下载目录的文档列表
   *
   * 需要提取出: "输出下载目录的文档列表"
   */
  private extractUserInput(prompt: string): string {
    if (!prompt) return "";

    // 尝试匹配 [日期时间] 后面的内容
    const timestampMatch = prompt.match(/\[.*?\]\s*([\s\S]*?)$/);
    if (timestampMatch) {
      return timestampMatch[1].trim();
    }

    // 尝试去掉 Sender 元数据块
    const senderMatch = prompt.match(/^Sender\s*\(.*?\):\s*```[\s\S]*?```\s*([\s\S]*)$/m);
    if (senderMatch) {
      return senderMatch[1].trim();
    }

    return prompt.trim();
  }

}
