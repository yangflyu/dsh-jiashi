/**
 * 剪贴板 → markdown
 *
 * 背景（实测确认的 bug）：编辑器原先是一个 contentEditable，粘贴走浏览器默认行为。
 * 从网页 / Word / 本应用的渲染态复制时，剪贴板里带的是 text/html，
 * contentEditable 会**插入真正的 HTML 元素**（比如 <h1>标题</h1>），
 * 而存盘时取的是 innerText → "#" 之类的结构标记被整段抹掉。
 *
 * 这里的策略（两层兜底）：
 *   1. 纯文本本身已经是 markdown（从 md 编辑器 / 代码复制）→ 原样保留，绝不动它
 *   2. 富文本来源 → 用 turndown 把 HTML 转回 markdown，
 *      这样网页里的一级标题会变成 `# 标题`，而不是丢掉结构只剩一行字
 */
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

let cached: TurndownService | null = null

function getTurndown(): TurndownService {
  if (cached) return cached
  const td = new TurndownService({
    headingStyle: 'atx',        // # 标题
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',   // ``` 围栏
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  })
  td.use(gfm)                   // 表格 / 删除线 / 任务列表
  // turndown 的列表项默认写成 `-   条目`（破折号后三个空格），观感偏松。
  // 这里统一成常见的 `- 条目` / `1. 条目`，也顺便把嵌套缩进从 4 空格收到 2 空格。
  td.addRule('compactListItem', {
    filter: 'li',
    replacement: (content: string, node: Node, options: { bulletListMarker: string }) => {
      const el = node as HTMLElement
      const parent = el.parentNode as HTMLElement | null
      const cleaned = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n/g, '\n  ')
      let prefix = `${options.bulletListMarker} `
      if (parent && parent.nodeName === 'OL') {
        // 有序列表要保持真实序号（含 <ol start="3"> 这种）
        const start = parent.getAttribute('start')
        const index = Array.prototype.indexOf.call(parent.children, el)
        prefix = `${start ? Number(start) + index : index + 1}. `
      }
      // 非末项要补换行，否则相邻列表项会挤成一行（`1. 甲2. 乙`）
      const sep = el.nextElementSibling && !/\n$/.test(cleaned) ? '\n' : ''
      return prefix + cleaned + sep
    },
  })
  cached = td
  return td
}

/** 纯文本里已带 markdown 结构标记 → 判定「来源本身就是 markdown 文本」 */
const MD_HINT =
  /(?:^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\|)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/

export function looksLikeMarkdown(s: string): boolean {
  return MD_HINT.test(s)
}

export function htmlToMarkdown(html: string): string {
  try {
    return getTurndown().turndown(html).trim()
  } catch {
    return ''
  }
}

/**
 * 从剪贴板数据里取出「最适合进 markdown 编辑器」的文本。
 */
export function clipboardToMarkdown(dt: DataTransfer | null | undefined): string {
  if (!dt) return ''
  const plain = dt.getData('text/plain') ?? ''
  const html = dt.getData('text/html') ?? ''
  // ① 已经像 markdown → 原样保留（最尊重用户输入）
  if (plain.trim() && looksLikeMarkdown(plain)) return plain
  // ② 富文本 → HTML 转 markdown
  if (html.trim()) {
    const md = htmlToMarkdown(html)
    if (md.trim()) return md
  }
  // ③ 兜底：纯文本
  return plain
}
