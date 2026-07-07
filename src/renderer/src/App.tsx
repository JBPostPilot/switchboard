import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMeta, ProjectInfo, ThreadItem } from '../../shared/types'

const sb = window.switchboard

const MODEL_CHOICES = [
  { id: '', label: 'Default model' },
  { id: 'opus', label: 'Opus — most capable' },
  { id: 'sonnet', label: 'Sonnet — fast + smart' },
  { id: 'haiku', label: 'Haiku — fastest' }
]

const HANDY_COMMANDS = [
  { cmd: '/init', desc: 'Teach Claude this project — writes project notes it reads every chat' },
  { cmd: '/compact', desc: 'Tidy a long chat so Claude stays sharp' },
  { cmd: '/review', desc: 'Review a pull request' }
]

function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: (props) => <a {...props} target="_blank" rel="noreferrer" />
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~')
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

export default function App(): React.JSX.Element {
  const [chats, setChats] = useState<ChatMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [items, setItems] = useState<ThreadItem[]>([])
  const [rawMode, setRawMode] = useState(false)
  const [raw, setRaw] = useState<unknown[]>([])
  const [info, setInfo] = useState<ProjectInfo | null>(null)
  const [draft, setDraft] = useState('')
  const composerRef = useRef<HTMLInputElement>(null)
  const currentIdRef = useRef(currentId)
  currentIdRef.current = currentId

  const current = chats.find((c) => c.id === currentId) ?? null

  useEffect(() => {
    void sb.listChats().then((list) => {
      setChats(list)
      if (list.length > 0) setCurrentId(list[0].id)
    })
  }, [])

  useEffect(() => {
    return sb.onChatEvent((event) => {
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
      if (event.raw) {
        const entry = event.raw
        setRaw((prev) => [...prev, entry])
      }
    })
  }, [])

  useEffect(() => {
    if (!currentId) return
    setItems([])
    setRaw([])
    setRawMode(false)
    setDraft('')
    void sb.getItems(currentId).then(setItems)
    void sb.getRaw(currentId).then(setRaw)
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

  const send = useCallback(
    (text: string) => {
      if (currentId) void sb.sendMessage(currentId, text)
    },
    [currentId]
  )

  const pendingAsk = useMemo(
    () => items.findLast((i) => i.kind === 'ask' && !i.resolved) as Extract<ThreadItem, { kind: 'ask' }> | undefined,
    [items]
  )

  const decide = useCallback(
    (decision: 'allow' | 'always' | 'deny') => {
      if (currentId && pendingAsk) void sb.respondPermission(currentId, decision)
    },
    [currentId, pendingAsk]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!pendingAsk) return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' && (target as HTMLInputElement).value !== '') return
      if (e.key === '1') decide('allow')
      if (e.key === '2') decide('always')
      if (e.key === '3') decide('deny')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingAsk, decide])

  return (
    <div className="app">
      <Sidebar chats={chats} currentId={currentId} onSelect={setCurrentId} onCreated={chatCreated} />
      {current ? (
        <>
          <ChatPane
            chat={current}
            items={items}
            raw={raw}
            rawMode={rawMode}
            draft={draft}
            setDraft={setDraft}
            composerRef={composerRef}
            onToggleRaw={() => setRawMode((v) => !v)}
            onSend={send}
            onDecide={decide}
            onInterrupt={() => void sb.interrupt(current.id)}
          />
          <DetailsPanel
            chat={current}
            info={info}
            onUseCommand={(cmd) => {
              setDraft(cmd + ' ')
              composerRef.current?.focus()
            }}
          />
        </>
      ) : (
        <EmptyState onCreated={chatCreated} />
      )}
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
                Makes a new folder in {root.replace(/^\/Users\/[^/]+/, '~')}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Sidebar({
  chats,
  currentId,
  onSelect,
  onCreated
}: {
  chats: ChatMeta[]
  currentId: string | null
  onSelect: (id: string) => void
  onCreated: (meta: ChatMeta) => void
}): React.JSX.Element {
  return (
    <aside className="rail">
      <div className="rail-top drag">
        <span className="wordmark">
          <span className="spark">✳</span> Switchboard
        </span>
      </div>
      <div className="rail-list">
        {STATUS_GROUPS.map((group) => {
          const inGroup = chats
            .filter((c) => group.key.includes(c.status))
            .sort((a, b) => b.updatedAt - a.updatedAt)
          if (inGroup.length === 0) return null
          return (
            <div key={group.label}>
              <div className={`rail-group-label ${group.cls}`}>{group.label}</div>
              {inGroup.map((c) => (
                <button
                  key={c.id}
                  className="chat-item"
                  aria-current={c.id === currentId}
                  onClick={() => onSelect(c.id)}
                >
                  <span className="avatar">{c.title === 'New chat' ? '＋' : c.title.slice(0, 1).toUpperCase()}</span>
                  <span className="chat-name">{c.title}</span>
                  <span className="chat-time">{timeAgo(c.updatedAt)}</span>
                  <span className={`chat-preview ${c.status === 'needs-you' || c.status === 'error' ? 'attn' : c.status === 'working' ? 'work' : ''}`}>
                    {c.statusLine || c.preview}
                  </span>
                  {c.status === 'needs-you' && <span className="badge" />}
                  {c.status === 'working' && <span className="badge work" />}
                </button>
              ))}
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
  raw,
  rawMode,
  draft,
  setDraft,
  composerRef,
  onToggleRaw,
  onSend,
  onDecide,
  onInterrupt
}: {
  chat: ChatMeta
  items: ThreadItem[]
  raw: unknown[]
  rawMode: boolean
  draft: string
  setDraft: (v: string) => void
  composerRef: React.RefObject<HTMLInputElement | null>
  onToggleRaw: () => void
  onSend: (text: string) => void
  onDecide: (d: 'allow' | 'always' | 'deny') => void
  onInterrupt: () => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items.length, chat.status, rawMode])

  const submit = (): void => {
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
  }

  return (
    <section className="chat">
      <div className="chat-head drag">
        <span className="avatar">{chat.title.slice(0, 1).toUpperCase()}</span>
        <div>
          <div className="chat-head-name">{chat.title}</div>
          <div className="chat-head-sub">{shortPath(chat.cwd)}</div>
        </div>
        <div className="head-actions no-drag">
          <select
            className="model-select"
            title="Which Claude model this chat uses"
            value={chat.preferredModel ?? ''}
            onChange={(e) => void sb.setModel(chat.id, e.target.value || undefined)}
          >
            {MODEL_CHOICES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {chat.status === 'working' && (
            <button className="icon-btn" onClick={onInterrupt} title="Stop what Claude is doing">
              ◼ Stop
            </button>
          )}
          <button
            className="icon-btn"
            aria-pressed={rawMode}
            onClick={onToggleRaw}
            title="Show the raw session log — same session, no translation"
          >
            {'</>'}
          </button>
        </div>
      </div>

      {rawMode ? (
        <div className="raw" ref={scrollRef}>
          <pre>{raw.map((m) => JSON.stringify(m)).join('\n') || 'Nothing logged yet this launch.'}</pre>
        </div>
      ) : (
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
              <ThreadItemView key={item.id} item={item} onDecide={onDecide} />
            ))}
            {chat.status === 'working' && (
              <div className="working">
                <span className="spinner" />
                Working…
              </div>
            )}
          </div>
        </div>
      )}

      <div className="composer">
        <div className="composer-inner">
          <input
            ref={composerRef}
            value={draft}
            placeholder={items.length === 0 ? 'What would you like Claude to do?' : 'Reply to Claude…'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
          <button className="send" aria-label="Send" onClick={submit}>
            ↑
          </button>
        </div>
      </div>
    </section>
  )
}

function ThreadItemView({
  item,
  onDecide
}: {
  item: ThreadItem
  onDecide: (d: 'allow' | 'always' | 'deny') => void
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user">
          <div className="bubble">{item.text}</div>
        </div>
      )
    case 'claude':
      return (
        <div className="msg-claude">
          <span className="spark-dot">✳</span>
          <div className="body markdown">
            <Markdown text={item.text} />
          </div>
        </div>
      )
    case 'step':
      return (
        <div className="steps">
          <div className="step">
            <span className="ico">·</span>
            <span>{item.summary}</span>
          </div>
        </div>
      )
    case 'ask':
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
    case 'info':
      return <div className="thread-info">{item.text}</div>
    case 'error':
      return <div className="thread-info error">{item.text}</div>
    default:
      return null
  }
}

function DetailsPanel({
  chat,
  info,
  onUseCommand
}: {
  chat: ChatMeta
  info: ProjectInfo | null
  onUseCommand: (cmd: string) => void
}): React.JSX.Element {
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
      <div className="d-section">
        <h3>Handy commands</h3>
        <div className="cmd-list">
          {HANDY_COMMANDS.map((c) => (
            <button className="cmd" key={c.cmd} onClick={() => onUseCommand(c.cmd)}>
              <span className="slash">{c.cmd}</span>
              <span className="cmd-desc">{c.desc}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="d-section">
        <h3>Connected apps</h3>
        <div className="chips">
          {info && info.mcpServers.length > 0 ? (
            info.mcpServers.map((m) => (
              <span className="chip" key={m}>
                {m}
              </span>
            ))
          ) : (
            <span className="chip off">None connected</span>
          )}
          <span className={`chip ${info?.hasClaudeMd ? '' : 'off'}`}>
            Project notes {info?.hasClaudeMd ? '✓' : '—'}
          </span>
        </div>
      </div>
    </aside>
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
