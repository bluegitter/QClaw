import { app, ipcMain, shell, BrowserWindow, dialog } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join, basename } from 'path'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { createHash, randomBytes, randomUUID, createPrivateKey, generateKeyPairSync, sign } from 'crypto'
import { openclawLogger } from '../common/logger.js'
import pkg from 'node-machine-id'
const { machineId } = pkg
import { getProcessManager, getConfigPath } from '../openclaw/index.js'
import { ConfigManager, willTriggerRestart } from '../server/index.js'
import { readConfigFileSync, writeConfigFile } from '../common/config-file.js'
import { LOG_BUFFER_CAPACITY } from '../constants.js'
import { OPENCLAW_DEFAULT_GATEWAY_PORT, OPENCLAW_CONFIG_PATH } from '../openclaw/constants.js'
import { getBundledSkillsDir, getDefaultConfigSourcePath, getManagedSkillsDir } from '../openclaw/paths.js'
import { inspectSkillDirectory, listBundledSkills } from '../openclaw/skill-selection.js'
import { importSkillFromGitHub, removeManagedSkill } from '../openclaw/skill-installer.js'
import { LOCALHOST_ADDRESS } from '../common/constants.js'
import { getChannelFilePath } from '../common/resource-paths.js'
import { checkHealthWithRetry } from '../server/health-check.js'
import type {
  ProcessStatus,
  LogEvent,
  OpenClawConfig,
  ConfigUpdateResult,
  InstanceMode,
  InstanceBootState,
  RumEvent
} from '@guanjia-openclaw/shared'
import { getBootState, initializeWithMode, retryBootSequence } from '../openclaw/boot.js'
import { rumReport } from '../reporting/rum-reporter.js'
import { RUM_FROM_RENDERER } from '../reporting/constants.js'
import { getStoreManager } from '../server/store/index.js'

/** 日志缓冲区，解决渲染进程启动晚于服务启动导致的日志丢失 */
const logBuffer: LogEvent[] = []
const OPENAI_CODEX_OAUTH_CLIENT_ID = 'codex_cli_simplified_flow'
const OPENAI_CODEX_OAUTH_AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const OPENAI_CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_CODEX_OAUTH_SCOPE = 'openid profile email offline_access'
const OPENAI_CODEX_OAUTH_TIMEOUT_MS = 120000
const SKILL_SELECTION_STORE_KEY = 'skills.selection.enabledIds'

interface OpenAICodexOauthResult {
  accessToken: string
  refreshToken: string
  idToken: string
  accountId: string
  email: string
  expiresAt: string
}

interface CodexAuthResult {
  accessToken: string
  accountId: string
  email: string
  expiresAt: string
  authMode: string
  lastRefresh: string
  sourcePath: string
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function createPkceVerifier(): string {
  return base64UrlEncode(randomBytes(32))
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

function deriveEd25519PublicKeyRaw(publicKeyDer: Buffer): Buffer {
  if (
    publicKeyDer.length === ED25519_SPKI_PREFIX.length + 32 &&
    publicKeyDer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return publicKeyDer.subarray(ED25519_SPKI_PREFIX.length)
  }

  return publicKeyDer
}

function normalizeEd25519PrivateKeyDer(privateKey: Buffer): Buffer {
  if (privateKey.length === 32) {
    return Buffer.concat([ED25519_PKCS8_SEED_PREFIX, privateKey])
  }

  return privateKey
}

function createPkceChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest())
}

function parseJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length < 2 || !parts[1]) {
    throw new Error('Invalid JWT token')
  }

  const normalized = parts[1]
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')

  return JSON.parse(Buffer.from(normalized, 'base64').toString('utf-8')) as Record<string, unknown>
}

function buildOauthResult(tokenResponse: {
  access_token?: string
  refresh_token?: string
  id_token?: string
}): OpenAICodexOauthResult {
  if (!tokenResponse.access_token || !tokenResponse.refresh_token || !tokenResponse.id_token) {
    throw new Error('OAuth token response is incomplete')
  }

  const claims = parseJwtPayload(tokenResponse.id_token)
  const authClaims = claims['https://api.openai.com/auth']
  const authPayload =
    authClaims && typeof authClaims === 'object'
      ? (authClaims as Record<string, unknown>)
      : null

  if (!authPayload) {
    throw new Error("JWT payload missing expected 'https://api.openai.com/auth' object")
  }

  const email = typeof claims.email === 'string' ? claims.email : ''
  const accountId =
    typeof authPayload.chatgpt_account_id === 'string'
      ? authPayload.chatgpt_account_id
      : typeof authPayload.account_id === 'string'
        ? authPayload.account_id
        : ''

  const expiresAt =
    typeof claims.exp === 'number'
      ? new Date(claims.exp * 1000).toISOString()
      : new Date(Date.now() + 3600_000).toISOString()

  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    idToken: tokenResponse.id_token,
    accountId,
    email,
    expiresAt,
  }
}

function buildCodexAuthResult(authPayload: Record<string, unknown>, sourcePath: string): CodexAuthResult {
  const authMode = typeof authPayload.auth_mode === 'string' ? authPayload.auth_mode : ''
  const lastRefresh = typeof authPayload.last_refresh === 'string' ? authPayload.last_refresh : ''
  const tokens =
    authPayload.tokens && typeof authPayload.tokens === 'object'
      ? (authPayload.tokens as Record<string, unknown>)
      : null

  const accessToken = tokens && typeof tokens.access_token === 'string' ? tokens.access_token : ''
  if (!accessToken) {
    throw new Error('Codex auth.json 中缺少 access token')
  }

  const claims = parseJwtPayload(accessToken)
  const audience = claims.aud
  const audienceList = Array.isArray(audience) ? audience : [audience]
  const hasOpenAIAudience = audienceList.some(
    (item) => typeof item === 'string' && item.startsWith('https://api.openai.com/'),
  )

  if (!hasOpenAIAudience) {
    throw new Error('Codex token 不包含 OpenAI API 访问权限')
  }

  const authClaims = claims['https://api.openai.com/auth']
  const authInfo =
    authClaims && typeof authClaims === 'object'
      ? (authClaims as Record<string, unknown>)
      : null

  const expiresAt =
    typeof claims.exp === 'number'
      ? new Date(claims.exp * 1000).toISOString()
      : ''

  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    throw new Error('Codex token 已过期，请先重新登录 Codex')
  }

  return {
    accessToken,
    accountId:
      typeof authInfo?.chatgpt_account_id === 'string'
        ? authInfo.chatgpt_account_id
        : typeof authInfo?.account_id === 'string'
          ? authInfo.account_id
          : '',
    email: typeof claims.email === 'string' ? claims.email : '',
    expiresAt,
    authMode,
    lastRefresh,
    sourcePath,
  }
}

function readCodexAuth(): CodexAuthResult {
  const sourcePath = join(app.getPath('home'), '.codex', 'auth.json')
  const raw = readFileSync(sourcePath, 'utf-8')
  const payload = JSON.parse(raw) as Record<string, unknown>
  return buildCodexAuthResult(payload, sourcePath)
}

function readCodexModels(): string[] {
  const sourcePath = join(app.getPath('home'), '.codex', 'models_cache.json')
  const raw = readFileSync(sourcePath, 'utf-8')
  const payload = JSON.parse(raw) as { models?: Array<{ slug?: string; supported_in_api?: boolean; visibility?: string }> }
  const models = Array.isArray(payload.models) ? payload.models : []
  return models
    .filter((model) => model?.supported_in_api !== false && (model?.visibility ?? 'list') === 'list')
    .map((model) => model?.slug || '')
    .filter((slug) => Boolean(slug))
}

async function exchangeOpenAICodexAuthorizationCode({
  code,
  redirectUri,
  codeVerifier,
}: {
  code: string
  redirectUri: string
  codeVerifier: string
}): Promise<OpenAICodexOauthResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  })

  const response = await fetch(OPENAI_CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!response.ok) {
    throw new Error(`Token endpoint returned status ${response.status}`)
  }

  const payload = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    id_token?: string
  }

  return buildOauthResult(payload)
}

function renderOpenAICodexOauthPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f7f8fb; color: #111; }
      .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
      .card { width: min(460px, 100%); padding: 28px 24px; border-radius: 20px; background: #fff; box-shadow: 0 12px 40px rgba(0,0,0,.08); text-align: center; }
      h1 { margin: 0 0 12px; font-size: 20px; }
      p { margin: 0; line-height: 1.6; color: #666; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>${title}</h1>
        <p>${message}</p>
      </div>
    </div>
  </body>
</html>`
}

async function startOpenAICodexOauthLogin(): Promise<OpenAICodexOauthResult> {
  throw new Error('当前版本暂不支持 OpenAI 网页 OAuth 登录，请改用 OpenAI API Key。')

  const state = randomUUID()
  const codeVerifier = createPkceVerifier()
  const codeChallenge = createPkceChallenge(codeVerifier)

  return new Promise<OpenAICodexOauthResult>((resolve, reject) => {
    let settled = false
    let timeoutId: NodeJS.Timeout | null = null

    const server = createServer((request, response) => {
      void (async () => {
        try {
          const requestUrl = new URL(request.url || '/', 'http://localhost')

          if (requestUrl.pathname !== '/auth/callback') {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            response.end('Not Found')
            return
          }

          const requestState = requestUrl.searchParams.get('state') || ''
          const code = requestUrl.searchParams.get('code') || ''
          const error = requestUrl.searchParams.get('error') || ''
          const errorDescription = requestUrl.searchParams.get('error_description') || ''

          if (error) {
            throw new Error(errorDescription || error)
          }

          if (requestState !== state) {
            throw new Error('State mismatch')
          }

          if (!code) {
            throw new Error('Missing authorization code')
          }

          const address = server.address() as AddressInfo | null
          if (!address?.port) {
            throw new Error('Unable to determine the server port')
          }

          const redirectUri = `http://localhost:${address.port}/auth/callback`
          const oauthResult = await exchangeOpenAICodexAuthorizationCode({
            code,
            redirectUri,
            codeVerifier,
          })

          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(renderOpenAICodexOauthPage('登录成功', 'OpenAI Codex OAuth 已完成，你可以回到 QClaw 继续配置。'))

          if (!settled) {
            settled = true
            if (timeoutId) {
              clearTimeout(timeoutId)
            }
            server.close()
            resolve(oauthResult)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end(renderOpenAICodexOauthPage('登录失败', message))

          if (!settled) {
            settled = true
            if (timeoutId) {
              clearTimeout(timeoutId)
            }
            server.close()
            reject(new Error(message))
          }
        }
      })()
    })

    server.listen(0, '127.0.0.1', async () => {
      try {
        const address = server.address() as AddressInfo | null
        if (!address?.port) {
          throw new Error('Unable to determine the server port')
        }

        const redirectUri = `http://localhost:${address.port}/auth/callback`
        const authUrl = new URL(OPENAI_CODEX_OAUTH_AUTH_URL)
        authUrl.searchParams.set('response_type', 'code')
        authUrl.searchParams.set('client_id', OPENAI_CODEX_OAUTH_CLIENT_ID)
        authUrl.searchParams.set('redirect_uri', redirectUri)
        authUrl.searchParams.set('scope', OPENAI_CODEX_OAUTH_SCOPE)
        authUrl.searchParams.set('code_challenge', codeChallenge)
        authUrl.searchParams.set('code_challenge_method', 'S256')
        authUrl.searchParams.set('id_token_add_organizations', 'true')
        authUrl.searchParams.set('state', state)

        await shell.openExternal(authUrl.toString())

        timeoutId = setTimeout(() => {
          if (settled) {
            return
          }
          settled = true
          server.close()
          reject(new Error('Login timed out'))
        }, OPENAI_CODEX_OAUTH_TIMEOUT_MS)
      } catch (error) {
        if (!settled) {
          settled = true
          server.close()
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })

    server.on('error', (error) => {
      if (!settled) {
        settled = true
        if (timeoutId) {
          clearTimeout(timeoutId)
        }
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

function pushLogBuffer(log: LogEvent): void {
  logBuffer.push(log)
  if (logBuffer.length > LOG_BUFFER_CAPACITY) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_CAPACITY)
  }
}

/** 为窗口注册最大化/取消最大化事件转发 */
function setupWindowMaximizeEvents(window: BrowserWindow): void {
  window.on('maximize', () => {
    if (!window.isDestroyed()) {
      window.webContents.send('window:maximizeChange', true)
    }
  })
  window.on('unmaximize', () => {
    if (!window.isDestroyed()) {
      window.webContents.send('window:maximizeChange', false)
    }
  })
}

/** 向所有已就绪窗口广播 IPC 消息 */
function broadcastToWindows(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, ...args)
    }
  }
}

/**
 * 设置所有 IPC 处理器
 * 纯注册层：只负责 IPC 通道绑定，业务逻辑在 server/ 模块中
 */
/**
 * 获取基于运行时 configPath 的 ConfigManager（单例）
 * ProcessManager 初始化后 runtimeConfig 才可用，因此延迟创建
 * 单例保证 writeLock 在所有调用间共享，防止并发写入丢失更新
 */
let configManagerInstance: ConfigManager | null = null

function getConfigManager(): ConfigManager {
  if (!configManagerInstance) {
    const runtimeConfig = getProcessManager().getRuntimeConfig()
    configManagerInstance = new ConfigManager({
      configPath: runtimeConfig?.configPath ?? OPENCLAW_CONFIG_PATH,
      defaultGatewayPort: OPENCLAW_DEFAULT_GATEWAY_PORT,
      templatePath: getDefaultConfigSourcePath(),
    })
  }
  return configManagerInstance
}

/** 处理下载响应流，写入文件并广播进度 */
function handleDownloadResponse(
  response: import('http').IncomingMessage,
  filePath: string,
  sender: Electron.WebContents,
  resolve: (value: string) => void,
  reject: (reason: Error) => void,
): void {
  if (response.statusCode && response.statusCode >= 400) {
    reject(new Error(`HTTP ${response.statusCode}`))
    return
  }

  const totalBytes = parseInt(response.headers['content-length'] || '0', 10)
  let receivedBytes = 0
  const fileStream = createWriteStream(filePath)

  response.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length
    if (totalBytes > 0 && !sender.isDestroyed()) {
      const percent = Math.round((receivedBytes / totalBytes) * 100)
      sender.send('app:downloadProgress', percent)
    }
  })

  response.pipe(fileStream)

  fileStream.on('finish', () => {
    fileStream.close()
    if (!sender.isDestroyed()) {
      sender.send('app:downloadProgress', 100)
    }
    resolve(filePath)
  })

  fileStream.on('error', (err: Error) => {
    fileStream.close()
    reject(err)
  })
}

export function setupIpcHandlers(): void {
  const processManager = getProcessManager()

  // ==================== 窗口控制 ====================

  ipcMain.handle('window:minimize', async (event: IpcMainInvokeEvent): Promise<void> => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle('window:maximize', async (event: IpcMainInvokeEvent): Promise<void> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize()
      } else {
        win.maximize()
      }
    }
  })

  ipcMain.handle('window:close', async (event: IpcMainInvokeEvent): Promise<void> => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('window:isMaximized', async (event: IpcMainInvokeEvent): Promise<boolean> => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  // 窗口最大化状态变更事件 - 监听新创建的窗口
  app.on('browser-window-created', (_event, window) => {
    setupWindowMaximizeEvents(window)
  })

  // ==================== 进程管理 ====================

  ipcMain.handle('process:start', async (
    _event: IpcMainInvokeEvent,
    options?: { verbose?: boolean }
  ): Promise<void> => {
    return processManager.start(options)
  })

  ipcMain.handle('process:stop', async (): Promise<void> => {
    return processManager.stop()
  })

  ipcMain.handle('process:restart', async (): Promise<void> => {
    return processManager.restart()
  })

  ipcMain.handle('process:getStatus', async (): Promise<ProcessStatus> => {
    return processManager.getStatus()
  })

  // 渲染进程就绪后主动拉取缓冲日志
  ipcMain.handle('process:getLogs', async (): Promise<LogEvent[]> => {
    return [...logBuffer]
  })

  // 在外部浏览器中打开 OpenClaw Control UI
  ipcMain.handle('process:openControlUI', async (): Promise<void> => {
    try {
      const configPath = getConfigPath()
      const config = readConfigFileSync<{
        gateway?: { port?: number; auth?: { token?: string } }
      }>(configPath)
      const token = config.gateway?.auth?.token ?? ''
      const port = config.gateway?.port ?? OPENCLAW_DEFAULT_GATEWAY_PORT
      await shell.openExternal(`http://${LOCALHOST_ADDRESS}:${port}#token=${token}`)
    } catch (err) {
      openclawLogger.error('Failed to open Control UI:', err)
    }
  })

  // 进程状态变更事件 - 转发到所有窗口
  processManager.onStatusChange((status: ProcessStatus) => {
    broadcastToWindows('process:status', status)
  })

  // 日志事件 - 写入缓冲并转发到所有窗口，同时写入 openclaw 日志文件
  processManager.onLog((log: LogEvent) => {
    pushLogBuffer(log)
    broadcastToWindows('process:log', log)
    // 写入 openclaw/{date}.log
    const level = log.level === 'warn' ? 'warn' : log.level === 'error' ? 'error' : 'info'
    openclawLogger[level](log.message)
  })

  // ==================== 配置管理 ====================

  ipcMain.handle('config:getField', async (
    _event: IpcMainInvokeEvent,
    keyPath: string
  ): Promise<unknown> => {
    return getConfigManager().getField(keyPath)
  })

  ipcMain.handle('config:updateField', async (
    _event: IpcMainInvokeEvent,
    partialConfig: Partial<OpenClawConfig>
  ): Promise<ConfigUpdateResult> => {
    const configManager = getConfigManager()
    const pm = getProcessManager()
    const status = pm.getStatus()

    // 判断此次配置变更是否会触发 OpenClaw gateway in-process restart
    const triggersRestart = status.status === 'running'
      && willTriggerRestart(partialConfig as Record<string, unknown>)

    if (!triggersRestart) {
      // 不触发重启，直接写入配置
      return configManager.updateField(partialConfig)
    }

    // 配置变更将触发 OpenClaw in-process restart，需要协调 Supervisor
    openclawLogger.info('[IPC] Config change will trigger OpenClaw in-process restart, pausing health checks')

    // 1. 暂停 Supervisor 健康检查，避免重启窗口期内误判为假死
    pm.pauseHealthCheck()

    try {
      // 2. 写入配置（触发 OpenClaw chokidar → in-process restart）
      const result = await configManager.updateField(partialConfig)

      if (!result.success) {
        pm.resumeHealthCheck()
        return result
      }

      // 3. 等待 OpenClaw 完成 in-process restart 并恢复健康
      const port = status.port
      const isHealthy = await checkHealthWithRetry({
        port,
        retries: 30,
        retryDelay: 1000,
        timeout: 5000,
      })

      // 4. 恢复 Supervisor 健康检查
      pm.resumeHealthCheck()

      if (isHealthy) {
        openclawLogger.info('[IPC] OpenClaw in-process restart completed, service healthy')
      return {
        ...result,
        message: '配置已更新，服务已重新加载',
          serviceRestarted: true,
        }
      } else {
        openclawLogger.warn('[IPC] OpenClaw did not become healthy after config restart')
        return {
          ...result,
          message: '配置已更新，但服务可能仍在重启中',
          serviceRestarted: true,
        }
      }
    } catch (error) {
      // 确保异常情况下健康检查也能恢复
      pm.resumeHealthCheck()
      throw error
    }
  })

  ipcMain.handle('config:replaceProvider', async (
    _event: IpcMainInvokeEvent,
    providerKey: string,
    providerConfig: Record<string, unknown>,
    primaryModel: string
  ): Promise<ConfigUpdateResult> => {
    try {
      const configPath = getConfigPath()
      const currentConfig = readConfigFileSync<Record<string, unknown>>(configPath)

      const models =
        currentConfig.models && typeof currentConfig.models === 'object'
          ? currentConfig.models as Record<string, unknown>
          : ((currentConfig.models = {}), currentConfig.models as Record<string, unknown>)

      const providers =
        models.providers && typeof models.providers === 'object'
          ? models.providers as Record<string, unknown>
          : ((models.providers = {}), models.providers as Record<string, unknown>)

      providers[providerKey] = providerConfig

      const agents =
        currentConfig.agents && typeof currentConfig.agents === 'object'
          ? currentConfig.agents as Record<string, unknown>
          : ((currentConfig.agents = {}), currentConfig.agents as Record<string, unknown>)

      const defaults =
        agents.defaults && typeof agents.defaults === 'object'
          ? agents.defaults as Record<string, unknown>
          : ((agents.defaults = {}), agents.defaults as Record<string, unknown>)

      const model =
        defaults.model && typeof defaults.model === 'object'
          ? defaults.model as Record<string, unknown>
          : ((defaults.model = {}), defaults.model as Record<string, unknown>)

      model.primary = primaryModel

      await writeConfigFile(configPath, currentConfig)

      return {
        success: true,
        config: currentConfig as OpenClawConfig,
        message: '配置已更新',
        serviceRestarted: false,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '配置更新失败'
      return {
        success: false,
        config: {} as OpenClawConfig,
        message: `配置更新失败: ${message}`,
        serviceRestarted: false,
        error: message,
      }
    }
  })

  // ==================== 应用级 API ====================

  ipcMain.handle('app:get-machine-id', async (): Promise<string> => {
    return machineId()
  })

  ipcMain.handle('app:get-version', async (): Promise<string> => {
    return app.getVersion()
  })

  ipcMain.handle('app:get-channel', async (): Promise<string> => {
    try {
      const channelPath = getChannelFilePath()
      const content = readFileSync(channelPath, 'utf-8')
      const data = JSON.parse(content) as { channel?: number }
      return String(data.channel ?? '')
    } catch {
      return ''
    }
  })

  ipcMain.handle('app:generate-device-identity', async (): Promise<{
    deviceId: string
    publicKey: string
    privateKey: string
  }> => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyDer = publicKey.export({
      type: 'spki',
      format: 'der',
    }) as Buffer
    const privateKeyDer = privateKey.export({
      type: 'pkcs8',
      format: 'der',
    }) as Buffer
    const publicKeyRaw = deriveEd25519PublicKeyRaw(publicKeyDer)

    return {
      deviceId: createHash('sha256').update(publicKeyRaw).digest('hex'),
      publicKey: base64UrlEncode(publicKeyRaw),
      privateKey: base64UrlEncode(privateKeyDer),
    }
  })

  ipcMain.handle('app:sign-device-payload', async (
    _event: IpcMainInvokeEvent,
    privateKey: string,
    payload: string,
  ): Promise<string> => {
    const keyObject = createPrivateKey({
      key: normalizeEd25519PrivateKeyDer(base64UrlDecode(privateKey)),
      format: 'der',
      type: 'pkcs8',
    })

    return base64UrlEncode(sign(null, Buffer.from(payload, 'utf-8'), keyObject))
  })

  ipcMain.handle('app:getSkillCatalog', async () => {
    return listBundledSkills(getBundledSkillsDir(), getManagedSkillsDir())
  })

  ipcMain.handle('app:inspectSkillDirectory', async (
    _event: IpcMainInvokeEvent,
    dirPath: string,
  ) => {
    return inspectSkillDirectory(dirPath, getBundledSkillsDir(), getManagedSkillsDir())
  })

  ipcMain.handle('app:selectSkillDirectory', async (
    event: IpcMainInvokeEvent,
  ) => {
    const currentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(currentWindow, {
      title: '选择技能目录',
      properties: ['openDirectory'],
      buttonLabel: '导入技能',
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return inspectSkillDirectory(result.filePaths[0]!, getBundledSkillsDir(), getManagedSkillsDir())
  })

  ipcMain.handle('app:getManagedSkillsRoot', async () => {
    const managedSkillsDir = getManagedSkillsDir()
    if (!existsSync(managedSkillsDir)) {
      mkdirSync(managedSkillsDir, { recursive: true })
    }
    return managedSkillsDir
  })

  ipcMain.handle('app:getSelectedSkillIds', async () => {
    const store = getStoreManager()
    const value = store.get<unknown>(SKILL_SELECTION_STORE_KEY)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  })

  ipcMain.handle('app:setSelectedSkillIds', async (
    _event: IpcMainInvokeEvent,
    skillIds: string[],
  ) => {
    const store = getStoreManager()
    store.set(
      SKILL_SELECTION_STORE_KEY,
      Array.isArray(skillIds) ? skillIds.filter((item): item is string => typeof item === 'string') : [],
    )
    return { success: true }
  })

  ipcMain.handle('app:importSkillFromGitHub', async (
    _event: IpcMainInvokeEvent,
    repoUrl: string,
  ) => {
    return importSkillFromGitHub(repoUrl, getManagedSkillsDir(), getBundledSkillsDir())
  })

  ipcMain.handle('app:removeManagedSkill', async (
    _event: IpcMainInvokeEvent,
    skillId: string,
  ) => {
    return removeManagedSkill(skillId, getManagedSkillsDir())
  })

  ipcMain.handle('app:get-codex-auth', async (): Promise<CodexAuthResult> => {
    return readCodexAuth()
  })

  ipcMain.handle('app:get-codex-models', async (): Promise<string[]> => {
    return readCodexModels()
  })

  ipcMain.handle('app:loginOpenAICodex', async (): Promise<OpenAICodexOauthResult> => {
    return startOpenAICodexOauthLogin()
  })

  ipcMain.handle('app:openPath', async (
    _event: IpcMainInvokeEvent,
    filePath: string
  ): Promise<string> => {
    return shell.openPath(filePath)
  })

  ipcMain.handle('app:quit', async (): Promise<void> => {
    app.quit()
  })

  ipcMain.handle('app:downloadFile', async (
    event: IpcMainInvokeEvent,
    url: string,
    fileName?: string
  ): Promise<string> => {
    const downloadsDir = app.getPath('downloads')
    if (!existsSync(downloadsDir)) {
      mkdirSync(downloadsDir, { recursive: true })
    }

    // 从 URL 中提取文件名（去掉查询参数）
    const resolvedFileName = fileName || basename(new URL(url).pathname) || 'update.dmg'
    const filePath = join(downloadsDir, resolvedFileName)
    const sender = event.sender

    return new Promise<string>((resolve, reject) => {
      const protocol = url.startsWith('https') ? require('https') : require('http')

      const request = protocol.get(url, (response: import('http').IncomingMessage) => {
        // 处理重定向
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          const redirectUrl = response.headers.location
          const redirectProtocol = redirectUrl.startsWith('https') ? require('https') : require('http')
          redirectProtocol.get(redirectUrl, (redirectResponse: import('http').IncomingMessage) => {
            handleDownloadResponse(redirectResponse, filePath, sender, resolve, reject)
          }).on('error', (err: Error) => {
            openclawLogger.error('[IPC] downloadFile redirect error:', err)
            reject(err)
          })
          return
        }
        handleDownloadResponse(response, filePath, sender, resolve, reject)
      })

      request.on('error', (err: Error) => {
        openclawLogger.error('[IPC] downloadFile request error:', err)
        reject(err)
      })
    })
  })

  ipcMain.handle('app:httpRequest', async (
    _event: IpcMainInvokeEvent,
    input: {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: string
    }
  ): Promise<{
    ok: boolean
    status: number
    statusText: string
    headers: Record<string, string>
    body: string
  }> => {
    const response = await fetch(input.url, {
      method: input.method ?? 'GET',
      headers: input.headers,
      body: input.body,
      redirect: 'follow',
    })

    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers,
      body: await response.text(),
    }
  })

  // ==================== 实例管理 ====================

  ipcMain.handle('instance:getBootState', async (): Promise<InstanceBootState | null> => {
    return getBootState()
  })

  ipcMain.handle('instance:setMode', async (
    _event: IpcMainInvokeEvent,
    mode: InstanceMode
  ): Promise<void> => {
    const bootState = getBootState()
    await initializeWithMode(mode, bootState?.externalInstance, true)
    broadcastToWindows('instance:modeChange', mode)
  })

  ipcMain.handle('instance:getMode', async (): Promise<InstanceMode | null> => {
    return processManager.getMode()
  })

  ipcMain.handle('instance:retryBoot', async (): Promise<InstanceBootState> => {
    return retryBootSequence()
  })

  // ==================== RUM 事件上报 ====================

  ipcMain.handle('rum:report', async (
    _event: IpcMainInvokeEvent,
    event: RumEvent
  ): Promise<void> => {
    rumReport(event, RUM_FROM_RENDERER)
  })

  // ==================== 会话管理 ====================

  ipcMain.handle('session:trimLastExchange', async (
    _event: IpcMainInvokeEvent,
    sessionKey: string
  ): Promise<boolean> => {
    try {
      const runtimeConfig = processManager.getRuntimeConfig()
      if (!runtimeConfig?.stateDir) {
        openclawLogger.warn('[IPC] trimLastExchange: stateDir 不可用')
        return false
      }

      // session key 格式: agent:{agentId}:{...}
      const parts = sessionKey.split(':')
      const agentId = parts[1] || 'main'

      const sessionsJsonPath = join(
        runtimeConfig.stateDir,
        'agents',
        agentId,
        'sessions',
        'sessions.json'
      )

      const fs = await import('fs')

      if (!fs.existsSync(sessionsJsonPath)) {
        openclawLogger.warn(`[IPC] trimLastExchange: sessions.json 不存在: ${sessionsJsonPath}`)
        return false
      }

      const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf-8'))
      const sessionInfo = sessionsData[sessionKey]

      if (!sessionInfo?.sessionFile) {
        openclawLogger.warn(`[IPC] trimLastExchange: session 文件未找到: ${sessionKey}`)
        return false
      }

      // sessionFile 可能是相对路径，需要相对于 sessions.json 所在目录解析
      const { dirname, isAbsolute } = await import('path')
      const fullSessionPath = isAbsolute(sessionInfo.sessionFile)
        ? sessionInfo.sessionFile
        : join(dirname(sessionsJsonPath), sessionInfo.sessionFile)

      if (!fs.existsSync(fullSessionPath)) {
        openclawLogger.warn(`[IPC] trimLastExchange: JSONL 文件不存在: ${fullSessionPath}`)
        return false
      }

      const content = fs.readFileSync(fullSessionPath, 'utf-8')
      const lines = content.split('\n').filter((l: string) => l.trim())

      // 从末尾向前找最后一条 user 消息的位置
      let lastUserIndex = -1
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line) continue

        try {
          const item = JSON.parse(line)
          if (
            item.type === 'message' &&
            item.message?.role === 'user'
          ) {
            lastUserIndex = i
            break
          }
        } catch {
          // 解析失败的行跳过
        }
      }

      if (lastUserIndex === -1) {
        openclawLogger.warn(`[IPC] trimLastExchange: 未找到 user 消息`)
        return false
      }

      // 保留 lastUserIndex 之前的所有行
      const remaining = lines.slice(0, lastUserIndex)
      fs.writeFileSync(fullSessionPath, remaining.join('\n') + (remaining.length > 0 ? '\n' : ''))

      openclawLogger.info(
        `[IPC] trimLastExchange: 成功删除 session ${sessionKey} 最后 ${lines.length - lastUserIndex} 条消息`
      )
      return true
    } catch (error) {
      openclawLogger.error('[IPC] trimLastExchange 失败:', error)
      return false
    }
  })

  // ==================== 调试工具 ====================

  ipcMain.handle('debug:openLogFolder', async (): Promise<void> => {
    const logsPath = app.getPath('logs')
    await shell.openPath(logsPath)
  })

  ipcMain.handle('debug:packQclaw', async (): Promise<{ outputFile: string; size: number; sizeFormatted: string }> => {
    // 打包后 scripts/ 通过 extraResources 放到 Resources/scripts/ 下，不在 asar 内
    // 开发环境 app.getAppPath() 指向源码目录，scripts/ 与 src/ 同级
    const scriptPath = app.isPackaged
      ? join(process.resourcesPath, 'scripts', 'pack-qclaw.cjs')
      : join(app.getAppPath(), 'scripts', 'pack-qclaw.cjs')
    const { packQclaw } = require(scriptPath)
    const result = await packQclaw()
    // 打包完成后在 Finder/资源管理器中高亮显示文件
    shell.showItemInFolder(result.outputFile)
    return result
  })

}
