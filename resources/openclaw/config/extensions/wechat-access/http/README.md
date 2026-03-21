# Fuwuhao (微信服务号) 模块

## 📁 文件结构

```
src/
├── types.ts              # 类型定义
├── crypto-utils.ts       # 加密解密工具
├── http-utils.ts         # HTTP 请求处理工具
├── callback-service.ts   # 后置回调服务
├── message-context.ts    # 消息上下文构建
├── message-handler.ts    # 消息处理器（核心业务逻辑）
├── webhook.ts            # Webhook 处理器（主入口）
├── runtime.ts            # Runtime 配置
└── index.ts              # 模块导出索引
```

## 📦 模块说明

### 1. `types.ts` - 类型定义
定义所有 TypeScript 类型和接口：
- `AgentEventPayload` - Agent 事件载荷
- `FuwuhaoMessage` - 服务号消息格式
- `SimpleAccount` - 账号配置
- `CallbackPayload` - 回调数据格式
- `StreamChunk` - 流式消息块
- `StreamCallback` - 流式回调函数类型

### 2. `crypto-utils.ts` - 加密解密工具
处理微信服务号的签名验证和消息加密解密：
- `verifySignature()` - 验证签名
- `decryptMessage()` - 解密消息

### 3. `http-utils.ts` - HTTP 工具
处理 HTTP 请求相关的工具方法：
- `parseQuery()` - 解析查询参数
- `readBody()` - 读取请求体
- `isFuwuhaoWebhookPath()` - 检查是否是服务号 webhook 路径

### 4. `callback-service.ts` - 后置回调服务
将处理结果发送到外部回调服务：
- `sendToCallbackService()` - 发送回调数据

### 5. `message-context.ts` - 消息上下文构建
构建消息处理所需的上下文信息：
- `buildMessageContext()` - 构建消息上下文（路由、会话、格式化等）

### 6. `message-handler.ts` - 消息处理器
核心业务逻辑，处理消息并调用 Agent：
- `handleMessage()` - 同步处理消息
- `handleMessageStream()` - 流式处理消息（SSE）

### 7. `webhook.ts` - Webhook 处理器
主入口，处理微信服务号的 webhook 请求：
- `handleSimpleWecomWebhook()` - 处理 GET/POST 请求，支持同步和流式返回

### 8. `runtime.ts` - Runtime 配置
获取 OpenClaw 运行时实例

### 9. `index.ts` - 模块导出
统一导出所有公共 API

## 🔄 数据流

```
微信服务号
    ↓
webhook.ts (入口)
    ↓
http-utils.ts (解析请求)
    ↓
crypto-utils.ts (验证签名/解密)
    ↓
message-context.ts (构建上下文)
    ↓
message-handler.ts (处理消息)
    ↓
OpenClaw Agent (AI 处理)
    ↓
callback-service.ts (后置回调)
    ↓
返回响应
```

## 🚀 使用示例

### 基本使用
```typescript
import { handleSimpleWecomWebhook } from "./src/webhook.js";

// 在 HTTP 服务器中使用
server.on("request", async (req, res) => {
  const handled = await handleSimpleWecomWebhook(req, res);
  if (!handled) {
    // 处理其他路由
  }
});
```

### 流式返回（SSE）
```typescript
// 客户端请求时添加 stream 参数
fetch("/fuwuhao?stream=true", {
  headers: {
    "Accept": "text/event-stream"
  }
});
```

## 🔧 配置

### 环境变量
- `FUWUHAO_CALLBACK_URL` - 后置回调服务 URL（默认：`http://localhost:3001/api/fuwuhao/callback`）

### 账号配置
在 `webhook.ts` 中修改 `mockAccount` 对象：
```typescript
const mockAccount: SimpleAccount = {
  token: "your_token_here",
  encodingAESKey: "your_encoding_aes_key_here", 
  receiveId: "your_receive_id_here"
};
```

## 📝 注意事项

1. **加密解密**：当前 `crypto-utils.ts` 中的加密解密方法是简化版，生产环境需要实现真实的加密逻辑
2. **签名验证**：同样需要在生产环境中实现真实的签名验证算法
3. **错误处理**：所有模块都包含完善的错误处理和日志记录
4. **类型安全**：所有模块都使用 TypeScript 严格类型检查

## 🎯 设计原则

- **单一职责**：每个文件只负责一个特定功能
- **低耦合**：模块之间通过明确的接口通信
- **高内聚**：相关功能集中在同一模块
- **可测试**：每个模块都可以独立测试
- **可扩展**：易于添加新功能或修改现有功能
