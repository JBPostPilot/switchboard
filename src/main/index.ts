import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ChatSession } from './sessions'
import { getProjectInfo } from './projectInfo'
import { loadChats, saveChats, loadItems, saveItems, deleteItems } from './store'
import type { ChatEvent, ChatMeta, PermissionDecision } from '../shared/types'

const sessions = new Map<string, ChatSession>()
let chats: ChatMeta[] = []
let win: BrowserWindow | null = null

function broadcast(event: ChatEvent): void {
  win?.webContents.send('chat:event', event)
}

function persistAll(): void {
  saveChats(chats)
}

function getSession(chatId: string): ChatSession | undefined {
  const existing = sessions.get(chatId)
  if (existing) return existing
  const meta = chats.find((c) => c.id === chatId)
  if (!meta) return undefined
  const session = new ChatSession(meta, broadcast, () => {
    persistAll()
    saveItems(chatId, session.items)
  })
  session.items = loadItems(chatId)
  sessions.set(chatId, session)
  return session
}

// Where brand-new projects are created, and where the folder picker starts.
// First existing conventional dev directory wins; ~/Projects is created as a
// fallback if none exist.
function projectsRoot(): string {
  const home = app.getPath('home')
  const candidates = ['Documents/Development', 'Development', 'Projects', 'code', 'dev'].map((p) =>
    path.join(home, p)
  )
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  const fallback = path.join(home, 'Projects')
  fs.mkdirSync(fallback, { recursive: true })
  return fallback
}

function createChatMeta(cwd: string): ChatMeta {
  return {
    id: randomUUID(),
    title: 'New chat',
    cwd,
    status: 'idle',
    statusLine: 'Ready when you are',
    preview: `New chat in ${path.basename(cwd)}`,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  chats = loadChats()

  ipcMain.handle('chats:list', () => chats)

  ipcMain.handle('projects:root', () => projectsRoot())

  ipcMain.handle('chats:create', async (_e, opts?: { newProjectName?: string }) => {
    let cwd: string
    if (opts?.newProjectName) {
      const safe = opts.newProjectName.trim().replace(/[/:\\]/g, '-')
      if (!safe) return null
      cwd = path.join(projectsRoot(), safe)
      fs.mkdirSync(cwd, { recursive: true })
    } else {
      if (!win) return null
      const picked = await dialog.showOpenDialog(win, {
        title: 'Choose a project folder for this chat',
        defaultPath: projectsRoot(),
        properties: ['openDirectory', 'createDirectory']
      })
      if (picked.canceled || picked.filePaths.length === 0) return null
      cwd = picked.filePaths[0]
    }
    const meta = createChatMeta(cwd)
    chats.unshift(meta)
    persistAll()
    return meta
  })

  ipcMain.handle('chats:send', (_e, chatId: string, text: string) => {
    getSession(chatId)?.send(text)
  })

  ipcMain.handle('chats:permission', (_e, chatId: string, decision: PermissionDecision) => {
    getSession(chatId)?.respondPermission(decision)
  })

  ipcMain.handle('chats:interrupt', async (_e, chatId: string) => {
    await getSession(chatId)?.interrupt()
  })

  ipcMain.handle('chats:items', (_e, chatId: string) => {
    const session = sessions.get(chatId)
    return session ? session.items : loadItems(chatId)
  })

  ipcMain.handle('chats:raw', (_e, chatId: string) => sessions.get(chatId)?.rawLog ?? [])

  ipcMain.handle('chats:delete', (_e, chatId: string) => {
    sessions.get(chatId)?.dispose()
    sessions.delete(chatId)
    chats = chats.filter((c) => c.id !== chatId)
    deleteItems(chatId)
    persistAll()
    return chats
  })

  ipcMain.handle('project:info', (_e, cwd: string) => getProjectInfo(cwd))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
