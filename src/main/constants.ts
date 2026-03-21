// ==================== 窗口配置 ====================

/** UI 开发服务器地址 */
export const UI_DEV_SERVER_URL = 'http://localhost:5175'

/** 主窗口默认宽度 */
export const MAIN_WINDOW_DEFAULT_WIDTH = 1200

/** 主窗口默认高度 */
export const MAIN_WINDOW_DEFAULT_HEIGHT = 800

/** 主窗口最小宽度 */
export const MAIN_WINDOW_MIN_WIDTH = 800

/** 主窗口最小高度 */
export const MAIN_WINDOW_MIN_HEIGHT = 600

/** 应用用户模型 ID */
export const APP_USER_MODEL_ID = 'com.tencent.qclaw'

// ==================== 日志配置 ====================

/** 日志保留天数 */
export const LOG_RETENTION_DAYS = 30

/** 日志子目录名 */
export const LOG_SUBDIRS = ['main', 'renderer', 'openclaw', 'crash'] as const

/** IPC 日志环形缓冲区容量 */
export const LOG_BUFFER_CAPACITY = 500

// ==================== 系统托盘 ====================

/** 托盘提示文字 */
export const TRAY_TOOLTIP = 'QClaw'

// ==================== 崩溃处理 ====================

/** 崩溃报告存储子目录名（位于 app logs 目录下） */
export const CRASH_REPORT_DIR_NAME = 'crash'

/** 崩溃报告最大保留数量 */
export const CRASH_REPORT_MAX_COUNT = 50

/** GPU 降级标记文件名（位于 userData 目录） */
export const GPU_DEGRADATION_FLAG_FILE = 'gpu-degradation.flag.json'

/** 启动进行中标记文件名（位于 userData 目录），用于检测原生崩溃 */
export const BOOT_IN_PROGRESS_FLAG_FILE = 'boot-in-progress.flag'

/** 渲染进程 reload：时间窗口内最大重试次数 */
export const RENDERER_RELOAD_MAX_RETRIES = 3

/** 渲染进程 reload：限速时间窗口（毫秒） */
export const RENDERER_RELOAD_WINDOW_MS = 60_000

/** 渲染进程 reload：reload 前延迟（毫秒） */
export const RENDERER_RELOAD_DELAY_MS = 500
