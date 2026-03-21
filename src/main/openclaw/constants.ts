import path from 'path'
import os from 'os'

// ==================== 名称常量 ====================

/** 状态目录名（QMOpenclaw 隔离目录） */
export const OPENCLAW_STATE_DIR_NAME = '.qclaw'

/** 外部 OpenClaw CLI 的状态目录名（用于实例检测） */
export const OPENCLAW_EXTERNAL_STATE_DIR_NAME = '.openclaw'

/** 配置文件名 */
export const OPENCLAW_CONFIG_FILE_NAME = 'openclaw.json'

/** 默认端口 */
export const OPENCLAW_GATEWAY_PORT_DEFAULT = 28789

/** 外部 OpenClaw CLI 的默认端口（用于实例检测） */
export const OPENCLAW_EXTERNAL_GATEWAY_PORT_DEFAULT = 18789

// ==================== 路径配置 ====================

/**
 * OpenClaw 状态目录
 *
 * 优先级: OPENCLAW_STATE_DIR > ~/.qmopenclaw
 */
function resolveStateDir(): string {
  if (process.env.OPENCLAW_STATE_DIR) {
    return process.env.OPENCLAW_STATE_DIR
  }
  return path.join(os.homedir(), OPENCLAW_STATE_DIR_NAME)
}

export const OPENCLAW_STATE_DIR = resolveStateDir()

/**
 * OpenClaw 配置文件路径
 *
 * 优先级: OPENCLAW_CONFIG_PATH > OPENCLAW_STATE_DIR/openclaw.json
 */
export const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ?? path.join(OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_FILE_NAME)

/** 配置备份目录 */
export const OPENCLAW_BACKUP_DIR = path.join(path.dirname(OPENCLAW_CONFIG_PATH), 'backups')

// ==================== 网关配置 ====================

/**
 * 默认网关端口
 *
 * 优先级: OPENCLAW_GATEWAY_PORT > 28789
 */
export const OPENCLAW_DEFAULT_GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT
  ? Number(process.env.OPENCLAW_GATEWAY_PORT)
  : OPENCLAW_GATEWAY_PORT_DEFAULT

// ==================== 启动健康等待 ====================

/** 启动时健康等待：最大重试次数（总等待 ≈ RETRIES × INTERVAL ≈ 10min） */
export const OPENCLAW_HEALTH_WAIT_RETRIES = 300

/** 启动时健康等待：重试间隔（毫秒） */
export const OPENCLAW_HEALTH_WAIT_INTERVAL = 2_000

// ==================== 进程管理 ====================

/** 进程启动超时（毫秒） */
export const OPENCLAW_STARTUP_TIMEOUT = 30_000

/** 进程关闭超时（毫秒） */
export const OPENCLAW_SHUTDOWN_TIMEOUT = 5_000

/** 停止后等待延迟（毫秒），确保进程完全退出 */
export const RESTART_DELAY_MS = 100

/** Node.js 启动选项 */
export const NODE_OPTIONS_VALUE = '--no-warnings'

/** 启用标志值 */
export const ENV_VALUE_ENABLED = '1'

// ==================== OpenClaw 服务 ====================

/** ClawHub skills 的外部搜索路径（使用 ~ 前缀，OpenClaw 运行时会自动展开） */
export const OPENCLAW_CLAWHUB_SKILLS_EXTRA_DIRS: readonly string[] = [
  '~/.openclaw/skills',
  '~/.openclaw/workspace/skills',
  '~/.agents/skills',
]

/** 外部插件的搜索路径（使用 ~ 前缀，OpenClaw 运行时会自动展开） */
export const OPENCLAW_EXTERNAL_PLUGIN_EXTRA_DIRS: readonly string[] = [
  '~/.openclaw/extensions',
]

/** 需要强制清除的插件名列表（即使不在 bundled extensions 中也会从用户目录删除） */
export const FORCED_CLEANUP_EXTENSIONS: readonly string[] = [
  'tencent-access',
]

/** bundled 路径的识别后缀，用于按后缀匹配检测已写入的旧路径 */
export const BUNDLED_PATH_SUFFIXES = [
  path.join('openclaw', 'config', 'extensions'),
  path.join('openclaw', 'config', 'skills'),
] as const

/** OpenClaw 入口文件名 */
export const OPENCLAW_ENTRY_FILE = 'openclaw.mjs'

/** QClaw 应用元信息文件名（写入 ~/.qclaw/，供 AI Agent 和外部工具读取） */
export const QCLAW_META_FILE_NAME = 'qclaw.json'

/** OpenClaw 启动命令 */
export const OPENCLAW_COMMAND_GATEWAY = 'gateway'

/** 工作空间子目录名 */
export const WORKSPACE_DIR_NAME = 'workspace'

/** 认证令牌随机字节数（生成 48 字符 hex token） */
export const AUTH_TOKEN_BYTES = 24

// ==================== 实例检测 ====================

/** 外部实例检测：单次健康检查超时（毫秒） */
export const INSTANCE_DETECTION_TIMEOUT_MS = 3000

/** 外部实例重新检测：轮询次数（总等待 ≈ 次数 × 间隔 ≈ 30s） */
export const INSTANCE_RETRY_DETECTION_MAX_ATTEMPTS = 10

/** 外部实例重新检测：轮询间隔（毫秒） */
export const INSTANCE_RETRY_DETECTION_INTERVAL_MS = 3000

/** 外部实例监控轮询间隔（毫秒） */
export const EXTERNAL_MONITOR_POLL_INTERVAL_MS = 30_000

/** Electron 渲染进程必需的 WebSocket 允许来源 */
export const ELECTRON_REQUIRED_ORIGINS: readonly string[] = ['file://', 'null']

/** 实例模式持久化存储键 */
export const STORE_KEY_INSTANCE_MODE = 'instanceMode'

/**
 * 模板合并时需要保护的用户配置路径
 *
 * 这些路径下的值不会被模板覆盖，保留用户自有数据。
 * 路径支持点分隔，精确匹配和祖先匹配：
 * - 'gateway' → 整个 gateway 对象不覆盖
 * - 'models.providers.qclaw.apiKey' → 仅该叶子字段不覆盖
 */
export const PROTECTED_CONFIG_PATHS: readonly string[] = [
  'gateway',                        // 网关配置整体（端口、认证、绑定、tailscale 等）
  'models.providers.qclaw.apiKey',  // 用户认证凭证
  'channels.wechat-access.token',   // 微信登录 token
  'agents.defaults.workspace',      // 用户工作空间路径
  'agents.defaults.model.primary',  // 用户可能自定义模型
  'skills.load.extraDirs',          // 由 ensureExternalExtraDirs / ensureBundledPaths 独立管理
  'plugins.load.paths',             // 同上，避免模板空数组覆盖用户自行添加的路径
]

// re-export 公共常量，保持向后兼容
export { LOCALHOST_ADDRESS } from '../common/constants.js'
