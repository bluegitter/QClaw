<template>
  <div class="init-loading-page">
    <header class="init-loading-header">
      <div class="init-loading-drag-region"></div>
      <div v-if="showWindowControls" class="init-loading-window-controls">
        <button class="init-loading-window-btn" type="button" aria-label="最小化" @click="handleMinimize">
          <span></span>
        </button>
        <button class="init-loading-window-btn" type="button" aria-label="最大化" @click="handleMaximize">
          <span class="is-square"></span>
        </button>
        <button class="init-loading-window-btn is-close" type="button" aria-label="关闭" @click="handleClose">
          <span class="is-close-mark"></span>
        </button>
      </div>
    </header>

    <main class="init-loading-main">
      <section class="init-loading-hero">
        <div class="init-loading-icon-shell">
          <img :src="qmIconImage" alt="QClaw" class="init-loading-icon" />
        </div>

        <h1 class="init-loading-title">QClaw正在启动中，你的小龙虾马上就位</h1>

        <div class="init-loading-progress-track" aria-hidden="true">
          <div class="init-loading-progress-fill" :style="{ width: `${progress}%` }"></div>
        </div>

        <p class="init-loading-status">{{ statusText }}</p>
      </section>

    </main>

    <div v-if="showModeDialog" class="init-loading-modal-mask">
      <div class="init-loading-modal" role="dialog" aria-modal="true" aria-labelledby="boot-mode-title">
        <h2 id="boot-mode-title" class="init-loading-modal-title">
          {{ bootState?.previousMode === 'shared' && !externalInstance?.detected ? '关联的 OpenClaw 实例未启动' : '检测到本地已安装 OpenClaw，是否一键关联？' }}
        </h2>
        <p class="init-loading-modal-subtitle">
          {{ bootState?.previousMode === 'shared' && !externalInstance?.detected
            ? '之前使用的是关联模式，但本地 OpenClaw 实例当前未运行。请启动 OpenClaw 后重试，或切换为独立运行模式。'
            : '不关联将以隔离模式启动，两个实例相互独立。' }}
        </p>

        <div v-if="externalInstance?.port" class="init-loading-modal-instance">
          <span>检测到的实例：端口 {{ externalInstance.port }}</span>
          <span :class="externalInstance.healthy ? 'is-running' : 'is-stopped'">
            {{ externalInstance.healthy ? '运行中' : '已停止' }}
          </span>
        </div>

        <div class="init-loading-modal-actions">
          <button
            v-if="bootState?.previousMode === 'shared' && !externalInstance?.detected"
            type="button"
            class="init-loading-modal-btn is-primary"
            :disabled="actionPending"
            @click="retryBoot"
          >
            重新检测
          </button>
          <button
            v-else
            type="button"
            class="init-loading-modal-btn is-primary"
            :disabled="actionPending"
            @click="selectMode('shared')"
          >
            关联
          </button>

          <button
            type="button"
            class="init-loading-modal-btn"
            :disabled="actionPending"
            @click="selectMode('isolated')"
          >
            {{ bootState?.previousMode === 'shared' && !externalInstance?.detected ? '独立运行' : '暂不关联' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { InstanceBootState, InstanceMode, ProcessStatus } from '@guanjia-openclaw/shared'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import loadingBgImage from '../../assets/loading-bg.png'
import qmIconImage from '../../assets/qm-icon.png'

const router = useRouter()

const showWindowControls = window.electronAPI?.platform !== 'darwin'
const progress = ref(16)
const bootState = ref<InstanceBootState | null>(null)
const processStatus = ref<ProcessStatus | null>(null)
const phase = ref<'detecting' | 'waiting' | 'initializing' | 'ready' | 'error'>('detecting')
const errorMessage = ref('')
const showModeDialog = ref(false)
const actionPending = ref(false)

let progressTimer: ReturnType<typeof setInterval> | null = null
let unsubscribeBootState: (() => void) | null = null
let unsubscribeStatusChange: (() => void) | null = null
let isNavigating = false

const externalInstance = computed(() => bootState.value?.externalInstance ?? null)
const statusText = computed(() => {
  if (errorMessage.value) {
    return errorMessage.value
  }

  if (phase.value === 'waiting') {
    return '检测到本地已安装 OpenClaw，请选择运行模式'
  }

  if (phase.value === 'initializing') {
    if (processStatus.value?.status === 'starting') {
      return '服务进程启动中，请稍候...'
    }
    if (processStatus.value?.status === 'running') {
      return '服务进程已启动，正在等待就绪...'
    }
    return '正在启动 OpenClaw 服务，请稍候...'
  }

  if (phase.value === 'ready') {
    return '启动完成，正在进入聊天界面...'
  }

  return '正在检测并初始化 OpenClaw 服务...'
})

function setProgressTarget(target: number, duration = 600) {
  if (progressTimer) {
    clearInterval(progressTimer)
    progressTimer = null
  }

  const safeTarget = Math.max(0, Math.min(100, target))
  const start = progress.value
  const delta = safeTarget - start

  if (delta === 0) {
    return
  }

  const steps = Math.max(1, Math.round(duration / 16))
  let currentStep = 0
  progressTimer = setInterval(() => {
    currentStep += 1
    progress.value = start + (delta * currentStep) / steps
    if (currentStep >= steps) {
      progress.value = safeTarget
      clearInterval(progressTimer!)
      progressTimer = null
    }
  }, 16)
}

function handleMinimize() {
  window.electronAPI?.window.minimize()
}

function handleMaximize() {
  window.electronAPI?.window.maximize()
}

function handleClose() {
  window.electronAPI?.window.close()
}

async function completeBoot() {
  if (isNavigating) {
    return
  }

  isNavigating = true
  phase.value = 'ready'
  setProgressTarget(100, 320)
  window.setTimeout(() => {
    router.replace('/chat')
  }, 380)
}

async function waitForServiceReady() {
  phase.value = 'initializing'
  setProgressTarget(Math.max(progress.value, 78), 520)

  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const status = await window.electronAPI?.process.getStatus()
      if (status) {
        processStatus.value = status
      }

      if (status?.status === 'running') {
        await completeBoot()
        return
      }

      if (status?.status === 'stopped' && bootState.value?.mode === 'shared' && externalInstance.value?.healthy) {
        await completeBoot()
        return
      }

      const nextProgress = Math.min(96, 78 + ((attempt + 1) / 120) * 18)
      setProgressTarget(nextProgress, 900)
      await new Promise((resolve) => window.setTimeout(resolve, 1000))
    }

    errorMessage.value = '服务启动超时，请稍后重试'
    phase.value = 'error'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '服务启动失败，请稍后重试'
    phase.value = 'error'
  }
}

async function selectMode(mode: InstanceMode) {
  actionPending.value = true
  showModeDialog.value = false
  errorMessage.value = ''

  try {
    await window.electronAPI?.instance.setMode(mode)
    if (bootState.value) {
      bootState.value = {
        ...bootState.value,
        mode,
        needsUserChoice: false,
      }
    }
    await waitForServiceReady()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '模式设置失败，请稍后重试'
    phase.value = 'error'
    showModeDialog.value = true
  } finally {
    actionPending.value = false
  }
}

async function retryBoot() {
  actionPending.value = true
  errorMessage.value = ''

  try {
    const nextState = await window.electronAPI?.instance.retryBoot()
    if (nextState) {
      applyBootState(nextState)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '重新检测失败，请稍后重试'
    phase.value = 'error'
  } finally {
    actionPending.value = false
  }
}

function applyBootState(state: InstanceBootState) {
  bootState.value = state

  if (state.needsUserChoice) {
    phase.value = 'waiting'
    setProgressTarget(46, 420)
    showModeDialog.value = true
    return
  }

  showModeDialog.value = false
  void waitForServiceReady()
}

onMounted(async () => {
  document.documentElement.style.setProperty('--init-loading-bg-image', `url("${loadingBgImage}")`)
  setProgressTarget(28, 900)

  unsubscribeBootState = window.electronAPI?.instance.onBootState((state) => {
    applyBootState(state)
  }) ?? null

  unsubscribeStatusChange = window.electronAPI?.process.onStatusChange((status) => {
    processStatus.value = status
  }) ?? null

  try {
    const [initialBootState, initialProcessStatus] = await Promise.all([
      window.electronAPI?.instance.getBootState(),
      window.electronAPI?.process.getStatus(),
    ])

    if (initialProcessStatus) {
      processStatus.value = initialProcessStatus
    }

    if (initialBootState) {
      applyBootState(initialBootState)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '启动状态读取失败'
    phase.value = 'error'
  }
})

onBeforeUnmount(() => {
  if (progressTimer) {
    clearInterval(progressTimer)
  }
  unsubscribeBootState?.()
  unsubscribeStatusChange?.()
})
</script>
