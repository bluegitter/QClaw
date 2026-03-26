<template>
  <div ref="scrollContainerRef" class="qclaw-chat-scroll">
    <div class="qclaw-messages">
      <article
        v-for="item in groupedItems"
        :key="item.id"
        :class="['qclaw-message', `qclaw-message-${item.role}`]"
      >
        <div
          v-if="item.type === 'user'"
          :class="['qclaw-bubble', 'qclaw-bubble-user']"
        >
          <p class="qclaw-message-plain">
            {{ item.message.text }}
          </p>
        </div>

        <div v-else class="qclaw-assistant-group">
          <div
            v-if="item.chain.hasThinkingHeader || item.chain.entries.length > 0"
            class="thinking-chain"
          >
            <button
              type="button"
              class="thinking-chain__toggle"
              @click="toggleGroup(item.id)"
            >
              <span class="thinking-chain__toggle-label">
                {{ item.chain.isStreaming ? '正在思考' : '已完成思考' }}
              </span>
              <svg
                :class="[
                  'thinking-chain__toggle-arrow',
                  isGroupExpanded(item.id) && 'thinking-chain__toggle-arrow--expanded',
                ]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </button>

            <div v-if="isGroupExpanded(item.id)" class="thinking-chain__content">
              <div class="thinking-chain__timeline">
                <div
                  v-for="(entry, entryIndex) in item.chain.entries"
                  :key="`${item.id}-entry-${entryIndex}`"
                  class="thinking-chain__step"
                >
                  <div class="thinking-chain__dot-wrapper">
                    <div
                      :class="[
                        'thinking-chain__dot',
                        entry.type === 'tool' && !entry.completed && 'thinking-chain__dot--active',
                      ]"
                    ></div>
                  </div>

                  <div class="thinking-chain__step-content">
                    <p v-if="entry.type === 'text'" class="thinking-chain__text">
                      {{ entry.text }}
                    </p>

                    <template v-else>
                      <button
                        type="button"
                        class="thinking-chain__tool"
                        @click="toggleToolEntry(item.id, entryIndex)"
                      >
                        <span
                          class="thinking-chain__tool-icon"
                          v-html="getToolCardIcon(entry.toolCard.name)"
                        ></span>
                        <span class="thinking-chain__tool-summary">
                          {{ formatToolStatusText(entry.toolCard) }}
                        </span>
                        <svg
                          v-if="entry.detail"
                          :class="[
                            'thinking-chain__tool-arrow',
                            isToolEntryExpanded(item.id, entryIndex) &&
                              'thinking-chain__tool-arrow--expanded',
                          ]"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <polyline points="9 6 15 12 9 18"></polyline>
                        </svg>
                      </button>

                      <div
                        v-if="entry.detail && isToolEntryExpanded(item.id, entryIndex)"
                        class="thinking-chain__tool-detail"
                      >
                        <div class="thinking-chain__tool-detail-text">{{ entry.detail }}</div>
                      </div>
                    </template>
                  </div>
                </div>
              </div>

              <div v-if="item.chain.isStreaming" class="thinking-chain__loading">
                <span class="thinking-chain__loading-dot"></span>
                <span class="thinking-chain__loading-dot"></span>
                <span class="thinking-chain__loading-dot"></span>
              </div>
            </div>
          </div>

          <div
            v-if="item.finalAssistantMessage"
            :class="['qclaw-bubble', 'qclaw-bubble-assistant']"
          >
            <div
              class="qclaw-message-text qclaw-message-markdown"
              v-html="renderMessageHtml(item.finalAssistantMessage)"
            ></div>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onUnmounted, watch } from 'vue'
import type { ChatMessage, ToolCard } from '../types'

interface UserGroupItem {
  id: string
  type: 'user'
  role: 'user'
  message: ChatMessage
}

interface ChainEntry {
  type: 'text' | 'tool'
  text?: string
  toolCard?: ToolCard
  detail?: string
  completed?: boolean
  aborted?: boolean
}

interface AssistantGroupItem {
  id: string
  type: 'assistant-group'
  role: 'assistant'
  finalAssistantMessage: ChatMessage | null
  chain: {
    hasThinkingHeader: boolean
    isStreaming: boolean
    entries: ChainEntry[]
  }
}

type GroupedItem = UserGroupItem | AssistantGroupItem

const props = defineProps<{
  messages: ChatMessage[]
  getDisplayRole: (message: ChatMessage) => string
  isStatusMessage: (message: ChatMessage) => boolean
  isStandaloneToolMessage: (message: ChatMessage) => boolean
  isToolCardCompleted: (toolCard: ToolCard) => boolean
  showToolCardCompletedLabel: (toolCard: ToolCard) => boolean
  isInlineToolCardText: (toolCard: ToolCard) => boolean
  getToolCardPreview: (text: string) => string
  getToolCardIcon: (toolName: string) => string
  formatToolCardName: (toolName: string) => string
  formatToolStatusText: (toolCard?: ToolCard | null) => string
  formatToolDetailText: (toolCard?: ToolCard | null) => string
  renderMessageHtml: (message: ChatMessage) => string
  openToolCardResult: (toolCard: ToolCard) => void
}>()

void props

const scrollContainerRef = ref<HTMLElement | null>(null)
const collapsedGroupIds = ref<Set<string>>(new Set())
const expandedToolEntryIds = ref<Set<string>>(new Set())

// 监听消息数量变化，当会话结束（消息从有到无）时清理折叠状态
let previousMessageCount = props.messages.length
watch(() => props.messages.length, (newCount) => {
  // 如果消息从有变为无，说明会话结束/切换，清理所有折叠状态
  if (previousMessageCount > 0 && newCount === 0) {
    collapsedGroupIds.value.clear()
    expandedToolEntryIds.value.clear()
  }
  previousMessageCount = newCount
})

// 组件卸载时清理所有状态，防止内存泄漏
onUnmounted(() => {
  collapsedGroupIds.value.clear()
  expandedToolEntryIds.value.clear()
})

function normalizeToolDetail(toolCard: ToolCard) {
  const formattedDetail = props.formatToolDetailText(toolCard)
  if (formattedDetail) {
    return formattedDetail
  }
  if (toolCard.detail) {
    return toolCard.detail
  }
  if (toolCard.text?.trim()) {
    return toolCard.text.trim()
  }
  return ''
}

function buildAssistantGroup(messages: ChatMessage[], fallbackIndex: number): AssistantGroupItem {
  const entries: ChainEntry[] = []
  let hasThinkingHeader = false
  let isStreaming = false
  let finalAssistantMessage: ChatMessage | null = null
  const toolCardMap = new Map<string, ToolCard>()

  for (const message of messages) {
    if (message.isStreaming) {
      isStreaming = true
    }

    if (message.thinkingState === 'pending' || message.thinkingState === 'running') {
      hasThinkingHeader = true
    }

    if (Array.isArray(message.toolCards)) {
      for (const toolCard of message.toolCards) {
        const toolKey =
          toolCard.toolCallId ||
          `${toolCard.name}:${toolCard.detail || ''}:${JSON.stringify(toolCard.args || {})}`
        toolCardMap.set(toolKey, toolCard)
      }
    }
  }

  for (const message of messages) {
    if (Array.isArray(message.thinkingLog) && message.thinkingLog.length > 0) {
      hasThinkingHeader = true

      for (const logEntry of message.thinkingLog) {
        if (logEntry.type === 'text') {
          entries.push({
            type: 'text',
            text: logEntry.text,
          })
          continue
        }

        const toolCard = toolCardMap.get(logEntry.toolCallId)
        if (!toolCard) {
          continue
        }

        entries.push({
          type: 'tool',
          toolCard,
          detail: normalizeToolDetail(toolCard),
          completed: !!toolCard.completed || toolCard.kind === 'result',
          aborted: !!toolCard.aborted,
        })
      }
    }
  }

  if (entries.length > 0) {
    for (const message of messages) {
      if (message.role === 'assistant' && message.text.trim()) {
        finalAssistantMessage = message
      }
    }
  }

  if (entries.length > 0) {
    const id =
      messages.map((message) => message.id).join('-') ||
      `assistant-group-${fallbackIndex}-${Math.random().toString(36).slice(2, 8)}`

    return {
      id,
      type: 'assistant-group',
      role: 'assistant',
      finalAssistantMessage,
      chain: {
        hasThinkingHeader,
        isStreaming,
        entries,
      },
    }
  }

  for (const message of messages) {
    if (props.isStatusMessage(message)) {
      const statusKind = message.statusMeta?.kind
      if (statusKind === 'thinking') {
        hasThinkingHeader = true
        if (message.statusMeta?.state !== 'completed') {
          isStreaming = true
        }
        continue
      }

      if (statusKind === 'received' && message.text.trim()) {
        entries.push({
          type: 'text',
          text: message.text.trim(),
        })
        continue
      }

      if (statusKind === 'tool' && message.statusMeta?.toolCard) {
        entries.push({
          type: 'tool',
          toolCard: message.statusMeta.toolCard,
          detail: normalizeToolDetail(message.statusMeta.toolCard),
          completed:
            message.statusMeta.state === 'completed' ||
            !!message.statusMeta.toolCard.completed,
          aborted: message.statusMeta.state === 'aborted',
        })
        continue
      }
    }

    if (Array.isArray(message.toolCards) && message.toolCards.length > 0) {
      for (const toolCard of message.toolCards) {
        entries.push({
          type: 'tool',
          toolCard,
          detail: normalizeToolDetail(toolCard),
          completed: !!toolCard.completed || toolCard.kind === 'result',
          aborted: false,
        })
      }
    }

    if (message.role === 'assistant' && message.text.trim()) {
      finalAssistantMessage = message
    }
  }

  const id =
    messages.map((message) => message.id).join('-') ||
    `assistant-group-${fallbackIndex}-${Math.random().toString(36).slice(2, 8)}`

  return {
    id,
    type: 'assistant-group',
    role: 'assistant',
    finalAssistantMessage,
    chain: {
      hasThinkingHeader,
      isStreaming,
      entries,
    },
  }
}

const groupedItems = computed<GroupedItem[]>(() => {
  const items: GroupedItem[] = []
  let pendingAssistantMessages: ChatMessage[] = []

  const flushAssistantGroup = () => {
    if (!pendingAssistantMessages.length) {
      return
    }
    items.push(buildAssistantGroup(pendingAssistantMessages, items.length))
    pendingAssistantMessages = []
  }

  for (const message of props.messages) {
    if (message.role === 'user') {
      flushAssistantGroup()
      items.push({
        id: message.id,
        type: 'user',
        role: 'user',
        message,
      })
      continue
    }

    pendingAssistantMessages.push(message)
  }

  flushAssistantGroup()
  return items
})

function isGroupExpanded(groupId: string) {
  const group = groupedItems.value.find(
    (item): item is AssistantGroupItem => item.type === 'assistant-group' && item.id === groupId,
  )
  if (!group) {
    return false
  }
  // 如果正在流式传输，则始终展开
  if (group.chain.isStreaming) {
    return true
  }
  // 如果已完成思考，默认折叠（用户点击后才会展开）
  // 只有当用户显式展开（不在 collapsedGroupIds 中）时才显示
  return !collapsedGroupIds.value.has(groupId) && group.chain.isStreaming
}

function toggleGroup(groupId: string) {
  const next = new Set(collapsedGroupIds.value)
  if (next.has(groupId)) {
    next.delete(groupId)
  } else {
    next.add(groupId)
  }
  collapsedGroupIds.value = next
}

function getToolEntryKey(groupId: string, entryIndex: number) {
  return `${groupId}:${entryIndex}`
}

function isToolEntryExpanded(groupId: string, entryIndex: number) {
  const key = getToolEntryKey(groupId, entryIndex)
  if (expandedToolEntryIds.value.has(key)) {
    return true
  }

  const group = groupedItems.value.find(
    (item): item is AssistantGroupItem => item.type === 'assistant-group' && item.id === groupId,
  )
  const entry = group?.chain.entries[entryIndex]
  if (!entry || entry.type !== 'tool') {
    return false
  }

  return !!entry.detail && !entry.completed && !entry.aborted
}

function toggleToolEntry(groupId: string, entryIndex: number) {
  const next = new Set(expandedToolEntryIds.value)
  const key = getToolEntryKey(groupId, entryIndex)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  expandedToolEntryIds.value = next
}

function scrollToBottom() {
  const messageList = scrollContainerRef.value
  if (!messageList) {
    return
  }

  messageList.scrollTop = messageList.scrollHeight

  window.requestAnimationFrame(() => {
    if (scrollContainerRef.value === messageList) {
      messageList.scrollTop = messageList.scrollHeight
    }
  })
}

defineExpose({
  scrollToBottom,
})
</script>
