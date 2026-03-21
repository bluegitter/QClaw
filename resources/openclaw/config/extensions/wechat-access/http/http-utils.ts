import type { IncomingMessage } from "node:http";

// ============================================
// HTTP 工具方法
// ============================================
// 提供 HTTP 请求处理的通用工具函数

/**
 * 解析 URL 查询参数
 * @param req - Node.js HTTP 请求对象
 * @returns URLSearchParams 对象，可通过 get() 方法获取参数值
 * @description 
 * 从请求 URL 中提取查询参数，例如：
 * - /wechat-access?timestamp=123&nonce=abc
 * - 可通过 params.get('timestamp') 获取值
 * @example
 * const query = parseQuery(req);
 * const timestamp = query.get('timestamp');
 */
export const parseQuery = (req: IncomingMessage): URLSearchParams => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  return url.searchParams;
};

/**
 * 读取 HTTP 请求体内容
 * @param req - Node.js HTTP 请求对象
 * @returns Promise<string> 请求体的完整内容（字符串格式）
 * @description 
 * 异步读取请求体的所有数据块，适用于：
 * - POST 请求的 JSON 数据
 * - XML 格式的微信消息
 * - 表单数据
 * 
 * 内部实现：
 * 1. 监听 'data' 事件，累积数据块
 * 2. 监听 'end' 事件，返回完整内容
 * 3. 监听 'error' 事件，处理读取错误
 * @example
 * const body = await readBody(req);
 * const data = JSON.parse(body);
 */
export const readBody = async (req: IncomingMessage): Promise<string> => {
  return new Promise((resolve, reject) => {
    let body = "";
    // 监听数据块事件，累积内容
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    // 监听结束事件，返回完整内容
    req.on("end", () => {
      resolve(body);
    });
    // 监听错误事件
    req.on("error", reject);
  });
};

/**
 * 检查请求路径是否是服务号 webhook 路径
 * @param url - 请求的完整 URL 或路径
 * @returns 是否匹配服务号 webhook 路径
 * @description 
 * 支持多种路径格式：
 * - /wechat-access - 基础路径
 * - /wechat-access/webhook - 标准 webhook 路径
 * - /wechat-access/* - 任何以 /wechat-access/ 开头的路径
 * 
 * 用于路由判断，确保只处理服务号相关的请求
 * @example
 * if (isFuwuhaoWebhookPath(req.url)) {
 *   // 处理服务号消息
 * }
 */
export const isFuwuhaoWebhookPath = (url: string): boolean => {
  const pathname = new URL(url, "http://localhost").pathname;
  // 支持多种路径格式
  return pathname === "/wechat-access" || 
         pathname === "/wechat-access/webhook" ||
         pathname.startsWith("/wechat-access/");
};
