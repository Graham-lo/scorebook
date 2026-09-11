// The shapes a screen takes when it has nothing, is waiting, or has something
// to say. Every one of them keeps the layout it will have when full, so a
// page never jumps as data arrives.

import { append, h, type Child } from './dom'
import { icon } from './icons'

// 空态就留白：一行标题、一句说明，需要动作再给一颗按钮。不摆占位插画——
// 一个大图标既说不清这里为什么空，也让页面看起来像还没做完。
export function empty(options: {
  title: string
  tip?: string
  action?: HTMLElement | null
}): HTMLElement {
  return h(
    'div.empty',
    {},
    h('div.h3', { text: options.title }),
    options.tip ? h('div.tip', { text: options.tip }) : null,
    options.action ? h('div', { style: 'margin-top:14px' }, options.action) : null,
  )
}

/** Placeholder rows shaped like the ledger, so the page does not reflow. */
export function ledgerSkeleton(rows = 5): HTMLElement {
  const list = h('div.ledger.loading')
  for (let i = 0; i < rows; i += 1) {
    list.appendChild(
      h(
        'div.lrow.skeleton',
        {},
        h('div.date', {}, h('span.sk', { style: 'width:22px;height:22px' })),
        h('div.thumb.sk'),
        h(
          'div.body',
          {},
          h('div.sk.line', { style: 'width:32%' }),
          h('div.sk.line', { style: 'width:76%' }),
        ),
        h('div.side', {}, h('div.sk.line', { style: 'width:54px' })),
      ),
    )
  }
  return list
}

export function note(kind: 'info' | 'warn', ...children: Child[]): HTMLElement {
  const body = h('div')
  append(body, children)
  return h('div', { class: ['note', kind === 'warn' ? 'warn' : ''] }, icon(kind === 'warn' ? 'info' : 'info'), body)
}

export function actions(...children: Child[]): HTMLElement {
  const row = h('div.acts')
  append(row, children)
  return row
}

/** A labelled bar, used for queue progress and index preparation. */
export function progressLine(label: string, ratio: number): HTMLElement {
  const width = Math.max(0, Math.min(1, ratio)) * 100
  return h(
    'div.progress-line',
    {},
    h('span', { text: label }),
    h('span.bar', {}, h('i', { style: `width:${width}%` })),
  )
}

export function spinner(label: string): HTMLElement {
  return h('div.sync', {}, h('i'), h('span', { text: label }))
}

/** Used wherever the backend has the data but the feature is not open yet. */
export function unavailable(title: string, why: string): HTMLElement {
  return h(
    'div.sheet.pad',
    {},
    empty({ title, tip: why }),
  )
}

/**
 * 收起来的那一段。技术口径、内部预算、比法版本这些东西该有——检索出了偏差时
 * 它们是唯一能查的证据——但它们不该挡在动作前面。所以放进这里：标题一行说清
 * 里面是什么，点开才展开，键盘和读屏都能用。
 *
 * 注意它收的只是「解释」，不收数据缺口和检索范围——那两样任何时候都摆在外面。
 */
export function foldout(title: string, ...children: Child[]): HTMLElement {
  return fold(null, title, children)
}

/** 记过名的那几段，开着还是收着。只在这一次会话里有效，不落盘。 */
const KEPT = new Map<string, boolean>()

/**
 * 记名字的折叠区：同一个 key 的那一段被重画之后，还是原来的开合状态。
 *
 * 「按图找」那一页改一个筛选就要把整个查询栏重画一遍（上一次的结果得跟着作废），
 * 重画出来的折叠区是新的，默认收着。于是连着调两个筛选，中间要再把这一段点开
 * 一次。开合是人刚刚做的动作，不是从数据算出来的，重画不该把它抹掉。
 *
 * 只有点名要记的地方才记——不记名的 foldout 一律照旧收着进场。
 */
export function keptFoldout(key: string, title: string, ...children: Child[]): HTMLElement {
  return fold(key, title, children)
}

function fold(key: string | null, title: string, children: Child[]): HTMLElement {
  const body = h('div.fold-b')
  append(body, children)
  const wrap = h('div.fold-w', { hidden: true }, body)
  const caret = h('span.fold-c', {}, icon('chev'))
  const head = h('button.fold-h', { type: 'button', attrs: { 'aria-expanded': 'false' } }, h('span', { text: title }), caret)
  let open = false
  head.addEventListener('click', () => {
    open = !open
    if (key) KEPT.set(key, open)
    head.setAttribute('aria-expanded', String(open))
    head.classList.toggle('on', open)
    // hidden 要先撤掉才能量到高度；收起来时等动画结束再挂回去，免得读屏在中途
    // 就把它当成不存在。
    if (open) {
      wrap.hidden = false
      wrap.style.height = `${body.scrollHeight}px`
      // overflow:hidden 只在动画那 240ms 里有用——它裁的是正在长高的那一截。
      // 展开完了还留着，里面弹出来的菜单（品种选择那颗 chip）就会被齐腰切掉，
      // 所以一到位就换成 done，让它溢得出去。
      window.setTimeout(() => {
        if (!open) return
        wrap.style.height = 'auto'
        wrap.classList.add('done')
      }, 240)
    } else {
      // done 要在量高度之前先摘掉：收的那一程还得靠 overflow:hidden 裁边，
      // 手快连点两下也不会留着上一轮的 done 卡在那儿。
      wrap.classList.remove('done')
      wrap.style.height = `${body.scrollHeight}px`
      void wrap.offsetHeight
      wrap.style.height = '0px'
      window.setTimeout(() => { if (!open) wrap.hidden = true }, 240)
    }
  })
  // 重画之前它是开着的：直接以开着的样子进场，不补一遍展开动画——那不是人刚
  // 按下去的动作，只是同一段东西又画了一次。done 要一起挂上，否则里面的下拉
  // 菜单会被 overflow 齐腰切掉。
  if (key && KEPT.get(key)) {
    open = true
    head.setAttribute('aria-expanded', 'true')
    head.classList.add('on')
    wrap.hidden = false
    wrap.style.height = 'auto'
    wrap.classList.add('done')
  }
  return h('div.fold', {}, head, wrap)
}
