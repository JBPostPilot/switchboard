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
  // Tokens currently occupying the context window (input + cache reads/writes
  // of the latest turn), and the size of that window for the active model.
  // Together they drive the usage meter's fill.
  contextTokens?: number
  contextWindow?: number
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

// A file the user attached to an outgoing message. Images are embedded as
// base64 content blocks; anything else is referenced by path so Claude's own
// Read tool can pick it up.
export interface Attachment {
  path: string
  name: string
  mime: string
  isImage: boolean
  sizeBytes: number
}

// One entry in Claude's task/todo list. Fed by the TodoWrite tool and by the
// persistent Task graph (TaskCreate/TaskUpdate/TaskList); `blockedBy` lists the
// ids of tasks that must finish first, and only applies to the Task graph.
export interface TaskEntry {
  id: string
  subject: string
  // Present-continuous label ("Fixing the bug") shown while in_progress.
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
  blockedBy?: string[]
}

// A single renderable item in a chat thread.
export type ThreadItem =
  | { kind: 'user'; id: string; text: string; attachments?: Attachment[]; ts: number }
  | { kind: 'claude'; id: string; text: string; ts: number }
  // path: the file this step acted on (Read/Edit/Write/…), when it targets one.
  // Present so the UI can offer to open that file.
  | { kind: 'step'; id: string; tool: string; summary: string; detail?: string; path?: string; ts: number }
  // Claude's task list, rendered as a live checklist. A single card per chat is
  // updated in place as tasks are created and change status.
  | { kind: 'tasks'; id: string; items: TaskEntry[]; ts: number }
  // A subagent launched via the Task tool. Rendered as a card that updates in
  // place while the agent works; SDK messages route to it by parent_tool_use_id.
  | {
      kind: 'agent'
      id: string
      toolUseId: string
      description: string
      agentType?: string
      status: 'running' | 'done' | 'error' | 'interrupted'
      // What the agent is doing right now (its latest tool call); cleared on finish.
      activity?: string
      steps: { summary: string; ts: number }[]
      // Tool-call count reported by task_progress — backgrounded agents don't
      // stream their steps, so this can run ahead of steps.length.
      toolUses?: number
      resultText?: string
      startedAt: number
      endedAt?: number
      ts: number
    }
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

// Per-command usage tally, keyed by command name. Drives frequency/recency
// ranking of the slash-command autocomplete. Single-user local app, so this is
// a flat machine-wide map — no per-user or per-project partitioning.
export type CommandUsage = Record<string, { count: number; lastUsed: number }>

export interface ModelChoice {
  id: string
  label: string
  description?: string
}

export interface AuthStatus {
  method: 'subscription' | 'env-key' | 'stored-key' | 'none'
}

// The signed-in account, surfaced from the Claude login. Every field beyond
// authMethod is best-effort — an API-key login has no profile behind it.
export interface UserProfile {
  authMethod: AuthStatus['method']
  name?: string
  email?: string
  organizationName?: string
  // Friendly plan label, e.g. "Team · Max 5×".
  plan?: string
  // Friendly org role, e.g. "Admin".
  role?: string
  extraUsageEnabled?: boolean
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
  // Progress of a compaction (manual /compact or the engine's own auto-compact)
  // so the meter can shimmer while it runs, then ease its fill down — or stop
  // and explain if the engine declined (e.g. too few messages to compact).
  compaction?: { phase: 'start' | 'done' | 'failed'; trigger: 'manual' | 'auto' }
}
