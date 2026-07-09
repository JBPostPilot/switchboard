import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import type { AuthStatus, UserProfile } from '../shared/types'

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

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Org roles arrive as "membership_admin" / "workspace_developer" etc.
function friendlyRole(role: unknown): string | undefined {
  if (typeof role !== 'string' || !role) return undefined
  const cleaned = role.replace(/^(membership|workspace)_/, '')
  const map: Record<string, string> = {
    admin: 'Admin',
    primary_owner: 'Owner',
    owner: 'Owner',
    billing: 'Billing',
    developer: 'Developer',
    member: 'Member',
    user: 'Member'
  }
  return map[cleaned] ?? titleCase(cleaned)
}

// Combine the org tier and the usage tier into one readable plan label, e.g.
// organizationType "claude_team" + userRateLimitTier "default_claude_max_5x"
// → "Team · Max 5×".
function friendlyPlan(oa: Record<string, unknown>): string | undefined {
  const orgType = typeof oa.organizationType === 'string' ? oa.organizationType : undefined
  const tier = typeof oa.userRateLimitTier === 'string' ? oa.userRateLimitTier : undefined
  const org =
    orgType === 'claude_team'
      ? 'Team'
      : orgType === 'claude_enterprise'
        ? 'Enterprise'
        : orgType
          ? titleCase(orgType.replace(/^claude_/, ''))
          : undefined
  let usage: string | undefined
  if (tier) {
    const m = tier.match(/max_(\d+)x/i)
    if (m) usage = `Max ${m[1]}×`
    else if (/enterprise/i.test(tier)) usage = 'Enterprise'
    else if (/pro/i.test(tier)) usage = 'Pro'
    else if (/free/i.test(tier)) usage = 'Free'
  }
  const parts = [org, usage].filter((p): p is string => Boolean(p))
  // Drop a duplicate (e.g. org "Enterprise" and usage "Enterprise").
  return [...new Set(parts)].join(' · ') || undefined
}

// The signed-in account, read from the Claude OAuth login. API-key logins have
// no account behind them, so only authMethod comes back in that case.
export function getUserProfile(): UserProfile {
  const authMethod = authStatus().method
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')) as {
      oauthAccount?: Record<string, unknown>
    }
    const oa = cfg.oauthAccount
    if (oa) {
      const email = typeof oa.emailAddress === 'string' ? oa.emailAddress : undefined
      const displayName = typeof oa.displayName === 'string' ? oa.displayName : undefined
      return {
        authMethod,
        name: displayName || email?.split('@')[0],
        email,
        organizationName:
          typeof oa.organizationName === 'string' ? oa.organizationName : undefined,
        plan: friendlyPlan(oa),
        role: friendlyRole(oa.organizationRole),
        extraUsageEnabled:
          typeof oa.hasExtraUsageEnabled === 'boolean' ? oa.hasExtraUsageEnabled : undefined
      }
    }
  } catch {
    // no login file / unreadable — fall through to the auth-method-only profile
  }
  return { authMethod }
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
