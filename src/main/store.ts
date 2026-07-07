import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatMeta, ThreadItem } from '../shared/types'

// Simple write-through JSON persistence in the app's userData directory.
// chats.json holds the chat list; one file per chat holds its thread items
// so the UI can restore history across launches (the SDK's `resume` restores
// Claude's context; this restores what the user sees).

function dataDir(): string {
  const dir = path.join(app.getPath('userData'), 'chats')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function loadChats(): ChatMeta[] {
  try {
    const raw = fs.readFileSync(path.join(dataDir(), 'chats.json'), 'utf8')
    const chats = JSON.parse(raw) as ChatMeta[]
    // Nothing is running right after launch.
    return chats.map((c) => ({
      ...c,
      status: 'idle',
      statusLine: c.preview ? c.statusLine : 'Ready when you are'
    }))
  } catch {
    return []
  }
}

export function saveChats(chats: ChatMeta[]): void {
  fs.writeFileSync(path.join(dataDir(), 'chats.json'), JSON.stringify(chats, null, 2))
}

export function loadItems(chatId: string): ThreadItem[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), `${chatId}.json`), 'utf8')) as ThreadItem[]
  } catch {
    return []
  }
}

export function saveItems(chatId: string, items: ThreadItem[]): void {
  fs.writeFileSync(path.join(dataDir(), `${chatId}.json`), JSON.stringify(items))
}

export function deleteItems(chatId: string): void {
  fs.rmSync(path.join(dataDir(), `${chatId}.json`), { force: true })
}
