export type MessageLevel = 'warning' | 'error' | 'success'

export type SystemSettingsTabKey =
  | 'general'
  | 'usage'
  | 'skills'
  | 'remote'
  | 'about'
  | 'release-note'

export type SkillCardSource = 'builtin' | 'project' | 'user'

export type SkillSettingsOption = {
  id: string
  name: string
  description: string
  emoji: string
  path?: string
  isBundled?: boolean
  alwaysEnabled?: boolean
  source?: SkillCardSource
  version?: string
  ownerId?: string
  fullDescription?: string
}

export type UsageStats = {
  sessionCount: number
  messageCount: number
  userMessageCount: number
  gatewayStatus: string
}

export type RemoteChannelCard = {
  id: string
  name: string
  icon: string
  description: string
  recommended: boolean
  status: 'connected' | 'available' | 'disabled'
  connectedLabel: string
}

export type ReleaseNote = {
  version: string
  date: string
  summary: string
  items: string[]
}

export const SYSTEM_SETTINGS_TABS: Array<{
  key: SystemSettingsTabKey
  label: string
  visible?: boolean
}> = [
  { key: 'general', label: '通用设置' },
  { key: 'usage', label: '用量统计' },
  { key: 'skills', label: '技能管理' },
  { key: 'remote', label: '远控通道' },
  { key: 'about', label: '关于我们' },
  { key: 'release-note', label: '版本日志', visible: false },
]

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '0.1.13',
    date: '2026/03/20',
    summary: '🎉 v0.1.13版本更新内容:',
    items: [
      '设置中新增“远控通道”，支持通过企微、QQ、飞书、钉钉等与QClaw交互对话',
      '“定时任务”功能焕新上线，体验优化',
      '多项性能提升优化、安全性提升优化与 bugfix',
    ],
  },
  {
    version: '0.1.12',
    date: '2026/03/19',
    summary: '🎉 v0.1.12版本更新内容:',
    items: ['用户引导白屏 bugfix'],
  },
  {
    version: '0.1.11',
    date: '2026/03/19',
    summary: '🎉 v0.1.11版本更新内容：',
    items: ['灵感广场体验优化；多界面交互优化', '多项性能提升优化与 bugfix'],
  },
  {
    version: '0.1.10',
    date: '2026/03/18',
    summary: '🎉 v0.1.10版本更新内容:',
    items: ['启动优化 bugfix'],
  },
  {
    version: '0.1.9',
    date: '2026/03/17',
    summary: '🎉 v0.1.9版本更新内容:',
    items: [
      '新增支持微信内直接接收 QClaw 处理好的图片、文件，一键打开。',
      '新增龙虾工作室，去看看龙虾在温馨的像素小屋里忙些什么吧！',
    ],
  },
]

export const ALWAYS_ENABLED_SKILL_IDS = new Set(['qclaw-rules'])

export const DEFAULT_SKILL_SETTINGS_OPTIONS: SkillSettingsOption[] = [
  {
    id: 'qclaw-rules',
    name: 'QClaw 系统规则',
    description: '系统级基础规则，负责维持 QClaw 的中文回复、执行流程和安全边界。',
    emoji: '📋',
    alwaysEnabled: true,
  },
  {
    id: 'find-skills',
    name: '技能发现',
    description: '帮助用户搜索、推荐和安装扩展技能能力。',
    emoji: '🔍',
  },
  {
    id: 'imap-smtp-email',
    name: '邮件助手',
    description: '通过 IMAP/SMTP 读取和发送邮件，支持附件与常见邮箱服务。',
    emoji: '📧',
  },
  {
    id: 'humanize-ai-text',
    name: '文本润色',
    description: '提供 AI 文本风格改写和人类表达优化能力。',
    emoji: '✍️',
  },
  {
    id: 'xiaohongshu',
    name: '小红书工具',
    description: '支持检索、分析和处理小红书内容数据。',
    emoji: '📕',
  },
  {
    id: 'tfs-rsmp-ops',
    name: 'TFS 工作项',
    description: '面向 RSMP 项目查询和处理 TFS 工作项、WIQL 与任务状态。',
    emoji: '🧩',
  },
]

export const SKILL_EMOJI_MAP: Record<string, string> = {
  'qclaw-rules': '📋',
  'find-skills': '🔍',
  'imap-smtp-email': '📧',
  'humanize-ai-text': '✍️',
  'xiaohongshu': '📕',
  'tfs-rsmp-ops': '🧩',
  'file-skill': '📁',
  'email-skill': '📮',
  'news-summary': '📰',
  'arxiv-watcher': '📚',
}
