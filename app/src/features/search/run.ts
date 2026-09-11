// 起检索、读进度、停手。
//
//   起检索  POST /v1/chart-search/runs —— 比哪一堆图必须由人明说。
//   看进度  GET  /v1/chart-search/runs/{id} —— 断开重连不会再起一次检索；
//           重来只有人按了才算。
//   停手    带 expected_generation；版本对不上就是别处已经动过它了。

import { ApiError } from '../../api/errors'
import { Latest } from '../../api/http'
import { cancelSearch, searchRun, startSearch, type ChartSearchInput, type ChartSearchRun } from '../../api/chart'
import type { Uuid } from '../../api/types'
import { h } from '../../ui/dom'
import { empty, note, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { MAX_HITS, cancelAction, forgetRun, lane, moving, period, rejectedExcludes, searchAction, state, rememberRun, queryFingerprint, searchVersion, finishSubmission, type SearchCtx } from './state'

/** 同一时间只有一条轮询在跑。 */
let pollingVersion = 0

/**
 * 这一次要发出去的请求体。
 *
 * 单独拎出来是因为它有一处不能想当然：人一条都没否过的时候，`exclude` 整个字段
 * 都不许出现——写成空数组，请求体和幂等键就跟从前不一样了，而这一次问的其实是
 * 同一件事。
 */
export function searchBody(queryId: Uuid): ChartSearchInput {
  const excluded = rejectedExcludes()
  return {
    attachment_id: queryId,
    scope: state.scope,
    ...(state.region ? { region: state.region } : {}),
    ...(state.symbol ? { symbol: state.symbol } : {}),
    ...(state.market ? { market: state.market } : {}),
    // 「不限」必须显式写出来：后端分不清「人选了不限」和「前端漏传周期」就
    // 会把一次 422 变成一次全库检索。
    interval: period.interval,
    interval_policy: period.anyInterval ? 'any_interval' : 'same_interval',
    ...(state.reverse ? { reverse: true } : {}),
    ...(state.redUp ? { red_up: true } : {}),
    limit: Math.min(MAX_HITS, Math.max(1, state.limit)),
    ...(excluded.length ? { exclude: excluded } : {}),
  }
}

export async function runSearch(ctx: SearchCtx): Promise<void> {
  if (!state.queryId || state.submitting || (state.runId && (!state.run || moving(state.run.status)))) return
  if (!period.chosen) {
    problem('请先说清楚截图的 K 线周期，或者明说不限周期。')
    return
  }
  const input = searchBody(state.queryId)
  forgetRun()
  const version = searchVersion
  const fingerprint = queryFingerprint()
  state.submitting = true
  ctx.repaintControls()
  ctx.resultPane.replaceChildren(spinner('正在安排这次检索…'))
  try {
    // 幂等键跟着请求体走，否决集合也在里面：连着按两次「都不是」报的不是同一
    // 份集合，于是这是两次不同的检索，而不是被当成同一次重发。
    const started = await startSearch(input, searchAction.keyFor(input))
    searchAction.reset()
    if (version !== searchVersion || fingerprint !== queryFingerprint()) return
    rememberRun(started.search_run_id)
  } catch (error) {
    if (!ctx.alive() || version !== searchVersion || fingerprint !== queryFingerprint()) return
    ctx.resultPane.replaceChildren(
      empty({
        title: '这次没有搜成',
        tip: error instanceof Error ? error.message : '稍后再试一次。',
        action: h('button.btn.sm', { text: '重试', on: { click: () => ctx.runSearch() } }),
      }),
    )
  } finally {
    finishSubmission()
  }
}

/**
 * 读这次检索的状态，直到它停下来。
 *
 * 中途读到的 provisional 会照样画出来，但会明说那还只是候选：来源核验和几何精排
 * 都在最后一步做。断开重连不会再起一次检索——重来只有人按了才算。
 */
export async function poll(ctx: SearchCtx): Promise<void> {
  const mine = ++pollingVersion
  const id = state.runId
  if (!id) return
  const signal = lane.begin()
  const current = () => ctx.alive() && mine === pollingVersion && state.runId === id && !signal.aborted
  try {
    for (;;) {
      if (!current()) return
      let run: ChartSearchRun
      try {
        run = await searchRun(id, { signal })
      } catch (error) {
        if (Latest.aborted(error) || !current()) return
        if (error instanceof ApiError && error.status === 404) {
          forgetRun()
          ctx.resultPane.replaceChildren(note('warn', '这次检索已经不在了，重新搜一次吧。'))
          return
        }
        await ctx.sleep(6_000)
        continue
      }
      if (!current()) return
      state.run = run
      ctx.repaintControls()
      ctx.repaintResults()
      if (!moving(run.status)) return
      await ctx.sleep(2_000)
    }
  } finally { /* Each loop owns its request signal. */ }
}

export async function stopSearch(ctx: SearchCtx): Promise<void> {
  const run = state.run
  if (!run) return
  const body = { id: run.id, expected_generation: run.generation }
  try {
    await cancelSearch(run.id, run.generation, cancelAction.keyFor(body))
    cancelAction.reset()
    if (!ctx.alive() || state.runId !== run.id) return
    toast('这次检索已经停手。')
  } catch (error) {
    if (!ctx.alive()) return
    // 版本对不上就是别处已经动过它了：把状态读回来给人看，不盲重试。
    problem(error instanceof Error ? error.message : '没有停下来。')
  }
  void poll(ctx)
}
