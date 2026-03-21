<template>
  <aside :class="['qclaw-sidebar', !sidebarVisible && 'qclaw-sidebar-collapsed']">
    <div class="qclaw-sidebar-top">
      <div v-if="isMacos" class="qclaw-sidebar-top-spacer" aria-hidden="true"></div>
      <div v-if="!isMacos" class="qclaw-traffic-lights">
        <span class="traffic-dot traffic-dot-close"></span>
        <span class="traffic-dot traffic-dot-minimize"></span>
        <span class="traffic-dot traffic-dot-maximize"></span>
      </div>

      <button class="qclaw-sidebar-toggle" @click="$emit('toggle-sidebar')" aria-label="切换侧边栏">
        <span class="qclaw-sidebar-toggle-icon">◧</span>
      </button>
    </div>

    <button class="qclaw-new-chat" @click="$emit('start-new-chat')">
      <img :src="newChatIcon" alt="" class="qclaw-new-chat-icon" aria-hidden="true" />
      <span>新建对话</span>
    </button>

    <div class="qclaw-history-heading">历史对话</div>

    <div class="qclaw-history-list">
      <div
        v-for="session in sessions"
        :key="session.key"
        :class="['qclaw-history-item', currentSessionKey === session.key && 'is-active']"
        @click="$emit('select-session', session.key)"
      >
        <span class="qclaw-history-item-text">{{ session.label || '新对话' }}</span>
        <button
          type="button"
          class="qclaw-history-item-delete"
          title="删除会话"
          aria-label="删除会话"
          :disabled="isProtectedSession(session.key)"
          @click.stop="$emit('delete-session', session.key)"
        >
          ×
        </button>
      </div>
    </div>

    <div class="qclaw-sidebar-footer">
      <div class="qclaw-sidebar-footer-row">
        <div class="qclaw-sidebar-footer-main">
          <div class="qclaw-user-popover-wrap">
            <button class="qclaw-user-row" type="button">
              <div class="qclaw-user-avatar"></div>
              <div class="qclaw-user-name">{{ loginUserName }}</div>
            </button>
          </div>
        </div>

        <button
          type="button"
          class="qclaw-sidebar-settings-btn"
          aria-label="系统设置"
          @click="$emit('open-system-settings')"
        >
          <img :src="settingIcon" alt="设置" />
        </button>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import newChatIcon from '../../../../assets/sidebar-new-chat-icon.svg'
import settingIcon from '../../../../assets/sidebar-setting-icon.svg'
import type { ChatSessionItem } from '../types'

defineProps<{
  isMacos: boolean
  sidebarVisible: boolean
  sessions: ChatSessionItem[]
  currentSessionKey: string
  loginUserName: string
  isProtectedSession: (sessionKey: string) => boolean
}>()

defineEmits<{
  (event: 'toggle-sidebar'): void
  (event: 'start-new-chat'): void
  (event: 'select-session', sessionKey: string): void
  (event: 'delete-session', sessionKey: string): void
  (event: 'open-system-settings'): void
}>()
</script>
