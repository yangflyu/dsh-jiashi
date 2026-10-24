// ── AI API: OpenAI-compatible chat completions (streaming) ──

import { loadAISettings, type AISettings } from './settings'
import type { Message } from './conversation'

/** Stream an AI response given a full messages array.
 *  The caller is responsible for assembling messages (system prompt, history, etc.). */
export async function* streamAIResponse(
  messages: Message[],
  settings?: AISettings,
): AsyncGenerator<string, void, unknown> {
  const cfg = settings ?? await loadAISettings()

  if (!cfg.apiKey) {
    throw new Error('请先在设置中填写 API Key')
  }

  const response = await fetch(`${cfg.endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
    }),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`API 请求失败 (${response.status}): ${errText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('无法读取流式响应')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') return

      try {
        const parsed = JSON.parse(data)
        const content = parsed.choices?.[0]?.delta?.content
        if (content) yield content
      } catch { /* skip malformed chunks */ }
    }
  }
}
