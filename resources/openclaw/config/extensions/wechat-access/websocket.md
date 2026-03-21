agentwsserver WebSocket 接口文档
目录
1.概述
2.连接
3.数据协议 (AGP Envelope)
4.下行消息 (服务端 → 客户端)
5.上行消息 (客户端 → 服务端)
6.通用数据结构
7.时序示意

概述
为独立 APP 提供 WebSocket 双向通信能力。
WebSocket 服务 — 运行于 :8080 端口，处理客户端的 WebSocket 长连接
数据协议 — 使用 AGP (Agent Gateway Protocol) 统一消息信封
消息传输 — 所有消息均为 WebSocket Text 帧，内容为 JSON

连接
地址
ws://21.0.62.97:8080/?token={token}
Query 参数
参数	类型	必填	说明
token	string	否	鉴权 token（当前未校验，后续启用）
连接行为
握手成功后服务端注册连接，同一 guid 的旧连接会被踢下线
空闲超时 5 分钟，超时无消息收发将断开
连接断开后服务端自动清理路由注册
错误场景
场景	行为
缺少 guid 或 user_id	握手拒绝，WebSocket 连接不会建立
URL 解析失败	握手拒绝

数据协议 (AGP Envelope)
Envelope 结构
所有 WebSocket 消息（上行和下行）均使用统一的 AGP 信封格式：
{
"msg_id":  "string",
"guid":    "string",
"user_id": "string",
"method":  "string",
"payload": {}
}
字段	类型	必填	说明
msg_id	string	是	全局唯一消息 ID（UUID），用于幂等去重
guid	string	是	设备 GUID
user_id	string	是	用户账户 ID
method	string	是	消息类型，见下方枚举
payload	object	是	消息载荷（JSON 对象，根据 method 类型而异）
Method 枚举
method	方向	说明
session.prompt	服务端 → 客户端	下发用户指令
session.cancel	服务端 → 客户端	取消 Prompt Turn
session.update	客户端 → 服务端	流式中间更新
session.promptResponse	客户端 → 服务端	最终结果

下行消息 (服务端 → 客户端)
session.prompt — 下发用户指令
{
"msg_id": "550e8400-e29b-41d4-a716-446655440000",
"guid": "device_001",
"user_id": "user_123",
"method": "session.prompt",
"payload": {
"session_id": "550e8400-e29b-41d4-a716-446655440000",
"prompt_id": "550e8400-e29b-41d4-a716-446655440001",
"agent_app": "openclaw",
"content": [
{ "type": "text", "text": "帮我查一下今天的天气" }
]
}
}
payload 字段：
字段	类型	必填	说明
session_id	string	是	所属 Session ID
prompt_id	string	是	本次 Turn 唯一 ID
agent_app	string	是	目标 AI 应用标识，客户端据此路由到本地 AI 应用
content	ContentBlock[]	是	用户指令内容（数组）
session.cancel — 取消 Prompt Turn
{
"msg_id": "550e8400-e29b-41d4-a716-446655440001",
"guid": "device_001",
"user_id": "user_123",
"method": "session.cancel",
"payload": {
"session_id": "550e8400-e29b-41d4-a716-446655440000",
"prompt_id": "550e8400-e29b-41d4-a716-446655440001",
"agent_app": "openclaw"
}
}
payload 字段：
字段	类型	必填	说明
session_id	string	是	所属 Session ID
prompt_id	string	是	要取消的 Turn ID
agent_app	string	是	目标 AI 应用标识

上行消息 (客户端 → 服务端)
session.update — 流式中间更新
客户端在处理 session.prompt 期间，通过此消息上报中间进度。可多次发送。
update_type 枚举
update_type	说明	使用字段
message_chunk	增量文本/内容（Agent 消息片段）	content
tool_call	AI 正在调用工具	tool_call
tool_call_update	工具执行状态变更	tool_call
payload 字段
字段	类型	必填	说明
session_id	string	是	所属 Session ID
prompt_id	string	是	所属 Turn ID
update_type	string	是	更新类型，取值见上方枚举
content	ContentBlock	条件	update_type=message_chunk 时使用，单个对象（非数组）
tool_call	ToolCall	条件	update_type=tool_call 或 tool_call_update 时使用
注意： content 字段为单个 ContentBlock 对象，不是数组。与 session.promptResponse 的 content 数组不同。
示例 — message_chunk（增量文本）
{
"msg_id": "550e8400-e29b-41d4-a716-446655440002",
"guid": "device_001",
"user_id": "user_123",
"method": "session.update",
"payload": {
"session_id": "550e8400-e29b-41d4-a716-446655440000",
"prompt_id": "550e8400-e29b-41d4-a716-446655440001",
"update_type": "message_chunk",
"content": {
"type": "text",
"text": "正在思考中...第一步是..."
}
}
}
示例 — tool_call（工具调用）
{
"msg_id": "550e8400-e29b-41d4-a716-446655440003",
"guid": "device_001",
"user_id": "user_123",
"method": "session.update",
"payload": {
"session_id": "550e8400-e29b-41d4-a716-446655440000",
"prompt_id": "550e8400-e29b-41d4-a716-446655440001",
"update_type": "tool_call",
"tool_call": {
"tool_call_id": "tc-001",
"title": "扫描临时文件",
"kind": "execute",
"status": "pending"
}
}
}
示例 — tool_call_update（工具状态更新）
{
"msg_id": "550e8400-e29b-41d4-a716-446655440004",
"guid": "device_001",
"user_id": "user_123",
"method": "session.update",
"payload": {
"session_id": "550e8400-e29b-41d4-a716-446655440000",
"prompt_id": "550e8400-e29b-41d4-a716-446655440001",
"update_type": "tool_call_update",
"tool_call": {
"tool_call_id": "tc-001",
"status": "completed",
"content": [{ "type": "text", "text": "发现临时文件 2.3GB" }]
}
}
}

session.promptResponse — 最终结果
客户端完成 session.prompt 处理后，上报最终结果。每个 prompt_id 只接受一次最终响应，重复的 msg_id 会被去重。
{
"msg_id": "550e8400-e29b-41d4-a716-446655440005",
"guid": "device_001",
"user_id": "user_123",
"method": "session.promptResponse",
"payload": {
"session_id": "550e8400-e29b-41d4-a716-446655440000",
"prompt_id": "550e8400-e29b-41d4-a716-446655440001",
"stop_reason": "end_turn",
"content": [
{ "type": "text", "text": "今天北京晴，气温 15°C" }
]
}
}
payload 字段：
字段	类型	必填	说明
session_id	string	是	所属 Session ID
prompt_id	string	是	所属 Turn ID
stop_reason	string	是	停止原因
content	ContentBlock[]	否	最终结果内容（数组）
error	string	否	错误描述（stop_reason 为 error / refusal 时附带）
stop_reason 枚举：
值	说明
end_turn	正常完成
cancelled	被取消
refusal	AI 应用拒绝执行
error	技术错误
错误响应示例
{
"msg_id": "550e8400-e29b-41d4-a716-446655440006",
"guid": "device_001",
"user_id": "user_123",
"method": "session.promptResponse",
"payload": {
"session_id": "550e8400-e29b-41d4-a716-446655440000",
"prompt_id": "550e8400-e29b-41d4-a716-446655440001",
"stop_reason": "error",
"error": "AI 应用执行超时"
}
}

通用数据结构
ContentBlock — 内容块
{
"type": "text",
"text": "文本内容"
}
字段	类型	必填	说明
type	string	是	内容类型，当前仅支持 "text"
text	string	是	type=text 时必填
ToolCall — 工具调用
{
"tool_call_id": "tc-001",
"title": "扫描临时文件",
"kind": "execute",
"status": "in_progress",
"content": [{ "type": "text", "text": "发现临时文件 2.3GB" }],
"locations": [{ "path": "/tmp" }]
}
字段	类型	必填	说明
tool_call_id	string	是	工具调用唯一 ID
title	string	否	工具调用标题（展示用）
kind	string	否	工具类型
status	string	是	工具调用状态
content	ContentBlock[]	否	工具调用结果内容
locations	Location[]	否	工具操作路径
kind 枚举：
值	说明
read	读取
edit	编辑
delete	删除
execute	执行
search	搜索
fetch	获取
think	思考
other	其他
status 枚举：
值	说明
pending	等待中
in_progress	执行中
completed	已完成
failed	失败
Location — 路径
{ "path": "/tmp" }
字段	类型	说明
path	string	操作路径

时序示意
正常流程
客户端 (APP)                         服务端
|                                  |
|--- WS 握手 (guid/user_id) ----->|
|<-- 101 Switching Protocols -----|  连接建立
|                                  |
|<-- session.prompt (WS Text) ----|  下发指令
|                                  |
|--- session.update (WS Text) --->|  流式上报（可多次）
|--- session.update (WS Text) --->|
|                                  |
|--- promptResponse (WS Text) --->|  最终结果
|                                  |
|--- 断开 / 超时 ---------------->|  连接清理
取消流程
客户端 (APP)                         服务端
|                                  |
|  (正在处理 session.prompt)       |
|<-- session.cancel (WS Text) ----|  服务端取消
|                                  |
|--- promptResponse (WS Text) --->|  stop_reason: "cancelled"