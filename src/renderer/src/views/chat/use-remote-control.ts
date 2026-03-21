import { computed, ref, type ComputedRef } from 'vue'
import {
  o as openclawApiService,
  aB as getStorageItem,
  r as removeStorageItem,
  s as setStorageItem,
} from '../../../assets/platform.js'
import type { LoginUserInfo, RemoteUserInfo } from './types'

const REMOTE_CONTROL_ENABLED_KEY = 'openclaw_remote_control_enabled'
const REMOTE_CONNECTED_USER_KEY = 'openclaw_connected_user'
const REMOTE_CONNECTION_GUID_KEY = 'openclaw_connection_guid'
const REMOTE_POLL_INTERVAL_MS = 2000
const REMOTE_CONNECT_TIMEOUT_MS = 300000

export function useRemoteControl(loginUser: ComputedRef<LoginUserInfo | null>) {
  const showRemoteModal = ref(false)
  const remoteModalState = ref<'disconnected' | 'connecting' | 'connected' | 'failed'>('disconnected')
  const remoteUserInfo = ref<RemoteUserInfo | null>(null)
  const remoteQrImageUrl = ref('')
  const remoteConnectionGuid = ref('')
  const remoteErrorMessage = ref('')
  const remoteCountdownSeconds = ref(0)
  const isRemoteConnected = computed(() => !!remoteUserInfo.value)

  let remotePollTimer: number | null = null
  let remoteTimeoutTimer: number | null = null
  let remoteCountdownTimer: number | null = null

  function clearRemoteTimers() {
    if (remotePollTimer !== null) {
      window.clearInterval(remotePollTimer)
      remotePollTimer = null
    }

    if (remoteTimeoutTimer !== null) {
      window.clearTimeout(remoteTimeoutTimer)
      remoteTimeoutTimer = null
    }

    if (remoteCountdownTimer !== null) {
      window.clearInterval(remoteCountdownTimer)
      remoteCountdownTimer = null
    }
  }

  function clearRemoteStoredState() {
    removeStorageItem(REMOTE_CONNECTED_USER_KEY)
    removeStorageItem(REMOTE_CONNECTION_GUID_KEY)
    removeStorageItem(REMOTE_CONTROL_ENABLED_KEY)
  }

  function persistRemoteConnectedState() {
    setStorageItem(REMOTE_CONTROL_ENABLED_KEY, true)
    if (remoteUserInfo.value) {
      setStorageItem(REMOTE_CONNECTED_USER_KEY, remoteUserInfo.value)
    }
    if (remoteConnectionGuid.value) {
      setStorageItem(REMOTE_CONNECTION_GUID_KEY, remoteConnectionGuid.value)
    }
  }

  function resetRemoteModalState() {
    clearRemoteTimers()
    remoteModalState.value = 'disconnected'
    remoteQrImageUrl.value = ''
    remoteErrorMessage.value = ''
    remoteCountdownSeconds.value = 0
  }

  function closeRemoteControlModal() {
    showRemoteModal.value = false
    clearRemoteTimers()
  }

  function buildRemoteQrImageUrl(url: string) {
    return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(url)}`
  }

  async function startRemoteConnect() {
    resetRemoteModalState()
    showRemoteModal.value = true

    try {
      remoteConnectionGuid.value = await openclawApiService.getGuid()
      const userId = loginUser.value?.userId || openclawApiService.getUserId()
      const response = await openclawApiService.generateContactLink({
        guid: remoteConnectionGuid.value,
        user_id: userId,
        open_id: 'wkzLlJLAAAfbxEV3ZcS-lHZxkaKmpejQ',
        contact_type: 'open_kfid',
      })

      const url = response?.data?.resp?.url ?? response?.data?.url ?? response?.data?.resp?.data?.url ?? ''
      if (!response.success || !url) {
        throw new Error(response.message || '获取连接链接失败')
      }

      remoteQrImageUrl.value = buildRemoteQrImageUrl(url)
      remoteModalState.value = 'connecting'
      remoteCountdownSeconds.value = Math.floor(REMOTE_CONNECT_TIMEOUT_MS / 1000)

      remoteCountdownTimer = window.setInterval(() => {
        remoteCountdownSeconds.value -= 1
        if (remoteCountdownSeconds.value <= 0) {
          clearRemoteTimers()
        }
      }, 1000)

      remoteTimeoutTimer = window.setTimeout(() => {
        clearRemoteTimers()
        remoteModalState.value = 'failed'
        remoteErrorMessage.value = '连接超时，请重试'
      }, REMOTE_CONNECT_TIMEOUT_MS)

      remotePollTimer = window.setInterval(async () => {
        try {
          const queryResult = await openclawApiService.queryDeviceByGuid({
            guid: remoteConnectionGuid.value,
          })
          const data = queryResult?.data?.resp?.data ?? queryResult?.data?.data ?? queryResult?.data?.resp

          if (queryResult.success && data?.nickname) {
            clearRemoteTimers()
            remoteUserInfo.value = {
              nickname: data.nickname,
              avatar: data.avatar,
              external_user_id: data.external_user_id,
            }
            remoteModalState.value = 'connected'
            persistRemoteConnectedState()
          }
        } catch (error) {
          console.error('[Chat] 轮询微信远程连接状态失败:', error)
        }
      }, REMOTE_POLL_INTERVAL_MS)
    } catch (error) {
      console.error('[Chat] 开始微信远程连接失败:', error)
      remoteModalState.value = 'failed'
      remoteErrorMessage.value = error instanceof Error ? error.message : '连接失败，请重试'
    }
  }

  function confirmRemoteConnected() {
    persistRemoteConnectedState()
    closeRemoteControlModal()
  }

  async function disconnectRemoteControl() {
    try {
      const guid =
        remoteConnectionGuid.value ||
        String(getStorageItem(REMOTE_CONNECTION_GUID_KEY) || '')

      if (guid) {
        const response = await openclawApiService.disconnectDevice({ guid })
        if (!response.success) {
          return
        }
      }
    } catch (error) {
      console.error('[Chat] 断开微信远程连接失败:', error)
    } finally {
      clearRemoteTimers()
      remoteUserInfo.value = null
      remoteConnectionGuid.value = ''
      closeRemoteControlModal()
      clearRemoteStoredState()
    }
  }

  async function validateRemoteConnectionState() {
    const storedGuid = String(getStorageItem(REMOTE_CONNECTION_GUID_KEY) || '')
    const storedUser = getStorageItem(REMOTE_CONNECTED_USER_KEY) as RemoteUserInfo | null

    if (storedUser) {
      remoteUserInfo.value = storedUser
    }
    if (storedGuid) {
      remoteConnectionGuid.value = storedGuid
    }

    if (!storedGuid) {
      return
    }

    try {
      const response = await openclawApiService.queryDeviceByGuid({ guid: storedGuid })
      const data = response?.data?.resp?.data ?? response?.data?.data ?? response?.data?.resp

      if (response.success && data?.nickname) {
        remoteUserInfo.value = {
          nickname: data.nickname,
          avatar: data.avatar,
          external_user_id: data.external_user_id,
        }
        persistRemoteConnectedState()
        return
      }
    } catch (error) {
      console.warn('[Chat] 校验微信远程连接状态失败:', error)
    }

    remoteUserInfo.value = null
    remoteConnectionGuid.value = ''
    clearRemoteStoredState()
  }

  function restartRemoteConnect() {
    void startRemoteConnect()
  }

  function resetRemoteControlState() {
    clearRemoteTimers()
    remoteUserInfo.value = null
    remoteConnectionGuid.value = ''
    clearRemoteStoredState()
    closeRemoteControlModal()
  }

  return {
    showRemoteModal,
    remoteModalState,
    remoteUserInfo,
    remoteQrImageUrl,
    remoteConnectionGuid,
    remoteErrorMessage,
    remoteCountdownSeconds,
    isRemoteConnected,
    startRemoteConnect,
    closeRemoteControlModal,
    confirmRemoteConnected,
    disconnectRemoteControl,
    validateRemoteConnectionState,
    restartRemoteConnect,
    resetRemoteControlState,
    clearRemoteTimers,
  }
}
