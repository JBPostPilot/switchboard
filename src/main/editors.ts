import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EditorApp } from '../shared/types'

// True macOS "Open With" is Launch Services (LSCopyApplicationURLsForURL),
// which Electron doesn't expose without a native module. Probing the standard
// app folders for editors people actually use gets the same result for a
// folder-shaped target, with no native code.
const KNOWN_EDITORS = [
  'Xcode',
  'Visual Studio Code',
  'Cursor',
  'Windsurf',
  'Sublime Text',
  'Zed',
  'Nova',
  'BBEdit',
  'TextMate',
  'WebStorm',
  'IntelliJ IDEA',
  'IntelliJ IDEA CE',
  'PyCharm',
  'PyCharm CE',
  'GoLand',
  'RubyMine',
  'CLion',
  'Android Studio'
]

// Re-probed on every call: ~36 stat calls is nothing, and it means a freshly
// installed editor shows up without relaunching Switchboard.
export function listEditors(): EditorApp[] {
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications')]
  const found: EditorApp[] = []
  for (const name of KNOWN_EDITORS) {
    for (const dir of dirs) {
      const appPath = path.join(dir, `${name}.app`)
      if (fs.existsSync(appPath)) {
        found.push({ name, appPath })
        break
      }
    }
  }
  return found
}

// Editor is looked up by name here rather than trusting a path from the
// renderer, so IPC can never be used to `open -a` an arbitrary app.
export function openInEditor(editorName: string, cwd: string): void {
  const editor = listEditors().find((e) => e.name === editorName)
  if (!editor) return
  execFile('open', ['-a', editor.appPath, cwd])
}
