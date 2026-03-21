import {
  SYSTEM_CONFIG_PROVIDER_KEY,
  CUSTOM_MODEL_PROVIDER_KEY,
  CODEX_PROVIDER_KEY,
  MODEL_AUTH_MODE_API_KEY,
  getProviderAuthMode,
  getProviderCredential,
} from "./chat-model-config.js"

function normalizeLegacyProviderKey(providerKey) {
  return providerKey === "codex" ? CODEX_PROVIDER_KEY : providerKey
}

function resetProviderFormState(targetState) {
  targetState.authMode = MODEL_AUTH_MODE_API_KEY
  targetState.apiKey = ""
  targetState.modelName = ""
  targetState.customModelName = ""
  targetState.baseUrl = ""
  targetState.modelOptions = []
}

export function resolveProviderBaseUrl(providerKey, providerOptions, currentBaseUrl) {
  if (providerKey === SYSTEM_CONFIG_PROVIDER_KEY) {
    return ""
  }

  const providerOption = providerOptions.find((item) => item.key === providerKey)
  const defaultBaseUrl = providerOption?.baseUrl || ""
  return currentBaseUrl || defaultBaseUrl
}

export async function restoreCustomProviderSelection({
  electronAPI,
  providerKeySet,
  cachedModelSetting,
  isSharedMode,
}) {
  if (isSharedMode) {
    return {
      provider: SYSTEM_CONFIG_PROVIDER_KEY,
      authMode: MODEL_AUTH_MODE_API_KEY,
      apiKey: "",
      baseUrl: "",
      modelName: "",
      customModelName: "",
      shouldFetchModels: false,
    }
  }

  const providers = await electronAPI?.config.getField("models.providers")
  if (!providers) {
    return null
  }

  let providerKey = cachedModelSetting?.provider
  providerKey = normalizeLegacyProviderKey(providerKey)

  if (!providerKey) {
    const primaryModel = await electronAPI?.config.getField("agents.defaults.model.primary")
    if (primaryModel) {
      const separatorIndex = primaryModel.indexOf("/")
      const primaryProvider = separatorIndex > 0 ? primaryModel.slice(0, separatorIndex) : ""
      const normalizedPrimaryProvider = normalizeLegacyProviderKey(primaryProvider)
      if (normalizedPrimaryProvider && providerKeySet.has(normalizedPrimaryProvider)) {
        providerKey = normalizedPrimaryProvider
      }
    }
  }

  if (!providerKey) {
    for (const candidateKey of Object.keys(providers)) {
      const normalizedCandidateKey = normalizeLegacyProviderKey(candidateKey)
      if (
        providerKeySet.has(normalizedCandidateKey) &&
        getProviderCredential(candidateKey, providers[candidateKey])
      ) {
        providerKey = normalizedCandidateKey
        break
      }
    }
  }

  if (!providerKey) {
    return null
  }

  const providerConfig = providers[providerKey] || providers.codex
  if (!providerConfig) {
    return null
  }

  const firstModelId = providerConfig.models?.[0]?.id || ""
  return {
    provider: providerKey,
    authMode: getProviderAuthMode(providerKey, providerConfig),
    apiKey: getProviderCredential(providerKey, providerConfig),
    baseUrl: providerConfig.baseUrl || "",
    modelName: providerKey === CUSTOM_MODEL_PROVIDER_KEY ? "" : firstModelId,
    customModelName: providerKey === CUSTOM_MODEL_PROVIDER_KEY ? firstModelId : "",
    shouldFetchModels:
      providerKey !== CUSTOM_MODEL_PROVIDER_KEY &&
      providerKey !== CODEX_PROVIDER_KEY &&
      providerKey !== SYSTEM_CONFIG_PROVIDER_KEY &&
      Boolean(getProviderCredential(providerKey, providerConfig)),
  }
}

export async function syncProviderFormStateFromConfig({
  electronAPI,
  providerKey,
}) {
  providerKey = normalizeLegacyProviderKey(providerKey)

  if (!providerKey || providerKey === SYSTEM_CONFIG_PROVIDER_KEY) {
    return {
      apiKey: "",
      authMode: MODEL_AUTH_MODE_API_KEY,
      modelName: "",
      customModelName: "",
      baseUrl: "",
      modelOptions: [],
      shouldFetchModels: false,
    }
  }

  try {
    const providers = await electronAPI?.config.getField("models.providers")
    const providerConfig = providers?.[providerKey] || (providerKey === CODEX_PROVIDER_KEY ? providers?.codex : undefined)

    if (!providerConfig) {
      return {
        apiKey: "",
        authMode: MODEL_AUTH_MODE_API_KEY,
        modelName: "",
        customModelName: "",
        baseUrl: "",
        modelOptions: [],
        shouldFetchModels: false,
      }
    }

    const firstModelId = providerConfig.models?.[0]?.id || ""
    return {
      authMode: getProviderAuthMode(providerKey, providerConfig),
      apiKey: getProviderCredential(providerKey, providerConfig),
      modelName: providerKey === CUSTOM_MODEL_PROVIDER_KEY ? "" : firstModelId,
      customModelName:
        providerKey === CUSTOM_MODEL_PROVIDER_KEY ? firstModelId : "",
      baseUrl: providerConfig.baseUrl || "",
      modelOptions: [],
      shouldFetchModels:
        providerKey !== CUSTOM_MODEL_PROVIDER_KEY &&
        providerKey !== CODEX_PROVIDER_KEY &&
        Boolean(getProviderCredential(providerKey, providerConfig)),
    }
  } catch {
    return {
      apiKey: "",
      authMode: MODEL_AUTH_MODE_API_KEY,
      modelName: "",
      customModelName: "",
      baseUrl: "",
      modelOptions: [],
      shouldFetchModels: false,
    }
  }
}

export async function fetchProviderModels({
  providerKey,
  baseUrl,
  apiKey,
  info,
  onInfo,
}) {
  if (providerKey === CODEX_PROVIDER_KEY) {
    return []
  }

  if (!baseUrl || !apiKey) {
    return []
  }

  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const payload = await response.json()
    return payload.data && Array.isArray(payload.data)
      ? payload.data.map((item) => item.id)
      : []
  } catch (error) {
    console.error("获取模型列表失败:", error)
    onInfo?.(info || "获取模型列表失败，请检查认证信息是否正确，或手动填入 Model ID")
    return []
  }
}

export { resetProviderFormState }
