// Shared shapes between main, preload, and renderer.

export type ChatStatus = 'working' | 'needs-you' | 'idle' | 'error'

export interface ChatMeta {
  id: string
  title: string
  // True once an LLM summary title has replaced the folder-name default.
  titled?: boolean
  cwd: string
  sessionId?: string
  status: ChatStatus
  statusLine: string
  preview: string
  model?: string
  preferredModel?: string
  permissionMode?: PermissionModeChoice
  costUsd?: number
  contextTokens?: number
  // Live MCP connections reported by the running session (includes claude.ai
  // connectors, which exist only account-side and are invisible on disk).
  mcp?: McpServer[]
  // Root of the git repo this folder belongs to (the *main* checkout for
  // worktrees) — chats in the same repo share an avatar color.
  repoRoot?: string
  isWorktree?: boolean
  createdAt: number
  updatedAt: number
}

export interface McpServer {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
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
  | {
      kind: 'question'
      id: string
      questions: ChatQuestion[]
      // question text → chosen answer; set once the user responds
      answers?: Record<string, string>
      skipped?: boolean
      ts: number
    }

export interface ChatQuestion {
  question: string
  header: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

export type PermissionDecision = 'allow' | 'always' | 'deny'

export type PermissionModeChoice = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint: string
}

export interface ModelChoice {
  id: string
  label: string
  description?: string
}

export interface AuthStatus {
  method: 'subscription' | 'env-key' | 'stored-key' | 'none'
}

export interface EditorApp {
  name: string
  appPath: string
}

export interface ProjectInfo {
  cwd: string
  branch?: string
  skills: { name: string; source: string }[]
  hasClaudeMd: boolean
  mcpServers: string[]
}

// A full-text match inside a chat's conversation history.
export interface SearchHit {
  chatId: string
  snippet: string
  ts: number
}

// One pending approval/question, with enough chat identity to act on it
// without opening the chat.
export interface BacklogEntry {
  chatId: string
  chatTitle: string
  cwd: string
  repoRoot?: string
  item: ThreadItem
}

// Events pushed from main → renderer.
export interface ChatEvent {
  chatId: string
  meta?: ChatMeta
  item?: ThreadItem
  updateItem?: { id: string; patch: Partial<ThreadItem> }
  commands?: SlashCommandInfo[]
  raw?: unknown
}
