// 「找」这一页在两次造访之间记住的东西。
//
// 状态活在模块里而不是 DOM 里：点开一条记录再回来，输入框里的话、给过的那张
// 图、认出来的品种周期和这一次的检索都还在，不用重问一遍。
//
// 它被拆成这几块：
//
//   state.ts  这里：输入、那张图、认图结果、两条检索各自的进度
//   run.ts    起检索、读进度（我的记录里 / 币安历史里 各一条）
//   hits.ts   一条结果长什么样
//   score.ts  很像 / 像 / 有点像

import type { ChartAnalysis, ChartSearchRun, SearchScope } from '../../api/chart'
import { WriteAction } from '../../api/http'
import type { KnowledgeHit } from '../../api/knowledge'
import type { Instrument, TagRecord, Uuid } from '../../api/types'

/** 一条检索：起了没有、跑到哪儿了、成没成。 */
export interface RunSlot {
  readonly scope: SearchScope
  runId: Uuid | null
  run: ChartSearchRun | null
  /** 这一次没起来或者没做完。 */
  failed: boolean
  exclude: Uuid[]
  page: number
  /** 重来一次就加一，迟到的回包认不出自己那一轮就不再往界面上写。 */
  version: number
  readonly action: WriteAction
}

function slot(scope: SearchScope): RunSlot {
  return { scope, runId: null, run: null, failed: false, exclude: [], page: 0, version: 0, action: new WriteAction() }
}

export interface SearchState {
  /** 输入框里现在写着什么。 */
  text: string
  /** 已经按这句话找过了。 */
  asked: string
  onlyMine: boolean
  limit: 3 | 5 | 10

  /** 给过的那张图。已定位或等待人工确认的 K 线图长期保留。 */
  queryId: Uuid | null
  imageVersion: number
  queryName: string
  analysis: ChartAnalysis | null
  /** 认过了，但这张图上没有 K 线。 */
  unreadable: boolean
  recognitionError: boolean
  /** 认出来的，或者人自己点的那个周期。 */
  interval: string | null

  /** 文字那一半。null 是还没找过。 */
  words: KnowledgeHit[] | null
  tags: TagRecord[]
  symbols: Instrument[]
  textBusy: boolean
  textError: string | null
  pendingSources: number

  mine: RunSlot
  market: RunSlot
}

export const state: SearchState = {
  text: '',
  asked: '',
  onlyMine: false,
  limit: 5,
  queryId: null,
  imageVersion: 0,
  queryName: '',
  analysis: null,
  unreadable: false,
  recognitionError: false,
  interval: null,
  words: null,
  tags: [],
  symbols: [],
  textBusy: false,
  textError: null,
  pendingSources: 0,
  mine: slot('private'),
  market: slot('binance_history'),
}

/** 换了图，上一张认出来的东西和上一次的检索都不算数了。 */
export function forgetImage(): void {
  state.imageVersion += 1
  state.queryId = null
  state.queryName = ''
  state.analysis = null
  state.unreadable = false
  state.recognitionError = false
  state.interval = null
  forgetRuns()
}

export function forgetRuns(): void {
  for (const run of [state.mine, state.market]) {
    run.version += 1
    run.runId = null
    run.run = null
    run.failed = false
    run.exclude = []
    run.page = 0
  }
}

export function forgetText(): void {
  state.asked = ''
  state.words = null
  state.tags = []
  state.symbols = []
  state.textBusy = false
  state.textError = null
  state.pendingSources = 0
}

/** 还在自己往下走的检索：等它就行，没有人要做的事。 */
const MOVING = ['queued', 'running', 'retry_wait']

export function moving(status: string): boolean {
  return MOVING.includes(status)
}
