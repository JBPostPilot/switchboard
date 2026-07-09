import { Children, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  Attachment,
  AuthStatus,
  BacklogEntry,
  ChatMeta,
  ChatQuestion,
  CommandUsage,
  EditorApp,
  ModelChoice,
  PermissionModeChoice,
  ProjectInfo,
  SearchHit,
  SlashCommandInfo,
  TaskEntry,
  ThreadItem,
  UserProfile
} from '../../shared/types'

// Anthropic's image content blocks accept base64 payloads up to a few MB;
// keep individual attachments well under that.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

// A paste bigger than either bound collapses to a "[Pasted text …]" chip rather
// than flooding the composer — mirroring the terminal's paste affordance.
const PASTE_LINE_THRESHOLD = 6
const PASTE_CHAR_THRESHOLD = 4000

type QuestionItem = Extract<ThreadItem, { kind: 'question' }>
type AgentItem = Extract<ThreadItem, { kind: 'agent' }>
type AskItem = Extract<ThreadItem, { kind: 'ask' }>

const sb = window.switchboard

// Shown until the live list from the engine arrives (or if fetching fails).
const FALLBACK_MODELS: ModelChoice[] = [
  { id: 'opus', label: 'Opus — most capable' },
  { id: 'sonnet', label: 'Sonnet — fast + smart' },
  { id: 'haiku', label: 'Haiku — fastest' }
]

const MODE_CHOICES: {
  id: PermissionModeChoice
  label: string
  desc: string
  danger?: boolean
}[] = [
  {
    id: 'default',
    label: 'Ask first',
    desc: 'Claude checks with you before changing files or running commands.'
  },
  {
    id: 'acceptEdits',
    label: 'Auto-edits',
    desc: 'File edits happen without asking. Commands still check with you.'
  },
  {
    id: 'plan',
    label: 'Plan first',
    desc: 'Read-only: Claude proposes a plan and changes nothing until you approve.'
  },
  {
    id: 'bypassPermissions',
    label: 'Full auto',
    desc: 'Never asks. Best for experiments where mistakes are easy to undo.',
    danger: true
  }
]

// Shown until the live command list arrives from the chat's engine session.
const FALLBACK_COMMANDS: SlashCommandInfo[] = [
  { name: 'init', description: 'Teach Claude this project — writes project notes', argumentHint: '' },
  { name: 'compact', description: 'Tidy a long chat so Claude stays sharp', argumentHint: '' },
  { name: 'review', description: 'Review a pull request', argumentHint: '<pr number or url>' }
]

// Full URLs plus bare dev-server addresses (localhost:5173, 127.0.0.1:3000/…)
// that markdown autolinking misses.
const URL_RE =
  /(https?:\/\/[^\s<>()"'`]+|(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}(?:\/[^\s<>()"'`]*)?)/g

function linkifyText(text: string): React.ReactNode {
  const parts = text.split(URL_RE)
  if (parts.length === 1) return text
  return parts.map((part, i) => {
    if (i % 2 === 0) return part
    // Trailing sentence punctuation isn't part of the URL.
    let url = part
    let trail = ''
    while (/[.,;:!?]$/.test(url)) {
      trail = url.slice(-1) + trail
      url = url.slice(0, -1)
    }
    const href = url.startsWith('http') ? url : `http://${url}`
    return (
      <span key={i}>
        <a href={href} target="_blank" rel="noreferrer">
          {url}
        </a>
        {trail}
      </span>
    )
  })
}

function linkifyNodes(children: React.ReactNode): React.ReactNode {
  return Children.map(children, (child) => (typeof child === 'string' ? linkifyText(child) : child))
}

// Flatten a React children tree back to its plain text — used to read the
// contents of an inline `code` span so we can tell if it names a file.
function nodeText(children: React.ReactNode): string {
  let out = ''
  Children.forEach(children, (c) => {
    if (typeof c === 'string' || typeof c === 'number') out += String(c)
    else if (c && typeof c === 'object' && 'props' in c) {
      out += nodeText((c as { props: { children?: React.ReactNode } }).props.children)
    }
  })
  return out
}

// File extensions common enough in a coding project that a bare `name.ext`
// (no slash) is worth treating as a file. A path separator is enough on its
// own; this list keeps `array.map` or `shell.openPath` from looking like files.
const OPENABLE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx', 'css', 'scss', 'less',
  'html', 'htm', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'vue', 'svelte', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'env',
  'txt', 'sql', 'xml', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'lock'
])

function looksLikeFilePath(s: string): boolean {
  const t = s.trim()
  if (!t || t.length > 200 || /\s/.test(t)) return false
  if (t.includes('/')) return true
  const dot = t.lastIndexOf('.')
  if (dot <= 0) return false
  return OPENABLE_EXT.has(t.slice(dot + 1).toLowerCase())
}

// A referenced file rendered as a click target: opens a small "Open With"
// menu (system-default open, detected apps, Reveal in Finder). The main
// process resolves `path` against the chat folder and refuses anything
// outside it, so an unresolvable reference simply does nothing.
function FileLink({
  path,
  cwd,
  children
}: {
  path: string
  cwd: string
  children: React.ReactNode
}): React.JSX.Element {
  // anchor = the button's screen rect, captured when the menu opens; the menu
  // renders in a portal so the thread's scroll clipping can't hide it.
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [editors, setEditors] = useState<EditorApp[]>([])
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const close = (): void => {
    setAnchor(null)
    setPos(null)
  }

  const toggle = (): void => {
    if (anchor) return close()
    if (btnRef.current) setAnchor(btnRef.current.getBoundingClientRect())
    void sb.listEditors().then(setEditors)
  }

  // Clamp the menu inside the viewport, flipping above the link if it would
  // run off the bottom. Runs once the menu (and its app list) has laid out.
  useLayoutEffect(() => {
    if (!anchor || !menuRef.current) return
    const m = menuRef.current.getBoundingClientRect()
    const margin = 8
    let left = anchor.left
    let top = anchor.bottom + 4
    if (left + m.width > window.innerWidth - margin) left = window.innerWidth - margin - m.width
    if (top + m.height > window.innerHeight - margin) top = anchor.top - m.height - 4
    setPos({ left: Math.max(margin, left), top: Math.max(margin, top) })
  }, [anchor, editors])

  useEffect(() => {
    if (!anchor) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    // A fixed-position menu detaches from the link once anything scrolls.
    const onScroll = (): void => close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [anchor])

  const act = (fn: () => void): void => {
    fn()
    close()
  }

  return (
    <>
      <button ref={btnRef} type="button" className="file-link" title="Open this file" onClick={toggle}>
        {children}
      </button>
      {anchor &&
        createPortal(
          <div
            ref={menuRef}
            className="file-menu"
            role="menu"
            style={{ left: pos?.left ?? anchor.left, top: pos?.top ?? anchor.bottom + 4, visibility: pos ? 'visible' : 'hidden' }}
          >
            <span className="file-menu-path">{path}</span>
            <button role="menuitem" onClick={() => act(() => void sb.openFile(cwd, path))}>
              Open
            </button>
            {editors.map((ed) => (
              <button
                key={ed.name}
                role="menuitem"
                onClick={() => act(() => void sb.openFileIn(cwd, path, ed.name))}
              >
                {ed.name}
              </button>
            ))}
            <button role="menuitem" onClick={() => act(() => void sb.revealFile(cwd, path))}>
              Reveal in Finder
            </button>
          </div>,
          document.body
        )}
    </>
  )
}

function Markdown({ text, cwd }: { text: string; cwd?: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        p: ({ node: _node, children, ...props }) => <p {...props}>{linkifyNodes(children)}</p>,
        li: ({ node: _node, children, ...props }) => <li {...props}>{linkifyNodes(children)}</li>,
        code: ({ node: _node, children, ...props }) => {
          const raw = nodeText(children)
          // Inline code that names a file becomes an open target; block code
          // (multi-line) and non-path spans keep their normal rendering.
          if (cwd && !raw.includes('\n') && looksLikeFilePath(raw)) {
            return (
              <FileLink path={raw} cwd={cwd}>
                <code {...props}>{raw}</code>
              </FileLink>
            )
          }
          return <code {...props}>{linkifyNodes(children)}</code>
        }
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~')
}

// Every chat in the same project folder gets the same color, so a project's
// chats read as a family in the sidebar. The hue is a stable hash of the path;
// light/dark shades are resolved in CSS so the badge follows the OS theme.
function projectHue(cwd: string): number {
  let h = 0
  for (let i = 0; i < cwd.length; i++) h = (h * 31 + cwd.charCodeAt(i)) % 360
  return h
}

function ProjectAvatar({ cwd, hueKey }: { cwd: string; hueKey?: string }): React.JSX.Element {
  const name = cwd.split('/').filter(Boolean).pop() ?? '?'
  return (
    <span
      className="avatar project"
      style={{ '--hue': projectHue(hueKey ?? cwd) } as React.CSSProperties}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

const STATUS_GROUPS: { key: ChatMeta['status'][]; label: string; cls: string }[] = [
  { key: ['needs-you', 'error'], label: 'Needs your reply', cls: 'attn' },
  { key: ['working'], label: 'Working on it', cls: 'work' },
  { key: ['idle'], label: 'All caught up', cls: 'idle' }
]

// Chats in the same repo (or the same folder, when there's no repo) count as
// one project — the same rule the avatar hue uses, so a stack is one color.
function projectKeyOf(c: ChatMeta): string {
  return c.repoRoot ?? c.cwd
}

type SidebarRow = { kind: 'chat'; chat: ChatMeta } | { kind: 'stack'; key: string; chats: ChatMeta[] }

// Collapse same-project chats into stacks. `sorted` is newest-first, buckets
// preserve that order, and each stack sits where its newest member would have.
function buildRows(sorted: ChatMeta[]): SidebarRow[] {
  const buckets = new Map<string, ChatMeta[]>()
  for (const c of sorted) {
    const key = projectKeyOf(c)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(c)
    else buckets.set(key, [c])
  }
  const rows: SidebarRow[] = []
  for (const c of sorted) {
    const key = projectKeyOf(c)
    const bucket = buckets.get(key)
    if (!bucket) continue
    buckets.delete(key)
    rows.push(bucket.length === 1 ? { kind: 'chat', chat: c } : { kind: 'stack', key, chats: bucket })
  }
  return rows
}

export default function App(): React.JSX.Element {
  const [chats, setChats] = useState<ChatMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [items, setItems] = useState<ThreadItem[]>([])
  const [info, setInfo] = useState<ProjectInfo | null>(null)
  const [models, setModels] = useState<ModelChoice[]>(FALLBACK_MODELS)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [commands, setCommands] = useState<SlashCommandInfo[]>([])
  // How often each slash command has been run, for autocomplete ranking.
  // Loaded once on launch; bumped optimistically on send (see `send`).
  const [cmdUsage, setCmdUsage] = useState<CommandUsage>({})
  const [backlog, setBacklog] = useState<BacklogEntry[]>([])
  const [backlogMode, setBacklogMode] = useState(false)
  // Latest compaction progress on a chat — a signal (not data) the usage meter
  // watches to shimmer while compacting and ease its fill down on completion.
  // `at` retriggers the effect on repeat compactions.
  const [compaction, setCompaction] = useState<{
    chatId: string
    phase: 'start' | 'done' | 'failed'
    at: number
  } | null>(null)
  const backlogTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId

  const current = chats.find((c) => c.id === currentId) ?? null

  // Auth gate: check once at launch, then poll while unauthenticated so
  // finishing the Terminal sign-in advances the app automatically.
  useEffect(() => {
    void sb.getAuthStatus().then(setAuth)
  }, [])
  useEffect(() => {
    if (auth?.method !== 'none') return
    const timer = setInterval(() => void sb.getAuthStatus().then(setAuth), 3000)
    return () => clearInterval(timer)
  }, [auth?.method])
  // Load the account profile once signed in (and refresh if the method changes).
  useEffect(() => {
    if (!auth || auth.method === 'none') {
      setProfile(null)
      return
    }
    void sb.getUserProfile().then(setProfile)
  }, [auth?.method])

  useEffect(() => {
    void sb.listChats().then((list) => {
      setChats(list)
      if (list.length > 0) setCurrentId(list[0].id)
    })
    // Hydrate the model dropdown from what this account can actually use.
    // Ask twice: once for the (possibly cached) instant answer, then again
    // shortly after so the background refresh from the engine lands too.
    const hydrate = (): Promise<void> =>
      sb.listModels().then((list) => {
        if (list.length > 0) setModels(list)
      })
    void hydrate()
    const later = setTimeout(() => void hydrate(), 20_000)
    return () => clearTimeout(later)
  }, [])

  // The backlog reflects live session state — refresh (debounced) whenever
  // anything happens in any chat.
  const refreshBacklog = useCallback(() => {
    if (backlogTimer.current) return
    backlogTimer.current = setTimeout(() => {
      backlogTimer.current = null
      void sb.getBacklog().then(setBacklog)
    }, 120)
  }, [])

  useEffect(() => {
    void sb.getBacklog().then(setBacklog)
  }, [])

  useEffect(() => {
    return sb.onChatEvent((event) => {
      refreshBacklog()
      if (event.meta) {
        const meta = event.meta
        setChats((prev) => {
          const next = prev.some((c) => c.id === meta.id)
            ? prev.map((c) => (c.id === meta.id ? meta : c))
            : [meta, ...prev]
          return next
        })
      }
      if (event.chatId !== currentIdRef.current) return
      if (event.item) {
        const item = event.item
        setItems((prev) => [...prev, item])
      }
      if (event.updateItem) {
        const { id, patch } = event.updateItem
        setItems((prev) => prev.map((i) => (i.id === id ? ({ ...i, ...patch } as ThreadItem) : i)))
      }
      if (event.commands) {
        setCommands(event.commands)
      }
      if (event.compaction) {
        setCompaction({ chatId: event.chatId, phase: event.compaction.phase, at: Date.now() })
      }
    })
  }, [refreshBacklog])

  useEffect(() => {
    if (!currentId) return
    setItems([])
    setDraft('')
    setAttachments([])
    setCommands([])
    void sb.getItems(currentId).then(setItems)
    void sb.getCommands(currentId).then((list) => {
      if (list.length > 0) setCommands(list)
    })
  }, [currentId])

  useEffect(() => {
    if (!current) {
      setInfo(null)
      return
    }
    void sb.getProjectInfo(current.cwd).then(setInfo)
  }, [current?.cwd, current?.status === 'idle'])

  const chatCreated = useCallback((meta: ChatMeta) => {
    setChats((prev) => [meta, ...prev])
    setCurrentId(meta.id)
  }, [])

  // Optimistic per-chat patch so model/mode changes reflect instantly on the
  // right chat, independent of the main→renderer meta round-trip.
  const patchChat = useCallback((id: string, patch: Partial<ChatMeta>) => {
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }, [])

  const closeChat = useCallback(async (chatId: string) => {
    const remaining = await sb.deleteChat(chatId) // null = user cancelled
    if (!remaining) return
    setChats(remaining)
    setCurrentId((prev) => (prev === chatId ? (remaining[0]?.id ?? null) : prev))
  }, [])

  useEffect(() => {
    return sb.onOpenChat((chatId) => setCurrentId(chatId))
  }, [])

  useEffect(() => {
    return sb.onMenuAction((action) => {
      if (action === 'close-chat' && currentIdRef.current) {
        void closeChat(currentIdRef.current)
      }
      if (action === 'new-chat') {
        void sb.createChat().then((meta) => {
          if (meta) chatCreated(meta)
        })
      }
    })
  }, [closeChat, chatCreated])

  const send = useCallback(
    (text: string, attachments: Attachment[]) => {
      if (!currentId) return
      void sb.sendMessage(currentId, text, attachments)
      // Count a command as "used" only when it's actually sent. Guard against
      // free-text that merely starts with "/" by matching a known command.
      if (text.startsWith('/')) {
        const typed = text.slice(1).split(/\s/)[0].toLowerCase()
        const match = commands.find((c) => c.name.toLowerCase() === typed)
        if (match) {
          void sb.recordCommandUsage(match.name)
          setCmdUsage((u) => ({
            ...u,
            [match.name]: { count: (u[match.name]?.count ?? 0) + 1, lastUsed: Date.now() }
          }))
        }
      }
    },
    [currentId, commands]
  )

  // Hydrate the slash-command usage tally once on launch.
  useEffect(() => {
    void sb.getCommandUsage().then(setCmdUsage)
  }, [])

  const pendingAsk = useMemo(
    () => items.findLast((i) => i.kind === 'ask' && !i.resolved) as Extract<ThreadItem, { kind: 'ask' }> | undefined,
    [items]
  )

  const pendingQuestion = useMemo(
    () => items.findLast((i) => i.kind === 'question' && !i.answers && !i.skipped) as QuestionItem | undefined,
    [items]
  )

  const decide = useCallback(
    (decision: 'allow' | 'always' | 'deny') => {
      if (currentId && pendingAsk) void sb.respondPermission(currentId, decision)
    },
    [currentId, pendingAsk]
  )

  const answer = useCallback(
    (answers: Record<string, string> | null) => {
      if (currentId && pendingQuestion) void sb.respondQuestion(currentId, answers)
    },
    [currentId, pendingQuestion]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setDraft('/')
        composerRef.current?.focus()
        return
      }
      if (paletteOpen) return // palette owns the keyboard while open
      const target = e.target as HTMLElement
      if (
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') &&
        (target as HTMLInputElement | HTMLTextAreaElement).value !== ''
      )
        return
      // In the backlog, number keys act on the topmost entry.
      if (backlogMode) {
        const top = backlog[0]
        if (!top) return
        if (top.item.kind === 'ask') {
          if (e.key === '1') void sb.respondPermission(top.chatId, 'allow')
          if (e.key === '2') void sb.respondPermission(top.chatId, 'always')
          if (e.key === '3') void sb.respondPermission(top.chatId, 'deny')
        } else if (top.item.kind === 'question' && top.item.questions.length === 1 && !top.item.questions[0].multiSelect) {
          const q = top.item.questions[0]
          const idx = Number(e.key) - 1
          if (idx >= 0 && idx < q.options.length) {
            void sb.respondQuestion(top.chatId, { [q.question]: q.options[idx].label })
          }
        }
        return
      }
      if (pendingAsk) {
        if (e.key === '1') decide('allow')
        if (e.key === '2') decide('always')
        if (e.key === '3') decide('deny')
        return
      }
      // Number keys pick an option when Claude asked exactly one single-choice question.
      if (pendingQuestion && pendingQuestion.questions.length === 1 && !pendingQuestion.questions[0].multiSelect) {
        const q = pendingQuestion.questions[0]
        const idx = Number(e.key) - 1
        if (idx >= 0 && idx < q.options.length) answer({ [q.question]: q.options[idx].label })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingAsk, pendingQuestion, decide, answer, paletteOpen, backlogMode, backlog])

  if (auth === null) {
    return <div className="app drag" />
  }
  if (auth.method === 'none') {
    return <Onboarding onAuthed={setAuth} />
  }

  return (
    <div className="app">
      <Sidebar
        chats={chats}
        currentId={backlogMode ? null : currentId}
        backlogCount={backlog.length}
        backlogActive={backlogMode}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenBacklog={() => setBacklogMode(true)}
        onSelect={(id) => {
          setBacklogMode(false)
          setCurrentId(id)
        }}
        onCreated={chatCreated}
        onClose={(id) => void closeChat(id)}
      />
      {backlogMode ? (
        <BacklogPane
          backlog={backlog}
          onOpenChat={(id) => {
            setBacklogMode(false)
            setCurrentId(id)
          }}
        />
      ) : current ? (
        <>
          <ChatPane
            chat={current}
            items={items}
            models={models}
            commands={commands.length > 0 ? commands : FALLBACK_COMMANDS}
            commandUsage={cmdUsage}
            onPatchChat={patchChat}
            draft={draft}
            setDraft={setDraft}
            attachments={attachments}
            setAttachments={setAttachments}
            composerRef={composerRef}
            onSend={send}
            onDecide={decide}
            onAnswer={answer}
            onInterrupt={() => void sb.interrupt(current.id)}
          />
          <DetailsPanel
            chat={current}
            info={info}
            compaction={compaction && compaction.chatId === current.id ? compaction : null}
          />
        </>
      ) : (
        <EmptyState onCreated={chatCreated} />
      )}
      {paletteOpen && (
        <Palette
          chats={chats}
          onPick={(id) => {
            setCurrentId(id)
            setPaletteOpen(false)
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      <ProfileBadge profile={profile} />
    </div>
  )
}

// Bottom-right account chip: a quiet avatar + name that expands to a card with
// email, org, plan, role, and whether extra usage is on. Reassures beginners
// they're signed in and shows which account is driving their sessions.
function ProfileBadge({ profile }: { profile: UserProfile | null }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!profile || profile.authMethod === 'none') return null

  const apiKey = profile.authMethod !== 'subscription'
  const name = profile.name ?? (apiKey ? 'API key' : 'Account')
  const initial = (profile.name ?? profile.email ?? (apiKey ? '⚿' : '?')).trim().charAt(0).toUpperCase()
  const authLabel =
    profile.authMethod === 'subscription'
      ? 'Claude subscription'
      : profile.authMethod === 'env-key'
        ? 'API key (environment)'
        : 'API key'

  return (
    <div className="profile" ref={ref}>
      {open && (
        <div className="profile-card" role="dialog" aria-label="Account">
          <div className="profile-card-head">
            <span className="profile-avatar lg">{initial}</span>
            <div className="profile-id">
              <div className="profile-name">{name}</div>
              {profile.email && <div className="profile-email">{profile.email}</div>}
            </div>
          </div>
          <dl className="profile-kv">
            {profile.organizationName && (
              <>
                <dt>Organization</dt>
                <dd>{profile.organizationName}</dd>
              </>
            )}
            {profile.plan && (
              <>
                <dt>Plan</dt>
                <dd>{profile.plan}</dd>
              </>
            )}
            {profile.role && (
              <>
                <dt>Role</dt>
                <dd>{profile.role}</dd>
              </>
            )}
            {profile.extraUsageEnabled !== undefined && (
              <>
                <dt>Extra usage</dt>
                <dd className={profile.extraUsageEnabled ? 'on' : ''}>
                  {profile.extraUsageEnabled ? 'On' : 'Off'}
                </dd>
              </>
            )}
            <dt>Signed in with</dt>
            <dd>{authLabel}</dd>
          </dl>
        </div>
      )}
      <button className="profile-chip" onClick={() => setOpen((v) => !v)} title="Your account">
        <span className="profile-avatar">{initial}</span>
        <span className="profile-chip-name">{name}</span>
      </button>
    </div>
  )
}

function Palette({
  chats,
  onPick,
  onClose
}: {
  chats: ChatMeta[]
  onPick: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [contentHits, setContentHits] = useState<SearchHit[]>([])

  const metaHits = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
    if (!needle) return sorted
    return sorted.filter((c) =>
      `${c.title} ${c.cwd} ${c.preview} ${c.statusLine}`.toLowerCase().includes(needle)
    )
  }, [chats, q])

  // Full-text search inside conversations, debounced; chats already matched
  // by name/folder aren't repeated.
  useEffect(() => {
    const needle = q.trim()
    if (needle.length < 2) {
      setContentHits([])
      return
    }
    const timer = setTimeout(() => void sb.searchChats(needle).then(setContentHits), 150)
    return () => clearTimeout(timer)
  }, [q])

  const contentRows = useMemo(() => {
    const seen = new Set(metaHits.map((c) => c.id))
    return contentHits
      .filter((h) => !seen.has(h.chatId))
      .map((h) => ({ hit: h, meta: chats.find((c) => c.id === h.chatId) }))
      .filter((r): r is { hit: SearchHit; meta: ChatMeta } => Boolean(r.meta))
  }, [contentHits, metaHits, chats])

  const total = metaHits.length + contentRows.length
  const hits = metaHits // rows 0..metaHits-1 are meta; the rest are content

  useEffect(() => setSel(0), [q])

  const pickAt = (i: number): void => {
    if (i < metaHits.length) onPick(metaHits[i].id)
    else if (contentRows[i - metaHits.length]) onPick(contentRows[i - metaHits.length].meta.id)
  }

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Jump to chat">
        <input
          autoFocus
          value={q}
          placeholder="Jump to a chat — name, folder, or what it’s about…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'ArrowDown') setSel((s) => Math.min(s + 1, total - 1))
            if (e.key === 'ArrowUp') setSel((s) => Math.max(s - 1, 0))
            if (e.key === 'Enter') pickAt(sel)
          }}
        />
        <div className="palette-results">
          {total === 0 && <div className="palette-empty">No chat matches “{q}”.</div>}
          {hits.map((c, i) => (
            <button
              key={c.id}
              className={`palette-row ${i === sel ? 'selected' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => onPick(c.id)}
            >
              <span
                className={`palette-dot ${c.status === 'needs-you' || c.status === 'error' ? 'attn' : c.status === 'working' ? 'work' : ''}`}
              />
              <span className="palette-title">{c.title}</span>
              <span className="palette-path">{shortPath(c.cwd)}</span>
              <span className="palette-preview">{c.statusLine || c.preview}</span>
            </button>
          ))}
          {contentRows.length > 0 && <div className="palette-section">In conversations</div>}
          {contentRows.map(({ hit, meta }, j) => {
            const i = metaHits.length + j
            return (
              <button
                key={hit.chatId}
                className={`palette-row ${i === sel ? 'selected' : ''}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => onPick(meta.id)}
              >
                <span className="palette-dot" />
                <span className="palette-title">{meta.title}</span>
                <span className="palette-path">{shortPath(meta.cwd)}</span>
                <span className="palette-preview snippet">“{hit.snippet}”</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function NewChatControl({
  onCreated,
  triggerClass,
  triggerLabel
}: {
  onCreated: (meta: ChatMeta) => void
  triggerClass: string
  triggerLabel: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [root, setRoot] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) void sb.getProjectsRoot().then(setRoot)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const finish = (meta: ChatMeta | null): void => {
    if (meta) onCreated(meta)
    setOpen(false)
    setName('')
  }

  const openFolder = async (): Promise<void> => finish(await sb.createChat())
  const createProject = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    finish(await sb.createChat({ newProjectName: trimmed }))
  }

  return (
    <div className="newchat-wrap" ref={wrapRef}>
      <button className={triggerClass} onClick={() => setOpen((v) => !v)}>
        {triggerLabel}
      </button>
      {open && (
        <div className="newchat-pop" role="menu">
          <button className="newchat-option" onClick={() => void openFolder()}>
            <span className="newchat-option-title">Open a folder…</span>
            <span className="newchat-option-desc">Chat in a project you already have</span>
          </button>
          <div className="newchat-divider" />
          <div className="newchat-option static">
            <span className="newchat-option-title">Create a new project</span>
            <div className="newchat-name-row">
              <input
                value={name}
                placeholder="project-name"
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createProject()
                }}
              />
              <button className="btn primary" disabled={!name.trim()} onClick={() => void createProject()}>
                Create
              </button>
            </div>
            {root && (
              <span className="newchat-option-desc">
                Makes a new folder in {shortPath(root)}{' '}
                <button
                  className="newchat-change"
                  onClick={() => void sb.chooseProjectsRoot().then(setRoot)}
                >
                  Change…
                </button>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ChatRow({
  chat,
  selected,
  onSelect,
  onClose,
  onNewChat,
  className
}: {
  chat: ChatMeta
  selected: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNewChat?: (cwd: string) => void
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={className ? `chat-item ${className}` : 'chat-item'}
      role="button"
      tabIndex={0}
      aria-current={selected}
      onClick={() => onSelect(chat.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(chat.id)
      }}
    >
      <ProjectAvatar cwd={chat.cwd} hueKey={chat.repoRoot} />
      <span className="chat-name">{chat.title}</span>
      <span className="chat-time">{timeAgo(chat.updatedAt)}</span>
      <span className={`chat-preview ${chat.status === 'needs-you' || chat.status === 'error' ? 'attn' : chat.status === 'working' ? 'work' : ''}`}>
        {chat.statusLine || chat.preview}
      </span>
      {chat.status === 'needs-you' && <span className="badge" />}
      {chat.status === 'working' && <span className="badge work" />}
      {onNewChat && (
        <button
          className="chat-newhere"
          data-tip="New chat in this project"
          aria-label={`Start a new chat in ${chat.title}`}
          onClick={(e) => {
            e.stopPropagation()
            onNewChat(chat.cwd)
          }}
        >
          +
        </button>
      )}
      <button
        className="chat-close"
        title="Close this chat (⌘W)"
        aria-label={`Close ${chat.title}`}
        onClick={(e) => {
          e.stopPropagation()
          onClose(chat.id)
        }}
      >
        ✕
      </button>
    </div>
  )
}

// Same-project chats piled into one row. Clicking the head only discloses the
// members — selecting a chat happens on the rows inside, never on the pile.
function ThreadStack({
  groupKey,
  chats,
  sectionCls,
  currentId,
  expanded,
  onToggle,
  onSelect,
  onClose,
  onNewChat
}: {
  groupKey: string
  chats: ChatMeta[]
  sectionCls: string
  currentId: string | null
  expanded: boolean
  onToggle: () => void
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNewChat: (cwd: string) => void
}): React.JSX.Element {
  const head = chats[0]
  const projectName = groupKey.split('/').filter(Boolean).pop() ?? groupKey
  const containsSelected = chats.some((c) => c.id === currentId)
  return (
    <div className={`stack ${expanded ? 'open' : 'collapsed'}`}>
      <div
        className="chat-item stack-head"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-current={!expanded && containsSelected}
        aria-label={`${projectName} — ${chats.length} chats`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        <ProjectAvatar cwd={groupKey} hueKey={groupKey} />
        <span className="stack-title">
          <span className="chat-name">{projectName}</span>
          <span className="stack-count">{chats.length}</span>
          <span className="stack-chevron" aria-hidden>
            ›
          </span>
        </span>
        {!expanded && (
          <>
            <span className="chat-time">{timeAgo(head.updatedAt)}</span>
            <span className={`chat-preview ${head.status === 'needs-you' || head.status === 'error' ? 'attn' : head.status === 'working' ? 'work' : ''}`}>
              {head.statusLine || head.preview}
            </span>
            {sectionCls === 'attn' && <span className="badge" />}
            {sectionCls === 'work' && <span className="badge work" />}
          </>
        )}
        <button
          className="chat-newhere"
          data-tip="New chat in this project"
          aria-label={`Start a new chat in ${projectName}`}
          onClick={(e) => {
            e.stopPropagation()
            onNewChat(head.cwd)
          }}
        >
          +
        </button>
      </div>
      <div className="stack-members" aria-hidden={!expanded}>
        <div className="stack-members-inner">
          {chats.map((c) => (
            <ChatRow
              key={c.id}
              chat={c}
              selected={c.id === currentId}
              onSelect={onSelect}
              onClose={onClose}
              className="stack-member"
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function Sidebar({
  chats,
  currentId,
  backlogCount,
  backlogActive,
  onOpenPalette,
  onOpenBacklog,
  onSelect,
  onCreated,
  onClose
}: {
  chats: ChatMeta[]
  currentId: string | null
  backlogCount: number
  backlogActive: boolean
  onOpenPalette: () => void
  onOpenBacklog: () => void
  onSelect: (id: string) => void
  onCreated: (meta: ChatMeta) => void
  onClose: (id: string) => void
}): React.JSX.Element {
  const [grouped, setGrouped] = useState(() => localStorage.getItem('sb.groupByProject') !== '0')
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem('sb.expandedStacks') ?? '[]'))
    } catch {
      return new Set<string>()
    }
  })

  const toggleGrouping = (): void => {
    const next = !grouped
    setGrouped(next)
    localStorage.setItem('sb.groupByProject', next ? '1' : '0')
  }

  const newInProject = async (cwd: string): Promise<void> => {
    const meta = await sb.createChat({ cwd })
    if (meta) onCreated(meta)
  }

  const toggleStack = (key: string): void => {
    const next = new Set(expandedStacks)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpandedStacks(next)
    localStorage.setItem('sb.expandedStacks', JSON.stringify([...next]))
  }

  return (
    <aside className="rail">
      <div className="rail-top drag">
        <span className="wordmark">Switchboard</span>
        <button
          className={`rail-groupby no-drag ${grouped ? 'on' : ''}`}
          title={grouped ? 'Grouped by project — click to show every chat' : 'Group chats by project'}
          aria-pressed={grouped}
          onClick={toggleGrouping}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect x="2.75" y="2.75" width="10.5" height="6.5" rx="1.75" stroke="currentColor" strokeWidth="1.5" />
            <path d="M4.5 11.75h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M6 14.25h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="rail-search no-drag">
        <button className="search-hint" title="Search chats and conversations" onClick={onOpenPalette}>
          Search <kbd>⌘K</kbd>
        </button>
      </div>
      <div className="rail-list">
        <button
          className={`approvals-row ${backlogCount === 0 ? 'empty' : ''}`}
          aria-current={backlogActive}
          onClick={onOpenBacklog}
        >
          <span className="approvals-icon">⚡</span>
          <span className="approvals-label">Approvals</span>
          {backlogCount > 0 ? (
            <span className="approvals-count">{backlogCount}</span>
          ) : (
            <span className="approvals-clear">✓</span>
          )}
        </button>
        {STATUS_GROUPS.map((group) => {
          const inGroup = chats
            .filter((c) => group.key.includes(c.status))
            .sort((a, b) => b.updatedAt - a.updatedAt)
          if (inGroup.length === 0) return null
          const rows: SidebarRow[] = grouped
            ? buildRows(inGroup)
            : inGroup.map((c) => ({ kind: 'chat' as const, chat: c }))
          return (
            <div key={group.label}>
              <div className={`rail-group-label ${group.cls}`}>{group.label}</div>
              {rows.map((row) =>
                row.kind === 'chat' ? (
                  <ChatRow
                    key={row.chat.id}
                    chat={row.chat}
                    selected={row.chat.id === currentId}
                    onSelect={onSelect}
                    onClose={onClose}
                    onNewChat={(cwd) => void newInProject(cwd)}
                  />
                ) : (
                  <ThreadStack
                    key={`${group.cls}:${row.key}`}
                    groupKey={row.key}
                    chats={row.chats}
                    sectionCls={group.cls}
                    currentId={currentId}
                    expanded={expandedStacks.has(`${group.cls}:${row.key}`)}
                    onToggle={() => toggleStack(`${group.cls}:${row.key}`)}
                    onSelect={onSelect}
                    onClose={onClose}
                    onNewChat={(cwd) => void newInProject(cwd)}
                  />
                )
              )}
            </div>
          )
        })}
      </div>
      <NewChatControl
        onCreated={onCreated}
        triggerClass="rail-new"
        triggerLabel={
          <>
            <span className="plus">+</span>New chat…
          </>
        }
      />
    </aside>
  )
}

function ChatPane({
  chat,
  items,
  models,
  commands,
  commandUsage,
  onPatchChat,
  draft,
  setDraft,
  attachments,
  setAttachments,
  composerRef,
  onSend,
  onDecide,
  onAnswer,
  onInterrupt
}: {
  chat: ChatMeta
  items: ThreadItem[]
  models: ModelChoice[]
  commands: SlashCommandInfo[]
  commandUsage: CommandUsage
  onPatchChat: (id: string, patch: Partial<ChatMeta>) => void
  draft: string
  setDraft: (v: string) => void
  attachments: Attachment[]
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>
  composerRef: React.RefObject<HTMLTextAreaElement | null>
  onSend: (text: string, attachments: Attachment[]) => void
  onDecide: (d: 'allow' | 'always' | 'deny') => void
  onAnswer: (a: Record<string, string> | null) => void
  onInterrupt: () => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // Follow the bottom while streaming, but don't yank the view if the user
    // has scrolled up to read something earlier.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [items, chat.status])

  // Grow the composer to fit what's typed (soft-wrapped, no inserted newlines);
  // CSS caps the height and lets it scroll past that.
  useLayoutEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft, composerRef])

  // Large pastes collapse to a "[Pasted text #n +N lines]" placeholder the user
  // sees inline; the full content is held here and spliced back in on send.
  const [pastes, setPastes] = useState<{ token: string; content: string }[]>([])
  const pasteSeq = useRef(0)

  const submit = (): void => {
    let text = draft.trim()
    for (const p of pastes) {
      if (text.includes(p.token)) text = text.split(p.token).join(p.content)
    }
    if (!text && attachments.length === 0) return
    onSend(text, attachments)
    setDraft('')
    setAttachments([])
    setPastes([])
  }

  const onComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const text = e.clipboardData.getData('text')
    const lineCount = text.split('\n').length
    // Small pastes flow straight in and soft-wrap; only big blobs get collapsed.
    if (lineCount <= PASTE_LINE_THRESHOLD && text.length <= PASTE_CHAR_THRESHOLD) return
    e.preventDefault()
    const measure = lineCount > 1 ? `+${lineCount} lines` : `+${text.length} chars`
    const token = `[Pasted text #${++pasteSeq.current} ${measure}]`
    setPastes((prev) => [...prev, { token, content: text }])
    const el = e.currentTarget
    const start = el.selectionStart ?? draft.length
    const end = el.selectionEnd ?? draft.length
    setDraft(draft.slice(0, start) + token + draft.slice(end))
    // Put the caret just past the inserted placeholder once React re-renders.
    requestAnimationFrame(() => {
      const pos = start + token.length
      el.setSelectionRange(pos, pos)
    })
  }

  // Attachments: dropped or picked files are resolved to Attachment
  // descriptors (stat'd on the main side) and merged into the pending list.
  // Oversized images are rejected rather than embedded — everything else
  // (including any non-image file, however large) is just path-referenced,
  // so no size check applies to it.
  const [dragActive, setDragActive] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const dragDepth = useRef(0)

  const addPaths = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return
    const described = await sb.describeAttachments(paths)
    setAttachments((prev) => {
      const existing = new Set(prev.map((a) => a.path))
      const fresh = described.filter((a) => !existing.has(a.path))
      const tooBig = fresh.filter((a) => a.isImage && a.sizeBytes > MAX_IMAGE_BYTES)
      const ok = fresh.filter((a) => !tooBig.includes(a))
      setAttachError(
        tooBig.length > 0
          ? `${tooBig.map((a) => a.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} too large to attach (max 5MB)`
          : null
      )
      return ok.length > 0 ? [...prev, ...ok] : prev
    })
  }

  const removeAttachment = (path: string): void => {
    setAttachments((prev) => prev.filter((a) => a.path !== path))
  }

  const onDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
  }
  const onDragEnter = (e: React.DragEvent): void => {
    e.preventDefault()
    if (!e.dataTransfer.types.includes('Files')) return
    dragDepth.current += 1
    setDragActive(true)
  }
  const onDragLeave = (e: React.DragEvent): void => {
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    const paths = Array.from(e.dataTransfer.files).map((f) => sb.getPathForFile(f))
    void addPaths(paths)
  }

  // Command popover: opens while the draft is a bare "/command" prefix (no
  // space yet), Esc dismisses until the slash is deleted.
  const [cmdDismissed, setCmdDismissed] = useState(false)
  const [cmdSel, setCmdSel] = useState(0)
  const cmdFilter = draft.startsWith('/') && !draft.includes(' ') ? draft.slice(1).toLowerCase() : null
  const cmdOpen = cmdFilter !== null && !cmdDismissed

  const cmdHits = useMemo(() => {
    if (!cmdOpen || cmdFilter === null) return []
    return commands
      .filter(
        (c) =>
          c.name.toLowerCase().includes(cmdFilter) ||
          c.description.toLowerCase().includes(cmdFilter)
      )
      .sort((a, b) => {
        // Prefix matches first, so typing stays predictable. Then the "memory":
        // most-used, then most-recently-used, then alphabetical. A bare "/" has
        // an empty filter (all names tie on prefix), so top-used surface first.
        const pa = Number(a.name.toLowerCase().startsWith(cmdFilter))
        const pb = Number(b.name.toLowerCase().startsWith(cmdFilter))
        if (pa !== pb) return pb - pa
        const ua = commandUsage[a.name]
        const ub = commandUsage[b.name]
        if ((ub?.count ?? 0) !== (ua?.count ?? 0)) return (ub?.count ?? 0) - (ua?.count ?? 0)
        if ((ub?.lastUsed ?? 0) !== (ua?.lastUsed ?? 0))
          return (ub?.lastUsed ?? 0) - (ua?.lastUsed ?? 0)
        return a.name.localeCompare(b.name)
      })
      .slice(0, 10)
  }, [cmdOpen, cmdFilter, commands, commandUsage])

  useEffect(() => setCmdSel(0), [cmdFilter])
  useEffect(() => {
    if (!draft.startsWith('/')) setCmdDismissed(false)
  }, [draft])

  const pickCommand = (c: SlashCommandInfo): void => {
    setDraft(`/${c.name} `)
    composerRef.current?.focus()
  }

  // Syntax helper: once a command is chosen/typed, show its expected arguments.
  const activeCommand = useMemo(() => {
    if (!draft.startsWith('/')) return undefined
    const typed = draft.slice(1).split(' ')[0].toLowerCase()
    return commands.find((c) => c.name.toLowerCase() === typed)
  }, [draft, commands])

  const composerKeyDown = (e: React.KeyboardEvent): void => {
    if (cmdOpen && cmdHits.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCmdSel((s) => Math.min(s + 1, cmdHits.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCmdSel((s) => Math.max(s - 1, 0))
        return
      }
      if (e.key === 'Escape') {
        setCmdDismissed(true)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        pickCommand(cmdHits[cmdSel])
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const chosen = cmdHits[cmdSel]
        // Enter on the exactly-typed command runs it; otherwise it completes.
        e.preventDefault()
        if (chosen.name.toLowerCase() === cmdFilter) submit()
        else pickCommand(chosen)
        return
      }
    }
    // Enter sends; Shift+Enter drops in a real newline. Plain wrapping is visual
    // only (the textarea soft-wraps — no newline is inserted into the text).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <section
      className="chat"
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragActive && (
        <div className="drop-overlay">
          <span>Drop to attach</span>
        </div>
      )}
      <div className="chat-head drag">
        <ProjectAvatar cwd={chat.cwd} hueKey={chat.repoRoot} />
        <div className="chat-head-info">
          <div className="chat-head-name">{chat.title}</div>
          <div className="chat-head-sub">
            <span className="chat-head-path" title={chat.cwd}>
              {shortPath(chat.cwd)}
            </span>
            {chat.isWorktree && chat.repoRoot && (
              <span className="wt-badge" title="A separate working copy — changes here can’t collide with other chats in this repo">
                ⑂ copy of {chat.repoRoot.split('/').pop()}
              </span>
            )}
          </div>
        </div>
        <div className="head-actions no-drag">
          <ModeSwitcher chat={chat} onPatchChat={onPatchChat} />
          <select
            className="model-select"
            title="Which Claude model this chat uses"
            value={chat.preferredModel ?? ''}
            onChange={(e) => {
              const model = e.target.value || undefined
              onPatchChat(chat.id, { preferredModel: model })
              void sb.setModel(chat.id, model)
            }}
          >
            {/* The engine's own "default" row becomes our empty-value option. */}
            <option value="">{models.find((m) => m.id === 'default')?.label ?? 'Default model'}</option>
            {models
              .filter((m) => m.id !== 'default')
              .map((m) => (
                <option key={m.id} value={m.id} title={m.description}>
                  {m.label}
                </option>
              ))}
            {chat.preferredModel && !models.some((m) => m.id === chat.preferredModel) && (
              <option value={chat.preferredModel}>{chat.preferredModel}</option>
            )}
          </select>
          {chat.status === 'working' && (
            <button className="icon-btn" onClick={onInterrupt} title="Stop what Claude is doing">
              ◼ Stop
            </button>
          )}
        </div>
      </div>

      <div className="thread" ref={scrollRef}>
        <div className="thread-inner">
          {items.length === 0 && (
            <p className="thread-empty">
              This chat lives in <code>{shortPath(chat.cwd)}</code>. Ask Claude anything about this
              project — it can read the code, make changes, and run commands, and it will ask before
              doing anything that needs your OK.
            </p>
          )}
          {items.map((item) => (
            <ThreadItemView
              key={item.id}
              item={item}
              cwd={chat.cwd}
              onDecide={onDecide}
              onAnswer={onAnswer}
            />
          ))}
          {chat.status === 'working' && (
            <div className="working">
              <span className="spinner" />
              {chat.statusLine || 'Working…'}
            </div>
          )}
        </div>
      </div>

      <div className="composer">
        {cmdOpen && cmdHits.length > 0 && (
          <div className="cmd-pop" role="listbox" aria-label="Commands">
            {cmdHits.map((c, i) => (
              <button
                key={c.name}
                className={`cmd-row ${i === cmdSel ? 'selected' : ''}`}
                role="option"
                aria-selected={i === cmdSel}
                onMouseEnter={() => setCmdSel(i)}
                onClick={() => pickCommand(c)}
              >
                <span className="cmd-name">/{c.name}</span>
                {c.argumentHint && <span className="cmd-hint">{c.argumentHint}</span>}
                {(commandUsage[c.name]?.count ?? 0) > 0 && (
                  <span className="cmd-recent" title="You use this often">
                    ★
                  </span>
                )}
                <span className="cmd-desc">{c.description}</span>
              </button>
            ))}
          </div>
        )}
        {activeCommand?.argumentHint && !cmdOpen && (
          <div className="cmd-helper">
            <span className="cmd-name">/{activeCommand.name}</span>
            <span className="cmd-hint">{activeCommand.argumentHint}</span>
            <span className="cmd-desc">{activeCommand.description}</span>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachment-row">
            {attachments.map((a) => (
              <div className="attachment-chip" key={a.path} title={a.name}>
                {a.isImage ? (
                  <img className="attachment-thumb" src={`file://${a.path}`} alt="" />
                ) : (
                  <span className="attachment-thumb attachment-generic">📄</span>
                )}
                <span className="attachment-name">{a.name}</span>
                <button
                  className="attachment-remove"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => removeAttachment(a.path)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {attachError && <div className="attach-error">{attachError}</div>}
        <div className="composer-inner">
          <button
            className="attach-btn"
            title="Attach files"
            aria-label="Attach files"
            onClick={() => {
              void sb.chooseAttachments().then(addPaths)
            }}
          >
            +
          </button>
          <button
            className="slash-btn"
            title="Commands (⌘/)"
            aria-label="Show commands"
            onClick={() => {
              setDraft('/')
              setCmdDismissed(false)
              composerRef.current?.focus()
            }}
          >
            /
          </button>
          <textarea
            ref={composerRef}
            className="composer-textarea"
            value={draft}
            rows={1}
            placeholder={items.length === 0 ? 'What would you like Claude to do?' : 'Reply to Claude…'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={composerKeyDown}
            onPaste={onComposerPaste}
          />
          <button className="send" aria-label="Send" onClick={submit}>
            ↑
          </button>
        </div>
      </div>
    </section>
  )
}

// Ambient context-window meter with a compact button. The fill reads how full
// the window is; color escalates as it fills so the cue to compact lives on the
// control that acts. Clicking compacts; the fill then animates down to the new
// level, driven by the real before/after token counts from the compaction event.
function UsageMeter({
  chat,
  compaction
}: {
  chat: ChatMeta
  compaction: { chatId: string; phase: 'start' | 'done' | 'failed'; at: number } | null
}): React.JSX.Element {
  const [compacting, setCompacting] = useState(false)
  const [draining, setDraining] = useState(false)
  const lastAt = useRef(compaction?.at ?? 0)

  // Follow compaction progress from the engine. `start` covers the engine's own
  // auto-compact too (no click), so the meter shimmers either way; `done` eases
  // the fill down with the deliberate drain curve; `failed` just stops.
  useEffect(() => {
    if (!compaction || compaction.at === lastAt.current) return undefined
    lastAt.current = compaction.at
    if (compaction.phase === 'start') {
      setCompacting(true)
      return undefined
    }
    setCompacting(false)
    if (compaction.phase === 'done') {
      // Hold the drain curve open past the "done" signal — the fill only drops
      // once the next turn's smaller usage lands, a beat later.
      setDraining(true)
      const t = setTimeout(() => setDraining(false), 1800)
      return () => clearTimeout(t)
    }
    return undefined
  }, [compaction])

  // Safety net: if the boundary event never arrives, don't spin forever.
  useEffect(() => {
    if (!compacting) return undefined
    const t = setTimeout(() => setCompacting(false), 30000)
    return () => clearTimeout(t)
  }, [compacting])

  const fmt = (n: number): string =>
    n >= 1_000_000
      ? (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
      : n >= 1_000
        ? Math.round(n / 1_000) + 'K'
        : String(n)

  const tokens = chat.contextTokens ?? 0
  const windowSize = chat.contextWindow ?? 1_000_000
  const ratio = Math.min(1, Math.max(0, tokens / windowSize))
  const pct = Math.round(ratio * 100)
  const level = ratio >= 0.88 ? 'full' : ratio >= 0.7 ? 'warn' : 'calm'
  // Always a clear text label — never an icon-only control, which reads as a
  // close/delete affordance rather than an action.
  const label = compacting ? 'Compacting…' : level === 'full' ? 'Compact now' : 'Compact'

  return (
    <div className={`usage ${level}${compacting ? ' compacting' : ''}${draining ? ' draining' : ''}`}>
      <div
        className="usage-bar"
        title={`${fmt(tokens)} of ${fmt(windowSize)} tokens used · ${pct}%`}
      >
        <div className="usage-fill" style={{ width: `${Math.max(2, ratio * 100)}%` }} />
      </div>
      <span className="usage-pct">{pct}%</span>
      <button
        className="usage-compact"
        disabled={compacting || tokens === 0}
        onClick={() => {
          if (compacting) return
          setCompacting(true)
          void sb.compact(chat.id)
        }}
        title="Compact the conversation to free up the context window"
      >
        <span className="usage-compact-label">{label}</span>
      </button>
    </div>
  )
}

function ModeSwitcher({
  chat,
  onPatchChat
}: {
  chat: ChatMeta
  onPatchChat: (id: string, patch: Partial<ChatMeta>) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const current =
    MODE_CHOICES.find((m) => m.id === (chat.permissionMode ?? 'default')) ?? MODE_CHOICES[0]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="mode-wrap" ref={wrapRef}>
      <button
        className="mode-btn"
        title="How much Claude checks with you before acting"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`mode-dot ${current.id}`} />
        {current.label}
        <span className="mode-caret">▾</span>
      </button>
      {open && (
        <div className="mode-pop" role="menu">
          <div className="mode-pop-title">When Claude acts</div>
          {MODE_CHOICES.map((m) => (
            <button
              key={m.id}
              className={`mode-option ${m.danger ? 'danger' : ''}`}
              aria-current={m.id === current.id}
              onClick={() => {
                onPatchChat(chat.id, { permissionMode: m.id })
                void sb.setPermissionMode(chat.id, m.id)
                setOpen(false)
              }}
            >
              <span className={`mode-dot ${m.id}`} />
              <span className="mode-option-label">
                {m.label}
                {m.id === 'default' && <span className="mode-rec"> · recommended</span>}
              </span>
              <span className="mode-option-desc">{m.desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ThreadItemView({
  item,
  cwd,
  onDecide,
  onAnswer
}: {
  item: ThreadItem
  cwd: string
  onDecide: (d: 'allow' | 'always' | 'deny') => void
  onAnswer: (a: Record<string, string> | null) => void
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user">
          {item.attachments && item.attachments.length > 0 && (
            <div className="attachment-row">
              {item.attachments.map((a) => (
                <div className="attachment-chip" key={a.path} title={a.name}>
                  {a.isImage ? (
                    <img className="attachment-thumb" src={`file://${a.path}`} alt="" />
                  ) : (
                    <span className="attachment-thumb attachment-generic">📄</span>
                  )}
                  <span className="attachment-name">{a.name}</span>
                </div>
              ))}
            </div>
          )}
          {item.text && <div className="bubble">{linkifyText(item.text)}</div>}
        </div>
      )
    case 'claude':
      return (
        <div className="msg-claude">
          <span className="spark-dot">✳</span>
          <div className="body markdown">
            <Markdown text={item.text} cwd={cwd} />
          </div>
        </div>
      )
    case 'step':
      return (
        <div className="steps">
          <div className="step">
            <span className="ico">·</span>
            {item.path ? (
              <FileLink path={item.path} cwd={cwd}>
                {item.summary}
              </FileLink>
            ) : (
              <span>{item.summary}</span>
            )}
          </div>
        </div>
      )
    case 'agent':
      return <AgentCard item={item} />
    case 'tasks':
      return <TaskListCard items={item.items} />
    case 'ask':
      return <AskCard item={item} onDecide={onDecide} />
    case 'question':
      return <QuestionCard item={item} onAnswer={onAnswer} />
    case 'info':
      return <div className="thread-info">{item.text}</div>
    case 'error':
      return <div className="thread-info error">{item.text}</div>
    default:
      return null
  }
}

// Claude's task list as a live checklist. Items flip to checked as they finish;
// the one in progress shows its present-continuous label and a pulsing dot.
function TaskListCard({ items }: { items: TaskEntry[] }): React.JSX.Element {
  const done = items.filter((t) => t.status === 'completed').length
  const allDone = items.length > 0 && done === items.length
  const statusById = new Map(items.map((t) => [t.id, t.status]))
  return (
    <div className="tasklist">
      <div className="tasklist-head">
        <span className="tasklist-title">Tasks</span>
        <span className={`tasklist-count ${allDone ? 'done' : ''}`}>
          {done}/{items.length}
        </span>
      </div>
      <ul className="tasklist-items">
        {items.map((t) => {
          // A dependency only blocks until it finishes — the engine leaves the
          // blockedBy id in place after the blocker completes, so filter those out.
          const activeBlockers = (t.blockedBy ?? []).filter((id) => statusById.get(id) !== 'completed')
          const blocked = t.status !== 'completed' && activeBlockers.length > 0
          const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject
          return (
            <li key={t.id} className={`task task-${t.status}${blocked ? ' task-blocked' : ''}`}>
              <span className="task-mark" aria-hidden />
              <span className="task-text">
                {label}
                {blocked && (
                  <span className="task-blocked-note">
                    blocked by {activeBlockers.map((b) => `#${b}`).join(', ')}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// A subagent's live card: what it's working on, what it's doing right now,
// and — once finished — a click-to-expand log of everything it did.
function AgentCard({ item }: { item: AgentItem }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [, setTick] = useState(0)
  const running = item.status === 'running'

  // Tick the elapsed readout only while this agent runs.
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  const elapsed = formatElapsed((item.endedAt ?? Date.now()) - item.startedAt)
  // Backgrounded agents don't stream their steps — task_progress reports a
  // count instead, so show whichever signal knows more.
  const stepTotal = Math.max(item.steps.length, item.toolUses ?? 0)
  const stepCount = `${stepTotal} step${stepTotal === 1 ? '' : 's'}`

  return (
    <div
      className={`agent-card ${item.status} ${expanded ? 'open' : ''}`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={() => setExpanded((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setExpanded((v) => !v)
        }
      }}
    >
      <div className="agent-head">
        {running ? (
          <span className="agent-dot" />
        ) : (
          <span className="agent-mark">
            {item.status === 'error' ? '⚠' : item.status === 'interrupted' ? '◼' : '✓'}
          </span>
        )}
        <span className="agent-title">{item.description}</span>
        {item.agentType && <span className="agent-chip">{item.agentType}</span>}
        <span className="agent-elapsed">{running ? elapsed : `${stepCount} · ${elapsed}`}</span>
      </div>
      {running && item.activity && (
        <div className="agent-activity">
          <span key={item.activity} className="agent-activity-text">
            {item.activity}
          </span>
        </div>
      )}
      <div className="agent-details" aria-hidden={!expanded}>
        <div className="agent-details-inner">
          {item.steps.length === 0 && <div className="agent-step faint">No steps yet</div>}
          {item.steps.map((s, i) => (
            <div key={i} className="agent-step">
              <span className="ico">·</span>
              <span>{s.summary}</span>
            </div>
          ))}
          {!running && item.resultText && <div className="agent-result">{item.resultText}</div>}
        </div>
      </div>
    </div>
  )
}

function AskCard({
  item,
  onDecide
}: {
  item: AskItem
  onDecide: (d: 'allow' | 'always' | 'deny') => void
}): React.JSX.Element {
  return (
    <div className={`ask ${item.resolved ? 'resolved' : ''}`}>
      <div className="ask-title">{item.title}</div>
      <div className="ask-body">{item.body}</div>
      {item.note && (
        <div className="ask-note">
          <code>{item.note}</code>
        </div>
      )}
      {item.resolved ? (
        <div className="ask-resolved">
          {item.resolved === 'denied'
            ? 'You said not now'
            : item.resolved === 'always-allowed'
              ? 'Allowed — Claude won’t ask again for this'
              : 'Allowed'}
        </div>
      ) : (
        <div className="ask-actions">
          <button className="btn primary" onClick={() => onDecide('allow')}>
            <kbd>1</kbd>Allow
          </button>
          <button className="btn" onClick={() => onDecide('always')}>
            <kbd>2</kbd>Always allow this
          </button>
          <button className="btn" onClick={() => onDecide('deny')}>
            <kbd>3</kbd>Not now
          </button>
        </div>
      )}
    </div>
  )
}

function BacklogPane({
  backlog,
  onOpenChat
}: {
  backlog: BacklogEntry[]
  onOpenChat: (chatId: string) => void
}): React.JSX.Element {
  return (
    <section className="chat backlog">
      <div className="chat-head drag">
        <span className="approvals-icon big">⚡</span>
        <div className="chat-head-info">
          <div className="chat-head-name">Approvals</div>
          <div className="chat-head-sub sans">
            {backlog.length === 0
              ? 'Nothing waiting on you'
              : `${backlog.length} waiting — number keys act on the top one`}
          </div>
        </div>
      </div>
      <div className="backlog-scroll">
        <div className="backlog-inner">
          {backlog.length === 0 && (
            <div className="backlog-empty">
              <div className="backlog-check">✓</div>
              <p>All caught up.</p>
            </div>
          )}
          {backlog.map((entry) => (
            <div className="backlog-entry" key={entry.item.id}>
              <button
                className="backlog-chat"
                title="Open this chat"
                onClick={() => onOpenChat(entry.chatId)}
              >
                <ProjectAvatar cwd={entry.cwd} hueKey={entry.repoRoot} />
                <span className="backlog-chat-title">{entry.chatTitle}</span>
                <span className="backlog-chat-path">{shortPath(entry.cwd)}</span>
              </button>
              {entry.item.kind === 'ask' && (
                <AskCard
                  item={entry.item}
                  onDecide={(d) => void sb.respondPermission(entry.chatId, d)}
                />
              )}
              {entry.item.kind === 'question' && (
                <QuestionCard
                  item={entry.item}
                  onAnswer={(a) => void sb.respondQuestion(entry.chatId, a)}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function QuestionCard({
  item,
  onAnswer
}: {
  item: QuestionItem
  onAnswer: (a: Record<string, string> | null) => void
}): React.JSX.Element {
  // Selections while composing a multi-question / multi-select answer.
  const [sel, setSel] = useState<Record<string, string[]>>({})
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({})
  const [otherText, setOtherText] = useState<Record<string, string>>({})

  const resolved = Boolean(item.answers) || item.skipped
  // The common case: one question, pick one option → answer on click.
  const instant = item.questions.length === 1 && !item.questions[0].multiSelect

  const choose = (q: ChatQuestion, label: string): void => {
    if (instant) {
      onAnswer({ [q.question]: label })
      return
    }
    setSel((prev) => {
      const cur = prev[q.question] ?? []
      const next = q.multiSelect
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label]
      return { ...prev, [q.question]: next }
    })
  }

  const submitOther = (q: ChatQuestion): void => {
    const text = (otherText[q.question] ?? '').trim()
    if (!text) return
    if (instant) {
      onAnswer({ [q.question]: text })
      return
    }
    setSel((prev) => ({ ...prev, [q.question]: [text] }))
    setOtherOpen((prev) => ({ ...prev, [q.question]: false }))
  }

  const allAnswered = item.questions.every((q) => (sel[q.question]?.length ?? 0) > 0)
  const submitAll = (): void =>
    onAnswer(Object.fromEntries(item.questions.map((q) => [q.question, (sel[q.question] ?? []).join(', ')])))

  return (
    <div className={`ask question ${resolved ? 'resolved' : ''}`}>
      <div className="ask-title">Claude has a question</div>
      {item.questions.map((q, qi) => (
        <div className="q-block" key={q.question}>
          {q.header && <span className="q-header">{q.header}</span>}
          <div className="ask-body">{q.question}</div>
          {resolved ? (
            <div className="ask-resolved">
              {item.skipped ? 'You skipped this' : `You chose: ${item.answers?.[q.question] ?? '—'}`}
            </div>
          ) : (
            <div className="q-options">
              {q.options.map((o, oi) => {
                const chosen = (sel[q.question] ?? []).includes(o.label)
                return (
                  <button
                    key={o.label}
                    className={`q-option ${chosen ? 'chosen' : ''}`}
                    title={o.description}
                    onClick={() => choose(q, o.label)}
                  >
                    {instant && qi === 0 && <kbd>{oi + 1}</kbd>}
                    <span className="q-option-label">{o.label}</span>
                    {o.description && <span className="q-option-desc">{o.description}</span>}
                  </button>
                )
              })}
              {otherOpen[q.question] ? (
                <div className="q-other-row">
                  <input
                    autoFocus
                    placeholder="Type your own answer…"
                    value={otherText[q.question] ?? ''}
                    onChange={(e) => setOtherText((p) => ({ ...p, [q.question]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitOther(q)
                    }}
                  />
                  <button className="btn primary" onClick={() => submitOther(q)}>
                    {instant ? 'Answer' : 'Set'}
                  </button>
                </div>
              ) : (
                <button
                  className="q-option other"
                  onClick={() => setOtherOpen((p) => ({ ...p, [q.question]: true }))}
                >
                  <span className="q-option-label">Other…</span>
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {!resolved && (
        <div className="ask-actions">
          {!instant && (
            <button className="btn primary" disabled={!allAnswered} onClick={submitAll}>
              Send answers
            </button>
          )}
          <button className="btn quiet" onClick={() => onAnswer(null)}>
            Skip
          </button>
        </div>
      )}
    </div>
  )
}

function DetailsPanel({
  chat,
  info,
  compaction
}: {
  chat: ChatMeta
  info: ProjectInfo | null
  compaction: { chatId: string; phase: 'start' | 'done' | 'failed'; at: number } | null
}): React.JSX.Element {
  const [editors, setEditors] = useState<EditorApp[]>([])

  useEffect(() => {
    void sb.listEditors().then(setEditors)
  }, [])

  return (
    <aside className="details">
      <div className="d-section">
        <h3>Details</h3>
        <dl className="kv">
          <dt>Folder</dt>
          <dd className="mono">{shortPath(chat.cwd)}</dd>
          {info?.branch && (
            <>
              <dt>Branch</dt>
              <dd className="mono">{info.branch}</dd>
            </>
          )}
          {chat.model && (
            <>
              <dt>Model</dt>
              <dd>{chat.model}</dd>
            </>
          )}
          {chat.costUsd != null && (
            <>
              <dt>Cost so far</dt>
              <dd>${chat.costUsd.toFixed(2)}</dd>
            </>
          )}
        </dl>
        <div className="open-row">
          <button
            className="open-btn"
            title="Show this folder in Finder"
            onClick={() => void sb.revealInFinder(chat.cwd)}
          >
            Reveal in Finder
          </button>
          {editors.map((ed) => (
            <button
              className="open-btn"
              key={ed.name}
              title={`Open this folder in ${ed.name}`}
              onClick={() => void sb.openInEditor(chat.cwd, ed.name)}
            >
              {ed.name}
            </button>
          ))}
        </div>
      </div>
      <div className="d-section">
        <h3>Context</h3>
        <UsageMeter chat={chat} compaction={compaction} />
      </div>
      <div className="d-section">
        <h3>Project shortcuts</h3>
        {info && info.skills.length > 0 ? (
          <>
            <div className="shortcut-list">
              {info.skills.map((s) => (
                <div className="sk" key={s.source + s.name}>
                  <span className="slash">/{s.name}</span>
                  <span className="desc">{s.source}</span>
                </div>
              ))}
            </div>
            <p className="d-hint">Type “/” in the chat to use one.</p>
          </>
        ) : (
          <p className="d-hint">
            No shortcuts yet — ask Claude to create one for anything you do often in this project.
          </p>
        )}
      </div>
      <ConnectedApps chat={chat} info={info} />
    </aside>
  )
}

// Prefers the running session's live report (which includes claude.ai
// connectors — invisible on disk); falls back to what's configured in
// .mcp.json / ~/.claude.json before the chat starts.
function ConnectedApps({ chat, info }: { chat: ChatMeta; info: ProjectInfo | null }): React.JSX.Element {
  const friendly = (name: string): string => name.replace(/^claude\.ai /, '').replace(/^plugin:/, '')
  const live = chat.mcp?.filter((s) => s.status !== 'disabled')

  let body: React.ReactNode
  if (live && live.length > 0) {
    const connected = live.filter((s) => s.status === 'connected')
    const waiting = live.filter((s) => s.status === 'needs-auth' || s.status === 'pending')
    const failed = live.filter((s) => s.status === 'failed')
    body = (
      <>
        {connected.map((s) => (
          <span className="chip" key={s.name} title={s.name}>
            {friendly(s.name)}
          </span>
        ))}
        {failed.map((s) => (
          <span className="chip err" key={s.name} title={`${s.name} couldn’t connect`}>
            {friendly(s.name)} !
          </span>
        ))}
        {waiting.length > 0 && (
          <span className="chip off" title={waiting.map((s) => friendly(s.name)).join(', ')}>
            {waiting.length} not signed in
          </span>
        )}
      </>
    )
  } else if (info && info.mcpServers.length > 0) {
    body = (
      <>
        {info.mcpServers.map((m) => (
          <span className="chip" key={m}>
            {m}
          </span>
        ))}
      </>
    )
  } else {
    body = <span className="chip off">None yet</span>
  }

  return (
    <div className="d-section">
      <h3>Connected apps</h3>
      <div className="chips">
        {body}
        <span className={`chip ${info?.hasClaudeMd ? '' : 'off'}`}>
          Project notes {info?.hasClaudeMd ? '✓' : '—'}
        </span>
      </div>
      {(!live || live.length === 0) && (
        <p className="d-hint">Your claude.ai connectors appear once the chat starts.</p>
      )}
    </div>
  )
}

function Onboarding({ onAuthed }: { onAuthed: (a: AuthStatus) => void }): React.JSX.Element {
  const [mode, setMode] = useState<'choose' | 'waiting' | 'key'>('choose')
  const [key, setKey] = useState('')
  const [keyError, setKeyError] = useState(false)

  const signIn = (): void => {
    void sb.openLogin()
    setMode('waiting')
  }

  const saveKey = async (): Promise<void> => {
    const trimmed = key.trim()
    if (!trimmed.startsWith('sk-ant-')) {
      setKeyError(true)
      return
    }
    const status = await sb.setApiKey(trimmed)
    onAuthed(status)
  }

  return (
    <div className="app drag onboarding">
      <div className="onboard-inner no-drag">
        <div className="empty-spark">✳</div>
        <h2>Welcome to Switchboard</h2>
        <p>
          Switchboard runs <strong>Claude Code</strong> — Anthropic’s coding agent — as friendly
          chats, one per project. Connect your Claude account to get started.
        </p>

        {mode === 'choose' && (
          <div className="onboard-actions">
            <button className="btn primary big" onClick={signIn}>
              Sign in with your Claude account
            </button>
            <button className="btn quiet" onClick={() => setMode('key')}>
              Use an API key instead
            </button>
          </div>
        )}

        {mode === 'waiting' && (
          <div className="onboard-waiting">
            <span className="spinner" />
            <p>
              Finish signing in from the Terminal window that just opened — Switchboard will notice
              automatically.
            </p>
            <button className="btn quiet" onClick={signIn}>
              Reopen the sign-in window
            </button>
          </div>
        )}

        {mode === 'key' && (
          <div className="onboard-key">
            <input
              autoFocus
              type="password"
              placeholder="sk-ant-…"
              value={key}
              onChange={(e) => {
                setKey(e.target.value)
                setKeyError(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveKey()
              }}
            />
            {keyError && <p className="onboard-error">That doesn’t look like an Anthropic API key.</p>}
            <div className="onboard-actions">
              <button className="btn primary" disabled={!key.trim()} onClick={() => void saveKey()}>
                Save key
              </button>
              <button className="btn quiet" onClick={() => setMode('choose')}>
                Back
              </button>
            </div>
            <p className="onboard-hint">
              Stored encrypted with your Mac’s keychain, only on this computer. Get a key at
              platform.claude.com.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyState({ onCreated }: { onCreated: (meta: ChatMeta) => void }): React.JSX.Element {
  return (
    <section className="chat empty drag">
      <div className="empty-inner no-drag">
        <div className="empty-spark">✳</div>
        <h2>Welcome to Switchboard</h2>
        <p>
          Every chat lives in a project folder. Claude can read the code, make changes, and run
          commands there — and it asks before doing anything that needs your OK.
        </p>
        <NewChatControl
          onCreated={onCreated}
          triggerClass="btn primary big"
          triggerLabel="Start your first chat"
        />
      </div>
    </section>
  )
}
