import type { TaskEntry } from '../shared/types'

// The tools that feed Claude's task list. Two systems flow through here:
//  - TodoWrite: sends the FULL list every call (we replace state wholesale).
//  - TaskCreate/TaskUpdate/TaskList/TaskGet: a persistent task graph with ids
//    and dependencies (we accumulate state from the create/update deltas).
// A session generally uses one or the other, and both share the same shape.
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

export function isTaskTool(tool: string): boolean {
  return TASK_TOOLS.has(tool)
}

type Status = TaskEntry['status']

function normalizeStatus(s: unknown): Status {
  const v = String(s ?? '')
  if (v === 'in_progress' || v === 'running') return 'in_progress'
  if (v === 'completed' || v === 'done') return 'completed'
  return 'pending'
}

interface Entry extends TaskEntry {
  order: number
}

// Rebuilds the current task list from the stream of task-tool calls. The engine
// assigns Task-graph ids sequentially ("1", "2", …) in create order, which is
// exactly what our running counter reproduces, so TaskUpdate-by-id lines up.
export class TaskTracker {
  private map = new Map<string, Entry>()
  private seq = 0 // last Task-graph id handed out
  private order = 0 // insertion order, for stable display

  // Adopt already-persisted entries (on session reload) so we keep updating the
  // same list instead of starting a fresh one.
  hydrate(entries: TaskEntry[]): void {
    entries.forEach((e, i) => {
      this.map.set(e.id, { ...e, blockedBy: e.blockedBy ?? [], order: i })
      const n = parseInt(e.id, 10)
      if (!Number.isNaN(n)) this.seq = Math.max(this.seq, n)
    })
    this.order = entries.length
  }

  // Apply one task-tool call. Returns true when the list changed (TaskList /
  // TaskGet are reads, so they return false — the caller still swallows them).
  apply(tool: string, input: Record<string, unknown>): boolean {
    if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
      this.map.clear()
      this.seq = 0
      this.order = 0
      for (const raw of input.todos as Record<string, unknown>[]) {
        const id = `todo-${this.order}`
        this.map.set(id, {
          id,
          subject: String(raw.content ?? raw.activeForm ?? 'Todo'),
          activeForm: typeof raw.activeForm === 'string' ? raw.activeForm : undefined,
          status: normalizeStatus(raw.status),
          blockedBy: [],
          order: this.order++
        })
      }
      return true
    }

    if (tool === 'TaskCreate') {
      const id = String(++this.seq)
      this.map.set(id, {
        id,
        subject: String(input.subject ?? input.description ?? `Task ${id}`),
        activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
        status: 'pending',
        blockedBy: [],
        order: this.order++
      })
      return true
    }

    if (tool === 'TaskUpdate' && input.taskId != null) {
      const id = String(input.taskId)
      let t = this.map.get(id)
      if (!t) {
        // An update for an id we never saw create — track it anyway so nothing
        // is silently lost.
        t = { id, subject: `Task ${id}`, status: 'pending', blockedBy: [], order: this.order++ }
        this.map.set(id, t)
      }
      if (input.status === 'deleted') {
        this.map.delete(id)
        return true
      }
      if (typeof input.status === 'string') t.status = normalizeStatus(input.status)
      if (typeof input.subject === 'string') t.subject = input.subject
      if (typeof input.activeForm === 'string') t.activeForm = input.activeForm
      if (Array.isArray(input.addBlockedBy)) {
        t.blockedBy = [...new Set([...(t.blockedBy ?? []), ...input.addBlockedBy.map(String)])]
      }
      return true
    }

    return false // TaskList / TaskGet — reads, no state change
  }

  list(): TaskEntry[] {
    return [...this.map.values()]
      .sort((a, b) => a.order - b.order)
      .map(({ order: _order, ...rest }) => rest)
  }

  get size(): number {
    return this.map.size
  }
}
