// 全屏行情图上几条「显示不显示、算不算数」的规则。
//
// 单独放一个文件，是因为 `market-view.ts` 整个是 DOM，Node 里的测试碰不到它，
// 而这几条规则恰恰是最容易改错、也最该被钉住的部分。

/** 窄到这个宽度以下就算手机竖屏：图例只留最要紧的那半行。 */
export const NARROW_PX = 480

/**
 * 这张图上要不要标「记下判断」。
 *
 * 判断发生在市场给出答案之前，所以这条线只属于**记录自己的那张截图**——从详情页
 * 「看真实走势」、从记一笔里那张图进来的都算。找相似的查询图、校准用的图不是一
 * 次判断，不画。
 */
export function showsJudgment(options: { attachmentId?: string; queryAttachmentId?: string }): boolean {
  return Boolean(options.attachmentId)
}

/**
 * 按住 `-` / `+` 不放时，这一下算不算数。
 *
 * 系统的重复按键一秒能来三十次，一次 ×1.35 的话眨眼就缩到头了；直接丢掉重复事件
 * 又会让按住不放完全没反应。取中间：最快 120 ms 走一步。
 */
export const HOLD_MS = 120
export function holdOk(repeat: boolean, lastMs: number, nowMs: number, gapMs = HOLD_MS): boolean {
  if (!repeat) return true
  if (!Number.isFinite(lastMs)) return true
  return nowMs - lastMs >= gapMs
}

/**
 * 重入保护：这一趟还没跑完又被叫了一次，就记个脏、立刻返回，外层跑完再补一趟。
 *
 * 图表那边的范围变化回调是**同步**触发的（`setData`、`removeSeries`、`resize`
 * 内部一读可见范围就 fire），回调里再去重画，就会从中间捅进正在跑的那一趟。
 */
export function guarded(run: () => void): () => void {
  let running = false
  let dirty = false
  return () => {
    if (running) { dirty = true; return }
    running = true
    try {
      do { dirty = false; run() } while (dirty)
    } finally { running = false; dirty = false }
  }
}

/**
 * 摘牌再删：先把名单原地清空、留一份旧的，再一个一个交给 `drop`。
 *
 * 边遍历边删的话，`drop` 里同步重入进来会换一批新的进名单，外层接着用旧名单删，
 * 同一条就被删两次——图会直接抛 `Series not found`。
 */
export function retire<T>(items: T[], drop: (item: T) => void): T[] {
  const old = items.splice(0, items.length)
  for (const item of old) drop(item)
  return old
}

/**
 * 「这一次视野变化是程序自己设的」这个标记。
 *
 * 图的范围变化回调是同步触发的，`setData` 一调就打出来一发；不打标记的话外面会
 * 把数据到达当成人在拖图——落位目标被丢掉、换档和速度逻辑跟着乱走。标记要多留
 * 一帧：`setVisibleLogicalRange` 只是排进图的 InvalidateMask，图自己在下一帧还
 * 会补发一次。所以按次数记，`nextFrame` 里再减，同一帧里套几层都配得上。
 */
export function selfMark(nextFrame: (run: () => void) => void): {
  mine(): boolean
  as(run: () => void): void
} {
  let depth = 0
  return {
    mine: () => depth > 0,
    as(run) {
      depth += 1
      try { run() } finally { nextFrame(() => { depth = Math.max(0, depth - 1) }) }
    },
  }
}

/**
 * 换数据和落位的先后顺序。全屏那张图只有这两条路，写在这儿是为了能在 Node 里
 * 用假图钉住顺序——顺序错了的症状（视野被钳到格子边上）在真图里才看得见。
 */
export interface Stage<B> {
  /** 把手里那份 bar 换成这一批（只换，不画）。 */
  fill(next: B[]): void
  /** 按这一段重铺格子；真换了返回 true（重铺自己会重画）。 */
  rebuild(fromMs: number, toMs: number): boolean
  /** 重画。 */
  repaint(): void
  /** 按毫秒落位。 */
  applyTime(fromMs: number, toMs: number): void
}

/**
 * 远跳一趟：先换数据、再铺格子，最后才落位。
 *
 * 顺序反不得。图算滚动位置用的是「最后一根真数据」的下标，新格子上一根真 bar
 * 都没有的时候它把我们要的位置当越界，直接钳到格子边上——落位当场就偏，而且偏
 * 出来的那一段还会被后面的补格子当成「现在看的是这儿」，一路漂下去。
 */
export function jumpTo<B>(stage: Stage<B>, fromMs: number, toMs: number, next: B[] | null): void {
  if (next) stage.fill(next)
  if (!stage.rebuild(fromMs, toMs) && next) stage.repaint()
  stage.applyTime(fromMs, toMs)
}

/**
 * 数据晚到了一步：填进去、重画，然后按那个还没落到的目标再落一次位。
 *
 * 远跳的数据两三秒才回来，上一次落位多半被钳在了格子边上。人自己动过手的话
 * `want` 早就作废了（传 null），不会把他拉回去。
 */
export function refill<B>(stage: Stage<B>, next: B[], want: { from: number; to: number } | null): void {
  stage.fill(next)
  stage.repaint()
  if (want) stage.applyTime(want.from, want.to)
}
