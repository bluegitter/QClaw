import type { BrowserWindow } from 'electron'
import type {
  InstanceMode,
  InstanceBootState,
  RuntimeConfig,
  ExternalInstanceInfo,
  PersistedInstanceMode,
} from '@guanjia-openclaw/shared'
import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { getStoreManager } from '../server/store/index.js'
import { detectExternalInstance } from './instance-detector.js'
import { patchExternalConfig, cleanupInjectedConfig, ensureAllowedOriginsForPath } from './config-patcher.js'
import { readConfigFileSync, writeConfigFileSync } from '../common/config-file.js'
import { getProcessManager } from './process-manager.js'
import { mainLogger } from '../common/logger.js'
import {
  OPENCLAW_STATE_DIR,
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_BACKUP_DIR,
  OPENCLAW_CONFIG_FILE_NAME,
  OPENCLAW_DEFAULT_GATEWAY_PORT,
  OPENCLAW_EXTERNAL_STATE_DIR_NAME,
  STORE_KEY_INSTANCE_MODE,
  INSTANCE_RETRY_DETECTION_MAX_ATTEMPTS,
  INSTANCE_RETRY_DETECTION_INTERVAL_MS,
  WORKSPACE_DIR_NAME,
  AUTH_TOKEN_BYTES,
} from './constants.js'
import { BACKUP_DIR_NAME } from '../server/constants.js'
import { getDefaultConfigSourcePath } from './paths.js'
import { writeQClawMeta } from './cli-env-writer.js'

let currentBootState: InstanceBootState | null = null

/**
 * 应用启动流程编排
 *
 * 1. 检测外部实例
 * 2. 读取持久化模式
 * 3. 计算启动状态
 * 4. 广播到渲染进程
 * 5. 如无需用户选择，直接初始化
 */
export async function runBootSequence(mainWindow: BrowserWindow): Promise<void> {
  const store = getStoreManager()
  const externalInfo = await detectExternalInstance()
  const persisted = store.get<PersistedInstanceMode>(STORE_KEY_INSTANCE_MODE)

  currentBootState = computeBootState(externalInfo, persisted)

  mainLogger.info('[Boot] Boot state:', JSON.stringify(currentBootState))
  mainWindow.webContents.send('instance:bootState', currentBootState)

  if (currentBootState.mode && !currentBootState.needsUserChoice) {
    await initializeWithMode(currentBootState.mode, externalInfo)
  }
}

/**
 * 重新运行 boot sequence（由用户点击"重新检测"触发）
 *
 * 与首次 boot 不同，这里采用多次轮询策略：
 * 用户可能刚启动了外部 OpenClaw，服务尚未 ready，
 * 单次检测大概率失败。轮询等待给服务启动留出时间。
 *
 * 默认 10 次 × 3s 间隔 = 最长等待 ~30s
 */
export async function retryBootSequence(): Promise<InstanceBootState> {
  const store = getStoreManager()
  const persisted = store.get<PersistedInstanceMode>(STORE_KEY_INSTANCE_MODE)

  let externalInfo: ExternalInstanceInfo = { detected: false }

  for (let attempt = 1; attempt <= INSTANCE_RETRY_DETECTION_MAX_ATTEMPTS; attempt++) {
    externalInfo = await detectExternalInstance()
    mainLogger.info(
      `[Boot] Retry detection attempt ${attempt}/${INSTANCE_RETRY_DETECTION_MAX_ATTEMPTS}: detected=${String(externalInfo.detected)}`,
    )

    if (externalInfo.detected) {
      break
    }

    if (attempt < INSTANCE_RETRY_DETECTION_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, INSTANCE_RETRY_DETECTION_INTERVAL_MS))
    }
  }

  currentBootState = computeBootState(externalInfo, persisted)
  mainLogger.info('[Boot] Retry boot state:', JSON.stringify(currentBootState))

  if (currentBootState.mode && !currentBootState.needsUserChoice) {
    await initializeWithMode(currentBootState.mode, externalInfo)
  }

  return currentBootState
}

/**
 * 以指定模式初始化
 * 由 boot sequence 自动调用，或由 UI 通过 IPC instance:setMode 触发
 *
 * @param userInitiated 是否由用户主动选择触发（IPC instance:setMode）
 */
export async function initializeWithMode(
  mode: InstanceMode,
  externalInfo?: ExternalInstanceInfo,
  _userInitiated = false,
): Promise<void> {
  mainLogger.info(`[Boot] Initializing with mode: ${mode}`)
  const store = getStoreManager()

  // 从 shared 切换到 isolated 时，迁移外部配置中的关键字段（如 wechat-access token）
  const bootState = currentBootState
  if (mode === 'isolated' && bootState?.previousMode === 'shared') {
    migrateConfigFromExternal()
  }

  store.set<PersistedInstanceMode>(STORE_KEY_INSTANCE_MODE, {
    mode,
    externalDetectedAtSelection: externalInfo?.detected ?? false,
    selectedAt: Date.now(),
  })

  const runtimeConfig = resolveRuntimeConfig(mode, externalInfo)
  const processManager = getProcessManager()

  prepareForStart(mode, runtimeConfig)

  // 用户主动选择关联模式时，原先会强制覆写 model.primary 为模板值
  // 现已按产品要求移除该逻辑，避免覆盖用户已选择的默认模型。
  // if (mode === 'shared' && userInitiated) {
  //   overwriteModelPrimary(runtimeConfig.configPath)
  // }

  processManager.initialize(mode, runtimeConfig)

  if (mode === 'shared') {
    // 关联模式也写入元信息，供 SKILL 脚本通过 ~/.qclaw/qclaw.json 获取运行时参数
    writeQClawMeta(
      runtimeConfig.stateDir,
      runtimeConfig.configPath,
      null,
      runtimeConfig.gatewayPort,
    )
  }

  if (mode === 'isolated') {
    try {
      await processManager.start()
    } catch (error) {
      mainLogger.error(
        '[Boot] Service start failed:',
        error instanceof Error ? error.message : String(error),
      )
      // 不向上抛出 — 让 boot sequence 正常结束，UI 可以渲染
      // UI 通过 process:status 事件感知 stopped 状态，提示用户重试
    }
  }
}

/**
 * 计算启动状态
 *
 * 场景覆盖:
 * - 无外部实例 + 无持久化/持久化 isolated → isolated（默认）
 * - 无外部实例 + 持久化 shared → 外部消失，弹窗让用户选择（启动外部或切独立）
 * - 有外部实例 + 无持久化 → 等待用户选择
 * - 有外部实例 + 有持久化 + 上次选择时也有外部 → 沿用
 * - 有外部实例 + 有持久化 + 上次选择时没有外部 → 情况变了，等待用户选择
 */
function computeBootState(
  external: ExternalInstanceInfo,
  persisted: PersistedInstanceMode | undefined,
): InstanceBootState {
  // 兼容历史持久化数据：standalone 视同 isolated
  const normalizedMode = normalizeMode(persisted?.mode)

  // 无外部实例
  if (!external.detected) {
    if (normalizedMode === 'shared') {
      // 外部实例消失，需要用户决定：等待外部启动 or 切换 isolated
      return { mode: null, externalInstance: external, needsUserChoice: true, previousMode: 'shared' }
    }
    return { mode: 'isolated', externalInstance: external, needsUserChoice: false, previousMode: normalizedMode ?? null }
  }

  // 有外部实例 + 无持久化选择
  if (!persisted) {
    return { mode: null, externalInstance: external, needsUserChoice: true, previousMode: null }
  }

  // 有外部实例 + 有持久化选择 + 上次选择时也检测到外部 → 沿用
  if (persisted.externalDetectedAtSelection) {
    return { mode: normalizedMode!, externalInstance: external, needsUserChoice: false, previousMode: normalizedMode! }
  }

  // 有外部实例 + 有持久化选择 + 上次选择时没有外部 → 情况变了
  return { mode: null, externalInstance: external, needsUserChoice: true, previousMode: normalizedMode! }
}

/**
 * 兼容历史持久化的 'standalone' 值，统一映射为 'isolated'
 */
function normalizeMode(mode: string | undefined): InstanceMode | undefined {
  if (!mode) return undefined
  if (mode === 'standalone') return 'isolated'
  return mode as InstanceMode
}

/**
 * 根据模式解析运行时配置
 */
function resolveRuntimeConfig(mode: InstanceMode, externalInfo?: ExternalInstanceInfo): RuntimeConfig {
  switch (mode) {
    case 'shared': {
      const externalStateDir = externalInfo?.configDir ?? OPENCLAW_STATE_DIR
      return {
        mode,
        stateDir: externalStateDir,
        configPath: externalInfo?.configDir
          ? `${externalInfo.configDir}/${OPENCLAW_CONFIG_FILE_NAME}`
          : OPENCLAW_CONFIG_PATH,
        backupDir: externalInfo?.configDir
          ? `${externalInfo.configDir}/${BACKUP_DIR_NAME}`
          : OPENCLAW_BACKUP_DIR,
        gatewayPort: externalInfo?.port ?? OPENCLAW_DEFAULT_GATEWAY_PORT,
      }
    }
    case 'isolated':
      return {
        mode,
        stateDir: OPENCLAW_STATE_DIR,
        configPath: OPENCLAW_CONFIG_PATH,
        backupDir: OPENCLAW_BACKUP_DIR,
        gatewayPort: OPENCLAW_DEFAULT_GATEWAY_PORT,
      }
  }
}

/**
 * 从外部 OpenClaw 配置迁移关键字段到隔离配置
 *
 * 触发条件: shared → isolated 自动切换（外部实例消失）
 * 迁移策略: 只迁移用户相关数据（token），不覆盖已有值
 */
function migrateConfigFromExternal(): void {
  const externalConfigPath = path.join(
    os.homedir(),
    OPENCLAW_EXTERNAL_STATE_DIR_NAME,
    OPENCLAW_CONFIG_FILE_NAME,
  )

  if (!fs.existsSync(externalConfigPath)) {
    mainLogger.info('[Boot] No external config found, skipping migration')
    return
  }

  try {
    const externalConfig = readConfigFileSync<Record<string, unknown>>(externalConfigPath)

    // 读取隔离配置；如果尚不存在，则从内置模板初始化
    // 必须基于模板创建，否则会缺失 gateway.mode 等必要字段，导致 OpenClaw 启动失败
    let isolatedConfig: Record<string, unknown> = {}
    let createdFromTemplate = false
    if (fs.existsSync(OPENCLAW_CONFIG_PATH)) {
      isolatedConfig = readConfigFileSync<Record<string, unknown>>(OPENCLAW_CONFIG_PATH)
    } else {
      // 从内置模板加载完整默认配置作为基底
      const templatePath = getDefaultConfigSourcePath()
      if (fs.existsSync(templatePath)) {
        isolatedConfig = readConfigFileSync<Record<string, unknown>>(templatePath)

        // 注入动态字段（与 OpenClawService.ensureConfig 逻辑一致）
        // 因为迁移会在 ensureConfig 之前创建文件，ensureConfig 将跳过，所以需要在此完成动态字段注入
        const agents = isolatedConfig.agents as Record<string, unknown> | undefined
        if (agents?.defaults) {
          const defaults = agents.defaults as Record<string, unknown>
          defaults.workspace = path.join(OPENCLAW_STATE_DIR, WORKSPACE_DIR_NAME)
        }
        const gateway = isolatedConfig.gateway as Record<string, unknown> | undefined
        if (gateway) {
          gateway.port = OPENCLAW_DEFAULT_GATEWAY_PORT
        }
        const auth = gateway?.auth as Record<string, unknown> | undefined
        if (auth?.mode === 'token') {
          auth.token = randomBytes(AUTH_TOKEN_BYTES).toString('hex')
        }

        mainLogger.info('[Boot] Initialized isolated config from template for migration')
        createdFromTemplate = true
      }
    }

    let changed = false

    // 迁移 channels.wechat-access.token
    const externalChannels = externalConfig.channels as Record<string, unknown> | undefined
    const externalTA = externalChannels?.['wechat-access'] as Record<string, unknown> | undefined
    const externalToken = externalTA?.token as string | undefined

    if (externalToken) {
      const isolatedChannels = (isolatedConfig.channels ?? {}) as Record<string, unknown>
      const isolatedTA = (isolatedChannels['wechat-access'] ?? {}) as Record<string, unknown>
      const currentToken = isolatedTA.token as string | undefined

      // 只在隔离配置无 token 时迁移，不覆盖用户已设置的值
      if (!currentToken) {
        isolatedTA.token = externalToken
        isolatedChannels['wechat-access'] = isolatedTA
        isolatedConfig.channels = isolatedChannels
        changed = true
        mainLogger.info('[Boot] Migrated wechat-access token from external config')
      }
    }

    if (changed || createdFromTemplate) {
      fs.mkdirSync(path.dirname(OPENCLAW_CONFIG_PATH), { recursive: true })
      writeConfigFileSync(OPENCLAW_CONFIG_PATH, isolatedConfig)
      mainLogger.info(`[Boot] Config migration completed (fromTemplate=${String(createdFromTemplate)}, tokenMigrated=${String(changed)})`)
    } else {
      mainLogger.info('[Boot] No config fields need migration')
    }
  } catch (err) {
    mainLogger.error(
      '[Boot] Config migration failed:',
      err instanceof Error ? err.message : 'Unknown error',
    )
  }
}

/**
 * 每次 OpenClaw 实例启动前的前置准备
 *
 * 确保配置补丁和资源部署在每次启动时都执行（而非仅首次初始化）:
 * - shared:  补丁外部配置 + 部署 bundled extensions
 * - isolated: 补丁 allowedOrigins + 消除与外部配置的插件冲突
 */
export function prepareForStart(mode: InstanceMode, runtimeConfig: RuntimeConfig): void {
  if (mode === 'shared') {
    patchExternalConfig(runtimeConfig.stateDir)
  } else {
    // 隔离模式: 清理 ~/.openclaw/ 中共享模式可能注入的配置
    const externalConfigPath = path.join(
      os.homedir(),
      OPENCLAW_EXTERNAL_STATE_DIR_NAME,
      OPENCLAW_CONFIG_FILE_NAME,
    )
    cleanupInjectedConfig(externalConfigPath)
    ensureAllowedOriginsForPath(runtimeConfig.configPath)
  }
}

/** 获取当前启动状态（供 IPC 查询） */
export function getBootState(): InstanceBootState | null {
  return currentBootState
}
