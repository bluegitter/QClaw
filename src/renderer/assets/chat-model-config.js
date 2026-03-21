export const DEFAULT_MODEL_PROVIDER_KEY = "qclaw"
export const SYSTEM_CONFIG_PROVIDER_KEY = "system-config"
export const CUSTOM_MODEL_PROVIDER_KEY = "other"
export const OPENAI_PROVIDER_KEY = "openai"
export const CODEX_PROVIDER_KEY = "openai-codex"
export const MODEL_REQUEST_TIMEOUT_MS = 30000
export const MODEL_AUTH_MODE_API_KEY = "api-key"
export const MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH = "openai-codex-oauth"

export const CHAT_MODEL_PROVIDER_KEYS = [
  "minimax",
  "kimi",
  "deepseek",
  "zai",
  "qwen",
  "hunyuan",
  "doubao",
  OPENAI_PROVIDER_KEY,
  CODEX_PROVIDER_KEY,
  CUSTOM_MODEL_PROVIDER_KEY,
  SYSTEM_CONFIG_PROVIDER_KEY,
]

export const CHAT_MODEL_PROVIDER_LABELS = {
  [SYSTEM_CONFIG_PROVIDER_KEY]: "用户系统配置",
  minimax: "Minimax",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  zai: "智谱",
  qwen: "千问",
  hunyuan: "混元",
  doubao: "豆包",
  [OPENAI_PROVIDER_KEY]: "OpenAI",
  [CODEX_PROVIDER_KEY]: "Codex",
  [CUSTOM_MODEL_PROVIDER_KEY]: "自定义",
}

export const CHAT_MODEL_PROVIDER_OPTIONS = [
  {
    key: SYSTEM_CONFIG_PROVIDER_KEY,
    label: CHAT_MODEL_PROVIDER_LABELS[SYSTEM_CONFIG_PROVIDER_KEY],
    baseUrl: "",
    officialUrl: "",
  },
  {
    key: "minimax",
    label: CHAT_MODEL_PROVIDER_LABELS.minimax,
    baseUrl: "https://api.minimaxi.com/v1",
    officialUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
  },
  {
    key: "kimi",
    label: CHAT_MODEL_PROVIDER_LABELS.kimi,
    baseUrl: "https://api.moonshot.cn/v1",
    officialUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    key: "deepseek",
    label: CHAT_MODEL_PROVIDER_LABELS.deepseek,
    baseUrl: "https://api.deepseek.com/",
    officialUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    key: "zai",
    label: CHAT_MODEL_PROVIDER_LABELS.zai,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    officialUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    key: "qwen",
    label: CHAT_MODEL_PROVIDER_LABELS.qwen,
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    officialUrl: "https://bailian.console.aliyun.com/cn-beijing/?tab=model#/api-key",
  },
  {
    key: "hunyuan",
    label: CHAT_MODEL_PROVIDER_LABELS.hunyuan,
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    officialUrl: "https://console.cloud.tencent.com/lkeap",
  },
  {
    key: "doubao",
    label: CHAT_MODEL_PROVIDER_LABELS.doubao,
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    officialUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
  },
  {
    key: OPENAI_PROVIDER_KEY,
    label: CHAT_MODEL_PROVIDER_LABELS[OPENAI_PROVIDER_KEY],
    baseUrl: "https://api.openai.com/v1",
    officialUrl: "https://platform.openai.com/",
  },
  {
    key: CODEX_PROVIDER_KEY,
    label: CHAT_MODEL_PROVIDER_LABELS[CODEX_PROVIDER_KEY],
    baseUrl: "https://chatgpt.com/backend-api",
    officialUrl: "",
  },
  {
    key: CUSTOM_MODEL_PROVIDER_KEY,
    label: CHAT_MODEL_PROVIDER_LABELS[CUSTOM_MODEL_PROVIDER_KEY],
    baseUrl: "",
    officialUrl: "",
  },
]

export function getChatModelDisplayLabel(modelConfig, providerLabels = CHAT_MODEL_PROVIDER_LABELS) {
  if (modelConfig.modelType === "default") {
    return "默认大模型"
  }
  if (modelConfig.modelName) {
    return modelConfig.modelName
  }
  if (modelConfig.provider) {
    return providerLabels[modelConfig.provider] || modelConfig.provider
  }
  return "自定义大模型"
}

export function getProviderAuthMode(providerKey, providerConfig) {
  if (providerConfig?.authMode) {
    return providerConfig.authMode
  }

  if (providerKey === CODEX_PROVIDER_KEY) {
    return MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH
  }

  if (providerKey === OPENAI_PROVIDER_KEY && providerConfig?.oauthAccessToken) {
    return MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH
  }

  return MODEL_AUTH_MODE_API_KEY
}

export function getProviderCredential(providerKey, providerConfig) {
  const authMode = getProviderAuthMode(providerKey, providerConfig)

  if (authMode === MODEL_AUTH_MODE_OPENAI_CODEX_OAUTH) {
    return providerConfig?.oauthAccessToken || providerConfig?.apiKey || ""
  }

  return providerConfig?.apiKey || providerConfig?.oauthAccessToken || ""
}
