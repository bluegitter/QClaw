import { EventEmitter } from 'events'
import { checkHealth } from './health-check.js'
import { mainLogger } from '../common/logger.js'
import {
  SUPERVISOR_BASE_DELAY,
  SUPERVISOR_MAX_DELAY,
  SUPERVISOR_BACKOFF_MULTIPLIER,
  SUPERVISOR_JITTER_FACTOR,
  SUPERVISOR_MAX_RETRIES,
  SUPERVISOR_RETRY_WINDOW,
  SUPERVISOR_STABLE_THRESHOLD,
  SUPERVISOR_HEALTH_CHECK_INTERVAL,
  SUPERVISOR_HEALTH_FAIL_THRESHOLD,
  HEALTH_CHECK_TIMEOUT
} from './constants.js'

// ==================== Types ====================

export type SupervisorState = 'active' | 'recovering' | 'circuit_open' | 'disabled'

export interface CrashRecord {
  timestamp: number
  exitCode: number | null
  signal: string | null
}

export interface SupervisorStatus {
  state: SupervisorState
  restartCount: number
  nextRetryAt: number | null
  circuitOpenReason: string | null
  crashHistory: CrashRecord[]
  consecutiveHealthFailures: number
}

interface SupervisorOptions {
  baseDelay?: number
  maxDelay?: number
  backoffMultiplier?: number
  jitterFactor?: number
  maxRetries?: number
  retryWindow?: number
  stableThreshold?: number
  healthCheckInterval?: number
  healthFailThreshold?: number
}

// ==================== ProcessSupervisor ====================

/**
 * ProcessSupervisor - 进程存活监督器
 *
 * 职责：
 * 1. 监听进程意外退出事件，按指数退避策略自动重启
 * 2. 连续崩溃超过阈值时触发熔断，停止自动重启
 * 3. 运行时周期性健康探测，发现假死时触发重启
 * 4. 进程稳定运行超过阈值后重置重试计数器
 *
 * 事件：
 * - 'restart-scheduled'  : 已安排一次重启 { delay, attempt }
 * - 'restart-attempt'    : 开始执行重启
 * - 'restart-success'    : 重启成功
 * - 'restart-failed'     : 重启失败 { error }
 * - 'circuit-open'       : 熔断触发 { reason, crashHistory }
 * - 'circuit-reset'      : 熔断恢复（用户手动操作）
 * - 'health-failure'     : 运行时健康检查失败 { consecutiveFailures }
 * - 'health-restart'     : 因假死触发重启
 * - 'stable'             : 进程进入稳定状态，重试计数器已重置
 */
export class ProcessSupervisor extends EventEmitter {
  // 配置参数
  private readonly baseDelay: number
  private readonly maxDelay: number
  private readonly backoffMultiplier: number
  private readonly jitterFactor: number
  private readonly maxRetries: number
  private readonly retryWindow: number
  private readonly stableThreshold: number
  private readonly healthCheckInterval: number
  private readonly healthFailThreshold: number

  // 运行状态
  private state: SupervisorState = 'disabled'
  private crashHistory: CrashRecord[] = []
  private retryTimerId: ReturnType<typeof setTimeout> | null = null
  private stableTimerId: ReturnType<typeof setTimeout> | null = null
  private healthTimerId: ReturnType<typeof setInterval> | null = null
  private consecutiveHealthFailures = 0
  private currentPort = 0
  private isRestarting = false
  private healthCheckPaused = false

  // 外部注入的重启函数
  private restartFn: (() => Promise<void>) | null = null

  constructor(options: SupervisorOptions = {}) {
    super()
    this.baseDelay = options.baseDelay ?? SUPERVISOR_BASE_DELAY
    this.maxDelay = options.maxDelay ?? SUPERVISOR_MAX_DELAY
    this.backoffMultiplier = options.backoffMultiplier ?? SUPERVISOR_BACKOFF_MULTIPLIER
    this.jitterFactor = options.jitterFactor ?? SUPERVISOR_JITTER_FACTOR
    this.maxRetries = options.maxRetries ?? SUPERVISOR_MAX_RETRIES
    this.retryWindow = options.retryWindow ?? SUPERVISOR_RETRY_WINDOW
    this.stableThreshold = options.stableThreshold ?? SUPERVISOR_STABLE_THRESHOLD
    this.healthCheckInterval = options.healthCheckInterval ?? SUPERVISOR_HEALTH_CHECK_INTERVAL
    this.healthFailThreshold = options.healthFailThreshold ?? SUPERVISOR_HEALTH_FAIL_THRESHOLD
  }

  // ==================== Public API ====================

  /**
   * 启用 supervisor，注入重启回调和当前端口
   */
  enable(restartFn: () => Promise<void>, port: number): void {
    this.restartFn = restartFn
    this.currentPort = port
    this.state = 'active'
    mainLogger.info('[Supervisor] Enabled')
  }

  /**
   * 禁用 supervisor（应用退出时调用）
   * 取消所有定时器，防止退出后触发重启
   */
  disable(): void {
    this.state = 'disabled'
    this.clearAllTimers()
    this.restartFn = null
    mainLogger.info('[Supervisor] Disabled')
  }

  /**
   * 通知 supervisor 进程已成功启动
   * 启动稳定性定时器和运行时健康探测
   */
  notifyStarted(port: number): void {
    if (this.state === 'disabled') return

    this.currentPort = port
    this.consecutiveHealthFailures = 0
    this.isRestarting = false

    // 启动稳定性定时器：运行超过 stableThreshold 后重置重试计数器
    this.startStableTimer()

    // 启动运行时健康探测
    this.startHealthCheck()

    if (this.state === 'recovering') {
      this.state = 'active'
      this.emit('restart-success')
    }
  }

  /**
   * 通知 supervisor 进程已停止（主动停止不触发重启）
   */
  notifyIntentionalStop(): void {
    this.clearAllTimers()
    // 主动停止不改变 supervisor state（保持 active 或 disabled）
    // 但要清理健康检查和稳定性定时器
  }

  /**
   * 通知 supervisor 进程意外退出
   * 这是触发自动重启逻辑的核心入口
   */
  notifyUnexpectedExit(exitCode: number | null, signal: string | null): void {
    if (this.state === 'disabled') return

    this.clearStableTimer()
    this.clearHealthCheck()

    // 能走到 notifyUnexpectedExit 说明 intentionalStop === false，
    // 即不是用户主动触发的停止。即使 exitCode === 0（例如进程捕获
    // SIGTERM 后以 process.exit(0) 优雅退出），也应该自动重启。
    // 真正的"主动停止"已在 OpenClawService 层通过 intentionalStop 过滤。

    // 记录 crash
    const record: CrashRecord = {
      timestamp: Date.now(),
      exitCode,
      signal
    }
    this.crashHistory.push(record)

    mainLogger.warn(
      `[Supervisor] Unexpected exit detected (code: ${exitCode}, signal: ${signal})`
    )

    // 清理过期的 crash 记录（retryWindow 之外的）
    this.pruneOldCrashes()

    // 检查是否应该熔断
    const recentCrashCount = this.crashHistory.length
    if (recentCrashCount >= this.maxRetries) {
      this.openCircuit(
        `Service crashed ${recentCrashCount} times within ${this.retryWindow / 1000}s window`
      )
      return
    }

    // 计算退避延迟并安排重启
    this.scheduleRestart(recentCrashCount)
  }

  /**
   * 手动重置熔断器（用户主动启动时调用）
   */
  resetCircuit(): void {
    if (this.state === 'circuit_open') {
      mainLogger.info('[Supervisor] Circuit reset by user action')
      this.crashHistory = []
      this.state = 'active'
      this.emit('circuit-reset')
    }
  }

  /**
   * 暂停健康检查评估。
   * 健康检查定时器继续运行，但检查结果被忽略。
   * 用于 Electron 侧感知到配置变更将触发 OpenClaw in-process restart 时，
   * 在重启窗口期内避免误判为假死。
   */
  pauseHealthCheck(): void {
    this.healthCheckPaused = true
    this.consecutiveHealthFailures = 0
    mainLogger.info('[Supervisor] Health check paused (config restart window)')
  }

  /**
   * 恢复健康检查评估。
   */
  resumeHealthCheck(): void {
    this.healthCheckPaused = false
    this.consecutiveHealthFailures = 0
    mainLogger.info('[Supervisor] Health check resumed')
  }

  /**
   * 更新 supervisor 跟踪的端口（配置变更时）
   */
  updatePort(port: number): void {
    this.currentPort = port
  }

  /**
   * 获取 supervisor 当前状态
   */
  getStatus(): SupervisorStatus {
    return {
      state: this.state,
      restartCount: this.getRecentCrashCount(),
      nextRetryAt: this.retryTimerId ? this.nextRetryAt : null,
      circuitOpenReason: this.state === 'circuit_open' ? this.circuitOpenReason : null,
      crashHistory: [...this.crashHistory],
      consecutiveHealthFailures: this.consecutiveHealthFailures
    }
  }

  // ==================== Private: Restart Logic ====================

  private nextRetryAt: number | null = null
  private circuitOpenReason: string | null = null

  /**
   * 计算退避延迟：delay = min(base * mult^attempt, max) * (1 ± jitter)
   */
  private calculateDelay(attempt: number): number {
    const rawDelay = Math.min(
      this.baseDelay * Math.pow(this.backoffMultiplier, attempt),
      this.maxDelay
    )
    const jitter = 1 + (Math.random() * 2 - 1) * this.jitterFactor
    return Math.round(rawDelay * jitter)
  }

  /**
   * 安排一次延迟重启
   */
  private scheduleRestart(attempt: number): void {
    if (this.state === 'disabled' || this.state === 'circuit_open') return

    this.state = 'recovering'
    const delay = this.calculateDelay(attempt)
    this.nextRetryAt = Date.now() + delay

    mainLogger.info(
      `[Supervisor] Scheduling restart attempt #${attempt + 1} in ${delay}ms`
    )

    this.emit('restart-scheduled', { delay, attempt: attempt + 1 })

    this.retryTimerId = setTimeout(() => {
      this.retryTimerId = null
      this.nextRetryAt = null
      this.executeRestart()
    }, delay)
  }

  /**
   * 执行重启
   */
  private async executeRestart(): Promise<void> {
    if (this.state === 'disabled' || this.state === 'circuit_open' || !this.restartFn) {
      return
    }

    if (this.isRestarting) {
      mainLogger.warn('[Supervisor] Restart already in progress, skipping')
      return
    }

    this.isRestarting = true
    this.emit('restart-attempt')
    mainLogger.info('[Supervisor] Executing restart...')

    try {
      await this.restartFn()
      // notifyStarted() 会在 service 成功启动后由 ProcessManager 调用
    } catch (error) {
      this.isRestarting = false
      const message = error instanceof Error ? error.message : 'Unknown error'
      mainLogger.error(`[Supervisor] Restart failed: ${message}`)
      this.emit('restart-failed', { error: message })

      // 重启失败也算一次 crash，触发下一次退避
      this.notifyUnexpectedExit(null, null)
    }
  }

  // ==================== Private: Circuit Breaker ====================

  /**
   * 触发熔断
   */
  private openCircuit(reason: string): void {
    this.state = 'circuit_open'
    this.circuitOpenReason = reason
    this.clearRetryTimer()

    mainLogger.error(`[Supervisor] Circuit OPEN: ${reason}`)

    this.emit('circuit-open', {
      reason,
      crashHistory: [...this.crashHistory]
    })
  }

  // ==================== Private: Health Check ====================

  /**
   * 启动运行时周期性健康探测
   */
  private startHealthCheck(): void {
    this.clearHealthCheck()

    if (this.currentPort <= 0) return

    this.healthTimerId = setInterval(async () => {
      if (this.state !== 'active' || this.isRestarting || this.healthCheckPaused) return

      const healthy = await checkHealth(this.currentPort, HEALTH_CHECK_TIMEOUT)

      if (healthy) {
        // 健康检查通过，重置连续失败计数
        if (this.consecutiveHealthFailures > 0) {
          this.consecutiveHealthFailures = 0
        }
        return
      }

      this.consecutiveHealthFailures++
      mainLogger.warn(
        `[Supervisor] Health check failed (${this.consecutiveHealthFailures}/${this.healthFailThreshold})`
      )
      this.emit('health-failure', {
        consecutiveFailures: this.consecutiveHealthFailures
      })

      if (this.consecutiveHealthFailures >= this.healthFailThreshold) {
        mainLogger.error(
          `[Supervisor] Process appears unresponsive after ${this.consecutiveHealthFailures} consecutive health check failures, triggering restart`
        )
        this.consecutiveHealthFailures = 0
        this.clearHealthCheck()
        this.clearStableTimer()
        this.emit('health-restart')

        // 当作意外退出处理，走退避重启流程
        // 但先尝试 stop 再 restart（通过 restartFn）
        this.notifyUnexpectedExit(null, 'HEALTH_CHECK_TIMEOUT')
      }
    }, this.healthCheckInterval)
  }

  // ==================== Private: Stability ====================

  /**
   * 启动稳定性定时器
   * 进程持续运行超过 stableThreshold 后，清空 crash 历史记录
   */
  private startStableTimer(): void {
    this.clearStableTimer()

    this.stableTimerId = setTimeout(() => {
      this.stableTimerId = null
      if (this.state === 'active' && this.crashHistory.length > 0) {
        mainLogger.info(
          `[Supervisor] Process stable for ${this.stableThreshold / 1000}s, resetting crash history`
        )
        this.crashHistory = []
        this.emit('stable')
      }
    }, this.stableThreshold)
  }

  // ==================== Private: Utilities ====================

  /**
   * 清理 retryWindow 之外的 crash 记录
   */
  private pruneOldCrashes(): void {
    const cutoff = Date.now() - this.retryWindow
    this.crashHistory = this.crashHistory.filter((c) => c.timestamp >= cutoff)
  }

  /**
   * 获取当前时间窗口内的 crash 次数
   */
  private getRecentCrashCount(): number {
    const cutoff = Date.now() - this.retryWindow
    return this.crashHistory.filter((c) => c.timestamp >= cutoff).length
  }

  private clearRetryTimer(): void {
    if (this.retryTimerId) {
      clearTimeout(this.retryTimerId)
      this.retryTimerId = null
      this.nextRetryAt = null
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimerId) {
      clearTimeout(this.stableTimerId)
      this.stableTimerId = null
    }
  }

  private clearHealthCheck(): void {
    if (this.healthTimerId) {
      clearInterval(this.healthTimerId)
      this.healthTimerId = null
    }
    this.consecutiveHealthFailures = 0
  }

  private clearAllTimers(): void {
    this.clearRetryTimer()
    this.clearStableTimer()
    this.clearHealthCheck()
  }
}

// 扩展 EventEmitter 类型以支持自定义事件
export interface ProcessSupervisor {
  on(event: 'restart-scheduled', listener: (data: { delay: number; attempt: number }) => void): this
  on(event: 'restart-attempt', listener: () => void): this
  on(event: 'restart-success', listener: () => void): this
  on(event: 'restart-failed', listener: (data: { error: string }) => void): this
  on(event: 'circuit-open', listener: (data: { reason: string; crashHistory: CrashRecord[] }) => void): this
  on(event: 'circuit-reset', listener: () => void): this
  on(event: 'health-failure', listener: (data: { consecutiveFailures: number }) => void): this
  on(event: 'health-restart', listener: () => void): this
  on(event: 'stable', listener: () => void): this
  on(event: string | symbol, listener: (...args: any[]) => void): this

  emit(event: 'restart-scheduled', data: { delay: number; attempt: number }): boolean
  emit(event: 'restart-attempt'): boolean
  emit(event: 'restart-success'): boolean
  emit(event: 'restart-failed', data: { error: string }): boolean
  emit(event: 'circuit-open', data: { reason: string; crashHistory: CrashRecord[] }): boolean
  emit(event: 'circuit-reset'): boolean
  emit(event: 'health-failure', data: { consecutiveFailures: number }): boolean
  emit(event: 'health-restart'): boolean
  emit(event: 'stable'): boolean
  emit(event: string | symbol, ...args: any[]): boolean
}
