import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ProjectInfo } from '../shared/types'

const execFileAsync = promisify(execFile)

// Everything the details panel shows about a folder is read passively from
// disk — the same files a normal `claude` session would load.

function listSkills(dir: string, source: string): { name: string; source: string }[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
      .map((e) => ({ name: e.name, source }))
  } catch {
    return []
  }
}

// Repo identity: worktrees of the same repo share a common git dir, so the
// common dir's parent is the stable identity for "same project".
export async function getRepoIdentity(
  cwd: string
): Promise<{ repoRoot?: string; isWorktree: boolean }> {
  try {
    const [{ stdout: common }, { stdout: gitDir }] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }),
      execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], { cwd })
    ])
    const repoRoot = path.dirname(common.trim())
    return { repoRoot, isWorktree: common.trim() !== gitDir.trim() }
  } catch {
    return { isWorktree: false }
  }
}

export async function getProjectInfo(cwd: string): Promise<ProjectInfo> {
  let branch: string | undefined
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
    branch = stdout.trim()
  } catch {
    branch = undefined
  }

  const skills = [
    ...listSkills(path.join(cwd, '.claude', 'skills'), 'this project'),
    ...listSkills(path.join(os.homedir(), '.claude', 'skills'), 'all projects')
  ]

  const hasClaudeMd =
    fs.existsSync(path.join(cwd, 'CLAUDE.md')) || fs.existsSync(path.join(cwd, '.claude', 'CLAUDE.md'))

  // Static discovery — what's configured on disk before a session starts.
  // Servers can live in three places: the project's .mcp.json (project scope),
  // ~/.claude.json top-level mcpServers (user scope), and ~/.claude.json
  // projects[cwd].mcpServers (local scope — what `claude mcp add` writes).
  // claude.ai connectors live account-side only; those appear once a chat's
  // session is running (ChatMeta.mcp).
  const names = new Set<string>()
  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    for (const name of Object.keys(mcp.mcpServers ?? {})) names.add(name)
  } catch {
    // no project .mcp.json
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>
    }
    for (const name of Object.keys(cfg.mcpServers ?? {})) names.add(name)
    for (const name of Object.keys(cfg.projects?.[cwd]?.mcpServers ?? {})) names.add(name)
  } catch {
    // no ~/.claude.json
  }

  return { cwd, branch, skills, hasClaudeMd, mcpServers: [...names] }
}
