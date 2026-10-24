/**
 * DSH 会话桥（架势画布 ↔ DSH session）。
 *
 * 画布上的"对话卡"通过 conversationId 存 DSH sessionId（形如 `session-…`）。
 * 这里负责：
 * - 对 ctx.sessions.retain 做引用计数（同一会话多张卡共享一个 binding）；
 * - 暴露 isDshSessionId 区分"DSH 会话"和架势自己的本地对话 id（UUID）；
 * - 通过宿主同源路由新建会话（不依赖客户端 Remote 的 inject）。
 */

export interface SessionEntry {
  binding: unknown
  face: any
  eventSource: any
}

interface CacheEntry {
  ref: any
  refCount: number
  promise: Promise<SessionEntry>
}

export const sessionRuntime: { ctx: any; bridge: any } = { ctx: null, bridge: null }

/** DSH 的 sessionId 形如 `session-<uuid>`；本地对话是 crypto.randomUUID()。 */
export function isDshSessionId(id?: string): id is string {
  return typeof id === 'string' && id.startsWith('session-')
}

/**
 * 表示"一直显示到最新"的结束 seq 哨兵。
 * 为什么不用 undefined：合并回尾巴卡时需要用 updateShape 把旧的 sessionToSeq 覆盖掉，
 * 而 tldraw 的 props 局部更新对 undefined 的处理不可靠，用一个大数更稳。
 */
export const SESSION_TAIL_SEQ = Number.MAX_SAFE_INTEGER

/** 从一张卡的结束 seq 推出下一张续接卡的起始 seq；尾巴卡返回 undefined（子卡也从最新开始）。 */
export function nextSeqAfter(toSeq?: number): number | undefined {
  if (toSeq === undefined || toSeq >= SESSION_TAIL_SEQ) return undefined
  return toSeq + 1
}

/** 诊断日志走插件入口挂到 window 上的钩子。 */
export function sessionLog(event: string, data?: unknown): void {
  try {
    ;(window as unknown as { __jiashiDebugLog?: (event: string, data: unknown) => void }).__jiashiDebugLog?.(
      event,
      data ?? {},
    )
  } catch {
    /* ignore */
  }
}

export function createSessionBridge(ctx: any) {
  const cache = new Map<string, CacheEntry>()

  function sessionsService(): any {
    try {
      const viaGet = ctx.get?.('sessions')
      if (viaGet !== undefined) return viaGet
    } catch {
      /* fall through */
    }
    try {
      return ctx.sessions
    } catch {
      return undefined
    }
  }

  function acquire(sessionId: string): Promise<SessionEntry> {
    let entry = cache.get(sessionId)
    if (entry === undefined) {
      let ref: any
      try {
        const sessions = sessionsService()
        if (sessions === undefined || typeof sessions.retain !== 'function') {
          throw new Error('sessions service unavailable')
        }
        ref = sessions.retain(sessionId, { source: 'jiashi-board' })
      } catch (error) {
        sessionLog('bridge.error', { sessionId, error: String((error as Error)?.message ?? error) })
        return Promise.reject(error)
      }
      entry = {
        ref,
        refCount: 0,
        promise: ref.ready.then(
          (binding: any) => ({
            binding,
            face: binding.session,
            eventSource: binding.eventSource,
          }),
          (error: unknown) => {
            cache.delete(sessionId)
            try {
              ref.release()
            } catch {
              /* already released */
            }
            sessionLog('bridge.open-failed', {
              sessionId,
              error: String((error as Error)?.message ?? error),
            })
            throw error
          },
        ),
      }
      cache.set(sessionId, entry)
    }
    entry.refCount += 1
    return entry.promise
  }

  function release(sessionId: string): void {
    const entry = cache.get(sessionId)
    if (entry === undefined) return
    entry.refCount -= 1
    if (entry.refCount > 0) return
    cache.delete(sessionId)
    try {
      entry.ref.release()
    } catch {
      /* already released */
    }
  }

  return { acquire, release }
}

/** 插件入口激活时调用一次。 */
export function configureSessionRuntime(ctx: any): void {
  sessionRuntime.ctx = ctx
  sessionRuntime.bridge = createSessionBridge(ctx)
}

/** 通过宿主同源路由新建一条 DSH 会话，返回 sessionId。 */
export async function createDshSessionId(): Promise<string> {
  const url = new URL('jiashi/api/session/create', document.baseURI).href
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const data = await response.json().catch(() => null)
  if (data === null || data.ok !== true || typeof data.sessionId !== 'string') {
    throw new Error(String(data?.error?.message ?? '创建 DSH 会话失败'))
  }
  sessionLog('session.create-ok', { sessionId: data.sessionId })
  return data.sessionId
}
