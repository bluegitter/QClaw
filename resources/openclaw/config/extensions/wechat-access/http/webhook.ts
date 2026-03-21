import type { IncomingMessage, ServerResponse } from "node:http";
import type { FuwuhaoMessage, SimpleAccount } from "./types.js";
import { verifySignature, decryptMessage } from "./crypto-utils.js";
import { parseQuery, readBody, isFuwuhaoWebhookPath } from "./http-utils.js";
import { handleMessage, handleMessageStream } from "./message-handler.js";

// ============================================
// 账号配置
// ============================================
// 微信服务号的账号配置信息
// 生产环境应从环境变量或配置文件中读取

/**
 * 模拟账号存储
 * @description 
 * 生产环境建议：
 * 1. 从环境变量读取：process.env.FUWUHAO_TOKEN 等
 * 2. 从配置文件读取：config.json
 * 3. 从数据库读取：支持多账号场景
 * 4. 使用密钥管理服务：如 AWS Secrets Manager
 */
const mockAccount: SimpleAccount = {
  token: "your_token_here",              // 微信服务号配置的 Token
  encodingAESKey: "your_encoding_aes_key_here",  // 消息加密密钥（43位字符）
  receiveId: "your_receive_id_here"      // 服务号的原始 ID
};

// ============================================
// Webhook 处理器（主入口）
// ============================================
/**
 * 处理微信服务号的 Webhook 请求
 * @param req - Node.js HTTP 请求对象
 * @param res - Node.js HTTP 响应对象
 * @returns Promise<boolean> 是否处理了此请求（true=已处理，false=交给其他处理器）
 * @description 
 * 此函数是微信服务号集成的主入口，负责：
 * 1. 路径匹配：检查是否是服务号 webhook 路径
 * 2. GET 请求：处理 URL 验证（微信服务器验证）
 * 3. POST 请求：处理用户消息
 *    - 支持加密消息（验证签名 + 解密）
 *    - 支持明文消息（测试用）
 *    - 支持同步返回和流式返回（SSE）
 * 
 * 请求流程：
 * - GET /wechat-access?signature=xxx&timestamp=xxx&nonce=xxx&echostr=xxx
 *   → 验证签名 → 解密 echostr → 返回明文
 * - POST /wechat-access （同步）
 *   → 验证签名 → 解密消息 → 调用 Agent → 返回 JSON
 * - POST /wechat-access?stream=true （流式）
 *   → 验证签名 → 解密消息 → 调用 Agent → 返回 SSE 流
 */
export const handleSimpleWecomWebhook = async (
  req: IncomingMessage, 
  res: ServerResponse
): Promise<boolean> => {
  // ============================================
  // 1. 路径匹配检查
  // ============================================
  // 检查请求路径是否匹配服务号 webhook 路径
  // 支持：/wechat-access、/wechat-access/webhook、/wechat-access/*
  if (!isFuwuhaoWebhookPath(req.url || "")) {
    return false; // 不是我们的路径，交给其他处理器
  }

  console.log(`[wechat-access] 收到请求: ${req.method} ${req.url}`);

  try {
    // ============================================
    // 2. 解析查询参数
    // ============================================
    // 微信服务器会在 URL 中附加验证参数
    const query = parseQuery(req);
    const timestamp = query.get("timestamp") || "";      // 时间戳
    const nonce = query.get("nonce") || "";              // 随机数
    const signature = query.get("msg_signature") || query.get("signature") || "";  // 签名

    // ============================================
    // 3. 处理 GET 请求 - URL 验证
    // ============================================
    // 微信服务器在配置 webhook 时会发送 GET 请求验证 URL
    // 请求格式：GET /wechat-access?signature=xxx&timestamp=xxx&nonce=xxx&echostr=xxx
    if (req.method === "GET") {
      const echostr = query.get("echostr") || "";
      
      // 验证签名（确保请求来自微信服务器）
      const isValid = verifySignature({
        token: mockAccount.token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature
      });

      if (!isValid) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("签名验证失败");
        return true;
      }

      // 解密 echostr 并返回（微信服务器会验证返回值）
      try {
        const decrypted = decryptMessage({
          encodingAESKey: mockAccount.encodingAESKey,
          receiveId: mockAccount.receiveId,
          encrypt: echostr
        });
        
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(decrypted);
        return true;
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("解密失败");
        return true;
      }
    }

    // ============================================
    // 4. 处理 POST 请求 - 用户消息
    // ============================================
    // 微信服务器会将用户发送的消息通过 POST 请求转发过来
    // 请求格式：POST /wechat-access?signature=xxx&timestamp=xxx&nonce=xxx
    // 请求体：加密的 JSON 或 XML 格式消息
    if (req.method === "POST") {
      // 读取请求体
      const body = await readBody(req);
      
      let message: FuwuhaoMessage;
      
      // ============================================
      // 4.1 解析和解密消息
      // ============================================
      // 尝试解析 JSON 格式
      try {
        const data = JSON.parse(body);
        const encrypt = data.encrypt || data.Encrypt || "";
        
        if (encrypt) {
          // ============================================
          // 加密消息处理流程
          // ============================================
          // 1. 验证签名（确保消息来自微信服务器）
          const isValid = verifySignature({
            token: mockAccount.token,
            timestamp,
            nonce,
            encrypt,
            signature
          });

          if (!isValid) {
            res.statusCode = 401;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("签名验证失败");
            return true;
          }

          // 2. 解密消息
          const decrypted = decryptMessage({
            encodingAESKey: mockAccount.encodingAESKey,
            receiveId: mockAccount.receiveId,
            encrypt
          });
          message = JSON.parse(decrypted);
        } else {
          // ============================================
          // 明文消息（用于测试）
          // ============================================
          // 直接使用 JSON 数据，无需解密
          message = data;
        }
      } catch {
        // ============================================
        // XML 格式处理（简化版）
        // ============================================
        // 可能是 XML 格式，简单处理
        console.log("[wechat-access] 收到非JSON格式数据，尝试简单解析");
        message = {
          msgtype: "text",
          Content: body,
          FromUserName: "unknown",
          MsgId: `${Date.now()}`
        };
      }

      // ============================================
      // 4.2 检查是否请求流式返回（SSE）
      // ============================================
      // 客户端可以通过以下方式请求流式返回：
      // 1. Accept: text/event-stream header
      // 2. ?stream=true 查询参数
      // 3. ?stream=1 查询参数
      const acceptHeader = req.headers.accept || "";
      const wantsStream = acceptHeader.includes("text/event-stream") || 
                          query.get("stream") === "true" ||
                          query.get("stream") === "1";
      console.log('adam-sssss-markoint===wantsStreamwantsStreamwantsStream', wantsStream)
      if (wantsStream) {
        // ============================================
        // 流式返回模式（Server-Sent Events）
        // ============================================
        // SSE 是一种服务器向客户端推送实时数据的技术
        // 适用于：实时显示 AI 生成过程、工具调用状态等
        console.log("[wechat-access] 使用流式返回模式 (SSE)");
        
        // 设置 SSE 响应头
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");  // SSE 标准格式
        res.setHeader("Cache-Control", "no-cache, no-transform");           // 禁用缓存
        res.setHeader("Connection", "keep-alive");                          // 保持连接
        res.setHeader("X-Accel-Buffering", "no");                           // 禁用 nginx 缓冲
        res.setHeader("Access-Control-Allow-Origin", "*");                  // 允许跨域
        res.flushHeaders(); // 立即发送 headers，建立 SSE 连接
        
        // 发送初始连接确认事件
        const connectedEvent = `data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`;
        console.log("[wechat-access] SSE 发送连接确认:", connectedEvent.trim());
        res.write(connectedEvent);
        
        try {
          // 调用流式消息处理器
          // handleMessageStream 会通过回调函数实时推送数据
          await handleMessageStream(message, (chunk) => {
            // SSE 数据格式：data: {JSON}\n\n
            const sseData = `data: ${JSON.stringify(chunk)}\n\n`;
            console.log("[wechat-access] SSE 发送数据:", chunk.type, chunk.text?.slice(0, 50));
            res.write(sseData);
            
            // 如果是完成或错误，关闭连接
            if (chunk.type === "done" || chunk.type === "error") {
              console.log("[wechat-access] SSE 连接关闭:", chunk.type);
              res.end();
            }
          });
        } catch (streamErr) {
          // 流式处理异常，发送错误事件
          console.error("[wechat-access] SSE 流式处理异常:", streamErr);
          const errorData = `data: ${JSON.stringify({ type: "error", text: String(streamErr), timestamp: Date.now() })}\n\n`;
          res.write(errorData);
          res.end();
        }
        
        return true;
      }

      // ============================================
      // 4.3 普通同步返回模式
      // ============================================
      // 等待 Agent 处理完成后一次性返回结果
      // 适用于：简单问答、不需要实时反馈的场景
      const reply = await handleMessage(message);

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ 
        success: true,
        reply: reply || "消息已接收，正在处理中..."
      }));
      return true;
    }

    return false;
  } catch (error) {
    // ============================================
    // 5. 异常处理
    // ============================================
    // 捕获所有未处理的异常，返回 500 错误
    console.error("[wechat-access] Webhook 处理异常:", error);
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("服务器内部错误");
    return true;
  }
};