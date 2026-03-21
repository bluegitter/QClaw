<template>
  <header class="qclaw-topbar">
    <div class="qclaw-topbar-left">
      <button
        v-if="!sidebarVisible"
        class="qclaw-topbar-sidebar-btn"
        aria-label="显示侧边栏"
        @click="emit('toggle-sidebar')"
      >
        <span class="qclaw-sidebar-toggle-icon">◧</span>
      </button>
    </div>

    <div class="qclaw-topbar-right">
      <span class="qclaw-version">{{ version }}</span>
      <button class="qclaw-topbar-link" @click="emit('feedback')">问题反馈</button>
      <button class="qclaw-topbar-link" @click="emit('check-updates')">检测更新</button>
    </div>
  </header>
</template>

<script setup lang="ts">
defineProps<{
  sidebarVisible: boolean
  version: string
}>()

const emit = defineEmits<{
  (event: 'toggle-sidebar'): void
  (event: 'feedback'): void
  (event: 'check-updates'): void
}>()
</script>
