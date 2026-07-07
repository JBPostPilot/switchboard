import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { sessionEnv } from './auth'
import { generateChatTitle } from './titles'
import type {
  ChatMeta,
  ChatEvent,
  ChatStatus,
  McpServer,
  PermissionDecision,
  PermissionModeChoice,
  ThreadItem
} from '../shared/types'

// A push-based async iterable: the SDK consumes it as the session's user-message
// stream, and we push into it whenever the user hits send.
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((v: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true })
        }
        return new Promise((resolve) => this.waiters.push(resolve))
      }
    }
  }
}

interface PendingPermission {
  kind: 'ask' | 'question'
  itemId: string
  resolve: (result: unknown) => void
  input: Record<string, unknown>
  suggestions: unknown[]
}

const TOOL_LABELS: Record<string, string> = {
  Read: 'Read a file',
  Write: 'Create a file',
  Edit: 'Edit a file',
  Bash: 'Run a command',
  Glob: 'Look for files',
  Grep: 'Search the code',
  WebFetch: 'Read a web page',
  WebSearch: 'Search the web',
  Task: 'Work on a subtask',
  TodoWrite: 'Update the plan'
}

export function friendlyToolSummary(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool
  const target =
    (input.file_path as string) ??
    (input.path as string) ??
    (input.command as string) ??
    (input.pattern as string) ??
    (input.url as string) ??
    (input.query as string) ??
    (input.description as string) ??
    ''
  const short = String(target).length > 80 ? String(target).slice(0, 77) + '…' : String(target)
  return short ? `${label} — ${short}` : label
}

export class ChatSession {
  meta: ChatMeta
  items: ThreadItem[] = []
  rawLog: unknown[] = []
  private queue = new AsyncQueue<unknown>()
  private q: ReturnType<typeof query> | null = null
  private pending: PendingPermission | null = null
  private emit: (event: ChatEvent) => void
  private persist: () => void

  constructor(meta: ChatMeta, emit: (event: ChatEvent) => void, persist: () => void) {
    this.meta = meta
    this.emit = emit
    this.persist = persist
  }

  start(): void {
    if (this.q) return
    this.q = query({
      prompt: this.queue as AsyncIterable<never>,
      options: {
        cwd: this.meta.cwd,
        model: this.meta.preferredModel,
        permissionMode: this.meta.permissionMode ?? 'default',
        includePartialMessages: true,
        // Behave like a normal `claude` session in this folder: load the
        // user's + project's settings, CLAUDE.md, skills, and MCP servers.
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        resume: this.meta.sessionId,
        env: sessionEnv() ? ({ ...process.env, ...sessionEnv() } as Record<string, string>) : undefined,
        canUseTool: (toolName: string, input: Record<string, unknown>, opts?: { suggestions?: unknown[] }) =>
          this.requestPermission(toolName, input, opts?.suggestions ?? []) as never
      }
    })
    void this.pump()
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.q as AsyncIterable<Record<string, unknown>>) {
        this.handleMessage(message)
      }
    } catch (err) {
      this.pushItem({
        kind: 'error',
        id: randomUUID(),
        text: `This chat hit a problem: ${err instanceof Error ? err.message : String(err)}`,
        ts: Date.now()
      })
      this.setStatus('error', 'Something went wrong — send a message to retry')
      this.q = null
    }
  }

  // Streaming state: content-block index → thread item id for the assistant
  // message currently being generated. Reset at each message_start.
  private streamItems = new Map<number, string>()
  private streamEmitTimers = new Map<string, NodeJS.Timeout>()

  private handleMessage(message: Record<string, unknown>): void {
    const type = message.type as string

    if (type === 'stream_event') {
      this.handleStreamEvent(message)
      return // too chatty for the raw log
    }

    this.rawLog.push(message)
    this.emit({ chatId: this.meta.id, raw: message })

    if (type === 'system' && message.subtype === 'init') {
      if (typeof message.session_id === 'string') this.meta.sessionId = message.session_id
      if (typeof message.model === 'string') this.meta.model = message.model
      this.touch()
      // MCP servers (including claude.ai connectors) connect asynchronously
      // after init — give them a moment, then report real statuses.
      setTimeout(() => void this.refreshMcp(), 4000)
      return
    }

    if (type === 'assistant') {
      const inner = message.message as { content?: unknown[] } | undefined
      // Text blocks that streamed in already have items — finalize those with
      // the authoritative full text instead of pushing duplicates.
      const streamedIds =
        message.parent_tool_use_id == null
          ? [...this.streamItems.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id)
          : []
      this.streamItems.clear()
      for (const block of inner?.content ?? []) {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const streamedId = streamedIds.shift()
          if (streamedId) {
            const item = this.items.find((i) => i.id === streamedId)
            if (item && item.kind === 'claude') item.text = b.text
            this.emit({ chatId: this.meta.id, updateItem: { id: streamedId, patch: { text: b.text } } })
          } else {
            this.pushItem({ kind: 'claude', id: randomUUID(), text: b.text, ts: Date.now() })
          }
          this.meta.preview = b.text.slice(0, 90)
        } else if (b.type === 'tool_use') {
          const tool = String(b.name ?? 'tool')
          const input = (b.input ?? {}) as Record<string, unknown>
          this.pushItem({
            kind: 'step',
            id: randomUUID(),
            tool,
            summary: friendlyToolSummary(tool, input),
            ts: Date.now()
          })
        }
      }
      this.touch()
      return
    }

    if (type === 'result') {
      if (typeof message.session_id === 'string') this.meta.sessionId = message.session_id
      if (typeof message.total_cost_usd === 'number') this.meta.costUsd = message.total_cost_usd
      const usage = message.usage as { input_tokens?: number; output_tokens?: number } | undefined
      if (usage) {
        this.meta.contextTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
      }
      if (message.subtype !== 'success' && typeof message.subtype === 'string') {
        this.pushItem({
          kind: 'info',
          id: randomUUID(),
          text: `Stopped early (${message.subtype.replace(/_/g, ' ')}).`,
          ts: Date.now()
        })
      }
      this.setStatus('idle', this.meta.preview || 'Ready when you are')
      void this.refreshMcp() // statuses can change mid-chat (e.g. after auth)
      return
    }
  }

  private handleStreamEvent(message: Record<string, unknown>): void {
    if (message.parent_tool_use_id != null) return // subagent activity; not rendered inline
    const event = message.event as Record<string, unknown> | undefined
    if (!event) return

    if (event.type === 'message_start') {
      this.streamItems.clear()
      return
    }

    if (event.type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined
      if (block?.type === 'text') {
        const item: ThreadItem = { kind: 'claude', id: randomUUID(), text: '', ts: Date.now() }
        this.items.push(item)
        this.streamItems.set(Number(event.index ?? 0), item.id)
        this.emit({ chatId: this.meta.id, item })
      }
      return
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      if (delta?.type !== 'text_delta' || typeof delta.text !== 'string') return
      const itemId = this.streamItems.get(Number(event.index ?? 0))
      if (!itemId) return
      const item = this.items.find((i) => i.id === itemId)
      if (!item || item.kind !== 'claude') return
      item.text += delta.text
      // Throttle renderer updates to ~30fps per item; final text lands with
      // the complete assistant message, so a trailing tick isn't critical.
      if (!this.streamEmitTimers.has(itemId)) {
        this.streamEmitTimers.set(
          itemId,
          setTimeout(() => {
            this.streamEmitTimers.delete(itemId)
            this.emit({ chatId: this.meta.id, updateItem: { id: itemId, patch: { text: item.text } } })
          }, 33)
        )
      }
    }
  }

  private async refreshMcp(): Promise<void> {
    const q = this.q as {
      mcpServerStatus?: () => Promise<{ name: string; status: McpServer['status'] }[]>
    } | null
    if (!q?.mcpServerStatus) return
    try {
      const statuses = await q.mcpServerStatus()
      this.meta.mcp = statuses.map((s) => ({ name: s.name, status: s.status }))
      this.touch()
    } catch {
      // Session may be shutting down or between turns — keep the last known list.
    }
  }

  private requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    suggestions: unknown[]
  ): Promise<unknown> {
    const itemId = randomUUID()

    // Claude's multiple-choice questions become tappable option cards; the
    // chosen answers go back through updatedInput.answers.
    if (toolName === 'AskUserQuestion' && Array.isArray(input.questions)) {
      const questions = (input.questions as Record<string, unknown>[]).map((q) => ({
        question: String(q.question ?? ''),
        header: String(q.header ?? ''),
        multiSelect: Boolean(q.multiSelect),
        options: Array.isArray(q.options)
          ? (q.options as Record<string, unknown>[]).map((o) => ({
              label: String(o.label ?? ''),
              description: o.description ? String(o.description) : undefined
            }))
          : []
      }))
      this.pushItem({ kind: 'question', id: itemId, questions, ts: Date.now() })
      const first = questions[0]?.question ?? 'a question'
      this.setStatus('needs-you', `Claude has a question — ${first}`)
      return new Promise((resolve) => {
        this.pending = { kind: 'question', itemId, resolve, input, suggestions }
      })
    }

    const summary = friendlyToolSummary(toolName, input)
    this.pushItem({
      kind: 'ask',
      id: itemId,
      title: 'Claude is asking for your OK',
      body: summary,
      note: toolName === 'Bash' ? String(input.command ?? '') : undefined,
      ts: Date.now()
    })
    this.setStatus('needs-you', `Waiting on permission — ${summary}`)

    return new Promise((resolve) => {
      this.pending = { kind: 'ask', itemId, resolve, input, suggestions }
    })
  }

  respondQuestion(answers: Record<string, string> | null): void {
    const pending = this.pending
    if (!pending || pending.kind !== 'question') return
    this.pending = null
    if (answers) {
      this.updateItem(pending.itemId, { answers })
      pending.resolve({ behavior: 'allow', updatedInput: { ...pending.input, answers } })
    } else {
      this.updateItem(pending.itemId, { skipped: true })
      pending.resolve({
        behavior: 'deny',
        message: 'The user chose not to answer. Proceed with your best judgment.'
      })
    }
    this.setStatus('working', 'Working…')
  }

  respondPermission(decision: PermissionDecision): void {
    const pending = this.pending
    if (!pending || pending.kind !== 'ask') return
    this.pending = null

    let result: unknown
    let resolved: 'allowed' | 'always-allowed' | 'denied'
    if (decision === 'deny') {
      result = { behavior: 'deny', message: 'The user declined. Ask what to do differently.' }
      resolved = 'denied'
    } else if (decision === 'always') {
      result = {
        behavior: 'allow',
        updatedInput: pending.input,
        updatedPermissions: pending.suggestions.length > 0 ? pending.suggestions : undefined
      }
      resolved = 'always-allowed'
    } else {
      result = { behavior: 'allow', updatedInput: pending.input }
      resolved = 'allowed'
    }

    this.updateItem(pending.itemId, { resolved })
    this.setStatus('working', 'Working…')
    pending.resolve(result)
  }

  send(text: string): void {
    this.start()
    this.pushItem({ kind: 'user', id: randomUUID(), text, ts: Date.now() })
    if (!this.meta.titled) this.autoTitle(text)
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null
    })
    this.setStatus('working', 'Working…')
  }

  // Replace the folder-name title with an LLM summary, in the background.
  // On failure the flag stays unset, so the next message tries again.
  private titling = false
  private autoTitle(text: string): void {
    if (this.titling) return
    this.titling = true
    void generateChatTitle(text).then((title) => {
      this.titling = false
      if (!title) return
      this.meta.title = title
      this.meta.titled = true
      this.touch()
    })
  }

  setPermissionModePref(mode: PermissionModeChoice): void {
    this.meta.permissionMode = mode
    const q = this.q as { setPermissionMode?: (m: string) => Promise<void> } | null
    if (q?.setPermissionMode) void q.setPermissionMode(mode).catch(() => {})
    this.touch()
  }

  setPreferredModel(model?: string): void {
    this.meta.preferredModel = model || undefined
    // Applies live if the session is running; otherwise it's picked up when
    // the session starts.
    const q = this.q as { setModel?: (m?: string) => Promise<void> } | null
    if (q?.setModel) void q.setModel(model || undefined).catch(() => {})
    this.touch()
  }

  async interrupt(): Promise<void> {
    const q = this.q as { interrupt?: () => Promise<void> } | null
    if (q?.interrupt) {
      await q.interrupt().catch(() => {})
      this.setStatus('idle', 'Stopped — ready for your next message')
    }
  }

  dispose(): void {
    this.queue.close()
    this.q = null
  }

  private pushItem(item: ThreadItem): void {
    this.items.push(item)
    this.emit({ chatId: this.meta.id, item })
    this.touch()
  }

  private updateItem(id: string, patch: Partial<ThreadItem>): void {
    const item = this.items.find((i) => i.id === id)
    if (item) Object.assign(item, patch)
    this.emit({ chatId: this.meta.id, updateItem: { id, patch } })
    this.persist()
  }

  private setStatus(status: ChatStatus, line: string): void {
    this.meta.status = status
    this.meta.statusLine = line
    this.touch()
  }

  private touch(): void {
    this.meta.updatedAt = Date.now()
    this.emit({ chatId: this.meta.id, meta: { ...this.meta } })
    this.persist()
  }
}
