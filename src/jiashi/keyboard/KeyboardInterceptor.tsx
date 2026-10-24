/**
 * KeyboardInterceptor — capture-phase keydown listener that checks
 * custom shortcut mappings before tldraw gets the event.
 *
 * Architecture:
 * 1. On mount, load custom shortcut mappings asynchronously and cache them.
 * 2. Install a capture-phase keydown listener on the editor container.
 * 3. On each keystroke, build a ShortcutDescriptor and check against cached
 *    custom-mapped actions/tools.
 * 4. If matched → preventDefault + stopImmediatePropagation + dispatch action.
 * 5. If unmatched → let the event reach tldraw's internal handler.
 */

import { useEffect, useRef } from 'react'
import { Editor, useEditor, TLUiEventSource } from 'tldraw'
import {
  getCustomShortcuts,
  kbdToDescriptor,
  eventToDescriptor,
  descriptorsMatch,
} from './shortcuts'

/** Action-like object: has id, kbd, onSelect */
interface ActionLike {
  id: string
  kbd?: string
  onSelect: (source: TLUiEventSource) => void
}

interface Props {
  /** Map of actionId → ActionLike, including both tools and actions */
  actions: Record<string, ActionLike>
}

export function KeyboardInterceptor({ actions }: Props) {
  const editor = useEditor()
  const actionsRef = useRef(actions)
  const shortcutCacheRef = useRef<Record<string, string>>({})
  actionsRef.current = actions

  // Load custom shortcuts on mount and cache them
  useEffect(() => {
    let cancelled = false
    getCustomShortcuts().then(map => {
      if (!cancelled) shortcutCacheRef.current = map
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const container = editor.getContainer()

    const handler = (e: KeyboardEvent) => {
      // Skip when target is inside an input, textarea, or contenteditable element
      // (including TipTap editor and other text inputs)
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.closest('[contenteditable="true"]') ||
        target.closest('.ProseMirror') ||
        target.closest('.tiptap')
      ) {
        return
      }

      const currentActions = actionsRef.current
      const customMap = shortcutCacheRef.current
      const eventDesc = eventToDescriptor(e)

      // Only process modifier keys + printable keys (filter out bare modifiers)
      if (!eventDesc.key && !eventDesc.ctrlCmd && !eventDesc.alt && !eventDesc.shift) return

      for (const [actionId, customKbd] of Object.entries(customMap)) {
        if (!customKbd) continue
        const customDesc = kbdToDescriptor(customKbd)
        if (!customDesc) continue
        if (descriptorsMatch(eventDesc, customDesc)) {
          const action = currentActions[actionId]
          if (action) {
            e.preventDefault()
            e.stopPropagation()
            e.stopImmediatePropagation()
            action.onSelect('kbd')
            return
          }
        }
      }
    }

    // Capture phase: our handler runs BEFORE tldraw's internal handlers
    container.addEventListener('keydown', handler, { capture: true })
    return () => container.removeEventListener('keydown', handler, { capture: true })
  }, [editor])

  return null
}
