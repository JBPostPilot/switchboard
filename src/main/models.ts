import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { sessionEnv } from './auth'
import { AsyncQueue } from './sessions'
import type { ModelChoice } from '../shared/types'

// The engine itself is the source of truth for which models this account can
// use (the API's model list can't see subscription entitlements). We ask it
// via a throwaway session — no messages sent — cache the answer to disk so
// the dropdown hydrates instantly on later launches, and refresh in the
// background on every launch.

let cached: ModelChoice[] = []
let inflight: Promise<ModelChoice[]> | null = null

function cachePath(): string {
  return path.join(app.getPath('userData'), 'models.json')
}

export function loadCachedModels(): ModelChoice[] {
  try {
    cached = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as ModelChoice[]
  } catch {
    cached = []
  }
  return cached
}

async function fetchFromEngine(): Promise<ModelChoice[]> {
  const queue = new AsyncQueue<never>()
  const abort = new AbortController()
  const q = query({
    prompt: queue,
    options: {
      settingSources: [],
      maxTurns: 1,
      abortController: abort,
      env: sessionEnv() ? ({ ...process.env, ...sessionEnv() } as Record<string, string>) : undefined
    }
  })
  try {
    const models = await (q as unknown as {
      supportedModels: () => Promise<{ value: string; displayName: string; description: string }[]>
    }).supportedModels()
    return models.map((m) => ({ id: m.value, label: m.displayName, description: m.description }))
  } finally {
    // Tear the throwaway session down completely — without the abort, its
    // engine subprocess would idle for the life of the app.
    queue.close()
    abort.abort()
    await (q as unknown as { return?: (v?: unknown) => Promise<unknown> }).return?.().catch(() => {})
  }
}

export async function getModels(): Promise<ModelChoice[]> {
  if (cached.length > 0) return cached
  return refreshModels()
}

export function refreshModels(): Promise<ModelChoice[]> {
  inflight ??= fetchFromEngine()
    .then((models) => {
      if (models.length > 0) {
        cached = models
        fs.writeFileSync(cachePath(), JSON.stringify(models, null, 2))
      }
      return cached
    })
    .catch(() => cached)
    .finally(() => {
      inflight = null
    })
  return inflight
}
