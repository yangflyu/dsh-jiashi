/**
 * Database adapter: dual-mode SQLite / localStorage
 *
 * - Inside Tauri webview: uses @tauri-apps/plugin-sql → SQLite
 * - Browser dev mode: falls back to localStorage
 *
 * The API is identical regardless of backend.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface Conversation {
  id: string
  label: string
  messages: Message[]
  createdAt: number
}

// ── Backend detection ──────────────────────────────────────────────

let sqliteAvailable = false

async function detectBackend(): Promise<void> {
  try {
    // Only import in Tauri context
    const { default: Database } = await import('@tauri-apps/plugin-sql')
    const db = await Database.load('sqlite:framework.db')
    await db.close()
    sqliteAvailable = true
  } catch {
    sqliteAvailable = false
  }
}

// ── SQLite helpers ─────────────────────────────────────────────────

async function sqliteExec(sql: string, params?: any[]): Promise<void> {
  const { default: Database } = await import('@tauri-apps/plugin-sql')
  const db = await Database.load('sqlite:framework.db')
  await db.execute(sql, params ?? [])
}

async function sqliteSelect<T>(sql: string, params?: any[]): Promise<T[]> {
  const { default: Database } = await import('@tauri-apps/plugin-sql')
  const db = await Database.load('sqlite:framework.db')
  return db.select<T[]>(sql, params ?? [])
}

async function initSqliteTables(): Promise<void> {
  await sqliteExec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)
  await sqliteExec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  await sqliteExec(`
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `)
  await sqliteExec(`
    CREATE TABLE IF NOT EXISTS shortcuts (
      action_id TEXT PRIMARY KEY,
      kbd       TEXT NOT NULL
    )
  `)
}

// ── Settings ───────────────────────────────────────────────────────

export async function loadSetting(key: string): Promise<string | null> {
  await detectBackend()
  if (sqliteAvailable) {
    const rows = await sqliteSelect<{ value: string }>(
      'SELECT value FROM settings WHERE key = ?', [key]
    )
    return rows.length > 0 ? rows[0].value : null
  }
  return localStorage.getItem(key)
}

export async function saveSetting(key: string, value: string): Promise<void> {
  await detectBackend()
  if (sqliteAvailable) {
    await sqliteExec(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      [key, value]
    )
    return
  }
  localStorage.setItem(key, value)
}

export async function deleteSetting(key: string): Promise<void> {
  await detectBackend()
  if (sqliteAvailable) {
    await sqliteExec('DELETE FROM settings WHERE key = ?', [key])
    return
  }
  localStorage.removeItem(key)
}

/** Load a JSON-parsed setting with fallback */
export async function loadJSONSetting<T>(key: string, defaults: T): Promise<T> {
  const raw = await loadSetting(key)
  if (!raw) return defaults
  try {
    return { ...defaults, ...JSON.parse(raw) }
  } catch {
    return defaults
  }
}

/** Save a value as a JSON setting */
export async function saveJSONSetting(key: string, value: unknown): Promise<void> {
  await saveSetting(key, JSON.stringify(value))
}

// ── Conversations ──────────────────────────────────────────────────

const CONV_KEY = 'framework-conversations'

export async function loadConversations(): Promise<Conversation[]> {
  await detectBackend()
  if (sqliteAvailable) {
    const convRows = await sqliteSelect<{ id: string; label: string; created_at: number }>(
      'SELECT id, label, created_at FROM conversations ORDER BY created_at DESC'
    )
    const result: Conversation[] = []
    for (const c of convRows) {
      const msgRows = await sqliteSelect<{ role: string; content: string }>(
        'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC',
        [c.id]
      )
      result.push({
        id: c.id,
        label: c.label,
        createdAt: c.created_at,
        messages: msgRows.map(m => ({
          role: m.role as Message['role'],
          content: m.content,
        })),
      })
    }
    return result
  }
  // localStorage fallback
  try {
    const raw = localStorage.getItem(CONV_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export async function saveConversation(conv: Conversation): Promise<void> {
  await detectBackend()
  if (sqliteAvailable) {
    // Upsert conversation
    await sqliteExec(
      'INSERT OR REPLACE INTO conversations (id, label, created_at) VALUES (?, ?, ?)',
      [conv.id, conv.label, conv.createdAt]
    )
    // Replace messages: delete old + insert new
    await sqliteExec('DELETE FROM messages WHERE conversation_id = ?', [conv.id])
    for (const msg of conv.messages) {
      await sqliteExec(
        'INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)',
        [conv.id, msg.role, msg.content]
      )
    }
    return
  }
  // localStorage fallback: reload store, update, persist
  const all = await loadConversations()
  const idx = all.findIndex(c => c.id === conv.id)
  if (idx >= 0) all[idx] = conv
  else all.push(conv)
  localStorage.setItem(CONV_KEY, JSON.stringify(all))
}

export async function deleteConversation(id: string): Promise<void> {
  await detectBackend()
  if (sqliteAvailable) {
    await sqliteExec('DELETE FROM messages WHERE conversation_id = ?', [id])
    await sqliteExec('DELETE FROM conversations WHERE id = ?', [id])
    return
  }
  const all = await loadConversations()
  localStorage.setItem(CONV_KEY, JSON.stringify(all.filter(c => c.id !== id)))
}

// ── Shortcuts ──────────────────────────────────────────────────────

const SHORTCUT_KEY = 'framework-keyboard-shortcuts'

export async function loadShortcuts(): Promise<Record<string, string>> {
  await detectBackend()
  if (sqliteAvailable) {
    const rows = await sqliteSelect<{ action_id: string; kbd: string }>(
      'SELECT action_id, kbd FROM shortcuts'
    )
    const map: Record<string, string> = {}
    for (const r of rows) map[r.action_id] = r.kbd
    return map
  }
  try {
    const raw = localStorage.getItem(SHORTCUT_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export async function saveShortcut(actionId: string, kbd: string): Promise<void> {
  await detectBackend()
  if (sqliteAvailable) {
    if (kbd) {
      await sqliteExec(
        'INSERT OR REPLACE INTO shortcuts (action_id, kbd) VALUES (?, ?)',
        [actionId, kbd]
      )
    } else {
      await sqliteExec('DELETE FROM shortcuts WHERE action_id = ?', [actionId])
    }
    return
  }
  const all = await loadShortcuts()
  if (kbd) all[actionId] = kbd
  else delete all[actionId]
  localStorage.setItem(SHORTCUT_KEY, JSON.stringify(all))
}

export async function resetAllShortcuts(): Promise<void> {
  await detectBackend()
  if (sqliteAvailable) {
    await sqliteExec('DELETE FROM shortcuts')
    return
  }
  localStorage.removeItem(SHORTCUT_KEY)
}

// ── Initialization ─────────────────────────────────────────────────

let initialized = false

/** Call once at app startup. Creates tables if needed. */
export async function initDatabase(): Promise<void> {
  if (initialized) return
  await detectBackend()
  if (sqliteAvailable) {
    await initSqliteTables()
  }
  initialized = true
}
