/**
 * 配置变更 reload 分类器
 *
 * 镜像 OpenClaw 的 gateway/config-reload.ts 中的规则，
 * 用于在 Electron 侧判断一次 partial config 更新是否会触发
 * OpenClaw gateway 的 in-process restart。
 *
 * 规则优先级（与 OpenClaw 一致）:
 * 1. 高优先 exact/prefix 规则 (BASE_RELOAD_RULES)
 * 2. 低优先 prefix 规则 (BASE_RELOAD_RULES_TAIL)
 * 3. 默认: restart（未匹配到任何规则的路径视为需要重启）
 */

type ReloadKind = 'restart' | 'hot' | 'none'

/**
 * 判断一个 partial config 更新是否会触发 OpenClaw gateway in-process restart。
 *
 * @param partialConfig 要写入的部分配置对象
 * @returns 如果存在任意变更路径命中 restart 规则则返回 true
 */
export function willTriggerRestart(partialConfig: Record<string, unknown>): boolean {
  const changedPaths = extractChangedPaths(partialConfig)
  return changedPaths.some((p) => classifyPath(p) === 'restart')
}

/**
 * 递归提取 partial config 中所有叶子节点的 dot-separated 路径。
 *
 * 示例:
 *   { channels: { 'wechat-access': { token: 'x' } } }
 *   → ['channels.wechat-access.token']
 */
function extractChangedPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const paths: string[] = []
  for (const key of Object.keys(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key
    const value = obj[key]
    if (
      value !== null &&
      value !== undefined &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      paths.push(...extractChangedPaths(value as Record<string, unknown>, fullPath))
    } else {
      paths.push(fullPath)
    }
  }
  return paths
}

// ==================== 高优先规则 ====================
// 对应 OpenClaw config-reload.ts 的 BASE_RELOAD_RULES
// 这些规则在低优先规则之前匹配

interface ReloadRule {
  prefix: string
  kind: ReloadKind
}

const HIGH_PRIORITY_RULES: readonly ReloadRule[] = [
  { prefix: 'gateway.remote', kind: 'none' },
  { prefix: 'gateway.reload', kind: 'none' },
  { prefix: 'hooks.gmail', kind: 'hot' },
  { prefix: 'hooks', kind: 'hot' },
  { prefix: 'agents.defaults.heartbeat', kind: 'hot' },
  { prefix: 'agent.heartbeat', kind: 'hot' },
  { prefix: 'cron', kind: 'hot' },
  { prefix: 'browser', kind: 'hot' },
  // Channel 热重载规则：所有 channels.* 变更都是 channel 级热重载，不触发 gateway restart
  // WhatsApp 是唯一特例：通过 web 前缀触发重载，channels.whatsapp 自身为 none
  { prefix: 'channels.whatsapp', kind: 'none' },
  { prefix: 'channels', kind: 'hot' },
  { prefix: 'web', kind: 'hot' },
]

// ==================== 低优先规则 ====================
// 对应 OpenClaw config-reload.ts 的 BASE_RELOAD_RULES_TAIL

const LOW_PRIORITY_RULES: readonly ReloadRule[] = [
  { prefix: 'meta', kind: 'none' },
  { prefix: 'identity', kind: 'none' },
  { prefix: 'wizard', kind: 'none' },
  { prefix: 'logging', kind: 'none' },
  { prefix: 'models', kind: 'none' },
  { prefix: 'agents', kind: 'none' },
  { prefix: 'tools', kind: 'none' },
  { prefix: 'bindings', kind: 'none' },
  { prefix: 'audio', kind: 'none' },
  { prefix: 'agent', kind: 'none' },
  { prefix: 'routing', kind: 'none' },
  { prefix: 'messages', kind: 'none' },
  { prefix: 'session', kind: 'none' },
  { prefix: 'talk', kind: 'none' },
  { prefix: 'skills', kind: 'none' },
  { prefix: 'plugins', kind: 'restart' },
  { prefix: 'ui', kind: 'none' },
  { prefix: 'gateway', kind: 'restart' },
  { prefix: 'discovery', kind: 'restart' },
  { prefix: 'canvasHost', kind: 'restart' },
]

/**
 * 按 OpenClaw 的规则优先级匹配单个配置路径的 reload 分类。
 *
 * 匹配逻辑（与 OpenClaw listReloadRules() + matchRule() 一致）:
 * 1. 先遍历高优先规则，命中即返回（包括 channel 热重载规则）
 * 2. 再遍历低优先规则，命中即返回
 * 3. 均未命中 → 返回 'restart'（安全默认值）
 *
 * Channel 热重载规则说明:
 * - channels 前缀统一映射为 'hot'（channel 级别的组件重载，不触发 gateway restart）
 * - channels.whatsapp 例外，设为 'none'（用 web 前缀代替触发重载）
 * - web 前缀设为 'hot'（WhatsApp 特殊：web 登录配置变更触发 channel 重载）
 *
 * 这确保了 Electron 侧的分类与 OpenClaw 运行时的热重载决策一致，
 * 避免了不必要的 gateway restart 等待。
 */
function classifyPath(configPath: string): ReloadKind {
  for (const rule of HIGH_PRIORITY_RULES) {
    if (matchesPrefix(configPath, rule.prefix)) {
      return rule.kind
    }
  }

  for (const rule of LOW_PRIORITY_RULES) {
    if (matchesPrefix(configPath, rule.prefix)) {
      return rule.kind
    }
  }

  // 未匹配到任何规则的路径默认需要 restart（安全第一）
  return 'restart'
}

function matchesPrefix(configPath: string, prefix: string): boolean {
  return configPath === prefix || configPath.startsWith(`${prefix}.`)
}
