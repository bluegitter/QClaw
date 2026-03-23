import { getWecomRuntime } from "./runtime.js";

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

/** onAgentEvent 的 listener 签名 */
type AgentEventListener = (evt: AgentEventPayload) => void;

/**
 * 注册 Agent 事件监听器。
 *
 * 通过 PluginRuntime.events.onAgentEvent 获取全局事件总线的订阅函数。
 * 这是框架推荐的路径，确保事件监听器能正确挂载到全局 listeners Set。
 *
 * 注意：openclaw/plugin-sdk 的 index.js 并未重新导出 onAgentEvent，
 * 之前使用 import("openclaw/plugin-sdk").onAgentEvent 的方式获取到的始终是 undefined，
 * 导致监听器从未真正注册，所有 lifecycle/assistant/tool 事件全部丢失。
 *
 * 现在改为从 PluginRuntime.events.onAgentEvent 获取，这是框架内部使用的同一个
 * 全局 Set-based 发布/订阅实例，能正确接收所有 Agent 事件。
 */
export const onAgentEvent = (
  listener: AgentEventListener
): () => boolean => {
  const runtime = getWecomRuntime();
  const fn = (runtime as any).events?.onAgentEvent;
  if (typeof fn === "function") {
    const unsubscribe = fn(listener);
    return unsubscribe;
  }
  console.warn(
    "[wechat-access] onAgentEvent 不可用: runtime.events.onAgentEvent 未找到"
  );
  return () => false;
};