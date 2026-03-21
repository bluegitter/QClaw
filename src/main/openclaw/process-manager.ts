import { EventEmitter } from 'events'
import { OpenClawService, type ServiceConfig } from './openclaw-service.js'
import { ProcessSupervisor, type SupervisorStatus, type CrashRecord } from '../server/process-supervisor.js'
import { ExternalInstanceMonitor } from './external-monitor.js'
import type { ProcessStatus, LogEvent, InstanceMode, RuntimeConfig } from '@guanjia-openclaw/shared'
import { mainLogger } from '../common/logger.js'
import { prepareForStart } from './boot.js'
import {
  OPENCLAW_DEFAULT_GATEWAY_PORT,
  RESTART_DELAY_MS,
} from './constants.js'
import {
  RUM_EVENT_OPENCLAW_UNEXPECTED_EXIT,
  RUM_EVENT_OPENCLAW_CIRCUIT_OPEN,
  RUM_EVENT_OPENCLAW_HEALTH_RESTART,
  RUM_EVENT_SERVICE_START,
  RUM_EVENT_SERVICE_STOP,
} from '../reporting/constants.js'
import { rumReport } from '../reporting/rum-reporter.js'

export class ProcessManager extends EventEmitter {
  private service: OpenClawService | null = null
  private supervisor: ProcessSupervisor | null = null
  private externalMonitor: ExternalInstanceMonitor | null = null
  private mode: InstanceMode | null = null
  private runtimeConfig: RuntimeConfig | null = null
  private isShuttingDown = false

  constructor() {
    super()
    this.setupExitHandlers()
  }

  /**
   * 初始化 ProcessManager
   * 根据运行模式创建 service (isolated) 或 externalMonitor (shared)
   * 必须在 start() 之前调用
   */
  initialize(mode: InstanceMode, config: RuntimeConfig): void {
    if (this.mode !== null) {
      mainLogger.warn('[ProcessManager] Already initialized, skipping')
      return
    }

    this.mode = mode
    this.runtimeConfig = config

    mainLogger.info(`[ProcessManager] Initializing in '${mode}' mode, gateway port: ${config.gatewayPort}`)
    mainLogger.info(`[ProcessManager] Runtime config: stateDir=${config.stateDir}, configPath=${config.configPath}`)

    if (mode === 'shared') {
      this.externalMonitor = new ExternalInstanceMonitor(config.gatewayPort)
      this.setupExternalMonitorListeners()
      this.externalMonitor.start()
    } else {
      const serviceConfig: Partial<ServiceConfig> = {
        stateDir: config.stateDir,
        configPath: config.configPath,
        gatewayPort: config.gatewayPort,
      }
      this.service = new OpenClawService(serviceConfig)
      this.supervisor = new ProcessSupervisor()
      this.setupServiceListeners()
      this.setupSupervisorListeners()
    }
  }

  /**
   * 启动 OpenClaw 服务
   * 启动成功后自动启用 supervisor 监控
   */
  async start(options?: { verbose?: boolean }): Promise<void> {
    if (this.mode === 'shared') {
      mainLogger.info('[ProcessManager] Shared mode — skipping process start (externally managed)')
      return
    }
    if (!this.service) {
      throw new Error('ProcessManager not initialized. Call initialize() first.')
    }
    if (this.isShuttingDown) {
      throw new Error('Application is shutting down')
    }

    mainLogger.info(`[ProcessManager] Starting service in '${this.mode}' mode`)

    // 每次启动前执行模式相关的前置准备（配置补丁、资源部署、冲突消除）
    if (this.mode && this.runtimeConfig) {
      prepareForStart(this.mode, this.runtimeConfig)
    }

    // 用户主动启动时，重置熔断状态
    this.supervisor?.resetCircuit()

    const startBegin = Date.now()
    await this.service.start(options)
    const startupDuration = Date.now() - startBegin

    // 启动成功后启用 supervisor
    if (this.supervisor) {
      const status = this.service.getStatus()
      this.supervisor.enable(
        () => this.supervisedRestart(),
        status.port,
      )
      this.supervisor.notifyStarted(status.port)
    }

    // RUM: 上报服务启动事件
    const startedStatus = this.service.getStatus()
    rumReport({
      name: RUM_EVENT_SERVICE_START,
      ext1: `mode:${this.mode}|port:${startedStatus.port}|startup:${startupDuration}ms`,
    })
  }

  /**
   * 停止 OpenClaw 服务
   * 通知 supervisor 这是主动停止
   */
  async stop(): Promise<void> {
    if (this.mode === 'shared') {
      mainLogger.info('[ProcessManager] Shared mode — skipping process stop')
      return
    }
    if (!this.service) return
    mainLogger.info(`[ProcessManager] Stopping service (mode: '${this.mode}')`)
    this.supervisor?.notifyIntentionalStop()
    await this.service.stop()

    // RUM: 上报服务停止事件
    rumReport({
      name: RUM_EVENT_SERVICE_STOP,
      ext1: `mode:${this.mode}`,
    })
  }

  /**
   * 重启 OpenClaw 服务
   */
  async restart(): Promise<void> {
    if (this.mode === 'shared') {
      mainLogger.info('[ProcessManager] Shared mode — skipping process restart')
      return
    }
    if (!this.service) {
      throw new Error('ProcessManager not initialized. Call initialize() first.')
    }
    if (this.isShuttingDown) {
      throw new Error('Application is shutting down')
    }

    // 每次启动前执行模式相关的前置准备（配置补丁、资源部署、冲突消除）
    if (this.mode && this.runtimeConfig) {
      prepareForStart(this.mode, this.runtimeConfig)
    }

    // 重启期间暂停 supervisor 的健康检查，避免在 stop→start 间隙误判
    this.supervisor?.notifyIntentionalStop()
    await this.service.restart()

    // 重启成功后重新启用 supervisor
    if (this.supervisor) {
      const status = this.service.getStatus()
      this.supervisor.enable(
        () => this.supervisedRestart(),
        status.port,
      )
      this.supervisor.notifyStarted(status.port)
    }
  }

  /**
   * 获取服务状态（融合 supervisor 信息）
   */
  getStatus(): ProcessStatus {
    if (this.mode === 'shared' && this.externalMonitor) {
      return this.externalMonitor.getStatus()
    }

    if (!this.service) {
      return {
        status: 'stopped',
        pid: null as unknown as number,
        uptime: 0,
        port: this.runtimeConfig?.gatewayPort ?? OPENCLAW_DEFAULT_GATEWAY_PORT,
      }
    }

    const serviceStatus = this.service.getStatus()
    const supervisorStatus = this.supervisor?.getStatus()

    // 融合 supervisor 状态到 ProcessStatus
    return {
      ...serviceStatus,
      // 当 service 是 stopped 但 supervisor 在恢复中时，覆盖显示为 recovering
      status: this.getSynthesizedStatus(serviceStatus, supervisorStatus),
      restartCount: supervisorStatus?.restartCount,
      nextRetryAt: supervisorStatus?.nextRetryAt ?? undefined,
      circuitOpenReason: supervisorStatus?.circuitOpenReason ?? undefined,
    }
  }

  /** 获取当前运行模式 */
  getMode(): InstanceMode | null {
    return this.mode
  }

  /** 获取运行时配置 */
  getRuntimeConfig(): RuntimeConfig | null {
    return this.runtimeConfig
  }

  /**
   * 订阅日志事件
   * 可在 initialize() 之前调用（PM 继承 EventEmitter，事件注册在 PM 自身）
   */
  onLog(listener: (log: LogEvent) => void): void {
    this.on('log', listener)
  }

  /**
   * 订阅状态变更事件
   * 可在 initialize() 之前调用
   */
  onStatusChange(listener: (status: ProcessStatus) => void): void {
    this.on('status', listener)
  }

  /**
   * 取消订阅
   */
  off(event: 'log' | 'status', listener: (...args: unknown[]) => void): this {
    return this.removeListener(event, listener)
  }

  /**
   * 暂停 supervisor 健康检查。
   * 用于配置变更触发 OpenClaw in-process restart 时，避免短暂的服务不可用被误判为假死。
   */
  pauseHealthCheck(): void {
    this.supervisor?.pauseHealthCheck()
  }

  /**
   * 恢复 supervisor 健康检查。
   */
  resumeHealthCheck(): void {
    this.supervisor?.resumeHealthCheck()
  }

  /**
   * 标记应用正在关闭
   */
  prepareShutdown(): void {
    this.isShuttingDown = true
  }

  /**
   * 停止服务并清理
   */
  async shutdown(): Promise<void> {
    this.prepareShutdown()

    // 停止外部监视器
    this.externalMonitor?.stop()
    this.externalMonitor?.removeAllListeners()

    // 先禁用 supervisor，防止退出后触发重启
    this.supervisor?.disable()

    if (this.service && this.service.getStatus().status !== 'stopped') {
      this.supervisor?.notifyIntentionalStop()
      await this.service.stop()
    }

    // 移除所有事件监听器
    this.service?.removeAllListeners()
    this.supervisor?.removeAllListeners()
  }

  // ==================== Private ====================

  /**
   * Supervisor 触发的重启回调
   * 与用户手动 restart() 不同：不重置熔断，不通知 intentionalStop
   */
  private async supervisedRestart(): Promise<void> {
    if (this.isShuttingDown || !this.service) return

    // 如果还在运行中（比如假死触发的重启），先停止
    const currentStatus = this.service.getStatus()
    if (currentStatus.status !== 'stopped') {
      // 标记为主动停止，避免 stop 过程中再次触发 unexpected-exit
      this.supervisor?.notifyIntentionalStop()
      await this.service.stop()
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS))
    }

    // 每次启动前执行模式相关的前置准备（配置补丁、资源部署、冲突消除）
    if (this.mode && this.runtimeConfig) {
      prepareForStart(this.mode, this.runtimeConfig)
    }

    await this.service.start()

    // 启动成功后通知 supervisor
    const newStatus = this.service.getStatus()
    this.supervisor?.notifyStarted(newStatus.port)
  }

  /**
   * 综合 service 和 supervisor 状态，返回 UI 应展示的状态
   */
  private getSynthesizedStatus(
    serviceStatus: ProcessStatus,
    supervisorStatus?: SupervisorStatus,
  ): ProcessStatus['status'] {
    // supervisor 熔断时显示 circuit_open
    if (supervisorStatus?.state === 'circuit_open') {
      return 'circuit_open'
    }
    // supervisor 正在恢复且 service 已停止，显示 recovering
    if (supervisorStatus?.state === 'recovering' && serviceStatus.status === 'stopped') {
      return 'recovering'
    }
    // 其他情况直接返回 service 状态
    return serviceStatus.status
  }

  /**
   * 广播融合后的状态
   * 通过 PM 自己的 EventEmitter 发射，IPC 层监听的是 PM 的事件
   */
  private broadcastSynthesizedStatus(): void {
    const synthesized = this.getStatus()
    this.emit('status', synthesized)
  }

  private setupServiceListeners(): void {
    if (!this.service) return

    // 日志事件转发
    this.service.on('log', (log) => {
      const level = log.level === 'warn' ? 'warn' : log.level === 'error' ? 'error' : 'info'
      mainLogger[level]('[OpenClaw]', log.message)
      this.emit('log', log)
    })

    // 状态变更事件转发
    this.service.on('status', () => {
      mainLogger.info('[ProcessManager] Status changed:', this.service?.getStatus().status)
      this.emit('status', this.getStatus())
    })

    // 意外退出事件：转发给 supervisor 进行自动恢复
    this.service.on('unexpected-exit', (data) => {
      mainLogger.warn(
        `[ProcessManager] Unexpected exit detected (code: ${data.code}, signal: ${data.signal}), notifying supervisor`,
      )
      this.supervisor?.notifyUnexpectedExit(data.code, data.signal)

      // RUM 上报 OpenClaw 意外退出
      const serviceStatus = this.service?.getStatus()
      const supervisorStatus = this.supervisor?.getStatus()
      rumReport({
        name: RUM_EVENT_OPENCLAW_UNEXPECTED_EXIT,
        ext1: `code:${data.code ?? 'null'}|signal:${data.signal ?? 'null'}|port:${serviceStatus?.port ?? 'unknown'}|pid:${serviceStatus?.pid ?? 'null'}`,
        ext2: `supervisor:${supervisorStatus?.state ?? 'unknown'}|restarts:${supervisorStatus?.restartCount ?? 0}|uptime:${serviceStatus?.uptime ? Math.floor(serviceStatus.uptime / 1000) + 's' : '0s'}`,
      })

      // 立即广播融合后的状态（可能是 recovering 或 circuit_open）
      this.broadcastSynthesizedStatus()
    })
  }

  private setupExternalMonitorListeners(): void {
    if (!this.externalMonitor) return

    this.externalMonitor.on('log', (log) => {
      mainLogger.info('[ExternalMonitor]', log.message)
      this.emit('log', log)
    })

    this.externalMonitor.on('status', () => {
      this.emit('status', this.getStatus())
    })
  }

  private setupSupervisorListeners(): void {
    if (!this.supervisor) return

    this.supervisor.on('restart-scheduled', ({ delay, attempt }: { delay: number; attempt: number }) => {
      const log: LogEvent = {
        level: 'info',
        message: `[Supervisor] Auto-restart #${attempt} scheduled in ${(delay / 1000).toFixed(1)}s`,
        timestamp: Date.now(),
      }
      this.emit('log', log)
      this.broadcastSynthesizedStatus()
    })

    this.supervisor.on('restart-attempt', () => {
      const log: LogEvent = { level: 'info', message: '[Supervisor] Attempting auto-restart...', timestamp: Date.now() }
      this.emit('log', log)
    })

    this.supervisor.on('restart-success', () => {
      const log: LogEvent = { level: 'info', message: '[Supervisor] Auto-restart succeeded', timestamp: Date.now() }
      this.emit('log', log)
    })

    this.supervisor.on('restart-failed', ({ error }: { error: string }) => {
      const log: LogEvent = { level: 'error', message: `[Supervisor] Auto-restart failed: ${error}`, timestamp: Date.now() }
      this.emit('log', log)
      this.broadcastSynthesizedStatus()
    })

    this.supervisor.on('circuit-open', ({ reason, crashHistory }: { reason: string; crashHistory: CrashRecord[] }) => {
      const log: LogEvent = { level: 'error', message: `[Supervisor] Circuit breaker OPEN: ${reason}`, timestamp: Date.now() }
      this.emit('log', log)
      this.broadcastSynthesizedStatus()

      // RUM 上报熔断事件
      const historyStr = crashHistory
        ? crashHistory.map((c) => `${new Date(c.timestamp).toISOString()}(code:${c.exitCode ?? 'null'},sig:${c.signal ?? 'null'})`).join(',')
        : ''
      rumReport({
        name: RUM_EVENT_OPENCLAW_CIRCUIT_OPEN,
        ext1: `${reason}|restarts:${this.supervisor?.getStatus().restartCount ?? 0}`,
        ext2: historyStr,
      })
    })

    this.supervisor.on('circuit-reset', () => {
      const log: LogEvent = { level: 'info', message: '[Supervisor] Circuit breaker reset', timestamp: Date.now() }
      this.emit('log', log)
    })

    this.supervisor.on('health-failure', ({ consecutiveFailures }: { consecutiveFailures: number }) => {
      const log: LogEvent = {
        level: 'warn',
        message: `[Supervisor] Health check failed (${consecutiveFailures} consecutive)`,
        timestamp: Date.now(),
      }
      this.emit('log', log)
    })

    this.supervisor.on('health-restart', () => {
      const log: LogEvent = { level: 'warn', message: '[Supervisor] Process unresponsive, triggering restart', timestamp: Date.now() }
      this.emit('log', log)

      // RUM 上报健康检查触发的重启
      const svcStatus = this.service?.getStatus()
      const supStatus = this.supervisor?.getStatus()
      rumReport({
        name: RUM_EVENT_OPENCLAW_HEALTH_RESTART,
        ext1: `port:${svcStatus?.port ?? 'unknown'}|pid:${svcStatus?.pid ?? 'null'}|failures:${supStatus?.consecutiveHealthFailures ?? 'unknown'}`,
        ext2: `restarts:${supStatus?.restartCount ?? 0}|uptime:${svcStatus?.uptime ? Math.floor(svcStatus.uptime / 1000) + 's' : '0s'}`,
      })
    })

    this.supervisor.on('stable', () => {
      const log: LogEvent = { level: 'info', message: '[Supervisor] Process stable, crash history reset', timestamp: Date.now() }
      this.emit('log', log)
    })
  }

  private setupExitHandlers(): void {
    // 注意：before-quit 和 window-all-closed 处理器已移至 index.ts
    // 由 TrayManager 统一协调退出流程，避免重复处理

    // 注意：uncaughtException / unhandledRejection 处理器已移至 crash-handler 模块
    // CrashHandler 负责持久化崩溃报告后通过 fatal-error 事件触发优雅关闭

    // 处理进程信号（开发环境）
    if (process.env.NODE_ENV === 'development') {
      process.on('SIGINT', async () => {
        mainLogger.info('[ProcessManager] Received SIGINT, shutting down...')
        await this.shutdown()
        process.exit(0)
      })

      process.on('SIGTERM', async () => {
        mainLogger.info('[ProcessManager] Received SIGTERM, shutting down...')
        await this.shutdown()
        process.exit(0)
      })
    }
  }
}

// 单例实例
let processManagerInstance: ProcessManager | null = null

export function getProcessManager(): ProcessManager {
  if (!processManagerInstance) {
    processManagerInstance = new ProcessManager()
  }
  return processManagerInstance
}
