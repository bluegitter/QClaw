import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { OpenClawConfigSchema, type OpenClawConfig, type ConfigUpdateResult } from '@guanjia-openclaw/shared'
import type { ProcessStatus } from '@guanjia-openclaw/shared'
import { mainLogger } from '../../common/logger.js'
import {
  BACKUP_KEEP_COUNT,
  BACKUP_DIR_NAME,
  GATEWAY_DEFAULT_BIND,
  DEFAULT_MODEL_PRIMARY,
  HEALTH_CHECK_TIMEOUT,
  HEALTH_CHECK_DEFAULT_RETRIES,
  HEALTH_CHECK_DEFAULT_RETRY_DELAY_MS,
} from '../constants.js'
import { readConfigFile, readConfigFileSync, writeConfigFile } from '../../common/config-file.js'

/**
 * 递归深合并两个对象
 * - 两侧都是普通对象时递归合并，保留 target 中未被 source 覆盖的字段
 * - 数组直接以 source 覆盖（不做元素级合并）
 * - 基本类型以 source 覆盖 target
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = structuredClone(target)
  for (const key of Object.keys(source) as (keyof T & string)[]) {
    const sourceVal = source[key]
    const targetVal = result[key]

    if (
      sourceVal !== null &&
      sourceVal !== undefined &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      targetVal !== undefined &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      // 两侧都是普通对象，递归合并
      ;(result as any)[key] = deepMerge(
        targetVal as Record<string, any>,
        sourceVal as Record<string, any>
      )
    } else {
      // 数组、基本类型等直接覆盖
      ;(result as any)[key] = structuredClone(sourceVal as any)
    }
  }
  return result
}

function stripLegacySkillSelection(config: Record<string, unknown>): void {
  const skills = config.skills
  if (!skills || typeof skills !== 'object' || Array.isArray(skills)) {
    return
  }

  if ('selection' in skills) {
    delete (skills as Record<string, unknown>).selection
  }
}

/**
 * ConfigManager 的外部依赖接口
 * 用于服务验证（进程管理 + 健康检查），通过构造函数注入
 */
export interface ConfigManagerDeps {
  /** 获取进程状态 */
  getProcessStatus: () => ProcessStatus
  /** 重启服务 */
  restartProcess: () => Promise<void>
  /** 带重试的健康检查 */
  checkHealthWithRetry: (options: { port: number; retries: number; retryDelay: number; timeout: number }) => Promise<boolean>
}

const BACKUP_FILE_PATTERN = /^openclaw\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/

/**
 * ConfigManager 构造选项
 */
export interface ConfigManagerOptions {
  /** 配置文件路径 */
  configPath: string
  /** 默认网关端口 */
  defaultGatewayPort: number
  /** 内置配置模板路径（用于 createDefault），不传则使用精简骨架 */
  templatePath?: string
  /** 外部依赖（进程管理 + 健康检查），用于 updateField 的服务验证 */
  deps?: ConfigManagerDeps
}

export class ConfigManager {
  private configPath: string
  private backupDir: string
  private defaultGatewayPort: number
  private templatePath?: string
  private deps?: ConfigManagerDeps
  /** 写入锁：链式 Promise，保证 read-merge-write 操作串行化，防止并发 lost update */
  private writeLock: Promise<void> = Promise.resolve()

  constructor(options: ConfigManagerOptions) {
    this.configPath = options.configPath
    this.defaultGatewayPort = options.defaultGatewayPort
    this.templatePath = options.templatePath
    this.backupDir = path.join(path.dirname(this.configPath), BACKUP_DIR_NAME)
    this.deps = options.deps
  }

  private getDefaultConfig(): OpenClawConfig {
    return {
      gateway: {
        port: this.defaultGatewayPort,
        bind: GATEWAY_DEFAULT_BIND,
        auth: { mode: 'none' }
      },
      agents: {
        defaults: {
          model: {
            primary: DEFAULT_MODEL_PRIMARY
          }
        }
      },
      models: {
        providers: {}
      }
    }
  }

  /**
   * 读取完整配置
   * 使用 safeParse 只做校验，返回原始 JSON 对象以保留 schema 未定义的字段（如 auth、messages、commands、session 等）
   */
  private async get(): Promise<OpenClawConfig> {
    const exists = await this.exists()
    if (!exists) {
      return await this.createDefault()
    }

    const parsed = await readConfigFile<Record<string, unknown>>(this.configPath)
    stripLegacySkillSelection(parsed)

    // 仅用 safeParse 校验 schema 定义的字段是否合法，不使用其返回值（避免 strip 掉未知属性）
    const result = OpenClawConfigSchema.safeParse(parsed)
    if (!result.success) {
      mainLogger.warn('[ConfigManager] 配置校验警告:', result.error.message)
    }

    return parsed as OpenClawConfig
  }

  /**
   * 写入配置（串行化）
   *
   * 通过 writeLock 保证多个并发调用按顺序执行，
   * 每次操作都读取最新磁盘内容再合并，避免 lost update。
   *
   * @returns { oldConfig, newConfig } — oldConfig 是写入前的磁盘快照（在锁内读取），
   *          供 updateField 回滚时使用，避免在锁外读取导致 TOCTOU 问题。
   */
  private set(newConfig: Partial<OpenClawConfig>): Promise<{ oldConfig: OpenClawConfig; newConfig: OpenClawConfig }> {
    const operation = this.writeLock.then(async () => {
      const currentConfig = await this.get()

      // 深合并：递归合并所有层级，未涉及的字段原样保留
      const mergedConfig = deepMerge(
        currentConfig as Record<string, any>,
        newConfig as Record<string, any>
      ) as OpenClawConfig
      stripLegacySkillSelection(mergedConfig as Record<string, unknown>)

      mainLogger.info('[ConfigManager] mergedConfig', JSON.stringify(mergedConfig, null, 2))

      // 仅用 safeParse 校验 schema 定义的字段是否合法，不使用其返回值（避免 strip 掉未知属性）
      const result = OpenClawConfigSchema.safeParse(mergedConfig)
      if (!result.success) {
        throw new Error(`配置校验失败: ${result.error.message}`)
      }

      await this.createBackup()

      try {
        await fs.mkdir(path.dirname(this.configPath), { recursive: true })

        // 写入深合并后的完整对象，保留所有 schema 未定义的字段
        await writeConfigFile(this.configPath, mergedConfig)

        return { oldConfig: currentConfig, newConfig: mergedConfig as OpenClawConfig }
      } catch (error) {
        await this.rollback()
        throw error
      }
    })

    // 无论成功或失败，都推进 writeLock 链，不阻塞后续操作
    this.writeLock = operation.then(() => {}, () => {})

    return operation
  }

  private async exists(): Promise<boolean> {
    try {
      await fs.access(this.configPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * 创建默认配置文件
   * 优先从内置模板读取完整配置（包含 channels、plugins 等 schema 未定义的字段），
   * 模板不可用时退回到精简骨架。
   */
  private async createDefault(): Promise<OpenClawConfig> {
    let defaultConfig: Record<string, unknown>

    if (this.templatePath && fsSync.existsSync(this.templatePath)) {
      defaultConfig = readConfigFileSync<Record<string, unknown>>(this.templatePath)
      mainLogger.info('[ConfigManager] Creating default config from template')
    } else {
      defaultConfig = this.getDefaultConfig() as Record<string, unknown>
      mainLogger.warn('[ConfigManager] Template not found, using minimal default config')
    }

    await fs.mkdir(path.dirname(this.configPath), { recursive: true })

    await writeConfigFile(this.configPath, defaultConfig)

    return defaultConfig as OpenClawConfig
  }

  /**
   * 颗粒化获取配置字段
   * @param keyPath 点分隔路径，如 'gateway.port'、'models.providers.openai.apiKey'，传空字符串获取完整配置
   * @returns 字段值，路径不存在时返回 undefined
   */
  async getField(keyPath: string): Promise<unknown> {
    const config = await this.get()
    return this.getNestedValue(config, keyPath)
  }

  /**
   * 颗粒化更新配置字段
   * 接收 JSON 格式的 partial 配置，完成校验/备份/写入/服务验证/回滚
   * @param partialConfig 要更新的部分配置（JSON 对象格式）
   * @returns ConfigUpdateResult 包含成功/失败状态、配置、服务重启信息
   */
  async updateField(partialConfig: Partial<OpenClawConfig>): Promise<ConfigUpdateResult> {
    let oldConfig: OpenClawConfig
    let newConfig: OpenClawConfig
    try {
      // 1. 更新配置（内部会做 Zod 校验 + 写入文件 + 备份）
      //    oldConfig 在 writeLock 内部捕获，确保是写入前的最新磁盘快照，
      //    避免在锁外读取导致并发回滚时覆盖其他调用的写入（TOCTOU）
      const result = await this.set(partialConfig)
      oldConfig = result.oldConfig
      newConfig = result.newConfig
    } catch (error) {
      // Schema 校验失败或写入失败，从磁盘读取当前配置作为返回值
      const currentConfig = await this.get()
      const message = error instanceof Error ? error.message : '配置校验失败'
      return {
        success: false,
        config: currentConfig,
        message: `配置更新失败: ${message}`,
        serviceRestarted: false,
        error: message
      }
    }

    // 2. 如果没有注入依赖，跳过服务验证
    if (!this.deps) {
      return {
        success: true,
        config: newConfig,
        message: '配置已更新',
        serviceRestarted: false
      }
    }

    // 3. 检查服务是否正在运行，如果正在运行则需要重启验证
    const status = this.deps.getProcessStatus()
    if (status.status !== 'running') {
      return {
        success: true,
        config: newConfig,
        message: '配置已更新（服务未运行，下次启动生效）',
        serviceRestarted: false
      }
    }

    // 4. 服务正在运行，执行重启验证
    try {
      await this.deps.restartProcess()

      // 5. 健康检查：验证服务是否能正常启动
      const isHealthy = await this.deps.checkHealthWithRetry({
        port: newConfig.gateway.port,
        retries: 5,
        retryDelay: HEALTH_CHECK_DEFAULT_RETRY_DELAY_MS,
        timeout: HEALTH_CHECK_TIMEOUT
      })

      if (isHealthy) {
        return {
          success: true,
          config: newConfig,
          message: '配置已更新，服务重启成功',
          serviceRestarted: true
        }
      }

      // 6. 健康检查失败，回滚配置
      throw new Error('服务健康检查未通过')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '服务重启失败'

      // 7. 回滚到旧配置（oldConfig 是锁内捕获的写入前快照，不会覆盖其他并发写入）
      try {
        await this.set(oldConfig)
        await this.deps.restartProcess()
        // 等待回滚后的服务恢复
        await this.deps.checkHealthWithRetry({
          port: oldConfig.gateway.port,
          retries: HEALTH_CHECK_DEFAULT_RETRIES,
          retryDelay: HEALTH_CHECK_DEFAULT_RETRY_DELAY_MS,
          timeout: HEALTH_CHECK_TIMEOUT
        })
      } catch (rollbackError) {
        const rollbackMsg = rollbackError instanceof Error ? rollbackError.message : '未知错误'
        mainLogger.error('[ConfigManager] 配置回滚失败:', rollbackMsg)
      }

      const rolledBackConfig = await this.get()
      return {
        success: false,
        config: rolledBackConfig,
        message: '配置更新失败，已回滚到原配置',
        serviceRestarted: true,
        error: errorMessage
      }
    }
  }

  /**
   * 按点分隔路径获取嵌套对象的值
   */
  private getNestedValue(obj: Record<string, any>, keyPath: string): unknown {
    if (!keyPath) {
      return obj
    }
    const keys = keyPath.split('.')
    let current: any = obj
    for (const key of keys) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined
      }
      current = current[key]
    }
    return current
  }

  private async getBackupList(): Promise<BackupFile[]> {
    try {
      const files = await fs.readdir(this.backupDir)
      const backupFiles = files
        .filter(f => BACKUP_FILE_PATTERN.test(f))
        .map(filename => ({
          filename,
          path: path.join(this.backupDir, filename),
          timestamp: this.parseBackupTimestamp(filename)
        }))
        .sort((a, b) => b.timestamp - a.timestamp)

      return backupFiles
    } catch {
      return []
    }
  }

  private async rollback(): Promise<void> {
    const backups = await this.getBackupList()
    if (backups.length === 0) {
      throw new Error('没有可用的备份文件')
    }

    const latestBackup = backups[0]!
    await fs.copyFile(latestBackup.path, this.configPath)
  }


  private async createBackup(): Promise<void> {
    const configExists = await this.exists()
    if (!configExists) {
      return
    }

    await fs.mkdir(this.backupDir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupFilename = `openclaw.${timestamp}.json`
    const backupPath = path.join(this.backupDir, backupFilename)

    await fs.copyFile(this.configPath, backupPath)

    await this.cleanOldBackups(BACKUP_KEEP_COUNT)
  }

  private async cleanOldBackups(keepCount: number): Promise<void> {
    const backups = await this.getBackupList()

    const toDelete = backups.slice(keepCount)
    for (const backup of toDelete) {
      await fs.unlink(backup.path)
    }
  }

  private parseBackupTimestamp(filename: string): number {
    const match = filename.match(/openclaw\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)\.json/)
    if (!match) {
      return 0
    }

    const timestampStr = match[1]!.replace(/-/g, ':').replace('T', 'T')
    return new Date(timestampStr).getTime()
  }

}

interface BackupFile {
  filename: string
  path: string
  timestamp: number
}
