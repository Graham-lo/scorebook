// 「正在准备哪几段历史」这件事要记在本地，否则刷新一下页面，进度就找不回来了：
// 后端能按编号查一份准备工作的进度，但没有「列出我所有准备工作」的接口。
//
// 这里只存定位信息——哪个合约、哪个周期、哪一段时间，以及后端给的编号。行情本身
// 和画出来的图一律不存。准备完成、取消或者读不到了，这一条就删掉。

export interface PrepEntry {
  /** 一次就能装下的一段走 index；太长的一段由后端分段做，走 plan。 */
  kind: 'index' | 'plan'
  id: string
  symbol: string
  market: string
  interval: string
  start_at: string
  end_at: string
  started_at: string
}

const KEY = 'scorebook.preparing.v1'

function read(): PrepEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry)
  } catch {
    return []
  }
}

function isEntry(value: unknown): value is PrepEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    (v.kind === 'index' || v.kind === 'plan') &&
    typeof v.id === 'string' &&
    typeof v.symbol === 'string' &&
    typeof v.market === 'string' &&
    typeof v.interval === 'string' &&
    typeof v.start_at === 'string' &&
    typeof v.end_at === 'string' &&
    typeof v.started_at === 'string'
  )
}

function write(entries: PrepEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-12)))
  } catch {
    // 存不下就算了，只是刷新之后要重新去看进度。
  }
}

/** 最近开始的排在最前面。 */
export function list(): PrepEntry[] {
  return read().reverse()
}

export function remember(entry: PrepEntry): void {
  write([...read().filter((e) => e.id !== entry.id), entry])
}

export function forget(id: string): void {
  write(read().filter((e) => e.id !== id))
}

// ——— 一直往前准备的那几条「跟进」———

/**
 * 跟进和「准备一段」不一样：它没有结束时间，后端会一轮一轮地往前追。同样地，
 * 后端只能按编号查一条，所以编号要记在本机，否则页面一刷新就找不回来了。
 */
export interface FollowEntry {
  id: string
  market: string
  symbols: string[]
  intervals: string[]
  start_at: string
  source: string
  started_at: string
}

const FOLLOW_KEY = 'scorebook.following.v1'

function readFollows(): FollowEntry[] {
  try {
    const raw = localStorage.getItem(FOLLOW_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isFollow)
  } catch {
    return []
  }
}

function isFollow(value: unknown): value is FollowEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.market === 'string' &&
    Array.isArray(v.symbols) &&
    Array.isArray(v.intervals) &&
    typeof v.start_at === 'string' &&
    typeof v.source === 'string' &&
    typeof v.started_at === 'string'
  )
}

function writeFollows(entries: FollowEntry[]): void {
  try {
    localStorage.setItem(FOLLOW_KEY, JSON.stringify(entries.slice(-12)))
  } catch {
    // 存不下就算了，只是刷新之后要重新按编号找回来。
  }
}

export function follows(): FollowEntry[] {
  return readFollows().reverse()
}

export function rememberFollow(entry: FollowEntry): void {
  writeFollows([...readFollows().filter((e) => e.id !== entry.id), entry])
}

export function forgetFollow(id: string): void {
  writeFollows(readFollows().filter((e) => e.id !== id))
}
