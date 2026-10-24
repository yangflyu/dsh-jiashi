/**
 * turndown / turndown-plugin-gfm 的最小类型声明。
 * 这两个包自身不带 .d.ts，社区也没有插件版的类型包，
 * 这里只声明本项目实际用到的部分，避免为了几个 API 引入一堆类型依赖。
 */
declare module 'turndown' {
  export interface TurndownOptions {
    headingStyle?: 'setext' | 'atx'
    hr?: string
    bulletListMarker?: string
    codeBlockStyle?: 'indented' | 'fenced'
    emDelimiter?: string
    strongDelimiter?: string
    linkStyle?: 'inlined' | 'referenced'
    br?: string
    blankReplacement?: (content: string, node: Node) => string
    keepReplacement?: (content: string, node: Node) => string
    defaultReplacement?: (content: string, node: Node) => string
  }

  export default class TurndownService {
    constructor(options?: TurndownOptions)
    use(plugin: unknown): TurndownService
    addRule(key: string, rule: unknown): TurndownService
    addRule(key: string, rule: {
      filter: string | string[] | ((node: Node) => boolean)
      replacement: (content: string, node: Node, options: Record<string, unknown>) => string
    }): TurndownService
    keep(filter: string | string[] | ((node: Node) => boolean)): TurndownService
    remove(filter: string | string[] | ((node: Node) => boolean)): TurndownService
    turndown(input: string | Node): string
  }
}

declare module 'turndown-plugin-gfm' {
  export const gfm: unknown
  export const tables: unknown
  export const strikethrough: unknown
  export const taskListItems: unknown
  export const highlightedCodeBlock: unknown
}
