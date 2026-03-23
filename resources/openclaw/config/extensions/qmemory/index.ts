import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WalStore } from "./src/wal-store";
import { CheckpointRecorder } from "./src/checkpoint-recorder";
import { RecoveryEngine } from "./src/recovery-engine";
import type { QMemoryConfig, Logger } from "./src/types";

const LOG_TAG = "qmemory";

/** 插件 API 最小接口（避免 any） */
interface PluginApi {
  pluginConfig?: QMemoryConfig;
  logger: Logger;
  runtime: { state: { resolveStateDir(): string } };
  on(event: string, handler: (...args: any[]) => unknown): void;
  registerHttpRoute(opts: {
    path: string;
    auth: string;
    match: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  }): void;
  registerCommand(opts: {
    name: string;
    description: string;
    handler: (ctx: unknown) => Promise<{ text: string }>;
  }): void;
}

/** 事件上下文接口 */
interface HookContext {
  sessionKey?: string;
  agentId?: string;
  [key: string]: unknown;
}

/** agent_end 事件接口 */
interface AgentEndEvent {
  success?: boolean;
  [key: string]: unknown;
}

// ─── HTTP 辅助 ───

/** 读取 POST 请求体并解析为 JSON */
function readJsonBody(req: IncomingMessage, logger: Logger): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        logger.error(`[${LOG_TAG}] readJsonBody JSON 解析失败:`, err);
        resolve({});
      }
    });
    req.on("error", (err) => {
      logger.error(`[${LOG_TAG}] readJsonBody 请求错误:`, err);
      resolve({});
    });
  });
}

/** 发送 JSON 响应 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const plugin = {
  id: "qmemory",
  name: "任务恢复",
  description:
    "任务恢复插件，记录任务执行过程中的 checkpoint，在 OpenClaw crash 重启后支持恢复中断的任务。",

  register(api: PluginApi) {
    const pluginCfg: QMemoryConfig = api.pluginConfig ?? {};

    // ─── 解析状态目录 ───
    let stateDir: string;
    try {
      stateDir = api.runtime.state.resolveStateDir();
    } catch {
      stateDir = "";
    }

    const walDir = pluginCfg.walDir || (stateDir ? path.join(stateDir, "qmemory") : "");
    if (!walDir) {
      api.logger.error(`[${LOG_TAG}] 无法确定 WAL 存储目录，插件初始化失败`);
      return;
    }

    // ─── 初始化核心模块 ───
    const walStore = new WalStore({
      walDir,
      maxFiles: pluginCfg.maxWalFiles,
      retentionMs: pluginCfg.walRetentionMs,
      logger: api.logger,
    });

    const checkpointRecorder = new CheckpointRecorder(walStore, api.logger);
    const recoveryEngine = new RecoveryEngine({
      walStore,
      logger: api.logger,
    });

    // ─── 注册 checkpoint 记录钩子 ───
    checkpointRecorder.registerHooks(api);

    // ─── 注册恢复相关钩子 ───

    // 安装 fetch 拦截器（核心注入机制）
    // 延迟安装：确保在 content-security 等其他插件的 fetch 拦截器之后安装，
    // 这样 qmemory 拦截器在调用链最外层，恢复指令替换后的内容会经过内层的安全审核。
    // 使用 queueMicrotask 而非 setTimeout：在当前同步代码（所有插件 register）
    // 执行完成后立即运行，比 setTimeout(0) 的宏任务更可靠地保证执行顺序。
    queueMicrotask(() => {
      recoveryEngine.setupFetchInterceptor();
    });

    // before_prompt_build: 恢复模式下激活 fetch 拦截器
    // 注意：不在 session_start 中清除恢复状态，因为用户点"继续任务"也会触发
    // session_start，过早清除会导致恢复上下文丢失。恢复状态的清除由
    // onBeforePromptBuild 内部在注入后自动完成。
    api.on("before_prompt_build", (event: Record<string, unknown>, ctx: HookContext) => {
      return recoveryEngine.onBeforePromptBuild(event, ctx);
    });

    // 恢复任务的新会话成功完成后，才真正删除旧的中断任务 WAL
    api.on("agent_end", (event: AgentEndEvent, _ctx: HookContext) => {
      if (event?.success === true && recoveryEngine.hasPendingWalCleanup()) {
        recoveryEngine.confirmRecoveryComplete();
      }
    });

    // ─── 插件加载时立即扫描中断任务（无 gateway_start 事件） ───
    const autoRecovery = pluginCfg.autoRecovery !== false;
    if (autoRecovery) {
      recoveryEngine.initialize();
      // 启动时清理过期 WAL 文件
      walStore.cleanup();
    }

    // ─── 注册 HTTP 路由 ───
    // registerHttpRoute 签名: (params: { path, handler, auth, match? }) => void
    // handler 签名: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void>

    // GET /qmemory/status — 查询恢复状态
    api.registerHttpRoute({
      path: "/qmemory/status",
      auth: "gateway",
      match: "exact",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "Method Not Allowed" });
          return;
        }

        const pendingRecoveries = recoveryEngine.getPendingRecoveries();
        const tasks: Array<Record<string, unknown>> = [];

        for (const [sessionKey, ctx] of pendingRecoveries) {
          tasks.push({
            taskId: ctx.task.taskId,
            sessionKey,
            agentId: ctx.task.agentId,
            originalPrompt: ctx.task.originalPrompt,
            completedSteps: ctx.task.steps.filter((s) => s.status === "completed").length,
            totalSteps: ctx.task.steps.length,
            interruptedAt: ctx.task.endedAt
              ? new Date(ctx.task.endedAt).toISOString()
              : undefined,
          });
        }

        sendJson(res, 200, {
          recoveryMode: recoveryEngine.isRecoveryMode(),
          pendingTasks: tasks,
          lastInjection: recoveryEngine.getLastInjectionDebug(),
          pendingWalCleanup: recoveryEngine.hasPendingWalCleanup(),
          injectedSessionsCount: recoveryEngine.getInjectedSessionsCount(),
        });
      },
    });

    // POST /qmemory/dismiss — 放弃恢复某个任务
    api.registerHttpRoute({
      path: "/qmemory/dismiss",
      auth: "gateway",
      match: "exact",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method Not Allowed" });
          return;
        }

        const body = await readJsonBody(req, api.logger);
        const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey : undefined;

        if (!sessionKey) {
          sendJson(res, 400, { error: "缺少 sessionKey 参数" });
          return;
        }

        const ctx = recoveryEngine.getRecoveryContext(sessionKey);
        if (!ctx) {
          sendJson(res, 404, { error: "未找到该会话的待恢复任务" });
          return;
        }

        recoveryEngine.dismissOne(sessionKey);
        sendJson(res, 200, { success: true });
      },
    });

    // POST /qmemory/dismiss-all — 放弃所有待恢复任务
    api.registerHttpRoute({
      path: "/qmemory/dismiss-all",
      auth: "gateway",
      match: "exact",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method Not Allowed" });
          return;
        }

        const count = recoveryEngine.getPendingRecoveries().size;
        recoveryEngine.clearAll();

        sendJson(res, 200, { success: true, dismissed: count });
      },
    });

    // POST /qmemory/cleanup — 手动触发 WAL 清理
    api.registerHttpRoute({
      path: "/qmemory/cleanup",
      auth: "gateway",
      match: "exact",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method Not Allowed" });
          return;
        }

        walStore.cleanup();
        sendJson(res, 200, { success: true });
      },
    });

    // ─── 注册聊天命令 ───
    // registerCommand 签名: (command: { name, description, handler }) => void
    // handler 签名: (ctx: PluginCommandContext) => ReplyPayload | Promise<ReplyPayload>

    api.registerCommand({
      name: "resume",
      description: "查看并恢复因 crash 中断的任务",
      handler: async (_ctx: unknown) => {
        const pendingRecoveries = recoveryEngine.getPendingRecoveries();

        if (pendingRecoveries.size === 0) {
          return { text: "当前没有需要恢复的中断任务。" };
        }

        const lines: string[] = ["发现以下中断任务：", ""];
        let idx = 1;
        for (const [sessionKey, recoveryCtx] of pendingRecoveries) {
          const { task } = recoveryCtx;
          const completed = task.steps.filter((s) => s.status === "completed").length;
          lines.push(`${idx}. 会话: ${sessionKey}`);
          if (task.originalPrompt) {
            const promptPreview =
              task.originalPrompt.length > 80
                ? task.originalPrompt.slice(0, 80) + "..."
                : task.originalPrompt;
            lines.push(`   任务: ${promptPreview}`);
          }
          lines.push(`   进度: ${completed}/${task.steps.length} 步已完成`);
          lines.push(
            `   中断时间: ${new Date(task.endedAt || task.updatedAt).toLocaleString()}`,
          );
          lines.push("");
          idx++;
        }

        lines.push("恢复方式：在对应会话中发送新消息，系统会自动注入恢复上下文。");
        return { text: lines.join("\n") };
      },
    });

  },
};

export default plugin;
