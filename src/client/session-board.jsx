import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  Tldraw,
  createShapeId,
} from 'tldraw'
import tldrawCss from 'tldraw/tldraw.css'

/**
 * 架势画布插件（原生版）— Client 半边。
 *
 * 这一版打通"画布 ↔ DSH 会话"的最小闭环：
 * - 左侧栏注册「画布」面板（sidebar.panellist），中央主面板注册同名 key（main）；
 * - 画布是原生 tldraw，卡片是 tldraw 自定义 shape，一张卡绑一个 session；
 * - 卡片里实时显示该会话的 user/assistant 消息，输入框直接 face.prompt() 写回同一个会话；
 * - 点卡片标题可回到原生线性视图（ctx.sessions.open + layout.selectPanel(null)）。
 *
 * 数据归属：消息永远在 DSH 的 session log 里；画布只存"哪个 session 摆在哪"。
 */

const MAIN_KEY = 'jiashi'
const NS = 'jiashi'
const CARD_TYPE = 'jiashi-card'

const zh = { 'panel.label': '画布', 'card.new': '新对话', 'card.open': '打开', 'card.send': '发送' }
const en = { 'panel.label': 'Canvas', 'card.new': 'New chat', 'card.open': 'Open', 'card.send': 'Send' }

let cssInjected = false
function injectTldrawCss() {
  if (cssInjected) return
  cssInjected = true
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-jiashi'
  style.dataset.jiashi = 'tldraw'
  style.textContent = tldrawCss
  document.head.appendChild(style)
}

/** 把客户端诊断信息写到宿主日志（/jiashi/api/log → $DSH_HOME/jiashi/board.log）。 */
function boardLog(event, data) {
  try {
    const url = new URL('jiashi/api/log', document.baseURI).href
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, data, time: new Date().toISOString() }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* 桌面 file:// 或服务不可用时静默 */
  }
}

/* ------------------------------------------------------------------ *
 * 会话桥：把 DSH session 的 retention/生命周期暴露给 React 卡片
 * ------------------------------------------------------------------ */

function createSessionBridge(ctx) {
  /** sessionId -> { ref, refCount, promise } */
  const cache = new Map()

  function sessionsService() {
    try {
      const viaGet = ctx.get?.('sessions')
      if (viaGet !== undefined) return viaGet
    } catch {
      /* fall through */
    }
    try {
      return ctx.sessions
    } catch {
      return undefined
    }
  }

  function acquire(sessionId) {
    let entry = cache.get(sessionId)
    if (entry === undefined) {
      let ref
      try {
        const sessions = sessionsService()
        if (sessions === undefined || typeof sessions.retain !== 'function') {
          throw new Error('sessions service unavailable')
        }
        ref = sessions.retain(sessionId, { source: 'jiashi-board' })
      } catch (error) {
        boardLog('bridge.error', { sessionId: String(sessionId), error: String(error?.message ?? error) })
        return Promise.reject(error)
      }
      entry = {
        ref,
        refCount: 0,
        promise: ref.ready.then(
          (binding) => ({
            binding,
            face: binding.session,
            eventSource: binding.eventSource,
          }),
          (error) => {
            // 失败的一代不能留在缓存里，否则重试只会拿到同一个失败 Promise。
            cache.delete(sessionId)
            try {
              ref.release()
            } catch {
              /* already released */
            }
            boardLog('bridge.open-failed', { sessionId: String(sessionId), error: String(error?.message ?? error) })
            throw error
          },
        ),
      }
      cache.set(sessionId, entry)
    }
    entry.refCount += 1
    return entry.promise
  }

  function release(sessionId) {
    const entry = cache.get(sessionId)
    if (entry === undefined) return
    entry.refCount -= 1
    if (entry.refCount > 0) return
    cache.delete(sessionId)
    try {
      entry.ref.release()
    } catch {
      /* already released */
    }
  }

  return { acquire, release }
}

/** 一个会话的 React 句柄：加载 + 订阅生命周期/事件窗口。 */
function useSessionEntry(sessionId) {
  const bridge = runtime.bridge
  const [entry, setEntry] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (bridge === null || !sessionId) return undefined
    let alive = true
    let attempt = 0
    let timer = 0
    const tryAcquire = () => {
      if (!alive) return
      bridge.acquire(sessionId).then(
        (value) => {
          if (alive) setEntry(value)
        },
        (reason) => {
          if (!alive) return
          attempt += 1
          // 新建的会话可能还没同步到客户端列表：短暂重试几次再报错。
          if (attempt < 4) {
            timer = setTimeout(tryAcquire, 400 * attempt)
          } else {
            setError(reason instanceof Error ? reason : new Error(String(reason)))
          }
        },
      )
    }
    tryAcquire()
    return () => {
      alive = false
      if (timer !== 0) clearTimeout(timer)
      bridge.release(sessionId)
    }
  }, [bridge, sessionId])

  return { entry, error }
}

/** 从事件窗口里抽出可读的对话消息（先只取 user / assistant 文本）。 */
function extractMessages(entries) {
  const messages = []
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const data = event.data ?? {}
    const content = data.content ?? data.message?.content ?? []
    const text = contentText(content)
    if (text === '') continue
    messages.push({
      role: event.type === 'user/message' ? 'user' : 'assistant',
      text,
      seq: event.seq,
    })
  }
  return messages
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part !== null && typeof part === 'object' && part.type === 'text' ? part.text : ''))
    .filter((text) => typeof text === 'string' && text !== '')
    .join('\n')
}

/* ------------------------------------------------------------------ *
 * 运行时上下文：apply 时注入，卡片组件从这里取（单插件实例，安全）
 * ------------------------------------------------------------------ */

const runtime = { ctx: null, bridge: null }

/* ------------------------------------------------------------------ *
 * 会话卡
 * ------------------------------------------------------------------ */

function SessionCard({ sessionId, seedTitle }) {
  const { entry, error } = useSessionEntry(sessionId)
  if (error !== null) {
    return <div style={styles.cardFallback}>会话打不开：{String(error.message ?? error)}</div>
  }
  if (entry === null) {
    return <div style={styles.cardFallback}>正在加载会话…</div>
  }
  return <SessionCardInner entry={entry} seedTitle={seedTitle} />
}

function SessionCardInner({ entry, seedTitle }) {
  const { face, eventSource } = entry
  const snapshot = useSyncExternalStore(
    (listener) => face.subscribe(listener),
    () => face.getSnapshot(),
  )
  const eventWindow = useSyncExternalStore(
    (listener) => eventSource.subscribe(listener),
    () => eventSource.getSnapshot(),
  )
  const messages = useMemo(() => extractMessages(eventWindow.entries), [eventWindow])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const listRef = useRef(null)

  useEffect(() => {
    const node = listRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [messages.length, snapshot.running])

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
      }
    } catch (reason) {
      setSendError(String(reason?.message ?? reason))
    } finally {
      setSending(false)
    }
  }, [draft, face, sending])

  const openNative = useCallback(() => {
    try {
      const uiWorkspace = runtime.ctx.get('uiWorkspace')
      if (uiWorkspace?.openSession) {
        uiWorkspace.openSession(face.sessionId)
        return
      }
      runtime.ctx.get('layout')?.selectPanel?.(null)
    } catch (reason) {
      console.error('[jiashi] open session failed', reason)
    }
  }, [face])

  const title = seedTitle || '对话'
  const stateLabel = snapshot.removed
    ? '已移除'
    : snapshot.openState === 'loading'
      ? '载入中'
      : snapshot.running
        ? '生成中'
        : '就绪'

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.title} title={title}>{title}</span>
        <span style={styles.state}>{stateLabel}</span>
        <button type="button" style={styles.linkButton} onClick={openNative} onPointerDown={stopPointer} title="回到线性对话">
          打开
        </button>
      </div>
      <div ref={listRef} style={styles.messages} onPointerDown={stopPointer} onWheel={stopPointer}>
        {messages.length === 0 ? (
          <div style={styles.empty}>还没有消息。直接在下面输入，会和原生对话写进同一个会话。</div>
        ) : (
          messages.map((message) => (
            <div
              key={`${message.seq}-${message.role}`}
              style={message.role === 'user' ? styles.userMessage : styles.assistantMessage}
            >
              {message.text}
            </div>
          ))
        )}
      </div>
      {sendError === '' ? null : <div style={styles.error}>{sendError}</div>}
      <div style={styles.composer} onPointerDown={stopPointer}>
        <textarea
          value={draft}
          placeholder="在这个会话里说点什么…"
          rows={2}
          style={styles.input}
          onPointerDown={stopPointer}
          onWheel={stopPointer}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <button type="button" style={styles.sendButton} onClick={() => void send()} disabled={sending}>
          {sending ? '…' : '发送'}
        </button>
      </div>
    </div>
  )
}

function stopPointer(event) {
  event.stopPropagation()
}

/* ------------------------------------------------------------------ *
 * tldraw shape：一张会话卡
 * ------------------------------------------------------------------ */

class SessionCardShapeUtil extends BaseBoxShapeUtil {
  static type = CARD_TYPE
  static props = {
    w: T.number,
    h: T.number,
    sessionId: T.string,
    title: T.string,
  }

  getDefaultProps() {
    return { w: 440, h: 340, sessionId: '', title: '' }
  }

  canResize() {
    return true
  }

  isAspectRatioLocked() {
    return false
  }

  component(shape) {
    return (
      <HTMLContainer
        style={{
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          // tldraw 的 HTML 容器默认 pointer-events:none（点击会穿透到画布选形状）。
          // 卡片里的输入框/按钮要能点，必须显式打开；内部再 stopPropagation 避免拖动。
          pointerEvents: 'all',
          borderRadius: 14,
          border: '1px solid rgba(127,127,127,0.35)',
          background: 'var(--dsw-alias-bg-base, #ffffff)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.14)',
          color: 'var(--dsw-alias-label-primary, #1f1f1f)',
          fontFamily: 'inherit',
          fontSize: 12,
        }}
      >
        <SessionCard sessionId={shape.props.sessionId} seedTitle={shape.props.title} />
      </HTMLContainer>
    )
  }

  indicator(shape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={14} />
  }
}

/* ------------------------------------------------------------------ *
 * 画布主面板
 * ------------------------------------------------------------------ */

const EMPTY_SESSIONS = { ids: [], byId: {}, current: undefined }
const EMPTY_WORKSPACES = { items: [] }

/** 画布渲染崩溃时：显示可读错误 + 写日志（DSH 的 slot 错误边界只给空 div）。 */
class BoardBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    boardLog('board.crash', {
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? '').slice(0, 4000),
      componentStack: String(info?.componentStack ?? '').slice(0, 2000),
    })
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div style={{ padding: 20, fontSize: 12, lineHeight: 1.7, color: '#e5484d', fontFamily: 'Consolas, monospace' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>画布渲染失败</div>
          <div>{String(this.state.error?.message ?? this.state.error)}</div>
          <div style={{ color: 'var(--dsw-alias-label-tertiary, #777)' }}>已写入 $DSH_HOME/jiashi/board.log</div>
        </div>
      )
    }
    return this.props.children
  }
}

function BoardEntry(props) {
  return (
    <BoardBoundary>
      <Board {...props} />
    </BoardBoundary>
  )
}

function Board(props) {
  // 主面板由 shell 注入标准 hooks；这里留一个空实现兜底，避免 slot 形态变化时整块崩掉。
  const useSessionsHook = props.useSessions ?? ((selector) => selector(EMPTY_SESSIONS))
  const useWorkspacesHook = props.useWorkspaces ?? ((selector) => selector(EMPTY_WORKSPACES))
  const sessions = useSessionsHook((state) => state) ?? EMPTY_SESSIONS
  const workspaces = useWorkspacesHook((state) => state) ?? EMPTY_WORKSPACES
  const sessionIds = sessions.ids ?? []
  const sessionsById = sessions.byId ?? {}
  const [editor, setEditor] = useState(null)
  const [notice, setNotice] = useState('')
  const [cardCount, setCardCount] = useState(0)

  const refreshCardCount = useCallback(() => {
    if (editor === null) return
    setCardCount(editor.getCurrentPageShapes().filter((shape) => shape.type === CARD_TYPE).length)
  }, [editor])

  useEffect(() => {
    refreshCardCount()
  }, [refreshCardCount])

  const workspaceId = useMemo(() => {
    const current = sessions.current ?? sessionIds[0]
    const items = workspaces?.items ?? []
    const owner = current === undefined ? undefined : items.find((item) => item.sessionIds.includes(current))
    return (owner ?? items[0])?.workspaceId
  }, [sessions.current, sessionIds, workspaces?.items])

  // 诊断：进面板时把会话/工作区状态写进宿主日志（排查"画布空/不能用"）。
  useEffect(() => {
    boardLog('board.state', {
      current: sessions.current === undefined ? null : String(sessions.current),
      ids: sessionIds.length,
      workspaces: (workspaces?.items ?? []).length,
      phase: sessions.phase ?? null,
      hasUseSessions: typeof props.useSessions,
      hasUseWorkspaces: typeof props.useWorkspaces,
    })
  }, [sessions.current, sessionIds.length, workspaces?.items.length, sessions.phase])

  useEffect(() => {
    boardLog('editor.mount', { mounted: editor !== null })
  }, [editor])

  const addCard = useCallback(
    (sessionId, title) => {
      if (editor === null || sessionId === undefined || sessionId === null) return
      const existing = editor
        .getCurrentPageShapes()
        .filter((shape) => shape.type === CARD_TYPE && shape.props.sessionId === sessionId)
      if (existing.length > 0) return
      const count = editor.getCurrentPageShapes().filter((shape) => shape.type === CARD_TYPE).length
      editor.createShape({
        id: createShapeId(),
        type: CARD_TYPE,
        x: 80 + (count % 3) * 480,
        y: 80 + Math.floor(count / 3) * 400,
        props: { w: 440, h: 340, sessionId, title: title ?? '' },
      })
      boardLog('card.add', { sessionId: String(sessionId) })
      refreshCardCount()
    },
    [editor, refreshCardCount],
  )

  // 打开画布时，保证"当前会话"一定有一张卡（已有的不重复）。
  useEffect(() => {
    if (editor === null) return
    const current = sessions.current
    if (current === undefined || current === null) return
    addCard(current, sessionsById[current]?.displayTitle ?? '')
  }, [editor, sessions.current, sessionsById, addCard])

  const createSession = useCallback(async () => {
    setNotice('')
    try {
      // 走宿主同源路由建会话：宿主直接调 sessionController.create，
      // 不依赖客户端 Remote 的 inject，也不会切走画布或弹选择框。
      const url = new URL('jiashi/api/session/create', document.baseURI).href
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(workspaceId === undefined ? {} : { workspaceId }),
      })
      const data = await response.json().catch(() => null)
      if (data !== null && data.ok === true && typeof data.sessionId === 'string' && data.sessionId !== '') {
        boardLog('session.create-ok', { sessionId: data.sessionId })
        addCard(data.sessionId, '')
        return
      }
      const message = data?.error?.message ?? '未知错误'
      setNotice('新建会话失败：' + message)
      boardLog('session.create-failed', { code: data?.error?.code ?? 'unknown', message })
    } catch (reason) {
      setNotice('新建会话失败：' + String(reason?.message ?? reason))
      boardLog('session.create-error', { error: String(reason?.message ?? reason) })
    }
  }, [workspaceId, addCard])

  /** 直接创建一张"当前对话"卡片；没有当前会话时新建一条会话。 */
  const createCard = useCallback(() => {
    setNotice('')
    if (editor === null) return
    const current = sessions.current
    if (current === undefined || current === null) {
      void createSession()
      return
    }
    addCard(current, sessionsById[current]?.displayTitle ?? '')
  }, [editor, sessions.current, sessionsById, addCard, createSession])

  /** 在原画布上画一个纯文本便签（tldraw 原生 text shape，双击可编辑）。 */
  const createTextBox = useCallback(() => {
    setNotice('')
    if (editor === null) return
    try {
      const bounds = editor.getViewportPageBounds()
      const id = createShapeId()
      editor.createShape({
        id,
        type: 'text',
        x: bounds.x + bounds.w / 2 - 110,
        y: bounds.y + bounds.h / 2 - 20,
      })
      editor.select(id)
      try {
        editor.setEditingShape(id)
      } catch {
        /* 老版本没有 setEditingShape 时，用户双击也能编辑 */
      }
      boardLog('textbox.add', {})
    } catch (reason) {
      setNotice('新建文本框失败：' + String(reason?.message ?? reason))
      boardLog('textbox.error', { error: String(reason?.message ?? reason) })
    }
  }, [editor])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <Tldraw
        shapeUtils={[SessionCardShapeUtil]}
        persistenceKey="dsh-jiashi-board-v2"
        onMount={(mountedEditor) => {
          setEditor(mountedEditor)
        }}
      />
      {notice === '' ? null : (
        <div style={styles.notice} onPointerDown={stopPointer}>
          {notice}
        </div>
      )}

      {/* 固定工具栏：不依赖 tldraw 的 UI，保证一定有"创建"入口 */}
      <div style={styles.toolbar} onPointerDown={stopPointer}>
        <button type="button" style={styles.toolbarPrimary} onClick={() => void createCard()}>
          ＋ 对话卡
        </button>
        <button type="button" style={styles.toolbarButton} onClick={() => void createSession()}>
          ＋ 新对话
        </button>
        <button type="button" style={styles.toolbarButton} onClick={createTextBox}>
          ＋ 文本框
        </button>
      </div>

      {editor !== null && cardCount === 0 ? (
        <div style={styles.emptyState} onPointerDown={stopPointer}>
          <div style={styles.emptyTitle}>画布还是空的</div>
          <div style={styles.emptyText}>
            「＋ 对话卡」把一张卡绑到一条 DSH 对话上：卡片里发消息，原生对话里也能看到，两边是同一份数据。
            「＋ 文本框」是纯便签，不绑定会话。
          </div>
          <div style={styles.emptyActions}>
            <button type="button" style={styles.emptyPrimary} onClick={() => void createCard()}>
              ＋ 对话卡
            </button>
            <button type="button" style={styles.emptySecondary} onClick={createTextBox}>
              ＋ 文本框
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 左侧栏面板行图标
 * ------------------------------------------------------------------ */

function PanelIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="10" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="10" y="13" width="10" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 11v2h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  injectTldrawCss()
  runtime.ctx = ctx
  runtime.bridge = createSessionBridge(ctx)
  boardLog('module.load', { version: '0.2.5-diag', href: String(document.baseURI) })

  // 版本探针：渲染 null，只用来确认新模块是否已经在页面里生效（排查用，后续删）。
  ctx.effect(
    () => ctx.slots.register({ name: 'shell.overlay', id: 'jiashi-probe' }, () => null),
    'jiashi: probe',
  )

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'jiashi: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.effect(
    () => ctx.slots.register({ name: 'main', key: MAIN_KEY, locale: NS }, BoardEntry),
    'jiashi: main panel',
  )
  ctx.effect(
    () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: MAIN_KEY,
          order: 20,
          locale: NS,
          label: () => t('panel.label'),
        },
        PanelIcon,
      ),
    'jiashi: sidebar entry',
  )
}

export const inject = ['slots', 'locale']

/* ------------------------------------------------------------------ *
 * 内联样式（先不引入 CSS 文件，保持产物简单）
 * ------------------------------------------------------------------ */

const styles = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minHeight: 0,
  },
  cardFallback: {
    padding: 16,
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary, #777)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    borderBottom: '1px solid rgba(127,127,127,0.22)',
    flex: 'none',
  },
  title: {
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 13,
    fontWeight: 600,
  },
  state: {
    flex: 'none',
    fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary, #777)',
  },
  linkButton: {
    flex: 'none',
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
    cursor: 'pointer',
    fontSize: 11,
    padding: '2px 4px',
  },
  messages: {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '8px 10px',
  },
  empty: {
    color: 'var(--dsw-alias-label-tertiary, #777)',
    fontSize: 11,
    lineHeight: 1.5,
  },
  userMessage: {
    alignSelf: 'flex-end',
    maxWidth: '86%',
    padding: '6px 9px',
    borderRadius: 10,
    background: 'var(--dsw-alias-interactive-bg-active, rgba(77,107,254,0.12))',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    lineHeight: 1.45,
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    maxWidth: '92%',
    padding: '6px 9px',
    borderRadius: 10,
    background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    lineHeight: 1.45,
  },
  error: {
    flex: 'none',
    padding: '0 10px 4px',
    fontSize: 11,
    color: '#e5484d',
  },
  composer: {
    flex: 'none',
    display: 'flex',
    gap: 6,
    padding: 8,
    borderTop: '1px solid rgba(127,127,127,0.22)',
  },
  input: {
    flex: '1 1 auto',
    resize: 'none',
    border: '1px solid rgba(127,127,127,0.3)',
    borderRadius: 8,
    background: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 12,
    lineHeight: 1.45,
    padding: '6px 8px',
    outline: 'none',
  },
  sendButton: {
    flex: 'none',
    alignSelf: 'flex-end',
    border: 'none',
    borderRadius: 8,
    background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: 12,
    padding: '7px 12px',
  },
  newCardButton: {
    position: 'absolute',
    left: 16,
    bottom: 16,
    zIndex: 1000,
    border: '1px solid rgba(127,127,127,0.35)',
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-base, #ffffff)',
    color: 'var(--dsw-alias-label-primary, #1f1f1f)',
    cursor: 'pointer',
    fontSize: 12,
    padding: '8px 12px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
  },
  notice: {
    position: 'absolute',
    left: 16,
    top: 112,
    zIndex: 1001,
    maxWidth: 420,
    border: '1px solid rgba(229,72,77,0.5)',
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-base, #ffffff)',
    color: '#e5484d',
    fontSize: 12,
    lineHeight: 1.5,
    padding: '8px 12px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
  },
  toolbar: {
    position: 'absolute',
    top: 60,
    left: 12,
    zIndex: 1001,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: 6,
    borderRadius: 12,
    border: '1px solid rgba(127,127,127,0.28)',
    background: 'var(--dsw-alias-bg-base, #ffffff)',
    boxShadow: '0 6px 20px rgba(0,0,0,0.14)',
  },
  toolbarPrimary: {
    border: 'none',
    borderRadius: 8,
    background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    padding: '7px 11px',
  },
  toolbarButton: {
    border: '1px solid rgba(127,127,127,0.3)',
    borderRadius: 8,
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary, #1f1f1f)',
    cursor: 'pointer',
    fontSize: 12,
    padding: '6px 10px',
  },
  emptyState: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 1000,
    width: 380,
    maxWidth: '80%',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: 18,
    borderRadius: 16,
    border: '1px solid rgba(127,127,127,0.28)',
    background: 'var(--dsw-alias-bg-base, #ffffff)',
    boxShadow: '0 12px 40px rgba(0,0,0,0.16)',
    color: 'var(--dsw-alias-label-primary, #1f1f1f)',
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: 600,
  },
  emptyText: {
    fontSize: 12,
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-tertiary, #666)',
  },
  emptyActions: {
    display: 'flex',
    gap: 8,
    marginTop: 2,
  },
  emptyPrimary: {
    border: 'none',
    borderRadius: 8,
    background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: 12,
    padding: '8px 12px',
  },
  emptySecondary: {
    border: '1px solid rgba(127,127,127,0.3)',
    borderRadius: 8,
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary, #1f1f1f)',
    cursor: 'pointer',
    fontSize: 12,
    padding: '7px 12px',
  },
}
