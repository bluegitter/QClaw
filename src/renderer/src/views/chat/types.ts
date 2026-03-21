export interface ToolCard {
  kind: 'call' | 'result'
  name: string
  args?: Record<string, any>
  detail?: string
  text?: string
  completed?: boolean
}

export interface ChatMessage {
  id: string
  role: 'assistant' | 'user' | 'tool' | 'system'
  text: string
  title?: string
  toolCards?: ToolCard[]
  isStreaming?: boolean
}

export interface ChatSessionItem {
  key: string
  label?: string
  updatedAt?: number
}

export interface LoginUserInfo {
  nickname?: string
  avatar?: string
  guid?: string
  userId?: string | number
  [key: string]: any
}

export interface RemoteUserInfo {
  nickname?: string
  avatar?: string
  external_user_id?: string
}
