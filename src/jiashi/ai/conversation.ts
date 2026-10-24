// ── AI Conversation: persistent multi-turn chat sessions ──
//
// Each conversation has a full messages[] array (system/user/assistant),
// enabling true multi-turn AI interactions with conversation memory.
//
// Text blocks belong to a conversation via their `conversationId` prop.
// Downstream text blocks (connected by arrow) inherit the conversation ID.
//
// Persistence: SQLite (via Tauri plugin) when running in Tauri webview,
// localStorage as fallback in browser dev mode.

import {
  initDatabase,
  loadConversations,
  saveConversation,
  deleteConversation as dbDeleteConversation,
} from '../db'
import type { Message, Conversation } from '../db'

export type { Message, Conversation }

// ── In-memory store ──────────────────────────────────────────────────

let store: Map<string, Conversation> | null = null
let _ready = false

/** Initialize the in-memory store from the database. Safe to call multiple times. */
async function initStore(): Promise<void> {
  if (_ready) return
  await initDatabase()
  const convs = await loadConversations()
  store = new Map()
  for (const c of convs) store.set(c.id, c)
  _ready = true
}

function getStore(): Map<string, Conversation> {
  if (!store) store = new Map()
  return store
}

/** Ensure the store is loaded (async, but safe to call multiple times). */
async function ensureReady(): Promise<void> {
  if (!_ready) await initStore()
}

/** Persist a single conversation to the database. */
async function persistOne(id: string): Promise<void> {
  const conv = getStore().get(id)
  if (conv) await saveConversation(conv)
}

/** Persist all conversations to the database. */
async function persistAll(): Promise<void> {
  for (const conv of getStore().values()) {
    await saveConversation(conv)
  }
}

// ── Public API ────────────────────────────────────────────────────────

/** Get a conversation by ID. Returns undefined if not found.
 *  Must be called after ensureReady() or from a React component
 *  (the in-memory store is loaded on first async access). */
export function getConversation(id: string): Conversation | undefined {
  return getStore().get(id)
}

/** Load a conversation (waits for store init if needed). */
export async function getConversationAsync(id: string): Promise<Conversation | undefined> {
  await ensureReady()
  return getStore().get(id)
}

/** Create a new conversation and persist it. */
export async function createConversation(label?: string): Promise<Conversation> {
  await ensureReady()
  const conv: Conversation = {
    id: crypto.randomUUID(),
    label: label ?? `对话 ${getStore().size + 1}`,
    messages: [],
    createdAt: Date.now(),
  }
  getStore().set(conv.id, conv)
  await persistOne(conv.id)
  return conv
}

/** Add a message to a conversation. Returns the updated conversation. */
export async function addMessage(
  conversationId: string,
  message: Message,
): Promise<Conversation | undefined> {
  await ensureReady()
  const conv = getStore().get(conversationId)
  if (!conv) return undefined
  conv.messages.push(message)
  await persistOne(conversationId)
  return conv
}

/** Build the messages array for an API call:
 *  1. System prompt with all text block contents in this conversation
 *  2. Full conversation history
 *  3. The new user message
 */
export function buildMessages(
  conversationId: string,
  userPrompt: string,
  textBlockContents: string[],
): Message[] {
  const conv = getStore().get(conversationId)
  const history = conv?.messages ?? []

  const parts: string[] = []

  // Context: all text block contents in this conversation
  if (textBlockContents.length > 0) {
    parts.push('你正在一个知识画布对话中。以下是与当前对话关联的所有文本框内容：')
    for (let i = 0; i < textBlockContents.length; i++) {
      const trimmed = textBlockContents[i].trim().slice(0, 800)
      if (trimmed) parts.push(`[文本框 ${i + 1}]:\n${trimmed}`)
    }
    parts.push('请参考以上内容，回应用户的消息。')
  }

  const systemContent = parts.join('\n\n')

  const result: Message[] = []
  if (systemContent) {
    result.push({ role: 'system', content: systemContent })
  }

  // Append full conversation history
  for (const msg of history) {
    result.push(msg)
  }

  // Append new user message
  result.push({ role: 'user', content: userPrompt })

  return result
}

/** Delete a conversation. Does NOT clear shape conversationId props. */
export async function deleteConversation(id: string): Promise<void> {
  await ensureReady()
  getStore().delete(id)
  await dbDeleteConversation(id)
}

/** List all conversations (most recent first).
 *  Must call ensureReady() first or use from a component setup. */
export function listConversations(): Conversation[] {
  return Array.from(getStore().values()).sort((a, b) => b.createdAt - a.createdAt)
}

/** Get a display label for a conversation by ID. */
export function getConversationLabel(id: string): string {
  return getStore().get(id)?.label ?? '对话'
}

/** Auto-inherit conversationId from incoming arrow sources.
 *  Returns the first found conversationId from any upstream text block,
 *  or undefined if none exists. */
export function inheritableConversationId(
  incomingSourceIds: string[],
  getConversationId: (shapeId: string) => string | undefined,
): string | undefined {
  for (const id of incomingSourceIds) {
    const cid = getConversationId(id)
    if (cid) return cid
  }
  return undefined
}

/** Initialize the store. Call at app startup. */
export { initStore }
