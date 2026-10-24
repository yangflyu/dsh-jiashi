/**
 * SessionThread — 对话卡里的 DSH 会话线程。
 *
 * - 消息来自 binding.eventSource（session log 的事件窗口，原生对话是同一份数据）；
 * - 输入通过 face.prompt() 写回同一个 session；
 * - 绑定卡片的显示范围由 fromSeq / toSeq 决定（拆分卡片只是显示层）；
 * - 流式回复直接读 transient 事件（assistant/live-chunk）拼出来。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { SESSION_TAIL_SEQ, isDshSessionId, sessionLog, sessionRuntime } from './bridge'
import { useSessionTitle } from './SessionInfo'

function useSessionEntry(sessionId: string) {
  const bridge = sessionRuntime.bridge
  const [entry, setEntry] = useState<any>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (bridge === null || !isDshSessionId(sessionId)) return undefined
    let alive = true
    let attempt = 0
    let timer = 0
    const tryAcquire = () => {
      if (!alive) return
      bridge.acquire(sessionId).then(
        (value: any) => {
          if (alive) setEntry(value)
        },
        (reason: unknown) => {
          if (!alive) return
          attempt += 1
          if (attempt < 4) {
            timer = window.setTimeout(tryAcquire, 400 * attempt)
          } else {
            setError(reason instanceof Error ? reason : new Error(String(reason)))
          }
        },
      )
    }
    tryAcquire()
    return () => {
      alive = false
      if (timer !== 0) window.clearTimeout(timer)
      bridge.release(sessionId)
    }
  }, [bridge, sessionId])

  return { entry, error }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: any) => (part !== null && typeof part === 'object' && part.type === 'text' ? part.text : ''))
    .filter((text: any) => typeof text === 'string' && text !== '')
    .join('\n')
}

interface ThreadMessage {
  role: 'user' | 'assistant'
  text: string
  seq: number
}

/** 只取持久的 user/assistant 消息（transient 流式片段单独处理）。 */
function extractMessages(entries: readonly any[]): ThreadMessage[] {
  const messages: ThreadMessage[] = []
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event === undefined) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const data = event.data ?? {}
    const text = contentText(data.content ?? data.message?.content ?? [])
    if (text === '') continue
    messages.push({
      role: event.type === 'user/message' ? 'user' : 'assistant',
      text,
      seq: event.seq,
    })
  }
  return messages
}

/** 从 transient 的 assistant/live-chunk 里拼出正在生成的文本（最近一次 attempt）。 */
function extractLiveText(entries: readonly any[]): string {
  const byAttempt = new Map<string, string>()
  for (const entry of entries) {
    if (entry.type !== 'transient') continue
    const data = entry.event?.data
    const chunk = data?.chunk
    if (chunk === undefined || chunk === null) continue
    if (chunk.type !== 'text-delta' || typeof chunk.text !== 'string') continue
    const attempt = String(data.attemptId ?? 'live')
    byAttempt.set(attempt, (byAttempt.get(attempt) ?? '') + chunk.text)
  }
  let latest = ''
  for (const text of byAttempt.values()) latest = text
  return latest
}

export default function SessionThread({
  sessionId,
  compact = false,
  fromSeq,
  toSeq,
  onSplit,
  onMerge,
}: {
  sessionId: string
  isDarkMode?: boolean
  compact?: boolean
  /** 显示范围起点（含）；缺省 = 从会话开头 */
  fromSeq?: number
  /** 显示范围终点（含）；缺省 = 显示到最新（"尾巴卡"） */
  toSeq?: number
  /** 从某条消息起拆到新卡（显示层操作） */
  onSplit?: (seq: number) => void
  /** 把这张分段卡合并回上一张（显示层操作） */
  onMerge?: () => void
}) {
  const { entry, error } = useSessionEntry(sessionId)
  if (error !== null) {
    return <div className="jiashi-session-error">会话打不开：{String(error.message ?? error)}</div>
  }
  if (entry === null) {
    return <div className="jiashi-session-loading">正在连接对话…</div>
  }
  return (
    <SessionThreadInner
      entry={entry}
      compact={compact}
      fromSeq={fromSeq}
      toSeq={toSeq}
      onSplit={onSplit}
      onMerge={onMerge}
    />
  )
}

function SessionThreadInner({
  entry,
  compact,
  fromSeq,
  toSeq,
  onSplit,
  onMerge,
}: {
  entry: any
  compact: boolean
  fromSeq?: number
  toSeq?: number
  onSplit?: (seq: number) => void
  onMerge?: () => void
}) {
  const { face, eventSource } = entry
  const sessionTitle = useSessionTitle(face.sessionId)
  const snapshot = useSyncExternalStore(
    (listener: () => void) => face.subscribe(listener),
    () => face.getSnapshot(),
  )
  const eventWindow = useSyncExternalStore(
    (listener: () => void) => eventSource.subscribe(listener),
    () => eventSource.getSnapshot(),
  )

  const isTail = toSeq === undefined || toSeq >= SESSION_TAIL_SEQ
  const effectiveTo = isTail ? Infinity : (toSeq as number)

  const messages = useMemo(() => {
    const all = extractMessages(eventWindow.entries ?? [])
    const start = fromSeq ?? -Infinity
    return all.filter((message) => message.seq >= start && message.seq <= effectiveTo)
  }, [eventWindow, fromSeq, effectiveTo])
  const liveText = useMemo(() => {
    // 只有"尾巴卡"显示流式内容；拆出去的卡片显示的是固定区段。
    if (!isTail) return ''
    return extractLiveText(eventWindow.entries ?? [])
  }, [eventWindow, isTail])

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = listRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [messages.length, liveText, snapshot.running])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (text === '' || sending) return
    setSending(true)
    setSendError('')
    try {
      const result = await face.prompt([{ type: 'text', text }], 'queue')
      if (result !== null && typeof result === 'object' && result.ok === false) {
        setSendError(result.error?.message ?? '发送失败')
      } else {
        setDraft('')
        sessionLog('thread.prompt', { sessionId: face.sessionId })
      }
    } catch (reason) {
      const message = String((reason as Error)?.message ?? reason)
      setSendError(message)
      sessionLog('thread.prompt-failed', { sessionId: face.sessionId, message })
    } finally {
      setSending(false)
    }
  }, [draft, face, sending])

  const openNative = useCallback(() => {
    try {
      const uiWorkspace = sessionRuntime.ctx?.get?.('uiWorkspace')
      if (uiWorkspace?.openSession) {
        uiWorkspace.openSession(face.sessionId)
        return
      }
      sessionRuntime.ctx?.get?.('layout')?.selectPanel?.(null)
    } catch (reason) {
      sessionLog('thread.open-failed', { error: String((reason as Error)?.message ?? reason) })
    }
  }, [face])

  const stateLabel = snapshot.removed
    ? '已移除'
    : snapshot.openState === 'loading'
      ? '载入中'
      : snapshot.running
        ? '生成中'
        : '就绪'

  const stopPointer = (event: { stopPropagation: () => void }) => event.stopPropagation()

  return (
    <div
      className="jiashi-session-thread"
      data-jiashi-session={face.sessionId}
      onPointerDown={stopPointer}
      onWheel={stopPointer}
    >
      <div className="jiashi-session-head">
        <span className="jiashi-session-dot" data-running={snapshot.running ? '1' : '0'} />
        <span className="jiashi-session-title" title={sessionTitle ?? 'DSH 对话'}>
          {sessionTitle ?? 'DSH 对话'}
        </span>
        {fromSeq !== undefined || !isTail ? (
          <span className="jiashi-session-range">
            {fromSeq !== undefined ? `#${fromSeq} 起` : '从头'}
            {isTail ? ' · 到最新' : ` · 到 #${toSeq}`}
          </span>
        ) : null}
        <span className="jiashi-session-state">{stateLabel}</span>
        {onMerge !== undefined ? (
          <button
            type="button"
            className="jiashi-session-merge"
            onClick={onMerge}
            onPointerDown={stopPointer}
            title="把这一段合并回上一张卡（只是显示层）"
          >
            ⇤ 合并
          </button>
        ) : null}
        <button
          type="button"
          className="jiashi-session-open"
          onClick={openNative}
          onPointerDown={stopPointer}
          title="在原生对话里打开这条会话"
        >
          打开
        </button>
      </div>

      <div ref={listRef} className="jiashi-session-messages" data-compact={compact ? '1' : '0'}>
        {messages.length === 0 && liveText === '' ? (
          <div className="jiashi-session-empty">还没有消息。在下面输入，会和原生对话写进同一个会话。</div>
        ) : (
          messages.map((message) => (
            <div key={`${message.seq}-${message.role}`} className={message.role === 'user' ? 'jiashi-msg-wrap jiashi-wrap-user' : 'jiashi-msg-wrap jiashi-wrap-assistant'}>
              <div className={message.role === 'user' ? 'jiashi-msg jiashi-msg-user' : 'jiashi-msg jiashi-msg-assistant'}>
                {message.text}
              </div>
              {onSplit !== undefined && message.role === 'user' ? (
                <button
                  type="button"
                  className="jiashi-msg-split"
                  title="从这条消息起拆到一张新卡（只是显示分段）"
                  onClick={() => onSplit(message.seq)}
                  onPointerDown={stopPointer}
                >
                  ✂ 拆出
                </button>
              ) : null}
            </div>
          ))
        )}
        {liveText === '' ? null : (
          <div className="jiashi-msg-wrap jiashi-wrap-assistant">
            <div className="jiashi-msg jiashi-msg-assistant jiashi-msg-live">
              {liveText}
              <span className="jiashi-caret">▌</span>
            </div>
          </div>
        )}
      </div>

      {sendError === '' ? null : <div className="jiashi-session-error">{sendError}</div>}

      <div className="ai-input-row">
        <input
          type="text"
          className="ai-input-field"
          placeholder={snapshot.running ? '生成中，也可以继续追问…' : '和这条 DSH 对话说点什么…'}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setSendError('')
          }}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <button
          type="button"
          className="ai-input-send"
          onClick={() => void send()}
          disabled={sending || draft.trim() === ''}
          title="发送到这条 DSH 会话"
        >
          {sending ? <span className="ai-spinner" /> : '发送'}
        </button>
      </div>
    </div>
  )
}
