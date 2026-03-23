/**
 * wecom_mcp — 模拟 MCP 调用的 Agent Tool
 *
 * 通过 MCP Streamable HTTP 传输协议调用企业微信 MCP Server，
 * 提供 list（列出所有工具）和 call（调用工具）两个操作。
 *
 * 在 skills 中的使用方式：
 *   wecom_mcp list <category>
 *   wecom_mcp call <category> <method> '<jsonArgs>'
 *
 * 示例：
 *   wecom_mcp list contact
 *   wecom_mcp call contact getContact '{}'
 */

import { sendJsonRpc, clearCategoryCache, type McpToolInfo } from "./transport.js";
import { cleanSchemaForGemini } from "./schema.js";

// ============================================================================
// 类型定义
// ============================================================================

/** wecom_mcp 的入参 */
interface WeComToolsParams {
  /** 操作类型：list | call */
  action: "list" | "call";
  /** MCP 品类，对应 mcpConfig 中的 key，如 doc、contact */
  category: string;
  /** 调用的 MCP 方法名（action=call 时必填） */
  method?: string;
  /** 调用 MCP 方法的 JSON 参数（action=call 时使用） */
  args?: string | Record<string, unknown>;
}

// ============================================================================
// 响应构造辅助
// ============================================================================

/** 构造统一的文本响应结构 */
const textResult = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/** 构造错误响应 */
const errorResult = (err: unknown) => {
  // 适配企业微信 API 返回的 { errcode, errmsg } 结构
  if (err && typeof err === "object" && "errcode" in err) {
    const { errcode, errmsg } = err as { errcode: number; errmsg?: string };
    return textResult({ error: errmsg ?? `错误码: ${errcode}`, errcode });
  }

  const message = err instanceof Error ? err.message : String(err);
  return textResult({ error: message });
};

// ============================================================================
// list 操作：列出某品类的所有 MCP 工具
// ============================================================================

const handleList = async (category: string): Promise<unknown> => {
  const result = await sendJsonRpc(category, "tools/list") as { tools?: McpToolInfo[] } | undefined;

  const tools = result?.tools ?? [];
  if (tools.length === 0) {
    return { message: `品类 "${category}" 下暂无可用工具`, tools: [] };
  }

  return {
    category,
    count: tools.length,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      // 清洗 inputSchema，内联 $ref/$defs 引用并移除 Gemini 不支持的关键词，
      // 避免 Gemini 模型解析 function response 时报 400 错误
      inputSchema: t.inputSchema ? cleanSchemaForGemini(t.inputSchema) : undefined,
    })),
  };
};

// ============================================================================
// call 操作：调用某品类的某个 MCP 工具
// ============================================================================

/**
 * 需要触发缓存清理的业务错误码集合
 *
 * 这些错误码出现在 MCP 工具调用返回的 content 文本中（业务层面），
 * 与 JSON-RPC 层面的错误码不同，需要在此处额外检测。
 *
 * - 850002: 机器人未被授权使用对应能力，需清理缓存以便下次重新拉取配置
 */
const BIZ_CACHE_CLEAR_ERROR_CODES = new Set([850002]);

/**
 * 检查 tools/call 的返回结果中是否包含需要清理缓存的业务错误码
 *
 * MCP Server 可能在正常的 JSON-RPC 响应中返回业务层错误，
 * 这些错误被包裹在 result.content[].text 中，需要解析后判断。
 */
const checkBizErrorAndClearCache = (result: unknown, category: string): void => {
  if (!result || typeof result !== "object") return;

  const { content } = result as { content?: Array<{ type: string; text?: string }> };
  if (!Array.isArray(content)) return;

  for (const item of content) {
    if (item.type !== "text" || !item.text) continue;
    try {
      const parsed = JSON.parse(item.text) as Record<string, unknown>;
      if (typeof parsed.errcode === "number" && BIZ_CACHE_CLEAR_ERROR_CODES.has(parsed.errcode)) {
        console.log(`[mcp] 检测到业务错误码 ${parsed.errcode} (category="${category}")，清理缓存`);
        clearCategoryCache(category);
        return;
      }
    } catch {
      // text 不是 JSON 格式，跳过
    }
  }
};

const handleCall = async (
  category: string,
  method: string,
  args: Record<string, unknown>,
): Promise<unknown> => {
  const result = await sendJsonRpc(category, "tools/call", {
    name: method,
    arguments: args,
  });

  // 检查业务层错误码，必要时清理缓存
  checkBizErrorAndClearCache(result, category);

  return result;
};

// ============================================================================
// 参数解析
// ============================================================================

/**
 * 解析 args 参数：支持 JSON 字符串或直接的对象
 */
const parseArgs = (args: string | Record<string, unknown> | undefined): Record<string, unknown> => {
  if (!args) return {};
  if (typeof args === "object") return args;
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof SyntaxError ? err.message : String(err);
    throw new Error(`args 参数不是合法的 JSON: ${args} (${detail})`);
  }
};

// ============================================================================
// 工具定义 & 导出
// ============================================================================

/**
 * 创建 wecom_mcp Agent Tool 定义
 */
export function createWeComMcpTool() {
  return {
    name: "wecom_mcp",
    label: "企业微信 MCP 工具",
    description: [
      "通过 HTTP 直接调用企业微信 MCP Server。",
      "支持两种操作：",
      "  - list: 列出指定品类的所有 MCP 工具",
      "  - call: 调用指定品类的某个 MCP 工具",
      "",
      "使用方式：",
      "  wecom_mcp list <category>",
      "  wecom_mcp call <category> <method> '<jsonArgs>'",
      "",
      "示例：",
      "  列出 contact 品类所有工具：wecom_mcp list contact",
      "  调用 contact 的 getContact：wecom_mcp call contact getContact '{}'",
    ].join("\n"),
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "call"],
          description: "操作类型：list（列出工具）或 call（调用工具）",
        },
        category: {
          type: "string",
          description: "MCP 品类名称，如 doc、contact 等，对应 mcpConfig 中的 key",
        },
        method: {
          type: "string",
          description: "要调用的 MCP 方法名（action=call 时必填）",
        },
        args: {
          type: ["string", "object"],
          description: "调用 MCP 方法的参数，可以是 JSON 字符串或对象（action=call 时使用，默认 {}）",
        },
      },
      required: ["action", "category"],
    },
    async execute(_toolCallId: string, params: unknown) {
      const p = params as WeComToolsParams;
      try {
        switch (p.action) {
          case "list":
            return textResult(await handleList(p.category));
          case "call": {
            if (!p.method) {
              return textResult({ error: "action 为 call 时必须提供 method 参数" });
            }
            const args = parseArgs(p.args);
            return textResult(await handleCall(p.category, p.method, args));
          }
          default:
            return textResult({ error: `未知操作类型: ${String(p.action)}，支持 list 和 call` });
        }
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}
