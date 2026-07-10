import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { encodeCwd } from './transcript'
import type { ChatMeta, DiscoveredSession } from '../shared/types'

// Discover live Claude Code sessions running *outside* Switchboard — i.e. in a
// Terminal window or an editor's integrated terminal — so they can be imported
// as chats. The engine writes a registry file per running process at
// ~/.claude/sessions/<pid>.json linking pid → sessionId → cwd → entrypoint;
// `entrypoint === 'sdk-cli'` marks Switchboard's own chats, everything else is
// an external session we can offer to import (and later resume by sessionId).

interface SessionRegistryEntry {
  pid?: number
  sessionId?: string
  cwd?: string
  entrypoint?: string
  name?: string
  startedAt?: number
}

// A registry file can outlive its process (crash, kill -9). Treat a session as
// live only if its pid still resolves. EPERM means the process exists but is
// owned by someone we can't signal — still alive for our purposes.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// slugs are kebab-case ("fix-login-bug"); make them read like a title.
function prettifySlug(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function deriveTitle(
  firstPrompt: string | undefined,
  slug: string | undefined,
  name: string | undefined,
  cwd: string
): string {
  if (firstPrompt) return truncate(firstPrompt, 60)
  if (slug) return prettifySlug(slug)
  if (name) return name
  return path.basename(cwd)
}

// Pull last-activity time, the session slug, and the first real user prompt out
// of the engine transcript so the picker (and the imported chat) have something
// human to show. Best-effort — a session may have no transcript yet.
function enrich(
  cwd: string,
  sessionId: string
): { lastActivity: number; slug?: string; firstPrompt?: string } {
  const file = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd), `${sessionId}.jsonl`)

  let lastActivity = 0
  try {
    lastActivity = fs.statSync(file).mtimeMs
  } catch {
    return { lastActivity }
  }

  let content: string
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch {
    return { lastActivity }
  }

  let slug: string | undefined
  let firstPrompt: string | undefined
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!slug && typeof entry.slug === 'string' && entry.slug.trim()) slug = entry.slug
    if (!firstPrompt && entry.type === 'user') {
      const inner = entry.message as { content?: unknown } | undefined
      const c = inner?.content
      let text: string | undefined
      if (typeof c === 'string') text = c
      else if (Array.isArray(c)) {
        for (const b of c as Record<string, unknown>[]) {
          if (b.type === 'text' && typeof b.text === 'string') {
            text = b.text
            break
          }
        }
      }
      // Skip harness-injected wrappers (<command-…>, <system-reminder>, …).
      if (text && text.trim() && !text.trimStart().startsWith('<')) firstPrompt = text.trim()
    }
    if (slug && firstPrompt) break
  }

  return { lastActivity, slug, firstPrompt }
}

export function discoverExternalSessions(existingChats: ChatMeta[]): DiscoveredSession[] {
  const dir = path.join(os.homedir(), '.claude', 'sessions')
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }

  // Don't offer sessions we've already imported.
  const taken = new Set(existingChats.map((c) => c.sessionId).filter(Boolean))
  const seen = new Set<string>()
  const out: DiscoveredSession[] = []

  for (const f of files) {
    if (!f.endsWith('.json')) continue
    let entry: SessionRegistryEntry
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SessionRegistryEntry
    } catch {
      continue
    }

    const { pid, sessionId, cwd, entrypoint } = entry
    if (!sessionId || !cwd || typeof pid !== 'number') continue
    if (entrypoint === 'sdk-cli') continue // Switchboard's own chats
    if (taken.has(sessionId) || seen.has(sessionId)) continue
    if (!isAlive(pid)) continue // stale registry file
    if (!fs.existsSync(cwd)) continue // project folder is gone
    seen.add(sessionId)

    const { lastActivity, slug, firstPrompt } = enrich(cwd, sessionId)
    out.push({
      sessionId,
      cwd,
      title: deriveTitle(firstPrompt, slug, entry.name, cwd),
      preview: firstPrompt ? truncate(firstPrompt, 140) : `Session in ${path.basename(cwd)}`,
      lastActivity: lastActivity || entry.startedAt || 0,
      projectName: path.basename(cwd)
    })
  }

  return out.sort((a, b) => b.lastActivity - a.lastActivity)
}
