import { app, nativeImage, nativeTheme } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

/**
 * 图标资源统一存放在 resources/icons/ 目录下，按类型和平台子目录组织:
 *
 * resources/icons/
 * ├── app/                         应用图标
 * │   ├── mac/icon.icns
 * │   ├── win/icon.ico
 * │   └── linux/icon.png
 * └── tray/                        托盘图标
 *     ├── mac/
 *     │   ├── dark.png             亮色模式使用 (黑色图标)
 *     │   ├── dark@2x.png          亮色模式 Retina
 *     │   ├── light.png            暗色模式使用 (白色图标)
 *     │   └── light@2x.png         暗色模式 Retina
 *     ├── win/tray.ico             Windows 托盘图标 (16x16, 32x32 multi-res)
 *     └── linux/tray.png           Linux 托盘图标 (24x24)
 */

/** 获取图标资源根目录 (resources/icons/) */
function getIconsBaseDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'icons')
  }
  return join(__dirname, '../../resources/icons')
}

/**
 * 获取 macOS 托盘图标
 * 根据系统外观模式选择黑色或白色图标
 */
function getMacTrayIcon(iconsBaseDir: string): Electron.NativeImage {
  const isDark = nativeTheme.shouldUseDarkColors
  // 暗色模式 → 白色图标 (light); 亮色模式 → 黑色图标 (dark)
  const variant = isDark ? 'light' : 'dark'
  const iconPath = join(iconsBaseDir, 'tray', 'mac', `${variant}.png`)

  if (existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath)
  }

  return nativeImage.createEmpty()
}

/**
 * 获取托盘图标
 * macOS: 根据亮色/暗色模式返回对应颜色的图标
 * Windows: 使用 tray/win/tray.ico
 * Linux: 使用 tray/linux/tray.png
 */
export function getTrayIcon(): Electron.NativeImage {
  const iconsBaseDir = getIconsBaseDir()
  const platform = process.platform

  if (platform === 'darwin') {
    return getMacTrayIcon(iconsBaseDir)
  }

  let iconPath: string
  if (platform === 'win32') {
    iconPath = join(iconsBaseDir, 'tray', 'win', 'tray.ico')
  } else {
    iconPath = join(iconsBaseDir, 'tray', 'linux', 'tray.png')
  }

  if (existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath)
  }

  return nativeImage.createEmpty()
}

/**
 * 获取应用图标 (用于 BrowserWindow icon)
 * macOS 使用 app bundle 图标，无需额外设置
 * Windows/Linux 需要显式指定窗口图标
 */
export function getAppIcon(): string | undefined {
  if (process.platform === 'darwin') {
    return undefined
  }

  const iconPath = join(getIconsBaseDir(), 'app', 'linux', 'icon.png')

  return existsSync(iconPath) ? iconPath : undefined
}
