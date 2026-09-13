// 全屏那张图上，键盘能干的每一件事。
//
// 单独列一张表有两个用处：一是弹层里照着它渲染，二是以后加了新键不会忘记补进
// 帮助里——表就是这一份，没有第二处。触屏那一列不进弹层：手机上没有键盘，列出
// 来只是占地方。

export interface Shortcut {
  key: string
  action: string
}

export const SHORTCUT_TITLE = '全屏快捷键'

export const SHORTCUTS: readonly Shortcut[] = [
  { key: '拖拽 / Shift+滚轮 / ← →', action: '平移' },
  { key: '滚轮 / + −', action: '缩放' },
  { key: '0 / Home', action: '回锚定段' },
  { key: 'End', action: '到最新' },
  { key: 'Shift+Home', action: '到上市' },
  { key: 'G', action: '跳到日期' },
  { key: '1–9', action: '选条上第几个周期' },
  { key: 'A', action: '周期自动' },
  { key: 'M', action: '十字线吸附' },
  { key: 'Shift+拖', action: '测量' },
  { key: 'Alt+点', action: '钉价位线' },
  { key: 'I', action: '指标' },
  { key: 'V', action: '成交量' },
  { key: 'O', action: '截图轮廓' },
  { key: 'F', action: '全屏' },
  { key: 'Esc', action: '退出全屏' },
]

/** 弹层里的一行：`键 · 动作`。 */
export function shortcutLine(item: Shortcut): string {
  return `${item.key} · ${item.action}`
}

/** 弹层里那 16 行（标题另外单独一条，不挂在第 0 行上）。 */
export function shortcutItems(): { label: string; value: string }[] {
  return SHORTCUTS.map((item, i) => ({ label: shortcutLine(item), value: `__key${i}` }))
}
