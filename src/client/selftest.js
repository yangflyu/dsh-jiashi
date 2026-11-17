/**
 * 架势插件·代码级自测（不碰鼠标、不截图）。
 *
 * 宿主侧约定：
 *   GET  /jiashi/api/selftest         → { run: "<触发 id>" }，来自 $DSH_HOME/jiashi/selftest.json
 *   POST /jiashi/api/selftest         → 上报测试报告（宿主写 selftest-report.json + board.log）
 *
 * 客户端在这里轮询触发文件；收到新 id 时：用 layout.selectPanel('jiashi') 打开画布面板，
 * 然后直接在 DOM 上做断言 / 派发事件，把结果上报。默认待机，不做任何事。
 */

const POLL_MS = 2000
const PANEL_KEY = 'jiashi'

let started = false
let lastRun = ''
let busy = false
let triggerUndo = 0
let triggerCleanup = false

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function triggerUrl() {
  // 触发文件放在插件静态目录 web/ 下（webServer 直接静态服务，不需要 Host 重新加载）
  const url = new URL('jiashi/selftest.json', document.baseURI)
  url.searchParams.set('t', String(Date.now()))
  return url.href
}

async function report(payload) {
  try {
    await fetch(new URL('jiashi/api/log', document.baseURI).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'selftest.report', data: payload, time: new Date().toISOString() }),
      keepalive: true,
    })
  } catch {
    /* 上报失败不影响画布 */
  }
}

async function pollOnce(onRun) {
  try {
    const res = await fetch(triggerUrl(), { cache: 'no-store' })
    if (!res.ok) return
    const data = await res.json()
    const run = String(data?.run ?? '')
    triggerUndo = Number(data?.undo ?? 0) || 0
    triggerCleanup = data?.cleanupIndependent === true
    if (run !== '' && run !== lastRun) {
      lastRun = run
      await onRun(run)
    }
  } catch {
    /* 触发文件不存在/格式不对时安静重试 */
  }
}

function waitFor(cond, timeout = 4000) {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      let value = null
      try {
        value = cond()
      } catch {
        value = null
      }
      if (value) return resolve(value)
      if (Date.now() - start > timeout) return resolve(null)
      setTimeout(tick, 60)
    }
    tick()
  })
}

function visible(el) {
  if (!el) return false
  const rect = el.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return false
  const style = getComputedStyle(el)
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0.05
}

function clickEl(el) {
  if (!el) return false
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return true
}

function contextMenu(el) {
  if (!el) return false
  const rect = el.getBoundingClientRect()
  el.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }))
  return true
}

function findMenuItem(text) {
  const buttons = Array.from(document.querySelectorAll('button'))
  const exact = buttons.find((node) => (node.textContent ?? '').trim() === text)
  if (exact) return exact
  const loose = buttons.find((node) => (node.textContent ?? '').includes(text))
  if (loose) return loose
  const others = Array.from(document.querySelectorAll('[role="menuitem"], div'))
  return others.find((node) => {
    const own = (node.textContent ?? '').trim()
    return own === text || (own.includes(text) && own.length <= text.length + 12)
  })
}

function clickOnly(el) {
  if (!el) return false
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return true
}

async function deleteThreadBlock(root, block) {
  contextMenu(block.querySelector('.jiashi-thread-block-head') ?? block)
  await sleep(400)
  const item = findMenuItem('删除此对话块')
  if (!item) return { ok: false, reason: 'menu-not-found' }
  // 菜单项的 handler 绑在 onMouseDown 上；只派发 mousedown/mouseup（合成 pointerdown 会先被别处处理掉）
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  item.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
  await sleep(700)
  return { ok: !document.body.contains(block) }
}

function pressUndo(times) {
  for (let i = 0; i < times; i += 1) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }))
  }
}

async function ensurePanelOpen(ctx) {
  const layout = ctx?.layout
  if (typeof layout?.selectPanel === 'function') {
    try {
      layout.selectPanel(PANEL_KEY)
    } catch {
      /* ignore */
    }
  }
  await waitFor(() => document.querySelector('.tl-canvas'), 5000)
  await sleep(900)
}

function boardRoot() {
  return document.querySelector('[data-jiashi-board]') ?? document.querySelector('.tl-canvas')
}

function cardEls(root) {
  return Array.from(root?.querySelectorAll('.tb-wrapper') ?? [])
}

async function runSuite(ctx, runId) {
  const steps = []
  const push = (name, ok, extra = {}) => {
    steps.push({ name, ok: Boolean(ok), ...extra })
    return ok
  }
  try {
    await ensurePanelOpen(ctx)
    // 可选：先按若干次 Ctrl+Z 清理上一轮测试遗留的块
    if (triggerUndo > 0) {
      const before = document.querySelectorAll('.jiashi-thread-block').length
      pressUndo(triggerUndo)
      await sleep(900)
      const after = document.querySelectorAll('.jiashi-thread-block').length
      push('undo-recovery', after < before, { before, after, times: triggerUndo })
      triggerUndo = 0
    }
    const root = boardRoot()
    if (!push('panel-mount', root !== null)) throw new Error('画布面板没有挂载')

    // 可选：清理测试期间产生的「独立会话」对话块（只删这些，主会话块保留）
    if (triggerCleanup) {
      triggerCleanup = false
      const indep = Array.from(root.querySelectorAll('.jiashi-thread-block')).filter((el) =>
        (el.querySelector('.jiashi-thread-block-sub')?.textContent ?? '').includes('独立会话'),
      )
      let removed = 0
      for (const block of indep) {
        const result = await deleteThreadBlock(root, block)
        if (result.ok) removed += 1
      }
      push('cleanup-independent-blocks', removed === indep.length, { removed, total: indep.length })
    }

    const cards = cardEls(root)
    push('card-count', cards.length > 0, { count: cards.length })
    const threadBlocks = Array.from(root.querySelectorAll('.jiashi-thread-block'))
    const initialBlocks = new Set(threadBlocks)
    push('thread-block-render', threadBlocks.length > 0, {
      count: threadBlocks.length,
      headers: threadBlocks.slice(0, 4).map((el) => el.textContent?.slice(0, 24) ?? ''),
    })

    // ── 1) 进入编辑态：双击一张预览卡 ──
    const preview = cards.map((card) => card.querySelector('.textblock-preview')).find(Boolean)
    if (preview) {
      const rect = preview.getBoundingClientRect()
      preview.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + 20,
      }))
      const wrapper = await waitFor(() => root.querySelector('.textblock-editor-wrapper'), 2000)
      push('enter-edit-mode', wrapper !== null)
    } else {
      push('enter-edit-mode', false, { reason: 'no-preview-card' })
    }

    // ── 2) 卡内「＋ 对话块」按钮存在且可见 ──
    const addBtn = await waitFor(() => root.querySelector('.jiashi-add-thread-btn'), 1500)
    if (addBtn) {
      const rect = addBtn.getBoundingClientRect()
      const editor = root.querySelector('.textblock-editor-wrapper')
      const editorRect = editor?.getBoundingClientRect()
      push('add-thread-button', visible(addBtn), {
        rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
        insideCard: editorRect
          ? rect.top >= editorRect.top && rect.bottom <= editorRect.bottom + 2
          : null,
      })
    } else {
      push('add-thread-button', false, { reason: 'not-found' })
    }

    // ── 3) 点击「＋ 对话块」→ 新建并渲染 ──
    const before = root.querySelectorAll('.jiashi-thread-block').length
    if (addBtn && visible(addBtn)) {
      clickEl(addBtn)
      await sleep(1400)
      const after = root.querySelectorAll('.jiashi-thread-block').length
      push('add-thread-click', after === before + 1, { before, after })
    } else {
      push('add-thread-click', false, { reason: 'button-not-visible' })
    }

    // ── 4) 插入槽 hover → 「＋对话」按钮 ──
    const slot = root.querySelector('[title^="在此插入自文本"]')
    if (slot) {
      slot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      slot.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
      const insertBtn = await waitFor(() => root.querySelector('.jiashi-insert-thread-btn'), 1200)
      push('insert-slot-thread-button', insertBtn !== null && visible(insertBtn))
      if (insertBtn && visible(insertBtn)) {
        const beforeInsert = root.querySelectorAll('.jiashi-thread-block').length
        clickEl(insertBtn)
        await sleep(1400)
        const afterInsert = root.querySelectorAll('.jiashi-thread-block').length
        push('insert-slot-click', afterInsert === beforeInsert + 1, { before: beforeInsert, after: afterInsert })
      }
    } else {
      push('insert-slot-thread-button', false, { reason: 'no-insert-slot' })
    }

    // ── 5) 右键删除对话块 ──
    const blocks = Array.from(root.querySelectorAll('.jiashi-thread-block'))
    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock) {
      const beforeDelete = blocks.length
      const deletion = await deleteThreadBlock(root, lastBlock)
      const afterDelete = root.querySelectorAll('.jiashi-thread-block').length
      push('delete-thread-block', deletion.ok && afterDelete === beforeDelete - 1, {
        before: beforeDelete,
        after: afterDelete,
        reason: deletion.reason ?? null,
      })
    } else {
      push('delete-thread-block', false, { reason: 'no-thread-block' })
    }

    // ── 6) 布局：单对话块卡片里输入框贴近卡片底部 ──
    const soleCard = cardEls(root).find((card) => {
      const blocksInCard = card.querySelectorAll('.jiashi-thread-block')
      return blocksInCard.length === 1
    })
    if (soleCard) {
      const cardRect = soleCard.getBoundingClientRect()
      const input = soleCard.querySelector('.ai-input-field')
      const inputRect = input?.getBoundingClientRect()
      const content = soleCard.querySelector('.textblock-content')
      const thread = soleCard.querySelector('.jiashi-session-thread')
      const messages = soleCard.querySelector('.jiashi-session-messages')
      const rectInfo = (el) => {
        const r = el?.getBoundingClientRect()
        return r ? [Math.round(r.top), Math.round(r.height)] : null
      }
      const gap = inputRect ? Math.round(cardRect.bottom - inputRect.bottom) : null
      push('sole-thread-input-bottom', gap !== null && gap >= -2 && gap <= 40, {
        gap,
        card: rectInfo(soleCard),
        content: rectInfo(content),
        thread: rectInfo(thread),
        messages: rectInfo(messages),
        input: rectInfo(input),
        cardClasses: String(soleCard.className ?? ''),
      })
    } else {
      push('sole-thread-input-bottom', false, { reason: 'no-sole-thread-card' })
    }

    // 清理：只删掉本次测试新增的对话块，原有内容不动
    const extraBlocks = Array.from(root.querySelectorAll('.jiashi-thread-block')).filter(
      (el) => !initialBlocks.has(el),
    )
    let cleaned = 0
    for (const block of extraBlocks) {
      const result = await deleteThreadBlock(root, block)
      if (result.ok) cleaned += 1
    }
    if (extraBlocks.length > 0) {
      push('cleanup-test-blocks', cleaned === extraBlocks.length, { cleaned, total: extraBlocks.length })
    }

    // 退出编辑态，尽量把画布恢复原样
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    } catch {
      /* ignore */
    }
    await sleep(300)

    return { run: runId, version: 'selftest-1', ok: steps.every((step) => step.ok), steps }
  } catch (error) {
    return { run: runId, version: 'selftest-1', ok: false, steps, error: String(error?.message ?? error) }
  }
}

export function startSelfTest(ctx) {
  if (started) return
  if (window.__jiashiSelftestStarted) return
  window.__jiashiSelftestStarted = true
  started = true
  window.__jiashiDebugLog?.('selftest.start', {
    hasLayout: typeof ctx?.layout?.selectPanel === 'function',
    href: String(document.baseURI),
  })
  const loop = async () => {
    if (busy) return
    await pollOnce(async (runId) => {
      busy = true
      window.__jiashiDebugLog?.('selftest.run', { run: runId })
      try {
        const result = await runSuite(ctx, runId)
        await report(result)
      } finally {
        busy = false
      }
    })
  }
  void loop()
  setInterval(() => {
    void loop()
  }, POLL_MS)
}
