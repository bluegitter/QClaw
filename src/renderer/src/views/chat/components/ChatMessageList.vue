<template>
  <div ref="scrollContainerRef" class="qclaw-chat-scroll">
    <div class="qclaw-messages">
      <article
        v-for="message in messages"
        :key="message.id"
        :class="['qclaw-message', `qclaw-message-${getDisplayRole(message)}`]"
      >
        <template v-if="isStandaloneToolMessage(message)">
          <div class="qclaw-tool-cards qclaw-tool-cards-standalone">
            <div
              v-for="(toolCard, toolCardIndex) in message.toolCards"
              :key="`${message.id}-tool-${toolCardIndex}`"
              class="qclaw-tool-card"
            >
              <div class="qclaw-tool-card-header">
                <div class="qclaw-tool-card-title">
                  <span class="qclaw-tool-card-icon" v-html="getToolCardIcon(toolCard.name)"></span>
                  <span>{{ formatToolCardName(toolCard.name) }}</span>
                </div>

                <span v-if="isToolCardCompleted(toolCard)" class="qclaw-tool-card-status">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </span>

                <button
                  v-else-if="toolCard.text"
                  type="button"
                  class="qclaw-tool-card-action"
                  @click="openToolCardResult(toolCard)"
                >
                  View
                </button>
              </div>

              <div v-if="toolCard.detail" class="qclaw-tool-card-detail">{{ toolCard.detail }}</div>
              <div v-if="showToolCardCompletedLabel(toolCard)" class="qclaw-tool-card-status-text">
                Completed
              </div>
              <div v-else-if="isInlineToolCardText(toolCard)" class="qclaw-tool-card-inline">
                {{ toolCard.text }}
              </div>
              <div v-else-if="toolCard.text" class="qclaw-tool-card-preview">
                {{ getToolCardPreview(toolCard.text) }}
              </div>
            </div>
          </div>
        </template>

        <div v-else :class="['qclaw-bubble', `qclaw-bubble-${getDisplayRole(message)}`]">
          <template v-if="message.title">
            <h3 class="qclaw-message-title">{{ message.title }}</h3>
          </template>

          <div
            v-if="message.role === 'assistant'"
            class="qclaw-message-text qclaw-message-markdown"
            v-html="renderMessageHtml(message)"
          ></div>

          <p v-else class="qclaw-message-plain">
            {{ message.text }}
          </p>

          <div v-if="message.toolCards?.length" class="qclaw-tool-cards">
            <div
              v-for="(toolCard, toolCardIndex) in message.toolCards"
              :key="`${message.id}-inline-tool-${toolCardIndex}`"
              class="qclaw-tool-card"
            >
              <div class="qclaw-tool-card-header">
                <div class="qclaw-tool-card-title">
                  <span class="qclaw-tool-card-icon" v-html="getToolCardIcon(toolCard.name)"></span>
                  <span>{{ formatToolCardName(toolCard.name) }}</span>
                </div>

                <span v-if="isToolCardCompleted(toolCard)" class="qclaw-tool-card-status">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </span>
              </div>

              <div v-if="toolCard.detail" class="qclaw-tool-card-detail">{{ toolCard.detail }}</div>
              <div v-if="isToolCardCompleted(toolCard)" class="qclaw-tool-card-status-text">
                Completed
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { ChatMessage, ToolCard } from '../types'

const props = defineProps<{
  messages: ChatMessage[]
  getDisplayRole: (message: ChatMessage) => string
  isStandaloneToolMessage: (message: ChatMessage) => boolean
  isToolCardCompleted: (toolCard: ToolCard) => boolean
  showToolCardCompletedLabel: (toolCard: ToolCard) => boolean
  isInlineToolCardText: (toolCard: ToolCard) => boolean
  getToolCardPreview: (text: string) => string
  getToolCardIcon: (toolName: string) => string
  formatToolCardName: (toolName: string) => string
  renderMessageHtml: (message: ChatMessage) => string
  openToolCardResult: (toolCard: ToolCard) => void
}>()

void props

const scrollContainerRef = ref<HTMLElement | null>(null)

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
