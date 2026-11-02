import { Tldraw, useEditor, createShapeId, Editor, useActions, useTools, TLUiEventSource, TLShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import { TextBlockShapeUtil, createChildBlock, DEFAULT_W, DEFAULT_H } from './shapes/TextBlockShapeUtil'
import LinearView from './components/LinearView'
import AISettingsPanel from './components/AISettingsPanel'
import { KeyboardInterceptor } from './keyboard/KeyboardInterceptor'
import { ShortcutEditor } from './keyboard/ShortcutEditor'
import {
  AttentionModeOverlay,
  enterAttentionLayout,
  exitAttentionLayout,
  getAttnZoomCap,
  AttnLayoutSnapshot,
} from './components/AttentionMode'
import { injectDemoShapes } from './demo'
import { useCallback, useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { initStore } from './ai/conversation'
import { createDshSessionId, nextSeqAfter, sessionLog } from './session/bridge'

const customShapeUtils = [TextBlockShapeUtil]

type AppMode = 'canvas' | 'linear'

/**
 * Toolbar — overlays on top of tldraw canvas.
 * Only rendered in canvas mode. In linear mode, LinearView has its own bar.
 */
function CustomToolbar({ onToggleMode, onOpenSettings, onOpenShortcuts, onToggleAttention, attentionActive, onCreateSessionCard, onAddChildCard, onCleanEmptyCards, onClearBoard }: {
  onToggleMode: () => void
  onOpenSettings: () => void
  onOpenShortcuts: () => void
  onToggleAttention: () => void
  attentionActive: boolean
  onCreateSessionCard: () => void
  onAddChildCard: () => void
  onCleanEmptyCards: () => void
  onClearBoard: () => void
}) {
  const editor = useEditor()

  const addTextBlock = useCallback(() => {
    const id = createShapeId()
    const viewport = editor.getViewportScreenBounds()
    const cx = viewport.w / 2 + (Math.random() - 0.5) * 200
    const cy = viewport.h / 2 + (Math.random() - 0.5) * 200
    const point = editor.screenToPage({ x: cx, y: cy })
    editor.createShape({ id, type: 'text-block', x: point.x, y: point.y })
    editor.select(id)
  }, [editor])

  const activateArrow = useCallback(() => {
    editor.setCurrentTool('arrow')
  }, [editor])

  const activateSelect = useCallback(() => {
    editor.setCurrentTool('select')
  }, [editor])

  return (
    <div className="custom-toolbar">
      {/* Select tool */}
      <button className="toolbar-btn" onClick={activateSelect} title="选择工具 (V)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
        </svg>
        <span className="toolbar-label">选择</span>
      </button>

      {/* Add text block */}
      <button className="toolbar-btn" onClick={addTextBlock} title="新建文本方框">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <line x1="8" y1="9" x2="16" y2="9" />
          <line x1="8" y1="13" x2="13" y2="13" />
          <line x1="8" y1="17" x2="11" y2="17" />
        </svg>
        <span className="toolbar-label">文本方框</span>
      </button>

      {/* Arrow tool */}
      <button className="toolbar-btn" onClick={activateArrow} title="箭头连线工具">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="5" y1="19" x2="19" y2="5" />
          <polyline points="12 5 19 5 19 12" />
        </svg>
        <span className="toolbar-label">箭头连线</span>
      </button>

      {/* DSH 对话卡：文本方框 + 绑定一条真实会话 */}
      <button className="toolbar-btn toolbar-btn-accent" onClick={onCreateSessionCard} title="新建对话卡（绑定一条 DSH 会话）">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6a8 8 0 0 1 8-8h2a8 8 0 0 1 8 3z" />
          <line x1="9" y1="11" x2="15" y2="11" />
          <line x1="9" y1="15" x2="13" y2="15" />
        </svg>
        <span className="toolbar-label">对话卡</span>
      </button>

      {/* 子卡：从选中的卡片向下新建一张（拖出手柄的按钮版兜底） */}
      <button className="toolbar-btn" onClick={onAddChildCard} title="从选中的卡片向下新建一张子卡（等同于拖出底边手柄）">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="3" width="16" height="7" rx="2" />
          <line x1="12" y1="10" x2="12" y2="16" />
          <polyline points="9 13 12 16 15 13" />
          <rect x="7" y="17" width="10" height="5" rx="1.5" />
        </svg>
        <span className="toolbar-label">子卡</span>
      </button>

      {/* Divider */}
      <div className="toolbar-divider" />

      {/* 清理空卡：删掉没有内容也没有绑定会话的文本方框（可撤销） */}
      <button className="toolbar-btn" onClick={onCleanEmptyCards} title="清理空卡：删除没有内容、也没有绑定会话的文本方框（可撤销）">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </svg>
        <span className="toolbar-label">清理空卡</span>
      </button>

      {/* 清空画布：删除当前页所有卡片（可撤销；不删除 DSH 会话本身） */}
      <button className="toolbar-btn" onClick={onClearBoard} title="清空画布：删除当前页所有卡片与连线（可撤销，不删 DSH 会话）">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="20" x2="9" y2="9" />
          <path d="M13 13l5 5M18 13l-5 5" />
        </svg>
        <span className="toolbar-label">清空画布</span>
      </button>

      {/* Attention / focus mode */}
      <button
        className="toolbar-btn"
        onClick={onToggleAttention}
        title="注意力模式（Alt+T，先选中一个文本方框）"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" strokeLinecap="round" />
          <circle cx="12" cy="12" r="8" strokeDasharray="2 3" />
        </svg>
        <span className="toolbar-label">{attentionActive ? '退出专注' : '专注'}</span>
      </button>

      {/* Mode toggle: canvas → linear */}
      <button className="toolbar-btn toolbar-btn-accent" onClick={onToggleMode} title="切换到线性视图">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
        <span className="toolbar-label">线性视图</span>
      </button>

      {/* Settings */}
      <button className="toolbar-btn toolbar-btn-settings" onClick={onOpenSettings} title="AI 设置">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span className="toolbar-label">设置</span>
      </button>

      {/* Keyboard shortcuts */}
      <button
        className="toolbar-btn"
        onClick={onOpenShortcuts}
        title="自定义快捷键"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M16 12h.01M6 16h.01M10 16h.01M14 16h.01" />
        </svg>
        <span className="toolbar-label">快捷键</span>
      </button>
    </div>
  )
}

// ─── App root ─────────────────────────────────────────────────────────

/**
 * Global wheel interceptor.
 *  - 注意力模式下：Ctrl+滚轮 → 以焦点框为中心缩放（保持焦点居中于放大镜下），
 *    并限制 zoom ≤ 焦点屏宽上限；普通滚轮仍被吞掉（防画布滚动/页面缩放）。
 *  - 普通模式：Ctrl+滚轮放行给 tldraw（画布缩放）；普通滚轮吞掉。
 */
function WheelInterceptor({
  editor,
  attentionActive,
  attentionFocusId,
  attnZoomCap,
}: {
  editor: Editor
  attentionActive: boolean
  attentionFocusId: string | null
  attnZoomCap: number
}) {
  useEffect(() => {
    const container = editor.getContainer()
    const handler = (e: WheelEvent) => {
      const target = e.target as HTMLElement
      // 文本块内部滚轮 → TextBlockContent 原生处理（滚动内容）
      if (target.closest('.textblock-content')) return
      // 注意力模式下：Ctrl+滚轮 = 以焦点为中心的缩放（中央不动、四周整体缩放）
      if (attentionActive && (e.ctrlKey || e.metaKey)) {
        if (attentionFocusId) {
          const fb = editor.getShapePageBounds(attentionFocusId as TLShapeId)
          if (fb) {
            e.preventDefault()
            e.stopPropagation()
            const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
            const cam = editor.getCamera()
            const next = Math.max(0.12, Math.min(attnZoomCap, cam.z * factor))
            editor.zoomToBounds(fb, { targetZoom: next, inset: 0 })
          }
        }
        return
      }
      // Ctrl+wheel 普通模式 → allow tldraw to zoom
      if (e.ctrlKey || e.metaKey) return
      // Plain wheel outside text blocks: kill the event before tldraw ever sees it
      e.stopPropagation()
      e.preventDefault()
    }
    // 全局门：只要 Ctrl/Cmd+滚轮，就先阻止浏览器默认的"页面缩放"
    //（Page Zoom 会把整个页面/工具栏一起放大）。仅 preventDefault，不阻断
    // 事件传播，让 tldraw 的 wheel handler 仍能收到并正常缩放画布。
    const blockBrowserZoom = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
    }
    // capture:true is critical — our handler fires BEFORE tldraw's internal
    // wheel handler, so we can intercept and stop the event at the gate.
    container.addEventListener('wheel', handler, { capture: true, passive: false })
    // 挂在 document 上：覆盖页面任意位置（包括 tldraw 容器外），防止漏到浏览器。
    document.addEventListener('wheel', blockBrowserZoom, { capture: true, passive: false })
    return () => {
      container.removeEventListener('wheel', handler, { capture: true })
      document.removeEventListener('wheel', blockBrowserZoom, { capture: true })
    }
  }, [editor, attentionActive, attentionFocusId, attnZoomCap])
  return null
}

/**
 * 注意力模式下的指针拦截（框选多选）：
 *  - 空白直接左键拖：拉出矩形**框选**——与矩形相交的四周关联名片被选中（多选）；
 *    按住 Shift 拖 = 在已选基础上追加。命中范围只含"名片态"的四周关联框，
 *    淡化远景框与隐藏的焦点框不参与。
 *  - 空白单击（未拖动）：取消选择。
 *  - 空格+拖 / 中键拖：放行给 tldraw 原生 pan（左键拖已让位给框选）。
 *  - 点在卡片 / 放大镜 / 回正按钮上：放行（选中、拖拽整组、双击编辑）。
 *  焦点真实框由 AttentionModeOverlay 实时钉屏，四周卡随相机自由移动。
 */
function AttentionPanInterceptor({
  editor,
  attentionActive,
}: {
  editor: Editor
  attentionActive: boolean
}) {
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  useEffect(() => {
    if (!attentionActive) return
    const container = editor.getContainer()
    const spaceRef = { down: false }
    let start: { x: number; y: number } | null = null
    let baseSelection: TLShapeId[] = []
    let moved = false
    let raf = 0
    let pending: PointerEvent | null = null

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.down = true
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceRef.down = false
    }

    /** 屏幕矩形 → 与之相交的"四周名片" id 列表（相交即命中，不要求完全包含） */
    const hitTest = (r: { x: number; y: number; w: number; h: number }): TLShapeId[] => {
      const p1 = editor.screenToPage({ x: r.x, y: r.y })
      const p2 = editor.screenToPage({ x: r.x + r.w, y: r.y + r.h })
      const minX = Math.min(p1.x, p2.x)
      const maxX = Math.max(p1.x, p2.x)
      const minY = Math.min(p1.y, p2.y)
      const maxY = Math.max(p1.y, p2.y)
      const ids: TLShapeId[] = []
      for (const s of editor.getCurrentPageShapes()) {
        if (s.type !== 'text-block') continue
        // 只认名片态（有 attn 标记）：远景淡化框、隐藏的焦点框都不参与框选
        if (!(s.props as { attn?: unknown }).attn) continue
        const b = editor.getShapePageBounds(s.id)
        if (!b) continue
        if (b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY) continue
        ids.push(s.id)
      }
      return ids
    }

    const applyMarquee = (e: PointerEvent) => {
      if (!start) return
      const rect = {
        x: Math.min(start.x, e.clientX),
        y: Math.min(start.y, e.clientY),
        w: Math.abs(e.clientX - start.x),
        h: Math.abs(e.clientY - start.y),
      }
      setMarquee(rect)
      const hits = hitTest(rect)
      const ids = baseSelection.length ? [...new Set([...baseSelection, ...hits])] : hits
      editor.setSelectedShapes(ids)
    }

    const onMove = (e: PointerEvent) => {
      if (!start) return
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3) moved = true
      if (!moved) return
      e.preventDefault()
      e.stopPropagation()
      pending = e
      if (!raf) {
        raf = window.requestAnimationFrame(() => {
          raf = 0
          if (pending) applyMarquee(pending)
        })
      }
    }
    const onUp = () => {
      // 单击空白（未拖动、非 Shift 追加）→ 取消选择
      // 注意：这里必须用 setSelectedShapes([])，editor.deselect() 在本项目上下文里是 no-op
      //（实测：3 个选中 → deselect() 后仍为 3；setSelectedShapes([]) 正常清空）
      if (!moved && baseSelection.length === 0) editor.setSelectedShapes([])
      start = null
      baseSelection = []
      moved = false
      pending = null
      setMarquee(null)
      if (raf) { window.cancelAnimationFrame(raf); raf = 0 }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    // document capture：任何 pointerdown 先经此处 → 再决定是否吞掉
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (spaceRef.down) return // 空格拖 → 交给 tldraw 原生 pan
      // 点在卡片/文本框/箭头/浮窗上 → 放行（选中/拖拽/编辑）
      const t = e.target as HTMLElement | null
      if (t && t.closest('.tl-shape, .attn-lens, .attn-recenter-btn')) return
      const rect = container.getBoundingClientRect()
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return
      // 空白拖 → 拉框多选（Shift = 追加选择）
      start = { x: e.clientX, y: e.clientY }
      baseSelection = e.shiftKey ? [...editor.getSelectedShapeIds()] : []
      moved = false
      window.addEventListener('pointermove', onMove, { passive: false })
      window.addEventListener('pointerup', onUp)
      // 吞掉：tldraw 原生框选会连远景淡化框一起选中，命中范围由我们控制
      e.preventDefault()
      e.stopPropagation()
    }

    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [editor, attentionActive])

  if (!marquee) return null
  // 挂到 body：避开 tldraw 容器内部的层叠/裁剪，保证框选矩形永远可见
  return createPortal(
    <div
      className="attn-marquee"
      style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
    />,
    document.body,
  )
}

/**
 * 注意力模式的跨卸载存续状态。
 * 主面板切走时 App 整个卸载，useState/ref 全部丢失 → 回来时会出现
 * "画布还是名片态、但聚焦框没了、Esc 也退出不了"的半状态。
 * 状态存到模块级变量里，切回来时可以恢复（含退出用的布局快照）。
 */
const attentionSession: {
  active: boolean
  focusedId: string | null
  snapshot: AttnLayoutSnapshot | null
} = { active: false, focusedId: null, snapshot: null }

export default function App() {
  const [mode, setMode] = useState<AppMode>('canvas')
  const [showSettings, setShowSettings] = useState(false)
  const [showShortcutEditor, setShowShortcutEditor] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)

  // ── 注意力模式状态 ──
  const [attentionActive, setAttentionActive] = useState(() => attentionSession.active)
  const [attentionFocusedId, setAttentionFocusedId] = useState<string | null>(() => attentionSession.focusedId)
  // 布局快照：进入时保存的原位置/透明度/相机，退出时还原
  const attnSnapshotRef = useRef<AttnLayoutSnapshot | null>(attentionSession.snapshot)
  // 给回调用最新值（避免 useCallback([]) 里的过期闭包）
  const attentionActiveRef = useRef(attentionActive)
  attentionActiveRef.current = attentionActive
  const attentionFocusedIdRef = useRef(attentionFocusedId)
  attentionFocusedIdRef.current = attentionFocusedId

  // 状态变化随时同步到模块级存续对象（含快照），面板切走再回来才能恢复
  useEffect(() => {
    attentionSession.active = attentionActive
    attentionSession.focusedId = attentionFocusedId
    attentionSession.snapshot = attnSnapshotRef.current
  }, [attentionActive, attentionFocusedId])

  // 面板切回来时：恢复注意力状态；若聚焦卡已不存在，干净地退出/清理残留
  useEffect(() => {
    if (!editor) return
    if (!attentionSession.active) {
      // 旧版本留下的半状态：形状上带 attn / 被专注模式压暗但状态没了 →
      // 清掉 attn、恢复不透明度（否则卡片会"消失"，只剩指向它的箭头）。
      const allShapes = editor.getCurrentPageShapes()
      const strays = allShapes.filter((s) => s.type === 'text-block' && (s.props as { attn?: unknown }).attn !== undefined)
      const dimmed = allShapes.filter((s) => (s.opacity ?? 1) < 0.99)
      if (strays.length > 0 || dimmed.length > 0) {
        editor.batch(() => {
          for (const stray of strays) {
            editor.updateShape({ id: stray.id, type: 'text-block', props: { attn: undefined } as never })
          }
          for (const shape of dimmed) {
            editor.updateShape({ id: shape.id, type: shape.type, opacity: 1 } as never)
          }
        })
        sessionLog('attention.clear-stale', { attn: strays.length, dimmed: dimmed.length })
      }
      return
    }
    const id = attentionSession.focusedId
    if (id === null) return
    const shape = editor.getShape(id)
    if (shape === undefined) {
      if (attentionSession.snapshot !== null) exitAttentionLayout(editor, attentionSession.snapshot)
      attentionSession.active = false
      attentionSession.focusedId = null
      attentionSession.snapshot = null
      setAttentionActive(false)
      setAttentionFocusedId(null)
      sessionLog('attention.restore-failed', { shapeId: id })
      return
    }
    attnSnapshotRef.current = attentionSession.snapshot
    setAttentionActive(true)
    setAttentionFocusedId(id)
    sessionLog('attention.restore', { shapeId: id })
  }, [editor])

  // Initialize database and conversation store on mount
  useEffect(() => { initStore() }, [])

  // ── 进入 / 退出注意力布局（只有一层：专注里再聚焦 = 切换焦点） ──
  const enterAttention = useCallback((editor: Editor, shapeId: string) => {
    // 切换焦点：先把旧专注布局还原，再按新焦点重新布局（快照始终是普通画布状态）
    if (attnSnapshotRef.current !== null) {
      exitAttentionLayout(editor, attnSnapshotRef.current)
      attnSnapshotRef.current = null
    }
    if (editor.getEditingShapeId()) editor.setEditingShape(null)
    attnSnapshotRef.current = enterAttentionLayout(editor, shapeId)
    setAttentionActive(true)
    setAttentionFocusedId(shapeId)
    sessionLog('attention.focus', { shapeId })
  }, [])

  const exitAttention = useCallback((editor: Editor) => {
    // 若正处在"名片展开编辑"状态，先退出编辑（触发 onEditEnd 缩回）
    if (editor.getEditingShapeId()) editor.setEditingShape(null)
    if (attnSnapshotRef.current !== null) {
      exitAttentionLayout(editor, attnSnapshotRef.current)
      attnSnapshotRef.current = null
    }
    setAttentionActive(false)
    setAttentionFocusedId(null)
  }, [])

  // ── 安全兜底：active 变 false 而快照仍残留 → 还原（覆盖组件卸载等路径） ──
  useEffect(() => {
    if (attentionActive || !editor || !attnSnapshotRef.current) return
    exitAttentionLayout(editor, attnSnapshotRef.current)
    attnSnapshotRef.current = null
  }, [attentionActive, editor])

  // ── 注意力模式快捷键：Alt+T 进入/切换聚焦，Esc 退出 ──
  useEffect(() => {
    if (!editor) return
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault()
        e.stopPropagation()
        const only = editor.getOnlySelectedShapeId()
        const shape = only ? editor.getShape(only) : null
        const isTextBlock = !!shape && shape.type === 'text-block'
        ;(window as unknown as { __jiashiDebugLog?: (event: string, data: unknown) => void }).__jiashiDebugLog?.(
          'attention.alt-t',
          { only: only ?? null, isTextBlock, attentionActive },
        )
        if (attentionActive) {
          if (isTextBlock && shape.id !== (attentionFocusedId as TLShapeId)) {
            // 在专注模式里选中了另一张卡：进入更深一层（押栈，Esc 可逐层退回）
            enterAttention(editor, shape.id as string)
          } else {
            // 同一框或无选中 → 退出（有上一层则退回上一层）
            exitAttention(editor)
          }
        } else {
          if (isTextBlock) enterAttention(editor, shape.id as string)
        }
      } else if (e.key === 'Escape' && attentionActive) {
        // 焦点在块编辑器的 textarea 里 → 这一下 Esc 归它（退回渲染态），
        // 本处理器挂在 window capture 阶段、比 textarea 先跑，不拦就会一路退到模式外
        const t = e.target as HTMLElement | null
        if (t?.closest?.('.tb-md-textarea')) return
        e.preventDefault()
        e.stopPropagation()
        // 分级退出：正在编辑某张画布卡片（名片展开编辑）→ 先只退出编辑
        //（onEditEnd 自动把卡片缩回缩略）；没有编辑态才真正退出注意力模式。
        const editingId = editor.getEditingShapeId()
        if (editingId) {
          editor.setEditingShape(null)
          return
        }
        exitAttention(editor)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [editor, attentionActive, attentionFocusedId, enterAttention, exitAttention])

  const toggleMode = useCallback(() => {
    setMode(prev => (prev === 'canvas' ? 'linear' : 'canvas'))
  }, [])

  const openSettings = useCallback(() => setShowSettings(true), [])
  const closeSettings = useCallback(() => setShowSettings(false), [])
  const openShortcuts = useCallback(() => setShowShortcutEditor(true), [])
  const closeShortcuts = useCallback(() => setShowShortcutEditor(false), [])

  // 工具栏上的"专注/注意力模式"入口：Alt+T 之外再给一个可见按钮。
  const toggleAttentionUI = useCallback(() => {
    if (!editor) return
    if (attentionActive) {
      exitAttention(editor)
      return
    }
    const onlyId = editor.getOnlySelectedShapeId()
    const selected = onlyId ? editor.getShape(onlyId) : null
    let target = selected && selected.type === 'text-block' ? selected.id : null
    if (!target) {
      const first = editor.getCurrentPageShapes().find((shape) => shape.type === 'text-block')
      if (first) target = first.id
    }
    if (!target) {
      // 画布上还没有文本方框：直接建一个再进入专注，避免按钮点了没反应。
      const bounds = editor.getViewportPageBounds()
      const created = editor.createShape({
        type: 'text-block',
        x: bounds.x + bounds.w / 2 - 220,
        y: bounds.y + bounds.h / 2 - 140,
      })
      target = created.id
    }
    if (target) enterAttention(editor, target)
  }, [editor, attentionActive, enterAttention, exitAttention])

  // 新建"对话卡"：建一条 DSH 会话，再放一个绑定它的文本块。
  const createSessionCard = useCallback(async () => {
    if (!editor) return
    try {
      const sessionId = await createDshSessionId()
      const bounds = editor.getViewportPageBounds()
      const shape = editor.createShape({
        type: 'text-block',
        x: bounds.x + bounds.w / 2 - 220,
        y: bounds.y + bounds.h / 2 - 140,
        props: { conversationId: sessionId },
      })
      editor.select(shape.id)
      sessionLog('session-card.add', { sessionId })
    } catch (error) {
      sessionLog('session-card.create-failed', { error: String((error as Error)?.message ?? error) })
    }
  }, [editor])

  // 工具栏「子卡」：从选中的卡片向下新建一张子卡（拖出手柄的按钮版兜底）。
  const addChildCard = useCallback(() => {
    if (!editor) return
    const onlyId = editor.getOnlySelectedShapeId()
    const selected = onlyId === null ? null : editor.getShape(onlyId)
    const parent = selected !== null && selected.type === 'text-block' ? selected : null
    const bounds = parent === null ? null : editor.getShapePageBounds(parent.id)
    const viewport = editor.getViewportPageBounds()
    const x = bounds === null ? viewport.x + viewport.w / 2 - DEFAULT_W / 2 : bounds.x + (bounds.w - DEFAULT_W) / 2
    const y = bounds === null ? viewport.y + viewport.h / 2 - DEFAULT_H / 2 : bounds.y + bounds.h + 40
    createChildBlock(editor, {
      parentId: parent?.id,
      x,
      y,
      origin: 'bottom',
      arrow: parent !== null,
      kind: 'addchild',
    })
  }, [editor])

  // 手动画箭头连接两张文本块时：目标没有会话就继承来源的会话，并从来源结束位置之后续接。
  useEffect(() => {
    if (!editor) return undefined
    const inherit = (record: any) => {
      if (record?.typeName !== 'shape' || record?.type !== 'arrow') return
      const props = record.props ?? {}
      const fromId = props.start?.boundShapeId
      const toId = props.end?.boundShapeId
      if (typeof fromId !== 'string' || typeof toId !== 'string' || fromId === toId) return
      const from = editor.getShape(fromId)
      const to = editor.getShape(toId)
      if (!from || !to || from.type !== 'text-block' || to.type !== 'text-block') return
      const fromProps = from.props as { conversationId?: string; sessionToSeq?: number }
      const toProps = to.props as { conversationId?: string }
      if (fromProps.conversationId === undefined || toProps.conversationId !== undefined) return
      const next = nextSeqAfter(fromProps.sessionToSeq)
      // store 监听回调里不直接改 store，放到 microtask 里，避免嵌套事务告警。
      queueMicrotask(() => {
        try {
          editor.updateShape({
            id: to.id,
            type: 'text-block',
            props: {
              conversationId: fromProps.conversationId,
              ...(next !== undefined ? { sessionFromSeq: next } : {}),
            },
          })
          sessionLog('session.inherit', { from: from.id, to: to.id, sessionId: fromProps.conversationId })
        } catch (error) {
          sessionLog('session.inherit-failed', { error: String((error as Error)?.message ?? error) })
        }
      })
    }
    const dispose = editor.store.listen(
      ({ changes }) => {
        const added = Object.values((changes as { added?: Record<string, unknown> }).added ?? {})
        const updated = Object.values((changes as { updated?: Record<string, unknown> }).updated ?? {})
        for (const record of [...added, ...updated]) inherit(record)
      },
      { scope: 'document', source: 'user' },
    )
    return () => dispose()
  }, [editor])

  // 诊断：任何位置按下 Ctrl/⌘ + \（或 Ctrl/⌘ + Enter）都记一条，用来判断
  // 事件到底有没有到达渲染进程（板载日志 board.log 里看 splitkey.global）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const isCandidate =
        e.code === 'Backslash' ||
        e.code === 'IntlBackslash' ||
        e.code === 'Enter' ||
        e.key === '\\' ||
        e.key === '、' ||
        e.key === 'Process'
      if (!isCandidate) return
      const target = e.target instanceof HTMLElement ? e.target : null
      sessionLog('splitkey.global', {
        code: e.code,
        key: e.key,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        target: target?.tagName,
        editable:
          target !== null &&
          (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT'),
        active: document.activeElement?.tagName,
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // 清理空卡：删除"没有内容、也没有绑定会话"的普通文本方框（可撤销）。
  const cleanEmptyCards = useCallback(() => {
    if (!editor) return
    const shapes = editor.getCurrentPageShapes()
    const ids = new Set<string>()
    for (const shape of shapes) {
      if (shape.type !== 'text-block') continue
      const props = shape.props as { conversationId?: string; content?: string; items?: unknown }
      if (props.conversationId !== undefined && props.conversationId !== '') continue
      const content = typeof props.content === 'string' ? props.content.trim() : ''
      const items = Array.isArray(props.items) ? props.items : []
      const hasText =
        content !== '' ||
        items.some(
          (item) =>
            item !== null &&
            typeof item === 'object' &&
            (item as { kind?: string }).kind === 'user' &&
            String((item as { text?: string }).text ?? '').trim() !== '',
        )
      if (!hasText) ids.add(shape.id)
    }
    const arrows = shapes.filter((shape) => {
      if (shape.type !== 'arrow') return false
      const props = shape.props as { start?: { boundShapeId?: string }; end?: { boundShapeId?: string } }
      const from = props.start?.boundShapeId
      const to = props.end?.boundShapeId
      return (typeof from === 'string' && ids.has(from)) || (typeof to === 'string' && ids.has(to))
    })
    if (ids.size === 0) {
      sessionLog('cards.clean-empty', { count: 0 })
      return
    }
    editor.batch(() => {
      editor.deleteShapes([...ids, ...arrows.map((shape) => shape.id)])
    })
    sessionLog('cards.clean-empty', { count: ids.size, arrows: arrows.length })
  }, [editor])

  // 清空画布：删除当前页所有卡片/连线（只删画布数据，不删 DSH 会话；tldraw 可撤销）
  const clearBoard = useCallback(() => {
    if (!editor) return
    if (attentionActive) exitAttention(editor)
    const ids = editor.getCurrentPageShapes().map((shape) => shape.id)
    if (ids.length === 0) {
      sessionLog('board.clear', { count: 0 })
      return
    }
    editor.batch(() => {
      editor.deleteShapes(ids)
    })
    editor.selectNone()
    sessionLog('board.clear', { count: ids.length })
  }, [editor, attentionActive, exitAttention])

  // Build root class: adds `linear-mode-active` to hide tldraw canvas
  // and save GPU/CPU when LinearView is covering it.
  const rootClass =
    mode === 'linear'
      ? 'app-root linear-mode-active'
      : attentionActive
        ? 'app-root attention-active'
        : 'app-root'

  return (
    <div className={rootClass}>
      <Tldraw
        shapeUtils={customShapeUtils}
        // 持久化：切走画布面板 / 刷新页面后画布内容不丢（tldraw 本地同步，存在浏览器 origin 下）。
        persistenceKey="dsh-jiashi-board-v1"
        onMount={(editor) => {
          setEditor(editor)
          // 便于自动化验证/调试：暴露编辑器实例
          if (typeof window !== 'undefined') {
            ;(window as unknown as { __editor?: Editor }).__editor = editor
          }
          // ?demo=1 注入测试示例；&reset=1 或画布为空时执行（reset 会清空重建）
          if (typeof window !== 'undefined') {
            const qs = new URLSearchParams(window.location.search)
            if (qs.has('demo')) {
              const wantReset = qs.get('reset') === '1' || qs.get('demo') === 'reset'
              if (wantReset || editor.getCurrentPageShapes().length === 0) {
                if (wantReset) editor.deleteShapes(editor.getCurrentPageShapes())
                injectDemoShapes(editor)
              }
            }
          }
        }}
      >
        {editor && (
          <WheelInterceptor
            editor={editor}
            attentionActive={attentionActive}
            attentionFocusId={attentionFocusedId}
            attnZoomCap={attentionFocusedId && editor ? getAttnZoomCap(editor, attentionFocusedId) : 1}
          />
        )}
        {editor && (
          <AttentionPanInterceptor editor={editor} attentionActive={attentionActive} />
        )}
        <ShortcutBridge
          showShortcutEditor={showShortcutEditor}
          onCloseShortcuts={closeShortcuts}
        />
        {mode === 'canvas' && (
          <CustomToolbar
            onToggleMode={toggleMode}
            onOpenSettings={openSettings}
            onOpenShortcuts={openShortcuts}
            onToggleAttention={toggleAttentionUI}
            attentionActive={attentionActive}
            onCreateSessionCard={createSessionCard}
            onAddChildCard={addChildCard}
            onCleanEmptyCards={cleanEmptyCards}
            onClearBoard={clearBoard}
          />
        )}
        {mode === 'linear' && <LinearView onBackToCanvas={toggleMode} />}
      </Tldraw>
      {/* AI settings panel must be OUTSIDE Tldraw — tldraw's canvas overlay
          layer has pointer-events: none which blocks any dialog inside it. */}
      <AISettingsPanel open={showSettings} onClose={closeSettings} />
      {/* 注意力模式 overlay — 同样放在 Tldraw 外部 */}
      {attentionActive && editor && (
        <AttentionModeOverlay
          editor={editor}
          focusedId={attentionFocusedId}
        />
      )}
    </div>
  )
}

function ShortcutBridge({
  showShortcutEditor,
  onCloseShortcuts,
}: {
  showShortcutEditor: boolean
  onCloseShortcuts: () => void
}) {
  const actions = useActions()
  const tools = useTools()
  const editor = useEditor()

  // Merge actions + tools into a single map of { id → { id, kbd, label, onSelect } }
  const allActions = useMemo(() => {
    const merged: Record<string, { id: string; kbd?: string; label?: string; onSelect: (source: TLUiEventSource) => void }> = {}

    for (const [id, action] of Object.entries(actions)) {
      if (action.kbd || action.label) {
        merged[id] = {
          id,
          kbd: action.kbd,
          label: typeof action.label === 'string' ? action.label : (action.label as any)?.['default'] ?? id,
          onSelect: action.onSelect,
        }
      }
    }

    for (const [id, tool] of Object.entries(tools)) {
      merged[id] = {
        id,
        kbd: tool.kbd,
        label: tool.label || id,
        onSelect: tool.onSelect,
      }
    }

    return merged
  }, [actions, tools])

  return (
    <>
      <KeyboardInterceptor actions={allActions} />
      <ShortcutEditor
        open={showShortcutEditor}
        onClose={onCloseShortcuts}
        actions={allActions}
        editor={editor}
      />
    </>
  )
}
