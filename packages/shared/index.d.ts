export type BuildEnv = 'test' | 'production'

export interface EnvUrls {
  jprxGateway: string
  wxLoginRedirectUri: string
  beaconUrl: string
  qclawBaseUrl: string
  wechatWsUrl: string
}

export declare const ENV_URLS: Record<BuildEnv, EnvUrls>
export declare function getEnvUrls(env: BuildEnv): EnvUrls

export interface SafeParseSuccess<T> {
  success: true
  data: T
}

export interface SafeParseFailure {
  success: false
  error: {
    message: string
  }
}

export interface SchemaLike<T> {
  safeParse(value: unknown): SafeParseSuccess<T> | SafeParseFailure
}

export type ProcessStatusType =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'recovering'
  | 'circuit_open'

export interface ProcessStatus {
  status: ProcessStatusType
  pid: number | null
  uptime: number
  port: number
  lastError?: string
  restartCount?: number
  nextRetryAt?: number
  circuitOpenReason?: string
}

export interface LogEvent {
  level: 'info' | 'warn' | 'error'
  message: string
  timestamp: number
}

export interface OpenClawConfig {
  gateway?: {
    port?: number
    bind?: 'loopback' | 'all'
    auth?: {
      mode?: 'token' | 'password' | 'none'
      token?: string
      password?: string
    }
  }
  agents?: {
    defaults?: {
      model?: {
        primary?: string
      }
    }
  }
  models?: {
    mode?: 'merge' | 'replace'
    providers?: Record<string, Record<string, unknown>>
  }
  channels?: Record<string, unknown>
  plugins?: {
    entries?: Record<string, unknown>
    allow?: unknown[]
  }
  [key: string]: unknown
}

export declare const OpenClawConfigSchema: SchemaLike<OpenClawConfig>

export interface ConfigUpdateResult {
  success: boolean
  config: OpenClawConfig
  message: string
  serviceRestarted: boolean
  error?: string
}

export type InstanceMode = 'shared' | 'isolated'

export interface PersistedInstanceMode {
  mode: InstanceMode | 'standalone'
  externalDetectedAtSelection: boolean
  selectedAt: number
}

export interface ExternalInstanceInfo {
  detected: boolean
  port?: number
  healthy?: boolean
  configDir?: string
}

export interface RuntimeConfig {
  mode: InstanceMode
  stateDir: string
  configPath: string
  backupDir: string
  gatewayPort: number
}

export interface InstanceBootState {
  mode: InstanceMode | null
  externalInstance: ExternalInstanceInfo
  needsUserChoice: boolean
  previousMode: InstanceMode | null
}

export interface RumEvent {
  name: string
  ext1?: string
  ext2?: string
  ext3?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  [key: string]: unknown
}

export interface ChatCompletionRequest {
  messages: ChatMessage[]
  [key: string]: unknown
}

export interface ChatCompletionChunk {
  id?: string
  choices?: unknown[]
  [key: string]: unknown
}

export interface SkillDirectoryInfo {
  id: string
  name: string
  description: string
  path: string
  isBundled: boolean
  alwaysEnabled: boolean
  source?: 'builtin' | 'project' | 'user'
  emoji?: string
  version?: string
  ownerId?: string
  fullDescription?: string
}

export interface SkillDirectoryInspection extends SkillDirectoryInfo {
  isValid: boolean
  error?: string
}

export interface RemoveManagedSkillResult {
  success: boolean
  message: string
}

export interface ElectronAPI {
  window: {
    minimize(): Promise<void>
    maximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    onMaximizeChange(callback: (isMaximized: boolean) => void): () => void
  }
  process: {
    start(options?: { verbose?: boolean }): Promise<void>
    stop(): Promise<void>
    restart(): Promise<void>
    getStatus(): Promise<ProcessStatus>
    getLogs(): Promise<LogEvent[]>
    openControlUI(): Promise<void>
    onLog(callback: (log: LogEvent) => void): () => void
    onStatusChange(callback: (status: ProcessStatus) => void): () => void
  }
  config: {
    getField(keyPath: string): Promise<unknown>
    updateField(partialConfig: Partial<OpenClawConfig>): Promise<ConfigUpdateResult>
    replaceProvider(providerKey: string, providerConfig: Record<string, unknown>, primaryModel: string): Promise<ConfigUpdateResult>
  }
  app: {
    getMachineId(): Promise<string>
    getVersion(): Promise<string>
    getChannel(): Promise<number | undefined>
    generateDeviceIdentity(): Promise<{
      deviceId: string
      publicKey: string
      privateKey: string
    }>
    signDevicePayload(privateKey: string, payload: string): Promise<string>
    getSkillCatalog(): Promise<SkillDirectoryInfo[]>
    inspectSkillDirectory(dirPath: string): Promise<SkillDirectoryInspection>
    selectSkillDirectory(): Promise<SkillDirectoryInspection | null>
    getManagedSkillsRoot(): Promise<string>
    getSelectedSkillIds(): Promise<string[]>
    setSelectedSkillIds(skillIds: string[]): Promise<{ success: boolean }>
    importSkillFromGitHub(repoUrl: string): Promise<SkillDirectoryInspection>
    removeManagedSkill(skillId: string): Promise<RemoveManagedSkillResult>
    getCodexAuth(): Promise<{
      accessToken: string
      accountId: string
      email: string
      expiresAt: string
      authMode: string
      lastRefresh: string
      sourcePath: string
    }>
    getCodexModels(): Promise<string[]>
    loginOpenAICodex(): Promise<{
      accessToken: string
      refreshToken: string
      idToken: string
      accountId: string
      email: string
      expiresAt: string
    }>
    openPath(filePath: string): Promise<string>
    downloadFile(url: string, fileName?: string): Promise<string>
    httpRequest(input: {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: string
    }): Promise<{
      ok: boolean
      status: number
      statusText: string
      headers: Record<string, string>
      body: string
    }>
    onDownloadProgress(callback: (percent: number) => void): () => void
    quitApp(): Promise<void>
  }
  logger: {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }
  reporter: {
    report(event: RumEvent): Promise<void>
  }
  instance: {
    getBootState(): Promise<InstanceBootState | null>
    setMode(mode: InstanceMode): Promise<void>
    getMode(): Promise<InstanceMode | null>
    retryBoot(): Promise<InstanceBootState | null>
    onBootState(callback: (state: InstanceBootState) => void): () => void
    onModeChange(callback: (mode: InstanceMode) => void): () => void
  }
  session: {
    trimLastExchange(sessionKey: string): Promise<void>
  }
  debug: {
    onTogglePanel(callback: () => void): () => void
    openLogFolder(): Promise<void>
    packQclaw(): Promise<{ outputFile: string; size: number; sizeFormatted: string }>
  }
  platform: string
  arch: string
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}
