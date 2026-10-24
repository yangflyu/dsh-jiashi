/**
 * Custom keyboard shortcut storage and matching logic.
 *
 * Shortcut format (compatible with tldraw's kbd):
 *   "$z"     → Ctrl/Cmd + Z
 *   "!a"     → Shift + A
 *   "?s"     → Alt + S
 *   "$!d"    → Ctrl/Cmd + Shift + D
 *   "Delete" → plain key
 *   "ArrowUp"→ arrow keys
 *
 * Persistence: SQLite (via Tauri plugin) when running in Tauri webview,
 * localStorage as fallback in browser dev mode.
 */

import { loadShortcuts, saveShortcut as dbSaveShortcut, resetAllShortcuts as dbResetAll, initDatabase } from '../db'

export interface ShortcutDescriptor {
  key: string       // normalized key name (lowercase for letters)
  ctrlCmd: boolean
  shift: boolean
  alt: boolean
}

/** All custom shortcut overrides: actionId → kbdString */
export async function getCustomShortcuts(): Promise<Record<string, string>> {
  await initDatabase()
  return loadShortcuts()
}

/** Set a custom shortcut for an action. Pass empty string to remove. */
export async function setCustomShortcut(actionId: string, kbd: string): Promise<void> {
  await initDatabase()
  await dbSaveShortcut(actionId, kbd)
}

/** Reset all custom shortcuts */
export async function resetAllShortcuts(): Promise<void> {
  await initDatabase()
  await dbResetAll()
}

/** Build a map of actionId → resolved kbd (custom overrides fallback to default) */
export async function resolveShortcuts(
  defaults: Record<string, string | undefined>
): Promise<Record<string, string>> {
  const customs = await getCustomShortcuts()
  const resolved: Record<string, string> = {}
  for (const [id, defaultKbd] of Object.entries(defaults)) {
    resolved[id] = customs[id] ?? defaultKbd ?? ''
  }
  return resolved
}

/**
 * Parse a kbd string into a ShortcutDescriptor.
 * Only handles the primary combo (ignores comma-separated alternatives).
 */
export function kbdToDescriptor(kbd: string): ShortcutDescriptor | null {
  if (!kbd) return null
  // Take the first alternative before any comma
  const raw = kbd.split(',')[0].trim()
  if (!raw) return null

  let ctrlCmd = false
  let shift = false
  let alt = false
  let remaining = raw

  // Detect legacy symbols: $ = cmd, ! = shift, ? = alt
  if (remaining.includes('$')) { ctrlCmd = true; remaining = remaining.replace('$', '') }
  if (remaining.includes('!')) { shift = true; remaining = remaining.replace('!', '') }
  if (remaining.includes('?')) { alt = true; remaining = remaining.replace('?', '') }

  // Normalize key name
  let key = remaining.toLowerCase()
  // Common normalization
  const keyMap: Record<string, string> = {
    'del': 'delete',
    'backspace': 'backspace',
    'esc': 'escape',
    'enter': 'enter',
    'return': 'enter',
    'space': ' ',
    'up': 'arrowup',
    'down': 'arrowdown',
    'left': 'arrowleft',
    'right': 'arrowright',
  }
  key = keyMap[key] ?? key

  return { key, ctrlCmd, shift, alt }
}

/** Convert a KeyboardEvent into a ShortcutDescriptor */
export function eventToDescriptor(e: KeyboardEvent): ShortcutDescriptor {
  let key = e.key.toLowerCase()
  // Normalize: some keyboards report "Meta" etc
  if (key === 'meta' || key === 'control' || key === 'alt' || key === 'shift') {
    return { key: '', ctrlCmd: false, shift: false, alt: false }
  }
  // Normalize specific keys
  const keyMap: Record<string, string> = {
    'del': 'delete',
    ' ': ' ',
  }
  key = keyMap[key] ?? key

  return {
    key,
    ctrlCmd: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
  }
}

/** Check if two descriptors match (for the purpose of triggering a shortcut) */
export function descriptorsMatch(a: ShortcutDescriptor, b: ShortcutDescriptor): boolean {
  return a.key === b.key
    && a.ctrlCmd === b.ctrlCmd
    && a.shift === b.shift
    && a.alt === b.alt
}

/**
 * Format a ShortcutDescriptor into a human-readable string like "Ctrl+Z", "Shift+A".
 */
export function formatDescriptor(d: ShortcutDescriptor): string {
  const parts: string[] = []
  if (d.ctrlCmd) parts.push('Ctrl')
  if (d.alt) parts.push('Alt')
  if (d.shift) parts.push('Shift')
  // Capitalize single letters
  const displayKey = d.key.length === 1 ? d.key.toUpperCase() : d.key
  parts.push(displayKey)
  return parts.join('+')
}

/**
 * Format a kbd string to human-readable form.
 * Handles legacy symbols: $ = Ctrl, ! = Shift, ? = Alt
 */
export function formatKbd(kbd: string): string {
  if (!kbd) return '—'
  const desc = kbdToDescriptor(kbd)
  if (!desc) return kbd
  return formatDescriptor(desc)
}
