/**
 * 卡片拆分（从光标处拆成两张卡）——当前编辑器的动作登记处。
 *
 * 由块编辑器在编辑态注册一个"在这里拆卡"的回调；
 * DSH 快捷键命令（client 入口注册的 jiashi.split-card）只负责调用它。
 */
export type CardSplitHandler = () => void

let activeHandler: CardSplitHandler | undefined

/** 注册当前可用的拆卡动作；返回注销函数。 */
export function setActiveCardSplitHandler(handler: CardSplitHandler | undefined): () => void {
  activeHandler = handler
  return () => {
    if (activeHandler === handler) activeHandler = undefined
  }
}

/** 现在有没有可拆的卡片（正在编辑某张卡的文本块）。 */
export function hasActiveCardSplit(): boolean {
  return activeHandler !== undefined
}

/** 执行拆卡；没有注册的动作时返回 false。 */
export function runActiveCardSplit(): boolean {
  if (activeHandler === undefined) return false
  activeHandler()
  return true
}
