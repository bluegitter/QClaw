import { contextBridge, ipcRenderer } from 'electron'
import type {
  ElectronAPI,
  OpenClawConfig,
  ConfigUpdateResult,
  ProcessStatus,
  LogEvent,
  InstanceBootState,
  InstanceMode,
  RumEvent
} from '@guanjia-openclaw/shared'

/**
 * Electron API 实现
 */
const electronAPI: ElectronAPI = {
  // 窗口控制
  window: {
    minimize: () =>
      ipcRenderer.invoke('window:minimize'),

    maximize: () =>
      ipcRenderer.invoke('window:maximize'),

    close: () =>
      ipcRenderer.invoke('window:close'),

    isMaximized: () =>
      ipcRenderer.invoke('window:isMaximized'),

    onMaximizeChange: (callback: (isMaximized: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, isMaximized: boolean) =>
        callback(isMaximized)
      ipcRenderer.on('window:maximizeChange', handler)
      return () => ipcRenderer.removeListener('window:maximizeChange', handler)
    }
  },

  // 进程管理
  process: {
    start: (options?: { verbose?: boolean }) =>
      ipcRenderer.invoke('process:start', options),

    stop: () =>
      ipcRenderer.invoke('process:stop'),

    restart: () =>
      ipcRenderer.invoke('process:restart'),

    getStatus: () =>
      ipcRenderer.invoke('process:getStatus'),

    getLogs: () =>
      ipcRenderer.invoke('process:getLogs'),

    openControlUI: () =>
      ipcRenderer.invoke('process:openControlUI'),

    onLog: (callback: (log: LogEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, log: LogEvent) => callback(log)
      ipcRenderer.on('process:log', handler)
      return () => ipcRenderer.removeListener('process:log', handler)
    },

    onStatusChange: (callback: (status: ProcessStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: ProcessStatus) =>
        callback(status)
      ipcRenderer.on('process:status', handler)
      return () => ipcRenderer.removeListener('process:status', handler)
    }
  },

  // 配置管理
  config: {
    getField: (keyPath: string) =>
      ipcRenderer.invoke('config:getField', keyPath),
    updateField: (partialConfig: Partial<OpenClawConfig>): Promise<ConfigUpdateResult> =>
      ipcRenderer.invoke('config:updateField', partialConfig),
    replaceProvider: (
      providerKey: string,
      providerConfig: Record<string, unknown>,
      primaryModel: string,
    ): Promise<ConfigUpdateResult> =>
      ipcRenderer.invoke('config:replaceProvider', providerKey, providerConfig, primaryModel),
    removeProvider: (
      providerKey: string,
      primaryModel: string,
    ): Promise<ConfigUpdateResult> =>
      ipcRenderer.invoke('config:removeProvider', providerKey, primaryModel)
  },

  // 应用级 API
  app: {
    getMachineId: () =>
      ipcRenderer.invoke('app:get-machine-id'),
    getVersion: () =>
      ipcRenderer.invoke('app:get-version'),
    getChannel: () =>
      ipcRenderer.invoke('app:get-channel'),
    generateDeviceIdentity: () =>
      ipcRenderer.invoke('app:generate-device-identity'),
    signDevicePayload: (privateKey: string, payload: string) =>
      ipcRenderer.invoke('app:sign-device-payload', privateKey, payload),
    getSkillCatalog: () =>
      ipcRenderer.invoke('app:getSkillCatalog'),
    inspectSkillDirectory: (dirPath: string) =>
      ipcRenderer.invoke('app:inspectSkillDirectory', dirPath),
    selectSkillDirectory: () =>
      ipcRenderer.invoke('app:selectSkillDirectory'),
    getManagedSkillsRoot: () =>
      ipcRenderer.invoke('app:getManagedSkillsRoot'),
    getSelectedSkillIds: () =>
      ipcRenderer.invoke('app:getSelectedSkillIds'),
    setSelectedSkillIds: (skillIds: string[]) =>
      ipcRenderer.invoke('app:setSelectedSkillIds', skillIds),
    importSkillFromGitHub: (repoUrl: string) =>
      ipcRenderer.invoke('app:importSkillFromGitHub', repoUrl),
    removeManagedSkill: (skillId: string) =>
      ipcRenderer.invoke('app:removeManagedSkill', skillId),
    getCodexAuth: () =>
      ipcRenderer.invoke('app:get-codex-auth'),
    getCodexModels: () =>
      ipcRenderer.invoke('app:get-codex-models'),
    loginOpenAICodex: () =>
      ipcRenderer.invoke('app:loginOpenAICodex'),
    openPath: (filePath: string): Promise<string> =>
      ipcRenderer.invoke('app:openPath', filePath),
    downloadFile: (url: string, fileName?: string): Promise<string> =>
      ipcRenderer.invoke('app:downloadFile', url, fileName),
    httpRequest: (input: {
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
    }> =>
      ipcRenderer.invoke('app:httpRequest', input),
    onDownloadProgress: (callback: (percent: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, percent: number) => callback(percent)
      ipcRenderer.on('app:downloadProgress', handler)
      return () => ipcRenderer.removeListener('app:downloadProgress', handler)
    },
    quitApp: () =>
      ipcRenderer.invoke('app:quit')
  },

  // 日志 API（通过 electron-log 内置 IPC 通道转发到主进程写入文件）
  logger: {
    info: (...args: unknown[]) => ipcRenderer.send('__ELECTRON_LOG__', {
      data: args, level: 'info', logId: 'renderer'
    }),
    warn: (...args: unknown[]) => ipcRenderer.send('__ELECTRON_LOG__', {
      data: args, level: 'warn', logId: 'renderer'
    }),
    error: (...args: unknown[]) => ipcRenderer.send('__ELECTRON_LOG__', {
      data: args, level: 'error', logId: 'renderer'
    })
  },

  // RUM 事件上报（通过 IPC 转发到主进程统一上报）
  reporter: {
    report: (event: RumEvent) =>
      ipcRenderer.invoke('rum:report', event)
  },

  // 实例管理
  instance: {
    getBootState: (): Promise<InstanceBootState | null> =>
      ipcRenderer.invoke('instance:getBootState'),

    setMode: (mode: InstanceMode): Promise<void> =>
      ipcRenderer.invoke('instance:setMode', mode),

    getMode: (): Promise<InstanceMode | null> =>
      ipcRenderer.invoke('instance:getMode'),

    retryBoot: (): Promise<InstanceBootState | null> =>
      ipcRenderer.invoke('instance:retryBoot'),

    onBootState: (callback: (state: InstanceBootState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: InstanceBootState) => callback(state)
      ipcRenderer.on('instance:bootState', handler)
      return () => ipcRenderer.removeListener('instance:bootState', handler)
    },

    onModeChange: (callback: (mode: InstanceMode) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, mode: InstanceMode) => callback(mode)
      ipcRenderer.on('instance:modeChange', handler)
      return () => ipcRenderer.removeListener('instance:modeChange', handler)
    }
  },

  // 会话管理
  session: {
    trimLastExchange: (sessionKey: string) =>
      ipcRenderer.invoke('session:trimLastExchange', sessionKey)
  },

  // 调试工具
  debug: {
    onTogglePanel: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('debug:togglePanel', handler)
      return () => ipcRenderer.removeListener('debug:togglePanel', handler)
    },
    openLogFolder: (): Promise<void> =>
      ipcRenderer.invoke('debug:openLogFolder'),
    packQclaw: (): Promise<{ outputFile: string; size: number; sizeFormatted: string }> =>
      ipcRenderer.invoke('debug:packQclaw')
  },

  // 平台信息
  platform: process.platform,
  arch: process.arch
}

// 使用 contextBridge 暴露 API
contextBridge.exposeInMainWorld('electronAPI', electronAPI)
