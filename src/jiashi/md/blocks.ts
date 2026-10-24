/**
 * markdown 块切分 —— 混合渲染编辑器的地基
 *
 * 目标：把一段 markdown 源码切成「顶层块」序列（标题 / 段落 / 列表 / 代码块 / 引用 / 表格 …），
 * 让编辑器能做到「默认渲染外观，点中哪块哪块才显示源码」。
 *
 * 关键设计：**用 mdast 节点的 position 偏移量从原文切片，而不是把 AST 序列化回 markdown**。
 *   - 序列化（mdast-util-to-markdown）会规范化写法：`*` 变 `-`、多余空格被清、行内空白被重排…
 *     用户的原文会被悄悄改写，这在「编辑自己的笔记」场景里是不可接受的。
 *   - 用 offset 切片则是零损失：切片拼接回去和原文逐字节相同（除了块间空行归一化）。
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { Root } from 'mdast'

export interface MdBlock {
  /** React key（仅渲染用，不参与持久化） */
  key: string
  /** 该块的 markdown 源码（原文切片） */
  text: string
  /** 在所属整段文本中的字符偏移（用于把 textarea 光标映射回块） */
  start: number
  end: number
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

let blockSeq = 0
const nextKey = () => `mb${blockSeq++}`

/**
 * 切分 markdown 源码为顶层块。
 * - 空文本 → 单个空块（编辑器需要它作为「可点击输入」的落点）
 * - 解析异常 → 整体兜底为一块（绝不丢内容）
 */
export function splitMarkdownBlocks(src: string): MdBlock[] {
  if (!src) return [{ key: nextKey(), text: '', start: 0, end: 0 }]
  try {
    const tree = processor.parse(src) as unknown as Root
    const out: MdBlock[] = []
    for (const node of tree.children) {
      const s = node.position?.start.offset
      const e = node.position?.end.offset
      if (typeof s !== 'number' || typeof e !== 'number' || e <= s) continue
      out.push({ key: nextKey(), text: src.slice(s, e), start: s, end: e })
    }
    if (out.length > 0) return out
  } catch {
    /* 解析失败 → 落到下面整体兜底 */
  }
  return [{ key: nextKey(), text: src, start: 0, end: src.length }]
}

/** 块序列 → 完整文本。块之间补一个空行，保证块级边界在再次解析时仍然成立。 */
export function joinMarkdownBlocks(blocks: MdBlock[]): string {
  return blocks.map(b => b.text).join('\n\n')
}

/**
 * 内容（重新）切分：先拼回完整文本再切，用来把「块内新敲出来的空行」
 * 固化成新的块边界。用于退出编辑 / 外部内容变化等不会打断输入焦点的时机。
 */
export function resplitBlocks(blocks: MdBlock[]): MdBlock[] {
  return splitMarkdownBlocks(joinMarkdownBlocks(blocks))
}
