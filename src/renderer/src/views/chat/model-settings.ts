import { computed, ref, watch } from 'vue'
import {
  CHAT_MODEL_PROVIDER_KEYS,
  CHAT_MODEL_PROVIDER_LABELS,
  CHAT_MODEL_PROVIDER_OPTIONS,
  CODEX_PROVIDER_KEY,
  CUSTOM_MODEL_PROVIDER_KEY,
  MODEL_AUTH_MODE_API_KEY,
  MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH,
  OPENAI_PROVIDER_KEY,
  SYSTEM_CONFIG_PROVIDER_KEY,
  getChatModelDisplayLabel,
  getProviderAuthMode,
  getProviderCredential,
} from '../../../assets/chat-model-config.js'
import {
  loadChatModelState,
  refreshChatModelConfigCache,
} from '../../../assets/chat-model-state.js'
import { fetchProviderModels } from '../../../assets/chat-model-modal-runtime.js'
import { submitModelSetting } from '../../../assets/chat-model-modal-submit.js'

type MessageLevel = 'warning' | 'error' | 'success'
type ProviderDraft = {
  authMode: string
  baseUrl: string
  token: string
  oauthAccessToken: string
  oauthRefreshToken: string
  oauthIdToken: string
  oauthAccountId: string
  oauthEmail: string
  oauthExpiresAt: string
  modelId: string
}

export function useChatModelSettings() {
  const providerDropdownRef = ref<HTMLElement | null>(null)
  const modelDropdownRef = ref<HTMLElement | null>(null)
  const showModelSettings = ref(false)
  const providerDropdownOpen = ref(false)
  const modelDropdownOpen = ref(false)
  const modelType = ref<'default' | 'custom'>('custom')
  const provider = ref<string>(CUSTOM_MODEL_PROVIDER_KEY)
  const authMode = ref<string>(MODEL_AUTH_MODE_API_KEY)
  const baseUrl = ref('http://192.168.64.22:3001/v1')
  const token = ref('sk-qclaw-rebuild-token')
  const oauthAccessToken = ref('')
  const oauthRefreshToken = ref('')
  const oauthIdToken = ref('')
  const oauthAccountId = ref('')
  const oauthEmail = ref('')
  const oauthExpiresAt = ref('')
  const tokenVisible = ref(false)
  const modelId = ref('qwen3.5-122b-vl')
  const modelOptions = ref<string[]>([])
  const providers = ref<Record<string, any> | undefined>(undefined)
  const primaryModel = ref<string | undefined>(undefined)
  const instanceMode = ref<string | null>(null)
  const isSavingModelSetting = ref(false)
  const isImportingCodexAuth = ref(false)
  const modelSettingMessage = ref('')
  const modelSettingMessageLevel = ref<MessageLevel>('warning')
  const providerKeySet = new Set(CHAT_MODEL_PROVIDER_KEYS)
  const providerDrafts = ref<Record<string, ProviderDraft>>({})

  const showCustomFields = computed(
    () => modelType.value === 'custom' && provider.value !== SYSTEM_CONFIG_PROVIDER_KEY,
  )
  const providerLabel = computed(
    () => CHAT_MODEL_PROVIDER_LABELS[provider.value] || provider.value || '自定义',
  )
  const isOpenAIProvider = computed(() => provider.value === OPENAI_PROVIDER_KEY)
  const isCodexProvider = computed(() => provider.value === CODEX_PROVIDER_KEY)
  const showAuthModeFields = computed(() => showCustomFields.value && isOpenAIProvider.value)
  const isOpenAICodexOAuth = computed(() => isCodexProvider.value)
  const showBaseUrlField = computed(
    () =>
      showCustomFields.value &&
      !isOpenAIProvider.value &&
      !isCodexProvider.value &&
      !isOpenAICodexOAuth.value,
  )
  const showModelSelect = computed(
    () =>
      showCustomFields.value &&
      provider.value !== CUSTOM_MODEL_PROVIDER_KEY &&
      modelOptions.value.length > 0,
  )
  const tokenLabel = computed(() => (isCodexProvider.value ? 'Codex Token：' : 'API Key：'))
  const tokenPlaceholder = computed(() =>
    !(isOpenAIProvider.value || isCodexProvider.value)
      ? ''
      : isCodexProvider.value
        ? '可手动粘贴 Codex access token，或点击下方按钮导入'
        : '请输入 OpenAI API Key',
  )
  const authModeHint = computed(() =>
    isOpenAIProvider.value
      ? '请输入 platform.openai.com 生成的 API Key。Base URL 固定为 OpenAI 默认接口。'
      : isCodexProvider.value
        ? 'Codex Token 与 OpenAI API Key 不同。Base URL 固定为 chatgpt.com/backend-api，并按 Codex 原生 responses 协议发送。'
        : 'API Key 将按 OpenAI 兼容接口的 Bearer Token 方式发送。',
  )
  const selectedModelLabel = computed(() => modelId.value || '请选择模型')
  const effectiveBaseUrl = computed(() => {
    if (isOpenAIProvider.value || isCodexProvider.value) {
      const providerOption = CHAT_MODEL_PROVIDER_OPTIONS.find((item) => item.key === provider.value)
      return providerOption?.baseUrl || (isCodexProvider.value ? 'https://chatgpt.com/backend-api' : 'https://api.openai.com/v1')
    }

    return baseUrl.value.trim()
  })
  const currentModelLabel = computed(() =>
    getChatModelDisplayLabel(
      {
        modelType: modelType.value,
        provider: provider.value,
        modelName: modelId.value,
      },
      CHAT_MODEL_PROVIDER_LABELS,
    ),
  )

  function getProviderOptionBaseUrl(providerKey: string) {
    return CHAT_MODEL_PROVIDER_OPTIONS.find((item) => item.key === providerKey)?.baseUrl || ''
  }

  function createProviderDraft(providerKey: string, providerConfig?: Record<string, any>): ProviderDraft {
    const authModeValue = getProviderAuthMode(providerKey, providerConfig)
    const optionBaseUrl = getProviderOptionBaseUrl(providerKey)
    return {
      authMode:
        providerKey === CODEX_PROVIDER_KEY
          ? MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH
          : authModeValue || MODEL_AUTH_MODE_API_KEY,
      baseUrl:
        providerKey === OPENAI_PROVIDER_KEY || providerKey === CODEX_PROVIDER_KEY
          ? optionBaseUrl
          : providerConfig?.baseUrl || optionBaseUrl,
      token: getProviderCredential(providerKey, providerConfig) || '',
      oauthAccessToken: providerConfig?.oauthAccessToken || '',
      oauthRefreshToken: providerConfig?.oauthRefreshToken || '',
      oauthIdToken: providerConfig?.oauthIdToken || '',
      oauthAccountId: providerConfig?.oauthAccountId || '',
      oauthEmail: providerConfig?.oauthEmail || '',
      oauthExpiresAt: providerConfig?.oauthExpiresAt || '',
      modelId: providerConfig?.models?.[0]?.id || '',
    }
  }

  function setProviderDraft(providerKey: string, draft: ProviderDraft) {
    providerDrafts.value = {
      ...providerDrafts.value,
      [providerKey]: { ...draft },
    }
  }

  function captureCurrentProviderDraft() {
    if (!provider.value || provider.value === SYSTEM_CONFIG_PROVIDER_KEY) {
      return
    }

    setProviderDraft(provider.value, {
      authMode: authMode.value,
      baseUrl: baseUrl.value,
      token: token.value,
      oauthAccessToken: oauthAccessToken.value,
      oauthRefreshToken: oauthRefreshToken.value,
      oauthIdToken: oauthIdToken.value,
      oauthAccountId: oauthAccountId.value,
      oauthEmail: oauthEmail.value,
      oauthExpiresAt: oauthExpiresAt.value,
      modelId: modelId.value,
    })
  }

  function applyProviderDraft(nextProvider: string) {
    if (nextProvider === SYSTEM_CONFIG_PROVIDER_KEY) {
      authMode.value = MODEL_AUTH_MODE_API_KEY
      baseUrl.value = ''
      token.value = ''
      oauthAccessToken.value = ''
      oauthRefreshToken.value = ''
      oauthIdToken.value = ''
      oauthAccountId.value = ''
      oauthEmail.value = ''
      oauthExpiresAt.value = ''
      modelId.value = ''
      modelOptions.value = []
      return
    }

    const providerConfig = providers.value?.[nextProvider]
    const draft =
      providerDrafts.value[nextProvider] || createProviderDraft(nextProvider, providerConfig)

    setProviderDraft(nextProvider, draft)
    authMode.value = draft.authMode
    baseUrl.value = draft.baseUrl
    token.value = draft.token
    oauthAccessToken.value = draft.oauthAccessToken
    oauthRefreshToken.value = draft.oauthRefreshToken
    oauthIdToken.value = draft.oauthIdToken
    oauthAccountId.value = draft.oauthAccountId
    oauthEmail.value = draft.oauthEmail
    oauthExpiresAt.value = draft.oauthExpiresAt
    modelId.value = draft.modelId
    modelOptions.value = []
  }

  function initializeProviderDrafts(
    availableProviders: Record<string, any> | undefined,
    currentProvider: string,
    currentModelConfig: Record<string, any>,
  ) {
    const nextDrafts: Record<string, ProviderDraft> = {}

    for (const providerKey of CHAT_MODEL_PROVIDER_KEYS) {
      if (providerKey === SYSTEM_CONFIG_PROVIDER_KEY) {
        continue
      }

      nextDrafts[providerKey] = createProviderDraft(providerKey, availableProviders?.[providerKey])
    }

    if (currentProvider && currentProvider !== SYSTEM_CONFIG_PROVIDER_KEY) {
      const currentDraft = nextDrafts[currentProvider] || createProviderDraft(currentProvider)
      nextDrafts[currentProvider] = {
        ...currentDraft,
        authMode: currentModelConfig.authMode || currentDraft.authMode,
        baseUrl:
          currentProvider === OPENAI_PROVIDER_KEY || currentProvider === CODEX_PROVIDER_KEY
            ? getProviderOptionBaseUrl(currentProvider)
            : currentModelConfig.baseUrl || currentDraft.baseUrl,
        token:
          currentModelConfig.apiKey ||
          currentModelConfig.oauthAccessToken ||
          currentDraft.token,
        oauthAccessToken: currentModelConfig.oauthAccessToken || currentDraft.oauthAccessToken,
        oauthRefreshToken: currentModelConfig.oauthRefreshToken || currentDraft.oauthRefreshToken,
        oauthIdToken: currentModelConfig.oauthIdToken || currentDraft.oauthIdToken,
        oauthAccountId: currentModelConfig.oauthAccountId || currentDraft.oauthAccountId,
        oauthEmail: currentModelConfig.oauthEmail || currentDraft.oauthEmail,
        oauthExpiresAt: currentModelConfig.oauthExpiresAt || currentDraft.oauthExpiresAt,
        modelId:
          currentModelConfig.modelName ||
          currentModelConfig.customModelName ||
          currentDraft.modelId,
      }
    }

    providerDrafts.value = nextDrafts
  }

  function closeProviderDropdown() {
    providerDropdownOpen.value = false
  }

  function closeModelDropdown() {
    modelDropdownOpen.value = false
  }

  function toggleProviderDropdown() {
    providerDropdownOpen.value = !providerDropdownOpen.value
  }

  function toggleModelDropdown() {
    if (!showModelSelect.value) {
      return
    }
    modelDropdownOpen.value = !modelDropdownOpen.value
  }

  function selectProvider(nextProvider: string) {
    captureCurrentProviderDraft()
    provider.value = nextProvider
    closeProviderDropdown()
    closeModelDropdown()
    applyProviderDraft(nextProvider)
  }

  function selectModelOption(nextModelId: string) {
    modelId.value = nextModelId
    closeModelDropdown()
  }

  function handleDocumentPointerDown(event: PointerEvent) {
    if (!providerDropdownOpen.value && !modelDropdownOpen.value) {
      return
    }

    const target = event.target
    if (!(target instanceof Node)) {
      closeProviderDropdown()
      closeModelDropdown()
      return
    }

    if (!providerDropdownRef.value?.contains(target)) {
      closeProviderDropdown()
    }
    if (!modelDropdownRef.value?.contains(target)) {
      closeModelDropdown()
    }
  }

  watch(provider, (nextProvider) => {
    if (nextProvider === CODEX_PROVIDER_KEY) {
      authMode.value = MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH
      baseUrl.value = getProviderOptionBaseUrl(nextProvider)
    } else if (nextProvider === OPENAI_PROVIDER_KEY) {
      authMode.value = MODEL_AUTH_MODE_API_KEY
      baseUrl.value = getProviderOptionBaseUrl(nextProvider)
    } else if (nextProvider !== OPENAI_PROVIDER_KEY) {
      authMode.value = MODEL_AUTH_MODE_API_KEY
    }

    modelOptions.value = []
    closeModelDropdown()
  })

  watch(authMode, (nextAuthMode) => {
    if (nextAuthMode !== MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH || !isCodexProvider.value) {
      oauthAccessToken.value = ''
      oauthRefreshToken.value = ''
      oauthIdToken.value = ''
      oauthAccountId.value = ''
      oauthEmail.value = ''
      oauthExpiresAt.value = ''
    }
    modelOptions.value = []
    closeModelDropdown()
  })

  watch(
    [showModelSettings, provider, authMode, token],
    ([isVisible, nextProvider]) => {
      if (!isVisible || nextProvider === SYSTEM_CONFIG_PROVIDER_KEY) {
        return
      }

      void loadProviderModelOptions()
    },
    { flush: 'post' },
  )

  async function loadModelSettings() {
    const electronAPI = window.electronAPI
    if (!electronAPI) {
      return
    }

    const nextState = await loadChatModelState({
      electronAPI,
      cachedModelSetting: null,
      providerKeys: CHAT_MODEL_PROVIDER_KEYS,
    })

    providers.value = nextState.providers
    primaryModel.value = nextState.primaryModel
    instanceMode.value = nextState.instanceMode
    modelType.value = nextState.nextModelConfig.modelType || 'default'
    provider.value = nextState.nextModelConfig.provider || CUSTOM_MODEL_PROVIDER_KEY
    if (
      provider.value === OPENAI_PROVIDER_KEY &&
      nextState.nextModelConfig.authMode === MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH
    ) {
      provider.value = CODEX_PROVIDER_KEY
    }
    authMode.value =
      provider.value === CODEX_PROVIDER_KEY
        ? MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH
        : nextState.nextModelConfig.authMode || MODEL_AUTH_MODE_API_KEY
    initializeProviderDrafts(
      nextState.providers,
      provider.value,
      nextState.nextModelConfig as Record<string, any>,
    )
    applyProviderDraft(provider.value)
    await loadProviderModelOptions()
  }

  function openModelSettings() {
    modelSettingMessage.value = ''
    tokenVisible.value = false
    closeProviderDropdown()
    closeModelDropdown()
    showModelSettings.value = true
    void loadModelSettings()
  }

  function closeModelSettings() {
    if (isSavingModelSetting.value) return
    closeProviderDropdown()
    closeModelDropdown()
    showModelSettings.value = false
  }

  async function importCodexAuthToken() {
    const electronAPI = window.electronAPI
    if (isImportingCodexAuth.value) {
      return
    }

    if (!electronAPI?.app?.getCodexAuth) {
      modelSettingMessageLevel.value = 'error'
      modelSettingMessage.value = '当前应用版本未包含 Codex 导入能力，请重启应用后重试。'
      return
    }

    isImportingCodexAuth.value = true
    modelSettingMessage.value = ''

    try {
      const codexAuth = await electronAPI.app.getCodexAuth()
      captureCurrentProviderDraft()
      provider.value = CODEX_PROVIDER_KEY
      authMode.value = MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH
      token.value = codexAuth.accessToken || ''
      tokenVisible.value = true
      oauthAccessToken.value = codexAuth.accessToken || ''
      oauthAccountId.value = codexAuth.accountId || ''
      oauthEmail.value = codexAuth.email || ''
      oauthExpiresAt.value = codexAuth.expiresAt || ''
      baseUrl.value = effectiveBaseUrl.value
      await loadProviderModelOptions(codexAuth.accessToken || '')
      captureCurrentProviderDraft()

      modelSettingMessageLevel.value = 'success'
      modelSettingMessage.value = codexAuth.expiresAt
        ? `已从 Codex 导入 token，来源 ${codexAuth.sourcePath}，有效期至 ${new Date(codexAuth.expiresAt).toLocaleString('zh-CN')}`
        : '已从 Codex 导入 token'
    } catch (error) {
      console.error('[Chat] 读取 Codex token 失败:', error)
      modelSettingMessageLevel.value = 'error'
      modelSettingMessage.value =
        error instanceof Error ? error.message : '读取 Codex token 失败'
    } finally {
      isImportingCodexAuth.value = false
    }
  }

  async function loadProviderModelOptions(credentialOverride?: string) {
    if (!showModelSettings.value || provider.value === CUSTOM_MODEL_PROVIDER_KEY) {
      modelOptions.value = []
      return
    }

    if (provider.value === CODEX_PROVIDER_KEY) {
      try {
        const nextModelOptions = await window.electronAPI?.app?.getCodexModels?.()
        modelOptions.value = Array.isArray(nextModelOptions) ? nextModelOptions : []
        if (modelOptions.value.length > 0 && !modelOptions.value.includes(modelId.value)) {
          modelId.value = modelOptions.value[0] || ''
        }
      } catch (error) {
        console.error('[Chat] 读取 Codex 模型列表失败:', error)
        modelOptions.value = []
        modelSettingMessageLevel.value = 'warning'
        modelSettingMessage.value = '读取 Codex 模型列表失败，请检查 ~/.codex/models_cache.json'
      }
      return
    }

    const credential = credentialOverride || token.value.trim()
    const nextBaseUrl = effectiveBaseUrl.value

    if (!nextBaseUrl || !credential) {
      modelOptions.value = []
      return
    }

    const nextModelOptions = await fetchProviderModels({
      providerKey: provider.value,
      baseUrl: nextBaseUrl,
      apiKey: credential,
      onInfo: (message: string) => {
        modelSettingMessageLevel.value = 'warning'
        modelSettingMessage.value = message
      },
    })

    modelOptions.value = nextModelOptions
    if (nextModelOptions.length > 0 && !nextModelOptions.includes(modelId.value)) {
      modelId.value = nextModelOptions[0] || ''
    }
  }

  async function confirmModelSettings() {
    const electronAPI = window.electronAPI
    if (!electronAPI || isSavingModelSetting.value) {
      return
    }

    modelSettingMessage.value = ''
    isSavingModelSetting.value = true

    try {
      const ok = await submitModelSetting({
        electronAPI,
        providerKeySet,
        modelType: modelType.value,
        provider: provider.value,
        authMode: authMode.value,
        baseUrl: effectiveBaseUrl.value,
        apiKey: token.value.trim(),
        oauthAccessToken: oauthAccessToken.value.trim(),
        oauthRefreshToken: oauthRefreshToken.value.trim(),
        oauthIdToken: oauthIdToken.value.trim(),
        oauthAccountId: oauthAccountId.value.trim(),
        oauthEmail: oauthEmail.value.trim(),
        oauthExpiresAt: oauthExpiresAt.value.trim(),
        modelName: provider.value === CUSTOM_MODEL_PROVIDER_KEY ? '' : modelId.value.trim(),
        customModelName: provider.value === CUSTOM_MODEL_PROVIDER_KEY ? modelId.value.trim() : '',
        validateConfig: () => Promise.resolve(true),
        onPersisted: async () => {
          const refreshed = await refreshChatModelConfigCache(electronAPI)
          providers.value = refreshed.providers
          primaryModel.value = refreshed.primaryModel
          initializeProviderDrafts(
            refreshed.providers,
            provider.value,
            {
              authMode: authMode.value,
              baseUrl: effectiveBaseUrl.value,
              apiKey: token.value.trim(),
              oauthAccessToken: oauthAccessToken.value.trim(),
              oauthRefreshToken: oauthRefreshToken.value.trim(),
              oauthIdToken: oauthIdToken.value.trim(),
              oauthAccountId: oauthAccountId.value.trim(),
              oauthEmail: oauthEmail.value.trim(),
              oauthExpiresAt: oauthExpiresAt.value.trim(),
              modelName: provider.value === CUSTOM_MODEL_PROVIDER_KEY ? '' : modelId.value.trim(),
              customModelName: provider.value === CUSTOM_MODEL_PROVIDER_KEY ? modelId.value.trim() : '',
            },
          )
        },
        showWarning: (message: string) => {
          modelSettingMessageLevel.value = 'warning'
          modelSettingMessage.value = message
        },
        showError: (message: string) => {
          modelSettingMessageLevel.value = 'error'
          modelSettingMessage.value = message
        },
      })

      if (!ok) {
        return
      }

      modelSettingMessageLevel.value = 'success'
      modelSettingMessage.value = '模型配置已更新'
      showModelSettings.value = false
      await loadModelSettings()
    } finally {
      isSavingModelSetting.value = false
    }
  }

  return {
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
    effectiveBaseUrl,
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
    loadProviderModelOptions,
    confirmModelSettings,
  }
}
