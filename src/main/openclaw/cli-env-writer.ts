import fs from 'fs'
import path from 'path'
import os from 'os'

import { getExecNodePath, getOpenClawEntryPath } from './paths.js'
import { QCLAW_META_FILE_NAME, OPENCLAW_STATE_DIR_NAME } from './constants.js'
import { mainLogger } from '../common/index.js'

export interface QClawMeta {
  cli: {
    nodeBinary: string
    openclawMjs: string
    pid: number | null
  }
  stateDir: string
  configPath: string
  port: number
  platform: NodeJS.Platform
}

/**
 * 将 QClaw 运行时元信息写入 ~/.qclaw/qclaw.json
 *
 * 该文件固定写入 ~/.qclaw/ 目录（不随实例模式变化），
 * 供 AI Agent 的 SKILL 脚本读取以构造正确的 CLI 调用命令。
 *
 * 每次 OpenClaw 进程启动成功后调用，确保 PID 等动态信息保持最新。
 */
export function writeQClawMeta(
  stateDir: string,
  configPath: string,
  pid: number | null,
  port: number,
): void {
  const meta: QClawMeta = {
    cli: {
      nodeBinary: getExecNodePath(),
      openclawMjs: getOpenClawEntryPath(),
      pid,
    },
    stateDir,
    configPath,
    port,
    platform: process.platform,
  }

  // 固定写入 ~/.qclaw/ 目录
  const metaDir = path.join(os.homedir(), OPENCLAW_STATE_DIR_NAME)
  fs.mkdirSync(metaDir, { recursive: true })

  const filePath = path.join(metaDir, QCLAW_META_FILE_NAME)
  fs.writeFileSync(filePath, JSON.stringify(meta, null, 2), 'utf-8')

  mainLogger.info(`QClaw meta written to ${filePath} (PID: ${String(pid)})`)
}
