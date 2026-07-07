# ✳ Switchboard

A friendly, messages-style Mac app for running **many Claude Code sessions at once** — built to
make Claude Code approachable for people who find a wall of terminal windows intimidating.

Each chat lives in a project folder. The sidebar sorts chats by what needs you — **Needs your
reply**, **Working on it**, **All caught up** — and an **Approvals** inbox collects every pending
permission and question across all chats so you can clear them from one place, with number keys.

## Try it

You need:

- macOS on Apple Silicon
- [Node.js](https://nodejs.org) 20 or newer
- A Claude account (Pro/Max subscription) **or** an Anthropic API key — nothing else to
  install; Switchboard bundles the Claude Code engine

```sh
git clone https://github.com/JBPostPilot/switchboard.git
cd switchboard
npm install
npm run dev
```

That's it. If you've never signed in to Claude Code, the first launch walks you through it
(sign in with your Claude account, or paste an API key — stored encrypted in your Mac's
keychain). Then click **“+ New chat…”**, pick a project folder, and talk to Claude.

Want it in your Applications folder instead of a dev window?

```sh
npm run dist        # builds dist/Switchboard-<version>-arm64.dmg
open dist/*.dmg     # drag to Applications; right-click → Open the first time (unsigned build)
```

## What you get

- **A chat per project** — Claude reads the code, edits files, and runs commands in that
  folder, asking first when it needs your OK
- **Attention triage** — the sidebar groups chats by who's waiting on whom; native macOS
  notifications when a background chat needs you
- **Approvals inbox** — every pending permission and question across all chats in one queue;
  action them with number keys without switching threads
- **Decision cards, not walls of text** — permissions and Claude's multiple-choice questions
  render as tappable cards with keyboard shortcuts
- **Streaming, markdown replies** — code blocks, tables, links that open in your browser
- **`/` command popover** — the chat's real, live command list (builtins, project commands,
  plugins, skills) with syntax hints; **⌘K** jumps to any chat; **⌘W** closes one
- **Per-chat model picker** (live list from your account — includes what your subscription can
  access) and **permission mode** (ask first / auto-accept edits / plan-only / full auto)
- **Project details at a glance** — branch, cost, connected apps (including claude.ai
  connectors), project skills, open-in-editor buttons
- **The honest escape hatch** — `</>` shows any chat's raw session log

## How it works

Switchboard is a chat skin over real Claude Code sessions, not a reimplementation. Each chat
is a live session driven by the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview),
which embeds the actual Claude Code runtime. Sessions load your `CLAUDE.md`, settings, skills,
and MCP servers exactly as a terminal `claude` session would, resume across launches from the
same transcripts the CLI uses (`~/.claude/projects/`), and bill the same way your terminal
sessions do — same subscription, same limits, no extra cost.

```
src/main/       Electron main process — session manager, persistence, project info
  sessions.ts   One ChatSession per chat: streaming-input queue → Agent SDK query()
src/preload/    contextBridge API exposed to the UI
src/renderer/   React UI — sidebar, thread, cards, approvals backlog, details panel
src/shared/     Types shared across processes
```

## Development

```sh
npm run dev          # hot-reloading dev build
npm run typecheck    # main + renderer
npm run build        # production build into out/
npm run dist         # package a .dmg
```

Cutting a signed release: see [docs/RELEASING.md](docs/RELEASING.md).

## Roadmap

- [ ] Adopt existing terminal sessions (`claude --resume` list → chats)
- [ ] Undo — rewind files to before any message (SDK file checkpointing)
- [ ] Subagent visualization — live cards for agents Claude spawns
- [ ] Reopen recently closed chats from their transcripts
- [ ] Attach images/files to messages
- [ ] Usage meter from live rate-limit info

## License

MIT
