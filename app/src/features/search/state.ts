// 这一页在两次造访之间记住的东西。
//
// 检索页的状态活在模块里而不是 DOM 里：去准备一段历史、去看某条记录，回来时
// 图、框、周期、范围和任务引用保存到本标签页会话；刷新后 GET 同一次任务恢复。
//
// 它被拆成这几块，各自住在自己的文件里：
//
//   state.ts      这里：查询条件、查询图与框、范围选择、这次检索的编号
//   image-pane.ts 查询图与框，以及换图
//   controls.ts   配色、周期、品种筛选、方向，和「开始搜索」
//   analysis.ts   先认一下这张图
//   run.ts        起检索、读进度、停手
//   results.ts    结果分发：还在跑、停手了、没做完、最终结果
//   hits.ts       一条命中长什么样（公开历史的片段 / 自己的记录）
//   scope.ts      两条路各自的前提：截图算过特征没有 / 能搜到哪些公开历史

import type { ChartAnalysis, ChartSearchRun, SearchScope } from '../../api/chart'
import { Latest, WriteAction } from '../../api/http'
import type { Market, Region, Uuid } from '../../api/types'
import type { ChartView } from '../../ui/media'
import { QueryPeriod } from './query-period'
import { CHECKPOINT_KEY, readCheckpoint } from './checkpoint'

/** 后端只收 1…30 条。 */
export const MAX_HITS = 30
export const HIT_CHOICES = [3, 5, 10]

/** 还在自己往下走的状态：等它就行，没有人要做的事。 */
const MOVING = ['queued', 'running', 'retry_wait']

export function moving(status: string): boolean {
  return MOVING.includes(status)
}

/** What the page is holding onto between visits, so a query survives a detour. */
export interface SearchState {
  scope: SearchScope
  queryId: Uuid | null
  queryName: string
  region: Region | null
  /** 图上是不是红涨绿跌。默认按绿涨红跌读，读反了 K 线的方向就全反了。 */
  redUp: boolean
  analysis: ChartAnalysis | null
  analysisFor: string | null
  symbol: string | null
  market: Market | null
  /** 反向匹配：把走势上下翻过来比。默认关闭。 */
  reverse: boolean
  limit: number
  runId: Uuid | null
  run: ChartSearchRun | null
  submitting: boolean
}

export const state: SearchState = {
  scope: 'private',
  queryId: null,
  queryName: '',
  region: null,
  redUp: false,
  analysis: null,
  analysisFor: null,
  symbol: null,
  market: null,
  reverse: false,
  limit: 3,
  runId: null,
  run: null,
  submitting: false,
}

export const period = new QueryPeriod()
export const uploadAction = new WriteAction()
export const analyzeAction = new WriteAction()
export const searchAction = new WriteAction()
export const cancelAction = new WriteAction()
export const reindexAction = new WriteAction()
export const lane = new Latest()
export let searchVersion = 0
let runFingerprint = ''
const submissionListeners = new Set<() => void>()
export function onSubmissionSettled(listener: () => void): () => void {
  submissionListeners.add(listener)
  return () => { submissionListeners.delete(listener) }
}
export function finishSubmission(): void {
  state.submitting = false
  for (const listener of submissionListeners) listener()
}

export function queryFingerprint(): string {
  return JSON.stringify([state.queryId, state.scope, state.region, period.value, state.symbol, state.market, state.redUp, state.reverse, state.limit])
}
export function persistSearch(): void {
  try {
    if (!state.queryId) { sessionStorage.removeItem(CHECKPOINT_KEY); return }
    const { queryId, queryName, scope, region, symbol, market, redUp, reverse, limit, runId } = state
    sessionStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ queryId, queryName, scope, region, interval: period.value, symbol, market, redUp, reverse, limit, runId }))
  } catch { /* Storage may be disabled; live browsing still works. */ }
}
export function restoreSearch(): void {
  if (state.queryId) return
  try {
    const saved = readCheckpoint(sessionStorage.getItem(CHECKPOINT_KEY))
    if (!saved) return
    const { interval, ...settings } = saved
    Object.assign(state, settings)
    if (interval) period.select(interval)
    runFingerprint = state.runId ? queryFingerprint() : ''
  } catch { /* No stored session. */ }
}
export function rememberRun(id: string): void {
  state.runId = id
  runFingerprint = queryFingerprint()
  persistSearch()
}
export function syncQuery(): void {
  if (runFingerprint && runFingerprint !== queryFingerprint()) forgetRun()
  persistSearch()
}

/** 换了图、换了框、换了范围，上一次的结果就不是这次问的答案了。 */
export function forgetRun(): void {
  searchVersion += 1
  lane.cancel()
  state.runId = null
  state.run = null
  runFingerprint = ''
  persistSearch()
}

/** 图或者框一变，上一次认图说的就不是这一块的事了。 */
export function forgetAnalysis(): void {
  state.analysis = null
  state.analysisFor = null
}

/**
 * 这一页在跑的时候，各个模块共用的那点东西。都从这里拿，模块之间就不用互相
 * 导入——否则「结果里的重试按钮」和「起检索」会绕成一个环。
 */
export interface SearchCtx {
  /** 人还在这一页上吗。离开之后任何迟到的回包都不许再往界面上写。 */
  alive(): boolean
  /** 登记一个离开时要关掉的东西：定时器、轮询、还没画完的图。 */
  onLeave(stop: () => void): void
  /** 会在离开这一页时立刻醒过来的等待，免得轮询卡在一个永远不 resolve 的 await 上。 */
  sleep(ms: number): Promise<void>
  /** 要一张登记过的行情图；离开这一页时统一取消。 */
  chart(): ChartView
  /** 重画结果之前，把上一批图都停掉。 */
  dropCharts(): void
  repaintQuery(): void
  repaintControls(): void
  repaintResults(): void
  runSearch(): void
  stopSearch(): void
  /** 结果那一栏。起检索时要先把「正在安排」写进去。 */
  resultPane: HTMLElement
}
