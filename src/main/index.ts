import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { mainLogger } from './common/logger.js'
import { setupIpcHandlers } from './ipc/index.js'
import { getProcessManager } from './openclaw/index.js'
import { getTrayManager } from './tray/index.js'
import { getAppIcon } from './tray/icons.js'
import {
  UI_DEV_SERVER_URL,
  MAIN_WINDOW_DEFAULT_WIDTH,
  MAIN_WINDOW_DEFAULT_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  MAIN_WINDOW_MIN_HEIGHT,
  APP_USER_MODEL_ID,
  TRAY_TOOLTIP,
} from './constants.js'
import {
  RUM_EVENT_APP_LAUNCH,
  RUM_EVENT_APP_QUIT,
} from './reporting/constants.js'
import { runBootSequence } from './openclaw/boot.js'
import {
  getCrashHandler,
  checkGpuDegradation,
  checkBootCrashFlag,
  setBootInProgressFlag,
  clearBootInProgressFlag,
} from './crash-handler/index.js'
import { createRumCrashReporter } from './reporting/crash-reporter.js'
import { rumReport } from './reporting/rum-reporter.js'
import { reportInstallEvent, reportUninstallEvent } from './reporting/install-reporter.js'

/**
 * UI 资源路径
 * 开发模式：从 ui dev server 加载
 * 生产模式：从打包后的 ui 静态文件加载
 */
// UI_DEV_SERVER_URL imported from constants

/** 主窗口引用，用于托盘恢复窗口 */
let mainWindow: BrowserWindow | null = null

/**
 * 设置应用名称
 * 影响 app.getPath('userData') 的目录名（macOS: ~/Library/Application Support/QMOpenClaw）
 * 必须在 requestSingleInstanceLock() 之前设置，否则单实例锁和 userData 路径不一致
 */
app.name = TRAY_TOOLTIP

/**
 * 单实例锁定
 * 确保应用只能运行一个实例
 * 当第二个实例启动时，聚焦已有窗口并退出第二个实例
 */
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // 获取锁失败，说明已有实例在运行，提示用户后退出
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'QClaw',
      message: '应用已在运行',
      detail: '检测到已有 QClaw 实例正在运行，请先退出已有实例后再启动。',
      buttons: ['确定'],
    })
    app.exit(0)
  })
}

/**
 * 启动安全预检（必须在 app.whenReady() 之前调用，commandLine.appendSwitch 只在 ready 之前生效）
 *
 * 1. checkBootCrashFlag: 检查上次启动是否因原生崩溃中断（标记文件残留 → 禁用 GPU）
 * 2. checkGpuDegradation: 检查 CrashHandler 运行时设置的 GPU 降级标记
 * 3. setBootInProgressFlag: 写入"启动进行中"标记，渲染成功后清除
 */
checkBootCrashFlag()
checkGpuDegradation()
setBootInProgressFlag()

// 当第二个实例启动时，聚焦主窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.show()
    mainWindow.focus()
  }
})

function getUIPath(): string {
  return join(__dirname, '../renderer/index.html')
}

function getDevRendererUrl(): string {
  const rawUrl = process.env['ELECTRON_RENDERER_URL'] || UI_DEV_SERVER_URL
  return rawUrl.replace('://127.0.0.1', '://localhost')
}

function shouldUseDevServer(): boolean {
  return is.dev && Boolean(process.env['ELECTRON_RENDERER_URL'])
}

/**
 * 创建主窗口
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: MAIN_WINDOW_DEFAULT_WIDTH,
    height: MAIN_WINDOW_DEFAULT_HEIGHT,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    // macOS: 使用原生红绿灯控件，隐藏标题栏但保留交通灯按钮
    // Windows: 完全无边框，使用自定义窗口控制按钮
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 16 } }
      : { frame: false, thickFrame: true }),
    backgroundColor: '#ffffff',
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()

    // 渲染进程首屏绘制完成，清除启动标记（证明 GPU 进程正常工作）
    clearBootInProgressFlag()

    // 初始化系统托盘（窗口显示后再创建，确保窗口引用有效）
    getTrayManager().init(mainWindow!)

    // 启动流程编排：检测外部实例 → 确定模式 → 初始化
    runBootSequence(mainWindow!).then(() => {
      // RUM: 上报应用启动事件
      const mode = getProcessManager().getMode() ?? 'unknown'
      rumReport({ name: RUM_EVENT_APP_LAUNCH, ext1: `mode:${mode}` })
    }).catch((error) => {
      mainLogger.error('Boot sequence failed:', error)
    })
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-start-loading', () => {
    mainLogger.info('[Renderer] did-start-loading')
  })

  mainWindow.webContents.on('did-finish-load', () => {
    mainLogger.info('[Renderer] did-finish-load', mainWindow?.webContents.getURL())
  })

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      mainLogger.error(
        '[Renderer] did-fail-load',
        JSON.stringify({
          errorCode,
          errorDescription,
          validatedURL,
          isMainFrame,
        }),
      )
    },
  )

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    mainLogger.error('[Renderer] render-process-gone', JSON.stringify(details))
  })

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const logger = level >= 2 ? mainLogger.error : mainLogger.info
    logger('[RendererConsole]', JSON.stringify({ level, message, line, sourceId }))
  })

  if (shouldUseDevServer()) {
    mainWindow.loadURL(getDevRendererUrl())
  } else {
    mainWindow.loadFile(getUIPath())
  }
}

/**
 * 应用初始化
 */
app.whenReady().then(() => {
  // 设置应用用户模型 ID
  electronApp.setAppUserModelId(APP_USER_MODEL_ID)

  // 初始化崩溃处理（必须在创建窗口之前，确保窗口创建事件被监听）
  const crashHandler = getCrashHandler()
  crashHandler.initialize()

  // 注入 RUM 远程崩溃上报
  crashHandler.setReporter(createRumCrashReporter())

  // 监听致命错误事件，触发优雅关闭
  crashHandler.on('fatal-error', async ({ exitCode }: { error: Error | string; exitCode: number }) => {
    try {
      const processManager = getProcessManager()
      await processManager.shutdown()
    } catch {
      // best effort
    }
    process.exit(exitCode)
  })

  // 注册所有 IPC 处理器
  setupIpcHandlers()

  // 检测安装状态并上报（首次安装 / 升级）
  reportInstallEvent().catch((err) => {
    mainLogger.warn('Install report failed:', err)
  })

  // 应用启动后创建窗口
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)

    // 生产模式下通过 F12 或 Cmd+Option+I 打开 DevTools（用于性能排查）
    // 通过 Cmd+Shift+D (macOS) / Ctrl+Shift+D (Windows/Linux) 切换调试面板
    window.webContents.on('before-input-event', (_, input) => {
      const isMacDevTools = input.meta && input.alt && input.key.toLowerCase() === 'i'
      const isF12 = input.key === 'F12'
      if (isF12 || isMacDevTools) {
        window.webContents.toggleDevTools()
      }

      const isDebugPanel = (input.meta || input.control) && input.shift && input.key.toLowerCase() === 'd'
      if (isDebugPanel) {
        window.webContents.send('debug:togglePanel')
      }
    })
  })

  createWindow()

  // macOS: Dock 点击或应用图标点击时显示已有窗口
  app.on('activate', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      createWindow()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })
})

/**
 * 所有窗口关闭时不退出应用（窗口只是隐藏到托盘）
 * 在 macOS 上，应用通常在窗口关闭后保持打开状态
 * 在 Windows/Linux 上，通过托盘图标继续运行
 */
app.on('window-all-closed', () => {
  // 不执行任何操作 - 应用在托盘中继续运行
})

/**
 * 应用退出前清理
 * 只有 TrayManager.quit() 才会触发真正的退出流程
 */
app.on('before-quit', async (event) => {
  const trayManager = getTrayManager()

  // 非托盘菜单触发的退出（如 macOS Cmd+Q），转由 TrayManager 统一处理
  if (!trayManager.isQuitting) {
    event.preventDefault()
    trayManager.quit()
    return
  }

  // RUM: 上报应用退出事件
  const uptimeSeconds = Math.floor(process.uptime())
  rumReport({ name: RUM_EVENT_APP_QUIT, ext1: `uptime:${uptimeSeconds}s` })

  // 上报卸载事件
  reportUninstallEvent().catch((err) => {
    mainLogger.warn('Uninstall report failed:', err)
  })

  // 停止 OpenClaw 服务
  const processManager = getProcessManager()
  const status = processManager.getStatus()

  if (status.status !== 'stopped') {
    event.preventDefault()
    try {
      await processManager.shutdown()
    } catch (error) {
      mainLogger.error('Error during shutdown:', error)
    }
    trayManager.destroy()
    app.exit(0)
  } else {
    trayManager.destroy()
  }
})
