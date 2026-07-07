// Shared shapes between main, preload, and renderer.

export type ChatStatus = 'working' | 'needs-you' | 'idle' | 'error'

export interface ChatMeta {
  id: string
  title: string
  cwd: string
  sessionId?: string
  status: ChatStatus
  statusLine: string
  preview: string
  model?: string
  preferredModel?: string
  costUsd?: number
  contextTokens?: number
  createdAt: number
  updatedAt: number
}

// A single renderable item in a chat thread.
export type ThreadItem =
  | { kind: 'user'; id: string; text: string; ts: number }
  | { kind: 'claude'; id: string; text: string; ts: number }
  | { kind: 'step'; id: string; tool: string; summary: string; detail?: string; ts: number }
  | {
      kind: 'ask'
      id: string
      title: string
      body: string
      note?: string
      resolved?: 'allowed' | 'always-allowed' | 'denied'
      ts: number
    }
  | { kind: 'info'; id: string; text: string; ts: number }
  | { kind: 'error'; id: string; text: string; ts: number }

export type PermissionDecision = 'allow' | 'always' | 'deny'

export interface ModelChoice {
  id: string
  label: string
  description?: string
}

export interface ProjectInfo {
  cwd: string
  branch?: string
  skills: { name: string; source: string }[]
  hasClaudeMd: boolean
  mcpServers: string[]
}

// Events pushed from main → renderer.
export interface ChatEvent {
  chatId: string
  meta?: ChatMeta
  item?: ThreadItem
  updateItem?: { id: string; patch: Partial<ThreadItem> }
  raw?: unknown
}
