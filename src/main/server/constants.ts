// ==================== 进程 Supervisor ====================

/** Supervisor: 退避初始延迟（毫秒） */
export const SUPERVISOR_BASE_DELAY = 1_000

/** Supervisor: 退避最大延迟（毫秒） */
export const SUPERVISOR_MAX_DELAY = 16_000

/** Supervisor: 退避指数因子 */
export const SUPERVISOR_BACKOFF_MULTIPLIER = 2

/** Supervisor: 退避抖动比例 (±30%) */
export const SUPERVISOR_JITTER_FACTOR = 0.3

/** Supervisor: 时间窗口内最大重试次数 */
export const SUPERVISOR_MAX_RETRIES = 5

/** Supervisor: 重试计数时间窗口（毫秒），5 分钟 */
export const SUPERVISOR_RETRY_WINDOW = 300_000

/** Supervisor: 进程运行超过此时间视为"稳定"，重置重试计数器（毫秒） */
export const SUPERVISOR_STABLE_THRESHOLD = 60_000

/** Supervisor: 运行时健康检查间隔（毫秒） */
export const SUPERVISOR_HEALTH_CHECK_INTERVAL = 30_000

/** Supervisor: 连续健康检查失败多少次后判定假死并触发重启 */
export const SUPERVISOR_HEALTH_FAIL_THRESHOLD = 3

// ==================== 健康检查默认参数 ====================

/** 健康检查端点 */
export const HEALTH_CHECK_ENDPOINT = '/v1/health'

/** 健康检查请求超时（毫秒） */
export const HEALTH_CHECK_TIMEOUT = 5000

/** 健康检查默认重试次数 */
export const HEALTH_CHECK_DEFAULT_RETRIES = 3

/** 健康检查默认重试间隔（毫秒） */
export const HEALTH_CHECK_DEFAULT_RETRY_DELAY_MS = 1000

/** 健康等待默认重试次数 */
export const HEALTH_WAIT_DEFAULT_RETRIES = 30

/** 健康等待默认重试间隔（毫秒） */
export const HEALTH_WAIT_DEFAULT_RETRY_DELAY_MS = 500

// ==================== 备份管理 ====================

/** 配置备份保留数量 */
export const BACKUP_KEEP_COUNT = 5

/** 备份子目录名 */
export const BACKUP_DIR_NAME = 'backups'

// ==================== ConfigManager 默认值 ====================

/** 网关默认绑定地址 */
export const GATEWAY_DEFAULT_BIND = 'loopback'

/** 默认主模型 */
export const DEFAULT_MODEL_PRIMARY = 'claude-sonnet-4.5'

// ==================== 端口释放等待 ====================

/** 端口释放最大等待时间（毫秒） */
export const PORT_RELEASE_MAX_WAIT_MS = 3000

/** 端口释放检查间隔（毫秒） */
export const PORT_RELEASE_CHECK_INTERVAL_MS = 200

/** 进程终止命令超时（毫秒） */
export const PROCESS_KILL_COMMAND_TIMEOUT_MS = 5000
