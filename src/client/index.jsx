import React from 'react'
import tldrawCss from 'tldraw/tldraw.css'
import katexCss from 'katex/dist/katex.min.css'
import appCss from '../jiashi/App.css'
import App from '../jiashi/App'
import { configureSessionRuntime } from '../jiashi/session/bridge'
import { hasActiveSplit, runActiveSplit } from '../jiashi/session/cardSplit'
import { SessionInfoProvider } from '../jiashi/session/SessionInfo'

/**
 * 架势画布（dsh-jiashi）— Client 半边（v0.3，UI 移植版）。
 *
 * 这一版把「架势」原来的整套界面原样搬进 DSH 的主面板：
 * - 复用 Framework/src 下的 App / TextBlockShapeUtil / 块级 Markdown 编辑器 /
 *   注意力模式 / 线性视图 / 快捷键系统（源码复制到 src/jiashi，改动仅限
 *   App.css 的 .app-root 由 fixed 改为 absolute，适配主面板容器）；
 * - 数据层暂时保持原样（localStorage + 原 AI 接口），下一阶段再换成 DSH session；
 * - 入口仍是左侧栏的「画布」主面板（main + sidebar.panellist）。
 */

const MAIN_KEY = 'jiashi'
const NS = 'jiashi'
const MODULE_VERSION = '0.26.0-small-pull-note'

const zh = { 'panel.label': '画布', 'split.item': '把光标所在的子框拆成两个' }
const en = { 'panel.label': 'Canvas', 'split.item': 'Split the focused sub-box in two' }

/** 客户端诊断日志（/jiashi/api/log → $DSH_HOME/jiashi/board.log）。 */
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
    /* 桌面 file:// / dsh-app 不可达时静默 */
  }
}

let stylesInjected = false
function injectStyles() {
  // 每次模块加载都刷新样式内容：HMR 会换掉 JS，但旧的 <style> 标签还在，
  // 如果这里直接跳过，改过的 CSS（比如拖出手柄的可见性）就永远不生效。
  if (stylesInjected) return
  stylesInjected = true
  const add = (id, text) => {
    let style = document.querySelector(`style[data-jiashi="${id}"]`)
    if (style === null) {
      style = document.createElement('style')
      style.dataset.plugin = 'dsh-jiashi'
      style.dataset.jiashi = id
      document.head.appendChild(style)
    }
    style.textContent = text
  }
  add('tldraw', tldrawCss)
  add('app', appCss)
  add('katex', katexCss)
}

/** 渲染崩溃时显示可读错误 + 写日志（DSH 的 slot 错误边界只渲染空 div）。 */
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
      stack: String(error?.stack ?? '').slice(0, 5000),
      componentStack: String(info?.componentStack ?? '').slice(0, 3000),
    })
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div style={{ padding: 20, fontSize: 12, lineHeight: 1.7, color: '#e5484d', fontFamily: 'Consolas, monospace' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>画布渲染失败</div>
          <div>{String(this.state.error?.message ?? this.state.error)}</div>
          <div style={{ whiteSpace: 'pre-wrap', opacity: 0.7 }}>
            {String(this.state.error?.stack ?? '').slice(0, 2000)}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

/** 主面板：把原版 App 铺进 DSH 的中间列，并把会话标题查询能力提供给画布内部。 */
function Board(props) {
  React.useEffect(() => {
    boardLog('board.mount', { version: MODULE_VERSION })
    // 诊断：卡片的 DOM 到底能不能收到指针事件。
    // .tl-html-container 默认 pointer-events:none；如果子元素没有显式覆盖，
    // 卡片里的手柄/文字都点不到 —— 这是"拖出没反应"的头号嫌疑。
    const timer = window.setTimeout(() => {
      try {
        const host = document.querySelector('[data-jiashi-board]')
        const card = host?.querySelector('.tb-wrapper') ?? null
        const htmlContainer = card?.closest('.tl-html-container') ?? null
        const shapeEl = card?.closest('.tl-shape') ?? null
        const rect = card?.getBoundingClientRect()
        const hit = rect
          ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          : null
        boardLog('diag.pointer', {
          cards: host?.querySelectorAll('.tb-wrapper').length ?? 0,
          handles: host?.querySelectorAll('.pull-handle').length ?? 0,
          subHandles: host?.querySelectorAll('.subbox-drag-handle').length ?? 0,
          cardPointer: card === null ? null : getComputedStyle(card).pointerEvents,
          htmlPointer: htmlContainer === null ? null : getComputedStyle(htmlContainer).pointerEvents,
          shapePointer: shapeEl === null ? null : getComputedStyle(shapeEl).pointerEvents,
          hit: hit === null ? null : `${hit.tagName}.${String(hit.className ?? '').slice(0, 40)}`,
          hitPointer: hit === null ? null : getComputedStyle(hit).pointerEvents,
          ...(() => {
            const handle = host?.querySelector('.pull-handle') ?? null
            if (handle === null) return { handleOpacity: null, handleRect: null, handleHit: null }
            const hr = handle.getBoundingClientRect()
            const h = document.elementFromPoint(hr.left + hr.width / 2, hr.top + hr.height / 2)
            return {
              handleOpacity: getComputedStyle(handle).opacity,
              handleRect: `${Math.round(hr.left)},${Math.round(hr.top)} ${Math.round(hr.width)}x${Math.round(hr.height)}`,
              handleHit: h === null ? null : `${h.tagName}.${String(h.className ?? '').slice(0, 30)}`,
            }
          })(),
        })
      } catch (error) {
        boardLog('diag.pointer-failed', { error: String(error?.message ?? error) })
      }
    }, 2500)
    // 诊断：画布里到底能不能选中文字（B 手势的前提）。
    const onUp = () => {
      window.setTimeout(() => {
        try {
          const sel = window.getSelection()
          if (!sel || sel.isCollapsed) return
          const text = sel.toString().trim()
          if (text === '') return
          const anchor = sel.anchorNode
          const anchorEl = anchor instanceof Element ? anchor : anchor?.parentElement ?? null
          boardLog('diag.selection', {
            length: text.length,
            anchor: anchorEl === null ? null : `${anchorEl.tagName}.${String(anchorEl.className ?? '').slice(0, 40)}`,
            inBoard: anchorEl !== null && anchorEl.closest('[data-jiashi-board]') !== null,
          })
        } catch {
          /* ignore */
        }
      }, 0)
    }
    document.addEventListener('mouseup', onUp)
    // 诊断：选区是否真的形成（用户反馈"对话卡里的回答选不中"时用来定位）
    let lastLen = 0
    const onSelChange = () => {
      try {
        const sel = window.getSelection()
        const len = sel === null || sel.isCollapsed ? 0 : sel.toString().trim().length
        if (len === 0 || len === lastLen) {
          lastLen = len
          return
        }
        lastLen = len
        const anchor = sel?.anchorNode ?? null
        const el = anchor instanceof Element ? anchor : anchor?.parentElement ?? null
        boardLog('diag.selchange', {
          length: len,
          cls: el === null ? null : `${el.tagName}.${String(el.className ?? '').slice(0, 40)}`,
        })
      } catch {
        /* ignore */
      }
    }
    document.addEventListener('selectionchange', onSelChange)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('selectionchange', onSelChange)
    }
  }, [])
  return (
    <SessionInfoProvider useSessions={props.useSessions}>
      <div
        data-jiashi-board=""
        style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden' }}
      >
        <App />
      </div>
    </SessionInfoProvider>
  )
}

function BoardEntry() {
  return (
    <BoardBoundary>
      <Board />
    </BoardBoundary>
  )
}

/** 左侧栏面板行的图标（sidebar.panellist 渲染的就是这个组件）。 */
function PanelIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="10" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="10" y="13" width="10" height="7" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 11v2h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function apply(ctx) {
  try {
    injectStyles()
  } catch (error) {
    boardLog('activate.error', { step: 'styles', error: String(error?.stack ?? error) })
  }
  boardLog('module.load', { version: MODULE_VERSION, href: String(document.baseURI) })
  // 让被复制的 App 也能往宿主日志写诊断（注意力模式快捷键等）。
  window.__jiashiDebugLog = (event, data) => boardLog(event, data)
  // 会话桥：画布上的对话卡通过它 retain/follow/prompt DSH 会话。
  try {
    configureSessionRuntime(ctx)
  } catch (error) {
    boardLog('activate.error', { step: 'session-runtime', error: String(error?.stack ?? error) })
  }

  /**
   * 注册失败绝不能抛回 cordis：以前直接在 apply 里注册 slot（尤其是一开始那个
   * 临时 probe），冷启动时父入口还没声明 slot，注册会抛 "slot ... is not declared"，
   * 整个 entry 变 failed，web boot 审计失败 → DSH 直接打不开。
   * 这里两层保险：slot 用 slots.inject 等声明；任何注册异常只写日志，不影响启动。
   */
  const safeEffect = (fn, label) => {
    try {
      ctx.effect(fn, label)
    } catch (error) {
      boardLog('activate.error', { step: label, error: String(error?.stack ?? error) })
    }
  }

  safeEffect(() => ctx.locale.register(NS, { zh, en }), 'jiashi: dictionaries')
  let t = (key) => key
  try {
    t = ctx.locale.bind(NS)
  } catch (error) {
    boardLog('activate.error', { step: 'locale-bind', error: String(error?.stack ?? error) })
  }

  safeEffect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: MAIN_KEY, locale: NS }, BoardEntry),
      ),
    'jiashi: main panel',
  )
  safeEffect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
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
      ),
    'jiashi: sidebar entry',
  )

  // 拆子框快捷键：走 DSH 的命令注册表（桌面端由原生键盘桥分发，
  // 不依赖 DOM keydown，也就不会被已注册的 DSH 快捷键抢走）。
  // 默认 Ctrl/⌘ + Shift + \\；用户也可以在 DSH「设置 → 快捷键」里改键。
  // 用 ctx.inject 等 shortcuts 服务就绪，服务缺失/注册失败只丢快捷键、不阻断插件激活。
  safeEffect(
    () =>
      ctx.inject(['shortcuts'], (injected) => {
        try {
          injected.effect(
            () =>
              injected.shortcuts.register({
                id: 'jiashi.split-item',
                label: () => t('split.item'),
                aliases: ['split item', 'jiashi split', '拆子框', '拆开'],
                defaults: {
                  'desktop:windows': { code: 'Backslash', modifiers: ['primary', 'shift'] },
                  'desktop:macos': { code: 'Backslash', modifiers: ['primary', 'shift'] },
                  'desktop:linux': { code: 'Backslash', modifiers: ['primary', 'shift'] },
                  'web:windows': { code: 'Backslash', modifiers: ['primary', 'shift'] },
                  'web:macos': { code: 'Backslash', modifiers: ['primary', 'shift'] },
                },
                regions: ['page', 'editable'],
                modals: [],
                resolve: () =>
                  hasActiveSplit()
                    ? {
                        status: 'handled',
                        run: () => {
                          runActiveSplit()
                        },
                      }
                    : { status: 'blocked', reason: '当前没有正在编辑的子框' },
              }),
            'jiashi: split-item shortcut',
          )
          boardLog('shortcuts.registered', { id: 'jiashi.split-item' })
        } catch (error) {
          boardLog('activate.error', { step: 'shortcuts-register', error: String(error?.stack ?? error) })
        }
      }),
    'jiashi: shortcuts',
  )
}

export const inject = ['slots', 'locale']
