const CHAT_FEATURE_PROMPTS = {
  weather:
    "使用 weather skill 获取「深圳南山区」的当日天气，包括天气状况、气温，并给出穿衣、出行建议，使用imap-smtp-email每天「早上8点」发送邮件提醒我，后续所有定时任务都通过邮件发给我。",
  remote:
    "帮我找的「桌面的word文档」，「重新润色内容」后，把文件用imap-smtp-email技能发邮件给我，后续相关的文件发送都通过邮件发给我。",
  phone:
    "帮我在隔离出来的浏览器里打开网站「https://claw.guanjia.qq.com/#」，截个图，使用imap-smtp-email技能发邮件给我",
  social:
    "实现「具体平台」的自动运营：用隔离出来的浏览器发布「AI效率工具使用技巧」笔记，在同领域热门帖评论互动引流；完成后将「发布结果、互动内容」整理成结论返回给我。（通过 find-skill 查找并调用对应的 MCP Server 能力完成全流程。如有登录问题，打开网页让我扫码登录）",
  github:
    "你是我的 GitHub 助手。请以「AI 智能清理重复照片」为创意，用隔离出来的浏览器全自动完成以下所有步骤（不要中途让我手动操作）：自动登录、创建 GitHub 仓库、生成代码、推送并提交 PR，最后把简报通过邮箱发给我",
}

export function getChatFeaturePrompt(featureKey) {
  return CHAT_FEATURE_PROMPTS[featureKey] || ""
}
