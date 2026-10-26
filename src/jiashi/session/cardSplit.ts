/**
 * 子框拆分（把光标所在的一个子框拆成两个子框，仍在同一张卡里）——当前编辑器的动作登记处。
 *
 * 由块编辑器在编辑态注册一个"在这里拆子框"的回调；
 * DSH 快捷键命令（client 入口注册的 jiashi.split-item）只负责调用它。
 */
export type SplitHandler = () => void

let activeHandler: SplitHandler | undefined

/** 注册当前可用的拆子框动作；返回注销函数。 */
export function setActiveSplitHandler(handler: SplitHandler | undefined): () => void {
  activeHandler = handler
  return () => {
    if (activeHandler === handler) activeHandler = undefined
  }
}

/** 现在有没有可拆的子框（正在编辑某张卡的文本块）。 */
export function hasActiveSplit(): boolean {
  return activeHandler !== undefined
}

/** 执行拆子框；没有注册的动作时返回 false。 */
export function runActiveSplit(): boolean {
  if (activeHandler === undefined) return false
  activeHandler()
  return true
}
