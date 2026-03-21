/**
 * CrashHandler → RUM 事件适配器
 *
 * 将 CrashReport 结构映射为 RUM 事件并上报。
 */

import { mainLogger } from '../common/logger.js'
import type { CrashReport, CrashReporter } from '../crash-handler/index.js'
import { rumReport, formatBytes } from './rum-reporter.js'
import {
  RUM_EVENT_MAIN_UNCAUGHT_EXCEPTION,
  RUM_EVENT_MAIN_UNHANDLED_REJECTION,
  RUM_EVENT_RENDERER_PROCESS_GONE,
  RUM_EVENT_CHILD_PROCESS_GONE,
} from './constants.js'

/** CrashReport.source → RUM 事件名映射 */
const CRASH_SOURCE_EVENT_MAP: Record<string, string> = {
  'uncaughtException': RUM_EVENT_MAIN_UNCAUGHT_EXCEPTION,
  'unhandledRejection': RUM_EVENT_MAIN_UNHANDLED_REJECTION,
  'render-process-gone': RUM_EVENT_RENDERER_PROCESS_GONE,
  'child-process-gone': RUM_EVENT_CHILD_PROCESS_GONE,
}

/**
 * 创建适配 CrashHandler.setReporter() 的 CrashReporter 实现
 *
 * 将 CrashReport 结构映射为 RUM 事件并上报。
 */
export function createRumCrashReporter(): CrashReporter {
  return {
    async upload(report: CrashReport): Promise<boolean> {
      try {
        const eventName = CRASH_SOURCE_EVENT_MAP[report.source] ?? report.source

        let ext1: string
        let ext2: string

        switch (report.source) {
          case 'uncaughtException':
          case 'unhandledRejection':
            ext1 = report.reason
            ext2 = report.stack ?? ''
            break

          case 'render-process-gone':
            ext1 = `reason:${report.reason}|exit:${report.exitCode ?? 'unknown'}`
            ext2 = `gpu_degraded:${report.gpuDegradationTriggered}|reload:${report.rendererReloadAttempted}`
            break

          case 'child-process-gone':
            ext1 = `type:${report.processType}|reason:${report.reason}|exit:${report.exitCode ?? 'unknown'}`
            ext2 = `mem:${formatBytes(report.system.freeMemory)}/${formatBytes(report.system.totalMemory)}|uptime:${Math.floor(report.system.uptime)}s`
            break

          default:
            ext1 = report.reason
            ext2 = report.stack ?? ''
        }

        rumReport({ name: eventName, ext1, ext2 })
        return true
      } catch (err) {
        mainLogger.warn('[RumReporter] Failed to upload crash report:', err)
        return false
      }
    },
  }
}
