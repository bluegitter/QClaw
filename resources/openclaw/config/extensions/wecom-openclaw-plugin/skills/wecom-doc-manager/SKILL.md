---
name: wecom-doc-manager
description: 企业微信文档管理技能。提供文档的创建、读取和编辑能力，支持通过 docid 或文档 URL 操作企业微信文档（doc_type=3）和智能表格（doc_type=10）。适用场景：(1) 以 Markdown 格式导出获取文档完整内容（异步轮询） (2) 新建文档或智能表格 (3) 用 Markdown 格式覆写文档内容。当用户需要查看文档内容、创建新文档、编辑文档正文时触发此 Skill。
---

# 企业微信文档管理

> `wecom_mcp` 是一个 MCP tool，所有操作通过调用该 tool 完成。

> ⚠️ **前置条件**：首次调用 `wecom_mcp` 前，必须按 `wecom-preflight` 技能执行前置条件检查，确保工具已加入白名单。

管理企业微信文档的创建、读取和编辑。所有接口支持通过 `docid` 或 `url` 二选一定位文档。

## 调用方式

通过 `wecom_mcp` tool 调用，品类为 `doc`：

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc <tool_name> '<json_params>'` 调用指定技能

## 返回格式说明

所有接口返回 JSON 对象，包含以下公共字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `errcode` | integer | 返回码，`0` 表示成功，非 `0` 表示失败 |
| `errmsg` | string | 错误信息，成功时为 `"ok"` |

当 `errcode` 不为 `0` 时，说明接口调用失败，可重试 1 次；若仍失败，将 `errcode` 和 `errmsg` 展示给用户。

### get_doc_content

获取文档完整内容数据，只能以 Markdown 格式返回。采用**异步轮询机制**：首次调用无需传 `task_id`，接口返回 `task_id`；若 `task_done` 为 false，需携带该 `task_id` 再次调用，直到 `task_done` 为 true 时返回完整内容。

- 首次调用（不传 task_id）：使用 `wecom_mcp` tool 调用 `wecom_mcp call doc get_doc_content '{"docid": "DOCID", "type": 2}'`
- 轮询（携带上次返回的 task_id）：使用 `wecom_mcp` tool 调用 `wecom_mcp call doc get_doc_content '{"docid": "DOCID", "type": 2, "task_id": "xxx"}'`
- 或通过 URL：使用 `wecom_mcp` tool 调用 `wecom_mcp call doc get_doc_content '{"url": "https://doc.weixin.qq.com/doc/xxx", "type": 2}'`

参见 [API 详情](references/api-export-document.md)。

### create_doc

新建文档（doc_type=3）或智能表格（doc_type=10）。创建成功返回 url 和 docid。

- 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc create_doc '{"doc_type": 3, "doc_name": "项目周报"}'`
- 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc create_doc '{"doc_type": 10, "doc_name": "任务跟踪表"}'`

**注意**：docid 仅在创建时返回，需妥善保存。创建智能表格时默认包含一个子表，可通过 `smartsheet_get_sheet` 查询其 sheet_id。

参见 [API 详情](references/api-create-doc.md)。

### edit_doc_content

用 Markdown 内容覆写文档正文。`content_type` 固定为 `1`（Markdown）。

使用 `wecom_mcp` tool 调用 `wecom_mcp call doc edit_doc_content '{"docid": "DOCID", "content": "# 标题\n\n正文内容", "content_type": 1}'`

参见 [API 详情](references/api-edit-doc-content.md)。

## 典型工作流

1. **读取文档** → 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc get_doc_content '{"docid": "DOCID", "type": 2}'`，若 `task_done` 为 false 则携带 `task_id` 继续轮询
2. **创建新文档** → 使用 `wecom_mcp` tool 调用 `wecom_mcp call doc create_doc '{"doc_type": 3, "doc_name": "文档名"}'`，保存返回的 docid
3. **编辑文档** → 先 get_doc_content 了解当前内容，再 edit_doc_content 覆写
