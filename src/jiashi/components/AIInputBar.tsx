// ── AI Input Bar — multi-turn conversation ──
//
// Each text block belongs to a conversation (via conversationId).
// The AI remembers full message history within that conversation,
// enabling true multi-turn interactions (follow-ups, iterations, etc.).
//
// AI responses are rendered as separate cards in TextBlockContent.

import { useState, useCallback, useRef, useEffect } from 'react'
import { loadAISettings } from '../ai/settings'
import { streamAIResponse } from '../ai/api'
import {
  getConversation,
  createConversation,
  addMessage,
  buildMessages,
  getConversationLabel,
} from '../ai/conversation'

interface Props {
  /** 当前文本框第一片段的文本内容（用于 AI 上下文） */
  contentText: string
  /** Current conversation ID (from the text block's props) */
  conversationId?: string
  /** Called when a new conversation is created/assigned to this text block */
  onConversationChange: (id: string) => void
  /** All text block contents in this conversation (for context) */
  contextContents: string[]
  /** Called when AI starts streaming a response */
  onAiStreamStart?: (model: string) => void
  /** Called with the full accumulated content during streaming */
  onAiStreamUpdate?: (fullContent: string) => void
  /** Called when streaming completes */
  onAiStreamEnd?: (model: string, fullContent: string, prompt: string) => void
  /**
   * 统一到 DSH：提供这个回调时，发送不再走本地 AI，
   * 而是由父组件建/接入一条 DSH 会话并把这句送进去。
   */
  onDshSend?: (text: string) => Promise<void>
}

export default function AIInputBar({
  contentText,
  conversationId,
  onConversationChange,
  contextContents,
  onAiStreamStart,
  onAiStreamUpdate,
  onAiStreamEnd,
  onDshSend,
}: Props) {
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const dshMode = onDshSend !== undefined

  // Resolve conversation label for display
  const convLabel = conversationId ? getConversationLabel(conversationId) : null

  const handleSend = useCallback(async () => {
    const text = prompt.trim()
    if (!text || loading) return

    // Unity mode: hand the first message to the DSH session instead of the local AI stack.
    if (onDshSend !== undefined) {
      setError('')
      setLoading(true)
      try {
        await onDshSend(text)
        setPrompt('')
      } catch (e) {
        setError(e instanceof Error ? e.message : '接入 DSH 会话失败')
      } finally {
        setLoading(false)
        inputRef.current?.focus()
      }
      return
    }

    const settings = await loadAISettings()
    if (!settings.apiKey) {
      setError('请先在设置中配置 API Key')
      return
    }

    setError('')
    setLoading(true)
    setPrompt('')

    // Ensure conversation exists (lazy create on first send)
    let activeId = conversationId
    if (!activeId) {
      const conv = await createConversation()
      activeId = conv.id
      onConversationChange(activeId)
    }

    // Build context: include current text content
    const currentContent = contentText ?? ''
    const allContents = currentContent.trim()
      ? [currentContent, ...contextContents.filter(c => c !== currentContent)]
      : contextContents

    // Build the full messages array: system context + history + new user message
    const messages = buildMessages(activeId, text, allContents)

    // Determine model name from settings
    const modelName = settings.model || 'deepseek-chat'

    // Notify parent that streaming is starting
    onAiStreamStart?.(modelName)

    let fullText = ''

    try {
      const generator = streamAIResponse(messages, settings)
      for await (const chunk of generator) {
        fullText += chunk
        // Update parent with accumulated content (for live preview)
        onAiStreamUpdate?.(fullText)
      }

      // Save to conversation history
      await addMessage(activeId, { role: 'user', content: text })
      await addMessage(activeId, { role: 'assistant', content: fullText })

      // Notify parent that streaming is complete — saves to shape props
      onAiStreamEnd?.(modelName, fullText, text)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '未知错误'
      setError(msg)
      onAiStreamEnd?.(modelName, fullText || '（生成失败）', text)
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }, [prompt, loading, conversationId, onConversationChange, contextContents, contentText, onAiStreamStart, onAiStreamUpdate, onAiStreamEnd, onDshSend])

  const handleNewConversation = useCallback(async () => {
    const conv = await createConversation()
    onConversationChange(conv.id)
    setError('')
  }, [onConversationChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const hasHistory = conversationId
    ? (getConversation(conversationId)?.messages.length ?? 0) > 0
    : false

  return (
    <div className="ai-input-bar">
      {/* Conversation header */}
      <div className="ai-conv-header">
        <span className="ai-conv-label">
          <span className="ai-conv-dot" />
          {dshMode ? 'DSH 对话（首次发送会新建会话）' : (convLabel ?? '新对话')}
        </span>
        {dshMode ? null : (
        <div className="ai-conv-actions">
          {hasHistory && (
            <span className="ai-conv-count">
              {getConversation(conversationId!)!.messages.length / 2} 轮
            </span>
          )}
          <button
            className="ai-conv-new-btn"
            onClick={handleNewConversation}
            title="新建对话"
            disabled={loading}
          >
            + 新建
          </button>
        </div>
        )}
      </div>

      {/* Context hint */}
      {contextContents.length > 0 && (
        <div className="ai-input-context-hint">
          已关联 {contextContents.length} 个文本框
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="ai-input-error">{error}</div>
      )}

      {/* Input row */}
      <div className="ai-input-row">
        <input
          ref={inputRef}
          type="text"
          className="ai-input-field"
          placeholder={loading ? '正在接入 DSH 会话…' : dshMode ? '输入后发送，会新建/接入一条 DSH 会话…' : '追问或输入新提示词...'}
          value={prompt}
          onChange={e => { setPrompt(e.target.value); setError('') }}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button
          className="ai-input-send"
          onClick={handleSend}
          disabled={!prompt.trim() || loading}
          title="发送 (Enter)"
        >
          {loading ? (
            <span className="ai-spinner" />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
