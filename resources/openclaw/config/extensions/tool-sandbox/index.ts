/**
 * tool-sandbox — 工具执行沙箱插件
 *
 * 核心机制：通过 before_tool_call 钩子改写 params.command，
 * 将原始命令包装为 lowpriv wrapper 调用，在低权限沙箱中执行。
 *
 * ★ 平台支持：
 * - Windows: 完整降权支持（lowpriv-launcher.exe，Low Integrity Level）
 * - macOS: 暂不支持降权（lowpriv-exec.sh 未实现），插件仅保留 blockPatterns
 *   高危命令拦截和审计日志能力，exec 命令不做降权包装
 *
 * 设计原则：
 * - 仅对 exec 类工具（bash_tool / execute_command）进行命令改写（仅限 Windows）
 * - blockPatterns 高危命令拦截在所有平台上生效
 * - 对 read_file / search 等只读工具放行
 * - 降权失败时（wrapper 不存在）回退到正常执行 + stderr 告警
 *
 * 动态开关机制（★ 无需重启进程即可生效）：
 * - 插件在每次 before_tool_call 时从 app-store.json 实时读取 toolSandbox.enabled
 * - 使用 5 秒 TTL 缓存避免频繁磁盘 IO
 * - 用户在 UI 切换开关 → Electron 写 app-store.json → 插件最多 5 秒后感知变更
 * - 环境变量 QCLAW_TOOL_LOWPRIV 仍作为初始值，app-store.json 优先级更高
 *
 * 环境变量（由 Electron createCleanEnv() 注入，仅 Windows）：
 * - QCLAW_TOOL_LOWPRIV=1               降权总开关（初始值，运行时以 app-store.json 为准）
 * - QCLAW_TOOL_WRAPPER_PATH=path       wrapper 可执行文件路径
 * - QCLAW_WRITABLE_DIRS=path           可写目录白名单（分隔符 = path.delimiter）
 * - QCLAW_TOOL_SANDBOX_LEVEL=level     降权级别（standard/strict/custom）
 * - QCLAW_APP_STORE_PATH=path          app-store.json 完整路径（用于实时读取开关状态）
 */

const LOG_TAG = 'tool-sandbox'

// ---- 动态配置读取（从 app-store.json 实时感知开关变更，无需重启进程）----

/**
 * 从 app-store.json 实时读取 toolSandbox.enabled 状态
 *
 * 设计目的：用户在 UI 上切换"工具权限限制"开关后，无需重启 OpenClaw 进程即可生效。
 * 环境变量 QCLAW_TOOL_LOWPRIV 仍然作为"初始值"在 register() 时使用，
 * 但运行时以 app-store.json 文件内容为准（文件优先于环境变量）。
 *
 * 性能策略：5 秒 TTL 缓存，避免每次 tool call 都读文件。
 * 对于连续的 tool call（典型间隔 100ms-2s），最多 5 秒内只读一次磁盘。
 * 用户切换开关后最多 5 秒生效，UX 可接受。
 */
const SECURITY_CONFIG_CACHE_TTL_MS = 5_000

interface SecurityConfigCache {
  enabled: boolean
  timestamp: number
}

let _securityConfigCache: SecurityConfigCache | null = null

function readToolSandboxEnabledFromFile(appStorePath: string | undefined): boolean | null {
  if (!appStorePath) return null

  // 检查缓存是否仍然有效
  if (_securityConfigCache && (Date.now() - _securityConfigCache.timestamp) < SECURITY_CONFIG_CACHE_TTL_MS) {
    return _securityConfigCache.enabled
  }

  try {
    // 使用 Node.js 内置 fs，OpenClaw 运行时环境中可用
    const fs = require('fs')

    if (!fs.existsSync(appStorePath)) {
      return null // 文件不存在，回退到环境变量
    }

    const raw = fs.readFileSync(appStorePath, 'utf-8')
    const config = JSON.parse(raw)
    const enabled = config?.toolSandbox?.enabled

    if (typeof enabled === 'boolean') {
      _securityConfigCache = { enabled, timestamp: Date.now() }
      return enabled
    }

    return null // 字段不存在或类型不对，回退到环境变量
  } catch {
    return null // 读取/解析失败，回退到环境变量
  }
}

// ---- 类型定义 ----

interface ToolCallEvent {
  toolName: string
  toolCallId: string
  params: Record<string, unknown>
  result?: { content: string }
}

interface HookContext {
  agentId: string
  sessionKey: string
}

interface BeforeToolCallResult {
  block?: boolean
  blockReason?: string
  params?: Record<string, unknown>
}

// ---- 工具分类辅助函数 ----

function isExecTool(name: string): boolean {
  // OpenClaw 运行时注册的工具名是 "exec"（CORE_TOOL_DEFINITIONS.id = "exec"）
  // "bash" 是 "exec" 的别名（TOOL_NAME_ALIASES: { bash: "exec" }）
  // 保留 bash_tool / execute_command 作为兼容（文档中曾使用这些名称）
  return name === 'exec' || name === 'bash' || name === 'bash_tool' || name === 'execute_command'
}

// ---- 外部程序启动检测（跳过降权）----

/**
 * 检测命令是否主要目的是「启动外部应用程序」
 *
 * 这类命令不应该被降权包装，因为：
 * 1. lowpriv-launcher 会使整条命令在 Low IL 下运行
 * 2. 被 spawn 出的子进程继承 Low IL，导致 .exe 程序权限不足、运行异常
 * 3. 启动外部程序本身不是危险操作，真正的安全风险由 blockPatterns 拦截
 *
 * 检测策略（按平台）：
 *
 * Windows (PowerShell):
 *   - Start-Process / start / saps（PowerShell 别名）
 *   - Invoke-Item / ii（打开文件关联的程序）
 *   - explorer.exe（文件管理器/打开目录）
 *   - cmd /c start（传统启动方式）
 *   - [Diagnostics.Process]::Start()（.NET API）
 *   - 直接以 .exe 路径开头的命令（如 "notepad.exe xxx"）—— 暂不检测，因为太宽泛
 *
 * macOS:
 *   - open（系统命令，打开应用/文件/URL）
 *   - /Applications/xxx.app（直接应用路径）
 */
function isAppLaunchCommand(command: string): boolean {
  const trimmed = command.trim()

  if (process.platform === 'win32') {
    // PowerShell: Start-Process / start / saps（忽略大小写）
    // 注意 "start" 也是 PowerShell 中 Start-Process 的别名
    // 匹配模式：命令以这些关键词开头，后面跟空格或引号或行尾
    if (/^(Start-Process|saps)\s/i.test(trimmed)) return true
    // "start" 比较特殊，需要排除 "start-xxx" 等其他命令
    if (/^start\s+(?!-)/i.test(trimmed)) return true

    // PowerShell: Invoke-Item / ii
    if (/^(Invoke-Item|ii)\s/i.test(trimmed)) return true

    // explorer.exe（打开文件管理器/目录/URL）
    if (/^explorer(\.exe)?\s/i.test(trimmed)) return true

    // cmd /c start（传统方式）
    if (/^cmd\s+\/c\s+start\s/i.test(trimmed)) return true

    // .NET [Diagnostics.Process]::Start()
    if (/\[(?:System\.)?Diagnostics\.Process\]::Start\s*\(/i.test(trimmed)) return true

    // & 'path\to\xxx.exe'（PowerShell 调用外部 exe，不含 shell 命令）
    // 仅匹配 & 后直接跟 .exe 路径的简单形式
    if (/^&\s+['"]?[^'"]*\.exe['"]?\s*$/i.test(trimmed)) return true

  } else if (process.platform === 'darwin') {
    // macOS: open 命令
    if (/^open\s/i.test(trimmed)) return true

    // 直接调用 .app bundle
    if (/^(\/Applications\/|~\/Applications\/).*\.app/i.test(trimmed)) return true
  }

  return false
}

function isWriteTool(name: string): boolean {
  // OpenClaw 运行时注册的工具名是 "write"（CORE_TOOL_DEFINITIONS.id = "write"）
  // "write_file" 是 "write" 的别名（TOOL_NAME_ALIASES: { write_file: "write" }）
  // "edit" 是文件编辑工具的实际注册名
  // 保留 file_editor 作为兼容（文档中曾使用此名称）
  return name === 'write' || name === 'edit' || name === 'write_file' || name === 'file_editor'
}

// ---- 降权级别参数映射 ----

/**
 * 根据降权级别获取 Windows lowpriv-launcher.exe 的命令行参数
 *
 * | 级别     | Low IL | Job Object | Restricted Token |
 * |----------|--------|------------|------------------|
 * | standard | ✅     | ✅         | ❌               |
 * | strict   | ✅     | ✅         | ✅               |
 * | custom   | ✅     | ✅         | ✅               |
 */
function getWindowsLauncherArgs(level: string): string {
  switch (level) {
    case 'strict':
    case 'custom':
      return '--low-il --restricted-token --job-object'
    case 'standard':
    default:
      return '--low-il --job-object'
  }
}

// ---- PowerShell 路径动态解析 ----

/**
 * 动态获取 PowerShell 可执行文件的完整路径
 *
 * 为什么需要完整路径：
 *   lowpriv-launcher.exe 通过 CreateProcessAsUser / CreateProcessW 创建子进程，
 *   当 lpApplicationName=nullptr 时，系统从 cmdLine 的第一个 token 搜索可执行文件。
 *   搜索范围依赖 PATH 环境变量，但在 Low IL token 或某些受限环境下，
 *   PATH 可能被修改或丢失，导致 "powershell.exe" 无法被找到（错误码 2: ERROR_FILE_NOT_FOUND）。
 *   使用完整路径可以完全绕过 PATH 搜索，确保在任何权限级别下都能正确启动。
 *
 * 解析策略（按优先级）：
 *   1. 检查 %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe（标准安装路径）
 *   2. 检查 %SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe（32位兼容）
 *   3. 回退到裸名 "powershell.exe"（依赖 PATH，作为最后手段）
 *
 * 缓存策略：路径在进程生命周期内不会变化，首次解析后缓存结果。
 */
let _resolvedPowerShellPath: string | null = null

function resolvePowerShellPath(): string {
  if (_resolvedPowerShellPath !== null) {
    return _resolvedPowerShellPath
  }

  const fs = require('fs')
  const path = require('path')
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'

  // 候选路径列表（按优先级排序）
  const candidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        _resolvedPowerShellPath = candidate
        console.log(`[${LOG_TAG}] resolved PowerShell path: ${candidate}`)
        return candidate
      }
    } catch {
      // 访问失败（权限等），继续尝试下一个
    }
  }

  // 所有候选路径都不存在，回退到裸名（依赖 PATH）
  console.warn(`[${LOG_TAG}] PowerShell not found at standard paths, falling back to "powershell.exe"`)
  _resolvedPowerShellPath = 'powershell.exe'
  return _resolvedPowerShellPath
}

// ---- 跨平台命令包装 ----

/**
 * 按当前平台包装命令
 *
 * 目前仅 Windows 支持降权包装（lowpriv-launcher.exe）。
 * macOS 暂不支持降权，不应到达此函数（上层已通过 wrapperPath 为空跳过）。
 *
 * Windows: wrapperPath 指向 lowpriv-launcher.exe
 *   改写后的命令由 PowerShell 执行:
 *   & 'launcher.exe' <level-args> -- "C:\Windows\System32\...\powershell.exe" -NoProfile -NonInteractive -Command '原始命令'
 *
 * @returns 包装后的命令字符串，null 表示无法包装（调用方应放行原始命令）
 */
function wrapCommandForPlatform(command: string, wrapperPath: string, level: string): string | null {
  if (process.platform === 'win32') {
    return wrapCommandWindows(command, wrapperPath, level)
  }
  return null // 非 Windows 平台不支持，放行
}

/**
 * Windows 命令包装
 *
 * OpenClaw getShellConfig() 在 Windows 上使用 PowerShell，所以改写后的命令
 * 会被 PowerShell 执行。使用 & 调用外部 exe。
 *
 * ★ 使用动态解析的 PowerShell 完整路径，避免在 Low IL 环境下因 PATH 丢失
 *   导致 CreateProcessAsUser / CreateProcessW 返回 ERROR_FILE_NOT_FOUND (2)。
 *
 * 转义策略：PowerShell 单引号内只需将 ' 转义为 ''
 */
function wrapCommandWindows(command: string, wrapperPath: string, level: string): string {
  const escapedCommand = command.replace(/'/g, "''")
  const launcherArgs = getWindowsLauncherArgs(level)
  const psPath = resolvePowerShellPath()
  return `& '${wrapperPath}' ${launcherArgs} -- "${psPath}" -NoProfile -NonInteractive -Command '${escapedCommand}'`
}

// ---- 系统保护路径（模拟 Low Integrity Level 写入限制）----

/**
 * 构建当前平台下低权限进程不能写入的系统保护路径列表
 *
 * Windows Low Integrity Level 限制：
 *   Low IL 进程无法写入任何标记为 Medium 或更高完整性级别的目录/文件。
 *   Windows 默认以下路径均为 Medium IL：
 *   - %SystemRoot% (C:\Windows)
 *   - %ProgramFiles% / %ProgramFiles(x86)%
 *   - %USERPROFILE% 下的大部分目录 (Desktop, Documents, AppData 等)
 *   - 其他用户的 profile 目录 (C:\Users\*)
 *
 *   Low IL 进程默认只能写入：
 *   - %LOCALAPPDATA%\Low (专用低完整性目录)
 *   - %USERPROFILE%\AppData\LocalLow
 *   - 由 lowpriv-launcher --writable-dir 预授权的目录 (QCLAW_WRITABLE_DIRS)
 *   - %TEMP%\Low (如果存在)
 *
 * macOS sandbox-exec 限制（当 QCLAW_TOOL_SANDBOX=1 时）：
 *   - /System, /usr (除 /usr/local), /bin, /sbin 等系统目录
 *   - ~/Library 下大部分子目录
 *   - 其他用户的 home 目录
 *
 * 此函数返回的路径列表用于 write_file / file_editor 的拦截检查，
 * 确保这两个工具的行为与 bash_tool（经 lowpriv wrapper 降权后）保持一致。
 */
function buildSystemDenyPaths(): string[] {
  const paths: string[] = []

  if (process.platform === 'win32') {
    // --- Windows 系统保护路径 ---

    // 系统根目录（C:\Windows）
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:/Windows'
    paths.push(normalizePath(systemRoot))

    // Program Files（两个版本）
    const programFiles = process.env.ProgramFiles || 'C:/Program Files'
    paths.push(normalizePath(programFiles))
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)'
    paths.push(normalizePath(programFilesX86))

    // ProgramData（C:\ProgramData，系统级应用数据）
    const programData = process.env.ProgramData || 'C:/ProgramData'
    paths.push(normalizePath(programData))

    // 用户 profile 下的受保护目录
    const userProfile = process.env.USERPROFILE
    if (userProfile) {
      const up = normalizePath(userProfile)
      // Desktop, Documents, Downloads, Pictures, Videos, Music, Favorites, Links
      // 这些目录都是 Medium IL，Low IL 进程不能写入
      // ★ 所有子路径必须经过 normalizePath（Windows 下转小写），否则 startsWith 比较会失败
      paths.push(normalizePath(`${up}/Desktop`))
      paths.push(normalizePath(`${up}/Documents`))
      paths.push(normalizePath(`${up}/Downloads`))
      paths.push(normalizePath(`${up}/Pictures`))
      paths.push(normalizePath(`${up}/Videos`))
      paths.push(normalizePath(`${up}/Music`))
      paths.push(normalizePath(`${up}/Favorites`))
      paths.push(normalizePath(`${up}/Links`))
      paths.push(normalizePath(`${up}/Saved Games`))
      paths.push(normalizePath(`${up}/Searches`))
      paths.push(normalizePath(`${up}/Contacts`))

      // .ssh, .gnupg 等敏感目录（这些本身是小写，但为一致性也经过 normalizePath）
      paths.push(normalizePath(`${up}/.ssh`))
      paths.push(normalizePath(`${up}/.gnupg`))
      paths.push(normalizePath(`${up}/.aws`))
      paths.push(normalizePath(`${up}/.azure`))
      paths.push(normalizePath(`${up}/.kube`))
      paths.push(normalizePath(`${up}/.docker`))
    }

    // AppData 下的受保护子目录
    const appData = process.env.APPDATA       // Roaming
    const localAppData = process.env.LOCALAPPDATA // Local
    if (appData) {
      // Roaming 整体受保护（包含浏览器 profile、各种 app 配置）
      paths.push(normalizePath(appData))
    }
    if (localAppData) {
      // Local 整体受保护，但 LocalLow 是 Low IL 可写的
      // 所以我们保护 Local 但排除 LocalLow（排除逻辑在 allowWritePaths 中处理）
      paths.push(normalizePath(localAppData))
    }

    // 其他用户的目录（C:\Users\* 除当前用户）
    // 我们用 C:/Users 作为保护根，然后在 allowWritePaths 中豁免当前用户的可写区域
    const usersDir = systemRoot ? normalizePath(systemRoot).replace(/\/windows$/i, '/Users') : 'C:/Users'
    paths.push(usersDir)

    // 驱动器根目录保护（防止写入 C:\ 根目录下的文件）
    // 注意：不能保护 C:/ 本身，否则所有路径都会被阻断
    // 改为保护根目录下的关键文件/目录
    // ★ 必须经过 normalizePath（Windows 下转小写）
    paths.push(normalizePath('C:/boot'))
    paths.push(normalizePath('C:/bootmgr'))
    paths.push(normalizePath('C:/Recovery'))

  } else if (process.platform === 'darwin') {
    // --- macOS 系统保护路径 ---
    paths.push('/System')
    paths.push('/usr/bin')
    paths.push('/usr/sbin')
    paths.push('/usr/lib')
    paths.push('/bin')
    paths.push('/sbin')
    paths.push('/Library')
    paths.push('/private/var')
    paths.push('/private/etc')

    const home = process.env.HOME
    if (home) {
      paths.push(`${home}/Library`)
      paths.push(`${home}/Desktop`)
      paths.push(`${home}/Documents`)
      paths.push(`${home}/Downloads`)
      paths.push(`${home}/Pictures`)
      paths.push(`${home}/Movies`)
      paths.push(`${home}/Music`)
      paths.push(`${home}/.ssh`)
      paths.push(`${home}/.gnupg`)
      paths.push(`${home}/.aws`)
      paths.push(`${home}/.azure`)
      paths.push(`${home}/.kube`)
      paths.push(`${home}/.docker`)
    }
  }

  return paths
}

/**
 * 构建允许写入的路径列表（豁免列表）
 *
 * 即使路径匹配了 denyWritePaths，如果同时匹配 allowWritePaths 则放行。
 * 这模拟了 lowpriv-launcher 的 --writable-dir 预授权行为。
 *
 * 默认包含：
 * - QCLAW_WRITABLE_DIRS 环境变量中的目录（由 Electron 注入，lowpriv-launcher 也读取）
 * - Windows: %LOCALAPPDATA%Low（Low IL 的默认可写区域）
 * - Windows: %USERPROFILE%\AppData\LocalLow（Low IL 的默认可写区域）
 * - 临时目录
 */
function buildAllowWritePaths(): string[] {
  const paths: string[] = []

  // 从环境变量读取 lowpriv-launcher 预授权的可写目录
  const envWritableDirs = process.env.QCLAW_WRITABLE_DIRS
  if (envWritableDirs) {
    const delimiter = process.platform === 'win32' ? ';' : ':'
    for (const dir of envWritableDirs.split(delimiter)) {
      if (dir.trim()) {
        paths.push(normalizePath(dir.trim()))
      }
    }
  }

  // OpenClaw 状态目录（如果有）
  const stateDir = process.env.OPENCLAW_STATE_DIR
  if (stateDir) {
    paths.push(normalizePath(stateDir))
  }

  if (process.platform === 'win32') {
    // Windows Low IL 默认可写目录
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      paths.push(normalizePath(localAppData + '/Low'))
    }

    const userProfile = process.env.USERPROFILE
    if (userProfile) {
      paths.push(normalizePath(userProfile + '/AppData/LocalLow'))
    }
  }

  // 临时目录（两个平台都需要）
  const tmpDir = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp'
  paths.push(normalizePath(tmpDir))

  return paths
}

/** 统一路径为正斜杠小写形式（Windows 路径大小写不敏感） */
function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 检查 filePath 是否被 denyPaths 阻止且不在 allowPaths 豁免中 */
function isPathDenied(filePath: string, denyPaths: string[], allowPaths: string[]): boolean {
  const normalized = process.platform === 'win32'
    ? filePath.replace(/\\/g, '/').toLowerCase()
    : filePath.replace(/\\/g, '/')

  console.log(`[${LOG_TAG}][isPathDenied] input="${filePath}" → normalized="${normalized}"`)
  console.log(`[${LOG_TAG}][isPathDenied] allowPaths (${allowPaths.length}): ${allowPaths.join(', ')}`)
  console.log(`[${LOG_TAG}][isPathDenied] denyPaths (${denyPaths.length}): ${denyPaths.join(', ')}`)

  // 先检查是否在豁免列表中
  for (const allow of allowPaths) {
    if (normalized.startsWith(allow)) {
      console.log(`[${LOG_TAG}][isPathDenied] ALLOW HIT: "${normalized}" startsWith "${allow}" →放行`)
      return false // 豁免，放行
    }
  }
  console.log(`[${LOG_TAG}][isPathDenied] no allow match`)

  // 再检查是否在拒绝列表中
  for (const deny of denyPaths) {
    if (normalized.startsWith(deny)) {
      console.log(`[${LOG_TAG}][isPathDenied] DENY HIT: "${normalized}" startsWith "${deny}" → 拦截`)
      return true // 被阻断
    }
  }

  console.log(`[${LOG_TAG}][isPathDenied] no deny match → 放行`)
  return false // 不在拒绝列表中，放行
}

// ---- 插件定义 ----

const plugin = {
  id: 'tool-sandbox',
  name: '工具执行沙箱',
  description: '工具执行降权 — params 改写 + 外部 wrapper',

  register(api: any) {
    // ★ macOS 下完全屏蔽插件：不注册任何钩子，插件等于不存在
    if (process.platform === 'darwin') {
      console.log(`[${LOG_TAG}] skipped on macOS — plugin disabled for this platform`)
      return
    }

    const config = api.pluginConfig || {}

    // 从环境变量读取不变的基础设施参数（由 Electron createCleanEnv 注入）
    // 这些参数在进程生命周期内不会变化，所以在 register 时一次性读取
    const initialLowprivEnabled = process.env.QCLAW_TOOL_LOWPRIV === '1'
    const wrapperPath = process.env.QCLAW_TOOL_WRAPPER_PATH
    const sandboxLevel = process.env.QCLAW_TOOL_SANDBOX_LEVEL || 'standard'
    const appStorePath = process.env.QCLAW_APP_STORE_PATH
    const auditLog = config.auditLog !== false
    const blockPatterns = (config.blockPatterns || []).map((p: string) => new RegExp(p, 'i'))

    // [已禁用] 路径黑名单：低权限 shell 本身已无法写入保护路径，无需在插件层重复拦截
    // const configDenyPaths: string[] = (config.denyWritePaths || []).map((p: string) => normalizePath(p))
    // const systemDenyPaths = wrapperPath ? buildSystemDenyPaths() : []
    // const denyWritePaths = [...systemDenyPaths, ...configDenyPaths]
    // const allowWritePaths = wrapperPath ? buildAllowWritePaths() : []
    const denyWritePaths: string[] = []
    const allowWritePaths: string[] = []

    // ★ 平台检测：降权功能仅在 Windows 上可用
    const isPlatformSupported = process.platform === 'win32'

    /**
     * ★ 运行时动态判断降权是否启用
     *
     * 前置条件：
     *   - 平台必须是 Windows（macOS 暂不支持降权）
     *   - wrapper 路径必须存在（没有 wrapper 就无法降权）
     *
     * 优先级:
     *   1. app-store.json 中的 toolSandbox.enabled（实时读取，5 秒缓存）
     *   2. 环境变量 QCLAW_TOOL_LOWPRIV（进程启动时的初始值）
     *
     * 这使得用户在 UI 上切换开关后，无需重启 OpenClaw 进程即可生效。
     */
    const isLowprivActive = (): boolean => {
      if (!isPlatformSupported) return false // macOS / Linux 不支持降权
      if (!wrapperPath) return false
      const fileValue = readToolSandboxEnabledFromFile(appStorePath)
      if (fileValue !== null) return fileValue
      return initialLowprivEnabled
    }

    console.log(
      `[${LOG_TAG}] registered. platform=${process.platform}, platformSupported=${String(isPlatformSupported)}, ` +
      `lowpriv=${String(initialLowprivEnabled)}, ` +
      `wrapper=${wrapperPath || 'none'}, level=${sandboxLevel}, ` +
      `appStorePath=${appStorePath || 'none'} (dynamic reload: ${appStorePath ? 'enabled' : 'disabled'})`
    )
    if (denyWritePaths.length > 0) {
      console.log(`[${LOG_TAG}] denyWritePaths (${denyWritePaths.length}): ${denyWritePaths.slice(0, 5).join(', ')}...`)
      console.log(`[${LOG_TAG}] allowWritePaths (${allowWritePaths.length}): ${allowWritePaths.join(', ')}`)
    }

    // ---- before_tool_call: 命令改写 + 安全检查 ----
    api.on('before_tool_call', async (event: ToolCallEvent, _ctx: HookContext): Promise<BeforeToolCallResult | undefined> => {
      const { toolName, params, toolCallId } = event

      // ★ 每次 tool call 时动态检查降权状态（从 app-store.json 读取，带 5 秒缓存）
      const lowprivEnabled = isLowprivActive()

      if (auditLog) {
        console.log(
          `[${LOG_TAG}] before: ${toolName} (${toolCallId}) lowpriv=${String(lowprivEnabled)}`,
          JSON.stringify(params).slice(0, 500)
        )
      }

      // ★ 核心：exec 工具命令改写（降权包装）
      if (isExecTool(toolName) && lowprivEnabled && wrapperPath) {
        const command = String(params.command || '')

        // 阻断高危命令（在改写之前检查，无论是否降权都生效）
        for (const pattern of blockPatterns) {
          if (pattern.test(command)) {
            return {
              block: true,
              blockReason: `[${LOG_TAG}] Command blocked by policy: ${pattern.source}`,
            }
          }
        }

        // ★ 外部程序启动检测：如果命令的主要目的是启动 .exe / 打开应用程序，
        //   则跳过降权包装，避免子进程因 Low IL 权限不足而无法正常运行。
        //   安全保障：blockPatterns 仍然在上方生效，高危命令不会被放行。
        if (isAppLaunchCommand(command)) {
          console.log(
            `[${LOG_TAG}] app-launch detected, skip lowpriv wrapper: "${command.slice(0, 120)}"`
          )
          return undefined // 放行原始命令，不包装
        }

        // ★ 按平台改写 params.command（传递降权级别）
        const wrappedCommand = wrapCommandForPlatform(command, wrapperPath, sandboxLevel)
        if (wrappedCommand) {
          console.log(
            `[${LOG_TAG}] rewrite (${sandboxLevel}): "${command.slice(0, 80)}..." → lowpriv wrapper`
          )
          return {
            params: { ...params, command: wrappedCommand },
          }
        } else {
          // 无法包装（不支持的平台），回退放行 + 告警
          console.warn(
            `[${LOG_TAG}] platform ${process.platform} not supported for command wrapping, passing through`
          )
        }
      }

      // [已禁用] write_file / file_editor 路径检查
      // 低权限 shell 本身已通过 OS 层面的 Low IL 限制写入，无需在插件层重复拦截
      // if (isWriteTool(toolName) && lowprivEnabled && denyWritePaths.length > 0) {
      //   const filePath = String(params.path || params.file_path || '')
      //   if (filePath && isPathDenied(filePath, denyWritePaths, allowWritePaths)) {
      //     return {
      //       block: true,
      //       blockReason: `[${LOG_TAG}] Write to protected path blocked (Low IL policy): ${filePath}`,
      //     }
      //   }
      // }

      return undefined // 放行
    })

    // ---- after_tool_call: 审计日志 ----
    if (auditLog) {
      api.on('after_tool_call', async (event: ToolCallEvent, _ctx: HookContext) => {
        const preview = event.result?.content?.slice(0, 200) || '(no result)'
        console.log(
          `[${LOG_TAG}] after: ${event.toolName} (${event.toolCallId})`,
          preview
        )
      })
    }
  },
}

export default plugin
