import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { CommandUsage } from '../shared/types'

// Remembers how often (and how recently) each slash command is run so the
// autocomplete can surface the user's favorites first. Mirrors the models.ts
// pattern: load once on launch into an in-memory cache, serve instantly, and
// write through to disk on every change. Single-user local app — no keying.

let cached: CommandUsage = {}

function cachePath(): string {
  return path.join(app.getPath('userData'), 'commandUsage.json')
}

export function loadCommandUsage(): CommandUsage {
  try {
    cached = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as CommandUsage
  } catch {
    cached = {}
  }
  return cached
}

export function getCommandUsage(): CommandUsage {
  return cached
}

export function recordCommandUsage(name: string): void {
  const prev = cached[name]
  cached[name] = { count: (prev?.count ?? 0) + 1, lastUsed: Date.now() }
  fs.writeFileSync(cachePath(), JSON.stringify(cached, null, 2))
}
