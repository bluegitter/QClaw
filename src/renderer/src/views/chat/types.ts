export interface ToolCard {
  kind: 'call' | 'result'
  name: string
  args?: Record<string, any>
  detail?: string
  text?: string
  completed?: boolean
  aborted?: boolean
  toolCallId?: string
}

export interface ChatStatusMeta {
  kind: 'thinking' | 'received' | 'tool'
  state?: 'pending' | 'running' | 'completed'
  toolCard?: ToolCard
}

export interface ChatMessage {
  id: string
  role: 'assistant' | 'user' | 'tool' | 'system'
  text: string
  title?: string
  toolCards?: ToolCard[]
  isStreaming?: boolean
  statusMeta?: ChatStatusMeta
  thinkingState?: 'pending' | 'running' | 'completed'
  thinkingText?: string
  thinkingLog?: Array<
    | {
        type: 'text'
        text: string
      }
    | {
        type: 'tool'
        toolCallId: string
      }
  >
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
