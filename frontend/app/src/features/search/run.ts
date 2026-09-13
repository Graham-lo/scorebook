// 给一张图的那条路：起检索、读进度。
//
//   起检索  POST /v1/chart-search/runs —— 我的记录里、币安历史里各起一条。
//   读进度  GET  /v1/chart-search/runs/{id} —— 断线重连不会再起一次；
//           中途出现的 provisional 只是候选，做完才算数。
//
// 比哪一堆图不再问人：默认两边都比，右上角那个开关按下去就只比自己的记录。

import { Latest } from '../../api/http'
import { cancelSearch, searchRun, startSearch, type ChartSearchInput } from '../../api/chart'
import { prefs } from '../../data/prefs'
import { moving, state, type RunSlot } from './state'

/** 一次看几条。后端默认 5，这一页照它的默认走。 */

export interface RunCtx {
  alive(): boolean
  sleep(ms: number): Promise<void>
  repaint(): void
}

export function searchBody(slot: RunSlot, queryId: string, interval: string): ChartSearchInput {
  return {
    attachment_id: queryId,
    scope: slot.scope,
    ...(slot.scope === 'private' && state.text.trim() ? { query_text: state.text.trim() } : {}),
    interval,
    interval_policy: 'same_interval',
    // 图上是不是红涨绿跌，按设置里的涨跌配色当首选；认反了 K 线的方向就全反了。
    ...(prefs().updown === 'red_up' ? { red_up: true } : {}),
    limit: state.limit,
    ...(slot.exclude.length ? { exclude: [...slot.exclude] } : {}),
  }
}

/** 两条路一起起：只看我的记录时就只起一条。 */
export function launchAll(ctx: RunCtx): void {
  launch(state.mine, ctx)
  if (state.onlyMine) {
    state.market.version += 1
    state.market.runId = null
    state.market.run = null
    state.market.failed = false
  } else {
    launch(state.market, ctx)
  }
}

async function stopRun(id: string): Promise<void> {
  try {
    const previous = await searchRun(id)
    if (moving(previous.status)) await cancelSearch(id, previous.generation, crypto.randomUUID())
  } catch { /* 完成或已取消的任务无需再操作。 */ }
}

export function launch(slot: RunSlot, ctx: RunCtx): void {
  const queryId = state.queryId
  const interval = state.interval
  if (!queryId || !interval) return
  const previousId = slot.runId
  const previousRun = slot.run
  if (previousId) void (async () => {
    try {
      const previous = previousRun ?? await searchRun(previousId)
      if (moving(previous.status)) await cancelSearch(previousId, previous.generation, crypto.randomUUID())
    } catch { /* A completed or already-cancelled run needs no further action. */ }
  })()
  const mine = (slot.version += 1)
  slot.runId = null
  slot.run = null
  slot.page = 0
  slot.failed = false
  const body = searchBody(slot, queryId, interval)
  void (async () => {
    try {
      const started = await startSearch(body, slot.action.keyFor(body))
      slot.action.reset()
      if (mine !== slot.version) { void stopRun(started.search_run_id); return }
      slot.runId = started.search_run_id
      if (!ctx.alive()) return
      ctx.repaint()
      await poll(slot, ctx, mine)
    } catch {
      if (!ctx.alive() || mine !== slot.version) return
      slot.failed = true
      ctx.repaint()
    }
  })()
}

/** 读这一条检索的状态，直到它停下来。 */
export async function poll(slot: RunSlot, ctx: RunCtx, mine = slot.version): Promise<void> {
  const id = slot.runId
  if (!id) return
  const lane = new Latest()
  const signal = lane.begin()
  const current = (): boolean => ctx.alive() && mine === slot.version && slot.runId === id
  let failures = 0
  slot.failed = false
  for (;;) {
    if (!current()) return
    try {
      const run = await searchRun(id, { signal })
      if (!current()) return
      failures = 0
      slot.failed = false
      slot.run = run
      ctx.repaint()
      if (!moving(run.status)) return
    } catch (error) {
      if (Latest.aborted(error) || !current()) return
      failures += 1
      if (failures >= 3) { slot.failed = true; ctx.repaint(); return }
      await ctx.sleep(6_000)
      continue
    }
    await ctx.sleep(2_000)
  }
}
