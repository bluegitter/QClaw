import {
  DEFAULT_MODEL_PROVIDER_KEY,
  SYSTEM_CONFIG_PROVIDER_KEY,
  CUSTOM_MODEL_PROVIDER_KEY,
  CODEX_PROVIDER_KEY,
  MODEL_REQUEST_TIMEOUT_MS,
  MODEL_AUTH_MODE_API_KEY,
  MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH,
} from "./chat-model-config.js"

function notifyValidationError(showError, statusCode, message, modelId) {
  if (statusCode === 401 || statusCode === 403) {
    showError("认证信息无效或无权限，请检查后重试")
    return false
  }

  if (statusCode === 404) {
    showError(`模型 ID "${modelId}" 不存在或不可用，请检查 model_id`)
    return false
  }

  if (statusCode === 429) {
    showError("API 调用频率超限，请稍后再试")
    return false
  }

  showError(message || `模型配置校验失败 (HTTP ${statusCode})，请检查配置`)
  return false
}

async function postChatCompletions(url, credential, payload) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), MODEL_REQUEST_TIMEOUT_MS)

  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

async function postResponses(url, credential, payload) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), MODEL_REQUEST_TIMEOUT_MS)

  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

function shouldRetryWithoutMaxTokens(payload) {
  const error = payload?.error
  if (!error) {
    return false
  }

  const errorCode = String(error.code || "")
  const errorType = String(error.type || "")
  const errorMessage = String(error.message || "")

  return (
    errorCode === "unsupported_parameter" ||
    (errorType === "invalid_request_error" &&
      /not supported|unsupported/i.test(errorMessage)) ||
    (errorType === "invalid_request_error" &&
      /max_tokens.*reached|output limit.*reached/i.test(errorMessage))
  )
}

export async function validateModelConfiguration({
  baseUrl,
  apiKey,
  modelId,
  provider,
  showError,
}) {
  if (provider === CODEX_PROVIDER_KEY) {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")
    const endpoint = normalizedBaseUrl.endsWith("/codex/responses")
      ? normalizedBaseUrl
      : normalizedBaseUrl.endsWith("/codex")
        ? `${normalizedBaseUrl}/responses`
        : `${normalizedBaseUrl}/codex/responses`

    try {
      const response = await postResponses(endpoint, apiKey, {
        model: modelId,
        instructions: "You are Codex, a coding assistant.",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "hi",
              },
            ],
          },
        ],
        stream: true,
        store: false,
      })

      if (response.ok) {
        return true
      }

      let payload = null
      try {
        payload = await response.json()
      } catch {
        return notifyValidationError(showError, response.status, "", modelId)
      }

      const payloadError = payload?.error
      const payloadMessage = String(
        payloadError?.message || payload?.message || "",
      )

      return notifyValidationError(
        showError,
        response.status,
        payloadMessage,
        modelId,
      )
    } catch (error) {
      console.error("[ModelSettingModal] 校验 Codex 模型配置失败:", error)
      if (error instanceof DOMException && error.name === "AbortError") {
        showError("校验请求超时，请检查网络连接或 Base URL 是否正确")
      } else {
        showError("网络请求失败，请检查 Codex Token、Base URL 或网络连接")
      }
      return false
    }
  }

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`

  try {
    let response = await postChatCompletions(endpoint, apiKey, {
      model: modelId,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    })

    if (response.ok) {
      return true
    }

    let payload = null
    try {
      payload = await response.json()
    } catch {
      return notifyValidationError(showError, response.status, "", modelId)
    }

    if (shouldRetryWithoutMaxTokens(payload)) {
      response = await postChatCompletions(endpoint, apiKey, {
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
      })

      if (response.ok) {
        return true
      }

      let retryMessage = ""
      try {
        const retryPayload = await response.json()
        const retryError = retryPayload?.error
        retryMessage = String(
          retryError?.message || retryPayload?.message || "",
        )
      } catch {
        // ignore parse failure, fallback to default message
      }

      return notifyValidationError(
        showError,
        response.status,
        retryMessage,
        modelId,
      )
    }

    const payloadError = payload?.error
    const payloadMessage = String(
      payloadError?.message || payload?.message || "",
    )

    return notifyValidationError(
      showError,
      response.status,
      payloadMessage,
      modelId,
    )
  } catch (error) {
    console.error("[ModelSettingModal] 校验模型配置失败:", error)
    if (error instanceof DOMException && error.name === "AbortError") {
      showError("校验请求超时，请检查网络连接或 Base URL 是否正确")
    } else {
      showError("网络请求失败，请检查 Base URL 是否正确或网络连接是否正常")
    }
    return false
  }
}

export function openProviderOfficialUrl(providerKey, providerOptions) {
  const providerOption = providerOptions.find((item) => item.key === providerKey)
  if (providerOption?.officialUrl) {
    window.open(providerOption.officialUrl, "_blank")
  }
}

function buildModelSettingPayload({ modelType, provider, authMode, baseUrl, apiKey, modelId }) {
  const payload = { modelType }
  if (modelType === "custom") {
    payload.provider = provider
    if (provider !== SYSTEM_CONFIG_PROVIDER_KEY) {
      payload.authMode = authMode
      payload.baseUrl = baseUrl
      payload.apiKey = apiKey
      payload.modelName = modelId
    }
  }
  return payload
}

async function resolveSystemConfigPrimaryModel({
  electronAPI,
  providerKeySet,
  showError,
}) {
  const providers = await electronAPI?.config.getField("models.providers")
  let primaryModel = ""

  if (providers) {
    for (const [providerKey, providerConfig] of Object.entries(providers)) {
      if (!providerKeySet.has(providerKey) && providerConfig?.models?.[0]?.id) {
        primaryModel = `${providerKey}/${providerConfig.models[0].id}`
        break
      }
    }
  }

  if (!primaryModel) {
    const configuredPrimaryModel = await electronAPI?.config.getField(
      "agents.defaults.model.primary",
    )
    if (configuredPrimaryModel) {
      const separatorIndex = configuredPrimaryModel.indexOf("/")
      const providerKey =
        separatorIndex > 0 ? configuredPrimaryModel.slice(0, separatorIndex) : ""
      if (!providerKeySet.has(providerKey)) {
        primaryModel = configuredPrimaryModel
      }
    }
  }

  if (!primaryModel) {
    showError("未找到默认模型配置，请检查 openclaw.json")
    return null
  }

  return primaryModel
}

async function persistModelSelection({
  electronAPI,
  providerKeySet,
  provider,
  modelType,
  authMode,
  baseUrl,
  apiKey,
  oauthAccessToken,
  oauthRefreshToken,
  oauthIdToken,
  oauthAccountId,
  oauthEmail,
  oauthExpiresAt,
  modelId,
  showError,
}) {
  if (modelType === "custom" && provider === SYSTEM_CONFIG_PROVIDER_KEY) {
    const primaryModel = await resolveSystemConfigPrimaryModel({
      electronAPI,
      providerKeySet,
      showError,
    })

    if (!primaryModel) {
      return false
    }

    const result = await electronAPI?.config.updateField({
      agents: { defaults: { model: { primary: primaryModel } } },
    })

    if (result && !result.success) {
      showError(result.message || "配置更新失败")
      return false
    }

    return true
  }

  if (modelType === "custom" && modelId) {
    if (provider === CODEX_PROVIDER_KEY) {
      const result = await electronAPI?.config.removeProvider(
        provider,
        `${provider}/${modelId}`,
      )

      if (result && !result.success) {
        showError(result.message || "配置更新失败")
        return false
      }

      return true
    }

    const providerPayload = {
      baseUrl,
      apiKey:
        authMode === MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH
          ? oauthAccessToken || apiKey
          : apiKey,
      api: provider === CODEX_PROVIDER_KEY ? "openai-responses" : "openai-completions",
      models: [{ id: modelId, name: modelId }],
    }

    const result = await electronAPI?.config.replaceProvider(
      provider,
      providerPayload,
      `${provider}/${modelId}`,
    )

    if (result && !result.success) {
      showError(result.message || "配置更新失败")
      return false
    }

    return true
  }

  const providers = await electronAPI?.config.getField("models.providers")
  const defaultProvider = providers?.[DEFAULT_MODEL_PROVIDER_KEY]
  const defaultModelId = defaultProvider?.models?.[0]?.id

  if (!defaultModelId) {
    showError("未找到默认模型配置，请检查 openclaw.json")
    return false
  }

  const result = await electronAPI?.config.updateField({
    agents: {
      defaults: {
        model: { primary: `${DEFAULT_MODEL_PROVIDER_KEY}/${defaultModelId}` },
      },
    },
  })

  if (result && !result.success) {
    showError(result.message || "配置更新失败")
    return false
  }

  return true
}

export async function submitModelSetting({
  electronAPI,
  providerKeySet,
  modelType,
  provider,
  authMode = MODEL_AUTH_MODE_API_KEY,
  baseUrl,
  apiKey,
  oauthAccessToken,
  oauthRefreshToken,
  oauthIdToken,
  oauthAccountId,
  oauthEmail,
  oauthExpiresAt,
  modelName,
  customModelName,
  validateConfig,
  onPersisted,
  showWarning,
  showError,
}) {
  if (modelType === "custom") {
    if (!provider) {
      showWarning("请选择模型厂商")
      return false
    }

    if (provider !== SYSTEM_CONFIG_PROVIDER_KEY) {
      if (!baseUrl) {
        showWarning("请输入 Base URL")
        return false
      }
      if (!apiKey) {
        showWarning(
          authMode === MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH
            ? "请输入 Codex Token"
            : "请输入 Token",
        )
        return false
      }
      if (provider === CUSTOM_MODEL_PROVIDER_KEY) {
        if (!customModelName) {
          showWarning("请输入 Model ID")
          return false
        }
      } else if (!modelName) {
        showWarning("请选择或输入 Model ID")
        return false
      }
    }
  }

  const selectedModelId =
    provider === CUSTOM_MODEL_PROVIDER_KEY ? customModelName : modelName
  const payload = buildModelSettingPayload({
    modelType,
    provider,
    authMode,
    baseUrl,
    apiKey,
    modelId: selectedModelId,
  })

  if (modelType === "custom" && provider !== SYSTEM_CONFIG_PROVIDER_KEY) {
    if (provider !== CODEX_PROVIDER_KEY && baseUrl && apiKey && selectedModelId) {
      const isValid = await validateConfig({
        baseUrl,
        apiKey,
        modelId: selectedModelId,
      })

      if (!isValid) {
        return false
      }
    }
  }

  try {
    const persisted = await persistModelSelection({
      electronAPI,
      providerKeySet,
      provider,
      modelType,
      authMode,
      baseUrl,
      apiKey,
      oauthAccessToken,
      oauthRefreshToken,
      oauthIdToken,
      oauthAccountId,
      oauthEmail,
      oauthExpiresAt,
      modelId: selectedModelId,
      showError,
    })

    if (!persisted) {
      return false
    }
  } catch (error) {
    console.error("[ModelSettingModal] 写入配置失败:", error)
    showError("配置保存失败")
    return false
  }

  onPersisted(payload)
  return true
}
