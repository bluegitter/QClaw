function extractApiKeyFromResponse(response) {
  return (
    response?.data?.key ??
    response?.data?.resp?.data?.key ??
    response?.data?.resp?.key
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function syncChatBootstrapConfig({
  apiClient,
  electronAPI,
  notifyWarning,
  retryCount = 3,
  retryDelayMs = 1500
}) {
  try {
    const [initialChannelToken, initialApiKeyResponse] = await Promise.all([
      apiClient.refreshChannelToken().catch((error) => {
        console.error("[Chat] 获取 Channel Token 失败:", error);
      }),
      apiClient.createApiKey().catch((error) => {
        console.error("[Chat] 获取 API Key 失败:", error);
        return null;
      })
    ]);

    let channelToken = initialChannelToken;
    let apiKey = extractApiKeyFromResponse(initialApiKeyResponse);

    if (!channelToken || !apiKey) {
      for (let attempt = 1; attempt <= retryCount; attempt += 1) {
        const missingLabels = [
          !channelToken && "Channel Token",
          !apiKey && "API Key"
        ].filter(Boolean);

        console.warn(
          `[Chat] ${missingLabels.join(" & ")} 为空，第 ${attempt}/${retryCount} 次重试...`
        );

        await sleep(retryDelayMs);

        const retryTasks = [];
        const retryKinds = [];

        if (!channelToken) {
          retryKinds.push("channelToken");
          retryTasks.push(apiClient.refreshChannelToken().catch(() => {}));
        }

        if (!apiKey) {
          retryKinds.push("apiKey");
          retryTasks.push(apiClient.createApiKey().catch(() => null));
        }

        const retryResults = await Promise.all(retryTasks);

        retryKinds.forEach((kind, index) => {
          if (kind === "channelToken" && !channelToken) {
            channelToken = retryResults[index];
            return;
          }

          if (kind === "apiKey" && !apiKey) {
            apiKey = extractApiKeyFromResponse(retryResults[index]);
          }
        });

        if (channelToken && apiKey) {
          console.log(`[Chat] 第 ${attempt} 次重试成功，所有配置已获取`);
          break;
        }
      }
    }

    if (!channelToken) {
      console.warn("[Chat] 未能获取有效的 Channel Token");
    }

    if (!apiKey) {
      console.warn(
        "[Chat] 未能获取有效的默认模型 Token，默认模型聊天功能可能不可用"
      );
      notifyWarning?.("默认模型 Token 同步失败，请稍后重试或重新登录");
    }

    const [wechatToken, qclawApiKey, contentSecurityToken] = await Promise.all([
      electronAPI?.config.getField("channels.wechat-access.token"),
      electronAPI?.config.getField("models.providers.qclaw.apiKey"),
      electronAPI?.config.getField("plugins.entries.content-security.config.token")
    ]);

    const nextConfigPatch = {};

    if (channelToken && channelToken !== wechatToken) {
      nextConfigPatch.channels = { "wechat-access": { token: channelToken } };
    }

    if (channelToken && channelToken !== contentSecurityToken) {
      nextConfigPatch.plugins = {
        entries: {
          "content-security": {
            config: { token: channelToken }
          }
        }
      };
    }

    if (apiKey && apiKey !== qclawApiKey) {
      nextConfigPatch.models = {
        providers: {
          qclaw: { apiKey }
        }
      };
    }

    if (Object.keys(nextConfigPatch).length === 0) {
      return;
    }

    console.log(
      "[Chat] 配置不一致，同步写入 openclaw.json:",
      Object.keys(nextConfigPatch)
    );

    await electronAPI?.config.updateField(nextConfigPatch);
  } catch (error) {
    console.error("[Chat] 同步配置到文件异常:", error);
  }
}
