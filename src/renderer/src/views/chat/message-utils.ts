import DOMPurify from 'dompurify'
import hljs from 'highlight.js'
import MarkdownIt from 'markdown-it'
import { ref, type Ref } from 'vue'
import {
  describeToolCall,
  extractToolCardsFromMessage,
  normalizeChatHistoryMessages,
} from '../../../assets/chat-history-state.js'
import { resolveSessionChannel } from '../../../assets/chat-session-utils.js'
import type { ChatMessage, ToolCard } from './types'

const TOOL_CARD_INLINE_TEXT_LIMIT = 80
const TOOL_CARD_PREVIEW_LINE_LIMIT = 2
const TOOL_CARD_PREVIEW_CHAR_LIMIT = 100

const TOOL_CARD_ICONS: Record<string, string> = {
  bash: '<svg viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>',
  execute: '<svg viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>',
  shell: '<svg viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>',
  read: '<svg viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
  read_file: '<svg viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
  write: '<svg viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
  write_file: '<svg viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
  grep: '<svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
  list_files: '<svg viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
  web: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
  fetch: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
  browser: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
}

function trimMarkdownCache(markdownCache: Map<string, string>) {
  if (markdownCache.size < 200) {
    return
  }

  const oldestKey = markdownCache.keys().next().value
  if (oldestKey) {
    markdownCache.delete(oldestKey)
  }
}

function escapeHtml(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function normalizeThinkingText(text: string) {
  const trimmed = text.trim()
  if (!trimmed) {
    return ''
  }

  const withoutPrefix = trimmed.startsWith('Reasoning:\n')
    ? trimmed.slice('Reasoning:\n'.length)
    : trimmed.startsWith('Reasoning:')
      ? trimmed.slice('Reasoning:'.length)
      : trimmed

  return withoutPrefix
    .split('\n')
    .map((line) => {
      const normalizedLine = line.trim()
      if (normalizedLine.startsWith('_') && normalizedLine.endsWith('_') && normalizedLine.length > 1) {
        return normalizedLine.slice(1, -1)
      }
      return line
    })
    .join('\n')
    .trim()
}

function splitThinkingTimelineSteps(text: string) {
  const normalized = normalizeThinkingText(text)
  if (!normalized) {
    return []
  }

  const steps: string[] = []
  let buffer = ''

  const flushBuffer = () => {
    const next = buffer.trim()
    if (!next) {
      buffer = ''
      return
    }

    if (steps.length > 0 && next.length <= 10) {
      steps[steps.length - 1] = `${steps[steps.length - 1]}${next}`
    } else {
      steps.push(next)
    }

    buffer = ''
  }

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    buffer += char

    if ('。！？!?；;'.includes(char)) {
      flushBuffer()
      continue
    }

    if (char === '\n' && normalized[index + 1] === '\n') {
      flushBuffer()
    }
  }

  flushBuffer()
  return steps
}

function stripToolMarkup(text: string) {
  return text
    .replace(/<\/?arg_key>/gi, ' ')
    .replace(/<\/?arg_value>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTaggedToolArgs(text: string) {
  const taggedArgs: Record<string, string> = {}
  const regex = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi

  for (const match of text.matchAll(regex)) {
    const key = stripToolMarkup(match[1] || '').toLowerCase()
    const value = stripToolMarkup(match[2] || '')
    if (key && value && !taggedArgs[key]) {
      taggedArgs[key] = value
    }
  }

  return taggedArgs
}

function normalizeToolArgString(value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  return stripToolMarkup(trimmed) || trimmed
}

function collectToolArgValues(toolArgs: unknown, result: Record<string, string>, depth = 0) {
  if (depth > 3 || toolArgs == null) {
    return
  }

  if (typeof toolArgs === 'string') {
    const normalizedValue = normalizeToolArgString(toolArgs)
    if (normalizedValue && !result.__first) {
      result.__first = normalizedValue
    }

    const taggedArgs = extractTaggedToolArgs(toolArgs)
    for (const [key, value] of Object.entries(taggedArgs)) {
      if (value && !result[key]) {
        result[key] = value
      }
    }
    return
  }

  if (typeof toolArgs === 'number' || typeof toolArgs === 'boolean') {
    const normalizedValue = String(toolArgs)
    if (normalizedValue && !result.__first) {
      result.__first = normalizedValue
    }
    return
  }

  if (Array.isArray(toolArgs)) {
    for (const item of toolArgs) {
      collectToolArgValues(item, result, depth + 1)
    }
    return
  }

  if (typeof toolArgs !== 'object') {
    return
  }

  for (const [rawKey, value] of Object.entries(toolArgs)) {
    const key = String(rawKey || '').toLowerCase()
    if (!key) {
      continue
    }

    if (typeof value === 'string') {
      const normalizedValue = normalizeToolArgString(value)
      if (normalizedValue) {
        if (!result[key]) {
          result[key] = normalizedValue
        }
        if (!result.__first) {
          result.__first = normalizedValue
        }
      }

      const taggedArgs = extractTaggedToolArgs(value)
      for (const [taggedKey, taggedValue] of Object.entries(taggedArgs)) {
        if (taggedValue && !result[taggedKey]) {
          result[taggedKey] = taggedValue
        }
      }
      continue
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      const normalizedValue = String(value)
      if (!result[key]) {
        result[key] = normalizedValue
      }
      if (!result.__first) {
        result.__first = normalizedValue
      }
      continue
    }

    collectToolArgValues(value, result, depth + 1)
  }
}

function getToolArgValue(toolArgs: unknown, preferredKeys: string[]) {
  const argMap: Record<string, string> = {}
  collectToolArgValues(toolArgs, argMap)

  for (const key of preferredKeys) {
    const value = argMap[key.toLowerCase()]
    if (value) {
      return value
    }
  }

  return argMap.__first || ''
}

function truncateToolDisplayText(value: string, limit = 60) {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed
}

function formatToolTargetLabel(value: string, limit = 60) {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  try {
    const parsed = new URL(trimmed)
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : ''
    const query = parsed.search && parsed.search !== '?' ? parsed.search : ''
    return truncateToolDisplayText(`${parsed.host}${path}${query}`, limit)
  } catch {
    return truncateToolDisplayText(trimmed, limit)
  }
}

function getPathLikeValue(toolArgs?: unknown) {
  return getToolArgValue(toolArgs, [
    'path',
    'file',
    'filepath',
    'file_path',
    'filename',
    'name',
    'target',
    'source',
  ]).trim()
}

function getDisplayFileName(pathLike: string) {
  const trimmed = pathLike.trim()
  if (!trimmed) {
    return ''
  }

  const normalized = trimmed.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] || trimmed
}

function getCommandLikeValue(toolArgs?: unknown) {
  return getToolArgValue(toolArgs, ['command', 'cmd']).trim()
}

function getBrowserActionKind(toolArgs?: unknown) {
  return getToolArgValue(toolArgs, ['kind', 'event', 'gesture', 'interaction', 'mode']).toLowerCase()
}

function getBrowserActionTarget(toolArgs?: unknown) {
  return getToolArgValue(toolArgs, [
    'url',
    'href',
    'target',
    'selector',
    'element',
    'locator',
    'label',
    'name',
    'query',
    'text',
    'page',
    'location',
  ])
}

function getBrowserActionInput(toolArgs?: unknown) {
  return getToolArgValue(toolArgs, ['value', 'input', 'content', 'text', 'keys', 'key'])
}

function getBrowserOperation(toolCard: ToolCard) {
  const normalizedName = String(toolCard.name || '').toLowerCase()
  const knownOperations = new Set(['status', 'start', 'open', 'navigate', 'snapshot', 'act'])

  if (knownOperations.has(normalizedName)) {
    return normalizedName
  }

  const operation = getToolArgValue(toolCard.args, [
    'action',
    'operation',
    'command',
    'method',
    'step',
    'tool',
    'name',
  ]).toLowerCase()

  if (knownOperations.has(operation)) {
    return operation
  }

  const normalizedDetail = String(toolCard.detail || '').trim().toLowerCase()
  if (knownOperations.has(normalizedDetail)) {
    return normalizedDetail
  }

  return ''
}

function isBrowserLikeTool(toolCard?: ToolCard | null) {
  if (!toolCard) {
    return false
  }

  const normalizedName = String(toolCard.name || '').toLowerCase()
  return (
    ['web', 'fetch', 'browser', 'start', 'open', 'navigate', 'snapshot', 'act', 'status'].includes(
      normalizedName,
    ) || !!getBrowserOperation(toolCard)
  )
}

function formatBrowserActionSummary(toolCard: ToolCard) {
  const normalizedName = String(toolCard.name || '').toLowerCase()
  const operation = getBrowserOperation(toolCard) || normalizedName
  const browserName = getToolArgValue(toolCard.args, ['browser', 'engine', 'name'])
  const targetLabel = formatToolTargetLabel(getBrowserActionTarget(toolCard.args), 48)

  if (operation === 'status') {
    return '检查了浏览器状态'
  }

  if (operation === 'start') {
    return browserName ? `启动了 ${browserName}` : '启动了浏览器'
  }

  if (operation === 'open') {
    return targetLabel ? `打开了 ${targetLabel}` : '打开了页面'
  }

  if (operation === 'navigate') {
    return targetLabel ? `跳转到 ${targetLabel}` : '跳转了页面'
  }

  if (operation === 'snapshot') {
    return targetLabel ? `读取了 ${targetLabel}` : '读取了页面快照'
  }

  const actionKind = getBrowserActionKind(toolCard.args)
  if (actionKind === 'click') {
    return targetLabel ? `点击了 ${targetLabel}` : '点击了页面元素'
  }
  if (actionKind === 'fill' || actionKind === 'input' || actionKind === 'type') {
    return targetLabel ? `向 ${targetLabel} 输入了内容` : '输入了内容'
  }
  if (actionKind === 'scroll') {
    return targetLabel ? `滚动到了 ${targetLabel}` : '滚动了页面'
  }
  if (actionKind === 'select') {
    return targetLabel ? `选择了 ${targetLabel}` : '选择了选项'
  }
  if (actionKind === 'hover') {
    return targetLabel ? `悬停到 ${targetLabel}` : '悬停到了元素'
  }
  if (actionKind === 'press') {
    const input = formatToolTargetLabel(getBrowserActionInput(toolCard.args), 24)
    return input ? `触发了按键 ${input}` : '触发了按键'
  }
  if (actionKind === 'wait') {
    return targetLabel ? `等待了 ${targetLabel}` : '等待了页面状态'
  }

  return targetLabel ? `执行了页面操作 ${targetLabel}` : '执行了页面操作'
}

function formatBrowserActionDetail(toolCard: ToolCard) {
  const normalizedName = String(toolCard.name || '').toLowerCase()
  const operation = getBrowserOperation(toolCard) || normalizedName
  const browserName = getToolArgValue(toolCard.args, ['browser', 'engine', 'name'])
  const target = getBrowserActionTarget(toolCard.args)

  if (operation === 'status') {
    return '检查浏览器当前状态'
  }

  if (operation === 'start') {
    return browserName || '启动浏览器会话'
  }

  if (operation === 'open' || operation === 'navigate') {
    return target || ''
  }

  if (operation === 'snapshot') {
    return target || '读取当前页面快照'
  }

  const actionKind = getBrowserActionKind(toolCard.args)
  const input = getBrowserActionInput(toolCard.args)

  if (actionKind === 'click') {
    return target ? `点击 ${target}` : '点击页面元素'
  }
  if (actionKind === 'fill' || actionKind === 'input' || actionKind === 'type') {
    return target ? `向 ${target} 输入内容` : '输入内容'
  }
  if (actionKind === 'scroll') {
    return target ? `滚动到 ${target}` : '滚动页面'
  }
  if (actionKind === 'select') {
    return target ? `在 ${target} 选择选项` : '选择选项'
  }
  if (actionKind === 'hover') {
    return target ? `悬停到 ${target}` : '悬停到元素'
  }
  if (actionKind === 'press') {
    return input ? `按下 ${input}` : '触发按键'
  }
  if (actionKind === 'wait') {
    return target ? `等待 ${target}` : '等待页面状态'
  }

  return target || ''
}

export function useChatMessageUtils(currentSessionKey: Ref<string>) {
  const markdownCache = new Map<string, string>()
  const activeToolCardResult = ref<ToolCard | null>(null)
  const toolCardCopyMessage = ref('')
  const toolCardCopyMessageLevel = ref<'warning' | 'error' | 'success'>('success')
  let toolCardCopyTimer: number | null = null

  const markdownRenderer = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    highlight(code, language) {
      const normalizedLanguage = (language || '').trim().toLowerCase()

      if (normalizedLanguage && hljs.getLanguage(normalizedLanguage)) {
        return `<pre class="qclaw-code-block hljs"><code>${hljs.highlight(code, {
          language: normalizedLanguage,
          ignoreIllegals: true,
        }).value}</code></pre>`
      }

      return `<pre class="qclaw-code-block hljs"><code>${hljs.highlightAuto(code).value}</code></pre>`
    },
  })

  function renderMarkdown(text: string) {
    const cached = markdownCache.get(text)
    if (cached) {
      return cached
    }

    const rendered = markdownRenderer.render(text)
    const sanitized = DOMPurify.sanitize(rendered)
    markdownCache.set(text, sanitized)
    trimMarkdownCache(markdownCache)
    return sanitized
  }

  function renderPlainText(text: string) {
    return DOMPurify.sanitize(escapeHtml(text).replaceAll('\n', '<br />'))
  }

  function buildDisplayMessage(role: 'assistant' | 'user', text: string): ChatMessage {
    return {
      id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      text,
      toolCards: [],
    }
  }

  function buildStatusMessage(
    kind: 'thinking' | 'received' | 'tool',
    options: {
      text?: string
      state?: 'pending' | 'running' | 'completed'
      toolCard?: ToolCard
    } = {},
  ): ChatMessage {
    return {
      id: `status-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      text: options.text || '',
      toolCards: [],
      statusMeta: {
        kind,
        state: options.state,
        toolCard: options.toolCard,
      },
    }
  }

  function updateAssistantMessageText(message: ChatMessage, text: string) {
    message.text = text || ' '
  }

  function renderMessageHtml(message: ChatMessage) {
    return message.role === 'assistant' ? renderMarkdown(message.text || ' ') : renderPlainText(message.text)
  }

  function isStatusMessage(message: ChatMessage) {
    return !!message.statusMeta
  }

  function isToolResultMessage(message: any) {
    const role = String(message?.role || '').toLowerCase()
    return role === 'toolresult' || role === 'tool_result'
  }

  function getDisplayRole(message: ChatMessage) {
    return message.role === 'user' ? 'user' : 'assistant'
  }

  function isStandaloneToolMessage(message: ChatMessage) {
    return (
      message.role !== 'user' &&
      Array.isArray(message.toolCards) &&
      message.toolCards.length > 0 &&
      !message.text.trim()
    )
  }

  function isToolCardCompleted(toolCard: ToolCard) {
    return !!((toolCard.completed || toolCard.kind === 'result') && !toolCard.text?.trim())
  }

  function showToolCardCompletedLabel(toolCard: ToolCard) {
    return isToolCardCompleted(toolCard)
  }

  function isInlineToolCardText(toolCard: ToolCard) {
    const text = toolCard.text?.trim()
    return !!text && text.length <= TOOL_CARD_INLINE_TEXT_LIMIT
  }

  function getToolCardPreview(text: string) {
    const lines = text.split('\n')
    const joined = lines.slice(0, TOOL_CARD_PREVIEW_LINE_LIMIT).join('\n')
    if (joined.length > TOOL_CARD_PREVIEW_CHAR_LIMIT) {
      return `${joined.slice(0, TOOL_CARD_PREVIEW_CHAR_LIMIT)}...`
    }
    if (lines.length > TOOL_CARD_PREVIEW_LINE_LIMIT) {
      return `${joined}...`
    }
    return joined
  }

  function resetToolCardCopyMessage() {
    toolCardCopyMessage.value = ''
    toolCardCopyMessageLevel.value = 'success'
    if (toolCardCopyTimer !== null) {
      window.clearTimeout(toolCardCopyTimer)
      toolCardCopyTimer = null
    }
  }

  function setToolCardCopyMessage(
    text: string,
    level: 'warning' | 'error' | 'success' = 'success',
  ) {
    resetToolCardCopyMessage()
    toolCardCopyMessage.value = text
    toolCardCopyMessageLevel.value = level
    toolCardCopyTimer = window.setTimeout(() => {
      toolCardCopyTimer = null
      toolCardCopyMessage.value = ''
    }, 2200)
  }

  function openToolCardResult(toolCard: ToolCard) {
    if (!toolCard.text?.trim()) {
      return
    }

    resetToolCardCopyMessage()
    activeToolCardResult.value = toolCard
  }

  function closeToolCardResult() {
    activeToolCardResult.value = null
    resetToolCardCopyMessage()
  }

  async function copyToolCardResult() {
    const text = activeToolCardResult.value?.text?.trim()
    if (!text) {
      setToolCardCopyMessage('没有可复制的内容', 'warning')
      return
    }

    try {
      await navigator.clipboard.writeText(text)
      setToolCardCopyMessage('已复制到剪贴板')
    } catch (error) {
      console.error('[Chat] 复制 tool result 失败:', error)
      setToolCardCopyMessage('复制失败，请手动复制', 'error')
    }
  }

  function getToolCardIcon(toolName: string) {
    return TOOL_CARD_ICONS[toolName] || TOOL_CARD_ICONS.browser || ''
  }

  function formatToolCardName(toolName: string) {
    return toolName
      ? toolName
          .replaceAll('_', ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/\b\w/g, (char) => char.toUpperCase())
      : 'Tool'
  }

  function formatToolStatusText(toolCard?: ToolCard | null) {
    if (!toolCard) {
      return '执行了工具调用'
    }

    const detail = toolCard.detail || describeToolCall(toolCard.name, toolCard.args)
    const normalizedName = String(toolCard.name || '').toLowerCase()

    if (isBrowserLikeTool(toolCard)) {
      return formatBrowserActionSummary(toolCard)
    }

    if (normalizedName === 'read' || normalizedName === 'read_file') {
      const pathLike = getPathLikeValue(toolCard.args) || detail
      const fileName = getDisplayFileName(pathLike)
      return fileName ? `查看了 ${fileName}` : '查看了文件'
    }

    if (normalizedName === 'write' || normalizedName === 'write_file' || normalizedName === 'edit') {
      const pathLike = getPathLikeValue(toolCard.args) || detail
      const fileName = getDisplayFileName(pathLike)
      return fileName ? `修改了 ${fileName}` : '修改了文件'
    }

    if (normalizedName === 'search' || normalizedName === 'grep') {
      return detail ? `搜索了 ${detail}` : '执行了搜索'
    }

    if (
      normalizedName === 'bash' ||
      normalizedName === 'execute' ||
      normalizedName === 'shell' ||
      normalizedName === 'exec'
    ) {
      return detail ? `执行了 ${detail}` : '执行了命令'
    }

    if (normalizedName === 'web' || normalizedName === 'fetch' || normalizedName === 'browser') {
      return detail ? `访问了 ${detail}` : '访问了网页'
    }

    const prettyName = formatToolCardName(toolCard.name)
    return detail ? `${prettyName}: ${detail}` : `调用了 ${prettyName}`
  }

  function formatToolDetailText(toolCard?: ToolCard | null) {
    if (!toolCard) {
      return ''
    }

    const normalizedName = String(toolCard.name || '').toLowerCase()
    const detail = toolCard.detail || describeToolCall(toolCard.name, toolCard.args)
    const pathLike = getPathLikeValue(toolCard.args) || detail
    const commandLike = getCommandLikeValue(toolCard.args)

    if (isBrowserLikeTool(toolCard)) {
      return formatBrowserActionDetail(toolCard)
    }

    if (normalizedName === 'read' || normalizedName === 'read_file') {
      return pathLike ? `from ${pathLike}` : ''
    }

    if (normalizedName === 'write' || normalizedName === 'write_file' || normalizedName === 'edit') {
      return pathLike ? `to ${pathLike}` : ''
    }

    if (
      normalizedName === 'bash' ||
      normalizedName === 'execute' ||
      normalizedName === 'shell' ||
      normalizedName === 'exec'
    ) {
      return commandLike || detail || ''
    }

    return detail || toolCard.text?.trim() || ''
  }

  function mergeStreamingText(previousText: string, incomingText: string) {
    if (!incomingText) return previousText
    if (!previousText) return incomingText
    if (incomingText === previousText) return previousText
    if (incomingText.startsWith(previousText)) return incomingText
    if (previousText.endsWith(incomingText) || previousText.includes(incomingText)) {
      return previousText
    }

    const maxOverlap = Math.min(previousText.length, incomingText.length)
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      if (previousText.endsWith(incomingText.slice(0, overlap))) {
        return `${previousText}${incomingText.slice(overlap)}`
      }
    }

    return `${previousText}${incomingText}`
  }

  function extractMessageText(message: any): string {
    if (!message) {
      return ''
    }

    if (typeof message.text === 'string') {
      return message.text
    }

    if (!Array.isArray(message.content)) {
      return ''
    }

    return message.content
      .map((item: any) => {
        if (!item || typeof item !== 'object') {
          return ''
        }

        if (typeof item.text === 'string') {
          return item.text
        }

        if (typeof item.content === 'string') {
          return item.content
        }

        return ''
      })
      .filter(Boolean)
      .join('\n')
  }

  function mapRole(role: string): 'assistant' | 'user' | 'tool' | 'system' {
    const nextRole = String(role || '').toLowerCase()
    if (nextRole === 'user') return 'user'
    if (nextRole === 'assistant') return 'assistant'
    if (nextRole === 'system') return 'system'
    if (nextRole === 'toolresult' || nextRole === 'tool_result' || nextRole === 'tool') {
      return 'tool'
    }
    return 'assistant'
  }

  function normalizeSessionLabel(text: string) {
    const trimmed = text.trim()
    if (!trimmed) {
      return '新对话'
    }
    return trimmed.length > 30 ? `${trimmed.slice(0, 30)}...` : trimmed
  }

  function extractThinkingLog(message: any): ChatMessage['thinkingLog'] | undefined {
    void message
    return undefined
  }

  function toDisplayMessages(historyMessages: any[]) {
    const displayMessages = normalizeChatHistoryMessages({
      sessionKey: currentSessionKey.value,
      historyMessages,
      mapRole,
      extractMessageText,
      extractToolCards: (message: any) =>
        extractToolCardsFromMessage(message, extractMessageText, isToolResultMessage),
      resolveSessionChannel,
    }).map((message: any) => ({
      id: `${message.role}-${message.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role:
        message.role === 'user'
          ? 'user'
          : message.role === 'tool'
            ? 'tool'
            : 'assistant',
      text: message.text || '',
      toolCards: message.toolCards || [],
      thinkingLog: extractThinkingLog(message),
    }))

    return displayMessages.filter((message, index) => {
      if (message.role !== 'tool' || !message.toolCards?.length) {
        return true
      }

      for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
        const previousMessage = displayMessages[previousIndex]
        if (previousMessage.role === 'user') {
          break
        }

        if (previousMessage.role !== 'assistant' || !previousMessage.toolCards?.length) {
          continue
        }

        const isMergedToolResult = message.toolCards.every((toolCard) => {
          if (toolCard.kind !== 'result') {
            return false
          }

          return previousMessage.toolCards?.some(
            (previousToolCard) =>
              previousToolCard.kind === 'call' &&
              previousToolCard.name === toolCard.name &&
              previousToolCard.completed &&
              previousToolCard.text === toolCard.text,
          )
        })

        return !isMergedToolResult
      }

      return true
    })
  }

  return {
    activeToolCardResult,
    toolCardCopyMessage,
    toolCardCopyMessageLevel,
    buildDisplayMessage,
    buildStatusMessage,
    updateAssistantMessageText,
    renderMessageHtml,
    isStatusMessage,
    isToolResultMessage,
    getDisplayRole,
    isStandaloneToolMessage,
    isToolCardCompleted,
    showToolCardCompletedLabel,
    isInlineToolCardText,
    getToolCardPreview,
    resetToolCardCopyMessage,
    openToolCardResult,
    closeToolCardResult,
    copyToolCardResult,
    getToolCardIcon,
    formatToolCardName,
    formatToolStatusText,
    formatToolDetailText,
    splitThinkingTimelineSteps,
    mergeStreamingText,
    extractMessageText,
    mapRole,
    normalizeSessionLabel,
    toDisplayMessages,
  }
}
