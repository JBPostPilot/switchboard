import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { friendlyToolSummary } from './sessions'
import { TaskTracker, isTaskTool } from './tasks'
import type { ThreadItem } from '../shared/types'

// Rebuild a chat's visible history from the engine's own session transcript
// (~/.claude/projects/<encoded-cwd>/<session-id>.jsonl). Used when Switchboard
// has no local history for a chat — e.g. resuming a session recorded before
// this feature, or adopting a session started from the terminal.

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function loadTranscriptItems(cwd: string, sessionId: string): ThreadItem[] {
  const file = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`)
  let lines: string[]
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    return []
  }

  const items: ThreadItem[] = []
  // Task/todo tools are replayed into one checklist card rather than shown as a
  // step apiece; it's slotted in where the tasks first appeared.
  const tasks = new TaskTracker()
  let taskInsertAt = -1
  for (const line of lines) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.isMeta) continue
    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Date.now()
    const inner = entry.message as { content?: unknown } | undefined
    const content = inner?.content

    if (entry.type === 'user') {
      // Skip tool results and harness-injected wrappers (<command-…>,
      // <system-reminder>, …) — only real typed messages are shown.
      const texts: string[] = []
      if (typeof content === 'string') texts.push(content)
      else if (Array.isArray(content)) {
        for (const b of content as Record<string, unknown>[]) {
          if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
        }
      }
      for (const text of texts) {
        if (text.trim() && !text.trimStart().startsWith('<')) {
          items.push({ kind: 'user', id: randomUUID(), text, ts })
        }
      }
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as Record<string, unknown>[]) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          items.push({ kind: 'claude', id: randomUUID(), text: b.text, ts })
        } else if (b.type === 'tool_use') {
          const tool = String(b.name ?? 'tool')
          if (isTaskTool(tool)) {
            if (taskInsertAt < 0) taskInsertAt = items.length
            tasks.apply(tool, (b.input ?? {}) as Record<string, unknown>)
            continue
          }
          items.push({
            kind: 'step',
            id: randomUUID(),
            tool,
            summary: friendlyToolSummary(tool, (b.input ?? {}) as Record<string, unknown>),
            ts
          })
        }
      }
    }
  }

  if (tasks.size > 0) {
    const card: ThreadItem = { kind: 'tasks', id: randomUUID(), items: tasks.list(), ts: Date.now() }
    const at = taskInsertAt >= 0 && taskInsertAt <= items.length ? taskInsertAt : items.length
    items.splice(at, 0, card)
  }

  return items
}
