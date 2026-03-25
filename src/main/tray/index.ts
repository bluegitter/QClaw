import { Tray, Menu, app, nativeTheme } from 'electron'
import type { BrowserWindow } from 'electron'
import { getTrayIcon } from './icons.js'
import { TRAY_TOOLTIP } from '../constants.js'

/**
 * 系统托盘管理器
 *
 * 职责：
 * - 创建系统托盘图标和右键菜单
 * - 拦截窗口关闭事件，改为隐藏到托盘
 * - 管理 isQuitting 标志位，协调退出流程
 */
export class TrayManager {
  private tray: Tray | null = null
  private mainWindow: BrowserWindow | null = null
  private _isQuitting = false
  private themeListenerRegistered = false

  /**
   * 初始化托盘，绑定主窗口
   * 应在 mainWindow ready-to-show 后调用
   */
  init(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow

    // 防止重复创建托盘图标（activate 事件可能导致 createWindow → ready-to-show → init 再次调用）
    if (this.tray && !this.tray.isDestroyed()) {
      return
    }

    this.createTray()
    this.setupWindowCloseHandler()
    this.setupThemeChangeHandler()
  }

  /**
   * 是否正在退出应用
   */
  get isQuitting(): boolean {
    return this._isQuitting
  }

  /**
   * 标记退出并触发 app.quit()
   */
  quit(): void {
    this._isQuitting = true
    app.quit()
  }

  /**
   * 销毁托盘图标
   */
  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private buildContextMenu(): Menu {
    return Menu.buildFromTemplate([
      { label: '显示窗口', click: () => this.showWindow() },
      { type: 'separator' },
      { label: '退出', click: () => this.quit() }
    ])
  }

  private createTray(): void {
    this.tray = new Tray(getTrayIcon())
    this.tray.setToolTip(TRAY_TOOLTIP)

    // 不使用 setContextMenu，否则 macOS 左键也会弹出菜单
    // 改为右键手动弹出，左键打开窗口
    this.tray.on('right-click', () => {
      const menu = this.buildContextMenu()
      this.tray?.popUpContextMenu(menu)
    })

    // 左键单击：打开窗口（所有平台统一行为）
    this.tray.on('click', () => this.showWindow())

    // Windows/Linux: 双击托盘图标也打开窗口
    this.tray.on('double-click', () => this.showWindow())
  }

  /**
   * 监听系统主题变化，动态切换托盘图标
   * macOS 在亮色/暗色模式切换时更新图标颜色
   */
  private setupThemeChangeHandler(): void {
    if (process.platform !== 'darwin' || this.themeListenerRegistered) return

    this.themeListenerRegistered = true

    nativeTheme.on('updated', () => {
      this.tray?.setImage(getTrayIcon())
    })
  }

  /**
   * 拦截窗口关闭：非退出状态下隐藏窗口而非销毁
   */
  private setupWindowCloseHandler(): void {
    this.mainWindow?.on('close', (event) => {
      if (!this._isQuitting) {
        event.preventDefault()
        this.mainWindow?.hide()
      }
    })
  }

  private showWindow(): void {
    if (!this.mainWindow) return

    this.mainWindow.show()
    this.mainWindow.focus()
  }
}

// 单例
let trayManagerInstance: TrayManager | null = null

export function getTrayManager(): TrayManager {
  if (!trayManagerInstance) {
    trayManagerInstance = new TrayManager()
  }
  return trayManagerInstance
}
