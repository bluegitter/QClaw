/**
 * 安装 / 卸载上报集成模块
 *
 * 在 Electron 主进程中使用 @guanjia-openclaw/report 统一包：
 * - 应用启动时检测安装状态并上报（首次安装 / 升级）
 * - 应用退出前上报卸载事件
 */

import { app } from 'electron'
import { readFileSync } from 'node:fs'
import pkg from 'node-machine-id'
const { machineId } = pkg
import { InstallReporter } from '@guanjia-openclaw/report/server'
import type { InstallChannel } from '@guanjia-openclaw/report'
import { mainLogger } from '../common/logger.js'
import { getChannelFilePath } from '../common/resource-paths.js'
import { OPENCLAW_STATE_DIR } from '../openclaw/constants.js'
import { getEnvUrls } from '@guanjia-openclaw/shared'

/**
 * 读取打包时写入的 channel.json，获取安装渠道号
 *
 * 打包态从 Resources/channel.json 读取，开发态从项目 resources/channel.json 读取。
 * 读取失败时返回 undefined，不阻塞上报流程。
 */
function readInstallChannel(): InstallChannel | undefined {
  try {
    const channelPath = getChannelFilePath()
    const content = readFileSync(channelPath, 'utf-8')
    const data = JSON.parse(content) as { channel?: number }
    return (data.channel as InstallChannel) || undefined
  } catch {
    mainLogger.warn('[InstallReport] 读取 channel.json 失败，使用默认渠道')
    return undefined
  }
}

/**
 * 构建 InstallReporter 实例（内部复用）
 */
async function createInstallReporter(): Promise<InstallReporter> {
  let guid = ''
  try {
    guid = await machineId()
  } catch {
    // machineId 获取失败不阻塞上报
  }

  const channel = readInstallChannel()
  const rawEnv = process.env.BUILD_ENV || 'test'
  const env = rawEnv === 'production' ? 'production' : 'test'
  const baseUrl = getEnvUrls(env).beaconUrl

  return new InstallReporter({
    stateDir: OPENCLAW_STATE_DIR,
    appVersion: app.getVersion(),
    guid,
    baseUrl,
    channel,
    logger: {
      info: (msg: string, ...args: unknown[]) => mainLogger.info(msg, ...args),
      warn: (msg: string, ...args: unknown[]) => mainLogger.warn(msg, ...args),
    },
  })
}

/**
 * 检测安装状态并上报
 *
 * 应在 app.whenReady() 之后、窗口创建前调用。
 * 内部基于标记文件比对版本号，判断是首次安装、升级还是正常启动。
 */
export async function reportInstallEvent(): Promise<void> {
  const reporter = await createInstallReporter()
  await reporter.checkAndReport()
}

/**
 * 上报卸载事件
 *
 * 应在应用退出前调用（before-quit 事件中）。
 * Windows 端由 NSIS 卸载脚本独立上报，此函数主要服务于 macOS 端。
 */
export async function reportUninstallEvent(): Promise<void> {
  const reporter = await createInstallReporter()
  await reporter.reportUninstall()
}
