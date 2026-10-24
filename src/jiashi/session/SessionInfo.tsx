/**
 * SessionInfo — 把 DSH 会话列表（标题）通过 React Context 提供给画布内部的组件。
 *
 * 画布里的文本块/对话卡是 tldraw 形状里的 React 组件，拿不到主面板的 standard props；
 * 所以由插件入口（Board）调用 useSessions，把"按 sessionId 查标题"的能力放进 context。
 */
import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'

export interface SessionInfoValue {
  /** 会话标题：优先 durable title，其次 displayTitle；未知返回 undefined。 */
  titleOf: (sessionId: string) => string | undefined
}

const EMPTY_SESSION_INFO: SessionInfoValue = { titleOf: () => undefined }

export const SessionInfoContext = createContext<SessionInfoValue>(EMPTY_SESSION_INFO)

/** 会话标题变化的订阅：只要 useSessions 更新，context 值就更新。 */
export function SessionInfoProvider({
  useSessions,
  children,
}: {
  useSessions?: (selector: (state: unknown) => unknown) => unknown
  children: ReactNode
}) {
  const state = useSessions === undefined ? undefined : useSessions((snapshot: unknown) => snapshot)
  const value = useMemo<SessionInfoValue>(() => {
    const byId = (state as { byId?: Record<string, { title?: string; displayTitle?: string }> } | undefined)?.byId
    if (byId === undefined) return EMPTY_SESSION_INFO
    return {
      titleOf: (sessionId: string) => {
        const row = byId[sessionId]
        if (row === undefined) return undefined
        const title = typeof row.title === 'string' ? row.title.trim() : ''
        if (title !== '') return title
        const display = typeof row.displayTitle === 'string' ? row.displayTitle.trim() : ''
        return display === '' ? undefined : display
      },
    }
  }, [state])
  return <SessionInfoContext.Provider value={value}>{children}</SessionInfoContext.Provider>
}

/** 某个 DSH 会话的显示标题；没有/未知时返回 undefined。 */
export function useSessionTitle(sessionId?: string): string | undefined {
  const info = useContext(SessionInfoContext)
  if (sessionId === undefined || sessionId === '') return undefined
  return info.titleOf(sessionId)
}
