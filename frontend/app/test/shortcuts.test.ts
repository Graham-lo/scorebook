import test from 'node:test'
import assert from 'node:assert/strict'

import { SHORTCUTS, SHORTCUT_TITLE, shortcutItems } from '../src/features/relive/shortcuts'

test('快捷键弹层的 19 行一条不少，标题不占用第 0 行', () => {
  const items = shortcutItems()
  assert.equal(items.length, 19)
  assert.equal(items.length, SHORTCUTS.length)
  assert.equal(items[0]?.label, '拖拽 / Shift+滚轮 / ← → · 平移')
  assert.equal(items[18]?.label, 'Esc · 退出全屏')
  assert.equal(items[0]?.value, '__key0')
  // 标题是市场视图另外 push 的一条，不能混进这 19 行里
  assert.ok(!items.some((it) => it.label === SHORTCUT_TITLE))
})
