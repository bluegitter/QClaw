<template>
  <div v-if="show" class="qclaw-modal-mask" @click.self="emit('close')">
    <section class="qclaw-auth-modal qclaw-remote-modal">
      <button class="qclaw-auth-close" @click="emit('close')">×</button>

      <div v-if="state === 'disconnected' || state === 'connecting'" class="qclaw-remote-modal-content">
        <div class="qclaw-remote-header">
          <h2 class="qclaw-remote-title">扫码关联微信，手机操控电脑</h2>
          <p class="qclaw-remote-desc">扫码后可通过微信与客服号对话发送指令操控电脑</p>
        </div>

        <div class="qclaw-remote-body">
          <div v-if="state === 'disconnected'" class="qclaw-remote-qr-placeholder">
            <div class="qclaw-remote-qr-box is-loading">
              <div class="qclaw-remote-loading-icon"></div>
              <span class="qclaw-remote-loading-text">正在生成二维码...</span>
            </div>
          </div>

          <div v-else class="qclaw-remote-qr-wrapper">
            <div class="qclaw-remote-qr-box">
              <img :src="qrImageUrl" alt="wechat qr" class="qclaw-remote-qr-image" />
            </div>
          </div>

          <div class="qclaw-remote-scan-tip">
            <span v-if="state === 'connecting'" class="qclaw-remote-connected-dot"></span>
            <span class="qclaw-remote-scan-tip-text">使用微信扫一扫</span>
          </div>

          <div class="qclaw-remote-warning-tip">
            扫码验证后的微信可以直接操控电脑，请谨慎保管二维码
          </div>

          <div v-if="countdownSeconds > 0" class="qclaw-remote-countdown">
            二维码将在 {{ countdownSeconds }} 秒后失效
          </div>
        </div>
      </div>

      <div v-else-if="state === 'connected'" class="qclaw-remote-modal-content">
        <div class="qclaw-remote-header">
          <h2 class="qclaw-remote-title">微信已连接</h2>
          <p class="qclaw-remote-desc">请确认远程操控方</p>
        </div>

        <div class="qclaw-remote-connected-body">
          <div class="qclaw-remote-connected-avatar-wrap">
            <img
              v-if="remoteUserInfo?.avatar"
              :src="remoteUserInfo.avatar"
              alt="avatar"
              class="qclaw-remote-connected-avatar"
            />
            <div v-else class="qclaw-remote-connected-avatar qclaw-remote-connected-avatar-default"></div>
          </div>

          <div class="qclaw-remote-connected-name">
            <span class="qclaw-remote-connected-success-dot"></span>
            <span>{{ remoteUserInfo?.nickname || '未知用户' }}</span>
          </div>

          <div class="qclaw-remote-connected-actions">
            <button class="qclaw-remote-primary-btn" @click="emit('confirm')">确定</button>
            <button class="qclaw-remote-secondary-btn" @click="emit('disconnect')">断开连接</button>
          </div>
        </div>
      </div>

      <div v-else class="qclaw-remote-modal-content">
        <div class="qclaw-remote-header">
          <h2 class="qclaw-remote-title">连接失败</h2>
          <p class="qclaw-remote-desc">{{ errorMessage || '连接超时，请重试' }}</p>
        </div>

        <div class="qclaw-remote-failed-body">
          <button class="qclaw-remote-primary-btn" @click="emit('retry')">重新连接</button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { RemoteUserInfo } from '../types'

defineProps<{
  show: boolean
  state: 'disconnected' | 'connecting' | 'connected' | 'failed'
  qrImageUrl: string
  countdownSeconds: number
  remoteUserInfo: RemoteUserInfo | null
  errorMessage: string
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'confirm'): void
  (event: 'disconnect'): void
  (event: 'retry'): void
}>()
</script>
