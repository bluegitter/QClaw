import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { OPENCLAW_CONFIG_PATH, OPENCLAW_CONFIG_FILE_NAME, OPENCLAW_ENTRY_FILE } from './constants.js'

export function getOpenClawPath(): string {
  if (app.isPackaged) {
    // pnpm deploy 输出: resources/openclaw/node_modules/openclaw
    return path.join(process.resourcesPath, 'openclaw', 'node_modules', 'openclaw')
  }
  // 开发环境: 使用 app.getAppPath() 获取 apps/electron 目录
  // 然后拼接 resources/openclaw/node_modules/openclaw
  const appPath = app.getAppPath()
  return path.join(appPath, 'resources', 'openclaw', 'node_modules', 'openclaw')
}

/**
 * 获取用于 ELECTRON_RUN_AS_NODE 模式的可执行文件路径
 *
 * macOS: 使用 Electron Helper 二进制 (Info.plist 含 LSUIElement=true，不产生 Dock 图标)
 *   打包: AppName.app/Contents/Frameworks/AppName Helper.app/Contents/MacOS/AppName Helper
 *   开发: Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper
 *
 * Windows: 直接使用 process.execPath (无 Dock 图标问题)
 */
export function getExecNodePath(): string {
  if (process.platform === 'darwin') {
    const helperPath = getMacHelperPath()
    if (helperPath && fs.existsSync(helperPath)) {
      return helperPath
    }
    // fallback: 开发环境中 Helper 不存在时直接使用主二进制
  }
  return process.execPath
}

/**
 * 从 process.execPath 推导 macOS Electron Helper 二进制路径
 *
 * process.execPath 格式: .../AppName.app/Contents/MacOS/AppName
 * Helper 格式: .../AppName.app/Contents/Frameworks/AppName Helper.app/Contents/MacOS/AppName Helper
 */
function getMacHelperPath(): string | null {
  const execPath = process.execPath
  // execPath: /path/to/AppName.app/Contents/MacOS/AppName
  const appName = path.basename(execPath)
  const macOSDir = path.dirname(execPath) // .../Contents/MacOS
  const contentsDir = path.dirname(macOSDir) // .../Contents
  const helperAppNames = [`${appName} Helper`, 'Electron Helper']

  for (const helperAppName of helperAppNames) {
    const helperPath = path.join(
      contentsDir,
      'Frameworks',
      `${helperAppName}.app`,
      'Contents',
      'MacOS',
      helperAppName,
    )
    if (fs.existsSync(helperPath)) {
      return helperPath
    }
  }

  return null
}

export function getConfigPath(): string {
  return OPENCLAW_CONFIG_PATH
}

/**
 * 获取内置默认配置模板路径
 * 打包时 resources/openclaw/config/openclaw.json 随 extraResources 一起复制
 *
 * 目录结构:
 *   开发环境: apps/electron/resources/openclaw/config/openclaw.json
 *   生产环境: Resources/openclaw/config/openclaw.json
 */
export function getDefaultConfigSourcePath(): string {
  return path.join(getBundledConfigDir(), OPENCLAW_CONFIG_FILE_NAME)
}

/**
 * 获取内置资源配置目录路径
 * 该目录包含默认配置文件和需要部署到用户目录的资源子目录 (extensions, skills 等)
 *
 * 目录结构:
 *   开发环境: apps/electron/resources/openclaw/config/
 *   生产环境: Resources/openclaw/config/
 */
export function getBundledConfigDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'openclaw', 'config')
  }
  const appPath = app.getAppPath()
  return path.join(appPath, 'resources', 'openclaw', 'config')
}

/**
 * 获取 app 内预装 extensions (plugins) 目录的绝对路径
 * OpenClaw 通过 plugins.load.paths 配置直接引用此路径，无需复制到用户目录
 *
 * 目录结构:
 *   开发环境: apps/electron/resources/openclaw/config/extensions/
 *   生产环境: Resources/openclaw/config/extensions/
 */
export function getBundledExtensionsDir(): string {
  return path.join(getBundledConfigDir(), 'extensions')
}

/**
 * 获取 app 内预装 skills 目录的绝对路径
 * OpenClaw 通过 skills.load.extraDirs 配置直接引用此路径，无需复制到用户目录
 *
 * 目录结构:
 *   开发环境: apps/electron/resources/openclaw/config/skills/
 *   生产环境: Resources/openclaw/config/skills/
 */
export function getBundledSkillsDir(): string {
  return path.join(getBundledConfigDir(), 'skills')
}

export function getManagedSkillsDir(): string {
  return path.join(app.getPath('home'), '.qclaw', 'skills')
}

/**
 * 获取 openclaw.mjs 入口文件的完整路径
 *
 * 目录结构:
 *   开发环境: apps/electron/resources/openclaw/node_modules/openclaw/openclaw.mjs
 *   生产环境: Resources/openclaw/node_modules/openclaw/openclaw.mjs
 */
export function getOpenClawEntryPath(): string {
  return path.join(getOpenClawPath(), OPENCLAW_ENTRY_FILE)
}
