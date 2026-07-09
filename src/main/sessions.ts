import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { claudeExecutablePath, sessionEnv } from './auth'
import { generateChatTitle } from './titles'
import { TaskTracker, isTaskTool } from './tasks'
import type {
  Attachment,
  ChatMeta,
  ChatEvent,
  ChatStatus,
  McpServer,
  PermissionDecision,
  PermissionModeChoice,
  SlashCommandInfo,
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
  Agent: 'Work on a subtask',
  TodoWrite: 'Update the plan'
}

// The subagent-spawning tool: 'Task' historically, 'Agent' in newer engines.
function isSubagentTool(tool: string): boolean {
  return tool === 'Task' || tool === 'Agent'
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

// First line of a Task tool_result — the finished agent's returned summary.
function toolResultFirstLine(content: unknown): string | undefined {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((c) => {
              const b = c as Record<string, unknown>
              return b.type === 'text' ? String(b.text ?? '') : ''
            })
            .join('\n')
        : ''
  const line = text.trim().split('\n')[0] ?? ''
  if (!line) return undefined
  return line.length > 140 ? line.slice(0, 137) + '…' : line
}

// The context window for a model, used as the usage-meter denominator. The
// engine encodes it in the model string as a suffix (e.g. "claude-opus-4-8[1m]");
// fall back to a family guess when the suffix is absent.
function contextWindowFor(model: string | undefined): number {
  if (model) {
    const m = model.match(/\[(\d+)(k|m)\]/i)
    if (m) {
      const n = parseInt(m[1], 10)
      return m[2].toLowerCase() === 'm' ? n * 1_000_000 : n * 1_000
    }
    if (/haiku/i.test(model)) return 200_000
  }
  // Opus / Sonnet / Fable currently ship 1M windows.
  return 1_000_000
}

export class ChatSession {
  meta: ChatMeta
  items: ThreadItem[] = []
  commands: SlashCommandInfo[] = []
  private queue = new AsyncQueue<unknown>()
  private q: ReturnType<typeof query> | null = null
  private pending: PendingPermission | null = null
  // True between issuing /compact and its result, so a "compacting" status is
  // attributed to the user (manual) rather than the engine (auto-compact).
  private compactRequested = false
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
        pathToClaudeCodeExecutable: claudeExecutablePath(),
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
      this.finalizeRunningAgents()
      this.setStatus('error', 'Something went wrong — send a message to retry')
      this.q = null
    }
  }

  // Streaming state: content-block index → thread item id for the assistant
  // message currently being generated. Reset at each message_start.
  private streamItems = new Map<number, string>()
  private streamEmitTimers = new Map<string, NodeJS.Timeout>()

  // Task/Agent tool_use id → agent thread-item id. A nested spawn (a subagent
  // spawning its own subagent) registers against the same top-level card, so
  // grandchild activity attributes to the card the user can see. Not
  // persisted: nothing is running after a relaunch.
  private agentItems = new Map<string, string>()
  // Engine task id → agent thread-item id, learned from task_started events.
  // Backgrounded agents report progress/completion only through these.
  private taskItems = new Map<string, string>()

  // Claude's task list, rebuilt from the task tools and rendered as one card
  // that updates in place. Hydrated lazily from the persisted card on reload.
  private taskTracker = new TaskTracker()
  private tasksItemId: string | null = null
  private taskStateLoaded = false

  private handleMessage(message: Record<string, unknown>): void {
    const type = message.type as string

    if (type === 'stream_event') {
      this.handleStreamEvent(message)
      return
    }

    if (type === 'system' && message.subtype === 'init') {
      if (typeof message.session_id === 'string') this.meta.sessionId = message.session_id
      if (typeof message.model === 'string') this.meta.model = message.model
      this.meta.contextWindow = contextWindowFor(this.meta.model)
      this.touch()
      // MCP servers (including claude.ai connectors) connect asynchronously
      // after init — give them a moment, then report real statuses.
      setTimeout(() => void this.refreshMcp(), 4000)
      void this.refreshCommands()
      return
    }

    // The engine pushes a fresh command list when it changes mid-session
    // (e.g. skills discovered while working); replace, don't re-fetch.
    if (type === 'system' && message.subtype === 'commands_changed' && Array.isArray(message.commands)) {
      this.setCommands(message.commands as Record<string, unknown>[])
      return
    }

    // Compaction progress. Manual /compact and the engine's auto-compact both
    // surface as `status` messages — "compacting" while it runs, then a
    // compact_result when it settles. No token counts ride along; the meter
    // drains on its own as the next turn's usage comes back smaller.
    if (type === 'system' && message.subtype === 'status') {
      const status = message.status as string | null | undefined
      const trigger: 'manual' | 'auto' = this.compactRequested ? 'manual' : 'auto'
      if (status === 'compacting') {
        this.emit({ chatId: this.meta.id, compaction: { phase: 'start', trigger } })
        this.setStatus('working', 'Compacting the conversation…')
        return
      }
      if (typeof message.compact_result === 'string') {
        const ok = message.compact_result === 'success'
        this.emit({ chatId: this.meta.id, compaction: { phase: ok ? 'done' : 'failed', trigger } })
        if (ok) {
          this.pushItem({
            kind: 'info',
            id: randomUUID(),
            text: 'Compacted the conversation to free up the context window.',
            ts: Date.now()
          })
        } else {
          const err =
            typeof message.compact_error === 'string' && message.compact_error
              ? message.compact_error.replace(/\.$/, '')
              : 'compaction was not possible'
          this.pushItem({
            kind: 'info',
            id: randomUUID(),
            text: `Couldn’t compact — ${err.charAt(0).toLowerCase() + err.slice(1)}.`,
            ts: Date.now()
          })
        }
        this.compactRequested = false
        return
      }
      return
    }

    // Task lifecycle events are the authoritative signal for subagents the
    // sidechain stream doesn't reach (backgrounded agents run detached):
    // started links engine task ids to cards, progress feeds the activity
    // line, notification is the completion signal.
    if (
      type === 'system' &&
      typeof message.subtype === 'string' &&
      message.subtype.startsWith('task_')
    ) {
      this.handleTaskEvent(message.subtype, message)
      return
    }

    if (type === 'assistant') {
      const inner = message.message as { content?: unknown[] } | undefined
      // Messages from inside a subagent update that agent's card instead of
      // rendering in the main thread.
      if (typeof message.parent_tool_use_id === 'string') {
        this.handleSubagentMessage(message.parent_tool_use_id, inner?.content ?? [])
        this.touch()
        return
      }
      // Context-window occupancy = the full prompt of this (top-level) turn:
      // fresh input plus everything served from / written to cache. Output
      // tokens aren't counted — they're a rounding error against the window and
      // counting them would make the meter twitch after every reply.
      const usage = (inner as { usage?: Record<string, number> } | undefined)?.usage
      if (usage) {
        const filled =
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0)
        if (filled > 0) this.meta.contextTokens = filled
      }
      // Text blocks that streamed in already have items — finalize those with
      // the authoritative full text instead of pushing duplicates.
      const streamedIds = [...this.streamItems.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id)
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
          if (isSubagentTool(tool)) {
            const itemId = randomUUID()
            this.agentItems.set(String(b.id), itemId)
            this.pushItem({
              kind: 'agent',
              id: itemId,
              toolUseId: String(b.id),
              description:
                typeof input.description === 'string' && input.description
                  ? input.description
                  : 'Work on a subtask',
              agentType: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
              status: 'running',
              steps: [],
              startedAt: Date.now(),
              ts: Date.now()
            })
            this.refreshWorkingStatus()
          } else if (isTaskTool(tool)) {
            // Task/todo tools feed the checklist card instead of cluttering the
            // thread with one opaque step per create/update.
            this.ensureTaskState()
            if (this.taskTracker.apply(tool, input)) this.syncTasksItem()
          } else {
            const target = input.file_path ?? input.path
            this.pushItem({
              kind: 'step',
              id: randomUUID(),
              tool,
              summary: friendlyToolSummary(tool, input),
              path: typeof target === 'string' ? target : undefined,
              ts: Date.now()
            })
          }
        }
      }
      this.touch()
      return
    }

    // Tool results come back as user-role messages. The only ones rendered
    // are Task results, which complete an agent card. Results from nested
    // Tasks carry a parent_tool_use_id and must not finish the visible card.
    if (type === 'user') {
      if (message.parent_tool_use_id != null) return
      const inner = message.message as { content?: unknown } | undefined
      if (!Array.isArray(inner?.content)) return
      for (const block of inner.content) {
        const b = block as Record<string, unknown>
        if (b.type !== 'tool_result') continue
        const itemId = this.agentItems.get(String(b.tool_use_id))
        if (!itemId) continue
        const item = this.items.find((i) => i.id === itemId)
        if (!item || item.kind !== 'agent' || item.status !== 'running') continue
        const summary = toolResultFirstLine(b.content)
        // A backgrounded agent acks its launch immediately and keeps working;
        // its real completion arrives later as a task_notification.
        if (b.is_error !== true && summary && /agent launched successfully/i.test(summary)) continue
        this.updateItem(itemId, {
          status: b.is_error === true ? 'error' : 'done',
          endedAt: Date.now(),
          activity: undefined,
          resultText: summary ?? item.resultText
        })
        this.refreshWorkingStatus()
      }
      return
    }

    if (type === 'result') {
      if (typeof message.session_id === 'string') this.meta.sessionId = message.session_id
      if (typeof message.total_cost_usd === 'number') this.meta.costUsd = message.total_cost_usd
      const usage = message.usage as Record<string, number> | undefined
      if (usage) {
        const filled =
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0)
        if (filled > 0) this.meta.contextTokens = filled
      }
      if (message.subtype !== 'success' && typeof message.subtype === 'string') {
        this.pushItem({
          kind: 'info',
          id: randomUUID(),
          text: `Stopped early (${message.subtype.replace(/_/g, ' ')}).`,
          ts: Date.now()
        })
      }
      // Backgrounded agents legitimately outlive the turn — their cards stay
      // running and complete via a later task_notification, so don't finalize
      // them here (only a dead stream or an interrupt does that).
      this.setStatus('idle', this.meta.preview || 'Ready when you are')
      void this.refreshMcp() // statuses can change mid-chat (e.g. after auth)
      return
    }
  }

  // Activity from inside a subagent: each tool call becomes a step on the
  // agent's card and its latest one is the "currently doing" line. Text
  // blocks are kept as a fallback summary until the real tool_result lands.
  private handleTaskEvent(subtype: string, message: Record<string, unknown>): void {
    const taskId = typeof message.task_id === 'string' ? message.task_id : undefined
    const toolUseId = typeof message.tool_use_id === 'string' ? message.tool_use_id : undefined
    const itemId =
      (toolUseId ? this.agentItems.get(toolUseId) : undefined) ??
      (taskId ? this.taskItems.get(taskId) : undefined)
    if (!itemId) return // not one of our agent cards (e.g. a background shell command)
    if (taskId) this.taskItems.set(taskId, itemId)
    const item = this.items.find((i) => i.id === itemId)
    if (!item || item.kind !== 'agent') return

    if (subtype === 'task_started') {
      if (typeof message.subagent_type === 'string' && !item.agentType) {
        this.updateItem(itemId, { agentType: message.subagent_type })
      }
      return
    }
    if (item.status !== 'running') return

    if (subtype === 'task_progress') {
      const usage = message.usage as { tool_uses?: number } | undefined
      const label =
        typeof message.summary === 'string' && message.summary.trim()
          ? message.summary.trim()
          : typeof message.last_tool_name === 'string' && message.last_tool_name
            ? (TOOL_LABELS[message.last_tool_name] ?? message.last_tool_name)
            : undefined
      this.updateItem(itemId, {
        activity: label ?? item.activity,
        toolUses: usage?.tool_uses ?? item.toolUses
      })
      return
    }
    if (subtype === 'task_notification') {
      const usage = message.usage as { tool_uses?: number } | undefined
      this.updateItem(itemId, {
        status:
          message.status === 'completed' ? 'done' : message.status === 'failed' ? 'error' : 'interrupted',
        endedAt: Date.now(),
        activity: undefined,
        toolUses: usage?.tool_uses ?? item.toolUses,
        resultText: toolResultFirstLine(message.summary) ?? item.resultText
      })
      this.refreshWorkingStatus()
      return
    }
    if (subtype === 'task_updated') {
      const patch = message.patch as { status?: string; error?: string } | undefined
      if (patch?.status === 'failed' || patch?.status === 'killed') {
        this.updateItem(itemId, {
          status: patch.status === 'failed' ? 'error' : 'interrupted',
          endedAt: Date.now(),
          activity: undefined,
          resultText: toolResultFirstLine(patch.error) ?? item.resultText
        })
        this.refreshWorkingStatus()
      }
    }
  }

  private handleSubagentMessage(parentId: string, content: unknown[]): void {
    const itemId = this.agentItems.get(parentId)
    if (!itemId) return // unknown parent (e.g. resumed session) — drop, don't flatten
    const item = this.items.find((i) => i.id === itemId)
    if (!item || item.kind !== 'agent' || item.status !== 'running') return
    let changed = false
    for (const block of content) {
      const b = block as Record<string, unknown>
      if (b.type === 'tool_use') {
        const summary = friendlyToolSummary(String(b.name ?? 'tool'), (b.input ?? {}) as Record<string, unknown>)
        item.steps.push({ summary, ts: Date.now() })
        item.activity = summary
        changed = true
        // A subagent spawning its own Task: attribute the grandchild's
        // activity to this top-level card.
        if (isSubagentTool(String(b.name))) this.agentItems.set(String(b.id), itemId)
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        item.resultText = b.text.trim()
        changed = true
      }
    }
    if (changed) {
      this.updateItem(itemId, { steps: item.steps, activity: item.activity, resultText: item.resultText })
    }
  }

  private workingLine(): string {
    const n = this.items.filter((i) => i.kind === 'agent' && i.status === 'running').length
    return n > 0 ? `Working — ${n} agent${n === 1 ? '' : 's'} on it` : 'Working…'
  }

  // Keep the sidebar line in sync with the running-agent count, without ever
  // clobbering a needs-you status (e.g. a permission ask from a subagent).
  private refreshWorkingStatus(): void {
    if (this.meta.status === 'working') this.setStatus('working', this.workingLine())
  }

  // Anything still running when the turn ends (result, stop, error) was cut
  // short — nothing will ever deliver its tool_result.
  private finalizeRunningAgents(): void {
    for (const item of this.items) {
      if (item.kind === 'agent' && item.status === 'running') {
        this.updateItem(item.id, { status: 'interrupted', endedAt: Date.now(), activity: undefined })
      }
    }
    this.agentItems.clear()
    this.taskItems.clear()
  }

  private handleStreamEvent(message: Record<string, unknown>): void {
    if (message.parent_tool_use_id != null) return // subagent activity; routed via handleSubagentMessage
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

  // Adopt a task card that was persisted before this launch, so new task-tool
  // calls keep updating the same list rather than spawning a second card.
  private ensureTaskState(): void {
    if (this.taskStateLoaded) return
    this.taskStateLoaded = true
    const existing = [...this.items].reverse().find((i) => i.kind === 'tasks')
    if (existing && existing.kind === 'tasks') {
      this.tasksItemId = existing.id
      this.taskTracker.hydrate(existing.items)
    }
  }

  private syncTasksItem(): void {
    const items = this.taskTracker.list()
    if (items.length === 0) return
    if (!this.tasksItemId) {
      const id = randomUUID()
      this.tasksItemId = id
      this.pushItem({ kind: 'tasks', id, items, ts: Date.now() })
    } else {
      this.updateItem(this.tasksItemId, { items })
    }
  }

  private setCommands(commands: Record<string, unknown>[]): void {
    this.commands = commands.map((c) => ({
      name: String(c.name ?? ''),
      description: String(c.description ?? ''),
      argumentHint: String(c.argumentHint ?? '')
    }))
    this.emit({ chatId: this.meta.id, commands: this.commands })
  }

  private async refreshCommands(): Promise<void> {
    const q = this.q as { supportedCommands?: () => Promise<Record<string, unknown>[]> } | null
    if (!q?.supportedCommands) return
    try {
      this.setCommands(await q.supportedCommands())
    } catch {
      // between turns or shutting down — keep the last known list
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

  pendingItem(): ThreadItem | undefined {
    if (!this.pending) return undefined
    return this.items.find((i) => i.id === this.pending?.itemId)
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
    this.setStatus('working', this.workingLine())
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
    this.setStatus('working', this.workingLine())
    pending.resolve(result)
  }

  send(text: string, attachments: Attachment[] = []): void {
    this.start()
    this.pushItem({
      kind: 'user',
      id: randomUUID(),
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
      ts: Date.now()
    })
    if (!this.meta.titled) this.autoTitle(text)
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: this.buildContent(text, attachments) },
      parent_tool_use_id: null
    })
    this.setStatus('working', this.workingLine())
  }

  // Tidy the conversation via the engine's own /compact. No user bubble is
  // shown — the resulting compact_boundary posts an info note and drains the
  // meter. Safe to call while idle; the engine queues it after any live turn.
  compact(): void {
    this.start()
    this.compactRequested = true
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: '/compact' },
      parent_tool_use_id: null
    })
    this.setStatus('working', 'Compacting the conversation…')
  }

  // Images are embedded as base64 content blocks the model can actually see;
  // everything else is referenced by path so Claude's own Read tool picks it
  // up, exactly as if the user had typed the path.
  private buildContent(text: string, attachments: Attachment[]): unknown {
    if (attachments.length === 0) return text

    const fileRefs = attachments
      .filter((a) => !a.isImage)
      .map((a) => `Attached file: ${a.path}`)
      .join('\n')
    const combinedText = fileRefs ? [text, fileRefs].filter(Boolean).join('\n\n') : text

    const blocks: Record<string, unknown>[] = []
    if (combinedText) blocks.push({ type: 'text', text: combinedText })
    for (const a of attachments.filter((a) => a.isImage)) {
      try {
        const data = fs.readFileSync(a.path).toString('base64')
        blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data } })
      } catch {
        // File vanished between attach and send — skip it rather than fail the turn.
      }
    }
    return blocks
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
      this.finalizeRunningAgents()
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
