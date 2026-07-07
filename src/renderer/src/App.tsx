import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  ChatMeta,
  ChatQuestion,
  EditorApp,
  ModelChoice,
  ProjectInfo,
  ThreadItem
} from '../../shared/types'

type QuestionItem = Extract<ThreadItem, { kind: 'question' }>

const sb = window.switchboard

// Shown until the live list from the engine arrives (or if fetching fails).
const FALLBACK_MODELS: ModelChoice[] = [
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

// Every chat in the same project folder gets the same color, so a project's
// chats read as a family in the sidebar. The hue is a stable hash of the path;
// light/dark shades are resolved in CSS so the badge follows the OS theme.
function projectHue(cwd: string): number {
  let h = 0
  for (let i = 0; i < cwd.length; i++) h = (h * 31 + cwd.charCodeAt(i)) % 360
  return h
}

function ProjectAvatar({ cwd }: { cwd: string }): React.JSX.Element {
  const name = cwd.split('/').filter(Boolean).pop() ?? '?'
  return (
    <span className="avatar project" style={{ '--hue': projectHue(cwd) } as React.CSSProperties}>
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

export default function App(): React.JSX.Element {
  const [chats, setChats] = useState<ChatMeta[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [items, setItems] = useState<ThreadItem[]>([])
  const [rawMode, setRawMode] = useState(false)
  const [raw, setRaw] = useState<unknown[]>([])
  const [info, setInfo] = useState<ProjectInfo | null>(null)
  const [models, setModels] = useState<ModelChoice[]>(FALLBACK_MODELS)
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
    (text: string) => {
      if (currentId) void sb.sendMessage(currentId, text)
    },
    [currentId]
  )

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
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' && (target as HTMLInputElement).value !== '') return
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
  }, [pendingAsk, pendingQuestion, decide, answer])

  return (
    <div className="app">
      <Sidebar
        chats={chats}
        currentId={currentId}
        onSelect={setCurrentId}
        onCreated={chatCreated}
        onClose={(id) => void closeChat(id)}
      />
      {current ? (
        <>
          <ChatPane
            chat={current}
            items={items}
            raw={raw}
            rawMode={rawMode}
            models={models}
            draft={draft}
            setDraft={setDraft}
            composerRef={composerRef}
            onToggleRaw={() => setRawMode((v) => !v)}
            onSend={send}
            onDecide={decide}
            onAnswer={answer}
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
  onCreated,
  onClose
}: {
  chats: ChatMeta[]
  currentId: string | null
  onSelect: (id: string) => void
  onCreated: (meta: ChatMeta) => void
  onClose: (id: string) => void
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
                <div
                  key={c.id}
                  className="chat-item"
                  role="button"
                  tabIndex={0}
                  aria-current={c.id === currentId}
                  onClick={() => onSelect(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSelect(c.id)
                  }}
                >
                  <ProjectAvatar cwd={c.cwd} />
                  <span className="chat-name">{c.title}</span>
                  <span className="chat-time">{timeAgo(c.updatedAt)}</span>
                  <span className={`chat-preview ${c.status === 'needs-you' || c.status === 'error' ? 'attn' : c.status === 'working' ? 'work' : ''}`}>
                    {c.statusLine || c.preview}
                  </span>
                  {c.status === 'needs-you' && <span className="badge" />}
                  {c.status === 'working' && <span className="badge work" />}
                  <button
                    className="chat-close"
                    title="Close this chat (⌘W)"
                    aria-label={`Close ${c.title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(c.id)
                    }}
                  >
                    ✕
                  </button>
                </div>
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
  models,
  draft,
  setDraft,
  composerRef,
  onToggleRaw,
  onSend,
  onDecide,
  onAnswer,
  onInterrupt
}: {
  chat: ChatMeta
  items: ThreadItem[]
  raw: unknown[]
  rawMode: boolean
  models: ModelChoice[]
  draft: string
  setDraft: (v: string) => void
  composerRef: React.RefObject<HTMLInputElement | null>
  onToggleRaw: () => void
  onSend: (text: string) => void
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
  }, [items, chat.status, rawMode])

  const submit = (): void => {
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
  }

  return (
    <section className="chat">
      <div className="chat-head drag">
        <ProjectAvatar cwd={chat.cwd} />
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
              <ThreadItemView key={item.id} item={item} onDecide={onDecide} onAnswer={onAnswer} />
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
  onDecide,
  onAnswer
}: {
  item: ThreadItem
  onDecide: (d: 'allow' | 'always' | 'deny') => void
  onAnswer: (a: Record<string, string> | null) => void
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
  onUseCommand
}: {
  chat: ChatMeta
  info: ProjectInfo | null
  onUseCommand: (cmd: string) => void
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
