// ==================== OpenClaw 业务管理 ====================

// Process management
export {
  OpenClawService,
  type ServiceConfig,
  type UnexpectedExitData
} from './openclaw-service.js'

export { ProcessManager, getProcessManager } from './process-manager.js'

// Boot sequence
export {
  runBootSequence,
  retryBootSequence,
  initializeWithMode,
  getBootState
} from './boot.js'

// External instance
export { detectExternalInstance } from './instance-detector.js'
export { ExternalInstanceMonitor } from './external-monitor.js'
export { patchExternalConfig, ensureAllowedOriginsForPath } from './config-patcher.js'

// Paths
export {
  getOpenClawPath,
  getConfigPath,
  getDefaultConfigSourcePath,
  getBundledConfigDir,
  getExecNodePath
} from './paths.js'
