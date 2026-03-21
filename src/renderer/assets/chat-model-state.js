import {
  CHAT_MODEL_PROVIDER_KEYS,
  SYSTEM_CONFIG_PROVIDER_KEY,
  MODEL_AUTH_MODE_API_KEY,
  getProviderAuthMode,
  getProviderCredential,
} from "./chat-model-config.js"

export async function loadChatModelState({
  electronAPI,
  cachedModelSetting,
  providerKeys = CHAT_MODEL_PROVIDER_KEYS,
}) {
  const [providers, primaryModel, instanceMode] = await Promise.all([
    electronAPI?.config.getField("models.providers"),
    electronAPI?.config.getField("agents.defaults.model.primary"),
    electronAPI?.instance?.getMode(),
  ])

  const sharedMode = instanceMode === "shared"
  let nextModelConfig = { modelType: "default" }

  if (primaryModel) {
    const providerSeparatorIndex = primaryModel.indexOf("/")
    const providerKey =
      providerSeparatorIndex > 0 ? primaryModel.slice(0, providerSeparatorIndex) : ""
    const modelName =
      providerSeparatorIndex > 0 ? primaryModel.slice(providerSeparatorIndex + 1) : ""

    if (providerKey !== "" && providerKeys.includes(providerKey)) {
      const providerConfig = providers?.[providerKey]
      nextModelConfig = {
        modelType: "custom",
        provider: providerKey,
        authMode: getProviderAuthMode(providerKey, providerConfig),
        baseUrl: providerConfig?.baseUrl || cachedModelSetting?.baseUrl || "",
        apiKey:
          getProviderCredential(providerKey, providerConfig) ||
          cachedModelSetting?.apiKey ||
          "",
        oauthAccessToken:
          providerConfig?.oauthAccessToken || cachedModelSetting?.oauthAccessToken || "",
        oauthRefreshToken:
          providerConfig?.oauthRefreshToken || cachedModelSetting?.oauthRefreshToken || "",
        oauthIdToken: providerConfig?.oauthIdToken || cachedModelSetting?.oauthIdToken || "",
        oauthAccountId:
          providerConfig?.oauthAccountId || cachedModelSetting?.oauthAccountId || "",
        oauthEmail: providerConfig?.oauthEmail || cachedModelSetting?.oauthEmail || "",
        oauthExpiresAt:
          providerConfig?.oauthExpiresAt || cachedModelSetting?.oauthExpiresAt || "",
        modelName:
          modelName ||
          providerConfig?.models?.[0]?.id ||
          cachedModelSetting?.modelName ||
          "",
      }
    } else if (sharedMode) {
      nextModelConfig = { modelType: "custom", provider: SYSTEM_CONFIG_PROVIDER_KEY }
    }
  } else if (sharedMode) {
    nextModelConfig = { modelType: "custom", provider: SYSTEM_CONFIG_PROVIDER_KEY }
  } else if (cachedModelSetting) {
    nextModelConfig = cachedModelSetting

    if (cachedModelSetting.modelType === "custom" && cachedModelSetting.provider) {
      const providerConfig = providers?.[cachedModelSetting.provider]
      if (providerConfig) {
        nextModelConfig = {
          ...cachedModelSetting,
          authMode: getProviderAuthMode(cachedModelSetting.provider, providerConfig),
          baseUrl: providerConfig.baseUrl || cachedModelSetting.baseUrl,
          apiKey:
            getProviderCredential(cachedModelSetting.provider, providerConfig) ||
            cachedModelSetting.apiKey,
          oauthAccessToken:
            providerConfig?.oauthAccessToken || cachedModelSetting.oauthAccessToken,
          oauthRefreshToken:
            providerConfig?.oauthRefreshToken || cachedModelSetting.oauthRefreshToken,
          oauthIdToken: providerConfig?.oauthIdToken || cachedModelSetting.oauthIdToken,
          oauthAccountId:
            providerConfig?.oauthAccountId || cachedModelSetting.oauthAccountId,
          oauthEmail: providerConfig?.oauthEmail || cachedModelSetting.oauthEmail,
          oauthExpiresAt:
            providerConfig?.oauthExpiresAt || cachedModelSetting.oauthExpiresAt,
          modelName: providerConfig.models?.[0]?.id || cachedModelSetting.modelName,
        }
      }
    }
  }

  if (!("authMode" in nextModelConfig)) {
    nextModelConfig.authMode = MODEL_AUTH_MODE_API_KEY
  }

  return {
    providers,
    primaryModel,
    instanceMode: instanceMode ?? null,
    nextModelConfig,
  }
}

export async function refreshChatModelConfigCache(electronAPI) {
  const [providers, primaryModel] = await Promise.all([
    electronAPI?.config.getField("models.providers"),
    electronAPI?.config.getField("agents.defaults.model.primary"),
  ])

  return {
    providers,
    primaryModel,
  }
}
