import {
  SYSTEM_CONFIG_PROVIDER_KEY,
  MODEL_AUTH_MODE_API_KEY,
  CODEX_PROVIDER_KEY,
  CHAT_MODEL_PROVIDER_OPTIONS,
  MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH,
  getProviderAuthMode,
  getProviderCredential,
} from "./chat-model-config.js"

export async function initializeModelSettingModalState({
  electronAPI,
  initialPrimary,
  initialProviders,
  instanceMode,
  cachedModelSetting,
  providerKeys,
}) {
  const primaryModel =
    initialPrimary ??
    (await electronAPI?.config.getField("agents.defaults.model.primary"))

  const providers =
    initialProviders ??
    (await electronAPI?.config.getField("models.providers"))

  const primaryProviderSeparatorIndex = primaryModel
    ? primaryModel.indexOf("/")
    : -1
  const primaryProvider =
    primaryProviderSeparatorIndex > 0 ? primaryModel.slice(0, primaryProviderSeparatorIndex) : ""
  const primaryModelName =
    primaryProviderSeparatorIndex > 0
      ? primaryModel.slice(primaryProviderSeparatorIndex + 1)
      : ""

  const hasKnownPrimaryProvider =
    primaryProvider !== "" && providerKeys.has(primaryProvider)

  const nextState = {
    modelType: "default",
    provider: undefined,
    authMode: MODEL_AUTH_MODE_API_KEY,
    apiKey: "",
    oauthAccountId: "",
    oauthEmail: "",
    oauthExpiresAt: "",
    oauthRefreshToken: "",
    oauthIdToken: "",
    oauthAccessToken: "",
    modelName: "",
    customModelName: "",
    baseUrl: "",
    providers,
  }

  if (instanceMode === "shared" && !hasKnownPrimaryProvider) {
    nextState.modelType = "custom"
    nextState.provider = SYSTEM_CONFIG_PROVIDER_KEY
    return nextState
  }

  if (hasKnownPrimaryProvider) {
    const providerConfig = providers?.[primaryProvider]
    const providerBaseUrl =
      providerConfig?.baseUrl ||
      CHAT_MODEL_PROVIDER_OPTIONS.find((option) => option.key === primaryProvider)?.baseUrl ||
      cachedModelSetting?.baseUrl ||
      ""
    nextState.modelType = "custom"
    nextState.provider = primaryProvider
    nextState.authMode =
      primaryProvider === CODEX_PROVIDER_KEY
        ? MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH
        : getProviderAuthMode(primaryProvider, providerConfig)
    nextState.apiKey = getProviderCredential(primaryProvider, providerConfig)
    nextState.oauthAccessToken = providerConfig?.oauthAccessToken || ""
    nextState.oauthRefreshToken = providerConfig?.oauthRefreshToken || ""
    nextState.oauthIdToken = providerConfig?.oauthIdToken || ""
    nextState.oauthAccountId = providerConfig?.oauthAccountId || ""
    nextState.oauthEmail = providerConfig?.oauthEmail || ""
    nextState.oauthExpiresAt = providerConfig?.oauthExpiresAt || ""
    nextState.baseUrl = providerBaseUrl

    if (primaryProvider === "other") {
      nextState.customModelName =
        primaryModelName || providerConfig?.models?.[0]?.id || ""
    } else {
      nextState.modelName =
        primaryModelName || providerConfig?.models?.[0]?.id || ""
    }

    return nextState
  }

  if (cachedModelSetting) {
    nextState.modelType = cachedModelSetting.modelType || "default"
    nextState.provider = cachedModelSetting.provider

    if (
      cachedModelSetting.modelType === "custom" &&
      cachedModelSetting.provider &&
      providers
    ) {
      const providerConfig = providers[cachedModelSetting.provider]
      if (providerConfig) {
        nextState.authMode = getProviderAuthMode(cachedModelSetting.provider, providerConfig)
        nextState.apiKey = getProviderCredential(cachedModelSetting.provider, providerConfig)
        nextState.oauthAccessToken = providerConfig?.oauthAccessToken || ""
        nextState.oauthRefreshToken = providerConfig?.oauthRefreshToken || ""
        nextState.oauthIdToken = providerConfig?.oauthIdToken || ""
        nextState.oauthAccountId = providerConfig?.oauthAccountId || ""
        nextState.oauthEmail = providerConfig?.oauthEmail || ""
        nextState.oauthExpiresAt = providerConfig?.oauthExpiresAt || ""
        nextState.baseUrl = providerConfig.baseUrl || ""

        if (cachedModelSetting.provider === "other") {
          nextState.customModelName = providerConfig.models?.[0]?.id || ""
        } else {
          nextState.modelName = providerConfig.models?.[0]?.id || ""
        }
      }
    }

    return nextState
  }

  return nextState
}
