---
name: wecom-msg
description: 企业微信消息技能。提供会话列表查询、消息记录拉取和文本消息发送能力。当用户需要"查看消息"、"看聊天记录"、"发消息给某人"、"最近有什么消息"、"给群里发消息"时触发。
metadata:
  {
    "openclaw": { "emoji": "💬" },
  }
---

# 企业微信消息技能

> `wecom_mcp` 是一个 MCP tool，所有操作通过调用该 tool 完成。

> ⚠️ **前置条件**：首次调用 `wecom_mcp` 前，必须按 `wecom-preflight` 技能执行前置条件检查，确保工具已加入白名单。

通过 `wecom_mcp call msg <接口名> '<json入参>'` 与企业微信消息系统交互。

---

## 接口列表

### get_msg_chat_list — 获取会话列表

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_msg_chat_list '{"begin_time": "2026-03-11 00:00:00", "end_time": "2026-03-17 23:59:59"}'`

按时间范围查询有消息的会话列表，支持分页。参见 [API 详情](references/api-get-msg-chat-list.md)。

### get_messages — 拉取会话消息

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_messages '{"chat_type": 1, "chatid": "zhangsan", "begin_time": "2026-03-17 09:00:00", "end_time": "2026-03-17 18:00:00"}'`

根据会话类型和 ID 拉取指定时间范围内的消息记录，支持分页。仅支持 7 天内。参见 [API 详情](references/api-get-messages.md)。

### send_message — 发送文本消息

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg send_message '{"chat_type": 1, "chatid": "zhangsan", "msgtype": "text", "text": {"content": "hello world"}}'`

向单聊或群聊发送文本消息。参见 [API 详情](references/api-send-message.md)。

---

## 核心规则

### 时间范围规则
- **格式**：所有时间参数使用 `YYYY-MM-DD HH:mm:ss` 格式
- **默认范围**：用户未指定时，默认使用最近7天（当前时间往前推7天）
- **限制**：开始时间不能早于当前时间的7天前，不能晚于当前时间
- **相对时间支持**：支持"昨天"、"最近三天"等自动推算

### chatid查找规则
- 当用户提供人名或群名而非ID时：
  1. 调用 `get_msg_chat_list` 获取会话列表（时间范围与目标查询一致）
  2. 在 `chats` 中按 `chat_name` 匹配
  3. **匹配策略**：
     - 精确匹配唯一结果：直接使用
     - 模糊匹配多个结果：展示候选列表让用户选择
     - 无匹配结果：告知用户未找到
- **chat_type 判断**：`get_msg_chat_list` 返回中不含会话类型字段，需根据上下文推断：用户明确提到「群」时使用 `chat_type=2`，否则默认 `chat_type=1`（单聊）

### userid转username
**流程**：
1. 调用 `wecom-contact-lookup get_userlist` 获取用户列表
2. 建立userid到username的映射关系
3. **展示策略**：
   - 精确匹配：显示username
   - 无匹配：保持显示userid

---

## 典型工作流

### 查看会话列表
**用户query示例**：
- "看看我最近一周有哪些聊天"
- "这几天谁给我发过消息"

**执行流程**：
1. 确定时间范围（用户指定或默认最近7天）
2. 调用 `get_msg_chat_list` 获取会话列表
3. 展示会话名称、最后消息时间、消息数量
4. 若 `has_more` 为 `true`，告知用户还有更多会话可继续查看

### 查看聊天记录
**用户query示例**：
- "帮我看看和张三最近的聊天记录"
- "看看项目群里最近的消息"

**执行流程**：
1. 确定时间范围（用户指定或默认最近7天）
2. 通过 **chatid查找规则** 确定目标会话的 `chatid` 和 `chat_type`
3. 调用 `get_messages` 拉取消息列表
4. 调用 `wecom-contact-lookup` 的 `get_userlist` 获取通讯录，建立 userid→姓名 映射
5. 展示消息时将 `userid` 替换为可读姓名，格式：`姓名 [时间]: 内容`
6. 若 `next_cursor` 不为空，告知用户还有更多消息可继续查看

### 发送消息
**用户query示例**：
- "帮我给张三发一条消息：明天会议改到下午3点"
- "在项目群里发一条消息：今天下午3点开会"

**执行流程**：
1. 通过 **chatid查找规则** 确定目标会话的 `chatid` 和 `chat_type`
2. **发送前确认**：向用户确认发送对象和内容（如："即将向 张三 发送：'明天会议改到下午3点'，确认发送吗？"），用户确认后再执行
3. 调用 `send_message` 发送（`msgtype` 固定为 `text`）
4. 展示发送结果

### 查看消息并回复
**用户query示例**：
- "看看张三给我发了什么，然后帮我回复收到"

**执行流程**：
1. 先执行"查看聊天记录"流程（复用已获取的 `chatid` 和 `chat_type`）
2. 展示消息后，执行"发送消息"流程（需确认后再发送）

---

## 错误处理
- **时间范围超限**：告知用户7天限制并调整为有效范围
- **会话未找到**：明确告知用户未找到对应会话
- **API错误**：展示具体错误信息，必要时重试
- **网络问题**：HTTP错误时主动重试最多3次`