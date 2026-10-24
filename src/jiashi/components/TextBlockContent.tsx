import React, { useCallback, useRef, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Editor, TLRichText, toRichText, renderPlaintextFromRichText, TLShapeId, createShapeId } from 'tldraw'
import {
  TextBlockShape,
  AiResponseEntry,
  AiResponseVersion,
  MixedItem,
  deriveTextBlockProps,
} from '../shapes/TextBlockShapeUtil'
import AIInputBar from './AIInputBar'
import SessionThread from '../session/SessionThread'
import { SESSION_TAIL_SEQ, isDshSessionId, sessionLog } from '../session/bridge'
import MarkdownPreview from './MarkdownPreview'
import MarkdownBlockEditor, { type BlockEditorHandle } from './MarkdownBlockEditor'
import {
  getConversationLabel,
  createConversation,
  getConversation,
} from '../ai/conversation'

/** 段落分隔符：AI 回复内部用 Ctrl+\ 拆分时插入，渲染为独立段落 */
export const PARAGRAPH_SEP = '\n\n'

/** 将 AI 回复内容拆分为段落数组（按 \n\n 分割，保留非空段） */
export function splitParagraphs(content: string): string[] {
  return content
    .split(PARAGRAPH_SEP)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/** Extract plain text from tldraw `TLRichText` using tldraw's built-in API. */
export function extractPlainText(editor: Editor, richText: TLRichText): string {
  return renderPlaintextFromRichText(editor, richText)
}

/**
 * Collect all incoming arrow source IDs for a given shape.
 * Used to auto-inherit conversationId from upstream text blocks.
 */
function collectIncomingSourceIds(editor: Editor, shapeId: string): string[] {
  const arrows = editor.getCurrentPageShapes().filter(s => s.type === 'arrow')
  const sources: string[] = []
  for (const arrow of arrows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const end = (arrow.props as any).end
    if (end?.boundShapeId === shapeId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const start = (arrow.props as any).start
      if (start?.boundShapeId) sources.push(start.boundShapeId)
    }
  }
  return sources
}

/**
 * Get the conversationId for a text block shape by ID.
 * Falls back to reading from the tldraw store.
 */
function getShapeConversationId(editor: Editor, shapeId: string): string | undefined {
  const shape = editor.getShape(shapeId as TLShapeId)
  if (!shape || shape.type !== 'text-block') return undefined
  return (shape.props as TextBlockShape['props']).conversationId
}

/**
 * Collect content of all text blocks that share the same conversationId.
 */
function collectConversationContext(
  editor: Editor,
  conversationId: string,
): string[] {
  const shapes = editor.getCurrentPageShapes()
  const contents: string[] = []
  for (const s of shapes) {
    if (s.type !== 'text-block') continue
    const props = s.props as TextBlockShape['props']
    if (props.conversationId !== conversationId) continue
    const c = props.content ?? ''
    if (c.trim()) contents.push(c)
  }
  return contents
}

// SubBoxDragHandle — 6 点样式（⋮⋮），鼠标悬浮变色，按住拖出可复制/移动整个片段
function SubBoxDragHandle({
  onDragStart,
  accentColor,
  borderColor,
}: {
  onDragStart: (e: React.PointerEvent) => void
  accentColor: string
  borderColor: string
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="subbox-drag-handle"
      onPointerDown={onDragStart}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '16px',
        minWidth: '16px',
        cursor: 'grab',
        background: hovered ? accentColor + '22' : 'transparent',
        borderRadius: '0 4px 4px 0',
        transition: 'background 0.15s',
        userSelect: 'none',
        borderLeft: `1px solid ${borderColor}`,
      }}
      title={hovered ? (window.navigator.platform.includes('Mac') ? '拖出复制，⌘+拖出移动' : '拖出复制，Ctrl+拖出移动') : ''}
    >
      <svg width="10" height="20" viewBox="0 0 10 20" fill="none" stroke={accentColor} strokeWidth="1.2" opacity={hovered ? 0.8 : 0.4}>
        <circle cx="3" cy="4" r="1.5" fill={accentColor} stroke="none" />
        <circle cx="7" cy="4" r="1.5" fill={accentColor} stroke="none" />
        <circle cx="3" cy="10" r="1.5" fill={accentColor} stroke="none" />
        <circle cx="7" cy="10" r="1.5" fill={accentColor} stroke="none" />
        <circle cx="3" cy="16" r="1.5" fill={accentColor} stroke="none" />
        <circle cx="7" cy="16" r="1.5" fill={accentColor} stroke="none" />
      </svg>
    </div>
  )
}

// InsertSlot — 条目之间的插入槽（编辑模式）：一条细虚线，点击插入新的自文本
//   无文字/无圆点/无图标；整条线区域可点（高度很小），hover 变紫
function InsertSlot({ onInsert }: { onInsert: () => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onClick={onInsert}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="在此插入自文本"
      style={{
        height: 12,
        margin: '1px 0',
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
        userSelect: 'none',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          // 虚线不贯穿全宽，只占中间 90%（两侧各留 5% 呼吸），hover 变紫
          width: '90%',
          height: 1,
          margin: '0 auto',
          backgroundImage: `repeating-linear-gradient(90deg, ${hovered ? '#7c4dff' : '#c3cad6'} 0 3px, transparent 3px 6px)`,
          opacity: hovered ? 0.9 : 0.55,
          transition: 'opacity 0.15s',
        }}
      />
    </div>
  )
}

// ─── AI 回复卡片组件 ──────────────────────────────────────────────

// AiResponseCard — 单个 AI 回复卡片
//   内部结构: 头部(模型名 + 用户提问 + 版本标签 + 操作按钮) + 内容(Markdown)
//   支持: 切换版本 / 双击重命名版本 / 新建版本 / 编辑保存 / 复制内容
function AiResponseCard({
  entry,
  isDarkMode,
  katexColor,
  onVersionChange,
  onVersionRename,
  onAddVersion,
  onSaveEdit,
  onDragStart,
  onContextMenu,
}: {
  entry: AiResponseEntry
  isDarkMode: boolean
  katexColor: string
  onVersionChange: (entryId: string, idx: number) => void
  onVersionRename: (entryId: string, versionId: string, newLabel: string) => void
  onAddVersion: (entryId: string) => void
  onSaveEdit: (entryId: string, newContent: string) => void
  onDragStart: (e: React.PointerEvent) => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const activeVersion = entry.versions[entry.activeVersionIdx]
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [editingBody, setEditingBody] = useState(false)
  const [editContent, setEditContent] = useState('')
  const editRef = useRef<HTMLTextAreaElement>(null)

  const handleStartRename = (versionId: string, currentLabel: string) => {
    setRenamingId(versionId)
    setRenameValue(currentLabel)
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  const handleFinishRename = () => {
    if (renamingId && renameValue.trim()) {
      onVersionRename(entry.id, renamingId, renameValue.trim())
    }
    setRenamingId(null)
  }

  const handleStartEdit = () => {
    setEditContent(activeVersion?.content || '')
    setEditingBody(true)
    setTimeout(() => editRef.current?.focus(), 50)
  }

  const handleCancelEdit = () => {
    setEditingBody(false)
    setEditContent('')
  }

  const handleSaveEdit = () => {
    if (editContent.trim() && editContent !== activeVersion?.content) {
      onSaveEdit(entry.id, editContent)
    }
    setEditingBody(false)
    setEditContent('')
  }

  // 复制当前版本内容到剪贴板
  const handleCopy = () => {
    const content = activeVersion?.content || ''
    navigator.clipboard.writeText(content).catch(() => {
      // fallback: 使用 textarea 选中复制
      const ta = document.createElement('textarea')
      ta.value = content
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    })
  }

  // AI 回复内容 Markdown 渲染（含段落分隔）
  const renderBody = (content: string) => {
    const paragraphs = splitParagraphs(content)
    if (paragraphs.length === 0) {
      return <span style={{ opacity: 0.4, fontStyle: 'italic' }}>（空）</span>
    }
    return paragraphs.map((p, i) => (
      <div key={i}>
        {i > 0 && (
          <div
            style={{
              height: 1,
              background: borderColor,
              margin: '8px 0',
              opacity: 0.4,
            }}
          />
        )}
        <MarkdownPreview text={p} isDarkMode={isDarkMode} />
      </div>
    ))
  }

  const bgColor = isDarkMode ? '#1e1e3a' : '#f8f9ff'
  const borderColor = isDarkMode ? '#4a4a8a' : '#c8c8ff'
  const accentColor = isDarkMode ? '#9d7cff' : '#7c4dff'
  const textColor = isDarkMode ? '#cdd6f4' : '#333'

  return (
    <div style={{ display: 'flex', alignItems: 'stretch' }} onContextMenu={onContextMenu}>
      <div
        className="tb-ai-card"
        style={{
          flex: 1,
          background: bgColor,
          border: `1.5px solid ${borderColor}`,
          borderRadius: '10px',
          margin: '8px 0',
        overflow: 'hidden',
      }}
    >
      {/* ── 头部 ── */}
      <div
        className="tb-ai-card-header"
        style={{
          padding: '6px 12px',
          background: isDarkMode ? 'rgba(124,77,255,0.08)' : 'rgba(124,77,255,0.06)',
          borderBottom: `1px solid ${borderColor}`,
        }}
      >
        {/* 第一行：模型名 + 用户提问 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
          <span
            className="tb-ai-model-name"
            style={{
              fontWeight: 700,
              fontSize: '12px',
              color: accentColor,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {entry.model}:
          </span>
          {entry.prompt && (
            <span
              style={{
                fontSize: '12px',
                color: textColor,
                opacity: 0.75,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
              title={entry.prompt}
            >
              {entry.prompt}
            </span>
          )}
        </div>

        {/* 第二行：版本标签 + 操作按钮 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', flex: 1 }}>
            {entry.versions.map((v, idx) => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center' }}>
                {renamingId === v.id ? (
                  <input
                    ref={renameInputRef}
                    className="tb-version-rename-input"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={handleFinishRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleFinishRename()
                      if (e.key === 'Escape') setRenamingId(null)
                    }}
                    style={{
                      fontSize: '11px',
                      padding: '1px 4px',
                      width: '60px',
                      border: `1px solid ${accentColor}`,
                      borderRadius: '4px',
                      outline: 'none',
                      background: isDarkMode ? '#313244' : '#fff',
                      color: textColor,
                    }}
                    autoFocus
                  />
                ) : (
                  <button
                    className="tb-version-tab"
                    onClick={() => onVersionChange(entry.id, idx)}
                    onDoubleClick={() => handleStartRename(v.id, v.label)}
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '8px',
                      border: 'none',
                      cursor: 'pointer',
                      fontWeight: idx === entry.activeVersionIdx ? 700 : 400,
                      background: idx === entry.activeVersionIdx
                        ? accentColor
                        : 'transparent',
                      color: idx === entry.activeVersionIdx ? '#fff' : textColor,
                      transition: 'all 0.15s ease',
                      opacity: idx === entry.activeVersionIdx ? 1 : 0.7,
                    }}
                  >
                    {v.label}
                  </button>
                )}
              </div>
            ))}

            {/* + 新建版本按钮 */}
            <button
              className="tb-version-add-btn"
              onClick={() => onAddVersion(entry.id)}
              title="新建版本（复制当前内容）"
              style={{
                fontSize: '11px',
                padding: '2px 6px',
                borderRadius: '8px',
                border: `1px dashed ${borderColor}`,
                cursor: 'pointer',
                background: 'transparent',
                color: textColor,
                opacity: 0.6,
              }}
            >
              + 新建版本
            </button>
          </div>

          {/* 复制按钮 */}
          <button
            onClick={handleCopy}
            title="复制当前版本内容"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '26px',
              height: '26px',
              borderRadius: '6px',
              border: `1px solid ${borderColor}`,
              background: 'transparent',
              cursor: 'pointer',
              opacity: 0.6,
              transition: 'opacity 0.15s',
              flexShrink: 0,
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '0.6')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={textColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── 内容区：预览或编辑 ── */}
      {editingBody ? (
        <div style={{ padding: '8px 12px' }}>
          <textarea
            ref={editRef}
            value={editContent}
            onChange={e => setEditContent(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl+\：在光标处把当前回复拆成两个段落（\n\n 分隔，同一条回复内）
              const isSplit = (e.ctrlKey || e.metaKey) && (e.key === '\\' || e.key === '、')
              if (isSplit) {
                e.preventDefault()
                e.stopPropagation()
                const ta = e.currentTarget
                const start = ta.selectionStart
                const end = ta.selectionEnd
                const next = editContent.slice(0, start) + PARAGRAPH_SEP + editContent.slice(end)
                setEditContent(next)
                requestAnimationFrame(() => {
                  ta.selectionStart = ta.selectionEnd = start + PARAGRAPH_SEP.length
                  ta.focus()
                })
              }
            }}
            style={{
              width: '100%',
              minHeight: '100px',
              padding: '8px',
              fontSize: '14px',
              lineHeight: 1.7,
              fontFamily: 'monospace',
              border: `1px solid ${borderColor}`,
              borderRadius: '6px',
              background: isDarkMode ? '#12121e' : '#fff',
              color: textColor,
              resize: 'vertical',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
            <button
              onClick={handleSaveEdit}
              style={{
                padding: '4px 12px',
                fontSize: '12px',
                borderRadius: '6px',
                border: 'none',
                background: accentColor,
                color: '#fff',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              保存为新版本
            </button>
            <button
              onClick={handleCancelEdit}
              style={{
                padding: '4px 12px',
                fontSize: '12px',
                borderRadius: '6px',
                border: `1px solid ${borderColor}`,
                background: 'transparent',
                color: textColor,
                cursor: 'pointer',
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <div
          className="tb-ai-card-body"
          onClick={handleStartEdit}
          title="点击编辑（Ctrl+\ 拆分段落）"
          style={{
            padding: '10px 14px',
            fontSize: '14px',
            lineHeight: 1.7,
            color: textColor,
            cursor: 'text',
          }}
        >
          {renderBody(activeVersion?.content ?? '')}
        </div>
      )}
    </div>
    <SubBoxDragHandle
      onDragStart={onDragStart}
      accentColor={accentColor}
      borderColor={borderColor}
    />
  </div>
  )
}

interface TextBlockContentProps {
  shape: TextBlockShape
  editor: Editor
  isSelected: boolean
  isDarkMode: boolean
  isEditing: boolean
  content: string
  htmlContent?: string
  userTextFragments: string[]
  aiResponses: AiResponseEntry[]
  items?: MixedItem[]
  conversationId?: string
  /** 绑定 DSH 会话时：本卡显示范围的起点 seq（含） */
  sessionFromSeq?: number
  /** 绑定 DSH 会话时：本卡显示范围的终点 seq（含）；缺省 = 显示到最新 */
  sessionToSeq?: number
  /** "选中拉出" 回调：用户从编辑器选中文字后拖出文本框时触发 */
  onPullOut?: (text: string, pageX: number, pageY: number) => void
  /** true（注意力模式）：选中文字拖出恒=复制；画布默认：普通拖出=复制，Ctrl/⌘+拖出=剪切 */
  copyOnPullOut?: boolean
}


export default function TextBlockContent({
  shape,
  editor,
  isSelected,
  isDarkMode,
  isEditing,
  content,
  htmlContent: _htmlContent,
  userTextFragments,
  aiResponses,
  items: itemsProp,
  conversationId,
  sessionFromSeq,
  sessionToSeq,
  onPullOut,
  copyOnPullOut = false,
}: TextBlockContentProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // 卡片绑定的是 DSH 会话（sessionId 形如 session-…）时，用 DSH 会话线程替代原来的本地 AI 对话。
  const dshSessionId = isDshSessionId(conversationId) ? conversationId : null

  // 把一条 DSH 会话从 seq 处拆成两张卡：当前卡显示到 seq-1，新卡从 seq 开始（纯显示层，不改会话数据）。
  const handleSessionSplit = useCallback((seq: number) => {
    if (!editor || !dshSessionId) return
    const bounds = editor.getShapePageBounds(shape.id)
    if (!bounds) return
    const childId = createShapeId()
    const arrowId = createShapeId()
    editor.batch(() => {
      editor.updateShape({ id: shape.id, type: 'text-block', props: { sessionToSeq: seq - 1 } })
      editor.createShape({
        id: childId,
        type: 'text-block',
        x: bounds.x + bounds.w + 100,
        y: bounds.y,
        props: { conversationId: dshSessionId, sessionFromSeq: seq },
      })
      editor.createShape({ id: arrowId, type: 'arrow', x: 0, y: 0 })
      editor.createBindings([
        {
          type: 'arrow',
          fromId: arrowId,
          toId: shape.id,
          props: { terminal: 'start', isPrecise: false, normalizedAnchor: { x: 0.5, y: 0.5 } },
        },
        {
          type: 'arrow',
          fromId: arrowId,
          toId: childId,
          props: { terminal: 'end', isPrecise: false, normalizedAnchor: { x: 0.5, y: 0.5 } },
        },
      ])
      editor.select(childId)
    })
    sessionLog('session.split', { sessionId: dshSessionId, seq })
  }, [editor, shape, dshSessionId])

  // 把这张分段卡合并回上一张：上一张的结束位置接上本卡，然后删掉本卡和它连着的箭头。
  const handleSessionMerge = useCallback(() => {
    if (!editor || !dshSessionId || sessionFromSeq === undefined) return
    const shapes = editor.getCurrentPageShapes()
    const prev = shapes.find(
      (s) =>
        s.id !== shape.id &&
        s.type === 'text-block' &&
        (s.props as { conversationId?: string }).conversationId === dshSessionId &&
        (s.props as { sessionToSeq?: number }).sessionToSeq === sessionFromSeq - 1,
    )
    if (!prev) {
      sessionLog('session.merge-skipped', { sessionId: dshSessionId, from: sessionFromSeq })
      return
    }
    const arrows = shapes.filter(
      (s) =>
        s.type === 'arrow' &&
        (((s.props as { start?: { boundShapeId?: string } }).start?.boundShapeId === shape.id) ||
          ((s.props as { end?: { boundShapeId?: string } }).end?.boundShapeId === shape.id)),
    )
    editor.batch(() => {
      editor.updateShape({ id: prev.id, type: 'text-block', props: { sessionToSeq: sessionToSeq ?? SESSION_TAIL_SEQ } })
      editor.deleteShapes([shape.id, ...arrows.map((arrow) => arrow.id)])
    })
    sessionLog('session.merge', { sessionId: dshSessionId, from: sessionFromSeq, into: prev.id })
  }, [editor, shape, dshSessionId, sessionFromSeq, sessionToSeq])

  // ── Pull-out drag state (选中文字拖出) ──
  const [isDraggingText, setIsDraggingText] = useState(false)
  const isDraggingTextRef = useRef(false)
  useEffect(() => { isDraggingTextRef.current = isDraggingText }, [isDraggingText])
  const [dragPreviewPos, setDragPreviewPos] = useState({ x: 0, y: 0 })
  // ── 右键菜单 ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; handler: () => void; label: string } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // 点击菜单外部 → 关闭（冒泡阶段 mousedown，用 menuRef 判断是否点在菜单内）
  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setCtxMenu(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [ctxMenu])

  const dragStateRef = useRef<{
    active: boolean
    startX: number
    startY: number
    pendingCheck: boolean
    selectedText: string
    ctrlKey: boolean   // 按下时是否按住 Ctrl/⌘ → 复制（不删原文）
    savedRange: Range | null  // 拖出时的选区快照（松手删除用）
    itemId: string | null     // 选区所在的 user 条目 id（数据级删除用）
  }>({ active: false, startX: 0, startY: 0, pendingCheck: false, selectedText: '', ctrlKey: false, savedRange: null, itemId: null })
  const onPullOutRef = useRef(onPullOut)
  useEffect(() => { onPullOutRef.current = onPullOut }, [onPullOut])
  const copyOnPullOutRef = useRef(copyOnPullOut)
  useEffect(() => { copyOnPullOutRef.current = copyOnPullOut }, [copyOnPullOut])

  // ── Refs to avoid stale closures ──
  const shapeRef = useRef(shape)
  const editorRef = useRef(editor)
  const isMountedRef = useRef(true)
  const isSelectedRef = useRef(isSelected)
  const isEditingRef = useRef(isEditing)

  useEffect(() => { shapeRef.current = shape }, [shape])
  useEffect(() => { editorRef.current = editor }, [editor])
  useEffect(() => { isSelectedRef.current = isSelected }, [isSelected])
  useEffect(() => { isEditingRef.current = isEditing }, [isEditing])

  useEffect(() => {
    isMountedRef.current = true
    return () => { isMountedRef.current = false }
  }, [])

  // ── AI 流式回复的实时状态 ──
  const [pendingResponse, setPendingResponse] = useState<{
    model: string
    content: string
  } | null>(null)

  // ── 有序混合条目 items ──
  // 优先使用 props.items（新格式）；旧数据迁移：user 片段在前 + AI 回复在后
  const items = useMemo<MixedItem[]>(() => {
    if (itemsProp && itemsProp.length > 0) return itemsProp
    const migrated: MixedItem[] = []
    const userTexts = userTextFragments.length > 0
      ? userTextFragments
      : (content.trim() ? [content] : [])
    for (let i = 0; i < userTexts.length; i++) {
      migrated.push({ kind: 'user', id: `legacy-user-${i}`, text: userTexts[i] })
    }
    for (let i = 0; i < aiResponses.length; i++) {
      migrated.push({ kind: 'ai', id: `legacy-ai-${i}`, ai: aiResponses[i] })
    }
    return migrated
  }, [itemsProp, userTextFragments, aiResponses, content])

  // itemsRef — 编辑中的最新文本状态（onInput 实时更新，退出编辑时写回）
  // 注意：编辑期间 tldraw 的其它 updateShape（如继承 conversationId）会改变 items 引用，
  //       此时不能把 itemsRef 重置为 store 旧值，否则会丢失正在输入的文本
  const itemsRef = useRef<MixedItem[]>(items)
  const editingItemsRef = useRef(false)
  useEffect(() => {
    if (!editingItemsRef.current) itemsRef.current = items
  }, [items])
  useEffect(() => {
    if (!isEditing) editingItemsRef.current = false
  }, [isEditing])

  // 拖拽排序时的实时预览顺序（拖拽中本地 state，结束时一次性保存）
  const [draftItems, setDraftItems] = useState<MixedItem[] | null>(null)
  const draftItemsRef = useRef<MixedItem[] | null>(null)
  useEffect(() => { draftItemsRef.current = draftItems }, [draftItems])
  const displayItems = draftItems ?? items

  // ── saveItems — 把有序条目写回 shape props（兼容字段统一由 deriveTextBlockProps 派生） ──
  const saveItems = useCallback((arr: MixedItem[]) => {
    const cur = shapeRef.current
    const ed = editorRef.current
    if (!cur || !ed) return
    ed.updateShape({
      id: cur.id,
      type: 'text-block',
      props: { items: arr, ...deriveTextBlockProps(arr) },
    })
  }, [])

  // 组件卸载时若仍处于编辑状态，把最新内容写回 store。
  // 场景：注意力模式（isEditing 恒 true 不会触发退出保存）中编辑文本后按 Esc 退出，
  //       overlay 卸载 → 这里兜底保存，保证画布数据同步。
  // 注意：StrictMode 开发模式 double-mount 时第一次卸载 editingItemsRef 为 false，不会误存。
  useEffect(() => {
    return () => {
      const cur = shapeRef.current
      const ed = editorRef.current
      if (!cur || !ed) return
      if (editingItemsRef.current && ed.getShape(cur.id)) {
        saveItems(itemsRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveItems])

  // 插入槽点击后自动聚焦新条目
  // 插入新条目后自动聚焦 —— 现在是「把 autoFocus 交给混合编辑器」，
  // 由它自己把第一块切成 textarea 并聚焦，不需要这里再操作 DOM 选区。
  const [pendingFocusItemId, setPendingFocusItemId] = useState<string | null>(null)

  // 实时更新 user 条目文本（编辑中输入时，不触发持久化）
  const updateUserItemText = useCallback((itemId: string, text: string) => {
    const arr = itemsRef.current
    const idx = arr.findIndex(i => i.kind === 'user' && i.id === itemId)
    if (idx === -1) return
    editingItemsRef.current = true
    const newArr = [...arr]
    // 注意：必须创建新对象再替换（newArr[idx] = {...arr[idx], text}），
    // 不能就地修改 newArr[idx].text —— itemsRef 可能指向 tldraw store 的
    // 只读/冻结对象，就地赋值会抛 TypeError，导致输入内容丢失！
    newArr[idx] = { ...(arr[idx] as Extract<MixedItem, { kind: 'user' }>), text }
    itemsRef.current = newArr
  }, [])

  // 在 idx 位置插入新的空自文本条目，并自动进入编辑
  const handleInsertUser = useCallback((idx: number) => {
    const arr = itemsRef.current
    const newItem: MixedItem = { kind: 'user', id: createShapeId(), text: '' }
    const newArr = [...arr]
    newArr.splice(idx, 0, newItem)
    itemsRef.current = newArr
    saveItems(newArr)
    setPendingFocusItemId(newItem.id)
  }, [saveItems])

  // 旧数据首次加载 → 一次性持久化 items（迁移写回 shape props）
  useEffect(() => {
    if (itemsProp && itemsProp.length > 0) return
    if (items.length === 0) return
    const ed = editorRef.current
    const cur = shapeRef.current
    if (!ed || !cur) return
    ed.updateShape({
      id: cur.id,
      type: 'text-block',
      props: { items },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsProp, items])

  // 派生：用户文本数组（AIInputBar 等旧逻辑兼容）
  const fragments = useMemo(
    () => items
      .filter((i): i is Extract<MixedItem, { kind: 'user' }> => i.kind === 'user')
      .map(i => i.text),
    [items],
  )

  // ── Auto-inherit conversationId on first edit ──
  useEffect(() => {
    if (!isEditing || conversationId) return
    const sources = collectIncomingSourceIds(editor, shape.id)
    for (const sourceId of sources) {
      const cid = getShapeConversationId(editor, sourceId)
      if (cid) {
        editor.updateShape({
          id: shape.id,
          type: 'text-block',
          props: { conversationId: cid },
        })
        return
      }
    }
  }, [isEditing, conversationId, editor, shape.id])

  // ── Conversation context (only when editing) ──
  const contextContents = useMemo(() => {
    if (!isEditing) return []
    const cid = conversationId ?? shape.props.conversationId
    if (!cid) return []
    return collectConversationContext(editor, cid)
  }, [isEditing, conversationId, shape.props.conversationId, shape.props.content, editor])

  const prevIsEditingRef = useRef(isEditing)
  useLayoutEffect(() => {
    const wasEditing = prevIsEditingRef.current
    prevIsEditingRef.current = isEditing
    if (wasEditing && !isEditing) {
      // 退出编辑：从 itemsRef 读取最新文本（DOM 已移除，ref 中保留最新内容）
      saveItems(itemsRef.current)
    }
  })

  const handleConversationChange = useCallback((newId: string) => {
    editor.updateShape({
      id: shape.id,
      type: 'text-block',
      props: { conversationId: newId },
    })
  }, [editor, shape.id])

  const saveAiResponse = useCallback((model: string, content: string, prompt: string) => {
    const cur = shapeRef.current
    const tldrawEditor = editorRef.current
    if (!tldrawEditor || !cur) return

    const newVersion: AiResponseVersion = {
      id: createShapeId(),
      label: '原版',
      content,
    }
    const newEntry: AiResponseEntry = {
      id: createShapeId(),
      model,
      prompt,
      versions: [newVersion],
      activeVersionIdx: 0,
    }
    // 追加到 items 末尾（保持条目顺序）
    const arr = [...itemsRef.current]
    arr.push({ kind: 'ai', id: createShapeId(), ai: newEntry })
    itemsRef.current = arr
    saveItems(arr)
  }, [saveItems])

  // ── AI 回复版本管理（基于 items 定位） ──
  const updateAiVersion = useCallback((
    entryId: string,
    updater: (entry: AiResponseEntry) => AiResponseEntry,
  ) => {
    const arr = itemsRef.current
    const idx = arr.findIndex(i => i.kind === 'ai' && i.ai.id === entryId)
    if (idx === -1) return
    const item = arr[idx]
    if (item.kind !== 'ai') return
    const newArr = [...arr]
    newArr[idx] = { ...item, ai: updater(item.ai) }
    itemsRef.current = newArr
    saveItems(newArr)
  }, [saveItems])

  const handleVersionChange = useCallback((entryId: string, idx: number) => {
    updateAiVersion(entryId, entry => ({ ...entry, activeVersionIdx: idx }))
  }, [updateAiVersion])

  const handleVersionRename = useCallback((entryId: string, versionId: string, newLabel: string) => {
    updateAiVersion(entryId, entry => ({
      ...entry,
      versions: entry.versions.map(v =>
        v.id === versionId ? { ...v, label: newLabel } : v
      ),
    }))
  }, [updateAiVersion])

  const handleAddVersion = useCallback((entryId: string) => {
    updateAiVersion(entryId, entry => {
      const activeV = entry.versions[entry.activeVersionIdx]
      const newV: AiResponseVersion = {
        id: createShapeId(),
        label: `修改`,
        content: activeV?.content ?? '',
      }
      const newIdx = entry.versions.length
      return {
        ...entry,
        versions: [...entry.versions, newV],
        activeVersionIdx: newIdx,
      }
    })
  }, [updateAiVersion])

  // ── AI 回复内容编辑保存（保存为新版本） ──
  const handleSaveEdit = useCallback((entryId: string, newContent: string) => {
    updateAiVersion(entryId, entry => {
      const newV: AiResponseVersion = {
        id: createShapeId(),
        label: `修改`,
        content: newContent,
      }
      const newIdx = entry.versions.length
      return {
        ...entry,
        versions: [...entry.versions, newV],
        activeVersionIdx: newIdx,
      }
    })
  }, [updateAiVersion])

  // ── 删除条目（AI 回复 / 用户自文本通用） ──
  const removeItemById = useCallback((itemId: string) => {
    setCtxMenu(null)
    const newArr = itemsRef.current.filter(i => i.id !== itemId)
    itemsRef.current = newArr
    saveItems(newArr)
  }, [saveItems])

  // 删除 AI 回复（按 AiResponseEntry.id 定位）
  const handleDeleteAiResponse = useCallback((entryId: string) => {
    setCtxMenu(null)
    const arr = itemsRef.current
    const idx = arr.findIndex(i => i.kind === 'ai' && i.ai.id === entryId)
    if (idx === -1) return
    const newArr = [...arr]
    newArr.splice(idx, 1)
    itemsRef.current = newArr
    saveItems(newArr)
  }, [saveItems])

  // 每个 user 条目的混合编辑器句柄（父组件外部改文本时用它强制重建块）
  const blockEditorsRef = useRef(new Map<string, BlockEditorHandle>())

  // 数据级删除选区文字（选中文字拉出 · 剪切语义用）。
  //
  // 改造后的难点：拖出发生在**渲染态块**上，而渲染后的文字与 markdown 源码不是 1:1
  // （`**粗体**` 渲染成「粗体」、`# 标题` 渲染成「标题」），没法像以前的 contentEditable
  // 那样直接用 Range 偏移算出源码位置。
  // 策略：拿选中文本去源码里找，**唯一匹配才删**；找不到 / 有多处匹配就静默退化为复制。
  // 宁可少删，也绝不误删别处的文字。
  const pullDeleteSelection = useCallback((itemId: string, r: Range | null) => {
    if (!r) return
    const selected = r.toString()
    if (!selected.trim()) return
    const arr = itemsRef.current
    const idx = arr.findIndex(i => i.kind === 'user' && i.id === itemId)
    if (idx === -1 || arr[idx].kind !== 'user') return
    const src = (arr[idx] as Extract<MixedItem, { kind: 'user' }>).text
    const pos = src.indexOf(selected)
    if (pos === -1) return
    if (src.indexOf(selected, pos + 1) !== -1) return
    editingItemsRef.current = true
    const nextText = src.slice(0, pos) + src.slice(pos + selected.length)
    const newArr = [...arr]
    newArr[idx] = { ...(arr[idx] as Extract<MixedItem, { kind: 'user' }>), text: nextText }
    itemsRef.current = newArr
    // 编辑器内部还拿着删除前的块，必须同步过去 —— 否则下一次按键会把删掉的文字带回来
    blockEditorsRef.current.get(itemId)?.replaceText(nextText)
  }, [])
  const pullDeleteRef = useRef(pullDeleteSelection)
  useEffect(() => { pullDeleteRef.current = pullDeleteSelection }, [pullDeleteSelection])

  // 拖出(move)模式：从 items 删除源条目（复用上方 removeItemById）

  // 子盒子拖出/排序预览状态
  const [subBoxDrag, setSubBoxDrag] = useState<{
    itemId?: string          // 条目 id（列表内排序 / 拖出删除用）
    kind?: 'user' | 'ai'
    isMove: boolean
    startX: number
    startY: number
    curX: number
    curY: number
  } | null>(null)

  // 启动子盒子拖拽（排序 or 拖出）
  const startSubBoxDrag = useCallback((
    e: React.PointerEvent,
    itemId: string | undefined,
    kind: 'user' | 'ai' | undefined,
    isMove: boolean,
  ) => {
    e.stopPropagation()
    e.preventDefault()
    setSubBoxDrag({ itemId, kind, isMove, startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY })
  }, [])

  // 子盒子拖出/排序追踪（document 级别）
  useEffect(() => {
    if (!subBoxDrag) return
    const el = containerRef.current
    if (!el) return
    const tldrawEditor = editorRef.current
    if (!tldrawEditor) return

    // 拖拽条目的文本内容（预览 + 拖出用）
    const getDragContent = (): string => {
      if (!subBoxDrag?.itemId) return ''
      const item = itemsRef.current.find(i => i.id === subBoxDrag.itemId)
      if (!item) return ''
      if (item.kind === 'user') return item.text
      const v = item.ai.versions[item.ai.activeVersionIdx]
      const body = v?.content ?? ''
      return item.ai.prompt ? `${item.ai.prompt}\n\n${body}` : body
    }

    let previewEl: HTMLDivElement | null = null

    const onPointerMove = (e: PointerEvent) => {
      setSubBoxDrag(prev => prev ? { ...prev, curX: e.clientX, curY: e.clientY } : null)
      const rect = el.getBoundingClientRect()

      // ── 框内实时排序预览 ──
      if (subBoxDrag?.itemId) {
        const arr = itemsRef.current
        const draggedIdx = arr.findIndex(i => i.id === subBoxDrag.itemId)
        if (draggedIdx !== -1) {
          const rows = el.querySelectorAll('.tb-item-row')
          let insertBefore = arr.length
          for (let i = 0; i < rows.length; i++) {
            const r = rows[i].getBoundingClientRect()
            if (e.clientY < r.top + r.height / 2) {
              insertBefore = i
              break
            }
          }
          const copy = [...arr]
          const [dragged] = copy.splice(draggedIdx, 1)
          const targetIdx = insertBefore > draggedIdx ? insertBefore - 1 : insertBefore
          copy.splice(targetIdx, 0, dragged)
          const base = draftItemsRef.current ?? arr
          if (base.map(i => i.id).join(',') !== copy.map(i => i.id).join(',')) {
            setDraftItems(copy)
          }
        }
      }

      // ── 拖出容器 → 显示悬浮预览 ──
      const outside = e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom
      if (!previewEl && outside) {
        previewEl = document.createElement('div')
        previewEl.className = 'subbox-drag-preview'
        previewEl.textContent = getDragContent().slice(0, 60) ?? ''
        Object.assign(previewEl.style, {
          position: 'fixed',
          padding: '8px 12px',
          background: 'rgba(124,77,255,0.9)',
          color: '#fff',
          borderRadius: '8px',
          fontSize: '13px',
          pointerEvents: 'none',
          zIndex: '9999',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '300px',
        })
        document.body.appendChild(previewEl)
      }
      if (previewEl) {
        previewEl.style.left = (e.clientX + 12) + 'px'
        previewEl.style.top = (e.clientY + 12) + 'px'
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      if (previewEl && document.body.contains(previewEl)) document.body.removeChild(previewEl)

      if (!subBoxDrag) {
        setSubBoxDrag(null)
        setDraftItems(null)
        document.removeEventListener('pointermove', onPointerMove)
        document.removeEventListener('pointerup', onPointerUp)
        document.body.style.cursor = ''
        return
      }

      const rect = el.getBoundingClientRect()
      const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom

      // ── 框内拖拽：提交排序（或取消） ──
      if (inside) {
        if (subBoxDrag.itemId) {
          const final = draftItemsRef.current
          if (final && final.length > 0) {
            itemsRef.current = final
            saveItems(final)
          }
        }
        setSubBoxDrag(null)
        setDraftItems(null)
        document.removeEventListener('pointermove', onPointerMove)
        document.removeEventListener('pointerup', onPointerUp)
        document.body.style.cursor = ''
        return
      }

      // ── 拖出容器：合并到目标框 或 创建新框 ──
      const dragContent = getDragContent()
      const pagePoint = tldrawEditor.screenToPage({ x: e.clientX, y: e.clientY })

      const allShapes = tldrawEditor.getCurrentPageShapes()
      const curId = (shapeRef.current as TextBlockShape)?.id
      const targetShape = allShapes.find(s =>
        s.type === 'text-block' &&
        s.id !== curId &&
        pagePoint.x >= s.x && pagePoint.x <= s.x + (s.props as TextBlockShape['props']).w &&
        pagePoint.y >= s.y && pagePoint.y <= s.y + (s.props as TextBlockShape['props']).h
      ) as TextBlockShape | undefined

      if (targetShape) {
        // ── 合并到目标文本框 ──
        const targetProps = targetShape.props
        const newContent = targetProps.content
          ? targetProps.content + '\n\n---\n\n' + dragContent
          : dragContent

        tldrawEditor.updateShape({
          id: targetShape.id,
          type: 'text-block',
          props: {
            content: newContent,
            richText: toRichText(newContent),
          },
        })

        if (subBoxDrag.isMove && subBoxDrag.itemId) {
          removeItemById(subBoxDrag.itemId)
        }

        tldrawEditor.select(targetShape.id)
      } else {
        // ── 拆分到新文本框 ──
        const childId = createShapeId()
        tldrawEditor.createShape({
          id: childId,
          type: 'text-block',
          x: pagePoint.x - 170,
          y: pagePoint.y - 60,
          props: {
            content: dragContent,
            richText: toRichText(dragContent),
          },
        })
        tldrawEditor.select(childId)
        tldrawEditor.setEditingShape(childId)

        if (subBoxDrag.isMove && subBoxDrag.itemId) {
          removeItemById(subBoxDrag.itemId)
        }
      }

      setSubBoxDrag(null)
      setDraftItems(null)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.body.style.cursor = ''
    }

    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.body.style.cursor = subBoxDrag.isMove ? 'grabbing' : 'copy'

    return () => {
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.body.style.cursor = ''
      if (previewEl && document.body.contains(previewEl)) document.body.removeChild(previewEl)
    }
  }, [subBoxDrag, saveItems, removeItemById])

  // ── AI 流式回调（传给 AIInputBar） ──
  const handleAiStreamStart = useCallback((model: string) => {
    setPendingResponse({ model, content: '' })
  }, [])

  const handleAiStreamUpdate = useCallback((fullContent: string) => {
    setPendingResponse(prev => prev ? { ...prev, content: fullContent } : null)
  }, [])

  const handleAiStreamEnd = useCallback((model: string, content: string, prompt: string) => {
    saveAiResponse(model, content, prompt)
    setPendingResponse(null)
  }, [saveAiResponse])

  // ── Conversation display info ──
  const activeCid = conversationId ?? shape.props.conversationId
  const convLabel = activeCid ? getConversationLabel(activeCid) : null
  const convCount = activeCid
    ? (getConversation(activeCid)?.messages.length ?? 0) / 2
    : 0

  // ── Colors ──
  const textColor = isDarkMode ? '#cdd6f4' : '#333333'
  const katexColor = isDarkMode ? '#cdd6f4' : '#333333'
  const accentColor = isDarkMode ? '#9d7cff' : '#7c4dff'
  const handleBorderColor = isDarkMode ? '#4a4a8a' : '#c8c8ff'

  // ── Native wheel handler ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (!isSelectedRef.current) return
      e.stopPropagation()
    }
    el.addEventListener('wheel', handler)
    return () => el.removeEventListener('wheel', handler)
  }, [])

  useEffect(() => {
    if (!isEditing) return
    const el = containerRef.current
    if (!el) return
    const editorLocal = editor
    let docMoveHandler: ((e: MouseEvent) => void) | null = null
    let docUpHandler: ((e: MouseEvent) => void) | null = null

    const cleanupDocListeners = () => {
      if (docMoveHandler) {
        document.removeEventListener('mousemove', docMoveHandler)
        docMoveHandler = null
      }
      if (docUpHandler) {
        document.removeEventListener('mouseup', docUpHandler)
        docUpHandler = null
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      // 只在「用户文本的渲染态块」上启动拖出（源码编辑态的 textarea 里
      // 选字拖动交给浏览器默认行为，AI 卡片有自己的复制按钮）
      if (!t?.closest('.tb-md-rendered')) return

      const sel = window.getSelection()
      const hasPriorSelection = sel && !sel.isCollapsed
      let insidePriorSelection = false
      let priorText = ''
      if (hasPriorSelection) {
        priorText = sel!.toString().trim()
        const range = sel!.getRangeAt(0)
        const rects = range.getClientRects()
        insidePriorSelection = Array.from(rects).some(r =>
          e.clientX >= r.left && e.clientX <= r.right &&
          e.clientY >= r.top && e.clientY <= r.bottom)
      }

      if (!hasPriorSelection || !priorText || !insidePriorSelection) {
        dragStateRef.current = { active: false, startX: 0, startY: 0, pendingCheck: false, selectedText: '', ctrlKey: false, savedRange: null, itemId: null }
        return
      }

      // 定位选区所在 user 条目（数据级删除用）
      const savedRange = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null
      const ceAnchor = savedRange
        ? (savedRange.startContainer.nodeType === Node.TEXT_NODE
          ? savedRange.startContainer.parentElement
          : (savedRange.startContainer as HTMLElement))
        : null
      const itemRow = ceAnchor?.closest('[data-item-id]') as HTMLElement | null

      dragStateRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        pendingCheck: false,
        selectedText: priorText,
        ctrlKey: e.ctrlKey || e.metaKey,
        savedRange,
        itemId: itemRow?.dataset.itemId ?? null,
      }

      docMoveHandler = (ev: MouseEvent) => {
        const ds = dragStateRef.current
        if (!ds.active) return
        const dx = ev.clientX - ds.startX
        const dy = ev.clientY - ds.startY
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return

        const rect = el.getBoundingClientRect()
        const outside = ev.clientX < rect.left || ev.clientX > rect.right ||
          ev.clientY < rect.top || ev.clientY > rect.bottom

        if (outside) {
          ev.preventDefault()
          setIsDraggingText(true)
          setDragPreviewPos({ x: ev.clientX, y: ev.clientY })
        }
      }

      docUpHandler = (ev: MouseEvent) => {
        const ds = dragStateRef.current
        if (ds.active) {
          if (isDraggingTextRef.current) {
            const rect = el.getBoundingClientRect()
            const outside = ev.clientX < rect.left || ev.clientX > rect.right ||
              ev.clientY < rect.top || ev.clientY > rect.bottom
            if (outside && ds.selectedText) {
              const pagePoint = editorLocal.screenToPage({ x: ev.clientX, y: ev.clientY })
              // 语义：普通拖出 = 复制（保护原文更常见，无修饰键最顺手）；
              //      Ctrl/⌘+拖出 = 剪切（删原文）；注意力模式（copyOnPullOut）恒复制
              const isCut = !copyOnPullOutRef.current && ds.ctrlKey
              if (isCut) {
                pullDeleteRef.current(ds.itemId ?? '', ds.savedRange)
              }
              onPullOutRef.current?.(ds.selectedText, pagePoint.x, pagePoint.y)
            }
          }
          setIsDraggingText(false)
        }
        dragStateRef.current = { active: false, startX: 0, startY: 0, pendingCheck: false, selectedText: '', ctrlKey: false, savedRange: null, itemId: null }
        cleanupDocListeners()
      }

      document.addEventListener('mousemove', docMoveHandler)
      document.addEventListener('mouseup', docUpHandler)
    }

    const preventNative = (e: DragEvent) => { e.preventDefault() }

    el.addEventListener('mousedown', onMouseDown)
    el.addEventListener('dragstart', preventNative)

    return () => {
      el.removeEventListener('mousedown', onMouseDown)
      el.removeEventListener('dragstart', preventNative)
      cleanupDocListeners()
    }
  }, [isEditing])

  // 流式中的待定回复卡片（历史回复由 items map 渲染）
  const renderPendingCard = () => {
    if (!pendingResponse) return null
    return (
      <AiResponseCard
        key="pending"
        entry={{
          id: 'pending',
          model: pendingResponse.model,
          versions: [{ id: 'pending-v', label: '原版', content: pendingResponse.content || '...' }],
          activeVersionIdx: 0,
          prompt: '',
        }}
        isDarkMode={isDarkMode}
        katexColor={katexColor}
        onVersionChange={() => {}}
        onVersionRename={() => {}}
        onAddVersion={() => {}}
        onSaveEdit={() => {}}
        onDragStart={(e) => {
          const ctrl = e.ctrlKey || e.metaKey
          startSubBoxDrag(e, undefined, undefined, ctrl)
        }}
      />
    )
  }

  return (
    <div
          ref={containerRef}
        className="textblock-content"
        style={{
          width: '100%',
          height: '100%',
          color: textColor,
          fontSize: '14px',
          lineHeight: 1.7,
          overflow: 'auto',
          cursor: isEditing ? 'text' : 'pointer',
          wordBreak: 'break-word',
          position: 'relative',
        }}
    >
      {/* Conversation tag — shown in preview mode */}
      {!isEditing && convLabel && (
        <div
          className="conv-tag"
          title={`对话: ${convLabel}${convCount > 0 ? ` (${convCount} 轮)` : ''}`}
        >
          {convLabel}
        </div>
      )}

      {isEditing ? (
        /* 编辑模式: items.map → 自文本「块级混合编辑器」 + AI 卡片，交错渲染
         *   · 文本保持渲染外观，点中某一块才就地变源码（Typora 式）
         *   · Ctrl+\ 在块内光标处拆块；条目间插入槽用于插入新片段 */
        <div
          className="textblock-editor-wrapper"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* 顶部插入槽 */}
          <InsertSlot onInsert={() => handleInsertUser(0)} />
          {displayItems.map((item, idx) => (
            <div key={item.id}>
              <div className="tb-item-row" data-item-id={item.id}>
                {item.kind === 'user' ? (
                  <div
                    style={{ display: 'flex', alignItems: 'stretch', marginBottom: '4px' }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setCtxMenu({ x: e.clientX, y: e.clientY, handler: () => removeItemById(item.id), label: '删除此段' })
                    }}
                  >
                    <div className="tb-user-card" style={{ flex: 1 }}>
                      <MarkdownBlockEditor
                        ref={(h) => {
                          if (h) blockEditorsRef.current.set(item.id, h)
                          else blockEditorsRef.current.delete(item.id)
                        }}
                        value={item.text}
                        isDarkMode={isDarkMode}
                        autoFocus={item.id === pendingFocusItemId}
                        onChange={(next) => updateUserItemText(item.id, next)}
                      />
                    </div>
                    <SubBoxDragHandle
                      onDragStart={(e) => {
                        const ctrl = e.ctrlKey || e.metaKey
                        startSubBoxDrag(e, item.id, 'user', ctrl)
                      }}
                      accentColor={accentColor}
                      borderColor={handleBorderColor}
                    />
                  </div>
                ) : (
                  <AiResponseCard
                    entry={item.ai}
                    isDarkMode={isDarkMode}
                    katexColor={katexColor}
                    onVersionChange={handleVersionChange}
                    onVersionRename={handleVersionRename}
                    onAddVersion={handleAddVersion}
                    onSaveEdit={handleSaveEdit}
                    onDragStart={(e) => {
                      const ctrl = e.ctrlKey || e.metaKey
                      startSubBoxDrag(e, item.id, 'ai', ctrl)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setCtxMenu({ x: e.clientX, y: e.clientY, handler: () => handleDeleteAiResponse(item.ai.id), label: '删除此回复' })
                    }}
                  />
                )}
              </div>
              {/* 条目之后插入槽 */}
              <InsertSlot onInsert={() => handleInsertUser(idx + 1)} />
            </div>
          ))}

          {/* 流式中的待定回复 */}
          {renderPendingCard()}

          {/* AI 输入栏 / DSH 会话线程 */}
          {dshSessionId ? (
            <SessionThread
              sessionId={dshSessionId}
              isDarkMode={isDarkMode}
              fromSeq={sessionFromSeq}
              toSeq={sessionToSeq}
              onSplit={handleSessionSplit}
              onMerge={sessionFromSeq !== undefined ? handleSessionMerge : undefined}
            />
          ) : (
            <AIInputBar
              contentText={fragments[0] || ''}
              conversationId={activeCid}
              onConversationChange={handleConversationChange}
              contextContents={contextContents}
              onAiStreamStart={handleAiStreamStart}
              onAiStreamUpdate={handleAiStreamUpdate}
              onAiStreamEnd={handleAiStreamEnd}
            />
          )}
        </div>
      ) : (
        /* 预览模式: items.map → MarkdownPreview / AiResponseCard 交错渲染 */
        <div className="textblock-preview">
          {displayItems.map((item) => (
            <div key={item.id} className="tb-item-row" data-item-id={item.id}>
              {item.kind === 'user' ? (
                <div
                  style={{ display: 'flex', alignItems: 'stretch' }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setCtxMenu({ x: e.clientX, y: e.clientY, handler: () => removeItemById(item.id), label: '删除此段' })
                  }}
                >
                  <div className="tb-user-card" style={{ flex: 1 }}>
                    <MarkdownPreview text={item.text} isDarkMode={isDarkMode} />
                  </div>
                  <SubBoxDragHandle
                    onDragStart={(e) => {
                      const ctrl = e.ctrlKey || e.metaKey
                      startSubBoxDrag(e, item.id, 'user', ctrl)
                    }}
                    accentColor={accentColor}
                    borderColor={handleBorderColor}
                  />
                </div>
              ) : (
                <AiResponseCard
                  entry={item.ai}
                  isDarkMode={isDarkMode}
                  katexColor={katexColor}
                  onVersionChange={handleVersionChange}
                  onVersionRename={handleVersionRename}
                  onAddVersion={handleAddVersion}
                  onSaveEdit={handleSaveEdit}
                  onDragStart={(e) => {
                    const ctrl = e.ctrlKey || e.metaKey
                    startSubBoxDrag(e, item.id, 'ai', ctrl)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setCtxMenu({ x: e.clientX, y: e.clientY, handler: () => handleDeleteAiResponse(item.ai.id), label: '删除此回复' })
                  }}
                />
              )}
            </div>
          ))}

          {/* 默认空状态：无任何条目 */}
          {items.length === 0 && (
            <span style={{ opacity: 0.4, fontStyle: 'italic' }}>
              双击编辑文本…
            </span>
          )}

          {/* 流式中的待定回复 */}
          {renderPendingCard()}

          {/* 绑定 DSH 会话时，预览态也显示会话线程 */}
          {dshSessionId && (
            <SessionThread
              sessionId={dshSessionId}
              isDarkMode={isDarkMode}
              fromSeq={sessionFromSeq}
              toSeq={sessionToSeq}
              onSplit={handleSessionSplit}
              onMerge={sessionFromSeq !== undefined ? handleSessionMerge : undefined}
            />
          )}
        </div>
      )}

      {/* 选中文字拖出浮动预览 — Portal 到 body */}
      {isDraggingText && createPortal(
        <div
          className="text-pull-preview"
          style={{
            left: dragPreviewPos.x + 12,
            top: dragPreviewPos.y + 12,
          }}
        >
          {dragStateRef.current.selectedText.slice(0, 50)}
          {dragStateRef.current.selectedText.length > 50 ? '…' : ''}
        </div>,
        document.body
      )}

      {/* 右键菜单 — Portal 到 body */}
      {ctxMenu && createPortal(
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            left: ctxMenu.x,
            top: ctxMenu.y,
            zIndex: 10000,
            background: isDarkMode ? '#313244' : '#fff',
            border: `1px solid ${isDarkMode ? '#4a4a8a' : '#ccc'}`,
            borderRadius: '8px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
            padding: '4px',
            minWidth: '140px',
          }}
        >
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              ctxMenu.handler()
            }}
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 14px',
              border: 'none',
              borderRadius: '6px',
              background: 'transparent',
              color: isDarkMode ? '#ff6b6b' : '#c0392b',
              fontSize: '13px',
              textAlign: 'left',
              cursor: 'pointer',
              fontWeight: 500,
            }}
            onMouseEnter={e => (e.currentTarget.style.background = isDarkMode ? '#3a2040' : '#fff0f0')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            {ctxMenu.label}
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
