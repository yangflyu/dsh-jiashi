import { useEditor, useValue, TLArrowShape, renderPlaintextFromRichText } from 'tldraw'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { TextBlockShape } from '../shapes/TextBlockShapeUtil'

// ─── Types ────────────────────────────────────────────────────────────

interface TreeNode {
  shape: TextBlockShape
  index: number        // order in topological sort
  children: string[]   // shape ids of outgoing arrows
  parents: string[]    // shape ids of incoming arrows
}

interface LinearViewProps {
  onBackToCanvas: () => void
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Topological sort using Kahn's algorithm */
function topologicalSort(nodes: TreeNode[]): TreeNode[] {
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  const idToNode = new Map<string, TreeNode>()

  // Initialize
  for (const node of nodes) {
    const id = node.shape.id
    inDegree.set(id, 0)
    adjacency.set(id, [])
    idToNode.set(id, node)
  }

  // Build graph
  for (const node of nodes) {
    for (const childId of node.children) {
      if (inDegree.has(childId)) {
        inDegree.set(childId, (inDegree.get(childId) ?? 0) + 1)
        adjacency.get(node.shape.id)?.push(childId)
      }
    }
  }

  // Kahn BFS
  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  const sorted: TreeNode[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    const node = idToNode.get(id)
    if (node) sorted.push(node)

    for (const childId of adjacency.get(id) ?? []) {
      const newDeg = (inDegree.get(childId) ?? 1) - 1
      inDegree.set(childId, newDeg)
      if (newDeg === 0) queue.push(childId)
    }
  }

  // If there are remaining nodes (cycles), append them
  const remaining = nodes.filter(n => !sorted.includes(n))
  sorted.push(...remaining)

  // Assign index
  sorted.forEach((n, i) => { n.index = i })
  return sorted
}

// ─── Component ────────────────────────────────────────────────────────

export default function LinearView({ onBackToCanvas }: LinearViewProps) {
  const editor = useEditor()
  const isDarkMode = useValue('dark mode', () => editor.user.getIsDarkMode(), [editor])

  // Get all shapes from the store
  const allShapes = useValue(
    'all shapes',
    () => {
      const records = editor.store.allRecords()
      return records
        .filter((r: any) => r.typeName === 'shape')
        .map((r: any) => r)
    },
    [editor],
  )

  // Separate text-block shapes and arrow shapes
  const textBlocks: TextBlockShape[] = []
  const arrows: { id: string; fromId: string; toId: string }[] = []

  for (const shape of allShapes) {
    if (shape.type === 'text-block') {
      textBlocks.push(shape as TextBlockShape)
    } else if (shape.type === 'arrow') {
      const arrow = shape as TLArrowShape
      // TLArrowShape.props.start/end are VecModel at type level,
      // but at runtime they contain boundShapeId when bound.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fromId = (arrow.props.start as any).boundShapeId ?? ''
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toId = (arrow.props.end as any).boundShapeId ?? ''
      arrows.push({ id: shape.id, fromId, toId })
    }
  }

  // Build tree nodes from text blocks + arrows
  const nodes: TreeNode[] = textBlocks.map((shape) => {
    const children = arrows
      .filter(a => a.fromId === shape.id)
      .map(a => a.toId)
    const parents = arrows
      .filter(a => a.toId === shape.id)
      .map(a => a.fromId)
    return { shape, index: 0, children, parents }
  })

  // Topological sort
  const sortedNodes = topologicalSort(nodes)

  // ── Colors ──
  const bg = isDarkMode ? '#131318' : '#f8f9fa'
  const cardBg = isDarkMode ? '#1e1e2e' : '#ffffff'
  const cardBorder = isDarkMode ? '#2a2a3c' : '#d0d5dd'
  const textColor = isDarkMode ? '#cdd6f4' : '#333333'
  const accentColor = '#4f7cff'
  const connectorColor = isDarkMode ? '#3a3a5c' : '#c0c8d4'

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1000,
        background: bg,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* ── Top bar ── */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 20px',
          borderBottom: `1px solid ${isDarkMode ? '#2a2a3c' : '#e0e4ea'}`,
          background: isDarkMode ? '#1a1a2e' : '#ffffff',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{
            fontSize: '16px',
            fontWeight: 700,
            color: textColor,
          }}>
            架示 Framework — 线性视图
          </span>
          <span style={{
            fontSize: '12px',
            color: isDarkMode ? '#6c7086' : '#999',
          }}>
            {sortedNodes.length} 个节点
          </span>
        </div>
        <button
          onClick={onBackToCanvas}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 16px',
            background: accentColor,
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          切换到画布模式
        </button>
      </div>

      {/* ── Content area ── */}
      <div
        className="linear-view-scroll"
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '30px 0 60px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        {sortedNodes.length === 0 ? (
          <div style={{
            marginTop: '120px',
            textAlign: 'center',
            color: isDarkMode ? '#6c7086' : '#999',
          }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
              style={{ marginBottom: '16px', opacity: 0.4 }}
            >
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <line x1="8" y1="9" x2="16" y2="9" />
              <line x1="8" y1="13" x2="13" y2="13" />
              <line x1="8" y1="17" x2="11" y2="17" />
            </svg>
            <p style={{ fontSize: '15px', margin: '0 0 8px' }}>画布中还没有文本方框</p>
            <p style={{ fontSize: '13px', margin: 0 }}>
              回到画布模式添加一些文本方框，并用箭头连接它们
            </p>
          </div>
        ) : (
          <div style={{
            width: '100%',
            maxWidth: '680px',
            display: 'flex',
            flexDirection: 'column',
            gap: '0px',
          }}>
            {sortedNodes.map((node, i) => {
              const hasConnector = i < sortedNodes.length - 1
              const nextNode = hasConnector ? sortedNodes[i + 1] : null
              const isConnected = nextNode && node.children.includes(nextNode.shape.id)

              return (
                <div key={node.shape.id}>
                  {/* ── Connection indicator (dot + line) ── */}
                  {i > 0 && (
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      padding: '0 20px',
                    }}>
                      <div style={{
                        width: isConnected ? '3px' : '2px',
                        height: '28px',
                        background: isConnected ? accentColor : connectorColor,
                        borderRadius: '2px',
                        opacity: isConnected ? 0.8 : 0.4,
                      }} />
                      {isConnected && (
                        <div style={{
                          marginTop: '-6px',
                          fontSize: '18px',
                          color: accentColor,
                          lineHeight: 1,
                        }}>
                          ▼
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Node card ── */}
                  <div
                    id={`linear-node-${node.shape.id}`}
                    style={{
                      background: cardBg,
                      border: `1.5px solid ${cardBorder}`,
                      borderRadius: '12px',
                      padding: '16px 24px',
                      color: textColor,
                      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
                      transition: 'border-color 0.2s',
                    }}
                  >
                    {/* Node index badge */}
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      marginBottom: '10px',
                    }}>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '22px',
                        height: '22px',
                        borderRadius: '50%',
                        background: isDarkMode ? '#313244' : '#eef1f6',
                        color: isDarkMode ? '#a6adc8' : '#666',
                        fontSize: '11px',
                        fontWeight: 600,
                      }}>
                        {i + 1}
                      </span>
                      {node.parents.length > 0 && (
                        <span style={{
                          fontSize: '11px',
                          color: isDarkMode ? '#6c7086' : '#999',
                        }}>
                          {node.parents.length} 个来源
                        </span>
                      )}
                      {node.children.length > 0 && (
                        <span style={{
                          fontSize: '11px',
                          color: isDarkMode ? '#6c7086' : '#999',
                        }}>
                          → {node.children.length} 个去向
                        </span>
                      )}
                    </div>

                    {/* Rendered Markdown content */}
                    <div style={{
                      fontSize: '14px',
                      lineHeight: 1.75,
                    }}>
                      {(() => {
                        const markdown = (node.shape as any).props?.content
                          || renderPlaintextFromRichText(editor, node.shape.props.richText)
                        if (!markdown.trim()) {
                          return (
                            <span style={{ opacity: 0.4, fontStyle: 'italic' }}>
                              (空文本框)
                            </span>
                          )
                        }
                        return (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex]}
                            components={{
                              h1: ({ children }: any) => (
                                <h1 style={{ fontSize: '1.3em', margin: '0.5em 0 0.3em', fontWeight: 700, borderBottom: `1px solid ${isDarkMode ? '#2a2a3c' : '#eee'}`, paddingBottom: '0.2em' }}>
                                  {children}
                                </h1>
                              ),
                              h2: ({ children }: any) => (
                                <h2 style={{ fontSize: '1.15em', margin: '0.4em 0 0.2em', fontWeight: 600 }}>
                                  {children}
                                </h2>
                              ),
                              h3: ({ children }: any) => (
                                <h3 style={{ fontSize: '1.05em', margin: '0.3em 0 0.2em', fontWeight: 600 }}>
                                  {children}
                                </h3>
                              ),
                              p: ({ children }: any) => <p style={{ margin: '0.25em 0' }}>{children}</p>,
                              ul: ({ children }: any) => <ul style={{ paddingLeft: '1.4em', margin: '0.3em 0' }}>{children}</ul>,
                              ol: ({ children }: any) => <ol style={{ paddingLeft: '1.4em', margin: '0.3em 0' }}>{children}</ol>,
                              blockquote: ({ children }: any) => (
                                <blockquote style={{
                                  borderLeft: `3px solid ${accentColor}`,
                                  paddingLeft: '12px',
                                  margin: '6px 0',
                                  opacity: 0.8,
                                }}>
                                  {children}
                                </blockquote>
                              ),
                            }}
                          >
                            {markdown}
                          </ReactMarkdown>
                        )
                      })()}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
