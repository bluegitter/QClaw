import log from 'electron-log/main'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import { LOG_RETENTION_DAYS, LOG_SUBDIRS } from '../constants.js'

// 初始化 electron-log，注册 IPC 通道（renderer 日志自动转发到主进程）
log.initialize()

const isDev = !app.isPackaged

// 渲染进程 logger
const rendererLogger = log.create({ logId: 'renderer' })

// OpenClaw 进程 logger
const openclawLogger = log.create({ logId: 'openclaw' })

if (isDev) {
  // 开发环境：禁用文件写入，只输出到 console
  log.transports.file.level = false
  rendererLogger.transports.file.level = false
  openclawLogger.transports.file.level = false
} else {
  // 生产环境：按天轮转写入不同子目录
  const logsDir = app.getPath('logs')

  /** 获取当天日期字符串 YYYY-MM-DD */
  function getTodayDate(): string {
    return new Date().toISOString().slice(0, 10)
  }

  /** 生成按天轮转的日志文件路径 */
  function dailyLogPath(subdir: string): string {
    return path.join(logsDir, subdir, `${getTodayDate()}.log`)
  }

  log.transports.file.resolvePathFn = () => dailyLogPath('main')
  rendererLogger.transports.file.resolvePathFn = () => dailyLogPath('renderer')
  openclawLogger.transports.file.resolvePathFn = () => dailyLogPath('openclaw')

  /**
   * 清理过期日志文件
   * 删除各子目录中超过 LOG_RETENTION_DAYS 天的 .log 文件
   */
  function cleanExpiredLogs(): void {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000

    for (const subdir of LOG_SUBDIRS) {
      const dir = path.join(logsDir, subdir)
      if (!fs.existsSync(dir)) continue

      try {
        const files = fs.readdirSync(dir)
        for (const file of files) {
          // 匹配 YYYY-MM-DD.log 格式
          const match = file.match(/^(\d{4}-\d{2}-\d{2})\.log$/)
          if (!match) continue

          const fileDate = new Date(match[1]!).getTime()
          if (fileDate < cutoff) {
            fs.unlinkSync(path.join(dir, file))
          }
        }
      } catch {
        // 清理失败不影响主流程
      }
    }
  }

  // 应用启动时执行一次清理
  cleanExpiredLogs()
}

export { log as mainLogger, rendererLogger, openclawLogger }
