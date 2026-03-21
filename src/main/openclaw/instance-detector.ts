import fs from 'fs'
import path from 'path'
import os from 'os'
import type { ExternalInstanceInfo } from '@guanjia-openclaw/shared'
import { checkHealth } from '../server/health-check.js'
import { readConfigField } from '../common/config-file.js'
import {
  OPENCLAW_EXTERNAL_STATE_DIR_NAME,
  OPENCLAW_EXTERNAL_GATEWAY_PORT_DEFAULT,
  OPENCLAW_CONFIG_FILE_NAME,
  INSTANCE_DETECTION_TIMEOUT_MS,
} from './constants.js'

/**
 * 检测系统中是否存在独立运行的外部 OpenClaw 实例
 *
 * 策略:
 * 1. 检查 ~/.openclaw/openclaw.json 是否存在
 * 2. 读取 gateway.port (默认 18789)
 * 3. HTTP GET http://127.0.0.1:{port}/v1/health (超时 3s)
 * 4. 200 OK → detected=true, 否则 → detected=false
 *
 * 只检测外部 OpenClaw CLI 的默认目录 ~/.openclaw, 不检测 QMOpenclaw 隔离实例
 */
export async function detectExternalInstance(): Promise<ExternalInstanceInfo> {
  const configDir = path.join(os.homedir(), OPENCLAW_EXTERNAL_STATE_DIR_NAME)
  const configPath = path.join(configDir, OPENCLAW_CONFIG_FILE_NAME)

  // 检查配置文件是否存在
  if (!fs.existsSync(configPath)) {
    return { detected: false }
  }

  // 读取端口
  const port = readConfigField<number>(configPath, 'gateway.port') ?? OPENCLAW_EXTERNAL_GATEWAY_PORT_DEFAULT

  // 健康检查
  const healthy = await checkHealth(port, INSTANCE_DETECTION_TIMEOUT_MS)

  return {
    detected: healthy,
    port,
    healthy,
    configDir,
  }
}
