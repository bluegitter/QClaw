import fs from 'fs'
import path from 'path'
import { getEnvUrls, type BuildEnv } from '@guanjia-openclaw/shared'
import { getDefaultConfigSourcePath, getBundledExtensionsDir, getBundledSkillsDir } from './paths.js'
import { getSelectedBundledSkillDirs } from './skill-selection.js'
import { readConfigFileSync, writeConfigFileSync, resolveNestedArray } from '../common/config-file.js'
import { mergeTemplateWithProtection } from '../common/merge-template-with-protection.js'
import {
  OPENCLAW_CONFIG_FILE_NAME,
  ELECTRON_REQUIRED_ORIGINS,
  FORCED_CLEANUP_EXTENSIONS,
  BUNDLED_PATH_SUFFIXES,
  PROTECTED_CONFIG_PATHS,
} from './constants.js'
import { mainLogger } from '../common/logger.js'

// ==================== 公共清理工具 ====================

/**
 * 从配置对象中删除指定 key 集合对应的 channels / plugins.entries / plugins.allow 条目
 *
 * 供 cleanupForcedExtensionConfigs 和 cleanupInjectedConfig 共用，
 * 避免相同的 "遍历 key → delete channel → delete entry → splice allow" 模式重复。
 *
 * @returns 是否有变更
 */
function removePluginConfigKeys(
  config: Record<string, unknown>,
  keysToRemove: readonly string[],
  logPrefix: string,
): boolean {
  if (keysToRemove.length === 0) return false

  let changed = false

  const channels = config.channels as Record<string, unknown> | undefined
  const plugins = config.plugins as Record<string, unknown> | undefined
  const entries = plugins?.entries as Record<string, unknown> | undefined
  const allow = plugins?.allow

  for (const name of keysToRemove) {
    // 移除 channels.<name>
    if (channels && name in channels) {
      delete channels[name]
      changed = true
      mainLogger.info(`[ConfigPatcher] ${logPrefix}: removed channels.${name}`)
    }

    // 移除 plugins.entries.<name>
    if (entries && name in entries) {
      delete entries[name]
      changed = true
      mainLogger.info(`[ConfigPatcher] ${logPrefix}: removed plugins.entries.${name}`)
    }

    // 移除 plugins.allow 中的 <name>
    if (Array.isArray(allow)) {
      const idx = (allow as unknown[]).indexOf(name)
      if (idx !== -1) {
        (allow as unknown[]).splice(idx, 1)
        changed = true
        mainLogger.info(`[ConfigPatcher] ${logPrefix}: removed plugins.allow entry: ${name}`)
      }
    }
  }

  return changed
}

/**
 * 清理 plugins.entries.*.config 中模板不存在的旧字段
 *
 * 插件升级可能删除配置字段，但 mergeTemplateWithProtection 只遍历模板中存在的 key，
 * 不会删除用户配置中多出来的字段。而插件的 configSchema 通常设置了
 * additionalProperties: false，残留的旧字段会导致 OpenClaw 运行时校验失败。
 *
 * 本函数以模板的 plugins.entries.*.config 为基准，删除用户配置中多出的 key。
 * 只处理模板中存在的插件，用户自行添加的插件不受影响。
 *
 * @returns 是否有变更
 */
export function stripExtraPluginConfigKeys(
  userConfig: Record<string, unknown>,
  templateConfig: Record<string, unknown>,
): boolean {
  const templatePlugins = templateConfig.plugins as Record<string, unknown> | undefined
  const templateEntries = templatePlugins?.entries as Record<string, unknown> | undefined
  if (!templateEntries) return false

  const userPlugins = userConfig.plugins as Record<string, unknown> | undefined
  const userEntries = userPlugins?.entries as Record<string, unknown> | undefined
  if (!userEntries) return false

  let changed = false

  for (const pluginName of Object.keys(templateEntries)) {
    const templateEntry = templateEntries[pluginName] as Record<string, unknown> | undefined
    const templatePluginConfig = templateEntry?.config as Record<string, unknown> | undefined
    // 模板中该插件没有 config 对象 → 跳过（如 wechat-access 只有 enabled）
    if (!templatePluginConfig) continue

    const userEntry = userEntries[pluginName] as Record<string, unknown> | undefined
    const userPluginConfig = userEntry?.config as Record<string, unknown> | undefined
    // 用户配置中该插件没有 config → 跳过
    if (!userPluginConfig) continue

    const allowedKeys = new Set(Object.keys(templatePluginConfig))

    for (const key of Object.keys(userPluginConfig)) {
      if (!allowedKeys.has(key)) {
        delete userPluginConfig[key]
        changed = true
        mainLogger.info(
          `[ConfigPatcher] Stripped stale config key: plugins.entries.${pluginName}.config.${key}`,
        )
      }
    }
  }

  return changed
}

/**
 * 从配置对象中指定路径的数组移除匹配后缀的 bundled 路径
 *
 * @returns 是否有变更
 */
function removeBundledPathsFromArray(
  config: Record<string, unknown>,
  keyPath: readonly string[],
  suffix: string,
): boolean {
  const resolved = resolveNestedArray(config, keyPath, 'readonly')
  if (!resolved) return false

  const { arr } = resolved
  let changed = false

  // 从后向前遍历，安全删除
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i]
    if (typeof item === 'string' && item.endsWith(suffix)) {
      arr.splice(i, 1)
      changed = true
      mainLogger.info(`[ConfigPatcher] Cleanup: removed bundled path: ${item}`)
    }
  }

  return changed
}

/**
 * 清理用户 stateDir/extensions 下与预装扩展同名的目录
 *
 * 旧版本通过文件复制将预装扩展部署到用户目录，重构为路径引用后
 * 这些副本会导致 OpenClaw 报 "duplicate plugin id" 警告。
 *
 * 由 patchExternalConfig（共享模式）和 OpenClawService.initializeEnvironment（隔离模式）共用。
 */
export function cleanupDuplicateExtensions(stateDir: string): void {
  const userExtDir = path.join(stateDir, 'extensions')
  if (!fs.existsSync(userExtDir)) return

  try {
    // 收集需要清理的插件名（去重）
    const namesToCleanup = new Set<string>(FORCED_CLEANUP_EXTENSIONS)

    const bundledExtDir = getBundledExtensionsDir()
    if (fs.existsSync(bundledExtDir)) {
      const bundledNames = fs.readdirSync(bundledExtDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
      for (const name of bundledNames) {
        namesToCleanup.add(name)
      }
    }

    for (const name of namesToCleanup) {
      const duplicatePath = path.join(userExtDir, name)
      if (fs.existsSync(duplicatePath)) {
        fs.rmSync(duplicatePath, { recursive: true, force: true })
        mainLogger.info(`[ConfigPatcher] Removed duplicate extension from user dir: ${duplicatePath}`)
      }
    }
  } catch (err) {
    mainLogger.error(
      '[ConfigPatcher] Failed to cleanup duplicate extensions:',
      err instanceof Error ? err.message : 'Unknown error',
    )
  }
}

// ==================== 环境 URL 注入 ====================

/**
 * 将 env-config 中的环境 URL 注入到配置文件
 *
 * 根据 BUILD_ENV 环境变量决定注入测试还是生产 URL，确保
 * qclawBaseUrl 和 wechatWsUrl 始终与当前构建环境一致。
 *
 * @returns 是否有变更
 */
export function injectEnvUrls(configPath: string): boolean {
  if (!fs.existsSync(configPath)) {
    return false
  }

  try {
    const rawEnv = process.env.BUILD_ENV || 'test'
    const env: BuildEnv = rawEnv === 'production' ? 'production' : 'test'
    const envUrls = getEnvUrls(env)
    const content = readConfigFileSync<Record<string, unknown>>(configPath)
    let changed = false

    // 注入 models.providers.qclaw.baseUrl
    const models = content.models as Record<string, unknown> | undefined
    const providers = models?.providers as Record<string, unknown> | undefined
    const qclaw = providers?.qclaw as Record<string, unknown> | undefined
    if (qclaw && qclaw.baseUrl !== envUrls.qclawBaseUrl) {
      qclaw.baseUrl = envUrls.qclawBaseUrl
      changed = true
    }

    // 注入 channels.wechat-access.wsUrl
    const channels = content.channels as Record<string, unknown> | undefined
    const wechatAccess = channels?.['wechat-access'] as Record<string, unknown> | undefined
    if (wechatAccess && wechatAccess.wsUrl !== envUrls.wechatWsUrl) {
      wechatAccess.wsUrl = envUrls.wechatWsUrl
      changed = true
    }

    if (changed) {
      writeConfigFileSync(configPath, content)
      mainLogger.info(`[ConfigPatcher] Injected env URLs (env=${env}, baseUrl=${envUrls.qclawBaseUrl})`)
    }

    return changed
  } catch (err) {
    mainLogger.error(
      '[ConfigPatcher] Failed to inject env URLs:',
      err instanceof Error ? err.message : 'Unknown error',
    )
    return false
  }
}

// ==================== 注入（共享模式） ====================

/**
 * 确保 Gateway 配置中包含 Electron 渲染进程的 Origin
 *
 * Electron 生产模式下页面从 file:// 加载，但浏览器发送 WebSocket 升级请求时
 * Origin 头为字符串 "null"（而非 "file://"）。
 * OpenClaw Gateway 会校验 gateway.controlUi.allowedOrigins，
 * 如果其中不包含 "null"，WebSocket 连接会被拒绝。
 *
 * 此函数检查并修补配置文件，确保 allowedOrigins 同时包含
 * "file://" 和 "null"，兼容所有平台和 Electron 版本的行为差异。
 */
export function ensureAllowedOriginsForPath(configPath: string): void {
  try {
    if (!fs.existsSync(configPath)) return

    const config = readConfigFileSync<Record<string, unknown>>(configPath)

    // 自动创建缺失的层级，确保无论外部配置什么状态都能写入 allowedOrigins
    const gateway = (config.gateway ?? {}) as Record<string, unknown>
    config.gateway = gateway
    const controlUi = (gateway.controlUi ?? {}) as Record<string, unknown>
    gateway.controlUi = controlUi

    const origins: unknown[] = Array.isArray(controlUi.allowedOrigins)
      ? controlUi.allowedOrigins
      : []

    // 需要确保同时包含 "file://" 和 "null"
    const requiredOrigins = ELECTRON_REQUIRED_ORIGINS
    let changed = false

    for (const origin of requiredOrigins) {
      if (!origins.includes(origin)) {
        origins.push(origin)
        changed = true
      }
    }

    if (changed) {
      controlUi.allowedOrigins = origins
      writeConfigFileSync(configPath, config)
    }
  } catch (err) {
    mainLogger.error('Failed to patch allowedOrigins:', err)
  }
}

/**
 * 对外部 OpenClaw 实例的配置执行补丁
 *
 * 策略: "只添加，不覆盖" — 仅补充缺失的配置节、必要的 allowedOrigins 和预装资源路径
 */
export function patchExternalConfig(externalStateDir: string): void {
  const configPath = path.join(externalStateDir, OPENCLAW_CONFIG_FILE_NAME)

  cleanupDuplicateExtensions(externalStateDir)
  cleanupForcedExtensionConfigs(configPath)
  patchConfigFile(configPath)
  injectEnvUrls(configPath)
  ensureAllowedOriginsForPath(configPath)
  ensureBundledPaths(configPath)
}

/**
 * 清理强制删除的插件在配置文件中的残留条目
 *
 * cleanupDuplicateExtensions 只删除插件目录，不清理配置文件。
 * 本函数负责移除 FORCED_CLEANUP_EXTENSIONS 中插件对应的:
 *   - channels.<pluginName>
 *   - plugins.entries.<pluginName>
 *   - plugins.allow 数组中的 pluginName
 */
export function cleanupForcedExtensionConfigs(configPath: string): void {
  if (FORCED_CLEANUP_EXTENSIONS.length === 0) return
  if (!fs.existsSync(configPath)) return

  try {
    const config = readConfigFileSync<Record<string, unknown>>(configPath)
    const changed = removePluginConfigKeys(config, FORCED_CLEANUP_EXTENSIONS, 'Forced cleanup')

    if (changed) {
      writeConfigFileSync(configPath, config)
      mainLogger.info('[ConfigPatcher] Cleaned up forced-removal plugin configs')
    }
  } catch (err) {
    mainLogger.error(
      '[ConfigPatcher] Failed to cleanup forced extension configs:',
      err instanceof Error ? err.message : 'Unknown error',
    )
  }
}

function patchConfigFile(configPath: string): void {
  if (!fs.existsSync(configPath)) {
    mainLogger.warn('[ConfigPatcher] External config not found, skipping patch')
    return
  }

  try {
    const externalConfig = readConfigFileSync<Record<string, unknown>>(configPath)

    const templatePath = getDefaultConfigSourcePath()
    if (!fs.existsSync(templatePath)) return

    const templateConfig = readConfigFileSync<Record<string, unknown>>(templatePath)

    // 模板深度覆盖 + 用户字段保护（保护路径内的字段保留用户值，其余以模板为准）
    let changed = mergeTemplateWithProtection(externalConfig, templateConfig, PROTECTED_CONFIG_PATHS)

    // 清理插件 config 中模板已移除的旧字段（additionalProperties: false 会导致校验失败）
    changed = stripExtraPluginConfigKeys(externalConfig, templateConfig) || changed

    if (changed) {
      writeConfigFileSync(configPath, externalConfig)
      mainLogger.info('[ConfigPatcher] External config patched successfully')
    } else {
      mainLogger.info('[ConfigPatcher] External config already up-to-date')
    }
  } catch (err) {
    mainLogger.error(
      '[ConfigPatcher] Failed to patch config:',
      err instanceof Error ? err.message : 'Unknown error',
    )
  }
}

/**
 * 将 app 内预装 extensions/skills 的绝对路径注入到外部配置的搜索路径中
 *
 * 策略: 检查路径是否已存在于配置数组中，仅追加缺失的路径
 */
function ensureBundledPaths(configPath: string): void {
  if (!fs.existsSync(configPath)) return

  try {
    const config = readConfigFileSync<Record<string, unknown>>(configPath)
    let changed = false

    // 注入 bundled extensions 路径到 plugins.load.paths
    const bundledExtDir = getBundledExtensionsDir()
    if (fs.existsSync(bundledExtDir)) {
      changed = ensureArrayValue(config, ['plugins', 'load', 'paths'], bundledExtDir) || changed
    }

    // 注入 bundled skills 路径到 skills.load.extraDirs
    const bundledSkillsDir = getBundledSkillsDir()
    if (fs.existsSync(bundledSkillsDir)) {
      changed =
        syncBundledSkillPaths(
          config,
          ['skills', 'load', 'extraDirs'],
          bundledSkillsDir,
          getSelectedBundledSkillDirs(config, bundledSkillsDir),
        ) || changed
    }

    if (changed) {
      writeConfigFileSync(configPath, config)
      mainLogger.info('[ConfigPatcher] Injected bundled resource paths into external config')
    }
  } catch (err) {
    mainLogger.error(
      '[ConfigPatcher] Failed to inject bundled paths:',
      err instanceof Error ? err.message : 'Unknown error',
    )
  }
}

function syncBundledSkillPaths(
  config: Record<string, unknown>,
  keyPath: string[],
  bundledSkillsDir: string,
  selectedSkillDirs: readonly string[],
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
      if (!selectedSkillDirs.includes(value)) {
        arr.splice(index, 1)
        changed = true
      }
    }
  }

  for (const skillDir of selectedSkillDirs) {
    changed = ensureArrayValue(config, keyPath, skillDir) || changed
  }

  return changed
}

/**
 * 确保配置对象中指定路径的数组包含给定值
 *
 * 对 bundled 路径（以 openclaw/config/extensions 或 openclaw/config/skills 结尾）采用后缀匹配：
 * - 如果数组中已存在相同后缀的条目且值正确 → 跳过
 * - 如果数组中已存在相同后缀的条目但值不同 → 原地替换
 * - 如果数组中不存在同后缀条目 → 追加
 *
 * @returns 是否有变更
 */
function ensureArrayValue(
  config: Record<string, unknown>,
  keyPath: readonly string[],
  value: string,
): boolean {
  const resolved = resolveNestedArray(config, keyPath, 'ensure')!
  const { parent, leafKey, arr } = resolved

  // 精确匹配：值已存在，无需变更
  if (arr.includes(value)) return false

  // 后缀匹配：检测是否有同后缀的旧 bundled 路径需要替换
  const suffix = BUNDLED_PATH_SUFFIXES.find((s) => value.endsWith(s))
  if (suffix) {
    const existingIdx = arr.findIndex(
      (item) => typeof item === 'string' && item.endsWith(suffix),
    )
    if (existingIdx !== -1) {
      // 同后缀旧路径存在，原地替换
      arr[existingIdx] = value
      parent[leafKey] = arr
      return true
    }
  }

  arr.push(value)
  parent[leafKey] = arr
  return true
}

// ==================== 回收（隔离模式） ====================

/**
 * 隔离模式启动时，清理 ~/.openclaw/openclaw.json 中共享模式注入的配置
 *
 * 清理范围: channels/models.providers/plugins 中与模板 key 匹配的项,
 *          以及 bundled 路径和 Electron 专用 allowedOrigins
 *
 * 与 patchExternalConfig 对称 — 注入时添加的配置，在此处回收
 */
export function cleanupInjectedConfig(configPath: string): void {
  if (!fs.existsSync(configPath)) return

  const templatePath = getDefaultConfigSourcePath()
  if (!fs.existsSync(templatePath)) return

  try {
    const config = readConfigFileSync<Record<string, unknown>>(configPath)
    const templateConfig = readConfigFileSync<Record<string, unknown>>(templatePath)
    let changed = false

    // --- 提取模板中的 key 集合 ---
    const templateChannels = templateConfig.channels as Record<string, unknown> | undefined
    const templatePlugins = templateConfig.plugins as Record<string, unknown> | undefined
    const templateEntries = templatePlugins?.entries as Record<string, unknown> | undefined

    // --- 清理 channels / plugins.entries / plugins.allow 中与模板 key 匹配的项 ---
    // 合并模板 channels + plugins.entries 的 key（去重），一次性调用 removePluginConfigKeys
    const keysFromTemplate = new Set<string>()
    if (templateChannels) {
      for (const k of Object.keys(templateChannels)) keysFromTemplate.add(k)
    }
    if (templateEntries) {
      for (const k of Object.keys(templateEntries)) keysFromTemplate.add(k)
    }
    changed = removePluginConfigKeys(config, [...keysFromTemplate], 'Cleanup') || changed

    // 注意: 不清理 models.providers —— 默认 provider（如 qclaw）应保留在外部配置中

    // --- 从 plugins.load.paths 移除 bundled extensions 路径 ---
    changed = removeBundledPathsFromArray(config, ['plugins', 'load', 'paths'], BUNDLED_PATH_SUFFIXES[0]!) || changed

    // --- 从 skills.load.extraDirs 移除 bundled skills 路径 ---
    changed = removeBundledPathsFromArray(config, ['skills', 'load', 'extraDirs'], BUNDLED_PATH_SUFFIXES[1]!) || changed

    // --- 从 gateway.controlUi.allowedOrigins 移除 Electron 专用 origin ---
    const controlUi = (config.gateway as Record<string, unknown> | undefined)
      ?.controlUi as Record<string, unknown> | undefined
    if (controlUi && Array.isArray(controlUi.allowedOrigins)) {
      const origins = controlUi.allowedOrigins as unknown[]
      for (const origin of ELECTRON_REQUIRED_ORIGINS) {
        const idx = origins.indexOf(origin)
        if (idx !== -1) {
          origins.splice(idx, 1)
          changed = true
          mainLogger.info(`[ConfigPatcher] Cleanup: removed Electron origin: ${origin}`)
        }
      }
    }

    if (changed) {
      writeConfigFileSync(configPath, config)
      mainLogger.info('[ConfigPatcher] Cleaned up injected config from external openclaw.json')
    } else {
      mainLogger.info('[ConfigPatcher] No injected config to clean up in external openclaw.json')
    }
  } catch (err) {
    mainLogger.error(
      '[ConfigPatcher] Failed to cleanup injected config:',
      err instanceof Error ? err.message : 'Unknown error',
    )
  }
}
