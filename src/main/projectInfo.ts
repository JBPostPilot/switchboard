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

  let mcpServers: string[] = []
  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    mcpServers = Object.keys(mcp.mcpServers ?? {})
  } catch {
    mcpServers = []
  }

  return { cwd, branch, skills, hasClaudeMd, mcpServers }
}
