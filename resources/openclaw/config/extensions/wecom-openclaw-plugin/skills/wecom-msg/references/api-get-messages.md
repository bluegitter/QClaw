# get_messages API

根据会话类型和会话 ID，拉取指定时间范围内的消息记录。目前仅支持文本类型消息。

## 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `chat_type` | integer | ✅ | 会话类型，`1`-单聊，`2`-群聊 |
| `chatid` | string | ✅ | 会话 ID，单聊时为 userid，群聊时为群 ID，最大 256 字节 |
| `begin_time` | string | ✅ | 拉取开始时间，格式：`YYYY-MM-DD HH:mm:ss`，仅支持请求时刻往前 **7 天**内 |
| `end_time` | string | ✅ | 拉取结束时间，格式：`YYYY-MM-DD HH:mm:ss`，必须 ≥ `begin_time` |
| `cursor` | string | ❌ | 分页游标，首次请求不传，后续传入上次响应的 `next_cursor`，最大 256 字节 |

## 请求示例

单聊：

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_messages '{"chat_type": 1, "chatid": "zhangsan", "begin_time": "2026-03-17 09:00:00", "end_time": "2026-03-17 18:00:00"}'`

群聊：

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_messages '{"chat_type": 2, "chatid": "wrxxxxxxxx", "begin_time": "2026-03-17 09:00:00", "end_time": "2026-03-17 18:00:00"}'`

分页请求：

使用 `wecom_mcp` tool 调用 `wecom_mcp call msg get_messages '{"chat_type": 1, "chatid": "zhangsan", "begin_time": "2026-03-17 09:00:00", "end_time": "2026-03-17 18:00:00", "cursor": "CURSOR_xxxxxx"}'`

## 返回字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | integer | 返回码，`0` 表示成功 |
| `errmsg` | string | 错误信息 |
| `messages` | array | 消息列表 |
| `messages[].userid` | string | 消息发送者的 userid |
| `messages[].send_time` | string | 发送时间，格式：`YYYY-MM-DD HH:mm:ss` |
| `messages[].msgtype` | string | 消息类型，目前仅支持 `text` |
| `messages[].text.content` | string | 消息内容 |
| `next_cursor` | string | 分页游标，为空表示已拉取完毕 |

## 响应示例

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "messages": [
        {
            "userid": "zhangsan",
            "send_time": "2026-03-17 09:30:00",
            "msgtype": "text",
            "text": {
                "content": "你好"
            }
        },
        {
            "userid": "lisi",
            "send_time": "2026-03-17 09:35:00",
            "msgtype": "text",
            "text": {
                "content": "你好，有什么可以帮助你的？"
            }
        }
    ],
    "next_cursor": "CURSOR_xxxxxx"
}
```
