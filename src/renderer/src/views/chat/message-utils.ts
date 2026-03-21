import DOMPurify from 'dompurify'
import hljs from 'highlight.js'
import MarkdownIt from 'markdown-it'
import { ref, type Ref } from 'vue'
import {
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

  function updateAssistantMessageText(message: ChatMessage, text: string) {
    message.text = text || ' '
  }

  function renderMessageHtml(message: ChatMessage) {
    return message.role === 'assistant' ? renderMarkdown(message.text || ' ') : renderPlainText(message.text)
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
    updateAssistantMessageText,
    renderMessageHtml,
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
    mergeStreamingText,
    extractMessageText,
    mapRole,
    normalizeSessionLabel,
    toDisplayMessages,
  }
}
