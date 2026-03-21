import { EventEmitter } from 'events'
import { app, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { mainLogger } from '../common/logger.js'
import {
  CRASH_REPORT_DIR_NAME,
  CRASH_REPORT_MAX_COUNT,
  GPU_DEGRADATION_FLAG_FILE,
  BOOT_IN_PROGRESS_FLAG_FILE,
  RENDERER_RELOAD_MAX_RETRIES,
  RENDERER_RELOAD_WINDOW_MS,
  RENDERER_RELOAD_DELAY_MS,
} from '../constants.js'

// ==================== 类型定义（模块内部，不需要共享到渲染进程） ====================

/** 崩溃来源标识 */
type CrashSource =
  | 'render-process-gone'
  | 'child-process-gone'
  | 'uncaughtException'
  | 'unhandledRejection'

/** 可触发渲染进程 reload 的 reason 白名单 */
const RELOADABLE_REASONS = new Set(['crashed', 'oom'])

/** GPU 降级标记文件结构 */
interface GpuDegradationFlag {
  /** 标记时间戳 */
  flaggedAt: number
  /** 触发标记的崩溃原因 */
  reason: string
  /** 崩溃时的 GPU 信息 */
  gpuInfo?: string
}

/** 系统环境快照 */
interface SystemSnapshot {
  platform: NodeJS.Platform
  arch: string
  osVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  totalMemory: number
  freeMemory: number
  uptime: number
  gpuFeatureStatus?: Electron.GPUFeatureStatus
}

/** 崩溃报告结构 */
export interface CrashReport {
  /** 唯一 ID: crash-{timestamp}-{random} */
  id: string
  /** 崩溃来源 */
  source: CrashSource
  /** ISO 8601 时间戳 */
  timestamp: string
  /** 崩溃原因 */
  reason: string
  /** 进程退出码 */
  exitCode?: number
  /** 错误堆栈（主进程异常时） */
  stack?: string
  /** 受影响的进程类型 */
  processType: string
  /** 系统环境快照 */
  system: SystemSnapshot
  /** 是否触发了 GPU 降级 */
  gpuDegradationTriggered: boolean
  /** 是否尝试了渲染进程 reload */
  rendererReloadAttempted: boolean
  /** 应用版本号 */
  appVersion: string
}

/** 预留：崩溃上报接口 */
export interface CrashReporter {
  upload(report: CrashReport): Promise<boolean>
}

// ==================== CrashHandler ====================

export class CrashHandler extends EventEmitter {
  private crashReportDir: string
  private gpuFlagPath: string
  /** webContentsId → reload 时间戳数组，用于限速 */
  private rendererReloadHistory: Map<number, number[]> = new Map()
  private initialized = false

  /** 预留：远程上报实现 */
  private reporter: CrashReporter | null = null

  constructor() {
    super()
    const logsDir = app.getPath('logs')
    this.crashReportDir = path.join(logsDir, CRASH_REPORT_DIR_NAME)
    this.gpuFlagPath = path.join(app.getPath('userData'), GPU_DEGRADATION_FLAG_FILE)
  }

  /**
   * 初始化崩溃处理器
   * 必须在 app.whenReady() 之后、createWindow() 之前调用
   * 注册所有崩溃事件监听器
   */
  initialize(): void {
    if (this.initialized) {
      mainLogger.warn('[CrashHandler] Already initialized, skipping')
      return
    }
    this.initialized = true

    // 确保崩溃报告目录存在
    fs.mkdirSync(this.crashReportDir, { recursive: true })

    this.setupProcessErrorHandlers()
    this.setupChildProcessGoneHandler()
    this.setupBrowserWindowCreatedHandler()

    mainLogger.info('[CrashHandler] Initialized')
  }

  /**
   * 监听指定窗口的渲染进程崩溃
   * 通过 browser-window-created 事件自动调用，也可手动调用
   */
  watchWindow(window: BrowserWindow): void {
    window.webContents.on('render-process-gone', (_event, details) => {
      const { reason, exitCode } = details

      mainLogger.error(
        `[CrashHandler] Renderer process gone: reason=${reason}, exitCode=${exitCode}`,
      )

      // 判断是否为 GPU 相关崩溃
      const isGpuCrash = (reason as string) === 'gpu-dead'

      const report = this.createCrashReport({
        source: 'render-process-gone',
        reason,
        exitCode,
        processType: 'renderer',
        gpuDegradationTriggered: isGpuCrash,
      })

      // GPU 崩溃：设置降级标记
      if (isGpuCrash) {
        this.setGpuDegradationFlag(reason)
      }

      // 持久化崩溃报告（同步写入，确保落盘）
      this.persistCrashReport(report)

      // 尝试渲染进程 reload（仅 crashed/oom）
      if (!window.isDestroyed() && RELOADABLE_REASONS.has(reason)) {
        report.rendererReloadAttempted = this.attemptRendererReload(window)
        // 更新报告中的 reload 状态
        this.persistCrashReport(report)
      }
    })
  }

  /**
   * 预留：设置远程崩溃上报实现
   */
  setReporter(reporter: CrashReporter): void {
    this.reporter = reporter
  }

  // ==================== 私有：事件处理器注册 ====================

  /**
   * 注册 uncaughtException 和 unhandledRejection 处理器
   * 注意：这些处理器从 ProcessManager.setupExitHandlers() 迁移至此
   */
  private setupProcessErrorHandlers(): void {
    process.on('uncaughtException', (error) => {
      mainLogger.error('[CrashHandler] Uncaught exception:', error)

      const report = this.createCrashReport({
        source: 'uncaughtException',
        reason: error.message,
        stack: error.stack,
        processType: 'main',
      })
      this.persistCrashReport(report)

      // 通过事件通知外部执行优雅关闭（解耦 ProcessManager）
      this.emit('fatal-error', { error, exitCode: 1 })
    })

    process.on('unhandledRejection', (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason)
      const stack = reason instanceof Error ? reason.stack : undefined
      mainLogger.error('[CrashHandler] Unhandled rejection:', reason)

      const report = this.createCrashReport({
        source: 'unhandledRejection',
        reason: message,
        stack,
        processType: 'main',
      })
      this.persistCrashReport(report)

      // 通过事件通知外部执行优雅关闭
      this.emit('fatal-error', { error: reason instanceof Error ? reason : new Error(message), exitCode: 1 })
    })
  }

  /**
   * 注册 child-process-gone 监听器
   * 捕获 GPU 进程崩溃、Utility 进程崩溃等
   */
  private setupChildProcessGoneHandler(): void {
    app.on('child-process-gone', (_event, details) => {
      const { type, reason, exitCode, name } = details

      mainLogger.error(
        `[CrashHandler] Child process gone: type=${type}, reason=${reason}, exitCode=${exitCode}, name=${name ?? 'unknown'}`,
      )

      const isGpuProcess = type === 'GPU'

      const report = this.createCrashReport({
        source: 'child-process-gone',
        reason: `${type}: ${reason}`,
        exitCode,
        processType: isGpuProcess ? 'gpu' : type.toLowerCase(),
        gpuDegradationTriggered: isGpuProcess,
      })

      // GPU 进程崩溃：设置降级标记
      if (isGpuProcess) {
        this.setGpuDegradationFlag(reason)
      }

      this.persistCrashReport(report)
    })
  }

  /**
   * 自动监听新创建的 BrowserWindow
   */
  private setupBrowserWindowCreatedHandler(): void {
    app.on('browser-window-created', (_event, window) => {
      this.watchWindow(window)
    })
  }

  // ==================== 私有：崩溃报告 ====================

  private createCrashReport(params: {
    source: CrashSource
    reason: string
    exitCode?: number
    stack?: string
    processType: string
    gpuDegradationTriggered?: boolean
  }): CrashReport {
    const now = new Date()
    return {
      id: `crash-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      source: params.source,
      timestamp: now.toISOString(),
      reason: params.reason,
      exitCode: params.exitCode,
      stack: params.stack,
      processType: params.processType,
      system: this.captureSystemSnapshot(),
      gpuDegradationTriggered: params.gpuDegradationTriggered ?? false,
      rendererReloadAttempted: false,
      appVersion: app.getVersion(),
    }
  }

  private captureSystemSnapshot(): SystemSnapshot {
    const snapshot: SystemSnapshot = {
      platform: process.platform,
      arch: process.arch,
      osVersion: os.release(),
      electronVersion: process.versions['electron'] ?? 'unknown',
      chromeVersion: process.versions['chrome'] ?? 'unknown',
      nodeVersion: process.versions['node'] ?? 'unknown',
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      uptime: process.uptime(),
    }

    try {
      const gpuInfo = app.getGPUFeatureStatus()
      snapshot.gpuFeatureStatus = gpuInfo
    } catch {
      // GPU 信息不可用，跳过
    }

    return snapshot
  }

  /**
   * 同步写入崩溃报告到磁盘
   * 使用 writeFileSync 确保进程退出前数据落盘
   */
  private persistCrashReport(report: CrashReport): void {
    try {
      fs.mkdirSync(this.crashReportDir, { recursive: true })
      const filePath = path.join(this.crashReportDir, `${report.id}.json`)
      fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8')
      mainLogger.info(`[CrashHandler] Crash report saved: ${filePath}`)

      this.cleanupOldReports()

      // 远程上报（fire-and-forget）
      this.reporter?.upload(report).catch(() => {})
    } catch (err) {
      mainLogger.error('[CrashHandler] Failed to persist crash report:', err)
    }
  }

  /**
   * 清理过期崩溃报告，保留最新 CRASH_REPORT_MAX_COUNT 条
   */
  private cleanupOldReports(): void {
    try {
      const files = fs.readdirSync(this.crashReportDir)
        .filter((f) => f.startsWith('crash-') && f.endsWith('.json'))
        .sort() // 文件名以时间戳开头，字典序排序即时间序

      if (files.length > CRASH_REPORT_MAX_COUNT) {
        const toDelete = files.slice(0, files.length - CRASH_REPORT_MAX_COUNT)
        for (const file of toDelete) {
          fs.unlinkSync(path.join(this.crashReportDir, file))
        }
      }
    } catch {
      // 清理失败不影响主流程
    }
  }

  // ==================== 私有：GPU 降级 ====================

  /**
   * 写入 GPU 降级标记文件
   * 下次启动时由 checkGpuDegradation() 读取并禁用硬件加速
   */
  private setGpuDegradationFlag(reason: string): void {
    try {
      const flag: GpuDegradationFlag = {
        flaggedAt: Date.now(),
        reason,
        gpuInfo: this.getGpuInfoString(),
      }
      fs.writeFileSync(this.gpuFlagPath, JSON.stringify(flag, null, 2), 'utf-8')
      mainLogger.warn(
        '[CrashHandler] GPU degradation flag set, hardware acceleration will be disabled on next launch',
      )
    } catch (err) {
      mainLogger.error('[CrashHandler] Failed to set GPU degradation flag:', err)
    }
  }

  private getGpuInfoString(): string {
    try {
      return JSON.stringify(app.getGPUFeatureStatus())
    } catch {
      return 'unavailable'
    }
  }

  // ==================== 私有：渲染进程 Reload ====================

  /**
   * 尝试 reload 崩溃的渲染进程
   * 限速策略：RENDERER_RELOAD_WINDOW_MS 内最多 RENDERER_RELOAD_MAX_RETRIES 次
   * 返回是否成功发起 reload
   */
  private attemptRendererReload(window: BrowserWindow): boolean {
    if (window.isDestroyed()) return false

    const wcId = window.webContents.id
    const now = Date.now()

    // 获取该窗口的 reload 历史
    let history = this.rendererReloadHistory.get(wcId)
    if (!history) {
      history = []
      this.rendererReloadHistory.set(wcId, history)
    }

    // 裁剪时间窗口外的记录
    const cutoff = now - RENDERER_RELOAD_WINDOW_MS
    const recentHistory = history.filter((t) => t > cutoff)
    this.rendererReloadHistory.set(wcId, recentHistory)

    // 限速检查
    if (recentHistory.length >= RENDERER_RELOAD_MAX_RETRIES) {
      mainLogger.error(
        `[CrashHandler] Renderer reload rate limit reached (${RENDERER_RELOAD_MAX_RETRIES} in ${RENDERER_RELOAD_WINDOW_MS / 1000}s), not reloading`,
      )
      return false
    }

    // 记录本次 reload
    recentHistory.push(now)

    // 延迟 reload，给崩溃进程清理时间
    mainLogger.info(`[CrashHandler] Scheduling renderer reload in ${RENDERER_RELOAD_DELAY_MS}ms`)
    setTimeout(() => {
      try {
        if (!window.isDestroyed()) {
          window.webContents.reload()
          mainLogger.info('[CrashHandler] Renderer reloaded successfully')
        }
      } catch (err) {
        mainLogger.error('[CrashHandler] Failed to reload renderer:', err)
      }
    }, RENDERER_RELOAD_DELAY_MS)

    return true
  }
}

// ==================== 单例 ====================

let crashHandlerInstance: CrashHandler | null = null

export function getCrashHandler(): CrashHandler {
  if (!crashHandlerInstance) {
    crashHandlerInstance = new CrashHandler()
  }
  return crashHandlerInstance
}

// ==================== GPU 降级预检（必须在 app.whenReady 之前调用） ====================

/**
 * 检查 GPU 降级标记并应用命令行开关
 *
 * 必须在 app.whenReady() 之前调用，因为 app.commandLine.appendSwitch()
 * 只在 app ready 之前生效。
 *
 * 流程：
 * 1. 读取 {userData}/gpu-degradation.flag.json
 * 2. 如存在：appendSwitch('disable-gpu') + appendSwitch('disable-gpu-compositing')
 * 3. 删除标记文件（一次性消费，下次启动重新尝试 GPU）
 *
 * @returns 是否启用了 GPU 降级模式
 */
export function checkGpuDegradation(): boolean {
  try {
    const flagPath = path.join(app.getPath('userData'), GPU_DEGRADATION_FLAG_FILE)
    if (!fs.existsSync(flagPath)) {
      return false
    }

    const raw = fs.readFileSync(flagPath, 'utf-8')
    const flag = JSON.parse(raw) as GpuDegradationFlag

    // 禁用硬件加速
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('disable-gpu-compositing')

    // electron-log 可能尚未初始化，使用 console 确保输出
    console.warn(
      `[CrashHandler] GPU degradation mode active (flagged at ${new Date(flag.flaggedAt).toISOString()}, reason: ${flag.reason}). Hardware acceleration disabled.`,
    )

    // 删除标记文件（一次性消费）
    // 如果 GPU 问题持续存在，下次崩溃会重新设置标记
    fs.unlinkSync(flagPath)

    return true
  } catch {
    return false
  }
}

// ==================== 启动进行中标记（检测原生崩溃） ====================

/**
 * 检查上次启动是否因原生崩溃而未完成
 *
 * 必须在 app.whenReady() 之前调用（与 checkGpuDegradation 同理）。
 *
 * 原理：每次启动前写入 boot-in-progress.flag，渲染进程成功显示后清除。
 * 如果本次启动时发现该标记仍存在，说明上次启动过程中发生了原生层面的崩溃
 * （GPU crash / 安全软件冲突等），CrashHandler 来不及执行，标记未被清除。
 *
 * 检测到残留标记后：禁用 GPU 硬件加速，避免无限崩溃循环。
 *
 * @returns 是否因检测到残留标记而触发了 GPU 降级
 */
export function checkBootCrashFlag(): boolean {
  try {
    const flagPath = path.join(app.getPath('userData'), BOOT_IN_PROGRESS_FLAG_FILE)
    if (!fs.existsSync(flagPath)) {
      return false
    }

    // 上次启动过程中崩溃了 — 禁用 GPU
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('disable-gpu-compositing')

    console.warn(
      '[CrashHandler] Boot crash detected (previous boot-in-progress flag found). Hardware acceleration disabled.',
    )

    // 删除残留标记
    fs.unlinkSync(flagPath)

    return true
  } catch {
    return false
  }
}

/**
 * 写入"启动进行中"标记文件
 *
 * 在 app.whenReady() 之前调用（checkBootCrashFlag 之后）。
 * 渲染进程成功加载后由 clearBootInProgressFlag() 清除。
 * 如果启动过程中发生原生崩溃，标记文件会残留，下次启动时被 checkBootCrashFlag() 检测到。
 */
export function setBootInProgressFlag(): void {
  try {
    const flagPath = path.join(app.getPath('userData'), BOOT_IN_PROGRESS_FLAG_FILE)
    fs.writeFileSync(flagPath, JSON.stringify({ startedAt: Date.now() }), 'utf-8')
  } catch {
    // 写入失败不影响启动
  }
}

/**
 * 清除"启动进行中"标记文件
 *
 * 在渲染进程首次成功加载后调用（ready-to-show 事件），
 * 证明本次启动过程正常完成，GPU 进程工作正常。
 */
export function clearBootInProgressFlag(): void {
  try {
    const flagPath = path.join(app.getPath('userData'), BOOT_IN_PROGRESS_FLAG_FILE)
    if (fs.existsSync(flagPath)) {
      fs.unlinkSync(flagPath)
    }
  } catch {
    // 清除失败不影响运行
  }
}
