/**
 * demo.ts — 开发测试用示例注入（?demo=1 时生效；?demo=1&reset=1 强制重建）
 *
 * 复杂拓扑（测试注意力模式空间地图 / 方位恒定 / 连线）：
 *
 *                    [上游A 需求文档]  [上游B 会议纪要]
 *                            \            /
 *    [旁支 灵感收集]━━同对话━━[★主笔记]
 *                          /    |    \
 *              [子1 设计方案][子2 进度追踪][子3 风险清单]
 *                  |             |            |
 *              [孙1 设计初稿][孙3 周报][孙2 风险应对]
 *
 *                 [独立笔记]（无箭头无对话，右下远角）
 * 全部带箭头连接（旁支与主笔记仅同对话无箭头）；主笔记与上游/子/孙同对话
 */
import { Editor, TLShapeId, createShapeId } from 'tldraw'
import { MixedItem, deriveTextBlockProps } from './shapes/TextBlockShapeUtil'

const DEMO_CONV = 'demo-conv-1'

function makeUserItem(text: string): MixedItem {
  return { kind: 'user', id: createShapeId(), text }
}

interface Spec {
  id: TLShapeId
  x: number
  y: number
  w: number
  h: number
  title: string
  text: string
  conv?: boolean
}

export function injectDemoShapes(editor: Editor) {
  const mk = (s: Spec) => {
    // 兼容字段（content / richText / userTextFragments / aiResponses）统一从 items 派生，
    // 不再手写 —— 手写容易出现「改了 items 忘了改 content」的静默不一致。
    const items = [makeUserItem(s.text)]
    editor.createShape({
      id: s.id,
      type: 'text-block',
      x: s.x,
      y: s.y,
      props: {
        title: s.title,
        items,
        ...deriveTextBlockProps(items),
        conversationId: s.conv ? DEMO_CONV : undefined,
        w: s.w,
        h: s.h,
      },
    })
  }

  const mainId = createShapeId()
  const upAId = createShapeId()
  const upBId = createShapeId()
  const child1Id = createShapeId()
  const child2Id = createShapeId()
  const child3Id = createShapeId()
  const grand1Id = createShapeId()
  const grand2Id = createShapeId()
  const grand3Id = createShapeId()
  const sideId = createShapeId()
  const indepId = createShapeId()

  editor.batch(() => {
    // ── 主笔记（中央） ──
    mk({
      id: mainId, x: -340, y: 40, w: 680, h: 340, title: '主笔记', conv: true,
      text: '## 项目主线\n\n这是整张图的中心。\n选中我按 Alt+T，四周会浮现：\n左侧上游、右侧下游的关联框。\n\n拖拽空白平移，滚轮缩放。',
    })

    // ── 上游（左侧，两条线指向主笔记） ──
    mk({
      id: upAId, x: -1520, y: -330, w: 680, h: 200, title: '上游A · 需求文档', conv: true,
      text: '产品需求 V3\n- 移动端适配\n- 离线优先',
    })
    mk({
      id: upBId, x: -1520, y: 300, w: 680, h: 200, title: '上游B · 会议纪要', conv: true,
      text: '0924 评审会\n确认技术选型与排期。',
    })

    // ── 直接子节点（下方三列） ──
    mk({
      id: child1Id, x: -1180, y: 800, w: 640, h: 200, title: '子1 · 设计方案', conv: true,
      text: '整体架构草图\n- 模块划分\n- 数据流',
    })
    mk({
      id: child2Id, x: -320, y: 800, w: 640, h: 200, title: '子2 · 进度追踪', conv: true,
      text: '里程碑\n1. 原型 ✅\n2. 联调 🔜',
    })
    mk({
      id: child3Id, x: 540, y: 800, w: 640, h: 200, title: '子3 · 风险清单', conv: true,
      text: '风险登记\n- 依赖版本锁定\n- 权限模型待评审',
    })

    // ── 孙节点（二级分支） ──
    mk({
      id: grand1Id, x: -1180, y: 1500, w: 640, h: 200, title: '孙1 · 设计初稿', conv: true,
      text: '第一版线框图与交互说明。',
    })
    mk({
      id: grand2Id, x: 540, y: 1500, w: 640, h: 200, title: '孙2 · 风险应对', conv: true,
      text: '应对预案：\n- 灰度发布\n- 回滚方案',
    })
    mk({
      id: grand3Id, x: -320, y: 1500, w: 640, h: 200, title: '孙3 · 周报', conv: true,
      text: '本周进展汇总与下周计划。',
    })

    // ── 旁支：同对话但无箭头（conv 关联测试） ──
    mk({
      id: sideId, x: -1600, y: -950, w: 620, h: 180, title: '旁支 · 灵感收集', conv: true,
      text: '随手记的想法，和主笔记同对话但没画箭头。',
    })

    // ── 独立笔记：无对话无箭头 ──
    mk({
      id: indepId, x: 1700, y: -650, w: 620, h: 180, title: '独立笔记',
      text: '没接任何线、不在对话里。\n它的注意力模式四周应该是空的。',
    })

    // ── 箭头：上游 → 主 → 子 → 孙 ──
    const arrow = (fromId: TLShapeId, toId: TLShapeId) => {
      const arrowId = createShapeId()
      editor.createShape({ id: arrowId, type: 'arrow', x: 0, y: 0 })
      editor.createBindings([
        {
          type: 'arrow',
          fromId: arrowId,
          toId: fromId,
          props: { terminal: 'start', isPrecise: false, normalizedAnchor: { x: 0.5, y: 1 } },
        },
        {
          type: 'arrow',
          fromId: arrowId,
          toId,
          props: { terminal: 'end', isPrecise: false, normalizedAnchor: { x: 0.5, y: 0 } },
        },
      ])
    }
    arrow(upAId, mainId)
    arrow(upBId, mainId)
    arrow(mainId, child1Id)
    arrow(mainId, child2Id)
    arrow(mainId, child3Id)
    arrow(child1Id, grand1Id)
    arrow(child3Id, grand2Id)
    arrow(child2Id, grand3Id)

    // 注入后默认选中主笔记，方便直接 Alt+T
    editor.select(mainId)
  })

  // 等布局就绪后把相机对准全部示例（避免画布视角停在别处显得"乱七八糟"）
  setTimeout(() => {
    try {
      editor.zoomToFit()
    } catch { /* 相机已在路上 */ }
  }, 120)
}
