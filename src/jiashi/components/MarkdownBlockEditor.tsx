/**
 * MarkdownBlockEditor —— 「块级混合渲染」文本编辑器
 *
 * 解决的问题：原先编辑态是一个整段 contentEditable，一进去**全篇掉渲染**变成源码，
 * 读起来很突兀。这里改成 Typora / Obsidian 那种粒度：
 *
 *   · 进入编辑后，文本**保持渲染外观**（和预览态一模一样）
 *   · 点中哪一块（标题 / 段落 / 列表 / 代码块 / 引用 / 表格），**只有那一块**就地变成源码
 *   · 光标离开又变回渲染
 *
 * 关键实现取舍：
 *   1. 块切分走 mdast（见 ../md/blocks.ts），但用 position 偏移**从原文切片**，
 *      不做序列化 —— 用户原始写法（`*` 还是 `-`、多少空格）零损失。
 *   2. 编辑期间**不重新切分**。否则用户刚敲出来的空行会让块数组重排、
 *      textarea 被卸载重建 → 光标丢失。固化块粒度放在「退出编辑」这个安全时机。
 *   3. 粘贴统一走 ../md/clipboard.ts 转换，避免富文本来源插入真 HTML 元素后
 *      被 innerText 抹掉结构（网页里的一级标题因此丢失 `#`）。
 *   4. 本组件**不订阅外部 value 变化**：编辑期间父组件的 props 文本是滞后的
 *      （父组件刻意只在内存 ref 里更新，避免每敲一个字都写 tldraw store）。
 *      若按 props 同步，点一下外面就会把正在编辑的文本回滚。外部需要改文本时
 *      走命令式句柄 `replaceText()`。
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import MarkdownPreview from './MarkdownPreview'
import { splitMarkdownBlocks, joinMarkdownBlocks, resplitBlocks, type MdBlock } from '../md/blocks'
import { clipboardToMarkdown } from '../md/clipboard'
import { setActiveCardSplitHandler } from '../session/cardSplit'

export interface BlockEditorHandle {
  /** 由父组件在外部改动文本后调用（如「选中文字拖出」的剪切语义），强制以新文本重建块 */
  replaceText: (text: string) => void
}

interface Props {
  /** 初始 markdown 源码（挂载时切块；后续变更走 replaceText） */
  value: string
  isDarkMode: boolean
  /** 内容变化实时上报（父组件只更新内存 ref，退出编辑才落库） */
  onChange: (next: string) => void
  /** 挂载后自动进入编辑（新建的空片段用，插进来自动可打字） */
  autoFocus?: boolean
  placeholder?: string
  /**
   * 提供后，Ctrl+\ 变成「把这张卡从光标处拆成两张卡」：
   * 参数 offset 是光标在当前条目文本里的字符偏移。
   * 不提供时（例如编辑 AI 回复条目）退回原来的"块内拆段"。
   */
  onSplitCard?: (offsetInValue: number) => void
}

let splitSeq = 0

/**
 * 标题块在源码态也要保持渲染态的**字号**，否则点开一个标题，它瞬间从
 * 18.2px 缩成 14px（高度差 7px），下面所有块跟着抖一下 —— 很跳。
 * 数值表必须与 MarkdownPreview 里 h1/h2/h3 的显式字号一致；
 * h4-h6 那边没显式设字号，走浏览器默认，这里照抄同样的默认值。
 */
const HEADING_FONT_SIZE = ['1.5em', '1.3em', '1.15em', '1em', '0.83em', '0.67em']

function blockFontSize(text: string): React.CSSProperties | undefined {
  const m = /^\s{0,3}(#{1,6})\s/.exec(text)
  if (!m) return undefined
  return { fontSize: HEADING_FONT_SIZE[m[1].length - 1] }
}

/** Ctrl/⌘ + \（中文输入法下 key 可能变成 '、'/'Process'，所以同时看物理键 code）；Ctrl/⌘ + Enter 是备用键。 */
function isSplitShortcut(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey)) return false
  if (e.code === 'Enter') return true
  return (
    e.code === 'Backslash' ||
    e.code === 'IntlBackslash' ||
    e.key === '\\' ||
    e.key === '、' ||
    e.key === 'Process'
  )
}

/** 写诊断日志到宿主（client 入口设置的 window.__jiashiDebugLog）。 */
function debugLog(event: string, data?: unknown) {
  try {
    const log = (window as unknown as { __jiashiDebugLog?: (event: string, data?: unknown) => void }).__jiashiDebugLog
    log?.(event, data)
  } catch {
    /* ignore */
  }
}

const MarkdownBlockEditor = forwardRef<BlockEditorHandle, Props>(function MarkdownBlockEditor(
  {
    value,
    isDarkMode,
    onChange,
    autoFocus = false,
    placeholder = '点击输入…',
    onSplitCard,
  }: Props,
  ref,
) {
  const [blocks, setBlocks] = useState<MdBlock[]>(() => splitMarkdownBlocks(value))
  const [editingIdx, setEditingIdx] = useState<number | null>(() => (autoFocus ? 0 : null))

  const rootRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const blocksRef = useRef(blocks)
  /** 单击 / 拖动选字 的区分：每次 mousedown 记起点（ref 而非 state，避免按下就重渲染） */
  const downPosRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => { blocksRef.current = blocks }, [blocks])

  const emit = useCallback((arr: MdBlock[]) => {
    onChange(joinMarkdownBlocks(arr))
  }, [onChange])

  useImperativeHandle(ref, () => ({
    replaceText(text: string) {
      const next = splitMarkdownBlocks(text)
      setBlocks(next)
      blocksRef.current = next
      setEditingIdx(null)
    },
  }), [])

  /** 退出编辑：清焦点 + 把「块内新敲出来的空行」固化成新的块边界 */
  const exitEditing = useCallback(() => {
    setEditingIdx(null)
    const next = resplitBlocks(blocksRef.current)
    setBlocks(next)
    blocksRef.current = next
    emit(next)
  }, [emit])

  const updateBlock = useCallback((idx: number, text: string) => {
    const next = blocksRef.current.map((b, i) => (i === idx ? { ...b, text } : b))
    setBlocks(next)
    blocksRef.current = next
    emit(next)
  }, [emit])

  // textarea 高度自适应（内容多少行就多高，不出现内部滚动条）
  const autosize = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [])

  useLayoutEffect(() => {
    if (editingIdx === null) return
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    // 光标落到末尾 —— 编辑已有内容的常见意图是「接着往下写」
    ta.selectionStart = ta.selectionEnd = ta.value.length
    autosize()
  }, [editingIdx, autosize])

  useLayoutEffect(() => { autosize() })

  // 点到编辑器之外 → 退出编辑（并固化块粒度）。
  // 用 capture 阶段监听 document：块 A 的 textarea 失焦与新块的进入编辑
  // 都由本组件内部负责，这里只处理「点到外面」。
  useEffect(() => {
    if (editingIdx === null) return
    const onDocDown = (e: MouseEvent) => {
      const root = rootRef.current
      const t = e.target as HTMLElement | null
      if (root && t && root.contains(t)) return
      exitEditing()
    }
    document.addEventListener('mousedown', onDocDown, true)
    return () => document.removeEventListener('mousedown', onDocDown, true)
  }, [editingIdx, exitEditing])

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>, idx: number) => {
      const md = clipboardToMarkdown(e.clipboardData)
      if (!md) return
      e.preventDefault()

      const ta = e.currentTarget
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const before = ta.value.slice(0, start)
      const after = ta.value.slice(end)

      // 粘贴进来的是「块级内容」（含空行，或以 #/-/>/``` 等块级标记开头）时，
      // 若光标在行中间 / 行尾，直接贴上会粘成一团（`## 标题# 新标题`）。
      // 这里按 markdown 的块边界语义补空行，粘贴结果才能独立成块。
      const trimmed = md.trim()
      const blockish =
        /\n\s*\n/.test(trimmed) ||
        /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\|)/.test(trimmed)
      let payload = md
      if (blockish) {
        if (before && !/\n\s*$/.test(before)) payload = '\n\n' + payload
        if (after && !/^\s*\n/.test(after)) payload = payload.replace(/\s+$/, '') + '\n\n'
      }

      updateBlock(idx, before + payload + after)

      // 光标移到粘进来的内容之后
      requestAnimationFrame(() => {
        const el = taRef.current
        if (!el) return
        el.selectionStart = el.selectionEnd = Math.min(start + payload.length, el.value.length)
        autosize()
      })
    },
    [updateBlock, autosize],
  )

  /** Ctrl+\ 在光标处把当前块一分为二（光标在末尾时在下方新建空块） */
  const splitAtCursor = useCallback((idx: number, ta: HTMLTextAreaElement) => {
    const pos = ta.selectionStart
    const before = ta.value.slice(0, pos).replace(/\s+$/, '')
    const after = ta.value.slice(pos).replace(/^\s+/, '')
    if (!before.trim() && !after.trim()) {
      debugLog('editor.split-empty', { idx, pos })
      return
    }
    let arr: MdBlock[]
    let focusIdx: number
    let mode: 'before' | 'middle' | 'end'
    if (!before.trim()) {
      // 光标在块首：在上面插入空块，原文留在当前块（和文本编辑器里"行首回车"一致）
      arr = [...blocksRef.current]
      arr.splice(idx, 0, { key: `mb-split-${splitSeq++}`, text: '', start: 0, end: 0 })
      focusIdx = idx
      mode = 'before'
    } else {
      arr = blocksRef.current.map((b, i) => (i === idx ? { ...b, text: before } : b))
      arr.splice(idx + 1, 0, {
        key: `mb-split-${splitSeq++}`,
        text: after,
        start: 0,
        end: after.length,
      })
      focusIdx = idx + 1
      mode = after.trim() ? 'middle' : 'end'
    }
    setBlocks(arr)
    blocksRef.current = arr
    emit(arr)
    setEditingIdx(focusIdx)
    debugLog('editor.split', { idx, mode, beforeLength: before.length, afterLength: after.length })
  }, [emit])

  /** 把「拆卡」动作交给父组件（偏移量 = 当前块在整段文本里的起点 + 光标位置）。 */
  const splitCardAtCursor = useCallback((idx: number, ta: HTMLTextAreaElement) => {
    const block = blocksRef.current[idx]
    if (block === undefined) return
    const offset = block.start + ta.selectionStart
    debugLog('card.split-key', { idx, offset })
    onSplitCard?.(offset)
  }, [onSplitCard])

  // 键盘必须用**原生监听**，不能只用 React 的 onKeyDown：
  // tldraw 把 keydown 挂在容器上（冒泡阶段），而它的 Escape 分支不受
  // 「输入框内禁用快捷键」保护 —— 无条件 editor.cancel()，会把整张卡片的编辑态一起退掉。
  // React 的事件挂在 React 根节点上，冒泡顺序晚于 tldraw 的容器，拦不住。
  // 挂在 textarea 自身则在「目标阶段」执行，早于容器的冒泡监听。
  useEffect(() => {
    const ta = taRef.current
    if (!ta || editingIdx === null) return
    debugLog('editor.edit-start', { idx: editingIdx, hasTextarea: true })
    const onNativeKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        exitEditing()
        return
      }
      // Ctrl+\ 拆卡（编辑 AI 回复条目时退回块内拆段）—— 用 e.code 物理键判断最可靠：
      // 中文输入法下 e.key 可能变成 'Process'/'、'，导致判定失效
      if (isSplitShortcut(e)) {
        e.preventDefault()
        e.stopPropagation()
        debugLog('editor.key-target', { key: e.key, code: e.code })
        if (onSplitCard !== undefined) splitCardAtCursor(editingIdx, ta)
        else splitAtCursor(editingIdx, ta)
      }
    }
    ta.addEventListener('keydown', onNativeKeyDown)

    // 兜底：DSH 外壳/宿主可能在冒泡阶段处理或吞掉组合键。
    // 在 window **捕获阶段**先接住，但只处理"焦点在我们块文本框里"的 Ctrl+\。
    const onWindowCapture = (e: KeyboardEvent) => {
      const active = document.activeElement
      if (!(active instanceof HTMLTextAreaElement)) return
      if (active.dataset.jiashiBlockEditor === undefined) return
      if (!isSplitShortcut(e)) return
      debugLog('editor.key-capture', { key: e.key, code: e.code })
      e.preventDefault()
      e.stopPropagation()
      if (onSplitCard !== undefined) splitCardAtCursor(editingIdx, active)
      else splitAtCursor(editingIdx, active)
    }
    window.addEventListener('keydown', onWindowCapture, true)
    return () => {
      debugLog('editor.edit-end', { idx: editingIdx })
      ta.removeEventListener('keydown', onNativeKeyDown)
      window.removeEventListener('keydown', onWindowCapture, true)
    }
  }, [editingIdx, exitEditing, splitAtCursor, splitCardAtCursor, onSplitCard])

  // 给 DSH 快捷键命令用的"当前可拆卡"动作（原生快捷键通过 IPC 触发时也走这里）。
  useEffect(() => {
    if (editingIdx === null || onSplitCard === undefined) return
    return setActiveCardSplitHandler(() => {
      const ta = taRef.current
      const block = blocksRef.current[editingIdx]
      if (ta === null || block === undefined) return
      const offset = block.start + ta.selectionStart
      debugLog('card.split-shortcut', { idx: editingIdx, offset })
      onSplitCard(offset)
    })
  }, [editingIdx, onSplitCard])

  return (
    <div className="tb-md-editor" ref={rootRef}>
      {blocks.map((b, i) => {
        if (editingIdx === i) {
          return (
            <div className="tb-md-block tb-md-block-editing" key={b.key}>
              <textarea
                ref={taRef}
                className="tb-md-textarea"
                data-jiashi-block-editor=""
                data-block-index={i}
                value={b.text}
                rows={1}
                style={blockFontSize(b.text)}
                spellCheck={false}
                placeholder={placeholder}
                onChange={(e) => updateBlock(i, e.target.value)}
                onPaste={(e) => handlePaste(e, i)}
              />
              {/* 鼠标兜底：键盘快捷键被外壳吞掉时也能拆 */}
              <button
                type="button"
                className="tb-md-split-btn"
                title={onSplitCard !== undefined ? '把这张卡从光标处拆成两张（Ctrl+Shift+\\）' : '在光标处拆块（Ctrl+\\）'}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  const ta = taRef.current
                  if (ta === null) return
                  if (onSplitCard !== undefined) {
                    const block = blocksRef.current[i]
                    const offset = block === undefined ? ta.selectionStart : block.start + ta.selectionStart
                    debugLog('card.split-btn', { idx: i, offset })
                    onSplitCard(offset)
                  } else {
                    debugLog('editor.split-btn', { idx: i })
                    splitAtCursor(i, ta)
                  }
                }}
              >
                {onSplitCard !== undefined ? '拆成新卡' : '拆'}
              </button>
            </div>
          )
        }
        const empty = !b.text.trim()
        return (
          <div className="tb-md-block" key={b.key}>
            <div
              className={`tb-md-rendered${empty ? ' tb-md-rendered-empty' : ''}`}
              onMouseDown={(e) => {
                // 记下起点：只有「单击」才进编辑；拖动选字、或已有选区时不进
                downPosRef.current = { x: e.clientX, y: e.clientY }
              }}
              onMouseUp={(e) => {
                const d = downPosRef.current
                downPosRef.current = null
                if (!d) return
                if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
                const sel = window.getSelection()
                if (sel && !sel.isCollapsed && sel.toString().trim()) return
                setEditingIdx(i)
              }}
            >
              {empty
                ? <span className="tb-md-placeholder">{placeholder}</span>
                : <MarkdownPreview text={b.text} isDarkMode={isDarkMode} />}
            </div>
          </div>
        )
      })}
    </div>
  )
})

export default MarkdownBlockEditor
