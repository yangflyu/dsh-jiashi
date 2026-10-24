/**
 * AttentionMode — 注意力模式 v6（中央放大镜 + 四周"真白板框"辐射重排）
 *
 * v6 解决 v5 的"缩略卡拖不动"：把四周关联框换成**画布上的真实框**——
 * 进入注意力模式时，将 上游/子/孙/同对话 的真实 text-block 按 dir/depth
 * 辐射重排到中央放大镜四周（记录原位置+透明度+相机），退出时还原。
 * 因为四周是真实框 + 真实箭头 binding：
 *   - 拖动任意四周框 → 箭头线实时跟随（tldraw 原生）
 *   - 可选中 / 可双击编辑 / Ctrl+滚轮随画布缩放
 *   - 空白左键拖 → 拉框多选（矩形相交即选中，Shift 追加；平移改用空格/中键拖）
 * 中央放大镜仍是 DOM 浮窗（640px），内容独立缩放，不随相机动。
 *
 * 进入流程（App 调 enterAttentionLayout）：
 *   1. getAttentionNodes 找关联（含孙，depth<=2）
 *   2. snapshot 每个将移动/淡化的框 {x,y,opacity} + 相机
 *   3. 非关联 text-block 淡化（远景），焦点框 opacity 0（仍作箭头锚点）
 *   4. 计算辐射布局 → updateShape 移动真实框
 *   5. setCamera 把焦点框中心放到视口中心
 * 退出流程（exitAttentionLayout）：还原所有 x/y/opacity + 相机
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Editor, TLShapeId, createShapeId, toRichText, useValue } from 'tldraw'
import TextBlockContent from './TextBlockContent'
import {
  TextBlockShape,
  MixedItem,
  TITLE_PLACEHOLDER,
  DEFAULT_W,
  DEFAULT_H,
} from '../shapes/TextBlockShapeUtil'

/** 中央放大镜定宽（屏幕 px） */
export const ATTN_WIDTH = 640
/** 中央内容缩放下限 / 上限 */
const SCALE_MIN = 0.5
const SCALE_MAX = 2.6

/** 四周重排：放大镜与列的屏幕间距 / 列间距 / 垂直间距 / 视口留白 */
const GAP_SCREEN = 30
const COL_GAP_SCREEN = 24
const V_GAP_SCREEN = 24
const MARGIN_SCREEN = 20
/** 注意力内相机最小/最大 zoom（由布局适配与焦点上限夹取） */
const ZOOM_MIN = 0.08
const ZOOM_MAX = 1.6

type Dir = 'in' | 'out' | 'conv'

interface AttnNode {
  id: string
  dir: Dir
  depth: number
}

/** 名片目标尺寸（屏幕 px）上限 / 每列可容纳的最大卡数 */
const CARD_W_TARGET = 200
const CARD_H_TARGET = 150
const CARD_W_MIN = 96
const CARD_H_MIN = 84

// ─────────────────────────────────────────────────────────────
// 还原快照：记录进入前每个被改动 shape 的 {x,y,opacity,w,h,attn} 与相机
// ─────────────────────────────────────────────────────────────
export interface AttnSnapshotEntry {
  x: number
  y: number
  opacity: number
  w: number
  h: number
  /** 名片态标记原值（进入时均为 undefined） */
  attn: { dir: string; depth?: number } | undefined
}
export interface AttnLayoutSnapshot {
  camera: { x: number; y: number; z: number }
  shapes: Record<string, AttnSnapshotEntry>
}

/**
 * BFS 遍历焦点框的关联节点（真实箭头 binding）。
 *  - out：焦点 → 子 → 孙（depth 1..2）
 *  - in ：上游 → 焦点（depth 1..2，可延伸上游的上游）
 *  - conv：与焦点同对话但无箭头
 *  返回 node 数组（不含焦点自身）。
 */
function getAttentionNodes(editor: Editor, focusId: string): AttnNode[] {
  const focus = focusId as TLShapeId
  const forward = new Map<string, Set<string>>()
  const reverse = new Map<string, Set<string>>()
  for (const a of editor.getCurrentPageShapes()) {
    if (a.type !== 'arrow') continue
    const bs = editor.getBindingsFromShape(a.id, 'arrow')
    let start: string | null = null
    let end: string | null = null
    for (const b of bs) {
      const term = (b.props as { terminal?: string } | null)?.terminal
      const target = b.toId as unknown as string
      if (term === 'start') start = target
      else if (term === 'end') end = target
    }
    if (start && end) {
      if (!forward.has(start)) forward.set(start, new Set())
      forward.get(start)!.add(end)
      if (!reverse.has(end)) reverse.set(end, new Set())
      reverse.get(end)!.add(start)
    }
  }

  const focusKey = focus as string
  const visited = new Set<string>([focusKey])
  const results: { id: string; dir: Dir; depth: number }[] = []

  interface QItem { id: string; dir: Dir; depth: number }
  const queue: QItem[] = []
  for (const to of forward.get(focusKey) ?? []) queue.push({ id: to, dir: 'out', depth: 1 })
  for (const from of reverse.get(focusKey) ?? []) queue.push({ id: from, dir: 'in', depth: 1 })

  while (queue.length) {
    const cur = queue.shift()!
    if (visited.has(cur.id)) continue
    visited.add(cur.id)
    if (cur.depth <= 2) results.push({ id: cur.id, dir: cur.dir, depth: cur.depth })
    if (cur.depth < 2) {
      if (cur.dir === 'out') {
        for (const to of forward.get(cur.id) ?? []) {
          if (!visited.has(to)) queue.push({ id: to, dir: 'out', depth: cur.depth + 1 })
        }
      } else {
        for (const from of reverse.get(cur.id) ?? []) {
          if (!visited.has(from)) queue.push({ id: from, dir: 'in', depth: cur.depth + 1 })
        }
      }
    }
  }

  const focusShape = editor.getShape<TextBlockShape>(focus)
  const convId = focusShape?.props.conversationId
  if (convId) {
    for (const s of editor.getCurrentPageShapes()) {
      if (s.type !== 'text-block' || s.id === focus) continue
      if (visited.has(s.id as string)) continue
      const sh = s as TextBlockShape
      if (sh.props.conversationId === convId) {
        results.push({ id: s.id as string, dir: 'conv', depth: 1 })
      }
    }
  }
  return results
}

// ─────────────────────────────────────────────────────────────
// 辐射重排布局：以焦点框中心为原点（页面坐标），放大镜区域视为中央禁入区
// ─────────────────────────────────────────────────────────────
interface LayoutResult {
  /** 目标 zoom：把焦点真实框放到与放大镜同宽（≤640px 屏） */
  z: number
  /** 名片页面尺寸（四周框会被 resize 成该尺寸） */
  cardPageW: number
  cardPageH: number
  /** id → 目标 x/y（页面坐标，左上角） */
  targets: Map<string, { x: number; y: number }>
}

/** 注意力模式下四周缩放的上限：焦点真实框屏幕宽 ≤ 放大镜宽（锚点不悬出卡片） */
export function getAttnZoomCap(editor: Editor, focusId: string): number {
  const f = editor.getShape<TextBlockShape>(focusId as TLShapeId)
  const fw = f?.props.w ?? DEFAULT_W
  return ATTN_WIDTH / fw
}

/**
 * 计算布局（进入时）：
 *  1. 求 z = ATTN_WIDTH / focusW（焦点真实框屏幕宽=放大镜宽，锚点与卡片贴齐）
 *  2. 名片屏幕尺寸 → 页面尺寸（÷z）
 *  3. 左右列：从放大镜外缘外开始向两侧铺，列内纵向居中
 */
function computeLayout(
  editor: Editor,
  focus: TextBlockShape,
  nodes: AttnNode[],
  vw: number,
  vh: number,
): LayoutResult {
  const fw = focus.props.w || DEFAULT_W
  const focusCX = focus.x + fw / 2
  const focusCY = focus.y + (focus.props.h || DEFAULT_H) / 2

  const inN = nodes.filter((n) => n.dir === 'in')
  const o1 = nodes.filter((n) => n.dir === 'out' && n.depth === 1)
  const o2 = nodes.filter((n) => n.dir === 'out' && n.depth === 2)
  const conv = nodes.filter((n) => n.dir === 'conv')
  const leftCols = [inN, conv].filter((c) => c.length > 0)
  const rightCols = [o1, o2].filter((c) => c.length > 0)

  const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, ATTN_WIDTH / fw))

  const maxColW = Math.max(leftCols.length, rightCols.length)
  const maxStack = Math.max(0, ...leftCols.map((c) => c.length), ...rightCols.map((c) => c.length))
  const sideAvail = vw / 2 - ATTN_WIDTH / 2 - GAP_SCREEN - MARGIN_SCREEN
  const colAvail = maxColW > 0 ? (sideAvail - (maxColW - 1) * COL_GAP_SCREEN) / maxColW : sideAvail
  const cardScreenW = Math.max(CARD_W_MIN, Math.min(CARD_W_TARGET, colAvail))
  const rowAvail = maxStack > 0 ? (vh - 2 * MARGIN_SCREEN - (maxStack - 1) * V_GAP_SCREEN) / maxStack : vh
  const cardScreenH = Math.max(CARD_H_MIN, Math.min(CARD_H_TARGET, rowAvail))

  // 页面单位尺寸：名片屏幕目标 / z
  const cardPageW = cardScreenW / z
  const cardPageH = cardScreenH / z

  // 页面间距 = 屏幕间距 / z
  const lensHalf = ATTN_WIDTH / 2
  const innerGapPage = (lensHalf + GAP_SCREEN) / z
  const colGapPage = COL_GAP_SCREEN / z
  const vGapPage = V_GAP_SCREEN / z

  const targets = new Map<string, { x: number; y: number }>()
  const stackCol = (col: AttnNode[], colX: number, alignRight: boolean) => {
    const totH = col.length * cardPageH + (col.length - 1) * vGapPage
    let y = focusCY - totH / 2
    col.forEach((n) => {
      const x = alignRight ? colX - cardPageW : colX
      targets.set(n.id, { x, y })
      y += cardPageH + vGapPage
    })
  }

  // 右侧列：从放大镜右缘外开始向右铺
  let rx = focusCX + innerGapPage
  for (const col of rightCols) {
    stackCol(col, rx, false)
    rx += cardPageW + colGapPage
  }
  // 左侧列：从放大镜左缘外开始向左铺（近镜 in，外侧 conv）
  let lx = focusCX - innerGapPage
  for (const col of leftCols) {
    stackCol(col, lx, true)
    lx -= cardPageW + colGapPage
  }

  return { z, cardPageW, cardPageH, targets }
}

// ─────────────────────────────────────────────────────────────
// 进入 / 退出布局
// ─────────────────────────────────────────────────────────────

/**
 * 进入注意力模式：将四周关联真实框 resize 成"名片"尺寸并辐射重排 + 淡化非关联
 * + 隐藏焦点真实框 + 相机聚焦。返回快照，退出时传给 exitAttentionLayout 还原。
 */
export function enterAttentionLayout(editor: Editor, focusId: string): AttnLayoutSnapshot {
  const focus = editor.getShape<TextBlockShape>(focusId as TLShapeId)
  if (!focus) return { camera: editor.getCamera(), shapes: {} }

  const nodes = getAttentionNodes(editor, focusId)
  const relatedIds = new Set<string>(nodes.map((n) => n.id))
  relatedIds.add(focusId)

  const vp = editor.getViewportScreenBounds()
  const { z, cardPageW, cardPageH, targets } = computeLayout(editor, focus, nodes, vp.w, vp.h)

  const shapes: Record<string, AttnSnapshotEntry> = {}
  const snap = (id: string) => {
    const s = editor.getShape(id as TLShapeId)
    if (s && !shapes[id]) {
      const tb = s as TextBlockShape
      shapes[id] = {
        x: s.x,
        y: s.y,
        opacity: s.opacity ?? 1,
        w: tb.props.w,
        h: tb.props.h,
        attn: tb.props.attn,
      }
    }
  }

  // 快照：所有将被移动/缩放/隐藏的关联框 + 将被淡化的非关联 text-block
  for (const n of nodes) snap(n.id)
  snap(focusId)
  const allShapes = editor.getCurrentPageShapes()
  const fadeTargets: { id: string; opacity: number }[] = []
  for (const s of allShapes) {
    if (s.type !== 'text-block') continue
    if (relatedIds.has(s.id as string)) continue
    snap(s.id as string)
    fadeTargets.push({ id: s.id as string, opacity: 0.05 })
  }

  const camera = editor.getCamera()

  // 非关联箭头（两端都不在关联集内）也一并淡化，避免"鬼线"
  const arrowFades: { id: string; opacity: number }[] = []
  for (const s of allShapes) {
    if (s.type !== 'arrow') continue
    const bs = editor.getBindingsFromShape(s.id, 'arrow')
    let touched = false
    for (const b of bs) {
      const target = b.toId as unknown as string
      if (relatedIds.has(target)) { touched = true; break }
    }
    if (!touched) {
      snap(s.id as string)
      arrowFades.push({ id: s.id as string, opacity: 0.05 })
    }
  }

  editor.batch(() => {
    // 淡化非关联框（远景）
    for (const t of fadeTargets) {
      editor.updateShape({ id: t.id as TLShapeId, type: 'text-block', opacity: t.opacity })
    }
    // 淡化非关联箭头
    for (const t of arrowFades) {
      editor.updateShape({ id: t.id as TLShapeId, type: 'arrow', opacity: t.opacity })
    }
    // 焦点真实框隐藏（仍作箭头锚点）
    editor.updateShape({ id: focusId as TLShapeId, type: 'text-block', opacity: 0 })
    // 四周关联真实框：resize 成名片 + 打 attn 标记 + 移到辐射位置
    for (const n of nodes) {
      const pos = targets.get(n.id)
      if (!pos) continue
      editor.updateShape({
        id: n.id as TLShapeId,
        type: 'text-block',
        x: pos.x,
        y: pos.y,
        props: { w: cardPageW, h: cardPageH, attn: { dir: n.dir, depth: n.depth } },
      })
    }
  })

  // 相机：焦点框中心对齐视口中心 + zoom 适配（不随动画，瞬时切换）
  const fb = editor.getShapePageBounds(focusId as TLShapeId)
  if (fb) editor.zoomToBounds(fb, { targetZoom: z, inset: 0 })

  return { camera, shapes }
}

/** 退出注意力模式：还原所有框位置/尺寸/透明度/attn 标记 + 相机 */
export function exitAttentionLayout(editor: Editor, snapshot: AttnLayoutSnapshot) {
  editor.batch(() => {
    for (const [id, entry] of Object.entries(snapshot.shapes)) {
      const s = editor.getShape(id as TLShapeId)
      if (!s) continue
      if (s.type === 'text-block') {
        editor.updateShape({
          id: id as TLShapeId,
          type: 'text-block',
          x: entry.x,
          y: entry.y,
          opacity: entry.opacity,
          props: { w: entry.w, h: entry.h, attn: entry.attn },
        })
      } else {
        editor.updateShape({
          id: id as TLShapeId,
          type: 'arrow',
          x: entry.x,
          y: entry.y,
          opacity: entry.opacity,
        })
      }
    }
    if (snapshot.camera) editor.setCamera(snapshot.camera)
  })
}

/** 计算"放大镜右侧、落在画布上"的页面落点（拉出创建子框用） */
export function attentionChildDropPage(editor: Editor): { x: number; y: number } {
  const vp = editor.getViewportScreenBounds()
  const sx = vp.w / 2 + ATTN_WIDTH / 2 + 160
  const sy = vp.h / 2
  return editor.screenToPage({ x: sx, y: sy })
}

/** 把焦点真实框（虚空卡）钉在屏幕中心（放大镜正下方）。
 *  无论相机如何 pan/zoom，虚拟卡页面坐标 = 视口中心对应的页面点 → 永不露出。
 *  用 history:'ignore' 避免相机拖动产生大量撤销点。 */
export function pinFocusToViewportCenter(editor: Editor, focusId: string) {
  const f = editor.getShape<TextBlockShape>(focusId as TLShapeId)
  if (!f) return
  const center = editor.getViewportPageBounds().center
  editor.run(
    () => {
      editor.updateShape({
        id: f.id as TLShapeId,
        type: 'text-block',
        x: center.x - f.props.w / 2,
        y: center.y - f.props.h / 2,
      })
    },
    { history: 'ignore' },
  )
}

/** 回正：把四周关联框重新排回"整齐环绕"位 + 相机聚焦回进入布局的 zoom。
 *  不重记快照——退出注意力仍按进入前快照还原白板原样。 */
export function recenterAttentionView(editor: Editor, focusId: string) {
  const focus = editor.getShape<TextBlockShape>(focusId as TLShapeId)
  if (!focus) return
  pinFocusToViewportCenter(editor, focusId)
  const nodes = getAttentionNodes(editor, focusId)
  const vp = editor.getViewportScreenBounds()
  const { z, cardPageW, cardPageH, targets } = computeLayout(editor, focus, nodes, vp.w, vp.h)
  editor.batch(() => {
    for (const n of nodes) {
      const pos = targets.get(n.id)
      if (!pos) continue
      editor.updateShape({
        id: n.id as TLShapeId,
        type: 'text-block',
        x: pos.x,
        y: pos.y,
        props: { w: cardPageW, h: cardPageH, attn: { dir: n.dir, depth: n.depth } },
      })
    }
  })
  const fb = editor.getShapePageBounds(focusId as TLShapeId)
  if (fb) editor.zoomToBounds(fb, { targetZoom: z, inset: 0 })
}

// ─────────────────────────────────────────────────────────────
// DOM 部件（标题编辑 / 拉出手柄 / 放大镜浮窗）
// ─────────────────────────────────────────────────────────────

/** 中央卡片头部：可双击编辑标题 */
function AttnTitle({ shape, editor, isDarkMode }: { shape: TextBlockShape; editor: Editor; isDarkMode: boolean }) {
  const [editing, setEditing] = useState(false)
  const title = shape.props.title?.trim() || TITLE_PLACEHOLDER
  const commit = (raw: string) => {
    const t = raw.trim() || TITLE_PLACEHOLDER
    editor.updateShape<TextBlockShape>({ id: shape.id, type: 'text-block', props: { title: t } })
    setEditing(false)
  }
  return (
    <div className="attention-center-header" style={{ color: isDarkMode ? '#cdd6f4' : '#444441' }}>
      {editing ? (
        <input
          className="attn-title-input"
          autoFocus
          defaultValue={title}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit((e.target as HTMLInputElement).value) }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false) }
          }}
          onBlur={(e) => commit(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="attn-header-title"
          title="双击编辑标题"
          onDoubleClick={(e) => { e.stopPropagation(); setEditing(true) }}
        >
          {title}
        </span>
      )}
      <span className="attn-header-hint">四周真框可拖/连线跟随 · 空白拖=框选多选 · 空格/中键拖=平移 · 双击卡片编辑 · Esc 退出</span>
    </div>
  )
}

/** 边缘拉出手柄（bottom/right）：拖出超过阈值 → 在放大镜右侧创建空子框 */
function AttnPullHandle({ dir, onCreate }: { dir: 'bottom' | 'right'; onCreate: () => void }) {
  const [active, setActive] = useState(false)
  const startRef = useRef({ x: 0, y: 0 })
  const firedRef = useRef(false)

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    startRef.current = { x: e.clientX, y: e.clientY }
    firedRef.current = false
    setActive(true)
    const move = (ev: PointerEvent) => {
      if (firedRef.current) return
      const dx = ev.clientX - startRef.current.x
      const dy = ev.clientY - startRef.current.y
      if (Math.hypot(dx, dy) > 24) { firedRef.current = true; setActive(false); cleanup(); onCreate() }
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    const up = () => { setActive(false); cleanup() }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className={`attn-pull-handle attn-pull-handle-${dir}${active ? ' attn-pull-handle-active' : ''}`}
      onPointerDown={onPointerDown}
      title={dir === 'bottom' ? '向下拖出创建子文本框' : '向右拖出创建子文本框'}
    />
  )
}

export function AttentionModeOverlay({
  editor,
  focusedId,
}: {
  editor: Editor
  focusedId: string | null
}) {
  const [contentScale, setContentScale] = useState(1)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200)
  }, [])

  // 订阅 store：focused shape 变化（如 Ctrl+\ 拆分写回 props）时强制重渲染
  const [storeTick, setStoreTick] = useState(0)
  useEffect(() => {
    if (!editor || !focusedId) return
    return editor.store.listen(() => setStoreTick((t) => t + 1), {
      scope: 'document',
      source: 'user',
    })
  }, [editor, focusedId])

  // ── 虚空卡钉屏：相机 pan/zoom 后把焦点真实框钉回视口中心 ──
  // 相机自由（白板可移动缩放），但焦点框页面坐标实时补偿 → 永远藏在放大镜下。
  // 注意 camera 记录 scope 是 'session'，必须监听 session 层才能捕获 pan/zoom。
  useEffect(() => {
    if (!editor || !focusedId) return
    let lastCam = ''
    const onStoreChange = () => {
      const cam = editor.getCamera()
      const key = `${cam.x.toFixed(2)}|${cam.y.toFixed(2)}|${cam.z.toFixed(4)}`
      if (key !== lastCam) {
        lastCam = key
        pinFocusToViewportCenter(editor, focusedId)
      }
    }
    onStoreChange()
    return editor.store.listen(onStoreChange, { scope: 'session', source: 'all' })
  }, [editor, focusedId])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const focused = focusedId ? editor.getShape<TextBlockShape>(focusedId as TLShapeId) : null

  // ── 编辑让位：正在编辑某张画布卡片（非中央焦点）时，隐藏放大镜 ──
  // editing 状态变化会触发 store document 事件 → storeTick 重渲染，此处渲染期读取即可。
  const editingShapeId = editor.getEditingShapeId()
  const hideLensWhileEditing = !!editingShapeId && editingShapeId !== focusedId

  useEffect(() => setContentScale(1), [focusedId])

  const isDarkMode = editor.user.getIsDarkMode()

  // 拉出创建子框：真实框 + 真实箭头（画布上，落在放大镜右侧可拖拽）
  const createChildFromPull = useCallback((text: string) => {
    const parent = focusedId ? editor.getShape<TextBlockShape>(focusedId as TLShapeId) : null
    if (!parent) return null
    const trimmed = text.trim()
    const userItem: MixedItem = { kind: 'user', id: createShapeId(), text: trimmed }
    const childId = createShapeId()
    const arrowId = createShapeId()
    const drop = attentionChildDropPage(editor)
    const childX = drop.x - DEFAULT_W / 2
    const childY = drop.y - DEFAULT_H / 2

    editor.batch(() => {
      editor.createShape({
        id: childId,
        type: 'text-block',
        x: childX,
        y: childY,
        props: {
          title: TITLE_PLACEHOLDER,
          items: trimmed ? [userItem] : [],
          content: trimmed,
          richText: toRichText(trimmed),
          userTextFragments: trimmed ? [trimmed] : [],
          aiResponses: [],
          conversationId: parent.props.conversationId,
        },
      })
      editor.createShape({ id: arrowId, type: 'arrow', x: 0, y: 0 })
      editor.createBindings([
        { type: 'arrow', fromId: arrowId, toId: parent.id, props: { terminal: 'start', isPrecise: false, normalizedAnchor: { x: 0.5, y: 1 } } },
        { type: 'arrow', fromId: arrowId, toId: childId, props: { terminal: 'end', isPrecise: false, normalizedAnchor: { x: 0.5, y: 0 } } },
      ])
    })
    showToast(trimmed ? `已拉出「${trimmed.slice(0, 12)}${trimmed.length > 12 ? '…' : ''}」` : '已创建子文本框')
    return childId
  }, [editor, focusedId, showToast])

  if (!focused) return null

  const onLensWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.stopPropagation()
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    setContentScale((s) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, s * factor)))
  }

  return (
    <div className={`attention-overlay${isDarkMode ? ' attention-overlay-dark' : ''}`}>
      {toast && <div className="attn-toast">{toast}</div>}

      {/* 回正按钮：四周卡被拖散/相机平移后，一键恢复整齐环绕布局 */}
      {!hideLensWhileEditing && (
        <button
          className="attn-recenter-btn"
          title="把四周卡片重新排回围绕中央的环绕布局"
          onClick={(e) => {
            e.stopPropagation()
            if (focusedId) recenterAttentionView(editor, focusedId)
          }}
        >
          ↺ 回正
        </button>
      )}

      {/* 编辑让位提示：某张画布卡正在被展开编辑时，放大镜隐藏，中央让给编辑框 */}
      {hideLensWhileEditing && (
        <div className="attn-edit-hint">
          正在编辑卡片 — 点空白处或按 Esc 完成
        </div>
      )}

      {/* 中央放大镜浮窗（DOM，不随画布相机缩放；四周是真实白板框） */}
      {!hideLensWhileEditing && (
        <div className="attn-lens-layer">
          <div
            className="attn-lens"
            style={{ width: ATTN_WIDTH, maxWidth: '100%' }}
            onWheel={onLensWheel}
          >
            <AttnTitle shape={focused} editor={editor} isDarkMode={isDarkMode} />
            <div className="attn-lens-body" style={{ background: isDarkMode ? '#1e1e2e' : '#ffffff' }}>
              <div className="attn-lens-scroll">
                <div className="attn-lens-scale" style={{ transform: `scale(${contentScale})` }}>
                  <div className="attn-lens-content">
                    <TextBlockContent
                      key={focused.id}
                      shape={focused}
                      editor={editor}
                      isSelected={false}
                      isDarkMode={isDarkMode}
                      isEditing={true}
                      copyOnPullOut
                      {...focused.props}
                      onPullOut={(text) => createChildFromPull(text)}
                    />
                  </div>
                </div>
              </div>
            </div>
            <AttnPullHandle dir="bottom" onCreate={() => createChildFromPull('')} />
            <AttnPullHandle dir="right" onCreate={() => createChildFromPull('')} />
          </div>
        </div>
      )}
    </div>
  )
}
