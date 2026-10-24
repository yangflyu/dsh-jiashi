/**
 * ShortcutEditor — an overlay panel that lists all actions/tools
 * and lets the user remap their keyboard shortcuts.
 *
 * UX:
 * - Each row shows: label + current shortcut (or "—" if none)
 * - Click a shortcut to enter "recording" mode
 * - Press the desired key combination → shortcut updates
 * - "重置" button restores all shortcuts to defaults
 * - "关闭" closes the panel
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { Editor, TLUiEventSource } from 'tldraw'
import {
  getCustomShortcuts,
  setCustomShortcut,
  resetAllShortcuts,
  resolveShortcuts,
  eventToDescriptor,
  formatKbd,
} from './shortcuts'
import type { ShortcutDescriptor } from './shortcuts'
import { getZhLabel } from './zhLabels'

interface ActionLike {
  id: string
  kbd?: string
  label?: string | { [key: string]: string }
  onSelect: (source: TLUiEventSource) => void
}

interface Props {
  open: boolean
  onClose: () => void
  actions: Record<string, ActionLike>
  editor: Editor | null
}

export function ShortcutEditor({ open, onClose, actions, editor }: Props) {
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [resolved, setResolved] = useState<Record<string, string>>({})
  const [customMap, setCustomMap] = useState<Record<string, string>>({})

  // Build the default kbd map from actions
  const defaultKbdMap = useMemo(() => {
    const map: Record<string, string | undefined> = {}
    for (const [id, action] of Object.entries(actions)) {
      map[id] = action.kbd
    }
    return map
  }, [actions])

  // Load resolved shortcuts when panel opens or after changes
  const refresh = useCallback(() => {
    getCustomShortcuts().then(customs => {
      setCustomMap(customs)
      return resolveShortcuts(defaultKbdMap)
    }).then(setResolved)
  }, [defaultKbdMap])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  // Listen for keypress when recording
  useEffect(() => {
    if (!recordingId || !open) return

    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()

      const desc = eventToDescriptor(e)
      // Ignore bare modifier keys
      if (!desc.key || desc.key === 'meta' || desc.key === 'control' || desc.key === 'alt' || desc.key === 'shift') {
        return
      }

      const kbd = descriptorToKbdString(desc)
      setCustomShortcut(recordingId, kbd).then(() => {
        setRecordingId(null)
        refresh()
      })
    }

    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [recordingId, open, refresh])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (recordingId) {
          setRecordingId(null)
        } else {
          onClose()
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, recordingId, onClose])

  const handleReset = useCallback(() => {
    resetAllShortcuts().then(refresh)
  }, [refresh])

  // Group actions for better organization (MUST be before early return)
  const entries = useMemo(() => {
    return Object.entries(actions)
      .filter(([id]) => {
        return !id.startsWith('__') && id !== 'asset'
      })
      .sort(([, a], [, b]) => {
        const labelA = getActionLabel(a)
        const labelB = getActionLabel(b)
        return labelA.localeCompare(labelB)
      })
  }, [actions])

  if (!open) return null

  return (
    <div className="kbs-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="kbs-panel">
        <div className="kbs-header">
          <h2 className="kbs-title">自定义快捷键</h2>
          <div className="kbs-header-actions">
            <button className="kbs-btn kbs-btn-reset" onClick={handleReset}>
              恢复默认
            </button>
            <button className="kbs-btn kbs-btn-close" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        <div className="kbs-hint">
          点击快捷键 → 按下新的按键组合 → 立即生效。按 Esc 取消录制。
        </div>

        <div className="kbs-list">
          {entries.map(([id, action]) => (
            <ShortcutRow
              key={id}
              actionId={id}
              action={action}
              currentKbd={resolved[id] || ''}
              isRecording={recordingId === id}
              isCustom={!!customMap[id]}
              onStartRecord={() => setRecordingId(id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function ShortcutRow({
  actionId,
  action,
  currentKbd,
  isRecording,
  isCustom,
  onStartRecord,
}: {
  actionId: string
  action: ActionLike
  currentKbd: string
  isRecording: boolean
  isCustom: boolean
  onStartRecord: () => void
}) {
  const label = getActionLabel(action)
  const display = currentKbd ? formatKbd(currentKbd) : '—'

  return (
    <div className={`kbs-row ${isCustom ? 'kbs-row-custom' : ''}`}>
      <span className="kbs-row-label" title={actionId}>
        {label}
      </span>
      <button
        className={`kbs-row-kbd ${isRecording ? 'kbs-row-recording' : ''}`}
        onClick={onStartRecord}
        title={isRecording ? '请按下新的快捷键…' : '点击修改快捷键'}
      >
        {isRecording ? '按下新快捷键…' : display}
        {isCustom && !isRecording && <span className="kbs-row-modified" title="已修改">*</span>}
      </button>
    </div>
  )
}

/** Get a Chinese label for an action, falling back to the original */
function getActionLabel(action: ActionLike): string {
  // First find the original label
  let original = action.id
  if (action.label) {
    if (typeof action.label === 'string') {
      original = action.label
    } else {
      original = action.label['default'] || action.label['menu'] || action.id
    }
  }
  // Try Chinese translation, fall back to original
  return getZhLabel(action.id, original)
}

/** Convert ShortcutDescriptor back to kbd string */
function descriptorToKbdString(desc: ShortcutDescriptor): string {
  let kbd = ''
  if (desc.ctrlCmd) kbd += '$'
  if (desc.shift) kbd += '!'
  if (desc.alt) kbd += '?'
  // Uppercase single letters for consistency with tldraw
  kbd += desc.key.length === 1 ? desc.key.toUpperCase() : desc.key
  return kbd
}
