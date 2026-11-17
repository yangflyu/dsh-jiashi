/**
 * Code-level self test (no mouse, no screenshots).
 *
 * Host side: GET /jiashi/api/selftest returns { run, seq, ... } from
 * $DSH_HOME/jiashi/selftest.json (or the static web/selftest.json fallback).
 * When the trigger key changes we open the canvas panel via layout.selectPanel
 * and run DOM assertions / synthetic events, then POST the report to
 * /jiashi/api/log as event "selftest.report".
 *
 * Dormant by default: it only polls a small JSON file.
 */

const POLL_MS = 2000
const PANEL_KEY = 'jiashi'

let started = false
let lastKey = ''
let busy = false
let triggerUndo = 0
let triggerCleanup = false

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function triggerUrl() {
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
    /* ignore */
  }
}

async function pollOnce(onRun) {
  try {
    const res = await fetch(triggerUrl(), { cache: 'no-store' })
    if (!res.ok) return
    const data = await res.json()
    const run = String(data?.run ?? '')
    const seq = String(data?.seq ?? '')
    const key = seq !== '' ? `seq:${seq}` : run !== '' ? `run:${run}` : ''
    triggerUndo = Number(data?.undo ?? 0) || 0
    triggerCleanup = data?.cleanupIndependent === true
    if (key !== '' && key !== lastKey) {
      lastKey = key
      await onRun(key)
    }
  } catch {
    /* ignore */
  }
}

function waitFor(cond, timeout = 4000) {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      let v = null
      try {
        v = cond()
      } catch {
        v = null
      }
      if (v) return resolve(v)
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

function fire(el, types = ['pointerdown', 'mousedown', 'mouseup', 'click']) {
  if (!el) return false
  for (const type of types) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  }
  return true
}

function clickOnly(el) {
  if (!el) return false
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  return true
}

function contextMenu(el) {
  if (!el) return false
  const rect = el.getBoundingClientRect()
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    }),
  )
  return true
}

function findButton(text) {
  const buttons = Array.from(document.querySelectorAll('button'))
  return (
    buttons.find((node) => (node.textContent ?? '').trim() === text) ??
    buttons.find((node) => (node.textContent ?? '').includes(text)) ??
    null
  )
}

async function deleteThreadBlock(block) {
  // Prefer the x button in the block header (exact, no native menu involved).
  const del = block.querySelector('.jiashi-thread-block-del')
  if (del) {
    clickOnly(del)
    await sleep(450)
    if (!document.body.contains(block)) return { ok: true, via: 'button' }
  }
  contextMenu(block.querySelector('.jiashi-thread-block-head') ?? block)
  await sleep(400)
  const item = findButton('鍒犻櫎姝ゅ璇濆潡')
  if (!item) return { ok: false, reason: 'menu-not-found' }
  item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  item.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
  await sleep(650)
  return { ok: !document.body.contains(block), via: 'menu' }
}

function pressUndo(times) {
  for (let i = 0; i < times; i += 1) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }))
  }
}

function boardRoot() {
  return document.querySelector('.tl-canvas') ?? document.querySelector('[data-jiashi-board]') ?? null
}

function cardsOf(root) {
  return Array.from(root?.querySelectorAll('.tb-wrapper') ?? [])
}

async function ensurePanelOpen(ctx) {
  if (typeof ctx?.layout?.selectPanel === 'function') {
    try {
      ctx.layout.selectPanel(PANEL_KEY)
    } catch {
      /* ignore */
    }
  }
  await waitFor(() => document.querySelector('.tl-canvas'), 5000)
  await sleep(900)
}

async function runSuite(ctx, key) {
  const steps = []
  const push = (name, ok, extra = {}) => {
    steps.push({ name, ok: Boolean(ok), ...extra })
    return ok
  }
  try {
    await ensurePanelOpen(ctx)

    if (triggerUndo > 0) {
      const before = document.querySelectorAll('.jiashi-thread-block').length
      pressUndo(triggerUndo)
      await sleep(900)
      const after = document.querySelectorAll('.jiashi-thread-block').length
      push('undo-recovery', after < before, { before, after, times: triggerUndo })
      triggerUndo = 0
    }

    const root = boardRoot()
    if (!push('panel-mount', root !== null)) throw new Error('panel not mounted')

    if (triggerCleanup) {
      triggerCleanup = false
      const indep = Array.from(root.querySelectorAll('.jiashi-thread-block')).filter((el) =>
        (el.querySelector('.jiashi-thread-block-sub')?.textContent ?? '').includes('鐙珛浼氳瘽'),
      )
      let removed = 0
      for (const block of indep) {
        const result = await deleteThreadBlock(block)
        if (result.ok) removed += 1
      }
      push('cleanup-independent-blocks', removed === indep.length, { removed, total: indep.length })
    }

    const cards = cardsOf(root)
    push('card-count', cards.length > 0, { count: cards.length })

    const initialBlocks = new Set(root.querySelectorAll('.jiashi-thread-block'))
    push('thread-block-render', initialBlocks.size > 0, { count: initialBlocks.size })

    const preview = cards.map((c) => c.querySelector('.textblock-preview')).find(Boolean)
    if (preview) {
      const rect = preview.getBoundingClientRect()
      preview.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + 24,
        }),
      )
      const wrapper = await waitFor(() => root.querySelector('.textblock-editor-wrapper'), 2000)
      push('enter-edit-mode', wrapper !== null)
    } else {
      push('enter-edit-mode', false, { reason: 'no-preview-card' })
    }

    const addBtn = await waitFor(() => root.querySelector('.jiashi-add-thread-btn'), 1500)
    const rect = addBtn?.getBoundingClientRect()
    push(
      'add-thread-button',
      Boolean(addBtn) && visible(addBtn) && Boolean(rect) && rect.top >= 0 && rect.bottom <= window.innerHeight,
      { rect: rect ? [Math.round(rect.left), Math.round(rect.top)] : null },
    )

    const beforeAdd = root.querySelectorAll('.jiashi-thread-block').length
    if (addBtn) {
      fire(addBtn)
      await sleep(1500)
      const afterAdd = root.querySelectorAll('.jiashi-thread-block').length
      push('add-thread-click', afterAdd === beforeAdd + 1, { before: beforeAdd, after: afterAdd })
    } else {
      push('add-thread-click', false, { reason: 'no-button' })
    }

    const slot = root.querySelector('[title^="鍦ㄦ鎻掑叆鑷枃鏈?]')
    if (slot) {
      slot.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      slot.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
      const insertBtn = await waitFor(() => root.querySelector('.jiashi-insert-thread-btn'), 1200)
      push('insert-slot-thread-button', Boolean(insertBtn) && visible(insertBtn))
      if (insertBtn) {
        const before = root.querySelectorAll('.jiashi-thread-block').length
        fire(insertBtn)
        await sleep(1500)
        const after = root.querySelectorAll('.jiashi-thread-block').length
        push('insert-slot-click', after === before + 1, { before, after })
      }
    } else {
      push('insert-slot-thread-button', false, { reason: 'no-slot' })
    }

    const blocks = Array.from(root.querySelectorAll('.jiashi-thread-block'))
    const last = blocks[blocks.length - 1]
    if (last) {
      const before = blocks.length
      const deletion = await deleteThreadBlock(last)
      const after = root.querySelectorAll('.jiashi-thread-block').length
      push('delete-thread-block', deletion.ok && after === before - 1, { before, after, via: deletion.via ?? null })
    } else {
      push('delete-thread-block', false, { reason: 'no-block' })
    }

    const soleCard = cardsOf(root).find((card) => card.querySelectorAll('.jiashi-thread-block').length === 1)
    if (soleCard) {
      const cardRect = soleCard.getBoundingClientRect()
      const input = soleCard.querySelector('.ai-input-field')
      const inputRect = input?.getBoundingClientRect()
      const gap = inputRect ? Math.round(cardRect.bottom - inputRect.bottom) : null
      push('sole-thread-input-bottom', gap !== null && gap >= -2 && gap <= 40, {
        gap,
        card: [Math.round(cardRect.top), Math.round(cardRect.height)],
        input: inputRect ? [Math.round(inputRect.top), Math.round(inputRect.height)] : null,
      })
    } else {
      push('sole-thread-input-bottom', false, { reason: 'no-sole-card' })
    }

    const extra = Array.from(root.querySelectorAll('.jiashi-thread-block')).filter((el) => !initialBlocks.has(el))
    let cleaned = 0
    for (const block of extra) {
      const result = await deleteThreadBlock(block)
      if (result.ok) cleaned += 1
    }
    if (extra.length > 0) {
      push('cleanup-test-blocks', cleaned === extra.length, { cleaned, total: extra.length })
    }

    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    } catch {
      /* ignore */
    }
    await sleep(250)

    return { key, version: 'selftest-2', ok: steps.every((step) => step.ok), steps }
  } catch (error) {
    return { key, version: 'selftest-2', ok: false, steps, error: String(error?.message ?? error) }
  }
}

export function startSelfTest(ctx) {
  if (started) return
  if (window.__jiashiSelftestV4) return
  window.__jiashiSelftestV4 = true
  started = true
  const loop = async () => {
    if (busy) return
    await pollOnce(async (key) => {
      busy = true
      try {
        const result = await runSuite(ctx, key)
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

