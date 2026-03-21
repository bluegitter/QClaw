/**
 * RUM (Real User Monitoring) 事件上报模块
 *
 * 基于 Aegis collect/events 接口，统一处理主进程和渲染进程的事件上报。
 * 所有上报均为 fire-and-forget，不阻塞主流程、不重试。
 */

import { app } from 'electron'
import pkg from 'node-machine-id'
const { machineId } = pkg
import type { RumEvent } from '@guanjia-openclaw/shared'
import {
  RUM_AEGIS_ID,
  RUM_COLLECT_URL,
  RUM_FROM_MAIN,
  RUM_EXT1_MAX_LEN,
  RUM_EXT2_MAX_LEN,
} from './constants.js'

// ==================== 内部工具 ====================

/** 截断字符串到指定长度 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

/** 缓存的设备 ID（异步获取，首次上报前可能为空） */
let cachedMachineId = ''
machineId().then((id) => { cachedMachineId = id }).catch(() => {})

/** 构建公共 ext3：版本/平台/架构/环境/主进程运行时长 */
function buildExt3(): string {
  const version = app.getVersion()
  const platform = process.platform
  const arch = process.arch
  const env = app.isPackaged ? 'prod' : 'dev'
  const uptime = Math.floor(process.uptime())
  return `v:${version}|p:${platform}|a:${arch}|env:${env}|up:${uptime}s`
}

/** 将对象编码为 URL 查询字符串 */
function queryStringify(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}

// ==================== 上报函数 ====================

/**
 * 上报 RUM 事件（fire-and-forget）
 *
 * @param event - 事件数据
 * @param from - 来源标识，默认为主进程
 */
export function rumReport(event: RumEvent, from: string = RUM_FROM_MAIN): void {
  try {
    const payload: Record<string, string> = { name: event.name }
    if (event.ext1) payload['ext1'] = truncate(event.ext1, RUM_EXT1_MAX_LEN)
    if (event.ext2) payload['ext2'] = truncate(event.ext2, RUM_EXT2_MAX_LEN)
    if (event.ext3) payload['ext3'] = event.ext3
    else payload['ext3'] = buildExt3()

    const queryObj: Record<string, string> = {
      id: RUM_AEGIS_ID,
      payload: JSON.stringify([payload]),
      from,
    }
    // uin: 用户/设备标识，使用 machineId
    if (cachedMachineId) {
      queryObj['uin'] = cachedMachineId
    }
    const url = `${RUM_COLLECT_URL}?${queryStringify(queryObj)}`

    fetch(url).catch(() => {
      // fire-and-forget: 上报失败静默忽略
    })
  } catch {
    // 上报逻辑不应影响应用正常运行
  }
}

/** 格式化字节数为可读字符串 */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`
  return `${Math.floor(mb)}MB`
}
