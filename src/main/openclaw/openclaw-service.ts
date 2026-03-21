import { spawn, execSync, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import net from 'net'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventEmitter } from 'events'
import type { ProcessStatus, ProcessStatusType, LogEvent } from '@guanjia-openclaw/shared'
import { getOpenClawPath, getExecNodePath, getDefaultConfigSourcePath, getBundledSkillsDir, getBundledExtensionsDir } from './paths.js'
import { cleanupForcedExtensionConfigs, cleanupDuplicateExtensions, injectEnvUrls, stripExtraPluginConfigKeys } from './config-patcher.js'
import { getSelectedBundledSkillDirs } from './skill-selection.js'
import { writeQClawMeta } from './cli-env-writer.js'
import { waitForHealth } from '../server/health-check.js'
import { readConfigField, readConfigFileSync, writeConfigFileSync, resolveNestedArray } from '../common/config-file.js'
import { mergeTemplateWithProtection } from '../common/merge-template-with-protection.js'
import {
  OPENCLAW_STATE_DIR,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_DEFAULT_GATEWAY_PORT,
  OPENCLAW_STARTUP_TIMEOUT,
  OPENCLAW_SHUTDOWN_TIMEOUT,
  OPENCLAW_HEALTH_WAIT_RETRIES,
  OPENCLAW_HEALTH_WAIT_INTERVAL,
  RESTART_DELAY_MS,
  NODE_OPTIONS_VALUE,
  ENV_VALUE_ENABLED,
  OPENCLAW_ENTRY_FILE,
  OPENCLAW_COMMAND_GATEWAY,
  WORKSPACE_DIR_NAME,
  AUTH_TOKEN_BYTES,
  LOCALHOST_ADDRESS,
  OPENCLAW_CLAWHUB_SKILLS_EXTRA_DIRS,
  OPENCLAW_EXTERNAL_PLUGIN_EXTRA_DIRS,
  BUNDLED_PATH_SUFFIXES,
  PROTECTED_CONFIG_PATHS,
} from './constants.js'
import {
  PORT_RELEASE_MAX_WAIT_MS,
  PORT_RELEASE_CHECK_INTERVAL_MS,
  PROCESS_KILL_COMMAND_TIMEOUT_MS,
} from '../server/constants.js'

interface ServiceOptions {
  verbose?: boolean
}

export interface ServiceConfig {
  stateDir: string
  configPath: string
  gatewayPort: number
}

export class OpenClawService extends EventEmitter {
  private process: ChildProcess | null = null
  private status: ProcessStatusType = 'stopped'
  private startTime: number = 0
  private currentPort: number
  private readonly startupTimeout = OPENCLAW_STARTUP_TIMEOUT
  private readonly shutdownTimeout = OPENCLAW_SHUTDOWN_TIMEOUT
  /** 标记当前停止是否为主动操作（stop/shutdown），用于区分意外退出 */
  private intentionalStop = false
  private readonly serviceConfig: ServiceConfig

  constructor(config?: Partial<ServiceConfig>) {
    super()
    this.serviceConfig = {
      stateDir: config?.stateDir ?? OPENCLAW_STATE_DIR,
      configPath: config?.configPath ?? OPENCLAW_CONFIG_PATH,
      gatewayPort: config?.gatewayPort ?? OPENCLAW_DEFAULT_GATEWAY_PORT,
    }
    this.currentPort = this.serviceConfig.gatewayPort
  }

  async start(options: ServiceOptions = {}): Promise<void> {
    if (this.status === 'starting' || this.status === 'running') {
      throw new Error(`Service is already ${this.status}`)
    }

    this.intentionalStop = false
    this.updateStatus('starting')
    this.startTime = Date.now()

    // 初始化运行环境：配置文件、资源目录等，并从配置中解析端口
    this.initializeEnvironment()

    const openclawPath = this.getOpenClawPath()
    const args = this.buildArgs(options)

    this.emit('log', this.createLogEntry('info', `Starting OpenClaw on port ${this.currentPort}`))

    try {
      // 启动前检查端口是否被占用（可能有逃逸的旧进程）
      await this.ensurePortAvailable(this.currentPort)

      const nodePath = this.getNodePath()
      const cleanEnv = this.createCleanEnv()

      this.emit('log', this.createLogEntry('info', `Using Node.js: ${nodePath} (${process.versions.node})`))

      this.process = spawn(nodePath, args, {
        cwd: openclawPath,
        env: cleanEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      })

      this.setupProcessHandlers()

      // 等待进程启动
      await this.waitForStartup()

      // 等待网关 HTTP 服务就绪（最多等待约 6 分钟，覆盖慢启动场景）
      this.emit('log', this.createLogEntry('info', `Waiting for gateway to be ready on port ${this.currentPort}...`))
      await waitForHealth({
        port: this.currentPort,
        retries: OPENCLAW_HEALTH_WAIT_RETRIES,
        retryDelay: OPENCLAW_HEALTH_WAIT_INTERVAL,
        isProcessAlive: () => this.process !== null && !this.process.killed
      })

      this.updateStatus('running')
      this.emit('log', this.createLogEntry('info', `OpenClaw started (PID: ${this.process.pid})`))
      this.emit('status', this.getStatus())

      // 写入 QClaw 元信息文件，供 AI Agent 的 SKILL 脚本读取 CLI 调用路径和 PID
      writeQClawMeta(
        this.serviceConfig.stateDir,
        this.serviceConfig.configPath,
        this.process.pid ?? null,
        this.currentPort,
      )
    } catch (error) {
      this.updateStatus('stopped')
      this.process = null
      const message = error instanceof Error ? error.message : 'Unknown error'
      this.emit('log', this.createLogEntry('error', `Failed to start OpenClaw: ${message}`))
      this.emit('status', this.getStatus())
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'stopping') {
      return
    }

    this.intentionalStop = true
    this.updateStatus('stopping')
    this.emit('status', this.getStatus())

    if (!this.process) {
      this.updateStatus('stopped')
      return
    }

    const pid = this.process.pid
    const proc = this.process

    return new Promise<void>((resolve) => {
      let resolved = false
      let sigkillTimerId: NodeJS.Timeout | null = null
      let finalTimerId: NodeJS.Timeout | null = null

      const finish = (logMsg: string, logLevel: LogEvent['level'] = 'info') => {
        if (resolved) return
        resolved = true

        if (sigkillTimerId) {
          clearTimeout(sigkillTimerId)
          sigkillTimerId = null
        }
        if (finalTimerId) {
          clearTimeout(finalTimerId)
          finalTimerId = null
        }
        proc.removeAllListeners()
        this.process = null
        this.updateStatus('stopped')
        this.emit('log', this.createLogEntry(logLevel, logMsg))
        this.emit('status', this.getStatus())
        resolve()
      }

      proc.once('exit', () => {
        finish(`OpenClaw stopped (PID: ${pid})`)
      })

      proc.once('error', (err: Error) => {
        finish(`Process error during stop: ${err.message}`, 'error')
      })

      // 第一阶段：发送 SIGTERM（优雅关闭）
      // 对整个进程组发信号，防止孙进程逃逸
      if (process.platform === 'win32') {
        proc.kill()
      } else if (pid) {
        try {
          // 向进程组发送 SIGTERM（负 PID = 进程组）
          process.kill(-pid, 'SIGTERM')
        } catch {
          // 进程组发送失败时 fallback 到直接发送
          try { proc.kill('SIGTERM') } catch { /* 进程可能已退出 */ }
        }
      } else {
        try { proc.kill('SIGTERM') } catch { /* 进程可能已退出 */ }
      }

      // 第二阶段：SIGTERM 超时后发送 SIGKILL 强制终止
      sigkillTimerId = setTimeout(() => {
        sigkillTimerId = null
        if (resolved) return

        this.emit('log', this.createLogEntry('warn', 'Shutdown timeout, forcing termination with SIGKILL...'))

        if (pid) {
          try {
            // 向进程组发送 SIGKILL
            process.kill(-pid, 'SIGKILL')
          } catch {
            try { proc.kill('SIGKILL') } catch { /* 进程可能已退出 */ }
          }
        } else {
          try { proc.kill('SIGKILL') } catch { /* 进程可能已退出 */ }
        }
      }, this.shutdownTimeout)

      // 第三阶段：最终兜底，SIGKILL 后如果仍未收到 exit 事件则强制 resolve
      // 防止 stop() 永远不 resolve 导致上层调用卡死
      finalTimerId = setTimeout(() => {
        finalTimerId = null
        finish(`OpenClaw stop forced (PID: ${pid}, no exit event received after SIGKILL)`, 'warn')
      }, this.shutdownTimeout * 2)
    })
  }

  async restart(): Promise<void> {
    this.emit('log', this.createLogEntry('info', 'Restarting OpenClaw...'))
    await this.stop()
    // 等待一小段时间确保进程完全退出
    await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS))
    await this.start()
  }

  getStatus(): ProcessStatus {
    return {
      status: this.status,
      pid: this.process?.pid ?? null,
      uptime: this.startTime && this.status === 'running' ? Date.now() - this.startTime : 0,
      port: this.currentPort
    }
  }

  private updateStatus(status: ProcessStatusType): void {
    this.status = status
  }

  private getNodePath(): string {
    // 使用 Electron 自身二进制 + ELECTRON_RUN_AS_NODE 模式
    // macOS 使用 Helper 二进制避免 Dock 出现第二个图标
    return getExecNodePath()
  }

  /**
   * 创建干净的环境变量，移除 Electron 特有的变量以确保子进程与 Electron 隔离
   */
  private createCleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }

    // 移除 Electron 相关环境变量，防止子进程被 Electron 运行时影响
    const electronVars = Object.keys(env).filter(
      (key) =>
        key.startsWith('ELECTRON_') ||
        key === 'ORIGINAL_XDG_CURRENT_DESKTOP' ||
        key === 'CHROME_DESKTOP'
    )
    for (const key of electronVars) {
      delete env[key]
    }

    // 启用 ELECTRON_RUN_AS_NODE 模式：让 Electron 二进制作为纯 Node.js 运行
    // 注意: 必须在清除所有 ELECTRON_* 之后再设置，否则会被上面的循环删除
    env.ELECTRON_RUN_AS_NODE = ENV_VALUE_ENABLED

    // 设置 OpenClaw 需要的环境变量
    env.NODE_OPTIONS = NODE_OPTIONS_VALUE

    // 将主进程解析出的配置值显式传递给子进程，确保两端一致
    env.OPENCLAW_NIX_MODE = ENV_VALUE_ENABLED
    env.OPENCLAW_STATE_DIR = this.serviceConfig.stateDir
    env.OPENCLAW_CONFIG_PATH = this.serviceConfig.configPath

    // 禁止 OpenClaw gateway 自行 spawn 新进程重启（进程逃逸来源），
    // 改为 in-process restart，确保 Electron 不丢失对子进程的追踪
    env.OPENCLAW_NO_RESPAWN = ENV_VALUE_ENABLED

    return env
  }

  /**
   * 初始化 OpenClaw 运行环境
   * 在进程启动前统一完成所有前置准备工作：
   *   1. 确保配置文件存在并注入动态字段 (workspace、token)
   *   2. 注入预装资源路径 (bundled extensions/skills) 到配置中
   *   3. 从配置文件读取 gateway 端口
   */
  private initializeEnvironment(): void {
    const configPath = this.serviceConfig.configPath
    const stateDir = this.serviceConfig.stateDir

    fs.mkdirSync(stateDir, { recursive: true })

    cleanupDuplicateExtensions(stateDir)
    cleanupForcedExtensionConfigs(configPath)
    this.ensureConfig(configPath, stateDir)
    this.patchConfigFromTemplate(configPath)
    this.injectEnvUrls(configPath)
    this.ensureExternalExtraDirs(configPath)

    // 从配置文件读取端口，作为唯一的端口来源
    const port = readConfigField<number>(configPath, 'gateway.port')
    this.currentPort = port ?? this.serviceConfig.gatewayPort
  }

  /**
   * 确保配置文件存在
   * 如果目标配置文件不存在，则从内置模板复制并注入动态字段
   */
  private ensureConfig(configPath: string, stateDir: string): void {
    if (fs.existsSync(configPath)) {
      return
    }

    const sourcePath = getDefaultConfigSourcePath()

    if (!fs.existsSync(sourcePath)) {
      this.emit(
        'log',
        this.createLogEntry('warn', `Default config template not found at ${sourcePath}`)
      )
      return
    }

    fs.copyFileSync(sourcePath, configPath)

    // 将模板中的动态字段替换为当前环境的实际值
    try {
      const content = readConfigFileSync<{
        agents?: { defaults?: { workspace?: string } }
        gateway?: { port?: number; auth?: { mode?: string; token?: string } }
      }>(configPath)
      if (content.agents?.defaults) {
        content.agents.defaults.workspace = path.join(stateDir, WORKSPACE_DIR_NAME)
      }
      // 动态注入 gateway 端口，确保隔离模式使用 28789 而非模板默认的 18789
      if (content.gateway) {
        content.gateway.port = this.serviceConfig.gatewayPort
      }
      // 动态生成 gateway auth token，避免所有实例使用相同的默认 token
      if (content.gateway?.auth?.mode === 'token') {
        content.gateway.auth.token = randomBytes(AUTH_TOKEN_BYTES).toString('hex')
      }
      this.stripLegacyEnvPlaceholder(content)
      this.stripLegacySkillSelection(content)
      this.migrateLegacyPluginEntries(content)
      writeConfigFileSync(configPath, content)
    } catch (err) {
      this.emit(
        'log',
        this.createLogEntry('warn', `Failed to initialize config: ${err instanceof Error ? err.message : 'Unknown error'}`)
      )
    }

    this.emit(
      'log',
      this.createLogEntry('info', `Config file created at ${configPath}`)
    )
  }

  /**
   * 将内置模板的配置合并到已有配置中
   * 确保存量用户在版本升级后自动获取更新的配置
   *
   * 合并策略: 模板深度覆盖 + 用户字段保护
   * - PROTECTED_CONFIG_PATHS 中的字段保留用户值不覆盖
   * - 其余字段以模板为准覆盖到用户配置
   * - 用户自行添加的非模板字段保留不动
   * - 存量迁移: 将旧版 providers.default 的 apiKey 迁移到 providers.qclaw
   */
  private patchConfigFromTemplate(configPath: string): void {
    if (!fs.existsSync(configPath)) {
      return
    }

    const templatePath = getDefaultConfigSourcePath()
    if (!fs.existsSync(templatePath)) {
      return
    }

    try {
      const userConfig = readConfigFileSync<Record<string, unknown>>(configPath)
      const templateConfig = readConfigFileSync<Record<string, unknown>>(templatePath)

      // 存量迁移: 将旧版 providers.default 迁移到 providers.qclaw（在模板合并之前执行）
      const legacyMigrated = this.migrateLegacyDefaultProvider(userConfig)

      // 模板深度覆盖 + 用户字段保护
      const templateMerged = mergeTemplateWithProtection(userConfig, templateConfig, PROTECTED_CONFIG_PATHS)

      // 清理插件 config 中模板已移除的旧字段（additionalProperties: false 会导致校验失败）
      const pluginConfigStripped = stripExtraPluginConfigKeys(userConfig, templateConfig)

      // 兼容旧模板中 `${QCLAW_LLM_API_KEY}` 这类 env var 占位。
      // Electron 独立模式不依赖外部 shell 注入该变量，保留占位会导致 OpenClaw 启动前校验失败。
      const strippedLegacyEnvPlaceholder = this.stripLegacyEnvPlaceholder(userConfig)
      const strippedLegacySkillSelection = this.stripLegacySkillSelection(userConfig)
      const migratedLegacyPluginEntries = this.migrateLegacyPluginEntries(userConfig)

      if (
        legacyMigrated ||
        templateMerged ||
        pluginConfigStripped ||
        strippedLegacyEnvPlaceholder ||
        strippedLegacySkillSelection ||
        migratedLegacyPluginEntries
      ) {
        writeConfigFileSync(configPath, userConfig)
        this.emit(
          'log',
          this.createLogEntry('info',
            `Patched config from template (legacyMigrated=${String(legacyMigrated)}, templateMerged=${String(templateMerged)}, strippedLegacyEnvPlaceholder=${String(strippedLegacyEnvPlaceholder)}, strippedLegacySkillSelection=${String(strippedLegacySkillSelection)}, migratedLegacyPluginEntries=${String(migratedLegacyPluginEntries)})`)
        )
      }
    } catch (err) {
      this.emit(
        'log',
        this.createLogEntry('warn', `Failed to patch config from template: ${err instanceof Error ? err.message : 'Unknown error'}`)
      )
    }
  }

  /** 内置 provider key（模板中的默认模型提供商） */
  private static readonly BUILTIN_PROVIDER_KEY = 'qclaw'

  /** 旧版内置 provider key（用于存量迁移） */
  private static readonly LEGACY_PROVIDER_KEY = 'default'

  /**
   * 将旧版 providers.default 的配置迁移到 providers.qclaw
   *
   * 迁移内容:
   *   1. models.providers.default.apiKey → models.providers.qclaw.apiKey（仅当 qclaw 无 apiKey 时）
   *   2. agents.defaults.model.primary: "default/xxx" → "qclaw/xxx"
   *   3. 迁移完成后删除 models.providers.default
   *
   * @returns 是否产生了变更
   */
  private migrateLegacyDefaultProvider(
    userConfig: Record<string, unknown>,
  ): boolean {
    const legacyKey = OpenClawService.LEGACY_PROVIDER_KEY
    const builtinKey = OpenClawService.BUILTIN_PROVIDER_KEY

    const userModels = userConfig.models as Record<string, unknown> | undefined
    const userProviders = userModels?.providers as Record<string, unknown> | undefined
    const legacyProvider = userProviders?.[legacyKey] as Record<string, unknown> | undefined

    if (!legacyProvider || !userProviders) {
      return false
    }

    let changed = false

    // 迁移 apiKey: 仅当 qclaw provider 不存在或无 apiKey 时才迁移
    const builtinProvider = userProviders[builtinKey] as Record<string, unknown> | undefined
    if (legacyProvider.apiKey && typeof legacyProvider.apiKey === 'string') {
      if (!builtinProvider) {
        // qclaw provider 不存在，将 legacy 整体复制（后续 mergeTemplateWithProtection 会覆盖 baseUrl/models）
        userProviders[builtinKey] = structuredClone(legacyProvider)
        changed = true
      } else if (!builtinProvider.apiKey) {
        // qclaw provider 存在但无 apiKey，仅迁移 apiKey
        builtinProvider.apiKey = legacyProvider.apiKey
        changed = true
      }
    }

    // 删除旧版 provider
    delete userProviders[legacyKey]
    changed = true

    // 迁移 primary: "default/xxx" → "qclaw/xxx"
    const userAgents = userConfig.agents as Record<string, unknown> | undefined
    const userDefaults = userAgents?.defaults as Record<string, unknown> | undefined
    const userModel = userDefaults?.model as Record<string, unknown> | undefined

    if (
      userModel?.primary !== undefined &&
      typeof userModel.primary === 'string' &&
      userModel.primary.startsWith(`${legacyKey}/`)
    ) {
      userModel.primary = userModel.primary.replace(`${legacyKey}/`, `${builtinKey}/`)
      changed = true
    }

    this.emit(
      'log',
      this.createLogEntry('info', `Migrated legacy provider '${legacyKey}' → '${builtinKey}'`)
    )

    return changed
  }

  private stripLegacySkillSelection(config: Record<string, unknown>): boolean {
    const skills = config.skills
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) {
      return false
    }

    if (!('selection' in skills)) {
      return false
    }

    delete (skills as Record<string, unknown>).selection
    return true
  }

  /**
   * 清理旧模板遗留的 env var 占位字符串，避免 OpenClaw 将其解析为必需环境变量。
   *
   * 已知问题:
   * - `models.providers.qclaw.apiKey: "${QCLAW_LLM_API_KEY}"`
   * - Electron 独立运行时通常不会注入该环境变量
   * - OpenClaw 在配置校验阶段直接报错并拒绝启动
   */
  private stripLegacyEnvPlaceholder(config: Record<string, unknown>): boolean {
    const providers = (config.models as Record<string, unknown> | undefined)?.providers as
      | Record<string, unknown>
      | undefined
    const qclawProvider = providers?.qclaw as Record<string, unknown> | undefined
    const apiKey = qclawProvider?.apiKey

    if (
      typeof apiKey === 'string' &&
      /^\s*\$\{QCLAW_LLM_API_KEY\}\s*$/.test(apiKey)
    ) {
      delete qclawProvider.apiKey
      this.emit(
        'log',
        this.createLogEntry('info', 'Removed legacy ${QCLAW_LLM_API_KEY} placeholder from qclaw provider config'),
      )
      return true
    }

    return false
  }

  /**
   * 迁移/清理历史遗留插件 ID，避免引用当前资源包中已不存在的插件。
   *
   * 当前打包资源中存在:
   * - wechat-access
   * - content-security
   *
   * 历史配置中可能残留:
   * - content-plugin      -> content-security
   * - qmemory            -> 已移除
   * - tool-sandbox       -> 已移除
   * - pcmgr-ai-security  -> 已移除
   */
  private migrateLegacyPluginEntries(config: Record<string, unknown>): boolean {
    const plugins = config.plugins as Record<string, unknown> | undefined
    const entries = plugins?.entries as Record<string, unknown> | undefined
    const allow = Array.isArray(plugins?.allow) ? (plugins?.allow as unknown[]) : null

    if (!entries && !allow) {
      return false
    }

    let changed = false

    const legacyContentPlugin = entries?.['content-plugin'] as Record<string, unknown> | undefined
    const contentSecurity = entries?.['content-security'] as Record<string, unknown> | undefined

    if (legacyContentPlugin) {
      if (!contentSecurity && entries) {
        entries['content-security'] = structuredClone(legacyContentPlugin)
        changed = true
      }

      const targetEntry = entries?.['content-security'] as Record<string, unknown> | undefined
      const legacyConfig = legacyContentPlugin.config as Record<string, unknown> | undefined
      const targetConfig = targetEntry?.config as Record<string, unknown> | undefined

      if (targetEntry && legacyConfig?.token && targetConfig && !targetConfig.token) {
        targetConfig.token = legacyConfig.token
        changed = true
      }

      if (entries && 'content-plugin' in entries) {
        delete entries['content-plugin']
        changed = true
      }

      if (this.removePluginAllowEntry(allow, 'content-plugin')) {
        changed = true
      }

      this.emit(
        'log',
        this.createLogEntry('info', 'Migrated legacy plugin entry content-plugin -> content-security'),
      )
    }

    for (const removedPluginId of ['qmemory', 'tool-sandbox', 'pcmgr-ai-security'] as const) {
      if (entries && removedPluginId in entries) {
        delete entries[removedPluginId]
        changed = true
        this.emit(
          'log',
          this.createLogEntry('info', `Removed obsolete plugin entry: ${removedPluginId}`),
        )
      }

      if (this.removePluginAllowEntry(allow, removedPluginId)) {
        changed = true
      }
    }

    return changed
  }

  private removePluginAllowEntry(allow: unknown[] | null, pluginId: string): boolean {
    if (!allow) {
      return false
    }

    const index = allow.indexOf(pluginId)
    if (index === -1) {
      return false
    }

    allow.splice(index, 1)
    return true
  }

  /**
   * 将 env-config 中的环境 URL 注入到用户配置
   *
   * 委托给 config-patcher 中的独立函数，并将结果通过事件发射通知调用者
   */
  private injectEnvUrls(configPath: string): void {
    const changed = injectEnvUrls(configPath)
    if (changed) {
      const rawEnv = process.env.BUILD_ENV || 'test'
      this.emit(
        'log',
        this.createLogEntry('info', `Injected env URLs (env=${rawEnv})`)
      )
    }
  }

  /**
   * 确保配置文件中包含预装资源路径和外部搜索路径
   *
   * 注入两类路径:
   *   1. Bundled 路径: app 内预装的 extensions/skills 目录（绝对路径，自动适配 dev/packaged）
   *   2. External 路径: 外部 CLI 安装的 skills/plugins 目录（~ 前缀路径）
   *
   * 每次启动时检查，确保存量用户升级后也能自动生效
   */
  private ensureExternalExtraDirs(configPath: string): void {
    if (!fs.existsSync(configPath)) {
      return
    }

    try {
      const content = readConfigFileSync<Record<string, unknown>>(configPath)

      // 合并 bundled + external skills 路径
      const bundledSkillsDir = getBundledSkillsDir()
      const selectedBundledSkillDirs = getSelectedBundledSkillDirs(content, bundledSkillsDir)
      const allSkillsDirs = [...OPENCLAW_CLAWHUB_SKILLS_EXTRA_DIRS, ...selectedBundledSkillDirs]

      // 合并 bundled + external plugins 路径
      const bundledExtensionsDir = getBundledExtensionsDir()
      const allPluginDirs = [...OPENCLAW_EXTERNAL_PLUGIN_EXTRA_DIRS, bundledExtensionsDir]

      let changed = false

      // 补全 skills.load.extraDirs
      changed =
        this.syncSkillExtraDirs(
          content,
          ['skills', 'load', 'extraDirs'],
          OPENCLAW_CLAWHUB_SKILLS_EXTRA_DIRS,
          bundledSkillsDir,
          selectedBundledSkillDirs,
        ) || changed

      // 补全 plugins.load.paths
      changed = this.ensureConfigArrayField(
        content,
        ['plugins', 'load', 'paths'],
        allPluginDirs,
        'plugins',
      ) || changed

      if (changed) {
        writeConfigFileSync(configPath, content)
      }
    } catch (err) {
      this.emit(
        'log',
        this.createLogEntry('warn', `Failed to ensure extra dirs: ${err instanceof Error ? err.message : 'Unknown error'}`)
      )
    }
  }

  private syncSkillExtraDirs(
    config: Record<string, unknown>,
    keyPath: string[],
    externalValues: readonly string[],
    bundledSkillsDir: string,
    selectedBundledSkillDirs: readonly string[],
  ): boolean {
    const resolved = resolveNestedArray(config, keyPath, 'ensure')!
    const { arr } = resolved
    let changed = false

    for (let index = arr.length - 1; index >= 0; index -= 1) {
      const value = arr[index]
      if (typeof value !== 'string') {
        continue
      }

      if (value === bundledSkillsDir || value.startsWith(`${bundledSkillsDir}${path.sep}`)) {
        if (!selectedBundledSkillDirs.includes(value)) {
          arr.splice(index, 1)
          changed = true
        }
      }
    }

    changed = this.ensureConfigArrayField(config, keyPath, externalValues, 'skills') || changed
    changed = this.ensureConfigArrayField(config, keyPath, selectedBundledSkillDirs, 'skills') || changed
    return changed
  }

  /**
   * 确保配置中指定路径的数组字段与实际文件系统保持同步
   *
   * 对 bundled 路径（以 openclaw/config/extensions 或 openclaw/config/skills 结尾）采用后缀匹配：
   * - 数组中已有相同后缀的条目且值正确 → 跳过
   * - 数组中已有相同后缀的条目但值不同 → 原地替换
   * - 数组中不存在同后缀条目 → 追加
   *
   * 对外部路径（~ 前缀）采用精确匹配：
   * - 添加：目录存在且尚未在配置中的路径
   * - 移除：之前添加但目录已不存在的路径（避免 OpenClaw 校验报错）
   *
   * @returns 是否有变更
   */
  private ensureConfigArrayField(
    config: Record<string, unknown>,
    keyPath: string[],
    requiredValues: readonly string[],
    label: string,
  ): boolean {
    const resolved = resolveNestedArray(config, keyPath, 'ensure')!
    const { parent, leafKey, arr } = resolved

    let changed = false

    // 移除已在配置中但目录不再存在的路径（仅清理由本逻辑管理的外部路径）
    for (const v of requiredValues) {
      const resolvedPath = v.startsWith('~') ? path.join(os.homedir(), v.slice(1)) : v
      const idx = arr.indexOf(v)
      if (idx !== -1 && !fs.existsSync(resolvedPath)) {
        arr.splice(idx, 1)
        changed = true
        this.emit(
          'log',
          this.createLogEntry('info', `Removed non-existent ${label} dir from config: ${v}`)
        )
      }
    }

    // 添加/替换路径
    for (const v of requiredValues) {
      // 精确匹配：已存在则跳过
      if (arr.includes(v)) continue

      const resolvedPath = v.startsWith('~') ? path.join(os.homedir(), v.slice(1)) : v

      // 按后缀匹配：检测是否有同后缀的旧 bundled 路径需要替换
      const suffix = BUNDLED_PATH_SUFFIXES.find((s) => v.endsWith(s))
      if (suffix) {
        const existingIdx = arr.findIndex(
          (item) => typeof item === 'string' && item.endsWith(suffix),
        )
        if (existingIdx !== -1) {
          // 同后缀旧路径存在，原地替换
          arr[existingIdx] = v
          changed = true
          this.emit(
            'log',
            this.createLogEntry('info', `Replaced outdated ${label} bundled dir in config: ${arr[existingIdx]} → ${v}`)
          )
          continue
        }
      }

      // 无同后缀旧条目，检查目录存在后追加
      if (fs.existsSync(resolvedPath)) {
        arr.push(v)
        changed = true
        this.emit(
          'log',
          this.createLogEntry('info', `Added ${label} dir to config: ${v}`)
        )
      }
    }

    if (changed) {
      parent[leafKey] = arr
    }

    return changed
  }

  private getOpenClawPath(): string {
    return getOpenClawPath()
  }

  private buildArgs(options: ServiceOptions): string[] {
    const entryPath = path.join(this.getOpenClawPath(), OPENCLAW_ENTRY_FILE)
    const args = [entryPath, OPENCLAW_COMMAND_GATEWAY]

    if (options.verbose) {
      args.push('--verbose')
    }

    return args
  }

  private setupProcessHandlers(): void {
    if (!this.process) return

    this.process.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString('utf8').split('\n').filter((line) => line.trim())
      for (const line of lines) {
        this.emit('log', this.createLogEntry('info', line))
      }
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString('utf8').split('\n').filter((line) => line.trim())
      for (const line of lines) {
        this.emit('log', this.createLogEntry('error', line))
      }
    })

    this.process.on('exit', (code, signal) => {
      const message = `Process exited (code: ${code}, signal: ${signal})`
      const wasRunning = this.status === 'running' || this.status === 'starting'

      if (wasRunning) {
        this.emit('log', this.createLogEntry('warn', message))
      }

      // 区分主动停止和意外退出
      // exitCode === 0 且无信号：说明 gateway 是主动 exit(0)。
      // 设置了 OPENCLAW_NO_RESPAWN=1 后，OpenClaw 使用 in-process restart（不退出进程），
      // 此分支理论上不会被触发。保留作为防御性兜底，避免 env 未正确设置时触发 Supervisor 竞争。
      const isGracefulSelfRestart = code === 0 && signal === null
      if (!this.intentionalStop && wasRunning && !isGracefulSelfRestart) {
        this.emit('unexpected-exit', { code, signal })
      }

      if (wasRunning || this.status === 'stopping') {
        this.updateStatus('stopped')
        this.emit('status', this.getStatus())
      }

      this.process = null
      this.intentionalStop = false
    })

    this.process.on('error', (err: Error) => {
      this.emit('log', this.createLogEntry('error', `Process error: ${err.message}`))
      if (this.status === 'starting' || this.status === 'running') {
        this.updateStatus('stopped')
        this.emit('status', this.getStatus())
      }
    })
  }

  private async waitForStartup(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        reject(new Error('Process not initialized'))
        return
      }

      const timeoutId = setTimeout(() => {
        reject(new Error('Process startup timeout'))
      }, this.startupTimeout)

      const checkExit = () => {
        if (!this.process || this.process.killed) {
          clearTimeout(timeoutId)
          reject(new Error('Process exited during startup'))
        }
      }

      // 监听进程退出
      this.process.once('exit', () => {
        checkExit()
      })

      // 监听进程错误
      this.process.once('error', (err) => {
        clearTimeout(timeoutId)
        reject(err)
      })

      // 进程成功启动后 resolve
      this.process.once('spawn', () => {
        clearTimeout(timeoutId)
        resolve()
      })

      // 如果已经 spawn，直接 resolve
      if (this.process.pid) {
        clearTimeout(timeoutId)
        resolve()
      }
    })
  }

  /**
   * 检查端口是否可用，如果被占用则尝试清理残留进程
   * 防止旧进程逃逸后占用端口导致新进程启动失败
   */
  private async ensurePortAvailable(port: number): Promise<void> {
    const inUse = await this.isPortInUse(port)
    if (!inUse) return

    this.emit('log', this.createLogEntry('warn', `Port ${port} is already in use, attempting to kill orphan process...`))

    // 尝试找到并杀死占用端口的进程
    const killed = this.killProcessOnPort(port)
    if (!killed) {
      throw new Error(`Port ${port} is occupied by another process and could not be freed`)
    }

    // 等待端口释放
    const maxWait = PORT_RELEASE_MAX_WAIT_MS
    const interval = PORT_RELEASE_CHECK_INTERVAL_MS
    let waited = 0
    while (waited < maxWait) {
      await new Promise((resolve) => setTimeout(resolve, interval))
      waited += interval
      if (!(await this.isPortInUse(port))) {
        this.emit('log', this.createLogEntry('info', `Port ${port} freed successfully`))
        return
      }
    }

    throw new Error(`Port ${port} is still occupied after attempting cleanup`)
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(true)
        } else {
          resolve(false)
        }
      })
      server.once('listening', () => {
        server.close(() => resolve(false))
      })
      server.listen(port, LOCALHOST_ADDRESS)
    })
  }

  /**
   * 查找并杀死占用指定端口的进程
   * 仅在 Unix 系统上有效（macOS/Linux）
   */
  private killProcessOnPort(port: number): boolean {
    try {
      if (process.platform === 'win32') {
        const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', timeout: PROCESS_KILL_COMMAND_TIMEOUT_MS })
        const match = output.trim().split(/\s+/).pop()
        if (match) {
          const orphanPid = parseInt(match, 10)
          if (!isNaN(orphanPid) && orphanPid > 0) {
            this.emit('log', this.createLogEntry('warn', `Killing orphan process PID ${orphanPid} on port ${port}`))
            execSync(`taskkill /F /PID ${orphanPid}`, { timeout: PROCESS_KILL_COMMAND_TIMEOUT_MS })
            return true
          }
        }
      } else {
        const output = execSync(`lsof -ti :${port}`, { encoding: 'utf8', timeout: PROCESS_KILL_COMMAND_TIMEOUT_MS })
        const pids = output.trim().split('\n').map((s) => parseInt(s, 10)).filter((p) => !isNaN(p) && p > 0)
        if (pids.length > 0) {
          for (const orphanPid of pids) {
            this.emit('log', this.createLogEntry('warn', `Killing orphan process PID ${orphanPid} on port ${port}`))
            try {
              process.kill(orphanPid, 'SIGKILL')
            } catch {
              // 进程可能已退出
            }
          }
          return true
        }
      }
    } catch {
      // lsof/netstat 命令可能失败（无进程占用时 exit code 非 0）
    }
    return false
  }

  private createLogEntry(level: LogEvent['level'], message: string): LogEvent {
    return {
      level,
      message,
      timestamp: Date.now()
    }
  }
}

/** 意外退出事件的数据结构 */
export interface UnexpectedExitData {
  code: number | null
  signal: string | null
}

// 扩展 EventEmitter 类型以支持自定义事件
export interface OpenClawService {
  on(event: 'log', listener: (log: LogEvent) => void): this
  on(event: 'status', listener: (status: ProcessStatus) => void): this
  on(event: 'unexpected-exit', listener: (data: UnexpectedExitData) => void): this
  on(event: string | symbol, listener: (...args: any[]) => void): this

  emit(event: 'log', log: LogEvent): boolean
  emit(event: 'status', status: ProcessStatus): boolean
  emit(event: 'unexpected-exit', data: UnexpectedExitData): boolean
  emit(event: string | symbol, ...args: any[]): boolean
}
