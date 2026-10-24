import { T } from '@tldraw/validate'
import {
  ShapeUtil,
  TLBaseShape,
  TLResizeInfo,
  resizeBox,
  Rectangle2d,
  HTMLContainer,
  SvgExportContext,
  useValue,
  toDomPrecision,
  RecordProps,
  richTextValidator,
  toRichText,
  TLRichText,
  createShapeId,
  TLShapeId,
} from 'tldraw'
import TextBlockContent from '../components/TextBlockContent'
import { isDshSessionId, nextSeqAfter } from '../session/bridge'
import { useSessionTitle } from '../session/SessionInfo'
import { useState, useCallback, useRef, useEffect } from 'react'

// AI 回复版本：原版始终保留，修改生成新版本
export interface AiResponseVersion {
  id: string
  label: string       // "原版"、"修改" 或自定义名称
  content: string     // 版本内容（HTML）
}

// AI 回复条目
export interface AiResponseEntry {
  id: string
  model: string       // 模型名称，如 "deepseek-chat"
  prompt: string      // 用户的提问
  versions: AiResponseVersion[]
  activeVersionIdx: number  // 当前显示哪个版本
}

// 混合条目：文本框内有序内容列表（自文本 / AI 回复可任意交错）
export type MixedItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'ai'; id: string; ai: AiResponseEntry }

/** `items` 可以派生出的全部「兼容字段」 */
export interface DerivedTextBlockProps {
  richText: TLRichText
  content: string
  userTextFragments: string[]
  aiResponses: AiResponseEntry[]
}

/**
 * 从有序条目派生出兼容字段 —— **所有写 text-block 的地方都必须走这里**。
 *
 * `items` 是唯一权威数据源，`content` / `richText` / `userTextFragments` / `aiResponses`
 * 只是给旧代码（AI 上下文拼装、线性视图、迁移路径）留的派生物。
 * 之前每个写入点各写一遍派生逻辑，改一处漏一处就会出现「items 里有、content 里没有」
 * 的静默不一致；收敛到这里之后，不变量只有一个维护点。
 */
export function deriveTextBlockProps(items: MixedItem[]): DerivedTextBlockProps {
  const userTexts = items
    .filter((i): i is Extract<MixedItem, { kind: 'user' }> => i.kind === 'user')
    .map(i => i.text)
  const aiList = items
    .filter((i): i is Extract<MixedItem, { kind: 'ai' }> => i.kind === 'ai')
    .map(i => i.ai)
  const joined = userTexts.join('\n\n')
  return {
    richText: toRichText(joined),
    content: joined,
    userTextFragments: userTexts,
    aiResponses: aiList,
  }
}

export type TextBlockShape = TLBaseShape<
  'text-block',
  {
    richText: TLRichText        // ProseMirror JSON — for TipTap editor
    content: string             // 第一段用户文本（与 userTextFragments[0] 同步，向后兼容）
    htmlContent?: string        // TipTap HTML output — for WYSIWYG preview
    conversationId?: string     // AI conversation session this block belongs to（或以 session- 开头的 DSH 会话）
    /** 绑定 DSH 会话时：本卡显示的起始消息 seq（含）。缺省表示从会话开头 */
    sessionFromSeq?: number
    /** 绑定 DSH 会话时：本卡显示的结束消息 seq（含）。缺省表示一直显示到最新（即"尾巴卡"） */
    sessionToSeq?: number
    userTextFragments: string[] // 所有用户文本片段（同类型同地位）
    aiResponses: AiResponseEntry[]  // AI 回复列表
    items?: MixedItem[]         // 有序混合条目（自文本与 AI 回复任意交错）— 新格式
    title?: string              // 框头标题 — 注意力模式缩略图显示用
    w: number
    h: number
    /** 注意力模式"名片态"标记（非持久 UI 状态）：dir = 相对焦点的方向，depth 区分子/孙 */
    attn?: { dir: string; depth?: number; ow?: number; oh?: number }
  }
>

const aiResponseVersionValidator = T.object({
  id: T.string,
  label: T.string,
  content: T.string,
})

const aiResponseEntryValidator = T.object({
  id: T.string,
  model: T.string,
  prompt: T.string,
  versions: T.arrayOf(aiResponseVersionValidator),
  activeVersionIdx: T.number,
})

const mixedItemValidator = T.union('kind', {
  user: T.object({
    kind: T.literal('user'),
    id: T.string,
    text: T.string,
  }),
  ai: T.object({
    kind: T.literal('ai'),
    id: T.string,
    ai: aiResponseEntryValidator,
  }),
})

export const textBlockProps: RecordProps<TextBlockShape> = {
  richText: richTextValidator,
  content: T.string,
  htmlContent: T.string.optional(),
  conversationId: T.string.optional(),
  sessionFromSeq: T.number.optional(),
  sessionToSeq: T.number.optional(),
  userTextFragments: T.arrayOf(T.string),
  aiResponses: T.arrayOf(aiResponseEntryValidator),
  items: T.arrayOf(mixedItemValidator).optional(),
  title: T.string.optional(),
  w: T.positiveNumber,
  h: T.positiveNumber,
  attn: T.object({ dir: T.string, depth: T.number.optional() }).optional(),
}

// 框头默认标题（未命名时的占位显示）
export const TITLE_PLACEHOLDER = '标题待定'

const DEFAULT_CONTENT = ''
const DEFAULT_AI_RESPONSES: AiResponseEntry[] = []

// 默认尺寸 — 宽 680（用户指定），高为旧默认(120)的 1.7 倍
export const DEFAULT_W = 680
export const DEFAULT_H = 204 // 120 × 1.7

const PULL_THRESHOLD = 20 // px — minimum drag distance to trigger creation

// ── 名片展开编辑的缩略几何缓存 ─────────────────────────────
// 注意力模式下名片被"展开"编辑时记录其缩略几何，退出编辑后恢复。
// key = shape id；value = 缩略几何（页面坐标，左上角）
const attnExpandMap = new Map<string, { x: number; y: number; w: number; h: number }>()

// ─── Anchor helpers ──────────────────────────────────────────────────

type PullOrigin = 'bottom' | 'right' | 'left'

function getPullAnchors(origin: PullOrigin) {
  switch (origin) {
    case 'bottom':
      return {
        start: { x: 0.5, y: 1 },   // bottom-center of parent
        end: { x: 0.5, y: 0 },     // top-center of child
      }
    case 'right':
      return {
        start: { x: 1, y: 0.5 },   // right-center of parent
        end: { x: 0, y: 0.5 },     // left-center of child
      }
    case 'left':
      return {
        start: { x: 0, y: 0.5 },   // left-center of parent
        end: { x: 1, y: 0.5 },     // right-center of child
      }
  }
}

// ─── Shape util ──────────────────────────────────────────────────────

export class TextBlockShapeUtil extends ShapeUtil<TextBlockShape> {
  static override type = 'text-block' as const
  static override props = textBlockProps

  // 选中时不显示 tldraw 默认的蓝色选中框和 resize 手柄（保持视觉干净）
  override hideSelectionBoundsBg() { return true }
  override hideSelectionBoundsFg() { return true }

  getDefaultProps(): TextBlockShape['props'] {
    return {
      richText: toRichText(DEFAULT_CONTENT),
      content: DEFAULT_CONTENT,
      userTextFragments: [],
      aiResponses: [...DEFAULT_AI_RESPONSES],
      items: [],
      title: TITLE_PLACEHOLDER,
      w: DEFAULT_W,
      h: DEFAULT_H,
    }
  }

  // 名片态（attn 标记）也允许进入编辑：双击名片 → 进入 tldraw 编辑态后
  // 由 onEditStart 把名片"展开"为可编辑尺寸（中央放大镜由 overlay 让位），
  // 退出编辑时 onEditEnd 自动缩回名片几何。
  override canEdit() {
    return true
  }

  // ── 名片展开编辑（onEditStart/onEditEnd + 双击入口） ───────
  // 进入编辑瞬间：记录当前缩略几何 → 展开成可编辑尺寸并移到视口中央。
  private expandAttnForEdit(shape: TextBlockShape) {
    const editor = this.editor
    const id = shape.id as TLShapeId
    if (attnExpandMap.has(id)) return // 已在展开态，防抖
    // 1) 记录缩略几何（页面坐标）
    attnExpandMap.set(id, { x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h })
    // 2) 展开几何：屏幕目标 ~ 视口中央一块编辑区（宽度≈放大镜，高度留边）
    const vp = editor.getViewportScreenBounds()
    const zoom = Math.max(0.1, editor.getZoomLevel())
    const sw = Math.min(620, vp.w - 140)
    const sh = Math.min(560, vp.h - 110)
    const pw = sw / zoom
    const ph = sh / zoom
    const center = editor.screenToPage({ x: vp.w / 2, y: vp.h / 2 })
    editor.updateShape({
      id,
      type: 'text-block',
      x: center.x - pw / 2,
      y: center.y - ph / 2,
      props: { w: pw, h: ph },
    })
  }

  // 双击缩略名片 → 展开几何并进入编辑态。
  // （tldraw 双击 HTMLContainer shape 时此钩子必被调用；对无 text label 的形状
  //  不会自动 startEditingShape，故显式 setEditingShape。）
  override onDoubleClick(shape: TextBlockShape) {
    if (!shape.props.attn) return
    this.expandAttnForEdit(shape)
    this.editor.setEditingShape(shape.id)
    this.editor.select(shape.id)
  }

  // 进入编辑（双击 / Enter 等任意入口都走 setEditingShape → onEditStart）：
  // 若该 shape 是"名片态"且尚未展开，则先记录缩略几何并展开成可编辑尺寸。
  // 编辑结束 → onEditEnd 恢复缩略几何。
  override onEditStart(shape: TextBlockShape) {
    if (shape.props.attn) this.expandAttnForEdit(shape)
  }

  // 退出编辑后恢复缩略几何（名片态仍在 → 渲染自动切回 renderAttnCard）。
  // 若 shape 已不在注意力模式（attn 已被 exit 清除），几何由 exitAttentionLayout
  // 还原，此处只清缓存。
  override onEditEnd(shape: TextBlockShape) {
    const saved = attnExpandMap.get(shape.id)
    if (!saved) return
    attnExpandMap.delete(shape.id)
    if (!shape.props.attn) return // 已退出注意力布局，勿用旧缩略几何覆盖
    this.editor.updateShape({
      id: shape.id as TLShapeId,
      type: 'text-block',
      x: saved.x,
      y: saved.y,
      props: { w: saved.w, h: saved.h },
    })
  }

  // ── Geometry ──

  getGeometry(shape: TextBlockShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    })
  }

  // ── Resize ──

  override canResize = () => true

  override onResize(shape: TextBlockShape, info: TLResizeInfo<TextBlockShape>) {
    return resizeBox(shape, info)
  }

  // ── "名片态"渲染（注意力模式下四周关联框） ────────────────
  // 纯渲染方法（无 hooks，由 component 在钩子之后调用）。
  // 卡片几何已被 resize 成"页面单位≈屏幕单位"，所以用固定页面字号即可，
  // 画布缩放时文字随卡片等比缩放（与普通文本框一致）。
  private renderAttnCard(shape: TextBlockShape, isDarkMode: boolean, isSelected: boolean) {
    const dir = shape.props.attn?.dir ?? 'out'
    const depth = shape.props.attn?.depth ?? 1
    const { w, h } = shape.props

    const TITLE_PX = 15
    const BODY_PX = 11
    const BADGE_PX = 10
    const PAD_PX = 12

    const title = shape.props.title?.trim() || TITLE_PLACEHOLDER
    // 摘要：取纯文本（去掉 markdown 记号）前 ~140 字，抹平换行
    const text = (
      shape.props.items
        ?.map((it) => (it.kind === 'user' ? it.text : it.ai?.versions[it.ai.activeVersionIdx]?.content ?? ''))
        .join(' ') ||
      shape.props.content ||
      ''
    )
      .replace(/[#>*`_\-\[\]()!]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140)
    const dirLabel = dir === 'in' ? '上游' : dir === 'conv' ? '同对话' : depth === 2 ? '孙' : '子'
    const arrowGlyph = dir === 'in' ? '↑' : dir === 'conv' ? '·' : '↓'

    const bg = isDarkMode ? '#26263a' : '#ffffff'
    // 选中态：高亮边框 + 外发光，让"点中了谁"有一眼实感
    const border = isSelected
      ? '#7c4dff'
      : isDarkMode ? '#3a3a5c' : '#d0d5dd'
    const ring = isSelected
      ? isDarkMode
        ? '0 0 0 2px rgba(167,139,250,0.55), 0 6px 22px rgba(167,139,250,0.28)'
        : '0 0 0 2px rgba(124,77,255,0.45), 0 6px 22px rgba(124,77,255,0.22)'
      : '0 2px 8px rgba(0,0,0,0.08)'
    const fg = isDarkMode ? '#e8e6f5' : '#2c2c34'
    const sub = isDarkMode ? '#a5a7c0' : '#6b7280'
    const accent = isDarkMode ? '#c4b5fd' : '#7c4dff'

    return (
      <HTMLContainer id={shape.id}>
        <div
          onDoubleClick={(e) => {
            // 名片可编辑：双击 → 展开编辑（放大镜在 overlay 让位）
            e.preventDefault()
            e.stopPropagation()
            this.expandAttnForEdit(shape)
            this.editor.select(shape.id)
            this.editor.setEditingShape(shape.id)
          }}
          style={{
            width: w,
            height: h,
            background: bg,
            border: `1px solid ${border}`,
            borderRadius: 10,
            boxSizing: 'border-box',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            padding: `${PAD_PX}px ${PAD_PX}px`,
            gap: 3,
            cursor: 'pointer',
            userSelect: 'none',
            // 名片需要可命中才能收到双击；拖动仍由 tldraw 画布层接管
            pointerEvents: 'auto',
            boxShadow: ring,
            transition: 'box-shadow 0.12s, border-color 0.12s',
          }}
        >
          <div style={{ fontSize: BADGE_PX, fontWeight: 600, color: accent, flexShrink: 0 }}>
            {arrowGlyph} {dirLabel}
          </div>
          <div
            style={{
              fontSize: TITLE_PX,
              fontWeight: 700,
              color: fg,
              lineHeight: 1.25,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: BODY_PX,
              color: sub,
              lineHeight: 1.4,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              flex: 1,
              minHeight: 0,
            }}
          >
            {text || '（无内容）'}
          </div>
        </div>
      </HTMLContainer>
    )
  }

  // ── component() — 画布上的实际渲染 ─────────────────────────
  //   结构: HTMLContainer > div.tb-wrapper > 卡牌 div > TextBlockContent + 手柄们

  component(shape: TextBlockShape) {
    const { w, h } = shape.props
    // 选中态要响应式订阅（支持框选多选：只要在选中集合内即高亮），否则选择变化后 UI 不刷新
    const isSelected = useValue(
      'isSelected',
      () => this.editor.getSelectedShapeIds().includes(shape.id),
      [this.editor, shape.id],
    )
    const isDarkMode = useValue('dark mode', () => this.editor.user.getIsDarkMode(), [this.editor])
    const isEditing = useValue(
      'isEditing',
      () => this.editor.getEditingShapeId() === shape.id,
      [this.editor],
    )
    const zoom = useValue('zoom', () => this.editor.getZoomLevel(), [this.editor])

    const bgColor = isDarkMode ? '#1e1e2e' : '#ffffff'
    const borderColor = isDarkMode
      ? isEditing ? '#c4a7ff' : isSelected ? '#6c8cff' : '#3a3a5c'
      : isEditing ? '#7c4dff' : isSelected ? '#4f7cff' : '#d0d5dd'

    // ── Pull-out drag state ──────────────────────────────────────

    // 拉出拖拽状态 — 从手柄拖出到 canvas 时创建子文本框
    const [pullDrag, setPullDrag] = useState<{
      active: boolean
      origin: PullOrigin
      startX: number  // screen coords
      startY: number
      curX: number
      curY: number
    } | null>(null)

    // ── 框头标题编辑状态 ──────────────────────────────────────
    const [editingTitle, setEditingTitle] = useState(false)
    const title = shape.props.title?.trim() ? shape.props.title!.trim() : TITLE_PLACEHOLDER
    // 绑定 DSH 会话的对话卡：标题还是占位符时显示会话标题（用户自己写过标题则优先用它）。
    const dshTitleSessionId = isDshSessionId(shape.props.conversationId) ? shape.props.conversationId : undefined
    const sessionTitle = useSessionTitle(dshTitleSessionId)
    const displayTitle = title === TITLE_PLACEHOLDER && sessionTitle !== undefined ? sessionTitle : title
    const isTitlePlaceholder = displayTitle === TITLE_PLACEHOLDER

    // 提交标题：空串回退占位符，非空写回 shape
    const commitTitle = useCallback((raw: string) => {
      const trimmed = raw.trim()
      const next = trimmed || TITLE_PLACEHOLDER
      const cur = shapeRef.current
      editorRef.current.updateShape<TextBlockShape>({
        id: cur.id,
        type: 'text-block',
        props: { title: next },
      })
      setEditingTitle(false)
    }, [])

    const shapeRef = useRef(shape)
    shapeRef.current = shape
    const editorRef = useRef(this.editor)
    editorRef.current = this.editor

    // Pull-out drag effect — manage global listeners while dragging
    useEffect(() => {
      if (!pullDrag?.active) return

      const editor = editorRef.current
      const container = editor.getContainer()

      const onPointerMove = (e: PointerEvent) => {
        setPullDrag(prev => prev ? { ...prev, curX: e.clientX, curY: e.clientY } : null)
      }

      const onPointerUp = (e: PointerEvent) => {
        setPullDrag(prev => {
          if (!prev) return null

          const dx = e.clientX - prev.startX
          const dy = e.clientY - prev.startY
          const dist = Math.sqrt(dx * dx + dy * dy)

          if (dist >= PULL_THRESHOLD) {
            const pagePoint = editor.screenToPage({ x: e.clientX, y: e.clientY })
            const cur = shapeRef.current

            const childId = createShapeId()
            const arrowId = createShapeId()
            const anchors = getPullAnchors(prev.origin)

            editor.batch(() => {
              editor.createShape({
                id: childId,
                type: 'text-block',
                x: pagePoint.x - DEFAULT_W / 2,
                y: pagePoint.y - DEFAULT_H / 2,
                props: {
                  conversationId: cur.props.conversationId,
                  ...(cur.props.conversationId !== undefined && nextSeqAfter(cur.props.sessionToSeq) !== undefined
                    ? { sessionFromSeq: nextSeqAfter(cur.props.sessionToSeq) }
                    : {}),
                },
              })

              editor.createShape({ id: arrowId, type: 'arrow', x: 0, y: 0 })

              editor.createBindings([
                {
                  type: 'arrow',
                  fromId: arrowId,
                  toId: cur.id,
                  props: {
                    terminal: 'start',
                    isPrecise: false,
                    normalizedAnchor: anchors.start,
                  },
                },
                {
                  type: 'arrow',
                  fromId: arrowId,
                  toId: childId,
                  props: {
                    terminal: 'end',
                    isPrecise: false,
                    normalizedAnchor: anchors.end,
                  },
                },
              ])

              editor.select(childId)
              editor.setEditingShape(childId)
            })
          }

          return null
        })

        container.removeEventListener('pointermove', onPointerMove)
        container.removeEventListener('pointerup', onPointerUp)
        document.body.style.cursor = ''
      }

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setPullDrag(null)
          container.removeEventListener('pointermove', onPointerMove)
          container.removeEventListener('pointerup', onPointerUp)
          document.body.style.cursor = ''
        }
      }

      container.addEventListener('pointermove', onPointerMove)
      container.addEventListener('pointerup', onPointerUp)
      window.addEventListener('keydown', onKeyDown)
      document.body.style.cursor = 'grabbing'

      return () => {
        container.removeEventListener('pointermove', onPointerMove)
        container.removeEventListener('pointerup', onPointerUp)
        window.removeEventListener('keydown', onKeyDown)
        document.body.style.cursor = ''
      }
    }, [pullDrag?.active])

    // ── Pull-out handle start ────────────────────────────────────

    // 拉出手柄的 pointerdown 回调
    const startPullOut = useCallback((origin: PullOrigin) => (e: React.PointerEvent) => {
      e.stopPropagation()
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      setPullDrag({
        active: true,
        origin,
        startX: e.clientX,
        startY: e.clientY,
        curX: e.clientX,
        curY: e.clientY,
      })
    }, [])

    // ── 选中文字拉出回调 ──────────────────────────────────────

    // "选中文字拉出" — TextBlockContent 的回调，在外部创建新文本框
    const handlePullOut = useCallback((selectedText: string, pageX: number, pageY: number) => {
      const editor = editorRef.current
      const cur = shapeRef.current
      const childId = createShapeId()
      const arrowId = createShapeId()

      editor.batch(() => {
        editor.createShape({
          id: childId,
          type: 'text-block',
          x: pageX - DEFAULT_W / 2,
          y: pageY - DEFAULT_H / 2,
          props: {
            content: selectedText,
            richText: toRichText(selectedText),
            htmlContent: `<p>${selectedText}</p>`,
            conversationId: cur.props.conversationId,
          },
        })
        editor.createShape({ id: arrowId, type: 'arrow', x: 0, y: 0 })
        editor.createBindings([
          {
            type: 'arrow',
            fromId: arrowId,
            toId: cur.id,
            props: {
              terminal: 'start',
              isPrecise: false,
              normalizedAnchor: { x: 0.5, y: 0.5 },
            },
          },
          {
            type: 'arrow',
            fromId: arrowId,
            toId: childId,
            props: {
              terminal: 'end',
              isPrecise: false,
              normalizedAnchor: { x: 0.5, y: 0.5 },
            },
          },
        ])
        editor.select(childId)
        editor.setEditingShape(childId)
      })
    }, [])

    // ── Click handler for "+" button ─────────────────────────────

    // "+" 按钮 — 在下方创建子节点并继承对话ID
    const handleAddChild = (e: React.MouseEvent) => {
      e.stopPropagation()
      const editor = this.editor
      const childId = createShapeId()
      const arrowId = createShapeId()
      const gap = 40

      const childX = shape.x + (w - DEFAULT_W) / 2
      const childY = shape.y + h + gap

      editor.batch(() => {
        editor.createShape({
          id: childId,
          type: 'text-block',
          x: childX,
          y: childY,
          props: {
            conversationId: shape.props.conversationId,
            ...(shape.props.conversationId !== undefined && nextSeqAfter(shape.props.sessionToSeq) !== undefined
              ? { sessionFromSeq: nextSeqAfter(shape.props.sessionToSeq) }
              : {}),
          },
        })
        editor.createShape({ id: arrowId, type: 'arrow', x: 0, y: 0 })
        editor.createBindings([
          {
            type: 'arrow',
            fromId: arrowId,
            toId: shape.id,
            props: {
              terminal: 'start',
              isPrecise: false,
              normalizedAnchor: { x: 0.5, y: 1 },
            },
          },
          {
            type: 'arrow',
            fromId: arrowId,
            toId: childId,
            props: {
              terminal: 'end',
              isPrecise: false,
              normalizedAnchor: { x: 0.5, y: 0 },
            },
          },
        ])
        editor.select(childId)
        editor.setEditingShape(childId)
      })
    }

    // ── Pull-out preview line ────────────────────────────────────

    const showHandles = isSelected && !pullDrag?.active

    // Calculate preview line in page coordinates
    let previewLine: { x1: number; y1: number; x2: number; y2: number } | null = null
    if (pullDrag?.active) {
      const editor = editorRef.current
      const pageOrigin = editor.screenToPage({ x: pullDrag.startX, y: pullDrag.startY })
      const pageCursor = editor.screenToPage({ x: pullDrag.curX, y: pullDrag.curY })

      // Anchor on shape edge based on origin
      switch (pullDrag.origin) {
        case 'bottom':
          previewLine = {
            x1: shape.x + w / 2,
            y1: shape.y + h,
            x2: pageCursor.x,
            y2: pageCursor.y,
          }
          break
        case 'right':
          previewLine = {
            x1: shape.x + w,
            y1: shape.y + h / 2,
            x2: pageCursor.x,
            y2: pageCursor.y,
          }
          break
        case 'left':
          previewLine = {
            x1: shape.x,
            y1: shape.y + h / 2,
            x2: pageCursor.x,
            y2: pageCursor.y,
          }
          break
      }
    }

    // 名片态：注意力模式下四周关联框 → 摘要名片（完整 hooks 执行完后分支，保证顺序稳定）
    if (shape.props.attn && !isEditing) {
      return this.renderAttnCard(shape, isDarkMode, isSelected)
    }

    return (
      <HTMLContainer id={shape.id}>
        <div className="tb-wrapper" style={{ position: 'relative', width: w, height: h }}>
          <div
            style={{
              background: bgColor,
              border: `1px solid ${borderColor}`,
              borderRadius: 10,
              boxShadow: isEditing
                ? '0 0 0 2px rgba(124, 77, 255, 0.4)'
                : isSelected
                  ? '0 0 0 1px rgba(79, 124, 255, 0.4)'
                  : '0 1px 3px rgba(0,0,0,0.08)',
              overflow: 'hidden',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* 框头 — 标题栏：双击编辑，回车/失焦保存，Esc 取消 */}
            <div
              className={`tb-header${isTitlePlaceholder ? ' tb-header-placeholder' : ''}`}
              onDoubleClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                setEditingTitle(true)
              }}
              onPointerDown={(e) => {
                // 阻断 tldraw 的 pointer 事件 — 标题栏不参与拖拽/双击进入编辑
                e.stopPropagation()
                e.preventDefault()
              }}
            >
              {editingTitle ? (
                <input
                  className="tb-header-input"
                  autoFocus
                  defaultValue={title}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      e.stopPropagation()
                      commitTitle((e.target as HTMLInputElement).value)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      setEditingTitle(false)
                    }
                  }}
                  onBlur={(e) => commitTitle(e.target.value)}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="tb-header-label">{displayTitle}</span>
              )}
            </div>

            {/* 内容区 — 框头下方滚动（左右留白 16px、底部 8px，内容不贴边框） */}
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '0 16px 8px' }}>
              <TextBlockContent
                shape={shape}
                editor={this.editor}
                isSelected={isSelected}
                isDarkMode={isDarkMode}
                isEditing={isEditing}
                {...shape.props}
                onPullOut={handlePullOut}
              />
            </div>
          </div>

          {showHandles && (
            <>
              <div
                className="pull-handle pull-handle-bottom"
                onPointerDown={startPullOut('bottom')}
              />
              <div
                className="pull-handle pull-handle-right"
                onPointerDown={startPullOut('right')}
              />
              <div
                className="pull-handle pull-handle-left"
                onPointerDown={startPullOut('left')}
              />
            </>
          )}

          {previewLine && (
            <svg
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                overflow: 'visible',
              }}
            >
              <line
                x1={previewLine.x1 - shape.x}
                y1={previewLine.y1 - shape.y}
                x2={previewLine.x2 - shape.x}
                y2={previewLine.y2 - shape.y}
                stroke={isDarkMode ? '#c4a7ff' : '#7c4dff'}
                strokeWidth={2}
                strokeDasharray="6 4"
              />
              <rect
                x={previewLine.x2 - shape.x - DEFAULT_W / 2}
                y={previewLine.y2 - shape.y - DEFAULT_H / 2}
                width={DEFAULT_W}
                height={DEFAULT_H}
                rx={10}
                fill={isDarkMode ? 'rgba(196, 167, 255, 0.1)' : 'rgba(124, 77, 255, 0.08)'}
                stroke={isDarkMode ? 'rgba(196, 167, 255, 0.4)' : 'rgba(124, 77, 255, 0.3)'}
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            </svg>
          )}

          <button
            className="tb-add-child-btn"
            onClick={handleAddChild}
            onPointerDown={(e) => {
              // 阻止 tldraw 收到 pointerdown — 避免与选中/拖动手势冲突
              e.stopPropagation()
              e.preventDefault()
            }}
            onPointerUp={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              bottom: 6,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 28,
              height: 28,
              borderRadius: '50%',
              border: 'none',
              background: isDarkMode ? '#3a3a5c' : '#e8ecf1',
              color: isDarkMode ? '#cdd6f4' : '#555',
              fontSize: 18,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: isSelected ? 1 : 0,
              transition: 'opacity 0.15s',
              // 高于拉出手柄(z-index:20)，避免点击时被 pull-handle-bottom 拦截
              zIndex: 30,
            }}
          >
            +
          </button>
        </div>
      </HTMLContainer>
    )
  }

  // ── indicator() — 选中框（虚线外框） ──
  // 返回 null：选中后不显示任何描边框（配合 hideSelectionBounds 完全干净）

  override indicator() {
    return null
  }

  // ── toSvg() — 导出为 SVG（备份/分享用） ──

  override toSvg(shape: TextBlockShape, ctx: SvgExportContext) {
    const text = (shape.props.richText.content as Array<{ text?: string }> | undefined)
      ?.map(n => n.text ?? '').join('') || ''

    return (
      <g>
        <rect
          width={shape.props.w}
          height={shape.props.h}
          rx={10}
          fill={ctx.isDarkMode ? '#1e1e2e' : '#ffffff'}
          stroke={ctx.isDarkMode ? '#3a3a5c' : '#d0d5dd'}
          strokeWidth={2}
        />
        <foreignObject width={shape.props.w - 24} height={shape.props.h - 24} x={12} y={12}>
          <div style={{
            fontSize: '14px',
            fontFamily: 'system-ui, sans-serif',
            color: ctx.isDarkMode ? '#cdd6f4' : '#333',
            lineHeight: 1.6,
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}>
            {text}
          </div>
        </foreignObject>
      </g>
    )
  }
}
