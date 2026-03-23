import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk'
import { reportWsConnectionEvent } from './common/report-data.js'
import { setWecomRuntime } from './common/runtime.js'

// 类型定义
type NormalizedChatType = 'direct' | 'group' | 'channel'
type WsState = string | number | undefined

type GatewayLog = {
  info?: (...args: any[]) => void
  warn?: (...args: any[]) => void
  error?: (...args: any[]) => void
}

interface WsClient {
  getState: () => WsState
  setCallbacks: (callbacks: Record<string, any>) => void
  start: () => void
  stop: () => void
}

interface WsRuntime {
  AgpWebSocketClient: new (config: any) => WsClient
  handlePrompt: (message: any, client: any) => Promise<void>
  handleCancel: (message: any, client: any) => void
  flushPendingTerminalMessages: (client: any) => void
  registerTerminalClient: (
    client: any,
    accountId: string,
    log?: GatewayLog,
  ) => void
  unregisterTerminalClient: (client: any) => void
}

let wsRuntimePromise: Promise<WsRuntime> | null = null

async function loadWsRuntime(): Promise<WsRuntime> {
  if (wsRuntimePromise) {
    return wsRuntimePromise
  }
  const runtimePromise = Promise.all([
    import('@tencent/agp-native'),
    import('./websocket/index.js'),
    import('./websocket/terminal-response-queue.js'),
  ]).then(([agpNative, websocketModule, queueModule]) => {
    const runtime: WsRuntime = {
      AgpWebSocketClient: agpNative.AgpWebSocketClient as WsRuntime['AgpWebSocketClient'],
      handlePrompt: websocketModule.handlePrompt,
      handleCancel: websocketModule.handleCancel,
      flushPendingTerminalMessages: queueModule.flushPendingTerminalMessages,
      registerTerminalClient: queueModule.registerTerminalClient,
      unregisterTerminalClient: queueModule.unregisterTerminalClient,
    }
    return runtime
  })
  wsRuntimePromise = runtimePromise
  return runtimePromise
}

// WebSocket 客户端实例（按 accountId 存储）
const wsClients = new Map<string, WsClient>()
const pendingOfflineTimers = new Map<string, ReturnType<typeof setTimeout>>()
const STATUS_OFFLINE_GRACE_MS = 4500
const FAILURE_COALESCE_MS = 2500

function clearOfflineTimer(accountId: string): void {
  const timer = pendingOfflineTimers.get(accountId)
  if (timer) {
    clearTimeout(timer)
    pendingOfflineTimers.delete(accountId)
  }
}

function formatConnectionState(state?: WsState): string {
  if (state === 1 || state === 'Connected' || state === 'connected') {
    return 'Connected'
  }
  if (state === 2 || state === 'Connecting' || state === 'connecting') {
    return 'Connecting'
  }
  if (state === 3 || state === 'Reconnecting' || state === 'reconnecting') {
    return 'Reconnecting'
  }
  return 'Disconnected'
}

function isClientRunning(state?: WsState): boolean {
  return formatConnectionState(state) !== 'Disconnected'
}

function resolveServerIp(wsUrl: string): string {
  try {
    return new URL(wsUrl).hostname
  } catch {
    return ''
  }
}

function scheduleOfflineStatus(
  ctx: any,
  accountId: string,
  client: WsClient,
  reason?: string,
  log?: GatewayLog,
): void {
  clearOfflineTimer(accountId)
  const timer = setTimeout(() => {
    pendingOfflineTimers.delete(accountId)
    if (wsClients.get(accountId) !== client) {
      return
    }
    const state = client.getState()
    if (isClientRunning(state)) {
      log?.info?.(`[wechat-access] 连接已恢复，跳过离线状态更新`, {
        accountId,
        reason,
        state,
      })
      return
    }
    log?.warn?.(`[wechat-access] 离线状态已确认: ${reason || 'unknown'}`)
    ctx.setStatus({ running: false })
  }, STATUS_OFFLINE_GRACE_MS)
  pendingOfflineTimers.set(accountId, timer)
}

// 渠道元数据
const meta = {
  id: 'wechat-access',
  label: '腾讯通路',
  /** 选择时的显示文本 */
  selectionLabel: '腾讯通路',
  detailLabel: '腾讯通路',
  /** 文档路径 */
  docsPath: '/channels/wechat-access',
  docsLabel: 'wechat-access',
  /** 简介 */
  blurb: '通用通路',
  /** 图标 */
  systemImage: 'message.fill',
  /** 排序权重 */
  order: 85,
}

// 渠道插件
const tencentAccessPlugin = {
  id: 'wechat-access',
  meta,

  // 能力声明
  capabilities: {
    chatTypes: ['direct'] as NormalizedChatType[],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },

  // 热重载：token 或 wsUrl 变更时触发 gateway 重启
  reload: {
    configPrefixes: [
      'channels.wechat-access.token',
      'channels.wechat-access.wsUrl',
    ],
  },

  // 配置适配器（必需）
  config: {
    listAccountIds: (cfg: any) => {
      const accounts = cfg.channels?.['wechat-access']?.accounts
      if (accounts && typeof accounts === 'object') {
        return Object.keys(accounts)
      }
      // 没有配置账号时，返回默认账号
      return ['default']
    },
    resolveAccount: (cfg: any, accountId: string) => {
      const accounts = cfg.channels?.['wechat-access']?.accounts
      const account = accounts?.[accountId ?? 'default']
      return account ?? { accountId: accountId ?? 'default' }
    },
  },

  // 出站适配器（必需）
  outbound: {
    deliveryMode: 'direct' as const,
    sendText: async () => ({ ok: true }),
  },

  // 状态适配器：上报 WebSocket 连接状态
  status: {
    buildAccountSnapshot: ({
      accountId,
    }: {
      accountId?: string
      cfg: any
      runtime?: any
    }) => {
      const client = wsClients.get(accountId ?? 'default')
      const running = isClientRunning(client?.getState())
      return { running }
    },
  },

  // Gateway 适配器：按账号启动/停止 WebSocket 连接
  gateway: {
    startAccount: async (ctx: any) => {
      const { cfg, accountId, abortSignal, log } = ctx
      const resolvedAccountId = accountId ?? 'default'

      clearOfflineTimer(resolvedAccountId)

      const tencentAccessConfig = cfg?.channels?.['wechat-access']
      const token = tencentAccessConfig?.token
        ? String(tencentAccessConfig.token)
        : ''
      const wsUrl = tencentAccessConfig?.wsUrl
        ? String(tencentAccessConfig.wsUrl)
        : ''
      const guid = tencentAccessConfig?.guid
        ? String(tencentAccessConfig.guid)
        : ''
      const userId = tencentAccessConfig?.userId
        ? String(tencentAccessConfig.userId)
        : ''
      const gatewayPort = cfg?.gateway?.port
        ? String(cfg.gateway.port)
        : 'unknown'
      const serverip = resolveServerIp(wsUrl)

      // 启动诊断日志
      log?.info(`[wechat-access] 启动账号 ${accountId}`, {
        platform: process.platform,
        nodeVersion: process.version,
        hasToken: !!token,
        hasUrl: !!wsUrl,
        url: wsUrl || '(未配置)',
        tokenLength: token ? token.length : 0,
        guid,
        userId,
        serverip,
      })

      if (!token) {
        log?.warn(`[wechat-access] token 为空，跳过 WebSocket 连接`)
        return
      }

      const wsConfig = {
        url: wsUrl,
        token,
        guid,
        user_id: userId,
        gateway_port: gatewayPort,
        reconnect_interval: 3000,
        max_reconnect_attempts: 10,
        heartbeat_interval: 20000,
      }

      const {
        AgpWebSocketClient,
        handlePrompt,
        handleCancel,
        flushPendingTerminalMessages,
        registerTerminalClient,
        unregisterTerminalClient,
      } = await loadWsRuntime()
      const client = new AgpWebSocketClient(wsConfig)
      registerTerminalClient(client, resolvedAccountId, log)
      const clientTraceId = `${resolvedAccountId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      let callbackSeq = 0
      let reconnectAttempt = 0
      let lastReportKey = ''
      let lastReportAt = 0
      let lastSocketError: { message: string; at: number } | null = null
      const getRecentSocketError = (): string => {
        if (!lastSocketError) {
          return ''
        }
        if (Date.now() - lastSocketError.at > FAILURE_COALESCE_MS) {
          lastSocketError = null
          return ''
        }
        return lastSocketError.message
      }
      const clearRecentSocketError = (): void => {
        lastSocketError = null
      }
      const reportConnectionEvent = (
        event_status: 'connecting' | 'connected' | 'failed' | 'reconnecting',
        extra: Record<string, unknown> = {}
      ): void => {
        const reason = typeof extra.reason === 'string' ? extra.reason : ''
        const errorDetail =
          typeof extra.error_detail === 'string' ? extra.error_detail : ''
        const callbackSource =
          typeof extra.callback_source === 'string' ? extra.callback_source : ''
        const reportKey = [event_status, reason, errorDetail, callbackSource].join(':')
        const now = Date.now()
        if (reportKey === lastReportKey && now - lastReportAt < 1000) {
          return
        }
        lastReportKey = reportKey
        lastReportAt = now
        reportWsConnectionEvent({
          guid,
          uid: userId,
          serverip,
          event_status,
          event_time: new Date(now).toISOString(),
          account_id: resolvedAccountId,
          gateway_port: gatewayPort,
          client_trace_id: clientTraceId,
          callback_seq: callbackSeq,
          connection_state: formatConnectionState(client.getState()),
          ws_url: wsUrl,
          ...extra,
        })
      }
      const logGatewayEvent = (
        level: 'info' | 'warn' | 'error',
        event: string,
        extra: Record<string, unknown> = {}
      ): void => {
        const logger =
          level === 'error' ? log?.error : level === 'warn' ? log?.warn : log?.info
        logger?.(`[wechat-access] ${event}`, {
          accountId: resolvedAccountId,
          clientTraceId,
          callbackSeq,
          state: formatConnectionState(client.getState()),
          gatewayPort,
          guid,
          userId,
          serverip,
          ...extra,
        })
      }

      client.setCallbacks({
        onConnected: (_err: Error | null) => {
          callbackSeq += 1
          reconnectAttempt = 0
          clearRecentSocketError()
          clearOfflineTimer(resolvedAccountId)
          logGatewayEvent('info', 'WebSocket 连接成功')
          reportConnectionEvent('connected', { callback_source: 'onConnected' })
          ctx.setStatus({ running: true })
          flushPendingTerminalMessages(client)
        },
        onDisconnected: (_err: Error | null, reason?: string) => {
          callbackSeq += 1
          const disconnectReason = reason || 'unknown'
          const errorDetail = getRecentSocketError()
          const shouldRetry =
            disconnectReason !== '用户主动断开'
            && disconnectReason !== '达到最大重连次数'
          logGatewayEvent('warn', 'WebSocket 连接断开', {
            reason: disconnectReason,
            errorDetail,
            reconnectAttempt,
          })
          if (disconnectReason !== '用户主动断开') {
            const shouldReportFailed =
              !errorDetail || disconnectReason === '达到最大重连次数'
            if (shouldReportFailed) {
              reportConnectionEvent('failed', {
                reason: disconnectReason,
                error_detail: errorDetail || disconnectReason,
                callback_source: 'onDisconnected',
                reconnect_attempt: reconnectAttempt,
                reconnect_delay_ms: shouldRetry ? wsConfig.reconnect_interval : 0,
              })
            }
            if (shouldRetry) {
              reconnectAttempt += 1
              reportConnectionEvent('reconnecting', {
                reason: disconnectReason,
                error_detail: errorDetail || disconnectReason,
                callback_source: 'onDisconnected',
                reconnect_attempt: reconnectAttempt,
                reconnect_delay_ms: wsConfig.reconnect_interval,
              })
            }
          }
          clearRecentSocketError()
          scheduleOfflineStatus(ctx, resolvedAccountId, client, reason, log)
        },
        onPrompt: (_err: Error | null, message: any) => {
          callbackSeq += 1
          logGatewayEvent('info', '收到 session.prompt', {
            msgId: message?.msg_id,
            promptId: message?.payload?.prompt_id,
            sessionId: message?.payload?.session_id,
            guid: message?.guid,
            userId: message?.user_id,
          })
          void handlePrompt(message, client).catch((err: Error) => {
            logGatewayEvent('error', '处理 prompt 失败', {
              message: err.message,
              promptId: message?.payload?.prompt_id,
              sessionId: message?.payload?.session_id,
            })
          })
        },
        onCancel: (_err: Error | null, message: any) => {
          callbackSeq += 1
          logGatewayEvent('info', '收到 session.cancel', {
            msgId: message?.msg_id,
            promptId: message?.payload?.prompt_id,
            sessionId: message?.payload?.session_id,
          })
          handleCancel(message, client)
        },
        onError: (_err: Error | null, error: string) => {
          callbackSeq += 1
          lastSocketError = { message: error, at: Date.now() }
          logGatewayEvent('error', 'WebSocket 错误', { error, reconnectAttempt })
          reportConnectionEvent('failed', {
            reason: '连接失败',
            error_detail: error,
            callback_source: 'onError',
            reconnect_attempt: reconnectAttempt,
            reconnect_delay_ms: wsConfig.reconnect_interval,
          })
        },
      })

      wsClients.set(resolvedAccountId, client)
      logGatewayEvent('info', '开始启动 WebSocket 客户端', {
        wsUrl,
        reconnectInterval: wsConfig.reconnect_interval,
        maxReconnectAttempts: wsConfig.max_reconnect_attempts,
      })
      reportConnectionEvent('connecting')
      client.start()

      // 等待框架发出停止信号
      await new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => {
          clearOfflineTimer(resolvedAccountId)
          log?.info(`[wechat-access] 停止账号 ${resolvedAccountId}`)
          // 始终停止当前闭包捕获的 client，避免多次 startAccount 时
          // wsClients 被新 client 覆盖后，旧 client 的 stop() 永远不被调用，导致无限重连
          client.stop()
          unregisterTerminalClient(client)
          // 仅当 wsClients 中存的还是当前 client 时才删除，避免误删新 client
          if (wsClients.get(resolvedAccountId) === client) {
            wsClients.delete(resolvedAccountId)
            ctx.setStatus({ running: false })
          }
          resolve()
        })
      })
    },

    stopAccount: async (ctx: any) => {
      const { accountId, log } = ctx
      const resolvedAccountId = accountId ?? 'default'
      clearOfflineTimer(resolvedAccountId)
      log?.info(
        `[wechat-access] stopAccount 钩子触发，停止账号 ${resolvedAccountId}`
      )
      const client = wsClients.get(resolvedAccountId)
      if (client) {
        const { unregisterTerminalClient } = await loadWsRuntime()
        client.stop()
        unregisterTerminalClient(client)
        wsClients.delete(resolvedAccountId)
        ctx.setStatus({ running: false })
        log?.info(`[wechat-access] 账号 ${resolvedAccountId} 已停止`)
      } else {
        ctx.setStatus({ running: false })
        log?.warn(
          `[wechat-access] stopAccount: 未找到账号 ${resolvedAccountId} 的客户端`
        )
      }
    },
  },
}

const index: any = {
  id: 'wechat-access',
  name: '通用通路插件',
  description: '腾讯通用通路插件',
  configSchema: emptyPluginConfigSchema(),

  /**
   * 插件注册入口点
   */
  register(api: OpenClawPluginApi) {
    // 1. 设置运行时环境
    setWecomRuntime(api.runtime)

    // 2. 注册渠道插件
    api.registerChannel({ plugin: tencentAccessPlugin as any })

    console.log('[wechat-access] 腾讯通路插件已注册')
  },
}

export default index
