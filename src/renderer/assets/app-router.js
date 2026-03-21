import { j as createRouter, k as createWebHashHistory } from "./vendor-vue.js"
import { vitePreload } from "./app-runtime.js"

const WX_LOGIN_DEPS = [
  "./wx-login-view.js",
  "./vendor-vue.js",
  "./platform.js",
  "./invite-code-modal.js",
  "./invite-code-modal.css",
  "./wx-login-view.css",
]

const CHAT_DEPS = [
  "./chat-view.js",
  "./platform.js",
  "./vendor-vue.js",
  "./invite-code-modal.js",
  "./invite-code-modal.css",
  "./shared-runtime.js",
  "./chat-view.css",
]

const CHAT_PAGE_DEPS = [
  "./chat-page-view.js",
  "./vendor-vue.js",
  "./chat-page.css",
]

const INIT_LOADING_DEPS = [
  "./init-loading-view.js",
  "./platform.js",
  "./vendor-vue.js",
  "./shared-runtime.js",
  "./init-loading-view.css",
]

const routes = [
  { path: "/", redirect: "/init-loading" },
  {
    path: "/wx-login",
    name: "WXLogin",
    component: () =>
      vitePreload(() => import("./wx-login-view.js"), WX_LOGIN_DEPS, import.meta.url),
    meta: { title: "微信登录 - QClaw" },
  },
  {
    path: "/init-loading",
    name: "InitLoading",
    component: () =>
      vitePreload(() => import("./init-loading-view.js"), INIT_LOADING_DEPS, import.meta.url),
    meta: { title: "初始化中 - QClaw" },
  },
  {
    path: "/chat",
    name: "Chat",
    component: () =>
      vitePreload(() => import("./chat-view.js"), CHAT_DEPS, import.meta.url),
    meta: { title: "AI 助手 - QClaw" },
  },
  {
    path: "/chat",
    name: "Chat",
    component: () =>
      vitePreload(() => import("./chat-page-view.js"), CHAT_PAGE_DEPS, import.meta.url),
    meta: { title: "Chat - QClaw" },
  },
]

export function createAppRouter() {
  return createRouter({
    history: createWebHashHistory(),
    routes,
  })
}
