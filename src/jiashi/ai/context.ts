// ── AI Context: collect upstream text-block content via arrow connections ──

import { Editor, TLArrowShape, TLShape } from 'tldraw'
import { TextBlockShape } from '../shapes/TextBlockShapeUtil'

/**
 * Collect all upstream text-block content for a given shape.
 *
 * Traces backwards along arrow connections (who points TO me?)
 * and builds a context chain from root to leaf.
 *
 * Example:  A ──→ B ──→ C (editing C)
 *           Returns: [{ id: 'A', title: ..., content: ... }, { id: 'B', ... }]
 */
export function collectUpstreamContext(
  editor: Editor,
  shapeId: string,
): Array<{ id: string; content: string }> {
  const allShapes = editor.getCurrentPageShapes()
  const arrowShapes = allShapes.filter(
    (s): s is TLArrowShape => s.type === 'arrow'
  )
  const textBlocks = new Map<string, TextBlockShape>()
  for (const s of allShapes) {
    if (s.type === 'text-block') {
      textBlocks.set(s.id, s as TextBlockShape)
    }
  }

  // Build a quick lookup: shapeId → set of shapeIds that point TO it
  const incomingMap = new Map<string, string[]>()
  for (const arrow of arrowShapes) {
    // TLArrowShape.props.start/end are VecModel at type level,
    // but at runtime they contain boundShapeId when the arrow is bound.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const start = arrow.props.start as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const end = arrow.props.end as any
    const toId: string | undefined = end.boundShapeId
    const fromId: string | undefined = start.boundShapeId
    if (toId && fromId) {
      const list = incomingMap.get(toId) ?? []
      list.push(fromId)
      incomingMap.set(toId, list)
    }
  }

  // BFS backwards: collect all upstream text blocks
  const visited = new Set<string>()
  const queue = [shapeId]
  const upstream: Array<{ id: string; content: string }> = []

  while (queue.length > 0) {
    const currentId = queue.shift()!
    const parents = incomingMap.get(currentId) ?? []
    for (const parentId of parents) {
      if (visited.has(parentId)) continue
      visited.add(parentId)

      const shape = textBlocks.get(parentId)
      if (shape) {
        const rawContent = shape.props.content ?? ''
        upstream.push({ id: parentId, content: rawContent })
        queue.push(parentId) // continue tracing upstream
      }
    }
  }

  // Reverse so root (earliest ancestor) comes first
  upstream.reverse()
  return upstream
}

/** Build a formatted context string from upstream nodes for the system prompt. */
export function buildContextPrompt(
  upstreamNodes: Array<{ id: string; content: string }>,
): string | undefined {
  if (upstreamNodes.length === 0) return undefined

  const parts = upstreamNodes.map((node, i) => {
    const label = `上游节点 ${i + 1}:`
    const trimmed = node.content.trim().slice(0, 800) // cap per-node to avoid token bloat
    return `${label}\n${trimmed}`
  })

  return [
    '以下是与当前文本框通过箭头关联的上游内容，请基于这些上下文生成内容：',
    '',
    ...parts,
    '',
    '请基于以上上下文，回应用户的提示词。',
  ].join('\n')
}
