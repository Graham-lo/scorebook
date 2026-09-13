// 两棵 DOM 之间就地对齐：同一件东西留着原来那个节点，只改变了的那几个字。
//
// 找相似那一页每两秒读一次进度。以前每一次都是「整块清空、全部重建」：屏幕闪一
// 下、滚动位置回到原样、小 K 线全部重画。这里换成按 key 对齐——`data-key` 一样
// 的就是同一件东西，节点原样留着（事件、焦点、正在跑的动画都还在），只有真的变
// 了的属性和文字才动。没有 key 的按位置配对，标签名不一样才换节点。
//
// `data-same` 是一道免修的口令：新树上那个位置放的是个占位符，意思是「活的那一
// 个我自己已经改好了，别碰它」——小 K 线那一列就是这么保住的。
//
// 这一层只用 DOM 的那几样最基本的东西（nodeType、attributes、insertBefore），
// 不用 instanceof，所以测试里拿个手搓的假 DOM 就能跑。

const ELEMENT = 1

/** 哪些类名是活的那一头自己加的，重建的树上没有，也不许被抹掉。 */
const KEEP = ['in']

function asElement(node: Node | null): Element | null {
  return node && node.nodeType === ELEMENT ? (node as Element) : null
}

/** 同一件东西的身份：标签名 + `data-key`。没写 key 的没有身份。 */
function keyOf(node: Node): string | null {
  const el = asElement(node)
  if (!el) return null
  const key = el.getAttribute('data-key')
  return key ? `${el.tagName} ${key}` : null
}

function sameKind(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false
  const one = asElement(a)
  const two = asElement(b)
  if (!one || !two) return true
  return one.tagName === two.tagName
}

function copyClass(live: Element, value: string): void {
  const want = new Set(value.split(/\s+/).filter(Boolean))
  const had = (live.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
  for (const name of had) if (KEEP.includes(name)) want.add(name)
  const next = [...want].join(' ')
  if ((live.getAttribute('class') ?? '') !== next) live.setAttribute('class', next)
}

function copyAttrs(live: Element, next: Element): void {
  const want = next.attributes
  for (let i = 0; i < want.length; i += 1) {
    const attr = want.item(i)
    if (!attr) continue
    if (attr.name === 'class') { copyClass(live, attr.value); continue }
    if (live.getAttribute(attr.name) !== attr.value) live.setAttribute(attr.name, attr.value)
  }
  const had = live.attributes
  for (let i = had.length - 1; i >= 0; i -= 1) {
    const attr = had.item(i)
    // `class` 和 `style` 上有活的那一头自己写的东西（进场的类名、错峰的 --i），
    // 重建的树上没有不等于该抹掉。
    if (!attr || attr.name === 'class' || attr.name === 'style') continue
    if (next.getAttribute(attr.name) === null) live.removeAttribute(attr.name)
  }
}

/**
 * 把 `live` 这棵树改成 `next` 的样子。
 *
 * `next` 里的节点会被搬进 `live`，所以它用完就该扔。回来之后 `live` 里凡是
 * key 没变的那些节点，还是原来那个节点（`isSameNode` 为真）。
 */
export function morph(live: Element, next: Element): void {
  if (live === next) return
  copyAttrs(live, next)
  const pool = new Map<string, Node>()
  for (const node of Array.from(live.childNodes)) {
    const key = keyOf(node)
    if (key) pool.set(key, node)
  }
  let cursor: Node | null = live.firstChild
  for (const wanted of Array.from(next.childNodes)) {
    const key = keyOf(wanted)
    let take: Node | null = null
    if (key) {
      take = pool.get(key) ?? null
      if (take) pool.delete(key)
    } else if (cursor && !keyOf(cursor) && sameKind(cursor, wanted)) {
      take = cursor
    }
    if (!take) {
      live.insertBefore(wanted, cursor)
      continue
    }
    if (take === cursor) cursor = cursor.nextSibling
    else live.insertBefore(take, cursor)
    const one = asElement(take)
    const two = asElement(wanted)
    // 占位符说这一块活的那个已经改好了：连进去都不进去。
    if (one && two && two.getAttribute('data-same') !== null) continue
    if (one && two) morph(one, two)
    else if (take.nodeValue !== wanted.nodeValue) take.nodeValue = wanted.nodeValue
  }
  // 新树上没有的，是真没了。
  while (cursor) {
    const go: Node = cursor
    cursor = cursor.nextSibling
    live.removeChild(go)
  }
}
