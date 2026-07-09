import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { authStatus, getUserProfile, openLoginTerminal, setStoredApiKey } from './auth'
import { ChatSession } from './sessions'
import { listEditors, openInEditor } from './editors'
import { getModels, loadCachedModels, refreshModels } from './models'
import { getProjectInfo, getRepoIdentity } from './projectInfo'
import { loadTranscriptItems } from './transcript'
import { loadChats, saveChats, loadItems, saveItems, deleteItems } from './store'
import type { Attachment, ChatEvent, ChatMeta, PermissionDecision, PermissionModeChoice } from '../shared/types'

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

// Local history first; if there is none but the chat has an engine session,
// rebuild the visible history from that session's transcript.
function itemsFor(meta: ChatMeta): ReturnType<typeof loadItems> {
  const items = loadItems(meta.id)
  if (items.length > 0 || !meta.sessionId) return items
  return loadTranscriptItems(meta.cwd, meta.sessionId)
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
  session.items = itemsFor(meta)
  sessions.set(chatId, session)
  return session
}

// App settings (currently just the projects root) live in userData.
interface Settings {
  projectsRoot?: string
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Settings
  } catch {
    return {}
  }
}

function saveSettings(settings: Settings): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}

// Where brand-new projects are created, and where the folder picker starts.
// The user's saved choice wins; otherwise the first existing conventional dev
// directory, with ~/Projects created as a last resort.
function projectsRoot(): string {
  const saved = loadSettings().projectsRoot
  if (saved && fs.existsSync(saved)) return saved
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

// The only image types the Anthropic API accepts as base64 content blocks.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

function describeAttachment(filePath: string): Attachment | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return null
    const ext = path.extname(filePath).toLowerCase()
    const imageMime = IMAGE_MIME_BY_EXT[ext]
    return {
      path: filePath,
      name: path.basename(filePath),
      mime: imageMime ?? 'application/octet-stream',
      isImage: imageMime !== undefined,
      sizeBytes: stat.size
    }
  } catch {
    return null // doesn't exist / not accessible
  }
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

  // Backfill repo identity for chats created before it existed.
  for (const meta of chats.filter((c) => c.repoRoot === undefined && !c.isWorktree)) {
    void getRepoIdentity(meta.cwd).then((identity) => {
      meta.repoRoot = identity.repoRoot ?? meta.cwd
      meta.isWorktree = identity.isWorktree
      persistAll()
      broadcast({ chatId: meta.id, meta: { ...meta } })
    })
  }

  ipcMain.handle('models:list', () => getModels())

  ipcMain.handle('chats:list', () => chats)

  ipcMain.handle('auth:status', () => authStatus())
  ipcMain.handle('auth:profile', () => getUserProfile())
  ipcMain.handle('auth:open-login', () => openLoginTerminal())
  ipcMain.handle('auth:set-key', (_e, key: string | null) => {
    setStoredApiKey(key)
    return authStatus()
  })

  ipcMain.handle('projects:root', () => projectsRoot())

  ipcMain.handle('projects:choose-root', async () => {
    if (!win) return projectsRoot()
    const picked = await dialog.showOpenDialog(win, {
      title: 'Where should new projects be created?',
      defaultPath: projectsRoot(),
      properties: ['openDirectory', 'createDirectory']
    })
    if (!picked.canceled && picked.filePaths.length > 0) {
      saveSettings({ ...loadSettings(), projectsRoot: picked.filePaths[0] })
    }
    return projectsRoot()
  })

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
    const identity = await getRepoIdentity(cwd)
    meta.repoRoot = identity.repoRoot
    meta.isWorktree = identity.isWorktree
    chats.unshift(meta)
    persistAll()
    return meta
  })

  ipcMain.handle('chats:send', (_e, chatId: string, text: string, attachments?: Attachment[]) => {
    getSession(chatId)?.send(text, attachments)
  })

  ipcMain.handle('chats:compact', (_e, chatId: string) => {
    getSession(chatId)?.compact()
  })

  // Native Finder-style open panel — no extension filter, since any filetype
  // Claude can read is a valid attachment.
  ipcMain.handle('files:choose-attachments', async () => {
    if (!win) return []
    const picked = await dialog.showOpenDialog(win, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections']
    })
    return picked.canceled ? [] : picked.filePaths
  })

  ipcMain.handle('files:describe-attachments', (_e, paths: string[]) => {
    return paths.map(describeAttachment).filter((a): a is Attachment => a !== null)
  })

  ipcMain.handle('chats:permission', (_e, chatId: string, decision: PermissionDecision) => {
    getSession(chatId)?.respondPermission(decision)
  })

  ipcMain.handle('chats:answer', (_e, chatId: string, answers: Record<string, string> | null) => {
    getSession(chatId)?.respondQuestion(answers)
  })

  // Model/mode are per-chat preferences. Persist them on the chat's meta by
  // id and live-apply to a running session — but do NOT spin up a throwaway
  // session just to record a preference (getSession would have, which both
  // wasted a subprocess and muddied which meta was being written).
  const patchChatMeta = (chatId: string, patch: Partial<ChatMeta>): void => {
    const meta = chats.find((c) => c.id === chatId)
    if (!meta) return
    Object.assign(meta, patch)
    persistAll()
    broadcast({ chatId, meta: { ...meta } })
  }

  ipcMain.handle('chats:set-model', (_e, chatId: string, model?: string) => {
    const session = sessions.get(chatId)
    if (session) session.setPreferredModel(model)
    else patchChatMeta(chatId, { preferredModel: model || undefined })
  })

  ipcMain.handle('chats:set-permission-mode', (_e, chatId: string, mode: PermissionModeChoice) => {
    const session = sessions.get(chatId)
    if (session) session.setPermissionModePref(mode)
    else patchChatMeta(chatId, { permissionMode: mode })
  })

  ipcMain.handle('chats:interrupt', async (_e, chatId: string) => {
    await getSession(chatId)?.interrupt()
  })

  ipcMain.handle('chats:items', (_e, chatId: string) => {
    const session = sessions.get(chatId)
    if (session) return session.items
    const meta = chats.find((c) => c.id === chatId)
    return meta ? itemsFor(meta) : []
  })

  ipcMain.handle('chats:commands', (_e, chatId: string) => sessions.get(chatId)?.commands ?? [])

  // Full-text search across every chat's conversation history — newest
  // matching message per chat, with a snippet around the match.
  ipcMain.handle('chats:search', (_e, query: string) => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    const results: { chatId: string; snippet: string; ts: number }[] = []
    for (const meta of chats) {
      const items = sessions.get(meta.id)?.items ?? loadItems(meta.id)
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        const text =
          item.kind === 'user' || item.kind === 'claude'
            ? item.text
            : item.kind === 'step'
              ? item.summary
              : ''
        const idx = text.toLowerCase().indexOf(q)
        if (idx < 0) continue
        const start = Math.max(0, idx - 30)
        const end = Math.min(text.length, idx + q.length + 60)
        const snippet =
          (start > 0 ? '…' : '') +
          text.slice(start, end).replace(/\s+/g, ' ').trim() +
          (end < text.length ? '…' : '')
        results.push({ chatId: meta.id, snippet, ts: item.ts })
        break // one hit per chat is enough to find the thread
      }
    }
    return results.sort((a, b) => b.ts - a.ts).slice(0, 12)
  })

  // Every pending approval/question across all chats, newest last — the
  // renderer's Approvals backlog.
  ipcMain.handle('backlog:list', () => {
    const entries = []
    for (const [chatId, session] of sessions) {
      const item = session.pendingItem()
      if (!item) continue
      entries.push({
        chatId,
        chatTitle: session.meta.title,
        cwd: session.meta.cwd,
        repoRoot: session.meta.repoRoot,
        item
      })
    }
    return entries.sort((a, b) => a.item.ts - b.item.ts)
  })

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

  // Individual files can only be opened when they live inside a chat's folder,
  // so the renderer can't point these at arbitrary paths on disk. Relative
  // references (as Claude usually writes them) resolve against that folder.
  const fileInChat = (cwd: string, filePath: string): string | undefined => {
    const root = chatCwd(cwd)
    if (!root) return
    const abs = path.resolve(root, filePath)
    const rel = path.relative(root, abs)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return
    try {
      if (!fs.statSync(abs).isFile()) return
    } catch {
      return // doesn't exist
    }
    return abs
  }

  ipcMain.handle('file:open', (_e, cwd: string, filePath: string) => {
    const safe = fileInChat(cwd, filePath)
    if (safe) void shell.openPath(safe) // system default for this file type
  })

  ipcMain.handle('file:reveal', (_e, cwd: string, filePath: string) => {
    const safe = fileInChat(cwd, filePath)
    if (safe) shell.showItemInFolder(safe)
  })

  ipcMain.handle('file:open-in', (_e, cwd: string, filePath: string, editorName: string) => {
    const safe = fileInChat(cwd, filePath)
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
