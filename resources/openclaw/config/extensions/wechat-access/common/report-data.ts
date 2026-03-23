import fs from 'node:fs'
import path from 'node:path'
import { getWecomRuntime } from './runtime.js'

type ReportDataParams = Record<string, unknown>

type ReportContext = {
  trace_id?: string
  guid?: string
  uid?: string
  app_version?: string
  source_terminal?: string
}

const REPORT_CONTEXT_CACHE_FILE = path.join(
  'plugins',
  'wechat-access',
  'report-context.json'
)

const INVALID_GUID_VALUES = new Set(['123123'])

let currentReportContext: ReportContext = {}
let reportContextLoaded = false
let lastWsConnectionPayload: WsConnectionReportPayload | null = null
let lastWsReportedKey = ''

type GatewayHandlerPayload = {
  params: Record<string, unknown>
  respond: (ok: boolean, payload?: unknown, error?: unknown) => void
  req: { method: string; params: Record<string, unknown> }
  client: null
  isWebchatConnect: boolean
  context: null
}

type GatewayHandler = (payload: GatewayHandlerPayload) => Promise<void> | void

type ContentPluginReportBridge = {
  syncExternalReportState: (params: ReportDataParams) => void
  reportWsConnectionEvent: (params: ReportDataParams) => void
}

function getContentPluginReportBridge(): ContentPluginReportBridge | null {
  const bridgeSymbol = Symbol.for('openclaw.contentPluginReportBridge')
  const bridge = (globalThis as Record<string | symbol, unknown>)[bridgeSymbol] as
    | ContentPluginReportBridge
    | undefined
  return bridge ?? null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function normalizeGuid(value?: string): string {
  if (!isNonEmptyString(value)) {
    return ''
  }
  const guid = value.trim()
  return INVALID_GUID_VALUES.has(guid) ? '' : guid
}

function normalizeUid(value?: string): string {
  return isNonEmptyString(value) ? value.trim() : ''
}

function hasWsReportGuid(payload: WsConnectionReportPayload): boolean {
  return !!normalizeGuid(payload.guid || currentReportContext.guid)
}

function resolveReportContextCachePath(): string | null {
  try {
    const stateDir = getWecomRuntime().state.resolveStateDir()
    if (!stateDir) {
      return null
    }
    return path.join(stateDir, REPORT_CONTEXT_CACHE_FILE)
  } catch {
    return null
  }
}

function ensureReportContextLoaded(): void {
  if (reportContextLoaded) {
    return
  }
  reportContextLoaded = true

  const cachePath = resolveReportContextCachePath()
  if (!cachePath || !fs.existsSync(cachePath)) {
    return
  }

  try {
    const raw = fs.readFileSync(cachePath, 'utf-8')
    const cached = JSON.parse(raw) as ReportContext
    const guid = normalizeGuid(cached.guid)
    const uid = normalizeUid(cached.uid)
    if (guid) {
      currentReportContext.guid = guid
    }
    if (uid) {
      currentReportContext.uid = uid
    }
    if (typeof cached.app_version === 'string' && cached.app_version) {
      currentReportContext.app_version = cached.app_version
    }
    if (typeof cached.source_terminal === 'string' && cached.source_terminal) {
      currentReportContext.source_terminal = cached.source_terminal
    }
  } catch {
  }
}

function persistReportContext(): void {
  const cachePath = resolveReportContextCachePath()
  if (!cachePath) {
    return
  }

  const data: ReportContext = {
    guid: normalizeGuid(currentReportContext.guid),
    uid: normalizeUid(currentReportContext.uid),
    app_version: currentReportContext.app_version,
    source_terminal: currentReportContext.source_terminal,
  }

  if (!data.guid && !data.uid && !data.app_version && !data.source_terminal) {
    return
  }

  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
  } catch {
  }
}

function updateReportContext(params: ReportDataParams): void {
  ensureReportContextLoaded()

  let changed = false

  if (typeof params.trace_id === 'string' && params.trace_id) {
    if (currentReportContext.trace_id !== params.trace_id) {
      currentReportContext.trace_id = params.trace_id
      changed = true
    }
  }

  const guid = normalizeGuid(typeof params.guid === 'string' ? params.guid : '')
  if (guid && currentReportContext.guid !== guid) {
    currentReportContext.guid = guid
    changed = true
  }

  const uid = normalizeUid(typeof params.uid === 'string' ? params.uid : '')
  if (uid && currentReportContext.uid !== uid) {
    currentReportContext.uid = uid
    changed = true
  }

  if (typeof params.app_version === 'string' && params.app_version) {
    if (currentReportContext.app_version !== params.app_version) {
      currentReportContext.app_version = params.app_version
      changed = true
    }
  }

  if (typeof params.source_terminal === 'string' && params.source_terminal) {
    if (currentReportContext.source_terminal !== params.source_terminal) {
      currentReportContext.source_terminal = params.source_terminal
      changed = true
    }
  }

  if (changed) {
    persistReportContext()
  }
}

function sendViaBridge(params: ReportDataParams): boolean {
  const bridge = getContentPluginReportBridge()
  if (!bridge) {
    return false
  }

  bridge.syncExternalReportState(params)
  if (params.event_name === 'agp_ws_connection') {
    bridge.reportWsConnectionEvent(params)
  }
  return true
}

function sendViaGateway(params: ReportDataParams): void {
  try {
    const registrySymbol = Symbol.for('openclaw.pluginRegistryState')
    const registryState = (globalThis as Record<string | symbol, unknown>)[registrySymbol] as {
      registry?: {
        gatewayHandlers?: Record<string, GatewayHandler>
      }
    } | undefined
    const handler = registryState?.registry?.gatewayHandlers?.['report.data']
    if (typeof handler === 'function') {
      void handler({
        params,
        respond: () => {},
        req: { method: 'report.data', params },
        client: null,
        isWebchatConnect: false,
        context: null,
      })
    }
  } catch {
  }
}

function normalizeWsPayload(payload: WsConnectionReportPayload): WsConnectionReportPayload {
  ensureReportContextLoaded()
  return {
    ...payload,
    event_time: payload.event_time || new Date().toISOString(),
    guid: normalizeGuid(payload.guid) || normalizeGuid(currentReportContext.guid),
    uid: normalizeUid(payload.uid) || normalizeUid(currentReportContext.uid),
    app_version: payload.app_version || currentReportContext.app_version,
    source_terminal:
      payload.source_terminal || currentReportContext.source_terminal || 'wechat',
  }
}

function buildWsReportKey(payload: WsConnectionReportPayload): string {
  return [
    payload.event_time || '',
    payload.event_status,
    payload.serverip || '',
    payload.reason || '',
    payload.error_detail || '',
    payload.callback_source || '',
    payload.client_trace_id || '',
    String(payload.callback_seq ?? ''),
    String(payload.reconnect_attempt ?? ''),
    String(payload.reconnect_delay_ms ?? ''),
  ].join('|')
}

function buildWsConnectionParams(payload: WsConnectionReportPayload): ReportDataParams {
  const normalizedPayload = normalizeWsPayload(payload)
  return {
    event_name: 'agp_ws_connection',
    event_time: normalizedPayload.event_time,
    guid: normalizedPayload.guid || '',
    uid: normalizedPayload.uid || '',
    serverip: normalizedPayload.serverip || '',
    event_status: normalizedPayload.event_status,
    reason: normalizedPayload.reason,
    error_detail: normalizedPayload.error_detail,
    reconnect_attempt: normalizedPayload.reconnect_attempt,
    reconnect_delay_ms: normalizedPayload.reconnect_delay_ms,
    app_version: normalizedPayload.app_version,
    source_terminal: normalizedPayload.source_terminal,
    account_id: normalizedPayload.account_id,
    gateway_port: normalizedPayload.gateway_port,
    client_trace_id: normalizedPayload.client_trace_id,
    callback_seq: normalizedPayload.callback_seq,
    callback_source: normalizedPayload.callback_source,
    connection_state: normalizedPayload.connection_state,
    ws_url: normalizedPayload.ws_url,
  }
}

function emitWsConnectionEvent(payload: WsConnectionReportPayload): void {
  const reportKey = buildWsReportKey(payload)
  if (reportKey === lastWsReportedKey) {
    return
  }
  lastWsReportedKey = reportKey
  invokeReportData(buildWsConnectionParams(payload))
}

function maybeBackfillWsConnectionEvent(): void {
  if (!lastWsConnectionPayload) {
    return
  }

  const nextPayload = normalizeWsPayload(lastWsConnectionPayload)
  if (!hasWsReportGuid(nextPayload)) {
    return
  }

  if (buildWsReportKey(nextPayload) === lastWsReportedKey) {
    return
  }

  console.log('[wechat-access] 补发 agp_ws_connection 事件，补齐 guid', {
    event_status: nextPayload.event_status,
    account_id: nextPayload.account_id,
    callback_source: nextPayload.callback_source,
    client_trace_id: nextPayload.client_trace_id,
  })

  lastWsConnectionPayload = nextPayload
  emitWsConnectionEvent(nextPayload)
}

export function invokeReportData(params: ReportDataParams): void {
  updateReportContext(params)

  const isWsConnectionEvent = params.event_name === 'agp_ws_connection'
  const handledByBridge = sendViaBridge(params)
  if (!handledByBridge) {
    sendViaGateway(params)
  }

  if (!isWsConnectionEvent) {
    maybeBackfillWsConnectionEvent()
  }
}

export interface WsConnectionReportPayload {
  event_time?: string
  guid?: string
  uid?: string
  serverip?: string
  event_status: 'connecting' | 'connected' | 'failed' | 'reconnecting'
  reason?: string
  error_detail?: string
  reconnect_attempt?: number
  reconnect_delay_ms?: number
  app_version?: string
  source_terminal?: string
  account_id?: string
  gateway_port?: string
  client_trace_id?: string
  callback_seq?: number
  callback_source?: string
  connection_state?: string
  ws_url?: string
}

export interface WsConnectionLogData {
  guid?: string
  uid?: string
  serverip?: string
  eventStatus: string
  eventTime?: string
  reason?: string
  errorDetail?: string
  reconnectAttempt?: number
  reconnectDelayMs?: number
  appVersion?: string
  sourceTerminal?: string
  openclawVersion?: string
  accountId?: string
  gatewayPort?: string
  clientTraceId?: string
  callbackSeq?: number
  callbackSource?: string
  connectionState?: string
  wsUrl?: string
}

export function reportWsConnectionEvent(payload: WsConnectionReportPayload): void {
  const normalizedPayload = normalizeWsPayload(payload)
  lastWsConnectionPayload = normalizedPayload

  if (!hasWsReportGuid(normalizedPayload)) {
    console.warn('[wechat-access] 跳过 agp_ws_connection 上报：缺少有效 guid', {
      event_status: normalizedPayload.event_status,
      account_id: normalizedPayload.account_id,
      callback_source: normalizedPayload.callback_source,
      client_trace_id: normalizedPayload.client_trace_id,
      reason: normalizedPayload.reason,
      error_detail: normalizedPayload.error_detail,
    })
    return
  }

  emitWsConnectionEvent(normalizedPayload)
}
