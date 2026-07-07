# ✳ Switchboard

A friendly, messages-style Mac app for running **many Claude Code sessions at once** — built to make
Claude Code approachable for people who find a wall of terminal windows intimidating.

Each chat lives in a project folder. The sidebar sorts chats by what needs you: **Needs your reply**
(Claude is waiting on a permission or a question), **Working on it**, and **All caught up**. Permission
prompts render as decision cards with real buttons — press `1` / `2` / `3` or click.

## How it works

Switchboard is a chat skin over real Claude Code sessions, not a reimplementation:

- Each chat is a live session driven by the **[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)**
  (`@anthropic-ai/claude-agent-sdk`), which embeds the actual Claude Code runtime.
- Sessions run with `settingSources: ['user', 'project', 'local']` and the `claude_code` system-prompt
  preset, so your `CLAUDE.md`, skills, settings, and MCP servers load exactly as they would in a
  terminal `claude` session.
- Permission prompts come through the SDK's `canUseTool` callback and render as cards. "Always allow
  this" persists the SDK's suggested permission rules, same as answering "don't ask again" in the CLI.
- Chats resume across launches via the SDK's `resume` (session transcripts live in
  `~/.claude/projects/`, same as the CLI).
- The `</>` button in any chat shows the raw session message log — the honest escape hatch.
- The details panel reads passively from the project folder: git branch, `.claude/skills/`
  ("Project shortcuts"), `.mcp.json` ("Connected apps"), and `CLAUDE.md` ("Project notes").

```
src/main/       Electron main process — session manager, persistence, project info
  sessions.ts   One ChatSession per chat: streaming-input queue → Agent SDK query()
src/preload/    contextBridge API exposed to the UI
src/renderer/   React UI — sidebar, thread, decision cards, details panel
src/shared/     Types shared across processes
```

## Running it

Requires Node 20+. Authentication works the same way the `claude` CLI does — an existing Claude Code
login is picked up automatically, or set `ANTHROPIC_API_KEY` in your environment.

```sh
npm install
npm run dev        # development, with hot reload
npm run build      # production build into out/
npm run dist       # package a .dmg (electron-builder)
```

## Roadmap

- [ ] Adopt existing terminal sessions (`claude --resume` list → chats)
- [ ] Reopen recently closed chats from their transcripts
- [ ] Attach images/files to messages
- [ ] Render option previews in question cards (code snippets, mockups)
- [ ] Refresh the model list when the dropdown opens (not just at launch)

## License

MIT
