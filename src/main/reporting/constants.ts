// ==================== RUM 上报 ====================

/** Aegis 项目 ID */
export const RUM_AEGIS_ID = 'zYmXYIzad2el6jj8Qa'

/** Aegis 事件上报端点 */
export const RUM_COLLECT_URL = 'https://aegis.qq.com/collect/events'

/** 主进程事件来源标识 */
export const RUM_FROM_MAIN = 'qclaw://main'

/** 渲染进程事件来源标识 */
export const RUM_FROM_RENDERER = 'qclaw://renderer'

/** ext1 字段最大长度 */
export const RUM_EXT1_MAX_LEN = 256

/** ext2 字段最大长度 */
export const RUM_EXT2_MAX_LEN = 1024

// -------------------- RUM 事件名 --------------------

// --- 崩溃/异常事件 ---
/** 主进程未捕获异常 */
export const RUM_EVENT_MAIN_UNCAUGHT_EXCEPTION = 'main_uncaught_exception'
/** 主进程未处理 Promise 拒绝 */
export const RUM_EVENT_MAIN_UNHANDLED_REJECTION = 'main_unhandled_rejection'
/** 渲染进程崩溃 */
export const RUM_EVENT_RENDERER_PROCESS_GONE = 'renderer_process_gone'
/** 子进程崩溃 */
export const RUM_EVENT_CHILD_PROCESS_GONE = 'child_process_gone'

// --- OpenClaw 进程事件 ---
/** OpenClaw 非预期退出 */
export const RUM_EVENT_OPENCLAW_UNEXPECTED_EXIT = 'openclaw_unexpected_exit'
/** Supervisor 熔断 */
export const RUM_EVENT_OPENCLAW_CIRCUIT_OPEN = 'openclaw_circuit_open'
/** 健康检查失败触发重启 */
export const RUM_EVENT_OPENCLAW_HEALTH_RESTART = 'openclaw_health_restart'

// --- 生命周期事件 ---
/** 应用启动 */
export const RUM_EVENT_APP_LAUNCH = 'app_launch'
/** 应用退出 */
export const RUM_EVENT_APP_QUIT = 'app_quit'
/** OpenClaw 服务启动 */
export const RUM_EVENT_SERVICE_START = 'service_start'
/** OpenClaw 服务停止 */
export const RUM_EVENT_SERVICE_STOP = 'service_stop'
/** 微信登录成功 */
export const RUM_EVENT_LOGIN_SUCCESS = 'login_success'
