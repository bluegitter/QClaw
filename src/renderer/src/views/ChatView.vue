<template>
  <div
    :class="[
      'qclaw-page',
      isMacOS && 'qclaw-page-macos',
      !sidebarVisible && 'qclaw-page-sidebar-collapsed',
    ]"
  >
    <ChatSidebar
      :is-macos="isMacOS"
      :sidebar-visible="sidebarVisible"
      :sessions="sessions"
      :current-session-key="currentSessionKey"
      :login-user-name="loginUserName"
      :is-protected-session="isProtectedSessionKey"
      @toggle-sidebar="toggleSidebar"
      @start-new-chat="startNewChat"
      @select-session="selectSession"
      @delete-session="deleteChatSession"
      @open-system-settings="openSystemSettings()"
    />

    <main class="qclaw-main">
      <ChatTopbar
        :sidebar-visible="sidebarVisible"
        version="v0.1.1"
        @toggle-sidebar="toggleSidebar"
        @feedback="openOfficialSite"
        @check-updates="openAboutAndCheckUpdates"
      />

      <section class="qclaw-chat-layout">
        <ChatMessageList
          ref="messageListRef"
          :messages="messages"
          :get-display-role="getDisplayRole"
          :is-status-message="isStatusMessage"
          :is-standalone-tool-message="isStandaloneToolMessage"
          :is-tool-card-completed="isToolCardCompleted"
          :show-tool-card-completed-label="showToolCardCompletedLabel"
          :is-inline-tool-card-text="isInlineToolCardText"
          :get-tool-card-preview="getToolCardPreview"
          :get-tool-card-icon="getToolCardIcon"
          :format-tool-card-name="formatToolCardName"
          :format-tool-status-text="formatToolStatusText"
          :format-tool-detail-text="formatToolDetailText"
          :render-message-html="renderMessageHtml"
          :open-tool-card-result="openToolCardResult"
        />

        <ChatComposer
          ref="messageInputRef"
          v-model="draftText"
          :is-sending="isSending"
          :can-send-message="canSendMessage"
          :current-model-label="currentModelLabel"
          @send="sendMessage"
          @open-model-settings="openModelSettings"
        />
      </section>
    </main>

    <SystemSettingsModal
      :show="showSystemSettings"
      :initial-tab="systemSettingsInitialTab"
      :check-updates-on-open="checkUpdatesOnSystemSettingsOpen"
      :system-settings-version="systemSettingsVersion"
      :system-settings-gateway-label="systemSettingsGatewayLabel"
      :usage-stats="usageStats"
      :remote-channel-cards="remoteChannelCards"
      :open-official-site="openOfficialSite"
      @close="closeSystemSettings"
      @open-model-settings="openModelSettingsFromSystem"
      @open-remote-channel="openRemoteChannel"
      @request-create-skill-by-chat="requestCreateSkillByChat"
    />

    <div v-if="showModelSettings" class="qclaw-modal-mask" @click.self="closeModelSettings">
      <section class="qclaw-model-modal">
        <header class="qclaw-model-modal-header">
          <h2>大模型设置</h2>
          <button class="qclaw-modal-close" @click="closeModelSettings">×</button>
        </header>

        <div class="qclaw-model-mode-list">
          <label class="qclaw-model-mode">
            <input v-model="modelType" type="radio" value="default" />
            <span class="qclaw-model-mode-dot"></span>
            <div class="qclaw-model-mode-copy">
              <div class="qclaw-model-mode-title">默认大模型</div>
              <div class="qclaw-model-mode-desc">
                内置 Kimi-K2.5、Minimax-M2.5、GLM-5、DeepSeek-V3.2，将根据网络状况智能分配
              </div>
            </div>
          </label>

          <label class="qclaw-model-mode">
            <input v-model="modelType" type="radio" value="custom" />
            <span class="qclaw-model-mode-dot"></span>
            <div class="qclaw-model-mode-copy">
              <div class="qclaw-model-mode-title">自定义大模型</div>
              <div class="qclaw-model-mode-desc">
                可选用自定义大模型配置，使用时请遵循相关法律法规
              </div>
            </div>
          </label>
        </div>

        <div v-if="modelType === 'custom'" class="qclaw-model-form">
          <label class="qclaw-form-field">
            <span class="qclaw-form-label">模型厂商：</span>
            <div ref="providerDropdownRef" class="qclaw-form-select-wrap">
              <button
                type="button"
                class="qclaw-form-select qclaw-form-select-trigger"
                :class="{ 'is-open': providerDropdownOpen }"
                @click="toggleProviderDropdown"
              >
                <span>{{ providerLabel }}</span>
                <span class="qclaw-select-arrow">﹀</span>
              </button>

              <div v-if="providerDropdownOpen" class="qclaw-form-select-menu">
                <button
                  v-for="option in CHAT_MODEL_PROVIDER_OPTIONS"
                  :key="option.key"
                  type="button"
                  class="qclaw-form-select-option"
                  :class="{ 'is-active': option.key === provider }"
                  @click="selectProvider(option.key)"
                >
                  <span>{{ option.label }}</span>
                  <span v-if="option.key === provider" class="qclaw-form-select-check">✓</span>
                </button>
              </div>
            </div>
          </label>

          <div v-if="showAuthModeFields" class="qclaw-form-field">
            <span class="qclaw-form-label">认证方式：</span>
            <div class="qclaw-auth-mode-list">
              <button
                type="button"
                :class="['qclaw-auth-mode-option', authMode === MODEL_AUTH_MODE_API_KEY && 'is-active']"
                @click="authMode = MODEL_AUTH_MODE_API_KEY"
              >
                API Key
              </button>
              <button
                type="button"
                :class="[
                  'qclaw-auth-mode-option',
                  authMode === MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH && 'is-active',
                ]"
                @click="authMode = MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH"
              >
                Codex Token
              </button>
            </div>
            <div class="qclaw-form-hint">
              {{ authModeHint }}
            </div>
          </div>

          <label v-if="showBaseUrlField" class="qclaw-form-field">
            <span class="qclaw-form-label">Base URL：</span>
            <input
              v-model="baseUrl"
              class="qclaw-form-input"
              type="text"
              :readonly="isOpenAIProvider || isCodexProvider"
            />
          </label>

          <label v-if="showCustomFields" class="qclaw-form-field">
            <span class="qclaw-form-label">{{ tokenLabel }}</span>
            <div class="qclaw-token-wrap">
              <input
                v-model="token"
                class="qclaw-form-input qclaw-token-input"
                :type="tokenVisible ? 'text' : 'password'"
                :placeholder="tokenPlaceholder"
              />
              <button type="button" class="qclaw-token-toggle" @click="tokenVisible = !tokenVisible">
                {{ tokenVisible ? '🙈' : '◉' }}
              </button>
            </div>
            <div
              v-if="isCodexProvider"
              class="qclaw-token-helper-row"
            >
              <button
                type="button"
                class="qclaw-token-import-btn"
                :disabled="isImportingCodexAuth"
                @click="importCodexAuthToken"
              >
                {{ isImportingCodexAuth ? '读取中...' : '从 Codex 导入' }}
              </button>
              <span class="qclaw-token-helper-text">读取 `~/.codex/auth.json` 中的 access token</span>
            </div>
          </label>

          <label v-if="showModelSelect" class="qclaw-form-field">
            <span class="qclaw-form-label">Model ID：</span>
            <div ref="modelDropdownRef" class="qclaw-form-select-wrap">
              <button
                type="button"
                class="qclaw-form-select qclaw-form-select-trigger"
                :class="{ 'is-open': modelDropdownOpen }"
                @click="toggleModelDropdown"
              >
                <span>{{ selectedModelLabel }}</span>
                <span class="qclaw-select-arrow">﹀</span>
              </button>

              <div v-if="modelDropdownOpen" class="qclaw-form-select-menu">
                <button
                  v-for="option in modelOptions"
                  :key="option"
                  type="button"
                  class="qclaw-form-select-option"
                  :class="{ 'is-active': option === modelId }"
                  @click="selectModelOption(option)"
                >
                  <span>{{ option }}</span>
                  <span v-if="option === modelId" class="qclaw-form-select-check">✓</span>
                </button>
              </div>
            </div>
          </label>

          <label v-else-if="showCustomFields" class="qclaw-form-field">
            <span class="qclaw-form-label">Model ID：</span>
            <input v-model="modelId" class="qclaw-form-input" type="text" />
          </label>

          <div
            v-if="modelSettingMessage"
            :class="['qclaw-form-message', `is-${modelSettingMessageLevel}`]"
          >
            {{ modelSettingMessage }}
          </div>
        </div>

        <footer class="qclaw-model-modal-footer">
          <button class="qclaw-modal-confirm" :disabled="isSavingModelSetting" @click="confirmModelSettings">
            {{ isSavingModelSetting ? '保存中...' : '确认' }}
          </button>
          <button class="qclaw-modal-cancel" :disabled="isSavingModelSetting" @click="closeModelSettings">
            取消
          </button>
        </footer>
      </section>
    </div>

    <RemoteControlModal
      :show="showRemoteModal"
      :state="remoteModalState"
      :qr-image-url="remoteQrImageUrl"
      :countdown-seconds="remoteCountdownSeconds"
      :remote-user-info="remoteUserInfo"
      :error-message="remoteErrorMessage"
      @close="closeRemoteControlModal"
      @confirm="confirmRemoteConnected"
      @disconnect="disconnectRemoteControl"
      @retry="restartRemoteConnect"
    />

    <div v-if="activeToolCardResult" class="qclaw-modal-mask" @click.self="closeToolCardResult">
      <section class="qclaw-tool-result-modal">
        <header class="qclaw-tool-result-header">
          <div class="qclaw-tool-result-heading">
            <span
              class="qclaw-tool-card-icon"
              v-html="getToolCardIcon(activeToolCardResult.name)"
            ></span>
            <div>
              <h2>{{ formatToolCardName(activeToolCardResult.name) }}</h2>
              <p v-if="activeToolCardResult.detail">{{ activeToolCardResult.detail }}</p>
            </div>
          </div>

          <button class="qclaw-modal-close" @click="closeToolCardResult">×</button>
        </header>

        <pre class="qclaw-tool-result-body">{{ activeToolCardResult.text }}</pre>

        <footer class="qclaw-tool-result-footer">
          <div
            v-if="toolCardCopyMessage"
            :class="['qclaw-form-message', `is-${toolCardCopyMessageLevel}`]"
          >
            {{ toolCardCopyMessage }}
          </div>

          <div class="qclaw-tool-result-actions">
            <button class="qclaw-modal-cancel" @click="closeToolCardResult">关闭</button>
            <button class="qclaw-modal-confirm" @click="copyToolCardResult">复制内容</button>
          </div>
        </footer>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  CHAT_MODEL_PROVIDER_OPTIONS,
  MODEL_AUTH_MODE_API_KEY,
  MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH,
} from '../../assets/chat-model-config.js'
import { refreshChatSessionPanel, toggleChatSidebar } from '../../assets/chat-session-panel.js'
import { autoFillMissingSessionLabels, loadChatSessions } from '../../assets/chat-session-list.js'
import { extractToolCardsFromMessage } from '../../assets/chat-history-state.js'
import { createPendingLocalSession } from '../../assets/chat-session-flow.js'
import { createLocalSessionKey, isProtectedSessionKey } from '../../assets/chat-session-utils.js'
import { useAuth } from '../../assets/auth-report-runtime.js'
import {
  o as openclawApiService,
  s as setStorageItem,
  aB as getStorageItem,
} from '../../assets/platform.js'
import {
  GATEWAY_STATUS,
  OpenClawGatewayClient,
  type GatewayStatus,
} from '../lib/openclaw-gateway-client'
import {
  useChatMessageUtils,
} from './chat/message-utils'
import { useChatModelSettings } from './chat/model-settings'
import { useRemoteControl } from './chat/use-remote-control'
import { useWxLoginInfo } from './chat/use-wx-login-info'
import ChatComposer from './chat/components/ChatComposer.vue'
import InviteCodeModal from './chat/components/InviteCodeModal.vue'
import ChatMessageList from './chat/components/ChatMessageList.vue'
import ChatSidebar from './chat/components/ChatSidebar.vue'
import ChatTopbar from './chat/components/ChatTopbar.vue'
import RemoteControlModal from './chat/components/RemoteControlModal.vue'
import SystemSettingsModal from './chat/components/SystemSettingsModal.vue'
import type {
  ChatMessage,
  ChatSessionItem,
  LoginUserInfo,
  ToolCard,
} from './chat/types'

const SIDEBAR_STORAGE_KEY = 'chat_sidebar_visible'
const CONNECTED_STATUS: GatewayStatus = GATEWAY_STATUS.CONNECTED
const OPENCLAW_API_BASE_URL = 'https://jprx.m.qq.com/'
const OPENCLAW_WEB_VERSION = '1.4.0'
const OPENCLAW_WEB_ENV = 'release'
const OPENCLAW_DEFAULT_LOGIN_KEY = 'm83qdao0AmE5'
const PRIVACY_POLICY_URL =
  'https://privacy.qq.com/document/preview/4a7ba3f82ff042c1aafbec6e7341d713'
const SERVICE_AGREEMENT_URL = 'https://rule.tencent.com/rule/202603060002'
const OFFICIAL_SITE_URL = 'https://qclaw.qq.com'

const messageListRef = ref<InstanceType<typeof ChatMessageList> | null>(null)
const messageInputRef = ref<InstanceType<typeof ChatComposer> | null>(null)
const sidebarVisible = ref(localStorage.getItem(SIDEBAR_STORAGE_KEY) !== 'false')
const isMacOS = /mac/i.test(navigator.platform || navigator.userAgent)
const currentSessionKey = ref('')
const draftText = ref('')
const sessions = ref<ChatSessionItem[]>([])
const messages = ref<ChatMessage[]>([])
const isSessionsLoading = ref(false)
const isHistoryLoading = ref(false)
const isSending = ref(false)
const gatewayStatus = ref<GatewayStatus>(GATEWAY_STATUS.DISCONNECTED)
const gatewayClient = ref<OpenClawGatewayClient | null>(null)
const activeAssistantMessage = ref<ChatMessage | null>(null)
const activeRunId = ref<string | null>(null)
const isCreatingChat = ref(false)
const isConnectingGateway = ref(false)
const activeToolStatusMessages = new Map<string, true>()
const sessionLabelCache = new Map<string, string>()
const sessionLabelPendingKeys = new Set<string>()
const sessionAgentNameCache = new Map<string, string>()
let gatewayReconnectTimer: number | null = null
const auth = useAuth()
const inviteModalVisible = ref(false)
const inviteUserId = ref<string | number>('')
const isInviteVerified = ref(false)
const showSystemSettings = ref(false)
const systemSettingsInitialTab = ref<'general' | 'usage' | 'skills' | 'remote' | 'about' | 'release-note'>('general')
const checkUpdatesOnSystemSettingsOpen = ref(false)
const systemSettingsVersion = ref('v0.1.1')
const wxLoginLoading = ref(true)
const wxLoginReady = ref(false)
const wxLoginRenderKey = ref(0)
const wxLoginModalVisible = ref(false)
const wxLoginState = ref('')
const wxLoginGuid = ref('')
const wxLoginErrorMessage = ref('')
const wxLoginDebugPhase = ref('idle')
const wxLoginDebugUrl = ref('')
const wxLoginIframeMounted = ref(false)
const wxLoginMessageHandler = ref<((event: MessageEvent) => void) | null>(null)
const wxLoginSubmitting = ref(false)
const wxLoginLastCode = ref('')
let pendingInviteAction: (() => void | Promise<void>) | null = null
let wxLoginSdkPromise: Promise<void> | null = null
const WX_LOGIN_CONTAINER_ID = 'wx_login'
const { getWxLoginInfo } = useWxLoginInfo()
const {
  providerDropdownRef,
  modelDropdownRef,
  showModelSettings,
  providerDropdownOpen,
  modelDropdownOpen,
  modelType,
  provider,
  authMode,
  baseUrl,
  token,
  oauthAccessToken,
  oauthRefreshToken,
  oauthIdToken,
  oauthAccountId,
  oauthEmail,
  oauthExpiresAt,
  tokenVisible,
  modelId,
  modelOptions,
  isSavingModelSetting,
  isImportingCodexAuth,
  modelSettingMessage,
  modelSettingMessageLevel,
  showCustomFields,
  providerLabel,
  isOpenAIProvider,
  isCodexProvider,
  showAuthModeFields,
  showBaseUrlField,
  showModelSelect,
  tokenLabel,
  tokenPlaceholder,
  authModeHint,
  selectedModelLabel,
  currentModelLabel,
  toggleProviderDropdown,
  toggleModelDropdown,
  selectProvider,
  selectModelOption,
  handleDocumentPointerDown,
  loadModelSettings,
  openModelSettings,
  closeModelSettings,
  importCodexAuthToken,
  confirmModelSettings,
} = useChatModelSettings()
const {
  activeToolCardResult,
  toolCardCopyMessage,
  toolCardCopyMessageLevel,
  buildDisplayMessage,
  updateAssistantMessageText,
  renderMessageHtml,
  isToolResultMessage,
  isStatusMessage,
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
  mergeStreamingText,
  extractMessageText,
  normalizeSessionLabel,
  toDisplayMessages,
} = useChatMessageUtils(currentSessionKey)
const canSendMessage = computed(() => !isSending.value && draftText.value.trim().length > 0)

const loginUser = computed<LoginUserInfo | null>(() => auth.loginUser.value as LoginUserInfo | null)
const isLoggedIn = computed(() => true)
const loginUserName = computed(() => '本地直连')
const loginUserAvatar = computed(() => '')
const {
  showRemoteModal,
  remoteModalState,
  remoteUserInfo,
  remoteQrImageUrl,
  remoteErrorMessage,
  remoteCountdownSeconds,
  isRemoteConnected,
  startRemoteConnect,
  closeRemoteControlModal,
  confirmRemoteConnected,
  disconnectRemoteControl,
  validateRemoteConnectionState,
  restartRemoteConnect,
  resetRemoteControlState,
  clearRemoteTimers,
} = useRemoteControl(loginUser)
const systemSettingsGatewayLabel = computed(() => {
  if (gatewayStatus.value === GATEWAY_STATUS.CONNECTED) {
    return '已连接'
  }
  if (gatewayStatus.value === GATEWAY_STATUS.CONNECTING) {
    return '连接中'
  }
  if (gatewayStatus.value === GATEWAY_STATUS.ERROR) {
    return '异常'
  }
  return '未连接'
})
const usageStats = computed(() => ({
  sessionCount: sessions.value.length,
  messageCount: messages.value.length,
  userMessageCount: messages.value.filter((message) => message.role === 'user').length,
  gatewayStatus: systemSettingsGatewayLabel.value,
}))
const remoteChannelCards = computed(() => [
  {
    id: 'wechat',
    name: '微信',
    icon: '微',
    description: '扫码关联微信，在手机上即可远程操控电脑中的 QClaw，随时发起指令、获取响应。',
    recommended: true,
    status: isRemoteConnected.value ? 'connected' : 'available',
    connectedLabel: remoteUserInfo.value?.nickname || '已配置',
  },
  {
    id: 'wecom',
    name: '企业微信',
    icon: '企',
    description: '在企业微信中与 QClaw 对话，适合团队办公协作场景。',
    recommended: false,
    status: 'disabled',
    connectedLabel: '',
  },
  {
    id: 'qqbot',
    name: 'QQ Bot',
    icon: 'Q',
    description: '通过 QQ Bot 作为远控入口，在常用聊天环境里直接调用 QClaw。',
    recommended: false,
    status: 'disabled',
    connectedLabel: '',
  },
  {
    id: 'feishu',
    name: '飞书',
    icon: '飞',
    description: '适合飞书组织内的机器人接入与远控协作场景。',
    recommended: false,
    status: 'disabled',
    connectedLabel: '',
  },
  {
    id: 'ddingtalk',
    name: '钉钉',
    icon: '钉',
    description: '为钉钉工作流预留的通道入口，当前版本仍在接入中。',
    recommended: false,
    status: 'disabled',
    connectedLabel: '',
  },
])

function requestCreateSkillByChat() {
  closeSystemSettings()
  startNewChat()
  draftText.value =
    '跟我一起用/skill-creator 创建一个技能，并且加入我的技能文档/列表 ~/.qclaw/skills 里。现在，你先问我技能应该做什么吧。'
  void nextTick(() => {
    syncMessageInputHeight()
    messageInputRef.value?.focusInput()
  })
}

async function openSystemSettings(
  tab: 'general' | 'usage' | 'skills' | 'remote' | 'about' | 'release-note' = 'general',
  options?: { checkUpdates?: boolean },
) {
  systemSettingsInitialTab.value = tab
  checkUpdatesOnSystemSettingsOpen.value = !!options?.checkUpdates
  showSystemSettings.value = true
  try {
    const version = await window.electronAPI?.app.getVersion()
    systemSettingsVersion.value = version ? `v${version}` : 'v0.1.1'
  } catch {
    systemSettingsVersion.value = 'v0.1.1'
  }
}

function closeSystemSettings() {
  showSystemSettings.value = false
  checkUpdatesOnSystemSettingsOpen.value = false
}

function openModelSettingsFromSystem() {
  closeSystemSettings()
  openModelSettings()
}

function openOfficialSite() {
  window.open(OFFICIAL_SITE_URL, '_blank', 'noopener')
}

async function openAboutAndCheckUpdates() {
  await openSystemSettings('about', { checkUpdates: true })
}

function openRemoteChannel(channelId: string) {
  if (channelId !== 'wechat') {
    return
  }

  if (isRemoteConnected.value) {
    remoteModalState.value = 'connected'
    showRemoteModal.value = true
    return
  }

  void startRemoteConnect()
}

function syncMessageInputHeight() {
  messageInputRef.value?.syncInputHeight()
}

watch(draftText, () => {
  void nextTick(() => {
    syncMessageInputHeight()
  })
})

function clearGatewayReconnectTimer() {
  if (gatewayReconnectTimer !== null) {
    window.clearTimeout(gatewayReconnectTimer)
    gatewayReconnectTimer = null
  }
}

function scheduleGatewayReconnect(delay = 1500) {
  if (gatewayReconnectTimer !== null || isConnectingGateway.value) {
    return
  }

  gatewayReconnectTimer = window.setTimeout(() => {
    gatewayReconnectTimer = null
    void connectGateway()
  }, delay)
}

function resetActiveStreamingState() {
  activeAssistantMessage.value = null
  activeRunId.value = null
  activeToolStatusMessages.clear()
}

function buildToolMessageKey(toolCard: ToolCard) {
  if (toolCard.toolCallId) {
    return toolCard.toolCallId
  }

  const argsSignature = toolCard.args ? JSON.stringify(toolCard.args) : ''
  return `${toolCard.kind}:${toolCard.name}:${toolCard.detail || ''}:${argsSignature}`
}

function ensureAssistantThinkingLog(message: ChatMessage) {
  if (!message.thinkingLog) {
    message.thinkingLog = []
  }
  return message.thinkingLog
}

function appendThinkingText(message: ChatMessage, text: string) {
  const normalized = text.trim()
  if (!normalized) {
    return
  }

  const thinkingLog = ensureAssistantThinkingLog(message)
  const lastEntry = thinkingLog[thinkingLog.length - 1]
  if (lastEntry?.type === 'text' && lastEntry.text === normalized) {
    return
  }

  thinkingLog.push({
    type: 'text',
    text: normalized,
  })
}

function ensureToolThinkingEntry(message: ChatMessage, toolCard: ToolCard) {
  const thinkingLog = ensureAssistantThinkingLog(message)
  const toolCallId = buildToolMessageKey(toolCard)
  if (!thinkingLog.some((entry) => entry.type === 'tool' && entry.toolCallId === toolCallId)) {
    thinkingLog.push({
      type: 'tool',
      toolCallId,
    })
  }
}

function createStreamingAssistantPlaceholder() {
  const nextMessage = buildDisplayMessage('assistant', '')
  nextMessage.isStreaming = true
  nextMessage.thinkingState = 'pending'
  nextMessage.thinkingLog = []
  nextMessage.toolCards = []
  messages.value.push(nextMessage)
  activeAssistantMessage.value = nextMessage
  return nextMessage
}

function promoteThinkingMessageToReceived() {
  if (!activeAssistantMessage.value) {
    return
  }

  activeAssistantMessage.value.thinkingState = 'running'
  appendThinkingText(activeAssistantMessage.value, '我已收到你的请求，请稍后。')
}

function discardThinkingStatusMessage() {
  const targetMessage = activeAssistantMessage.value
  if (!targetMessage) {
    return
  }

  const messageIndex = messages.value.findIndex((message) => message.id === targetMessage.id)
  if (messageIndex >= 0) {
    messages.value.splice(messageIndex, 1)
  }
  activeAssistantMessage.value = null
}

function upsertStreamingToolCards(nextToolCards: ToolCard[]) {
  for (const toolCard of nextToolCards) {
    if (activeAssistantMessage.value) {
      ensureToolThinkingEntry(activeAssistantMessage.value, toolCard)
      const toolCards = activeAssistantMessage.value.toolCards || []
      const existingIndex = toolCards.findIndex(
        (existingToolCard) =>
          buildToolMessageKey(existingToolCard) === buildToolMessageKey(toolCard),
      )

      if (existingIndex >= 0) {
        toolCards[existingIndex] = {
          ...toolCards[existingIndex],
          ...toolCard,
        }
      } else {
        toolCards.push({ ...toolCard })
      }

      activeAssistantMessage.value.toolCards = toolCards
    }

    if (toolCard.kind === 'call') {
      const key = buildToolMessageKey(toolCard)
      const existingMessage = activeToolStatusMessages.get(key)
      if (existingMessage) {
        continue
      }

      activeToolStatusMessages.set(key, true)
      continue
    }

    activeToolStatusMessages.set(
      buildToolMessageKey(toolCard),
      true,
    )
  }
}

function upsertToolStreamCard(event: {
  toolCallId?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolOutput?: string
  toolStreamPhase?: string
}) {
  if (!activeAssistantMessage.value || !event.toolCallId || !event.toolName) {
    return
  }

  const detail = extractToolCardsFromMessage(
    {
      content: [
        {
          type: 'tool_use',
          name: event.toolName,
          arguments: event.toolArgs || {},
          toolCallId: event.toolCallId,
        },
      ],
    },
    extractMessageText,
    isToolResultMessage,
  )[0]?.detail

  const nextToolCard: ToolCard = {
    kind: event.toolOutput ? 'result' : 'call',
    name: event.toolName,
    args: event.toolArgs,
    detail,
    text: event.toolOutput,
    completed: event.toolStreamPhase === 'result',
    aborted: event.toolStreamPhase === 'aborted',
    toolCallId: event.toolCallId,
  }

  upsertStreamingToolCards([nextToolCard])
}

async function loadChatHistory() {
  const client = gatewayClient.value
  if (!client || gatewayStatus.value !== CONNECTED_STATUS || !currentSessionKey.value) {
    return
  }

  isHistoryLoading.value = true

  try {
    const history = await client.getChatHistory({
      sessionKey: currentSessionKey.value,
      limit: 200,
    })

    messages.value = toDisplayMessages(history?.messages ?? [])
    resetActiveStreamingState()
    scrollMessagesToBottom()
  } catch (error) {
    console.error('[Chat] 加载聊天历史失败:', error)
  } finally {
    isHistoryLoading.value = false
    isCreatingChat.value = false
  }
}

async function refreshSessions() {
  await refreshChatSessionPanel({
    clientRef: gatewayClient,
    connectionStateRef: gatewayStatus,
    connectedState: CONNECTED_STATUS,
    isSessionsLoadingRef: isSessionsLoading,
    sessionsRef: sessions,
    sessionLabelCache,
    loadChatSessions,
    populateLabels: async () => {
      if (!gatewayClient.value) {
        return
      }

      await autoFillMissingSessionLabels({
        client: gatewayClient.value,
        sessions: sessions.value,
        sessionLabelCache,
        sessionAgentNameCache,
        pendingSessionKeys: sessionLabelPendingKeys,
        extractMessageText,
        isAgentSessionKey: () => false,
        buildAgentSessionLabel: (label: string) => label,
        normalizeSessionLabel: (label: string) => normalizeSessionLabel(label),
      })
    },
  })
}

function handleGatewayMessage(event: {
  runId?: string | null
  sessionKey?: string
  state: string
  text: string
  message?: any
  error?: boolean
  aborted?: boolean
  delta?: string
  toolCallId?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolOutput?: string
  toolStreamPhase?: string
  role?: string
}) {
  if (event.sessionKey && event.sessionKey !== currentSessionKey.value) {
    return
  }

  if (event.error) {
    discardThinkingStatusMessage()
    messages.value.push(buildDisplayMessage('assistant', `❌ ${event.text || '发送失败'}`))
    isSending.value = false
    resetActiveStreamingState()
    scrollMessagesToBottom()
    return
  }

  if (event.aborted) {
    if (activeAssistantMessage.value) {
      activeAssistantMessage.value.isStreaming = false
      activeAssistantMessage.value.thinkingState = 'completed'
    }
    isSending.value = false
    resetActiveStreamingState()
    return
  }

  if (activeRunId.value && activeRunId.value !== event.runId) {
    activeAssistantMessage.value = null
    activeRunId.value = null
    activeToolStatusMessages.clear()
  }

  if (!activeRunId.value && event.runId) {
    activeRunId.value = event.runId ?? null
  }

  const nextToolCards = event.message
    ? extractToolCardsFromMessage(event.message, extractMessageText, isToolResultMessage)
    : []
  const nextText = event.text || event.delta || ''

  if (activeAssistantMessage.value) {
    if (nextText) {
      activeAssistantMessage.value.thinkingState = 'running'
      updateAssistantMessageText(
        activeAssistantMessage.value,
        mergeStreamingText(activeAssistantMessage.value.text, nextText),
      )
    }
  } else if (nextText || nextToolCards.length > 0) {
    const nextMessage = createStreamingAssistantPlaceholder()
    nextMessage.thinkingState = 'running'
    if (nextText) {
      updateAssistantMessageText(nextMessage, nextText)
    }
  }

  if (event.state === 'tool_stream') {
    promoteThinkingMessageToReceived()
    upsertToolStreamCard(event)
    scrollMessagesToBottom()
    return
  }

  if (nextToolCards.length > 0) {
    promoteThinkingMessageToReceived()
    upsertStreamingToolCards(nextToolCards)
  }

  if (nextText) {
    promoteThinkingMessageToReceived()
  }

  scrollMessagesToBottom()

  if (event.state === 'final') {
    if (activeAssistantMessage.value) {
      activeAssistantMessage.value.isStreaming = false
      activeAssistantMessage.value.thinkingState = 'completed'
    }
    if (!activeAssistantMessage.value && (nextText || nextToolCards.length > 0)) {
      const finalMessage = buildDisplayMessage('assistant', nextText)
      if (nextText) {
        messages.value.push(finalMessage)
      }
    }
    isSending.value = false
    resetActiveStreamingState()
    void (async () => {
      await loadChatHistory()
      await refreshSessions()
    })()
  }
}

async function connectGateway() {
  if (isConnectingGateway.value) {
    return
  }

  isConnectingGateway.value = true
  const electronAPI = window.electronAPI
  clearGatewayReconnectTimer()

  try {
    const gatewayConfig = (await electronAPI?.config.getField('gateway')) as
      | { port?: number; auth?: { token?: string } }
      | undefined

    const gatewayPort = gatewayConfig?.port ?? 28789
    const gatewayToken = gatewayConfig?.auth?.token ?? 'dev-test-token'
    const gatewayUrl = `ws://127.0.0.1:${gatewayPort}`

    const isGatewayReady = await OpenClawGatewayClient.checkGatewayStatus(gatewayUrl)
    if (!isGatewayReady) {
      gatewayStatus.value = GATEWAY_STATUS.DISCONNECTED
      if (!currentSessionKey.value) {
        startNewChat()
      }
      scheduleGatewayReconnect()
      return
    }

    gatewayClient.value?.disconnect()
    gatewayClient.value = new OpenClawGatewayClient({
      url: gatewayUrl,
      token: gatewayToken,
      mode: 'ui',
      onStatusChange: (status) => {
        gatewayStatus.value = status
        if (status === GATEWAY_STATUS.DISCONNECTED || status === GATEWAY_STATUS.ERROR) {
          scheduleGatewayReconnect()
        }
      },
      onMessage: handleGatewayMessage,
      onError: (error) => {
        console.error('[Chat] Gateway WebSocket 错误:', error)
      },
    })

    await gatewayClient.value.connect()
    await refreshSessions()

    if (sessions.value.length > 0) {
      currentSessionKey.value = sessions.value[0]?.key ?? currentSessionKey.value
      await loadChatHistory()
    } else {
      startNewChat()
    }
  } catch (error) {
    console.error('[Chat] Gateway 连接失败:', error)
    gatewayStatus.value = GATEWAY_STATUS.ERROR
    if (!currentSessionKey.value) {
      startNewChat()
    }
    scheduleGatewayReconnect()
  } finally {
    isConnectingGateway.value = false
  }
}

function scrollMessagesToBottom() {
  void nextTick(() => {
    messageListRef.value?.scrollToBottom()
  })
}

function openExternal(url: string) {
  window.open(url, '_blank')
}

async function syncWechatAccessConfig(channelToken?: string) {
  let apiKey = ''

  try {
    const apiKeyResult = await openclawApiService.createApiKey()
    apiKey =
      apiKeyResult?.data?.key ??
      apiKeyResult?.data?.resp?.data?.key ??
      apiKeyResult?.data?.data?.key ??
      ''
  } catch (error) {
    console.error('[Chat] 获取 API Key 异常:', error)
  }

  const payload: Record<string, any> = {}

  if (channelToken) {
    payload.channels = {
      'wechat-access': {
        token: channelToken,
      },
    }
  }

  if (apiKey) {
    payload.models = {
      providers: {
        qclaw: {
          apiKey,
        },
      },
    }
  }

  if (!Object.keys(payload).length) {
    return
  }

  try {
    await window.electronAPI?.config.updateField(payload)
  } catch (error) {
    console.error('[Chat] 登录后更新配置失败:', error)
  }
}

function closeInviteModal() {
  inviteModalVisible.value = false
  pendingInviteAction = null
}

async function ensureInviteVerified(action: () => void | Promise<void>) {
  isInviteVerified.value = true
  await action()
  return true
}

async function handleInviteVerified() {
  inviteModalVisible.value = false
  isInviteVerified.value = true
  await syncWechatAccessConfig(getStorageItem('openclaw_channel_token') || undefined)

  if (pendingInviteAction) {
    const action = pendingInviteAction
    pendingInviteAction = null
    await action()
  }
}

async function handleLoginSuccess(user: LoginUserInfo) {
  wxLoginModalVisible.value = false
  await auth.onLoginSuccess(user)
  detachWxLoginMessageListener()

  const pendingAction = auth.consumePendingAction()
  if (pendingAction) {
    await ensureInviteVerified(pendingAction)
  }
}

function attachWxLoginMessageListener() {
  detachWxLoginMessageListener()

  wxLoginMessageHandler.value = async (event: MessageEvent) => {
    const message = event.data
    const code =
      typeof message === 'string'
        ? message
        : typeof message?.data === 'string' && message?.type === 'sendCode'
          ? message.data
          : typeof message?.code === 'string'
            ? message.code
            : ''

    if (!code) {
      return
    }

    if (wxLoginSubmitting.value || wxLoginLastCode.value === code) {
      return
    }

    wxLoginLastCode.value = code
    wxLoginDebugPhase.value = 'received-code'
    await submitWxLoginCode(String(code))
  }

  if (wxLoginMessageHandler.value) {
    window.addEventListener('message', wxLoginMessageHandler.value)
  }
}

function detachWxLoginMessageListener() {
  if (!wxLoginMessageHandler.value) {
    return
  }

  window.removeEventListener('message', wxLoginMessageHandler.value)
  wxLoginMessageHandler.value = null
}

async function ensureWxLoginSdk() {
  if (typeof (window as any).WxLogin === 'function') {
    return
  }

  if (!wxLoginSdkPromise) {
    wxLoginSdkPromise = new Promise<void>((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>('script[data-wx-login-sdk="true"]')
      if (existingScript) {
        existingScript.addEventListener('load', () => resolve(), { once: true })
        existingScript.addEventListener('error', () => reject(new Error('微信登录 SDK 加载失败')), {
          once: true,
        })
        return
      }

      const script = document.createElement('script')
      script.src = 'https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js'
      script.async = true
      script.defer = true
      script.setAttribute('data-wx-login-sdk', 'true')
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('微信登录 SDK 加载失败'))
      document.head.appendChild(script)
    }).catch((error) => {
      wxLoginSdkPromise = null
      throw error
    })
  }

  await wxLoginSdkPromise

  if (typeof (window as any).WxLogin !== 'function') {
    wxLoginSdkPromise = null
    throw new Error('微信登录 SDK 未正确初始化')
  }
}

function waitForAnimationFrame() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}

async function postOpenclawApiViaMain(path: string, payload: Record<string, unknown>) {
  const electronAPI = window.electronAPI
  if (!electronAPI?.app.httpRequest) {
    throw new Error('当前客户端缺少登录所需的网络能力，请升级应用后重试')
  }

  const userInfo = getStorageItem('userInfo') as LoginUserInfo | null
  const jwtToken = getStorageItem('jwt_token')
  const requestGuid =
    typeof payload.guid === 'string' || typeof payload.guid === 'number'
      ? String(payload.guid)
      : String(userInfo?.guid || '1')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Version': '1',
    'X-Token': String(userInfo?.loginKey || OPENCLAW_DEFAULT_LOGIN_KEY),
    'X-Guid': requestGuid,
    'X-Account': String(userInfo?.userId || '1'),
    'X-Session': '',
  }

  if (jwtToken) {
    headers['X-OpenClaw-Token'] = String(jwtToken)
  }

  const response = await electronAPI.app.httpRequest({
    url: `${OPENCLAW_API_BASE_URL}${path}`,
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...payload,
      web_version: OPENCLAW_WEB_VERSION,
      web_env: OPENCLAW_WEB_ENV,
    }),
  })

  const newToken = response.headers['x-new-token'] || response.headers['X-New-Token']
  if (newToken) {
    setStorageItem('jwt_token', newToken)
  }

  let data: any = null
  try {
    data = response.body ? JSON.parse(response.body) : null
  } catch {
    // keep null when response body is not json
  }

  if (!response.ok) {
    return {
      success: false,
      code: response.status,
      message: data?.message || response.statusText || `HTTP ${response.status}`,
      data,
    }
  }

  const ret = data?.ret
  const commonCode =
    data?.data?.common?.code ?? data?.resp?.common?.code ?? data?.common?.code
  const businessCode = data?.data?.resp?.common?.code
  if (ret === 0 && businessCode != null && businessCode !== 0) {
    return {
      success: false,
      code: businessCode,
      message: data?.data?.resp?.common?.message || '业务请求失败',
      data: data?.data ?? data?.resp ?? data,
    }
  }

  if (ret === 0 || commonCode === 0) {
    return {
      success: true,
      code: 0,
      data: data?.data ?? data?.resp ?? data,
    }
  }

  return {
    success: false,
    code: ret ?? commonCode,
    message:
      data?.data?.common?.message ?? data?.resp?.common?.message ?? data?.common?.message ?? '业务请求失败',
    data: data?.data ?? data?.resp ?? data,
  }
}

function buildWxLoginIframeUrl(state: string | number) {
  const loginInfo = getWxLoginInfo()
  const url = new URL('https://open.weixin.qq.com/connect/qrconnect')
  url.searchParams.set('appid', loginInfo.appid)
  url.searchParams.set('scope', 'snsapi_login')
  url.searchParams.set('redirect_uri', loginInfo.redirect_uri)
  url.searchParams.set('state', String(state))
  url.searchParams.set('login_type', 'jssdk')
  url.searchParams.set('self_redirect', 'true')
  url.searchParams.set('style', 'white')
  url.searchParams.set('href', `data:text/css;base64,${loginInfo.wxLoginStyleBase64}`)
  return url.toString()
}

async function resolveWxLoginState(guid: string) {
  const fallbackState = '233'
  wxLoginDebugPhase.value = 'fetching-state'

  try {
    const stateResult = (await Promise.race([
      postOpenclawApiViaMain('data/4050/forward', { guid }),
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error('获取微信登录 state 超时')), 2500)
      }),
    ])) as Awaited<ReturnType<typeof openclawApiService.getWxLoginState>>

    return String(
      stateResult?.data?.state ??
        stateResult?.data?.resp?.data?.state ??
        stateResult?.data?.resp?.state ??
        fallbackState,
    )
  } catch (error) {
    console.warn('[Chat] 获取微信登录 state 失败，使用默认值 233:', error)
    wxLoginDebugPhase.value = 'state-fallback'
    return fallbackState
  }
}

async function renderWxLogin(state: string | number) {
  wxLoginDebugPhase.value = 'rendering-sdk'
  const container = document.getElementById(WX_LOGIN_CONTAINER_ID)
  if (!container) {
    throw new Error('微信登录容器不存在')
  }

  await ensureWxLoginSdk()

  container.innerHTML = ''
  wxLoginIframeMounted.value = false
  wxLoginDebugUrl.value = buildWxLoginIframeUrl(state)

  const fallbackTimer = window.setTimeout(() => {
    wxLoginLoading.value = false
    wxLoginDebugPhase.value = 'sdk-timeout'
    wxLoginIframeMounted.value = !!container.querySelector('iframe')
  }, 2500)

  new (window as any).WxLogin({
    self_redirect: true,
    id: WX_LOGIN_CONTAINER_ID,
    appid: getWxLoginInfo().appid,
    scope: 'snsapi_login',
    redirect_uri: encodeURIComponent(getWxLoginInfo().redirect_uri),
    state: String(state),
    style: 'white',
    href: `data:text/css;base64,${getWxLoginInfo().wxLoginStyleBase64}`,
    onReady: (ready: boolean) => {
      if (!ready) {
        return
      }

      window.clearTimeout(fallbackTimer)
      wxLoginDebugPhase.value = 'sdk-ready'
      wxLoginLoading.value = false
      wxLoginIframeMounted.value = !!container.querySelector('iframe')
    },
    onQRcodeReady: () => {
      wxLoginDebugPhase.value = 'qrcode-ready'
      wxLoginIframeMounted.value = !!container.querySelector('iframe')
    },
  })

  window.setTimeout(() => {
    wxLoginIframeMounted.value = !!container.querySelector('iframe')
  }, 0)
}

async function loadWxLoginQrCode() {
  wxLoginLoading.value = true
  wxLoginReady.value = false
  wxLoginErrorMessage.value = ''
  wxLoginDebugPhase.value = 'starting'
  wxLoginDebugUrl.value = ''
  wxLoginIframeMounted.value = false
  wxLoginSubmitting.value = false
  wxLoginLastCode.value = ''
  wxLoginState.value = ''
  wxLoginGuid.value = ''

  try {
    const guid = await openclawApiService.getGuid()
    wxLoginGuid.value = String(guid)
    wxLoginDebugPhase.value = 'got-guid'
    wxLoginState.value = await resolveWxLoginState(wxLoginGuid.value)

    wxLoginRenderKey.value += 1
    await nextTick()
    wxLoginReady.value = true
    wxLoginDebugPhase.value = 'container-ready'
    await nextTick()
    await waitForAnimationFrame()
    await renderWxLogin(wxLoginState.value)
  } catch (error) {
    console.error('[Chat] 加载微信登录二维码失败:', error)
    wxLoginDebugPhase.value = 'load-failed'
    wxLoginLoading.value = false
    wxLoginReady.value = false
    wxLoginErrorMessage.value = '微信登录组件加载失败，请检查网络后重试'
  }
}

function isWxLoginStateExpiredMessage(message: string) {
  const normalized = message.trim()
  return (
    normalized.includes('state 无效') ||
    normalized.includes('state已过期') ||
    normalized.includes('state 已过期') ||
    normalized.includes('state invalid') ||
    normalized.includes('expired state')
  )
}

async function submitWxLoginCode(code: string) {
  wxLoginSubmitting.value = true
  wxLoginErrorMessage.value = ''
  setStorageItem('wx_login_code', code)

  try {
    const guid = wxLoginGuid.value || String(await openclawApiService.getGuid())
    wxLoginGuid.value = guid

    if (!wxLoginState.value) {
      wxLoginState.value = await resolveWxLoginState(guid)
    }

    const loginResult = await postOpenclawApiViaMain('data/4026/forward', {
      guid,
      code,
      state: wxLoginState.value,
    })

    if (!loginResult.success) {
      wxLoginDebugPhase.value = 'login-rejected'
      const message = loginResult.message || '微信登录失败，请重新扫码'
      if (isWxLoginStateExpiredMessage(message)) {
        wxLoginErrorMessage.value = '登录二维码已失效，正在刷新，请重新扫码'
        wxLoginDebugPhase.value = 'state-expired'
        window.setTimeout(() => {
          void loadWxLoginQrCode()
        }, 300)
        return
      }

      wxLoginErrorMessage.value = message
      return
    }

    const data = loginResult?.data?.resp?.data ?? loginResult?.data?.data ?? loginResult?.data ?? {}

    if (data.token) {
      setStorageItem('jwt_token', data.token)
    }

    if (data.openclaw_channel_token) {
      setStorageItem('openclaw_channel_token', data.openclaw_channel_token)
    }

    await syncWechatAccessConfig(data.openclaw_channel_token)

    const user: LoginUserInfo = {
      ...(data.user_info || {}),
      nickname: data?.user_info?.nickname || '',
      avatar: data?.user_info?.avatar_url || data?.user_info?.avatar || '',
      userId: data?.user_info?.user_id,
      guid,
    }

    setStorageItem('userInfo', user)
    await handleLoginSuccess(user)
  } catch (error) {
    console.error('[Chat] 微信登录请求异常:', error)
    wxLoginDebugPhase.value = 'login-error'
    wxLoginErrorMessage.value =
      error instanceof Error ? error.message : '微信登录请求异常，请重新扫码'
  } finally {
    wxLoginSubmitting.value = false
  }
}

function startNewChat() {
  createPendingLocalSession({
    createSessionKey: createLocalSessionKey,
    setPendingSessionFlag: (value: boolean) => {
      isCreatingChat.value = value
    },
    resetStreamingState: () => {
      resetActiveStreamingState()
      isSending.value = false
    },
    resetPendingState: () => {
      draftText.value = ''
    },
    currentSessionKeyRef: currentSessionKey,
    messagesRef: messages,
    messageInputRef: draftText,
    sessionsRef: sessions,
  })
}

async function selectSession(sessionKey: string) {
  if (sessionKey === currentSessionKey.value) {
    return
  }

  currentSessionKey.value = sessionKey
  messages.value = []
  draftText.value = ''
  resetActiveStreamingState()
  isSending.value = false
  await loadChatHistory()
}

async function deleteChatSession(sessionKey: string) {
  const client = gatewayClient.value
  if (!client || gatewayStatus.value !== CONNECTED_STATUS) {
    return
  }

  if (isProtectedSessionKey(sessionKey)) {
    window.alert('主会话不能删除，请新建或切换到其他会话。')
    return
  }

  if (isSending.value && sessionKey === currentSessionKey.value) {
    window.alert('当前会话正在生成回复，暂时不能删除。')
    return
  }

  const sessionIndex = sessions.value.findIndex((session) => session.key === sessionKey)
  const sessionLabel = sessions.value[sessionIndex]?.label || '新对话'
  const confirmed = window.confirm(`确认删除会话“${sessionLabel}”？`)
  if (!confirmed) {
    return
  }

  const fallbackSessionKey =
    sessions.value[sessionIndex + 1]?.key ?? sessions.value[sessionIndex - 1]?.key ?? ''
  const isDeletingCurrentSession = sessionKey === currentSessionKey.value

  try {
    await client.deleteSession(sessionKey)
    sessionLabelCache.delete(sessionKey)
    sessionLabelPendingKeys.delete(sessionKey)
    sessionAgentNameCache.delete(sessionKey)

    await refreshSessions()

    if (!isDeletingCurrentSession) {
      return
    }

    messages.value = []
    draftText.value = ''
    resetActiveStreamingState()
    isSending.value = false

    if (fallbackSessionKey && sessions.value.some((session) => session.key === fallbackSessionKey)) {
      currentSessionKey.value = fallbackSessionKey
      await loadChatHistory()
      return
    }

    currentSessionKey.value = ''
    startNewChat()
  } catch (error) {
    console.error('[Chat] 删除会话失败:', error)
    window.alert(`删除会话失败: ${error instanceof Error ? error.message : '未知错误'}`)
  }
}

function toggleSidebar() {
  toggleChatSidebar({
    sidebarVisibleRef: sidebarVisible,
    storageKey: SIDEBAR_STORAGE_KEY,
    refreshSessions: () => {
      void refreshSessions()
    },
  })
}

async function sendMessage() {
  const content = draftText.value.trim()
  if (!content || isSending.value) {
    return
  }

  if (!currentSessionKey.value) {
    startNewChat()
  }

  resetActiveStreamingState()
  messages.value.push(buildDisplayMessage('user', content))
  createStreamingAssistantPlaceholder()
  draftText.value = ''
  scrollMessagesToBottom()

  let isConnected = gatewayStatus.value === CONNECTED_STATUS
  const isFirstUserMessage =
    messages.value.filter((message) => message.role === 'user').length === 1

  if (isFirstUserMessage) {
    const nextLabel = normalizeSessionLabel(content)
    const currentSession = sessions.value.find((session) => session.key === currentSessionKey.value)
    if (currentSession) {
      currentSession.label = nextLabel
    }
    sessionLabelCache.set(currentSessionKey.value, nextLabel)
  }

  if (!gatewayClient.value || !isConnected) {
    await connectGateway()
    isConnected = gatewayStatus.value === CONNECTED_STATUS
  }

  const client = gatewayClient.value

  if (!client || !isConnected) {
    discardThinkingStatusMessage()
    messages.value.push(
      buildDisplayMessage('assistant', '未连接到 OpenClaw Gateway，请先启动本地 Gateway 服务。'),
    )
    scrollMessagesToBottom()
    return
  }

  isSending.value = true

  try {
    await client.sendChatMessage(content, {
      sessionKey: currentSessionKey.value,
    })
    promoteThinkingMessageToReceived()

    if (isFirstUserMessage) {
      try {
        await client.patchSession(currentSessionKey.value, {
          label: normalizeSessionLabel(content),
        })
      } catch (error) {
        console.warn('[Chat] 更新会话标题失败:', error)
      }
    }

    await refreshSessions()
  } catch (error) {
    console.error('[Chat] 发送消息失败:', error)
    discardThinkingStatusMessage()
    messages.value.push(
      buildDisplayMessage(
        'assistant',
        `❌ 发送失败: ${error instanceof Error ? error.message : '未知错误'}`,
      ),
    )
    isSending.value = false
    scrollMessagesToBottom()
  }
}

watch(
  () => auth.showWxLoginModal.value,
  (visible) => {
    wxLoginModalVisible.value = visible
  },
)

watch(
  () => wxLoginModalVisible.value,
  async (visible) => {
    if (visible) {
      attachWxLoginMessageListener()
      await nextTick()
      await loadWxLoginQrCode()
      return
    }

    detachWxLoginMessageListener()
  },
)

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  void loadModelSettings()
  void connectGateway()
  void validateRemoteConnectionState()
  void nextTick(() => {
    scrollMessagesToBottom()
    syncMessageInputHeight()
  })
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  clearGatewayReconnectTimer()
  clearRemoteTimers()
  detachWxLoginMessageListener()
  resetToolCardCopyMessage()
  gatewayClient.value?.disconnect()
})
</script>
