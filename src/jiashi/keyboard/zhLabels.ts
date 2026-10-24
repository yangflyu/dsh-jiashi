/**
 * Chinese translation map for tldraw action/tool IDs.
 * Used by ShortcutEditor to display user-friendly Chinese labels.
 */

const zhLabels: Record<string, string> = {
  // ── Tools ──
  'select': '选择',
  'hand': '手形工具',
  'eraser': '橡皮擦',
  'draw': '画笔',
  'arrow': '箭头',
  'line': '直线',
  'frame': '画框',
  'text': '文本',
  'asset': '资源',
  'note': '便签',
  'laser': '激光笔',
  'embed': '嵌入',
  'highlight': '高亮',
  'zoom': '缩放工具',
  'geo': '形状',

  // ── Geo shapes ──
  'rectangle': '矩形',
  'ellipse': '椭圆',
  'diamond': '菱形',
  'triangle': '三角形',
  'star': '星形',
  'pentagon': '五边形',
  'hexagon': '六边形',
  'octagon': '八边形',
  'cloud': '云朵',
  'heart': '爱心',
  'trapezoid': '梯形',
  'rhombus': '菱形2',
  'rhombus-2': '菱形3',
  'oval': '椭圆2',
  'x-box': '叉号框',
  'check-box': '勾选框',
  'arrow-down': '下箭头',
  'arrow-left': '左箭头',
  'arrow-right': '右箭头',
  'arrow-up': '上箭头',

  // ── Edit ──
  'undo': '撤销',
  'redo': '重做',
  'cut': '剪切',
  'copy': '复制',
  'paste': '粘贴',
  'duplicate': '复制一份',
  'delete': '删除',
  'select-all': '全选',
  'select-none': '取消选择',
  'group': '组合',
  'ungroup': '取消组合',
  'lock': '锁定',
  'unlock': '解锁',
  'toggle-lock': '切换锁定',
  'unlock-all': '全部解锁',

  // ── Arrange ──
  'bring-to-front': '移到顶层',
  'bring-forward': '上移一层',
  'send-backward': '下移一层',
  'send-to-back': '移到底层',

  // ── Align ──
  'align-left': '左对齐',
  'align-center-horizontal': '水平居中',
  'align-right': '右对齐',
  'align-top': '顶部对齐',
  'align-center-vertical': '垂直居中',
  'align-bottom': '底部对齐',
  'distribute-horizontal': '水平分布',
  'distribute-vertical': '垂直分布',
  'stretch-horizontal': '水平拉伸',
  'stretch-vertical': '垂直拉伸',
  'pack': '紧凑排列',
  'stack-horizontal': '水平堆叠',
  'stack-vertical': '垂直堆叠',

  // ── Flip / Rotate ──
  'flip-horizontal': '水平翻转',
  'flip-vertical': '垂直翻转',
  'rotate-cw': '顺时针旋转',
  'rotate-ccw': '逆时针旋转',

  // ── Zoom ──
  'zoom-in': '放大',
  'zoom-in-on-cursor': '光标处放大',
  'zoom-out': '缩小',
  'zoom-out-on-cursor': '光标处缩小',
  'zoom-to-100': '恢复100%',
  'zoom-to-fit': '适应屏幕',
  'zoom-to-selection': '适应选中',
  'select-zoom-tool': '缩放工具',

  // ── View ──
  'toggle-grid': '切换网格',
  'toggle-dark-mode': '切换深色模式',
  'toggle-focus-mode': '切换专注模式',
  'toggle-debug-mode': '切换调试模式',
  'toggle-snap-mode': '切换吸附',
  'toggle-wrap-mode': '切换自动换行',
  'toggle-dynamic-size-mode': '切换自适应大小',
  'toggle-paste-at-cursor': '切换粘贴到光标',
  'toggle-reduce-motion': '切换减少动画',
  'toggle-keyboard-shortcuts': '显示快捷键面板',
  'toggle-edge-scrolling': '切换边缘滚动',
  'toggle-transparent': '切换透明背景',
  'toggle-tool-lock': '切换工具锁定',
  'toggle-auto-size': '切换自动大小',

  // ── Export ──
  'export-as-svg': '导出SVG',
  'export-as-png': '导出PNG',
  'export-all-as-svg': '全部导出SVG',
  'export-all-as-png': '全部导出PNG',
  'copy-as-svg': '复制为SVG',
  'copy-as-png': '复制为PNG',
  'print': '打印',

  // ── Shapes ──
  'remove-frame': '移除画框',
  'fit-frame-to-content': '画框适应内容',
  'flatten-to-image': '扁平化为图片',
  'convert-to-bookmark': '转为书签',
  'convert-to-embed': '转为嵌入',
  'edit-link': '编辑链接',
  'insert-embed': '插入嵌入',
  'insert-media': '插入媒体',
  'open-embed-link': '打开嵌入链接',
  'open-kbd-shortcuts': '打开快捷键',

  // ── Misc ──
  'exit-pen-mode': '退出笔模式',
  'stop-following': '停止跟随',
  'back-to-content': '返回内容',
  'move-to-new-page': '移到新页面',
  'enlarge-shapes': '放大形状',
  'shrink-shapes': '缩小形状',
  'select-geo-tool': '选择形状工具',
  'select-white-color': '选白色',
  'select-fill-fill': '填充颜色',
  'adjust-shape-styles': '调整样式',

  // ── Navigation ──
  'change-page-prev': '上一页',
  'change-page-next': '下一页',

  // ── Media ──
  'image-replace': '替换图片',
  'video-replace': '替换视频',
  'download-original': '下载原文件',

  // ── Other ──
  'a11y-open-context-menu': '打开右键菜单',
  'a11y-repeat-shape-announce': '重复朗读',
  'open-cursor-chat': '打开光标聊天',
}

/** Get Chinese label for an action ID, or return the original label as fallback */
export function getZhLabel(id: string, fallback: string): string {
  return zhLabels[id] || fallback
}
