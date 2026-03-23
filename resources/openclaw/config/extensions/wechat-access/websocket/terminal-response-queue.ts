import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AgpWebSocketClient,
  ConnectionState,
  type PromptResponsePayload,
} from '@tencent/agp-native'

type GatewayLog = {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

interface PendingPromptResponse {
  key: string
  accountId: string
  label: string
  payload: PromptResponsePayload
  guid?: string
  userId?: string
  queuedAt: number
  updatedAt: number
  attempts: number
}

interface ReliablePromptResponseInput {
  client: AgpWebSocketClient
  label: string
  payload: PromptResponsePayload
  guid?: string
  userId?: string
}

const FLUSH_INTERVAL_MS = 2000
const STORAGE_DIR = path.join(os.homedir(), '.openclaw', 'wechat-access')
const STORAGE_FILE = path.join(STORAGE_DIR, 'pending-prompt-responses.json')

const accountClients = new Map<string, AgpWebSocketClient>()
const accountLogs = new Map<string, GatewayLog | undefined>()
const accountFlushTimers = new Map<string, ReturnType<typeof setInterval>>()
const clientAccountIds = new WeakMap<AgpWebSocketClient, string>()
const pendingPromptResponses = loadPendingPromptResponses()

function loadPendingPromptResponses(): Map<string, PendingPromptResponse> {
  try {
    if (!fs.existsSync(STORAGE_FILE)) {
      return new Map()
    }
    const raw = fs.readFileSync(STORAGE_FILE, 'utf8')
    if (!raw.trim()) {
      return new Map()
    }
    const list = JSON.parse(raw) as PendingPromptResponse[]
    return new Map(list.map((item) => [item.key, item]))
  } catch (err) {
    console.error('[wechat-access] 加载终态消息 WAL 失败，忽略旧数据', err)
    return new Map()
  }
}

function persistPendingPromptResponses(): void {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true })
    const tmpFile = `${STORAGE_FILE}.tmp`
    const content = JSON.stringify(
      Array.from(pendingPromptResponses.values()),
      null,
      2
    )
    fs.writeFileSync(tmpFile, content, 'utf8')
    fs.renameSync(tmpFile, STORAGE_FILE)
  } catch (err) {
    console.error('[wechat-access] 持久化终态消息 WAL 失败', err)
  }
}

const formatConnectionState = (state: ConnectionState): string => {
  switch (state) {
    case ConnectionState.Connected:
      return 'Connected'
    case ConnectionState.Connecting:
      return 'Connecting'
    case ConnectionState.Reconnecting:
      return 'Reconnecting'
    default:
      return 'Disconnected'
  }
}

const getAccountIdByClient = (client: AgpWebSocketClient): string => {
  return clientAccountIds.get(client) ?? 'default'
}

const getPendingItemsByAccount = (accountId: string): PendingPromptResponse[] => {
  return Array.from(pendingPromptResponses.values())
    .filter((item) => item.accountId === accountId)
    .sort((a, b) => a.queuedAt - b.queuedAt)
}

const makePendingKey = (accountId: string, promptId: string): string => {
  return `${accountId}:${promptId}`
}

const ensureFlushTimer = (accountId: string): void => {
  if (accountFlushTimers.has(accountId)) {
    return
  }
  const timer = setInterval(() => {
    flushPendingPromptResponsesByAccount(accountId)
  }, FLUSH_INTERVAL_MS)
  accountFlushTimers.set(accountId, timer)
}

const clearFlushTimer = (accountId: string): void => {
  const timer = accountFlushTimers.get(accountId)
  if (timer) {
    clearInterval(timer)
    accountFlushTimers.delete(accountId)
  }
}

const enqueuePromptResponse = (
  accountId: string,
  label: string,
  payload: PromptResponsePayload,
  guid?: string,
  userId?: string
): boolean => {
  const key = makePendingKey(accountId, payload.prompt_id)
  const log = accountLogs.get(accountId)
  const prev = pendingPromptResponses.get(key)
  const now = Date.now()
  pendingPromptResponses.set(key, {
    key,
    accountId,
    label,
    payload,
    guid,
    userId,
    queuedAt: prev?.queuedAt ?? now,
    updatedAt: now,
    attempts: (prev?.attempts ?? 0) + 1,
  })
  persistPendingPromptResponses()
  log?.warn?.('[wechat-access] 终态消息已写入补发队列', {
    accountId,
    key,
    label,
    pending: getPendingItemsByAccount(accountId).length,
    state: formatConnectionState(accountClients.get(accountId)?.getState() ?? ConnectionState.Disconnected),
  })
  return true
}

const trySendPromptResponse = (
  client: AgpWebSocketClient,
  payload: PromptResponsePayload,
  guid?: string,
  userId?: string
): void => {
  client.sendPromptResponse(payload, guid, userId)
}

export const registerTerminalClient = (
  client: AgpWebSocketClient,
  accountId: string,
  log?: GatewayLog
): void => {
  accountClients.set(accountId, client)
  accountLogs.set(accountId, log)
  clientAccountIds.set(client, accountId)
  ensureFlushTimer(accountId)
  const pending = getPendingItemsByAccount(accountId).length
  if (pending > 0) {
    log?.info?.('[wechat-access] 检测到历史终态消息待补发', {
      accountId,
      pending,
    })
  }
}

export const unregisterTerminalClient = (client: AgpWebSocketClient): void => {
  const accountId = clientAccountIds.get(client)
  if (!accountId) {
    return
  }
  if (accountClients.get(accountId) === client) {
    accountClients.delete(accountId)
    accountLogs.delete(accountId)
    clearFlushTimer(accountId)
  }
  clientAccountIds.delete(client)
}

export const sendPromptResponseReliable = ({
  client,
  label,
  payload,
  guid,
  userId,
}: ReliablePromptResponseInput): boolean => {
  const accountId = getAccountIdByClient(client)
  try {
    console.log(
      `[wechat-access-ws] ${label} 尝试发送: state=${formatConnectionState(client.getState())}`
    )
    trySendPromptResponse(client, payload, guid, userId)
    return true
  } catch (err) {
    console.warn(
      `[wechat-access-ws] ${label} 发送失败，写入补发队列: state=${formatConnectionState(client.getState())}`,
      err
    )
    return enqueuePromptResponse(accountId, label, payload, guid, userId)
  }
}

export const flushPendingTerminalMessages = (
  client: AgpWebSocketClient
): void => {
  flushPendingPromptResponsesByAccount(getAccountIdByClient(client))
}

function flushPendingPromptResponsesByAccount(accountId: string): void {
  const client = accountClients.get(accountId)
  const log = accountLogs.get(accountId)
  if (!client) {
    return
  }
  if (client.getState() !== ConnectionState.Connected) {
    return
  }
  const items = getPendingItemsByAccount(accountId)
  if (items.length === 0) {
    return
  }

  log?.info?.('[wechat-access] 开始补发终态消息', {
    accountId,
    pending: items.length,
    state: formatConnectionState(client.getState()),
  })

  let dirty = false
  for (const item of items) {
    try {
      trySendPromptResponse(client, item.payload, item.guid, item.userId)
      pendingPromptResponses.delete(item.key)
      dirty = true
      log?.info?.('[wechat-access] 终态消息补发成功', {
        accountId,
        key: item.key,
        label: item.label,
        queuedForMs: Date.now() - item.queuedAt,
        pending: getPendingItemsByAccount(accountId).length,
      })
    } catch (err) {
      pendingPromptResponses.set(item.key, {
        ...item,
        attempts: item.attempts + 1,
        updatedAt: Date.now(),
      })
      dirty = true
      log?.warn?.('[wechat-access] 终态消息补发失败，等待下一轮重试', {
        accountId,
        key: item.key,
        label: item.label,
        attempts: item.attempts + 1,
        pending: getPendingItemsByAccount(accountId).length,
        state: formatConnectionState(client.getState()),
        error: err instanceof Error ? err.message : String(err),
      })
      break
    }
  }

  if (dirty) {
    persistPendingPromptResponses()
  }
}
