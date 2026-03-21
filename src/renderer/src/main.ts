import { createApp } from 'vue'
import App from './App.vue'
import { createRendererRouter } from './router'
import './styles/chat.css'
import './styles/init-loading.css'

const app = createApp(App)
const router = createRendererRouter()

const platform = window.electronAPI?.platform
if (platform === 'darwin') {
  document.body.classList.add('platform-mac')
} else if (platform === 'win32') {
  document.body.classList.add('platform-win')
} else if (platform === 'linux') {
  document.body.classList.add('platform-linux')
}

app.use(router)

app.config.errorHandler = (error, instance, info) => {
  const componentName =
    instance?.$options?.name ??
    instance?.$options?.__name ??
    'unknown'

  console.error('[Vue Error]', error, info)
  window.electronAPI?.reporter.report({
    name: 'renderer_vue_error',
    ext1: `[${componentName}][${info}] ${error.message ?? String(error)}`.slice(0, 256),
    ext2: (error.stack ?? '').slice(0, 1024),
  })
}

window.onerror = (message, source, line, column, error) => {
  window.electronAPI?.reporter.report({
    name: 'renderer_js_error',
    ext1: ((error?.message) ?? String(message)).slice(0, 256),
    ext2: ((error?.stack) ?? `${source ?? ''}:${line ?? 0}:${column ?? 0}`).slice(0, 1024),
  })
}

window.onunhandledrejection = (event) => {
  const reason = event.reason
  window.electronAPI?.reporter.report({
    name: 'renderer_unhandled_rejection',
    ext1: ((reason?.message) ?? String(event.reason)).slice(0, 256),
    ext2: ((reason?.stack) ?? '').slice(0, 1024),
  })
}

app.mount('#app')
