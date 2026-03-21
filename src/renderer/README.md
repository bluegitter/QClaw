# Renderer Recovery Layout

The original renderer source code is not available in this repository.

This directory now contains two layers:

- `src/renderer/src/*`: the new standard Vue renderer source tree
- `src/renderer/assets/*`: recovered renderer/runtime assets kept as reference and compatibility aliases

The recovered asset layer keeps stable entry names:

- `index.html`: renderer entry page
- `assets/app.js`: renderer bootstrap
- `assets/app-runtime.js`: preload/polyfill helpers
- `assets/app-root.js`: root app component
- `assets/app-router.js`: recovered route table
- `assets/app.css`: global renderer styles
- `assets/chat-model-config.js`: chat model provider constants and labels
- `assets/chat-model-state.js`: chat model config loading helpers
- `assets/chat-model-modal-state.js`: model setting modal initialization helpers
- `assets/chat-model-modal-runtime.js`: model setting modal runtime helpers
- `assets/chat-model-modal-submit.js`: model setting modal validation and submit helpers
- `assets/chat-feature-prompts.js`: chat home feature prompt presets
- `assets/chat-session-list.js`: chat session list loading and auto-label helpers
- `assets/chat-send-flow.js`: chat send, abort, and scroll helpers
- `assets/chat-history-state.js`: chat history normalization and tool-card helpers
- `assets/chat-channel-events.js`: channel session switch and event routing helpers
- `assets/chat-stream-events.js`: stream event, security-block, and finalization helpers
- `assets/chat-session-utils.js`: session key, label, and channel utility helpers
- `assets/chat-session-flow.js`: session abort, create, switch, and confirmation flow helpers
- `assets/chat-session-panel.js`: sidebar toggle and session panel refresh helpers
- `assets/chat-config-sync.js`: bootstrap token refresh and openclaw config sync helpers
- `assets/chat-page-view.js`: compatibility alias to the new Vue chat page view
- `assets/chat-page.css`: compatibility alias to the new Vue chat stylesheet
- `assets/vendor-vue.js`: bundled Vue ecosystem runtime
- `assets/platform.js`: platform utilities and Electron-facing runtime helpers
- `assets/shared-runtime.js`: shared runtime helpers used by recovered pages
- `assets/auth-report-runtime.js`: auth state and reporting helpers recovered from legacy runtime chunk
- `assets/wx-login-view.js`: login page
- `assets/init-loading-view.js`: initialization page
- `assets/chat-view.js`: chat page
- `assets/process-dashboard.js`: debug/process panel
- `assets/invite-code-modal.js`: invite modal

The original hashed files are kept only as compatibility aliases.
New work should target the stable filenames above.

For the chat page specifically:

- `assets/chat-view.js` is the canonical implementation
- `assets/Chat-B6WG69P8.js` only re-exports `chat-view.js`
- `assets/Chat-CPdLMWaq.css` only re-exports `chat-view.css`

For the standard Vue renderer specifically:

- `src/main.ts`: canonical renderer entry
- `src/App.vue`: canonical root component
- `src/router/index.ts`: canonical router source
- `src/views/ChatView.vue`: canonical chat page
- `src/styles/chat.css`: canonical chat stylesheet

For the recovered renderer entry specifically:

- `assets/app.js` is the canonical recovered entry implementation
- `assets/index-BWb3Oa1T.js` only re-exports and runs `app.js`
- `assets/app.css` is the canonical recovered entry stylesheet
- `assets/index-CG9QQGJt.css` only re-exports `app.css`

For platform/runtime compatibility specifically:

- `assets/platform.js` is the canonical implementation
- `assets/platform-QEsQ5tXh.js` only re-exports `platform.js`
- `assets/auth-report-runtime.js` is the canonical implementation for auth/report helpers
- `assets/index-DNfvYBnh.js` only re-exports `auth-report-runtime.js`

For the WX login page specifically:

- `assets/wx-login-view.js` is the canonical implementation
- `assets/WXLoginView-Dzks_Y2M.js` only re-exports `wx-login-view.js`
- `assets/WXLoginView-Ckjoxzm9.css` only re-exports `wx-login-view.css`

For the init loading page specifically:

- `assets/init-loading-view.js` is the canonical implementation
- `assets/InitLoading-BqvDFdMB.js` only re-exports `init-loading-view.js`
- `assets/InitLoading-BtHhc3BA.css` only re-exports `init-loading-view.css`

For the invite code modal specifically:

- `assets/invite-code-modal.js` is the canonical implementation
- `assets/InviteCodeModal-C4xV5iKW.js` only re-exports `invite-code-modal.js`
- `assets/invite-code-modal.css` is the canonical stylesheet
- `assets/InviteCodeModal-CE7j6XTP.css` only re-exports `invite-code-modal.css`

For the process dashboard specifically:

- `assets/process-dashboard.js` is the canonical implementation
- `assets/ProcessDashboard-BJBMU9P5.js` only re-exports `process-dashboard.js`
- `assets/process-dashboard.css` is the canonical stylesheet
- `assets/ProcessDashboard-DwpcwrzL.css` only re-exports `process-dashboard.css`
