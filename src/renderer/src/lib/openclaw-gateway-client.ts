export const GATEWAY_STATUS = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error',
} as const

export type GatewayStatus = (typeof GATEWAY_STATUS)[keyof typeof GATEWAY_STATUS]

type PendingRequest = {
  method: string
  resolve: (value: any) => void
  reject: (reason?: unknown) => void
  timer: number
}

type ChatEventPayload = {
  runId?: string | null
  sessionKey?: string
  state?: string
  message?: any
  errorMessage?: string
  nonce?: string
  toolCallId?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolOutput?: string
  toolStreamPhase?: string
  role?: string
  delta?: string
  stream?: string
  data?: Record<string, any>
}

type DeviceIdentity = {
  deviceId: string
  publicKey: string
  privateKey: string
}

type StoredDeviceIdentity = DeviceIdentity & {
  version: 1
  createdAtMs: number
}

type StoredDeviceAuth = {
  version: 1
  deviceId: string
  tokens: Record<
    string,
    {
      token: string
      role: string
      scopes: string[]
      updatedAtMs: number
    }
  >
}

type GatewayClientOptions = {
  url: string
  token: string
  clientId?: string
  clientVersion?: string
  mode?: string
  onStatusChange?: (status: GatewayStatus) => void
  onMessage?: (payload: {
    runId?: string | null
    sessionKey?: string
    state: string
    text: string
    message?: any
    error?: boolean
    aborted?: boolean
    delta?: string
    toolCallId?: string
    toolName?: string
    toolArgs?: Record<string, unknown>
    toolOutput?: string
    toolStreamPhase?: string
    role?: string
  }) => void
  onError?: (error: unknown) => void
}

const DEVICE_IDENTITY_STORAGE_KEY = 'openclaw.device.identity.v1'
const DEVICE_AUTH_STORAGE_KEY = 'openclaw.device.auth.v1'
const CONNECT_ROLE = 'operator'
const CONNECT_SCOPES = ['operator.admin', 'operator.approvals', 'operator.pairing']
const GATEWAY_DEBUG_ENABLED = true
const GATEWAY_DEBUGGED_METHODS = new Set(['chat.send', 'sessions.patch'])

function truncateDebugText(value: unknown, limit = 400) {
  if (typeof value !== 'string') {
    return value
  }

  if (value.length <= limit) {
    return value
  }

  return `${value.slice(0, limit)}...(len=${value.length})`
}

function getMessageContentTypes(message: any) {
  if (!Array.isArray(message?.content)) {
    return []
  }

  return message.content.map((item) => String(item?.type || 'unknown'))
}

function debugGatewayLog(label: string, payload?: Record<string, unknown>) {
  if (!GATEWAY_DEBUG_ENABLED) {
    return
  }

  if (payload) {
    console.log('[GatewayDebug]', label, payload)
    return
  }

  console.log('[GatewayDebug]', label)
}

function shouldLogGatewayEvent(eventName: unknown) {
  const normalized = String(eventName || '')
  return normalized === 'agent' || normalized === 'chat'
}

function createRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function toBase64Url(bytes: Uint8Array) {
  let text = ''
  for (const byte of bytes) {
    text += String.fromCharCode(byte)
  }

  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function fromBase64Url(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const text = atob(padded)
  const bytes = new Uint8Array(text.length)

  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index)
  }

  return bytes
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
  return bytesToHex(new Uint8Array(digest))
}

async function generateDeviceIdentity(): Promise<DeviceIdentity> {
  const generated = await window.electronAPI?.app.generateDeviceIdentity()
  if (
    generated &&
    typeof generated.deviceId === 'string' &&
    typeof generated.publicKey === 'string' &&
    typeof generated.privateKey === 'string'
  ) {
    return generated
  }

  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey))

  return {
    deviceId: await sha256Hex(publicKey),
    publicKey: toBase64Url(publicKey),
    privateKey: toBase64Url(privateKey),
  }
}

async function loadDeviceIdentity(): Promise<DeviceIdentity | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return null
  }

  try {
    const raw = window.localStorage.getItem(DEVICE_IDENTITY_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredDeviceIdentity>
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKey === 'string' &&
        typeof parsed.privateKey === 'string'
      ) {
        const nextDeviceId = await sha256Hex(fromBase64Url(parsed.publicKey))
        if (nextDeviceId !== parsed.deviceId) {
          const migrated: StoredDeviceIdentity = {
            version: 1,
            deviceId: nextDeviceId,
            publicKey: parsed.publicKey,
            privateKey: parsed.privateKey,
            createdAtMs: typeof parsed.createdAtMs === 'number' ? parsed.createdAtMs : Date.now(),
          }
          window.localStorage.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(migrated))
          return migrated
        }

        return {
          deviceId: parsed.deviceId,
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
        }
      }
    }
  } catch {
    // ignore corrupted local storage
  }

  const created = await generateDeviceIdentity()
  const stored: StoredDeviceIdentity = {
    version: 1,
    createdAtMs: Date.now(),
    ...created,
  }
  window.localStorage.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(stored))
  return created
}

async function signConnectPayload(privateKey: string, payload: string) {
  const signatureFromElectron = await window.electronAPI?.app.signDevicePayload(privateKey, payload)
  if (typeof signatureFromElectron === 'string' && signatureFromElectron) {
    return signatureFromElectron
  }

  const importedKey = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64Url(privateKey),
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'Ed25519',
    importedKey,
    new TextEncoder().encode(payload),
  )

  return toBase64Url(new Uint8Array(signature))
}

function normalizeRole(role: string) {
  return role.trim().toLowerCase() || CONNECT_ROLE
}

function loadStoredDeviceAuth() {
  try {
    const raw = window.localStorage.getItem(DEVICE_AUTH_STORAGE_KEY)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as Partial<StoredDeviceAuth>
    if (
      parsed?.version !== 1 ||
      typeof parsed.deviceId !== 'string' ||
      !parsed.tokens ||
      typeof parsed.tokens !== 'object'
    ) {
      return null
    }

    return parsed as StoredDeviceAuth
  } catch {
    return null
  }
}

function saveStoredDeviceAuth(nextState: StoredDeviceAuth) {
  try {
    window.localStorage.setItem(DEVICE_AUTH_STORAGE_KEY, JSON.stringify(nextState))
  } catch {
    // ignore storage failure
  }
}

function getStoredDeviceToken(deviceId: string, role: string) {
  const state = loadStoredDeviceAuth()
  if (!state || state.deviceId !== deviceId) {
    return null
  }

  const normalizedRole = normalizeRole(role)
  const tokenState = state.tokens[normalizedRole]
  return tokenState?.token ?? null
}

function persistStoredDeviceToken(input: {
  deviceId: string
  role: string
  token: string
  scopes?: string[]
}) {
  const normalizedRole = normalizeRole(input.role)
  const previous = loadStoredDeviceAuth()
  const nextState: StoredDeviceAuth = {
    version: 1,
    deviceId: input.deviceId,
    tokens: previous?.deviceId === input.deviceId ? { ...previous.tokens } : {},
  }

  nextState.tokens[normalizedRole] = {
    token: input.token,
    role: normalizedRole,
    scopes: input.scopes ?? [],
    updatedAtMs: Date.now(),
  }

  saveStoredDeviceAuth(nextState)
}

function removeStoredDeviceToken(deviceId: string, role: string) {
  const previous = loadStoredDeviceAuth()
  if (!previous || previous.deviceId !== deviceId) {
    return
  }

  const normalizedRole = normalizeRole(role)
  if (!previous.tokens[normalizedRole]) {
    return
  }

  const nextState: StoredDeviceAuth = {
    ...previous,
    tokens: { ...previous.tokens },
  }
  delete nextState.tokens[normalizedRole]
  saveStoredDeviceAuth(nextState)
}

function buildDevicePayloadToSign(input: {
  deviceId: string
  clientId: string
  clientMode: string
  role: string
  scopes: string[]
  signedAtMs: number
  token: string | null
  nonce: string
}) {
  return [
    'v2',
    input.deviceId,
    input.clientId,
    input.clientMode,
    input.role,
    input.scopes.join(','),
    String(input.signedAtMs),
    input.token ?? '',
    input.nonce,
  ].join('|')
}

function extractMessageText(message: any) {
  if (!message) {
    return ''
  }

  if (typeof message.text === 'string') {
    return message.text
  }

  if (!Array.isArray(message.content)) {
    return ''
  }

  return message.content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return ''
      }

      const itemType = String(item.type || '').toLowerCase()
      if (itemType === 'thinking') {
        return ''
      }

      if (typeof item.text === 'string') {
        return item.text
      }

      if (typeof item.content === 'string') {
        return item.content
      }

      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractThinkingText(input: any) {
  if (!input || typeof input !== 'object') {
    return ''
  }

  if (typeof input.thinking === 'string' && input.thinking.trim()) {
    return input.thinking
  }

  if (typeof input.summary === 'string' && input.summary.trim()) {
    return input.summary
  }

  if (String(input.type || '').toLowerCase() === 'thinking') {
    if (typeof input.content === 'string' && input.content.trim()) {
      return input.content
    }

    if (typeof input.text === 'string' && input.text.trim()) {
      return input.text
    }
  }

  if (!Array.isArray(input.content)) {
    return ''
  }

  return input.content
    .map((item: any) => {
      if (!item || typeof item !== 'object') {
        return ''
      }

      const itemType = String(item.type || '').toLowerCase()
      if (itemType !== 'thinking') {
        return ''
      }

      if (typeof item.thinking === 'string') {
        return item.thinking
      }

      if (typeof item.summary === 'string') {
        return item.summary
      }

      if (typeof item.content === 'string') {
        return item.content
      }

      if (typeof item.text === 'string') {
        return item.text
      }

      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractThinkingStreamText(data: Record<string, any>, message?: any) {
  return (
    extractThinkingText(data) ||
    (typeof data.text === 'string' ? data.text : '') ||
    (typeof data.delta === 'string' ? data.delta : '') ||
    extractThinkingText(message)
  )
}

export class OpenClawGatewayClient {
  private url: string
  private token: string
  private clientId: string
  private clientVersion: string
  private mode: string
  private ws: WebSocket | null = null
  private status: GatewayStatus = GATEWAY_STATUS.DISCONNECTED
  private pending = new Map<string, PendingRequest>()
  private connectPromise: Promise<void> | null = null
  private connectResolve: (() => void) | null = null
  private connectReject: ((error?: unknown) => void) | null = null
  private connectNonce: string | null = null
  private connectSent = false
  private connectTimer: number | null = null
  private closed = false
  private onStatusChange: (status: GatewayStatus) => void
  private onMessage: NonNullable<GatewayClientOptions['onMessage']>
  private onError: (error: unknown) => void

  constructor(options: GatewayClientOptions) {
    this.url = options.url
    this.token = options.token
    this.clientId = options.clientId ?? 'openclaw-control-ui'
    this.clientVersion = options.clientVersion ?? '1.0.0'
    this.mode = options.mode ?? 'ui'
    this.onStatusChange = options.onStatusChange ?? (() => {})
    this.onMessage = options.onMessage ?? (() => {})
    this.onError = options.onError ?? (() => {})
  }

  static checkGatewayStatus(url: string) {
    return new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url)
      const timer = window.setTimeout(() => {
        ws.close()
        resolve(false)
      }, 3000)

      ws.onopen = () => {
        window.clearTimeout(timer)
        ws.close()
        resolve(true)
      }

      ws.onerror = () => {
        window.clearTimeout(timer)
        resolve(false)
      }
    })
  }

  getStatus() {
    return this.status
  }

  connect() {
    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
      this.closed = false
      this.setStatus(GATEWAY_STATUS.CONNECTING)
      this.doConnect()
    })

    return this.connectPromise
  }

  disconnect() {
    this.closed = true

    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer)
      this.connectTimer = null
    }

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    for (const [, request] of this.pending) {
      window.clearTimeout(request.timer)
      request.reject(new Error('client stopped'))
    }
    this.pending.clear()

    this.setStatus(GATEWAY_STATUS.DISCONNECTED)
    this.resetConnectPromise()
  }

  async sendChatMessage(message: string, options: { sessionKey: string; idempotencyKey?: string }) {
    return this.request('chat.send', {
      sessionKey: options.sessionKey,
      message,
      deliver: false,
      idempotencyKey:
        options.idempotencyKey ??
        `idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })
  }

  async getChatHistory(options: { sessionKey: string; limit?: number }) {
    return this.request('chat.history', {
      sessionKey: options.sessionKey,
      limit: options.limit ?? 200,
    })
  }

  async getSessionsList(options: {
    limit?: number
    includeGlobal?: boolean
    includeUnknown?: boolean
  } = {}) {
    return this.request('sessions.list', {
      limit: options.limit ?? 120,
      includeGlobal: options.includeGlobal ?? false,
      includeUnknown: options.includeUnknown ?? false,
    })
  }

  async patchSession(sessionKey: string, patch: Record<string, unknown>) {
    return this.request('sessions.patch', {
      key: sessionKey,
      ...patch,
    })
  }

  async deleteSession(sessionKey: string) {
    return this.request('sessions.delete', {
      key: sessionKey,
      deleteTranscript: true,
    })
  }

  async abortChatRun(sessionKey: string, runId?: string | null) {
    return this.request('chat.abort', {
      sessionKey,
      ...(runId ? { runId } : {}),
    })
  }

  private setStatus(status: GatewayStatus) {
    if (this.status === status) {
      return
    }

    this.status = status
    this.onStatusChange(status)
  }

  private resetConnectPromise() {
    this.connectPromise = null
    this.connectResolve = null
    this.connectReject = null
  }

  private doConnect() {
    try {
      this.ws = new WebSocket(this.url)
    } catch (error) {
      this.setStatus(GATEWAY_STATUS.ERROR)
      this.connectReject?.(error)
      this.resetConnectPromise()
      return
    }

    this.ws.onopen = () => {
      this.queueConnect()
    }

    this.ws.onmessage = (event) => {
      this.handleMessage(String(event.data ?? ''))
    }

    this.ws.onerror = (error) => {
      this.onError(error)
    }

    this.ws.onclose = (event) => {
      this.ws = null

      for (const [, request] of this.pending) {
        window.clearTimeout(request.timer)
        request.reject(
          new Error(`gateway closed (${event.code}): ${String(event.reason ?? '') || 'n/a'}`),
        )
      }
      this.pending.clear()

      if (this.status === GATEWAY_STATUS.CONNECTING) {
        this.setStatus(GATEWAY_STATUS.ERROR)
        this.connectReject?.(new Error(String(event.reason ?? '') || '连接失败'))
        this.resetConnectPromise()
      } else {
        this.setStatus(GATEWAY_STATUS.DISCONNECTED)
      }
    }
  }

  private queueConnect() {
    this.connectNonce = null
    this.connectSent = false

    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer)
    }

    this.connectTimer = window.setTimeout(() => {
      void this.sendConnect()
    }, 750)
  }

  private async sendConnect() {
    if (this.connectSent) {
      return
    }

    this.connectSent = true

    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer)
      this.connectTimer = null
    }

    let deviceIdentity: DeviceIdentity | null = null
    let reusedStoredToken = false
    let connectToken = this.token
    let device: Record<string, unknown> | undefined

    if (typeof crypto !== 'undefined' && crypto.subtle) {
      try {
        deviceIdentity = await loadDeviceIdentity()
        const storedToken = deviceIdentity
          ? getStoredDeviceToken(deviceIdentity.deviceId, CONNECT_ROLE)
          : null
        if (storedToken) {
          reusedStoredToken = Boolean(this.token)
          connectToken = storedToken
        }
      } catch (error) {
        console.warn('[OpenClaw] 加载设备身份失败，回退到 token 连接:', error)
        deviceIdentity = null
        reusedStoredToken = false
        connectToken = this.token
      }
    }

    if (deviceIdentity) {
      try {
        const signedAt = Date.now()
        const nonce = this.connectNonce ?? ''
        const payloadToSign = buildDevicePayloadToSign({
          deviceId: deviceIdentity.deviceId,
          clientId: this.clientId,
          clientMode: this.mode,
          role: CONNECT_ROLE,
          scopes: CONNECT_SCOPES,
          signedAtMs: signedAt,
          token: connectToken ?? null,
          nonce,
        })
        const signature = await signConnectPayload(deviceIdentity.privateKey, payloadToSign)

        device = {
          id: deviceIdentity.deviceId,
          publicKey: deviceIdentity.publicKey,
          signature,
          signedAt,
          nonce,
        }
      } catch (error) {
        console.warn('[OpenClaw] 设备签名失败，回退到 token 连接:', error)
        if (reusedStoredToken) {
          removeStoredDeviceToken(deviceIdentity.deviceId, CONNECT_ROLE)
          connectToken = this.token
          reusedStoredToken = false
        }
        deviceIdentity = null
        device = undefined
      }
    }

    const auth = connectToken ? { token: connectToken } : undefined

    try {
      const response = await this.request('connect', {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: this.clientId,
          version: this.clientVersion,
          platform: typeof navigator !== 'undefined' ? navigator.platform : 'web',
          mode: this.mode,
          instanceId: createRequestId(),
        },
        role: CONNECT_ROLE,
        scopes: CONNECT_SCOPES,
        device,
        caps: [],
        auth,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'OpenClaw-Client',
        locale: typeof navigator !== 'undefined' ? navigator.language : 'zh-CN',
      })

      const deviceToken = response?.auth?.deviceToken
      if (deviceIdentity && typeof deviceToken === 'string' && deviceToken) {
        persistStoredDeviceToken({
          deviceId: deviceIdentity.deviceId,
          role: response?.auth?.role ?? CONNECT_ROLE,
          token: deviceToken,
          scopes: Array.isArray(response?.auth?.scopes) ? response.auth.scopes : [],
        })
      }

      this.setStatus(GATEWAY_STATUS.CONNECTED)
      this.connectResolve?.()
      this.resetConnectPromise()
    } catch (error) {
      if (reusedStoredToken && deviceIdentity) {
        removeStoredDeviceToken(deviceIdentity.deviceId, CONNECT_ROLE)
      }

      this.setStatus(GATEWAY_STATUS.ERROR)
      this.connectReject?.(error)
      this.resetConnectPromise()

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(4008, 'connect failed')
      }
    }
  }

  private handleMessage(raw: string) {
    let message: any
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }

    if ((message.type === 'event' || message.event) && shouldLogGatewayEvent(message.event)) {
      debugGatewayLog('ws-event', {
        event: message.event,
        type: message.type,
        state: message.payload?.state,
        stream: message.payload?.stream,
        runId: message.payload?.runId,
        sessionKey: message.payload?.sessionKey,
        dataKeys: Object.keys(message.payload?.data || {}),
        messageContentTypes: getMessageContentTypes(message.payload?.message),
        rawPreview: truncateDebugText(raw, 1200),
      })
    }

    if (message.type === 'event' || message.event) {
      this.handleEvent(message)
      return
    }

    if (message.type === 'res') {
      this.handleResponse(message)
    }
  }

  private handleEvent(event: { event?: string; payload?: ChatEventPayload }) {
    const eventName = event.event
    const payload = event.payload

    if (eventName === 'connect.challenge') {
      this.connectNonce = payload?.nonce ?? payload?.message?.nonce ?? null
      void this.sendConnect()
      return
    }

    if (!payload) {
      return
    }

    if (eventName === 'agent') {
      const stream = payload.stream
      const data = payload.data || {}

      if (stream === 'thinking') {
        const text = extractThinkingStreamText(data, payload.message)
        const delta = typeof data.delta === 'string' ? data.delta : text

        debugGatewayLog('emit-thinking', {
          source: 'agent.thinking',
          runId: payload.runId,
          sessionKey: payload.sessionKey,
          textLength: text.length,
          deltaLength: delta.length,
          preview: truncateDebugText(text || delta, 300),
          dataKeys: Object.keys(data),
          messageContentTypes: getMessageContentTypes(payload.message),
        })

        this.onMessage({
          runId: payload.runId,
          sessionKey: payload.sessionKey,
          state: 'thinking',
          text,
          delta,
          role: 'assistant',
          message: {
            role: 'assistant',
            text,
          },
        })
        return
      }

      if (stream === 'assistant') {
        const thinkingText = extractThinkingText(data) || extractThinkingText(payload.message)
        debugGatewayLog('agent-assistant-parsed', {
          runId: payload.runId,
          sessionKey: payload.sessionKey,
          thinkingLength: thinkingText.length,
          textLength:
            (
              extractMessageText(data) ||
              extractMessageText(payload.message) ||
              (typeof data.text === 'string'
                ? data.text
                : typeof data.delta === 'string'
                  ? data.delta
                  : '')
            ).length,
          dataKeys: Object.keys(data),
          messageContentTypes: getMessageContentTypes(payload.message),
          thinkingPreview: truncateDebugText(thinkingText, 300),
        })

        if (thinkingText) {
          this.onMessage({
            runId: payload.runId,
            sessionKey: payload.sessionKey,
            state: 'thinking',
            text: thinkingText,
            delta: thinkingText,
            role: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: thinkingText,
                },
              ],
            },
          })
        }

        const text =
          extractMessageText(data) ||
          extractMessageText(payload.message) ||
          (typeof data.text === 'string'
            ? data.text
            : typeof data.delta === 'string'
              ? data.delta
              : '')
        const delta = typeof data.delta === 'string' ? data.delta : text

        if (text) {
          debugGatewayLog('emit-delta', {
            source: 'agent.assistant',
            runId: payload.runId,
            sessionKey: payload.sessionKey,
            textLength: text.length,
            deltaLength: delta.length,
            preview: truncateDebugText(text || delta, 300),
          })

          this.onMessage({
            runId: payload.runId,
            sessionKey: payload.sessionKey,
            state: 'delta',
            text,
            delta,
            role: 'assistant',
            message: {
              role: 'assistant',
              text,
            },
          })
        }
        return
      }

      if (stream === 'tool') {
        const toolCallId = data.toolCallId || data.tool_call_id
        const toolName = data.name || data.toolName || data.tool_name
        const toolArgs = data.args || data.toolArgs || data.tool_args
        const toolOutput = data.result || data.text || data.toolOutput || data.tool_output
        const phase = data.phase || data.toolStreamPhase

        debugGatewayLog('emit-tool-stream', {
          runId: payload.runId,
          sessionKey: payload.sessionKey,
          toolCallId,
          toolName,
          phase,
          hasOutput: !!toolOutput,
          outputPreview: truncateDebugText(toolOutput, 300),
        })

        this.onMessage({
          runId: payload.runId,
          sessionKey: payload.sessionKey,
          state: 'tool_stream',
          text: '',
          toolCallId,
          toolName,
          toolArgs,
          toolOutput,
          toolStreamPhase: phase,
          message: {
            role: 'assistant',
            content: [
              ...(toolCallId && toolName
                ? [
                    {
                      type: 'tool_use',
                      name: toolName,
                      arguments: toolArgs || {},
                      toolCallId,
                    },
                  ]
                : []),
              ...(toolCallId && toolName && toolOutput
                ? [
                    {
                      type: 'tool_result',
                      name: toolName,
                      text: toolOutput,
                      toolCallId,
                    },
                  ]
                : []),
            ],
          },
        })
        return
      }

      if (stream === 'lifecycle' && data.phase === 'error') {
        debugGatewayLog('emit-error', {
          source: 'agent.lifecycle',
          runId: payload.runId,
          sessionKey: payload.sessionKey,
          error: truncateDebugText(
            (typeof data.error === 'string' && data.error) ||
              (typeof data.message === 'string' && data.message) ||
              '发生错误',
            300,
          ),
        })

        this.onMessage({
          runId: payload.runId,
          sessionKey: payload.sessionKey,
          state: 'error',
          text:
            (typeof data.error === 'string' && data.error) ||
            (typeof data.message === 'string' && data.message) ||
            '发生错误',
          error: true,
        })
      }

      return
    }

    if (eventName !== 'chat') {
      return
    }

    if (payload.state === 'error') {
      debugGatewayLog('emit-error', {
        source: 'chat.error',
        runId: payload.runId,
        sessionKey: payload.sessionKey,
        error: truncateDebugText(payload.errorMessage || '发生错误', 300),
      })

      this.onMessage({
        runId: payload.runId,
        sessionKey: payload.sessionKey,
        state: 'error',
        text: payload.errorMessage || '发生错误',
        error: true,
      })
      return
    }

    if (payload.state === 'aborted') {
      debugGatewayLog('emit-aborted', {
        runId: payload.runId,
        sessionKey: payload.sessionKey,
      })

      this.onMessage({
        runId: payload.runId,
        sessionKey: payload.sessionKey,
        state: 'aborted',
        text: '',
        aborted: true,
      })
      return
    }

    if (payload.state === 'tool_stream') {
      const toolCallId = payload.toolCallId
      const toolName = payload.toolName || payload.message?.toolName || payload.message?.tool_name
      const toolArgs = payload.toolArgs || payload.message?.toolArgs || payload.message?.tool_args
      const toolOutput =
        payload.toolOutput ||
        payload.message?.toolOutput ||
        payload.message?.tool_output ||
        extractMessageText(payload.message)

      const syntheticContent: any[] = []
      if (toolCallId && toolName) {
        syntheticContent.push({
          type: 'tool_use',
          name: toolName,
          arguments: toolArgs || {},
          toolCallId,
        })
      }
      if (toolCallId && toolName && toolOutput) {
        syntheticContent.push({
          type: 'tool_result',
          name: toolName,
          text: toolOutput,
          toolCallId,
        })
      }

      debugGatewayLog('emit-tool-stream', {
        source: 'chat.tool_stream',
        runId: payload.runId,
        sessionKey: payload.sessionKey,
        toolCallId,
        toolName,
        phase: payload.toolStreamPhase,
        hasOutput: !!toolOutput,
        outputPreview: truncateDebugText(toolOutput, 300),
      })

      this.onMessage({
        runId: payload.runId,
        sessionKey: payload.sessionKey,
        state: 'tool_stream',
        text: '',
        toolCallId,
        toolName,
        toolArgs,
        toolOutput,
        toolStreamPhase: payload.toolStreamPhase,
        message:
          syntheticContent.length > 0
            ? {
                role: payload.role || 'assistant',
                content: syntheticContent,
              }
            : payload.message,
      })
      return
    }

    const thinkingText = extractThinkingText(payload.message)
    if (thinkingText) {
      debugGatewayLog('emit-thinking', {
        source: `chat.${payload.state || 'delta'}`,
        runId: payload.runId,
        sessionKey: payload.sessionKey,
        textLength: thinkingText.length,
        preview: truncateDebugText(thinkingText, 300),
        messageContentTypes: getMessageContentTypes(payload.message),
      })

      this.onMessage({
        runId: payload.runId,
        sessionKey: payload.sessionKey,
        state: 'thinking',
        text: thinkingText,
        delta: thinkingText,
        role: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: thinkingText,
            },
          ],
        },
      })

      if (payload.state === 'thinking') {
        return
      }
    }

    const text = extractMessageText(payload.message)
    debugGatewayLog('emit-chat-message', {
      source: `chat.${payload.state || 'delta'}`,
      runId: payload.runId,
      sessionKey: payload.sessionKey,
      textLength: text.length,
      deltaLength: typeof payload.delta === 'string' ? payload.delta.length : 0,
      preview: truncateDebugText(text || payload.delta || '', 300),
      messageContentTypes: getMessageContentTypes(payload.message),
    })
    this.onMessage({
      runId: payload.runId,
      sessionKey: payload.sessionKey,
      state: payload.state || 'delta',
      text,
      message: payload.message,
      delta: payload.delta,
      role: payload.role || payload.message?.role,
    })
  }

  private handleResponse(response: {
    id: string
    ok: boolean
    payload?: any
    error?: { message?: string }
  }) {
    const request = this.pending.get(response.id)
    if (!request) {
      return
    }

    this.pending.delete(response.id)
    window.clearTimeout(request.timer)

    if (GATEWAY_DEBUGGED_METHODS.has(request.method)) {
      debugGatewayLog('request-response', {
        method: request.method,
        ok: response.ok,
        responseKeys: Object.keys(response.payload || {}),
        error: response.error?.message,
        payloadPreview: truncateDebugText(JSON.stringify(response.payload || {}), 500),
      })
    }

    if (response.ok) {
      request.resolve(response.payload)
      return
    }

    request.reject(new Error(response.error?.message || '请求失败'))
  }

  private request(method: string, params: Record<string, unknown>) {
    return new Promise<any>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket 未连接'))
        return
      }

      const id = createRequestId()
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('请求超时'))
      }, 30_000)

      if (GATEWAY_DEBUGGED_METHODS.has(method)) {
        debugGatewayLog('request-send', {
          method,
          paramsPreview: truncateDebugText(JSON.stringify(params), 600),
        })
      }

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
      })

      this.ws.send(
        JSON.stringify({
          type: 'req',
          id,
          method,
          params,
        }),
      )
    })
  }
}
