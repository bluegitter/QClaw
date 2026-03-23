/**
 * MCP 配置拉取与持久化模块
 *
 * 负责:
 * - 通过 WSClient 发送 aibot_get_mcp_config 请求
 * - 解析服务端响应,提取 MCP 配置(url、type、is_authed)
 * - 将配置写入 openclaw.plugin.json 的 wecomMcp 字段
 */

import os from "os";
import path from "path";
import { type WSClient, generateReqId } from "@wecom/aibot-node-sdk";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import {
  readJsonFileWithFallback,
  writeJsonFileAtomically,
  withFileLock,
} from "openclaw/plugin-sdk";
import type { McpConfigBody } from "./interface.js";
import {
  MCP_GET_CONFIG_CMD,
  MCP_CONFIG_FETCH_TIMEOUT_MS,
//   PLUGIN_JSON_PATH,
} from "./const.js";
import { withTimeout } from "./timeout.js";

// ============================================================================
// MCP 配置拉取
// ============================================================================

/**
 * 通过 WSClient 发送 aibot_get_mcp_config 命令,获取 MCP 配置
 *
 * @param wsClient - 已认证的 WSClient 实例
 * @returns MCP 配置(url、type、is_authed)
 * @throws 响应错误码非 0 或缺少 url 字段时抛出错误
 */
export async function fetchMcpConfig(
  wsClient: WSClient,
): Promise<McpConfigBody> {
  const biz_type = "doc";
  const reqId = generateReqId("mcp_config");

  // 通过 reply 方法发送自定义命令
  const response = await withTimeout(
    wsClient.reply(
      { headers: { req_id: reqId } },
      { biz_type },
      MCP_GET_CONFIG_CMD,
    ),
    MCP_CONFIG_FETCH_TIMEOUT_MS,
    `MCP config fetch timed out after ${MCP_CONFIG_FETCH_TIMEOUT_MS}ms`,
  );

  // 校验响应错误码
  if (response.errcode && response.errcode !== 0) {
    throw new Error(
      `MCP config request failed: errcode=${response.errcode}, errmsg=${response.errmsg ?? "unknown"}`,
    );
  }

  // 提取并校验 body
  const body = response.body as McpConfigBody | undefined;
  if (!body?.url) {
    throw new Error(
      "MCP config response missing required 'url' field",
    );
  }

  return {
    biz_type,
    url: body.url,
    type: body.type,
    is_authed: body.is_authed,
  };
}

// ============================================================================
// 配置持久化
// ============================================================================

/**
 * 将 MCP 配置写入 openclaw.plugin.json 的 mcpConfig 字段
 *
 * 使用 OpenClaw SDK 提供的文件锁和原子写入,保证并发安全。
 * 配置格式: { mcpConfig: { [type]: { type, url } } }
 * 示例: { "mcpConfig": { "doc": { "type": "streamable-http", "url": "..." } } }
 *
 * @param config - MCP 配置
 * @param runtime - 运行时环境
 */
async function saveMcpConfigToPluginJson(
  config: McpConfigBody,
  runtime: RuntimeEnv,
): Promise<void> {
//   const pluginJsonPath = PLUGIN_JSON_PATH;
  
  // 获取绝对路径并写入到配置文件
//   const absolutePath = path.resolve(pluginJsonPath);
  const wecomConfigDir = path.join(os.homedir(), ".openclaw", "wecomConfig");
  const wecomConfigPath = path.join(wecomConfigDir, "config.json");
  
//   // 写入 wecom 配置文件
//   try {
//     const lockOptions = {
//       stale: 60_000,
//       retries: {
//         retries: 3,
//         factor: 1.35,
//         minTimeout: 8,
//         maxTimeout: 200,
//         randomize: true,
//       },
//     };
    
//     await withFileLock(wecomConfigPath, lockOptions, async () => {
//       const { value: wecomConfig } = await readJsonFileWithFallback<Record<string, unknown>>(
//         wecomConfigPath,
//         {},
//       );
      
//       wecomConfig.pluginConfigPath = absolutePath;
//       await writeJsonFileAtomically(wecomConfigPath, wecomConfig);
//       runtime.log?.(`[WeCom] Plugin config path saved to ${wecomConfigPath}`);
//     });
//   } catch (err) {
//     runtime.error?.(`[WeCom] Failed to save plugin config path: ${String(err)}`);
//   }

  const lockOptions = {
    stale: 60_000, // 60秒锁过期
    retries: {
      retries: 6,
      factor: 1.35,
      minTimeout: 8,
      maxTimeout: 1200,
      randomize: true,
    },
  };

  await withFileLock(wecomConfigPath, lockOptions, async () => {
    // 读取现有配置(不存在时使用空对象)
    const { value: pluginJson } = await readJsonFileWithFallback<Record<string, unknown>>(
      wecomConfigPath,
      {},
    );

    // 确保 mcpConfig 字段存在且为对象
    if (!pluginJson.mcpConfig || typeof pluginJson.mcpConfig !== 'object') {
      pluginJson.mcpConfig = {};
    }

    // 使用 type 作为键存储配置
    const typeKey = config.biz_type || 'default';
    (pluginJson.mcpConfig as Record<string, unknown>)[typeKey] = {
      type: config.type,
      url: config.url,
    };

    // 原子写入
    await writeJsonFileAtomically(wecomConfigPath, pluginJson);

    runtime.log?.(`[WeCom] MCP config saved to ${wecomConfigPath}`);
  });
}

// ============================================================================
// 组合入口
// ============================================================================

/**
 * 拉取 MCP 配置并持久化到 openclaw.plugin.json
 *
 * 认证成功后调用。失败仅记录日志,不影响 WebSocket 消息正常收发。
 *
 * @param wsClient - 已认证的 WSClient 实例
 * @param accountId - 账户 ID(用于日志)
 * @param runtime - 运行时环境(用于日志)
 */
export async function fetchAndSaveMcpConfig(
  wsClient: WSClient,
  accountId: string,
  runtime: RuntimeEnv,
): Promise<void> {
  try {
    runtime.log?.(`[${accountId}] Fetching MCP config...`);

    const config = await fetchMcpConfig(wsClient);
    runtime.log?.(
      `[${accountId}] MCP config fetched: url=${config.url}, type=${config.type ?? "N/A"}, is_authed=${config.is_authed ?? "N/A"}`,
    );

    await saveMcpConfigToPluginJson(config, runtime);
  } catch (err) {
    runtime.error?.(
      `[${accountId}] Failed to fetch/save MCP config: ${String(err)}`,
    );
  }
}
