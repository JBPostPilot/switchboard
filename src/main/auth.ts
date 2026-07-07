import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import type { AuthStatus } from '../shared/types'

// Auth resolution mirrors the claude CLI: an explicit API key wins, otherwise
// the user's Claude login (~/.claude.json / ~/.claude/.credentials.json).
// A key entered in onboarding is encrypted with the OS keychain (safeStorage)
// and injected into each session's environment — never written in plaintext.

function keyFilePath(): string {
  return path.join(app.getPath('userData'), 'api-key.enc')
}

export function getStoredApiKey(): string | undefined {
  try {
    const enc = fs.readFileSync(keyFilePath())
    return safeStorage.decryptString(enc)
  } catch {
    return undefined
  }
}

export function setStoredApiKey(key: string | null): void {
  if (!key) {
    fs.rmSync(keyFilePath(), { force: true })
    return
  }
  fs.writeFileSync(keyFilePath(), safeStorage.encryptString(key.trim()))
}

function hasClaudeLogin(): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')) as {
      oauthAccount?: unknown
    }
    if (cfg.oauthAccount) return true
  } catch {
    // fall through
  }
  return fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'))
}

export function authStatus(): AuthStatus {
  if (process.env.ANTHROPIC_API_KEY) return { method: 'env-key' }
  if (getStoredApiKey()) return { method: 'stored-key' }
  if (hasClaudeLogin()) return { method: 'subscription' }
  return { method: 'none' }
}

// Extra environment for SDK sessions: inject the stored key when the user
// chose the API-key path. (An env key or CLI login needs nothing from us.)
export function sessionEnv(): Record<string, string> | undefined {
  if (process.env.ANTHROPIC_API_KEY) return undefined
  const key = getStoredApiKey()
  return key ? { ANTHROPIC_API_KEY: key } : undefined
}

// In a packaged app the SDK lives inside app.asar and would try to spawn its
// bundled engine from within the archive (spawn ENOTDIR). Point every session
// at the asarUnpack'd copy instead. In dev, the SDK resolves itself normally.
export function claudeExecutablePath(): string | undefined {
  if (!app.isPackaged) return undefined
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const base = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
  return path.join(base, 'node_modules', pkg, 'claude')
}

// The engine binary to run for interactive login. Prefer the user's installed
// CLI; fall back to the SDK's bundled binary (which exists even in a packaged
// app, via asarUnpack) so brand-new users don't need anything preinstalled.
function claudeBinary(): string {
  const installed = path.join(os.homedir(), '.local', 'bin', 'claude')
  if (fs.existsSync(installed)) return installed
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  const base = app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
  return claudeExecutablePath() ?? path.join(base, 'node_modules', pkg, 'claude')
}

// Open Terminal running the engine: an unauthenticated `claude` walks the
// user through browser sign-in on launch and writes credentials to ~/.claude,
// which every future Switchboard session picks up automatically.
export function openLoginTerminal(): void {
  const cmd = claudeBinary().replace(/'/g, "'\\''")
  const script = `tell application "Terminal"
  activate
  do script "clear; echo 'Sign in to Claude below, then come back to Switchboard.'; '${cmd}'"
end tell`
  execFile('osascript', ['-e', script])
}
