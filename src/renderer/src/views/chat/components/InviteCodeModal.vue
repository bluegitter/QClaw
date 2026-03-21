<template>
  <div v-if="visible" class="qclaw-modal-mask" @click.self="emit('close')">
    <section class="qclaw-invite-modal">
      <button class="qclaw-invite-close" @click="emit('close')">×</button>

      <div class="qclaw-invite-modal-bg"></div>

      <div class="qclaw-invite-modal-content">
        <div class="qclaw-invite-icon-section">
          <div class="qclaw-invite-icon-bg">
            <img class="qclaw-invite-lock-img" :src="inviteLockImage" alt="lock" />
          </div>
        </div>

        <h2 class="qclaw-invite-title">你当前暂无使用权限 ~</h2>
        <p class="qclaw-invite-desc">产品正在内测中，输入邀请码即可体验，正式版敬请期待。</p>

        <div class="qclaw-invite-input-section">
          <input
            v-model="inviteCode"
            class="qclaw-invite-input"
            type="text"
            maxlength="20"
            placeholder="请输入邀请码"
            @keydown.enter="submitInviteCode"
          />
        </div>

        <div v-if="errorMessage" class="qclaw-invite-error">{{ errorMessage }}</div>

        <button
          class="qclaw-invite-submit-btn"
          :disabled="submitting || !inviteCode.trim()"
          @click="submitInviteCode"
        >
          {{ submitting ? '提交中...' : '立即体验' }}
        </button>

        <div class="qclaw-invite-footer">
          <span>我没有邀请码，</span>
          <button type="button" class="qclaw-invite-apply-link" @click="applyInviteCode">
            申请邀请码
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import inviteLockImage from '../../../assets/invite-lock.png'
import modalBgImage from '../../../assets/modal-bg.png'
import { o as openclawApiService } from '../../../assets/platform.js'

const props = defineProps<{
  visible: boolean
  userId: string | number
}>()

const emit = defineEmits<{
  (event: 'verified'): void
  (event: 'close'): void
}>()

const inviteCode = ref('')
const submitting = ref(false)
const errorMessage = ref('')

watch(
  () => props.visible,
  (visible) => {
    if (!visible) {
      inviteCode.value = ''
      errorMessage.value = ''
      submitting.value = false
    }
  },
)

async function submitInviteCode() {
  const code = inviteCode.value.trim()
  if (!code || submitting.value) {
    return
  }

  submitting.value = true
  errorMessage.value = ''

  try {
    const result = await openclawApiService.submitInviteCode({
      user_id: props.userId,
      code,
    })

    const common =
      result?.data?.resp?.common ??
      result?.data?.common ??
      result?.data?.data?.common ??
      null
    const businessCode = common?.code

    if (result?.success && businessCode === 0) {
      emit('verified')
      return
    }

    errorMessage.value = common?.message || result?.message || '邀请码验证失败，请重试'
  } catch (error) {
    console.error('[InviteCodeModal] 提交邀请码异常:', error)
    errorMessage.value = '网络异常，请稍后重试'
  } finally {
    submitting.value = false
  }
}

function applyInviteCode() {
  window.open('https://wj.qq.com/s2/25871229/abe7/', '_blank')
}
</script>

<style scoped>
.qclaw-invite-modal {
  position: relative;
  width: min(440px, calc(100vw - 32px));
  border: 1px solid rgba(255, 255, 255, 0.92);
  border-radius: 20px;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 0 24px rgba(0, 0, 0, 0.12);
}

.qclaw-invite-modal-bg {
  position: absolute;
  inset: 0 0 auto;
  height: 200px;
  background: url(v-bind('modalBgImage')) no-repeat center top / 100% auto;
  pointer-events: none;
}

.qclaw-invite-close {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 2;
  width: 28px;
  height: 28px;
  border: 0;
  background: transparent;
  font-size: 22px;
  line-height: 1;
  color: #666;
  cursor: pointer;
}

.qclaw-invite-modal-content {
  position: relative;
  z-index: 1;
  padding: 24px 24px 28px;
  text-align: center;
}

.qclaw-invite-icon-section {
  display: flex;
  justify-content: center;
  margin-bottom: 20px;
}

.qclaw-invite-icon-bg {
  display: flex;
  width: 160px;
  height: 160px;
  align-items: center;
  justify-content: center;
}

.qclaw-invite-lock-img {
  width: 160px;
  height: 160px;
  object-fit: contain;
}

.qclaw-invite-title {
  margin: 0 0 12px;
  font-size: 22px;
  line-height: 1.3;
  font-weight: 700;
  color: #1a1a1a;
}

.qclaw-invite-desc {
  margin: 0 0 20px;
  font-size: 14px;
  line-height: 1.6;
  color: #999;
}

.qclaw-invite-input-section {
  margin-bottom: 8px;
}

.qclaw-invite-input {
  width: 100%;
  height: 40px;
  padding: 0 16px;
  border: 1px solid #e8e8e8;
  border-radius: 110px;
  outline: none;
  font-size: 15px;
  transition: border-color 0.2s ease;
}

.qclaw-invite-input:hover,
.qclaw-invite-input:focus {
  border-color: #4a90d9;
}

.qclaw-invite-error {
  min-height: 20px;
  margin-bottom: 8px;
  font-size: 13px;
  color: #ff4d4f;
  text-align: left;
}

.qclaw-invite-submit-btn {
  width: 100%;
  height: 40px;
  margin-top: 16px;
  border: 0;
  border-radius: 30px;
  background: #2f2f2f;
  color: #fff;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
}

.qclaw-invite-submit-btn:disabled {
  background: #c0c0c0;
  cursor: not-allowed;
}

.qclaw-invite-footer {
  margin-top: 20px;
  font-size: 14px;
  color: #999;
}

.qclaw-invite-apply-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: #4a90d9;
  cursor: pointer;
}

.qclaw-invite-apply-link:hover {
  text-decoration: underline;
}
</style>
