import { createRouter, createWebHashHistory } from 'vue-router'
import InitLoadingView from '../views/InitLoadingView.vue'
import ChatView from '../views/ChatView.vue'

export function createRendererRouter() {
  return createRouter({
    history: createWebHashHistory(),
    routes: [
      {
        path: '/',
        redirect: '/init-loading',
      },
      {
        path: '/init-loading',
        name: 'InitLoading',
        component: InitLoadingView,
        meta: {
          title: 'Initializing - QClaw',
        },
      },
      {
        path: '/chat',
        name: 'Chat',
        component: ChatView,
        meta: {
          title: 'Chat - QClaw',
        },
      },
    ],
  })
}
