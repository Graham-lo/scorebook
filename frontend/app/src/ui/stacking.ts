// 菜单为什么会被后面的卡片盖住：`.pop` 是 `position:absolute; z-index:50`，可它上面
// 的 `.fcard`（`animation:rise`）、`.frecog`、`.page` 计算后都带 `transform`，各自开了
// 一个层叠上下文。z-index:50 只在最近那个上下文里管用，出了 `.fcard` 就跟后面的
// `.fgroup` 比不了——`.fgroup` 按 DOM 顺序画在后面，于是压住菜单。
//
// 修法不是把菜单改成 fixed（定位逻辑依赖 absolute），而是菜单开着的这一会儿，把
// 沿途开了层叠上下文的祖先抬到同一层：`pop-host` 给 z-index，原本 static 的再补一
// 个 `pop-host-static` 让 z-index 生效。关菜单时按记下来的名单原样摘掉。
//
// 判定与打标都写成纯函数，测试里拿假节点跑，不需要浏览器。

/** 判定要用到的那几个计算样式字段。 */
export interface StyleLike {
  transform: string
  opacity: string
  filter: string
  willChange: string
  isolation: string
  position: string
  zIndex: string
  perspective?: string
  backdropFilter?: string
  mixBlendMode?: string
  contain?: string
}

/** 打标要用到的那几样节点能力。 */
export interface HostLike {
  parentElement: HostLike | null
  classList: { add(name: string): void; remove(name: string): void }
  style: { zIndex: string }
}

export const POP_HOST = 'pop-host'
export const POP_HOST_STATIC = 'pop-host-static'

/** 菜单要抬到的层号；和 CSS 里的 `.pop-host{z-index:60}` 是同一个数。 */
export const POP_HOST_Z = 60

function none(value: string | undefined): boolean {
  return !value || value === 'none' || value === 'normal' || value === 'auto'
}

/** 这个元素自己开了一个层叠上下文吗（菜单的 z-index 在它里面就出不去了）。 */
export function formsStackingContext(style: StyleLike): boolean {
  if (!none(style.transform)) return true
  if (!none(style.filter)) return true
  if (!none(style.perspective)) return true
  if (!none(style.backdropFilter)) return true
  if (style.mixBlendMode && style.mixBlendMode !== 'normal') return true
  if (style.isolation === 'isolate') return true
  if (style.opacity !== '' && Number(style.opacity) < 1) return true
  if (/transform|opacity|filter/.test(style.willChange ?? '')) return true
  if (style.contain === 'paint' || style.contain === 'layout' || style.contain === 'strict' || style.contain === 'content') return true
  if (style.position !== 'static' && style.zIndex !== 'auto') return true
  return false
}

/** 已经比菜单站得高的祖先不用动；只抬 `auto` 和比它矮的。 */
export function needsLift(style: StyleLike): boolean {
  if (style.zIndex === 'auto' || style.zIndex === '') return true
  const z = Number(style.zIndex)
  return Number.isFinite(z) && z < POP_HOST_Z
}

/** 原本是 static 的，光给 z-index 不生效，得顺手补一个 `position:relative`。 */
export function needsPosition(style: StyleLike): boolean {
  return style.position === 'static'
}

export interface PopHostMark {
  node: HostLike
  /** 这个祖先补过 `position:relative` 吗（摘的时候要一起摘）。 */
  positioned: boolean
  /** 打标前它自己的内联 z-index，关菜单时原样写回（本来没有就是空串）。 */
  zIndex: string
}

/**
 * 从 `wrap` 往上走到 `stop`（含 body 那一层就传 body 的父级），把开了层叠上下文
 * 又站得不够高的祖先打上标，返回打过标的名单。关菜单时把名单交给 `unmarkPopHosts`。
 */
export function markPopHosts(
  from: HostLike | null,
  stop: HostLike | null,
  styleOf: (node: HostLike) => StyleLike,
): PopHostMark[] {
  const marks: PopHostMark[] = []
  let node = from?.parentElement ?? null
  while (node && node !== stop) {
    const style = styleOf(node)
    if (formsStackingContext(style) && needsLift(style)) {
      const positioned = needsPosition(style)
      const zIndex = node.style.zIndex
      node.classList.add(POP_HOST)
      if (positioned) node.classList.add(POP_HOST_STATIC)
      // 光靠 class 不够：全屏那几条选择器（`.market-fullscreen .market-controls`）
      // 特异度比 `.pop-host` 高，class 写的 z-index 会被它们压回去。内联样式不比
      // 特异度，写上就赢，关菜单时再把原来的值原样写回。
      node.style.zIndex = String(POP_HOST_Z)
      marks.push({ node, positioned, zIndex })
    }
    node = node.parentElement
  }
  return marks
}

/** 原样摘掉：只摘自己打过的，不再遍历一遍（那时样式已经变了）。 */
export function unmarkPopHosts(marks: readonly PopHostMark[]): void {
  for (const mark of marks) {
    mark.node.classList.remove(POP_HOST)
    if (mark.positioned) mark.node.classList.remove(POP_HOST_STATIC)
    mark.node.style.zIndex = mark.zIndex
  }
}
