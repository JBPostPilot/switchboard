// Headless smoke test of the session core: one streaming-input session,
// one user message, expect an assistant reply and a result message.
// Run: node scripts/smoke.mjs
import { query } from '@anthropic-ai/claude-agent-sdk'

const messages = (async function* () {
  yield {
    type: 'user',
    message: { role: 'user', content: 'Reply with exactly the word: pong' },
    parent_tool_use_id: null
  }
})()

let sawAssistant = false
const timer = setTimeout(() => {
  console.error('TIMEOUT: no result within 120s')
  process.exit(1)
}, 120_000)

for await (const msg of query({
  prompt: messages,
  options: {
    cwd: process.cwd(),
    permissionMode: 'default',
    settingSources: [],
    maxTurns: 1
  }
})) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    console.log('init ok — session', msg.session_id, 'model', msg.model)
  }
  if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text') {
        sawAssistant = true
        console.log('assistant:', block.text.slice(0, 80))
      }
    }
  }
  if (msg.type === 'result') {
    clearTimeout(timer)
    console.log('result:', msg.subtype, '| cost:', msg.total_cost_usd, '| turns:', msg.num_turns)
    process.exit(sawAssistant && msg.subtype === 'success' ? 0 : 1)
  }
}
