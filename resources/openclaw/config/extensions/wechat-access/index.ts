import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import pkg from "node-machine-id";
import { WechatAccessWebSocketClient, handlePrompt, handleCancel } from "./websocket/index.js";
// import { handleSimpleWecomWebhook } from "./http/webhook.js";
import { setWecomRuntime } from "./common/runtime.js";
const { machineId } = pkg;

// 类型定义
type NormalizedChatType = "direct" | "group" | "channel";

// WebSocket 客户端实例（按 accountId 存储）
const wsClients = new Map<string, WechatAccessWebSocketClient>();

// 渠道元数据
const meta = {
  id: "wechat-access",
  label: "腾讯通路",
  /** 选择时的显示文本 */
  selectionLabel: "腾讯通路",
  detailLabel: "腾讯通路",
  /** 文档路径 */
  docsPath: "/channels/wechat-access",
  docsLabel: "wechat-access",
  /** 简介 */
  blurb: "通用通路",
  /** 图标 */
  systemImage: "message.fill",
  /** 排序权重 */
  order: 85,
};

// 渠道插件
const tencentAccessPlugin = {
  id: "wechat-access",
  meta,

  // 能力声明
  capabilities: {
    chatTypes: ["direct"] as NormalizedChatType[],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },

  // 热重载：token 或 wsUrl 变更时触发 gateway 重启
  reload: {
    configPrefixes: [
      "channels.wechat-access.token",
      "channels.wechat-access.wsUrl",
      "channels.wechat-access.guid",
      "channels.wechat-access.userId",
      "channels.wechat-access.user_id",
      "channels.wechat-access.accounts",
    ],
  },

  // 配置适配器（必需）
  config: {
    listAccountIds: (cfg: any) => {
      const accounts = cfg.channels?.["wechat-access"]?.accounts;
      if (accounts && typeof accounts === "object") {
        return Object.keys(accounts);
      }
      // 没有配置账号时，返回默认账号
      return ["default"];
    },
    resolveAccount: (cfg: any, accountId: string) => {
      const accounts = cfg.channels?.["wechat-access"]?.accounts;
      const account = accounts?.[accountId ?? "default"];
      return account ?? { accountId: accountId ?? "default" };
    },
  },

  // 出站适配器（必需）
  outbound: {
    deliveryMode: "direct" as const,
    sendText: async () => ({ ok: true }),
  },

  // 状态适配器：上报 WebSocket 连接状态
  status: {
    buildAccountSnapshot: ({ accountId }: { accountId?: string; cfg: any; runtime?: any }) => {
      const client = wsClients.get(accountId ?? "default");
      const running = client?.getState() === "connected";
      return { running };
    },
  },

  // Gateway 适配器：按账号启动/停止 WebSocket 连接
  gateway: {
    startAccount: async (ctx: any) => {
      const { cfg, accountId, abortSignal, log } = ctx;

      const tencentAccessConfig = cfg?.channels?.["wechat-access"];
      const pluginEnabled = cfg?.plugins?.entries?.["wechat-access"]?.enabled !== false;
      const channelEnabled = tencentAccessConfig?.enabled !== false;
      if (!pluginEnabled || !channelEnabled) {
        log?.info("[wechat-access] 已禁用，跳过 WebSocket 连接", {
          pluginEnabled,
          channelEnabled,
          accountId,
        });
        return;
      }
      const accountConfig = tencentAccessConfig?.accounts?.[accountId] ?? {};
      const token = accountConfig?.token
        ? String(accountConfig.token)
        : tencentAccessConfig?.token
          ? String(tencentAccessConfig.token)
          : "";
      const wsUrl = accountConfig?.wsUrl
        ? String(accountConfig.wsUrl)
        : tencentAccessConfig?.wsUrl
          ? String(tencentAccessConfig.wsUrl)
          : "";
      const configuredGuid = accountConfig?.guid
        ? String(accountConfig.guid)
        : tencentAccessConfig?.guid
          ? String(tencentAccessConfig.guid)
          : "";
      const configuredUserId = accountConfig?.userId
        ? String(accountConfig.userId)
        : accountConfig?.user_id
          ? String(accountConfig.user_id)
          : tencentAccessConfig?.userId
            ? String(tencentAccessConfig.userId)
            : tencentAccessConfig?.user_id
              ? String(tencentAccessConfig.user_id)
              : "";
      const gatewayPort = cfg?.gateway?.port ? String(cfg.gateway.port) : "unknown";
      let guid = configuredGuid;

      if (!guid) {
        try {
          guid = await machineId();
        } catch (error) {
          log?.warn("[wechat-access] machineId 获取失败，guid 将保持为空", error);
        }
      }

      const userId = configuredUserId || String(accountId || "default");

      // 启动诊断日志
      log?.info(`[wechat-access] 启动账号 ${accountId}`, {
        platform: process.platform,
        nodeVersion: process.version,
        hasToken: !!token,
        hasUrl: !!wsUrl,
        hasGuid: !!guid,
        hasUserId: !!userId,
        url: wsUrl || "(未配置)",
        tokenPrefix: token ? token.substring(0, 6) + "..." : "(未配置)",
        guid,
        userId,
      });

      if (!token) {
        log?.warn(`[wechat-access] token 为空，跳过 WebSocket 连接`);
        return;
      }

      if (!guid) {
        log?.warn("[wechat-access] guid 为空，跳过 WebSocket 连接");
        return;
      }

      if (!userId) {
        log?.warn("[wechat-access] userId 为空，跳过 WebSocket 连接");
        return;
      }

      const wsConfig = {
        url: wsUrl,
        token,
        guid,
        userId,
        gatewayPort,
        reconnectInterval: 3000,
        maxReconnectAttempts: 10,
        heartbeatInterval: 20000,
      };

      const client = new WechatAccessWebSocketClient(wsConfig, {
        onConnected: () => {
          log?.info(`[wechat-access] WebSocket 连接成功`);
          ctx.setStatus({ running: true });
        },
        onDisconnected: (reason?: string) => {
          log?.warn(`[wechat-access] WebSocket 连接断开: ${reason}`);
          ctx.setStatus({ running: false });
        },
        onPrompt: (message: any) => {
          void handlePrompt(message, client).catch((err: Error) => {
            log?.error(`[wechat-access] 处理 prompt 失败: ${err.message}`);
          });
        },
        onCancel: (message: any) => {
          handleCancel(message, client);
        },
        onError: (error: Error) => {
          log?.error(`[wechat-access] WebSocket 错误: ${error.message}`);
        },
      });

      wsClients.set(accountId, client);
      client.start();

      // 等待框架发出停止信号
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener("abort", () => {
          log?.info(`[wechat-access] 停止账号 ${accountId}`);
          // 始终停止当前闭包捕获的 client，避免多次 startAccount 时
          // wsClients 被新 client 覆盖后，旧 client 的 stop() 永远不被调用，导致无限重连
          client.stop();
          // 仅当 wsClients 中存的还是当前 client 时才删除，避免误删新 client
          if (wsClients.get(accountId) === client) {
            wsClients.delete(accountId);
            ctx.setStatus({ running: false });
          }
          resolve();
        });
      });
    },

    stopAccount: async (ctx: any) => {
      const { accountId, log } = ctx;
      log?.info(`[wechat-access] stopAccount 钩子触发，停止账号 ${accountId}`);
      const client = wsClients.get(accountId);
      if (client) {
        client.stop();
        wsClients.delete(accountId);
        ctx.setStatus({ running: false });
        log?.info(`[wechat-access] 账号 ${accountId} 已停止`);
      } else {
        log?.warn(`[wechat-access] stopAccount: 未找到账号 ${accountId} 的客户端`);
      }
    },
  },
};

const index = {
  id: "wechat-access",
  name: "通用通路插件",
  description: "腾讯通用通路插件",
  configSchema: emptyPluginConfigSchema(),

  /**
   * 插件注册入口点
   */
  register(api: OpenClawPluginApi) {
    // 1. 设置运行时环境
    setWecomRuntime(api.runtime);

    // 2. 注册渠道插件
    api.registerChannel({ plugin: tencentAccessPlugin as any });

    // 3. 注册 HTTP 处理器（如需要）
    // api.registerHttpHandler(handleSimpleWecomWebhook);

    console.log("[wechat-access] 腾讯通路插件已注册");
  },
};

export default index;
