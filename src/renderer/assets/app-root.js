import {
  d as defineComponent,
  o as onMounted,
  a as onUnmounted,
  c as createElementBlock,
  b as createVNode,
  e as createBlock,
  u as unref,
  f as createCommentVNode,
  g as defineAsyncComponent,
  r as ref,
  h as resolveComponent,
  i as openBlock,
} from "./vendor-vue.js"
import { vitePreload } from "./app-runtime.js"

const PROCESS_DASHBOARD_DEPS = [
  "./process-dashboard.js",
  "./vendor-vue.js",
  "./process-dashboard.css",
]

const APP_ROOT_PROPS = { id: "app-root" }

const AppComponent = defineComponent({
  __name: "App",
  setup() {
    const DebugPanel = defineAsyncComponent(() =>
      vitePreload(() => import("./process-dashboard.js"), PROCESS_DASHBOARD_DEPS, import.meta.url),
    )
    const isDebugPanelVisible = ref(false)
    let removeTogglePanelListener = null

    onMounted(() => {
      removeTogglePanelListener =
        window.electronAPI?.debug?.onTogglePanel(() => {
          isDebugPanelVisible.value = !isDebugPanelVisible.value
        }) ?? null
    })

    onUnmounted(() => {
      removeTogglePanelListener?.()
    })

    return () => {
      const RouterView = resolveComponent("router-view")
      return openBlock(), createElementBlock("div", APP_ROOT_PROPS, [
        createVNode(RouterView),
        isDebugPanelVisible.value
          ? (openBlock(), createBlock(unref(DebugPanel), { key: 0 }))
          : createCommentVNode("", true),
      ])
    }
  },
})

function attachScopeId(component, scopeEntries) {
  const target = component.__vccOpts || component
  for (const [key, value] of scopeEntries) {
    target[key] = value
  }
  return target
}

const AppRoot = attachScopeId(AppComponent, [["__scopeId", "data-v-00d0433c"]])

export default AppRoot
