import { EventEmitter } from 'events'
import type { ProcessStatus, LogEvent } from '@guanjia-openclaw/shared'
import { checkHealth } from '../server/health-check.js'
import { mainLogger } from '../common/logger.js'
import { EXTERNAL_MONITOR_POLL_INTERVAL_MS } from './constants.js'

/**
 * shared 模式下的外部实例健康轮询器
 *
 * 定期检查外部 OpenClaw 实例健康状态，状态变化时发射事件
 */
export class ExternalInstanceMonitor extends EventEmitter {
  private readonly port: number
  private intervalId: NodeJS.Timeout | null = null
  private lastHealthy: boolean = false

  constructor(port: number) {
    super()
    this.port = port
  }

  start(): void {
    if (this.intervalId) return

    mainLogger.info(`[ExternalMonitor] Starting health polling for port ${this.port}`)

    // Initial check
    void this.poll()

    // Schedule periodic checks
    this.intervalId = setInterval(() => void this.poll(), EXTERNAL_MONITOR_POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      mainLogger.info('[ExternalMonitor] Stopped health polling')
    }
  }

  getStatus(): ProcessStatus {
    return {
      status: this.lastHealthy ? 'running' : 'stopped',
      pid: null as unknown as number, // External process, PID unknown
      uptime: 0, // Unknown
      port: this.port,
    }
  }

  private async poll(): Promise<void> {
    const healthy = await checkHealth(this.port)

    if (healthy !== this.lastHealthy) {
      this.lastHealthy = healthy
      const status = healthy ? 'running' : 'stopped'

      const logEntry: LogEvent = {
        level: 'info',
        message: `[ExternalMonitor] External instance ${status} (port ${this.port})`,
        timestamp: Date.now(),
      }

      this.emit('log', logEntry)
      this.emit('status', this.getStatus())
    }
  }
}

// 扩展类型声明
export interface ExternalInstanceMonitor {
  on(event: 'log', listener: (log: LogEvent) => void): this
  on(event: 'status', listener: (status: ProcessStatus) => void): this
  emit(event: 'log', log: LogEvent): boolean
  emit(event: 'status', status: ProcessStatus): boolean
}
