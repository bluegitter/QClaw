// ==================== 公共基础服务 ====================

// Process supervisor (通用进程守护)
export {
  ProcessSupervisor,
  type SupervisorState,
  type SupervisorStatus,
  type CrashRecord
} from './process-supervisor.js'

// Health check (通用 HTTP 健康检查)
export {
  checkHealth,
  checkHealthWithRetry,
  waitForHealth,
  getHealthStatus,
  type HealthCheckOptions,
  type HealthStatus
} from './health-check.js'

// Config file (通用 JSON5 配置文件读写) — 实际位于 common/，此处 re-export 保持兼容
export {
  readConfigFileSync,
  readConfigFile,
  writeConfigFileSync,
  writeConfigFile,
  readConfigField
} from '../common/config-file.js'

// Configuration management (通用配置管理器)
export { ConfigManager, type ConfigManagerDeps, type ConfigManagerOptions, willTriggerRestart } from './config/index.js'

// Store management (应用本地存储)
export { StoreManager, getStoreManager } from './store/index.js'

// Re-export shared types for convenience
export type {
  ProcessStatus,
  ProcessStatusType,
  LogEvent,
  OpenClawConfig,
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionChunk
} from '@guanjia-openclaw/shared'
