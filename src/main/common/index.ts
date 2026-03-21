// ==================== 公共基础设施 ====================

// Logger (日志)
export { mainLogger, rendererLogger, openclawLogger } from './logger.js'

// Config file I/O (JSON5 配置文件读写)
export {
  readConfigFileSync,
  readConfigFile,
  writeConfigFileSync,
  writeConfigFile,
  readConfigField,
  resolveNestedArray,
} from './config-file.js'

// Template merge with protection (模板覆盖 + 用户字段保护)
export { mergeTemplateWithProtection } from './merge-template-with-protection.js'

// Constants (公共常量)
export { LOCALHOST_ADDRESS, APP_STORE_FILE_NAME } from './constants.js'
