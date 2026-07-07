import { query } from '@anthropic-ai/claude-agent-sdk'

// Name a chat from its first message: one cheap, tool-less Haiku turn.
// Returns null on any failure — the chat just keeps its folder-name title.
export async function generateChatTitle(firstMessage: string): Promise<string | null> {
  const prompt =
    'A coding assistant chat starts with the user message below. Write a short title ' +
    'summarizing what the chat is about. Reply with the title only: 2-5 plain words, ' +
    'no quotes, no trailing punctuation.\n\nUser message:\n' +
    firstMessage.slice(0, 1000)
  try {
    const q = query({
      prompt,
      options: { model: 'haiku', settingSources: [], maxTurns: 1, allowedTools: [] }
    })
    for await (const message of q as AsyncIterable<Record<string, unknown>>) {
      if (message.type === 'result') {
        if (message.subtype !== 'success' || typeof message.result !== 'string') return null
        const title = message.result.trim().replace(/^["'“”]+|["'“”.]+$/g, '')
        if (!title || title.includes('\n')) return null
        return title.length > 48 ? title.slice(0, 45) + '…' : title
      }
    }
  } catch {
    // fall through
  }
  return null
}
