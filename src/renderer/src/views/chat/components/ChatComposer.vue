<template>
  <footer class="qclaw-input-shell">
    <div class="qclaw-input-area">
      <div class="qclaw-input-card">
        <div class="qclaw-textarea-wrap">
          <textarea
            ref="textareaRef"
            :value="modelValue"
            class="qclaw-input"
            rows="1"
            placeholder="继续输入问题..."
            @input="handleInput"
            @keydown.enter.exact.prevent="emit('send')"
          />
        </div>

        <div class="qclaw-input-footer">
          <div class="qclaw-input-footer-left">
            <button
              type="button"
              class="qclaw-model-pill"
              :disabled="isSending"
              @click="emit('open-model-settings')"
            >
              <span class="qclaw-model-pill-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" focusable="false">
                  <path
                    d="M8.0013 0.666687L14.3346 4.33335V11.6667L8.0013 15.3334L1.66797 11.6667V4.33335L8.0013 0.666687ZM8.0013 2.20735L3.66397 4.71869L2.99997 5.10469V10.8954L7.33464 13.4067L8.0013 13.7907L13.0013 10.8974L13.0026 5.10402L8.0013 2.20802V2.20735Z"
                  />
                  <path
                    d="M11.0054 5.48932L11.6674 5.87332V6.64665L8.66737 8.38399L8.6667 11.864L8.00003 12.2507L7.33336 11.8647V8.38465L4.33203 6.64665V5.87332L4.99403 5.48932L8.0007 7.22932L11.0054 5.48932Z"
                  />
                </svg>
              </span>
              <span>{{ currentModelLabel }}</span>
              <span class="qclaw-model-pill-arrow" aria-hidden="true">⌄</span>
            </button>
          </div>

          <button
            type="button"
            class="qclaw-send-btn"
            :disabled="!canSendMessage"
            aria-label="发送"
            @click="emit('send')"
          >
            <span class="qclaw-send-btn-icon" aria-hidden="true">
              <svg viewBox="0 0 18 18" focusable="false">
                <path
                  d="M9.19839 1.01086C9.48476 1.1444 9.71176 1.37186 9.84833 1.64435L15.0478 11.9466C15.4052 12.6774 15.1138 13.5594 14.3979 13.9303C14.0522 14.0936 13.662 14.1267 13.298 14.0137L9.63016 12.887C9.29431 12.7838 9.06508 12.4736 9.06508 12.1223L9.06508 8.1791C9.06391 7.88926 8.82974 7.65226 8.53179 7.64565C8.23846 7.64748 8.00136 7.88156 7.99851 8.1791L7.99851 12.1194C7.99851 12.4721 7.76749 12.7832 7.42983 12.8852L3.74891 13.997C2.98121 14.2296 2.16239 13.7905 1.93241 13.0135C1.81934 12.6538 1.85366 12.2647 2.03241 11.9299L7.23191 1.64435C7.59889 0.925848 8.48193 0.636681 9.19839 1.01086Z"
                />
              </svg>
            </span>
          </button>
        </div>
      </div>
    </div>

    <div class="qclaw-disclaimer">内容由AI生成，请仔细甄别</div>
  </footer>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: string
  isSending: boolean
  canSendMessage: boolean
  currentModelLabel: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'send'): void
  (event: 'open-model-settings'): void
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)

function syncInputHeight() {
  const textarea = textareaRef.value
  if (!textarea) {
    return
  }

  textarea.style.height = 'auto'
  const computedStyle = window.getComputedStyle(textarea)
  const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 21
  const maxHeight = lineHeight * 4
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
}

function handleInput(event: Event) {
  const nextValue = (event.target as HTMLTextAreaElement).value
  emit('update:modelValue', nextValue)
  syncInputHeight()
}

function focusInput() {
  textareaRef.value?.focus()
}

watch(
  () => props.modelValue,
  () => {
    void nextTick(() => {
      syncInputHeight()
    })
  },
  { immediate: true },
)

defineExpose({
  syncInputHeight,
  focusInput,
})
</script>
