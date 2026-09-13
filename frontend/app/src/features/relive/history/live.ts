// 活的最新一根。
//
// 历史那一套是「一段一段地取」，最右边这一根不一样：它每一秒都在变，取回来的那
// 一刻就已经旧了。所以它走一条完全独立的路——一条 WebSocket，收一根画一根，**永
// 远不进任何缓存**；等交易所说这根收盘了（`x === true`），它才被当成历史并进内
// 存，从此和别的 bar 一样。
//
// 什么时候开这条流：只在全屏、而且眼睛确实在看最右边那一屏的时候。人拖到 2019
// 年去了，最新一根跳不跳没人关心，流就该关掉——省电、省流量，也省得回来的时候
// 一屏跳动。月度归档那种源、已经交割完的合约，压根没有「最新」可言，不开。
//
// 这个文件里带 DOM 的只有 `liveStream` 一个函数，其余全是纯规矩：映射、节流、
// 退避、贴不贴近现在、还剩多久收盘，Node 里直接测。

import type { Bar, ChartRequest, Market } from '../../../api/types'
import { barSpanMs } from './tiles'

/* ---------------------------------------------------------- 一根活的怎么来 */

/** 币安推过来的那一根。数字都是字符串，和 REST 那边一个口径。 */
export interface LiveKline {
  t: number
  T: number
  o: string
  h: string
  l: string
  c: string
  v?: string
  x?: boolean
}

/**
 * 推送的一根映射成项目的 Bar。
 *
 * `end` 同样是收盘时间 + 1 毫秒——和 `mapKline` 一个字不差，不然同一根从两条路
 * 进来会变成两根。认不出来就返回 null，不猜。
 */
export function liveBar(k: unknown): Bar | null {
  if (!k || typeof k !== 'object') return null
  const row = k as Partial<LiveKline>
  const open = Number(row.t)
  const close = Number(row.T)
  if (!Number.isFinite(open) || !Number.isFinite(close) || close < open) return null
  const parts = [row.o, row.h, row.l, row.c]
  if (!parts.every((v) => typeof v === 'string' && v.length > 0)) return null
  return {
    start: new Date(open).toISOString(),
    end: new Date(close + 1).toISOString(),
    open: row.o as string,
    high: row.h as string,
    low: row.l as string,
    close: row.c as string,
    volume: typeof row.v === 'string' && row.v.length > 0 ? row.v : null,
  }
}

/** 整条消息里把那一根挖出来。`{ k: {...} }`，别的字段用不上。 */
export function liveFrame(text: string): { bar: Bar; closed: boolean } | null {
  let data: unknown
  try { data = JSON.parse(text) } catch { return null }
  if (!data || typeof data !== 'object') return null
  const k = (data as { k?: unknown }).k
  const bar = liveBar(k)
  if (!bar) return null
  return { bar, closed: (k as { x?: boolean }).x === true }
}

/* ------------------------------------------------------------ 开不开这条流 */

const WS_HOST: Record<Market, string> = {
  usd_m: 'wss://fstream.binance.com/ws',
  coin_m: 'wss://dstream.binance.com/ws',
}

export function streamUrl(market: Market, symbol: string, interval: string): string {
  return `${WS_HOST[market]}/${symbol.toLowerCase()}_kline_${interval}`
}

/** 币安永续的「交割时间」是 2100-12-25 那个占位值，不是真的要交割。 */
export const FAR_AHEAD_MS = 10 * 365 * 86_400_000

/**
 * 这个合约还有没有「最新一根」。
 *
 * 月度归档是一份躺着的文件，不会再动；交割时间已经过去的合约也一样。远得离谱的
 * 那个交割时间是占位符，当作没有。
 */
export function streamable(what: {
  source?: ChartRequest['source']
  deliveryMs?: number | null
  nowMs: number
}): boolean {
  if (what.source === 'monthly_archive') return false
  const delivery = what.deliveryMs
  if (delivery == null) return true
  if (delivery - what.nowMs > FAR_AHEAD_MS) return true
  return delivery > what.nowMs
}

/**
 * 眼睛在不在最右边那一屏。
 *
 * 「一屏之内」是故意放宽的：人往左拖半屏还在看最近的行情，这时候把流关掉、回来
 * 再开，中间那一小段就断了。拖出一整屏才算是去看历史了。
 */
export function nearNow(view: { fromMs: number; toMs: number }, nowMs: number): boolean {
  const span = view.toMs - view.fromMs
  if (!(span > 0)) return false
  return view.toMs >= nowMs - span
}

/** 右边缘是不是就钉在最新那一根上（`跟到最新` 的按下态）。 */
export function pinnedToLatest(view: { toMs: number }, nowMs: number, interval: string): boolean {
  return view.toMs >= nowMs - barSpanMs(interval)
}

/* ---------------------------------------------------------------- 断了再连 */

export const BACKOFF_START_MS = 1_000
export const BACKOFF_CAP_MS = 30_000

/** 第 n 次重连等多久：1、2、4、8、16、30、30…… */
export function backoffMs(attempt: number): number {
  const step = Math.max(0, Math.floor(attempt))
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** step)
}

/** 开了这么久还一条消息都没有，就当这条路不通。 */
export const FIRST_FRAME_MS = 10_000
/** 不通的时候退回一期那条直连，每隔这么久补两根。 */
export const POLL_MS = 15_000
/** 画面最多这么密地更新一次。再密人眼也看不出来，只是白烧。 */
export const THROTTLE_MS = 250

/**
 * 节流：头一下立刻走，之后每 250 毫秒最多一下，中间来的只留最后一根。
 *
 * 之所以要「留最后一根」而不是丢掉：最后那一根是当前价，丢了的话在没有新消息的
 * 那几秒里，图上停的是一个过时的价格。
 */
export function throttle<T>(gapMs: number, run: (value: T) => void, clock: () => number = () => Date.now()): {
  push(value: T): void
  flush(): void
  pending(): boolean
} {
  let last = -Infinity
  let held: { value: T } | null = null
  const fire = (value: T): void => { last = clock(); held = null; run(value) }
  return {
    push(value) {
      if (clock() - last >= gapMs) fire(value)
      else held = { value }
    },
    flush() { if (held) fire(held.value) },
    pending: () => held !== null,
  }
}

/* ------------------------------------------------------------ 还剩多久收盘 */

const two = (n: number): string => String(Math.floor(n)).padStart(2, '0')

/**
 * 「距收盘」那半行。一小时以内按 `mm:ss` 走秒，1d 以上按 `{h}h{mm}m`。
 *
 * 已经过点了（消息比本机时钟慢半拍）就按 0 显示，不出负数。
 */
export function closesIn(msLeft: number, interval: string): string {
  const left = Math.max(0, msLeft)
  if (barSpanMs(interval) >= 86_400_000) {
    const hours = Math.floor(left / 3_600_000)
    const minutes = Math.floor((left % 3_600_000) / 60_000)
    return `距收盘 ${hours}h${two(minutes)}m`
  }
  const total = Math.floor(left / 1000)
  return `距收盘 ${two(Math.floor(total / 60))}:${two(total % 60)}`
}

/* ---------------------------------------------------------------- 那条流本身 */

export interface LiveDeps {
  market: Market
  symbol: string
  interval: string
  onBar(bar: Bar): void
  onClosed(bar: Bar): void
  /** WS 不通时的退路：取最后两根（一期那条直连，或者后端那条）。 */
  poll?(): Promise<Bar[]>
  now?(): number
  open?(url: string): WebSocketLike
  timer?: TimerLike
}

export interface WebSocketLike {
  close(): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
}

export interface TimerLike {
  set(run: () => void, ms: number): number
  clear(id: number): void
}

const realTimer: TimerLike = {
  set: (run, ms) => setTimeout(run, ms) as unknown as number,
  clear: (id) => clearTimeout(id),
}

export interface LiveStream {
  /** 该开就开、该关就关。视野一变就叫一次，幂等。 */
  want(on: boolean): void
  connected(): boolean
  stop(): void
}

/**
 * 一条流的完整生命：开、收、断、退避重连、彻底不通就改成每 15 秒补两根。
 *
 * 页面藏起来（切标签、锁屏）就主动断开——后台标签的 WebSocket 会被浏览器限流到
 * 没有意义，留着只是白占一条连接；回前台按「贴不贴近现在」重新决定。
 */
export function liveStream(deps: LiveDeps): LiveStream {
  const now = deps.now ?? (() => Date.now())
  const timer = deps.timer ?? realTimer
  const openSocket = deps.open ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike)
  const beat = throttle<Bar>(THROTTLE_MS, (bar) => deps.onBar(bar), now)

  let socket: WebSocketLike | null = null
  let attempt = 0
  let wantOn = false
  let dead = false
  let retryAt = 0
  let guardAt = 0
  let pollAt = 0
  let sawFrame = false

  const clearTimers = (): void => {
    for (const id of [retryAt, guardAt]) if (id) timer.clear(id)
    retryAt = 0
    guardAt = 0
  }

  function stopPolling(): void {
    if (pollAt) { timer.clear(pollAt); pollAt = 0 }
  }

  /** WS 走不通的那条退路。只有 `poll` 给了才有。 */
  function startPolling(): void {
    if (!deps.poll || pollAt || dead) return
    const tick = (): void => {
      pollAt = timer.set(tick, POLL_MS)
      if (!wantOn) return
      void deps.poll?.().then((bars) => {
        if (dead || !wantOn) return
        for (const bar of bars) deps.onBar(bar)
      }).catch(() => { /* 补不上就算了，下一轮再说 */ })
    }
    pollAt = timer.set(tick, POLL_MS)
  }

  function disconnect(): void {
    clearTimers()
    if (!socket) return
    const old = socket
    socket = null
    old.onopen = null
    old.onmessage = null
    old.onerror = null
    old.onclose = null
    try { old.close() } catch { /* 已经断了 */ }
  }

  function retry(): void {
    if (dead || !wantOn) return
    const wait = backoffMs(attempt)
    attempt += 1
    retryAt = timer.set(() => { retryAt = 0; connect() }, wait)
  }

  function connect(): void {
    if (dead || !wantOn || socket) return
    let ws: WebSocketLike
    try {
      ws = openSocket(streamUrl(deps.market, deps.symbol, deps.interval))
    } catch {
      // 构造函数就抛了：这个环境根本没有 WebSocket，别再试了，直接走退路。
      startPolling()
      return
    }
    socket = ws
    sawFrame = false
    guardAt = timer.set(() => {
      guardAt = 0
      if (dead || sawFrame) return
      // 开了十秒一条消息都没有：当它不通，换退路，同时继续退避重连。
      startPolling()
      disconnect()
      retry()
    }, FIRST_FRAME_MS)
    ws.onopen = () => { attempt = 0 }
    ws.onmessage = (event) => {
      if (dead || typeof event.data !== 'string') return
      const frame = liveFrame(event.data)
      if (!frame) return
      sawFrame = true
      stopPolling()
      if (frame.closed) {
        beat.flush()
        deps.onBar(frame.bar)
        deps.onClosed(frame.bar)
        return
      }
      beat.push(frame.bar)
    }
    ws.onerror = () => { /* onclose 紧跟着来，统一在那儿处理 */ }
    ws.onclose = () => {
      if (dead || socket !== ws) return
      disconnect()
      retry()
    }
  }

  return {
    want(on) {
      if (dead || on === wantOn) return
      wantOn = on
      if (on) { attempt = 0; connect() }
      else { disconnect(); stopPolling() }
    },
    connected: () => socket !== null && sawFrame,
    stop() {
      dead = true
      wantOn = false
      disconnect()
      stopPolling()
    },
  }
}
