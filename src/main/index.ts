import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ChatSession } from './sessions'
import { listEditors, openInEditor } from './editors'
import { getModels, loadCachedModels, refreshModels } from './models'
import { getProjectInfo } from './projectInfo'
import { loadChats, saveChats, loadItems, saveItems, deleteItems } from './store'
import type { ChatEvent, ChatMeta, PermissionDecision } from '../shared/types'

const sessions = new Map<string, ChatSession>()
let chats: ChatMeta[] = []
let win: BrowserWindow | null = null

// Notify on attention transitions while the window is unfocused; clicking
// the notification focuses the app and jumps to that chat.
const lastStatus = new Map<string, string>()

function maybeNotify(meta: ChatMeta): void {
  const prev = lastStatus.get(meta.id)
  lastStatus.set(meta.id, meta.status)
  if (prev === meta.status || !Notification.isSupported()) return
  if (win?.isFocused()) return

  let body: string | null = null
  if (meta.status === 'needs-you') body = meta.statusLine || 'Claude needs your reply'
  else if (meta.status === 'idle' && prev === 'working') body = 'Done — ready for you'
  if (!body) return

  const n = new Notification({ title: meta.title, body })
  n.on('click', () => {
    win?.show()
    win?.focus()
    win?.webContents.send('notification:open', meta.id)
  })
  n.show()
}

function broadcast(event: ChatEvent): void {
  if (event.meta) maybeNotify(event.meta)
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
    // Chats are named for their project until the first message earns them
    // an LLM-written summary title (see ChatSession.send).
    title: path.basename(cwd),
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

  // Links in rendered markdown open in the browser, never in-app.
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
}

// ⌘W closes the current chat (not the window) — the Mac-native way to
// "close one of the terminal windows". The window itself is ⌘⇧W.
function buildMenu(): void {
  const menu = Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Chat…',
          accelerator: 'CmdOrCtrl+N',
          click: () => win?.webContents.send('menu:action', 'new-chat')
        },
        {
          label: 'Close Chat',
          accelerator: 'CmdOrCtrl+W',
          click: () => win?.webContents.send('menu:action', 'close-chat')
        },
        { type: 'separator' },
        { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ])
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(() => {
  chats = loadChats()
  buildMenu()
  loadCachedModels()
  void refreshModels() // background refresh; dropdown re-hydrates when it lands

  ipcMain.handle('models:list', () => getModels())

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

  ipcMain.handle('chats:answer', (_e, chatId: string, answers: Record<string, string> | null) => {
    getSession(chatId)?.respondQuestion(answers)
  })

  ipcMain.handle('chats:set-model', (_e, chatId: string, model?: string) => {
    getSession(chatId)?.setPreferredModel(model)
  })

  ipcMain.handle('chats:interrupt', async (_e, chatId: string) => {
    await getSession(chatId)?.interrupt()
  })

  ipcMain.handle('chats:items', (_e, chatId: string) => {
    const session = sessions.get(chatId)
    return session ? session.items : loadItems(chatId)
  })

  ipcMain.handle('chats:raw', (_e, chatId: string) => sessions.get(chatId)?.rawLog ?? [])

  ipcMain.handle('chats:delete', async (_e, chatId: string) => {
    const meta = chats.find((c) => c.id === chatId)
    if (!meta || !win) return null
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Close Chat', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Close “${meta.title}”?`,
      detail:
        'This stops anything in progress and removes the chat from Switchboard. Files in the project folder are not touched.'
    })
    if (response !== 0) return null
    const session = sessions.get(chatId)
    if (session) {
      await session.interrupt()
      session.dispose()
      sessions.delete(chatId)
    }
    chats = chats.filter((c) => c.id !== chatId)
    deleteItems(chatId)
    persistAll()
    return chats
  })

  ipcMain.handle('project:info', (_e, cwd: string) => getProjectInfo(cwd))

  // Only folders that belong to a chat can be revealed/opened — the renderer
  // can't point these at arbitrary paths.
  const chatCwd = (cwd: string): string | undefined => chats.find((c) => c.cwd === cwd)?.cwd

  ipcMain.handle('project:reveal', (_e, cwd: string) => {
    const safe = chatCwd(cwd)
    if (safe) shell.showItemInFolder(safe)
  })

  ipcMain.handle('project:editors', () => listEditors())

  ipcMain.handle('project:open-in', (_e, cwd: string, editorName: string) => {
    const safe = chatCwd(cwd)
    if (safe) openInEditor(editorName, safe)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
