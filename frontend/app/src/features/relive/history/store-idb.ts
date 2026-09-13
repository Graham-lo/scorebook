// 24 小时热缓存：同一段行情今天第二次看，不再走一趟网络。
//
// 口径和后端那份 replay_bars 一致，一个字都没放宽：**临时、过期即清、可一键清
// 空**。只存已经收盘的整格——正在走的那一根每秒都在变，存下来就是错的；过期时
// 间硬编在每一条上，读的时候先看表，看完再看内容。
//
// 存取那一层和「什么该存、什么该扔」这一层是分开的：下面这些规矩是纯函数，
// Node 里直接测；真的 IndexedDB 只是一个 20 行的后端实现，任何一步抛错都静默退
// 回纯内存（隐私模式、被策略禁掉、配额满，都会抛）。

import type { Bar } from '../../../api/types'
import { tileKeyString, tileRange, type TileKey } from './tiles'

export const DB_NAME = 'tf-klines'
export const DB_VERSION = 1
export const STORE = 'tiles'

/** 一条存多久。 */
export const TTL_MS = 24 * 3_600_000
/** 整库最多占这么多（估算值，不是精确字节）。 */
export const CAP_BYTES = 50 * 1024 * 1024

export interface HotTile {
  market: string
  symbol: string
  interval: string
  index: number
  bars: Bar[]
  complete: boolean
  fetchedAt: number
  expiresAt: number
  touchedAt: number
}

/** 一条大概占多少字节。一根 K 线七个字段，按 120 字节估。 */
export const BYTES_PER_BAR = 120
export function estimateBytes(tile: Pick<HotTile, 'bars'>): number {
  return 64 + tile.bars.length * BYTES_PER_BAR
}

/** 还没过期吗。 */
export function fresh(tile: Pick<HotTile, 'expiresAt'>, nowMs: number): boolean {
  return tile.expiresAt > nowMs
}

/**
 * 这一格能不能存。两条：问干净了（`complete`），而且整格都已经收盘。
 *
 * 第二条是关键——桶止还在未来的那一格里躺着一根正在走的 K 线，存下来明天读出来
 * 就是一根错的。
 */
export function keepable(
  key: Pick<TileKey, 'interval' | 'index'>,
  tile: { complete: boolean; bars: readonly Bar[] },
  nowMs: number,
): boolean {
  if (!tile.complete) return false
  if (!tile.bars.length) return false
  return tileRange(key.index, key.interval).endMs <= nowMs
}

/**
 * 总量超了就按最久没碰过的往外扔，扔到装得下为止。返回要扔掉的那几个键。
 */
export function evictions(
  tiles: readonly (Pick<HotTile, 'bars' | 'touchedAt'> & { key: string })[],
  capBytes = CAP_BYTES,
): string[] {
  let total = 0
  for (const tile of tiles) total += estimateBytes(tile)
  if (total <= capBytes) return []
  const order = [...tiles].sort((a, b) => a.touchedAt - b.touchedAt)
  const out: string[] = []
  for (const tile of order) {
    if (total <= capBytes) break
    total -= estimateBytes(tile)
    out.push(tile.key)
  }
  return out
}

/** 真正落地的那一层。IndexedDB 是它的一种实现，测试里换成一张 Map。 */
export interface HotBackend {
  get(key: string): Promise<HotTile | null>
  put(key: string, tile: HotTile): Promise<void>
  delete(keys: readonly string[]): Promise<void>
  all(): Promise<{ key: string; tile: HotTile }[]>
  clear(): Promise<void>
}

export interface HotCache {
  read(key: TileKey, nowMs?: number): Promise<{ bars: Bar[]; complete: boolean } | null>
  write(key: TileKey, tile: { bars: readonly Bar[]; complete: boolean }, nowMs?: number): Promise<void>
  /** 清掉过期的，再看看总量要不要淘汰。返回还剩几条。 */
  sweep(nowMs?: number): Promise<number>
  count(): Promise<number>
  clear(): Promise<void>
}

/** 出错一律静默：热缓存没了顶多多发一次请求，不该把图弄坏。 */
async function quiet<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try { return await work() } catch { return fallback }
}

export function hotCache(backend: HotBackend, clock: () => number = () => Date.now()): HotCache {
  return {
    read(key, nowMs = clock()) {
      return quiet(async () => {
        const id = tileKeyString(key)
        const found = await backend.get(id)
        if (!found) return null
        if (!fresh(found, nowMs)) { await backend.delete([id]); return null }
        await backend.put(id, { ...found, touchedAt: nowMs })
        return { bars: found.bars, complete: found.complete }
      }, null)
    },
    write(key, tile, nowMs = clock()) {
      return quiet(async () => {
        if (!keepable(key, tile, nowMs)) return
        await backend.put(tileKeyString(key), {
          market: key.market,
          symbol: key.symbol,
          interval: key.interval,
          index: key.index,
          bars: tile.bars.slice(),
          complete: true,
          fetchedAt: nowMs,
          expiresAt: nowMs + TTL_MS,
          touchedAt: nowMs,
        })
      }, undefined)
    },
    sweep(nowMs = clock()) {
      return quiet(async () => {
        const all = await backend.all()
        const stale = all.filter((row) => !fresh(row.tile, nowMs)).map((row) => row.key)
        if (stale.length) await backend.delete(stale)
        const left = all.filter((row) => fresh(row.tile, nowMs))
        const over = evictions(left.map((row) => ({ key: row.key, bars: row.tile.bars, touchedAt: row.tile.touchedAt })))
        if (over.length) await backend.delete(over)
        return left.length - over.length
      }, 0)
    },
    count() { return quiet(async () => (await backend.all()).length, 0) },
    clear() { return quiet(() => backend.clear(), undefined) },
  }
}

/* ------------------------------------------------ 真的 IndexedDB 那一层 */

function ask<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((done, fail) => {
    request.onsuccess = () => done(request.result)
    request.onerror = () => fail(request.error ?? new Error('indexeddb'))
  })
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((done, fail) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (db.objectStoreNames.contains(STORE)) return
      const store = db.createObjectStore(STORE)
      store.createIndex('expiresAt', 'expiresAt')
      store.createIndex('touchedAt', 'touchedAt')
    }
    request.onsuccess = () => done(request.result)
    request.onerror = () => fail(request.error ?? new Error('indexeddb'))
    request.onblocked = () => fail(new Error('indexeddb blocked'))
  })
}

/** 浏览器里那份实现。拿不到 IndexedDB 就返回 null，调用方退回纯内存。 */
export function idbBackend(): HotBackend | null {
  try {
    if (typeof indexedDB === 'undefined') return null
  } catch { return null }
  let db: Promise<IDBDatabase> | null = null
  const use = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> => {
    db ??= openDb()
    const open = await db
    const tx = open.transaction(STORE, mode)
    return run(tx.objectStore(STORE))
  }
  return {
    get: (key) => use('readonly', async (store) => (await ask<HotTile | undefined>(store.get(key))) ?? null),
    put: (key, tile) => use('readwrite', async (store) => { await ask(store.put(tile, key)) }),
    delete: (keys) => use('readwrite', async (store) => { for (const key of keys) await ask(store.delete(key)) }),
    all: () => use('readonly', async (store) => {
      const keys = await ask<IDBValidKey[]>(store.getAllKeys())
      const values = await ask<HotTile[]>(store.getAll())
      return keys.map((key, i) => ({ key: String(key), tile: values[i] as HotTile })).filter((row) => row.tile)
    }),
    clear: () => use('readwrite', async (store) => { await ask(store.clear()) }),
  }
}

/** 全局那一份。没有 IndexedDB 就是 null，所有调用点都当它不存在。 */
let shared: HotCache | null | undefined
export function hot(): HotCache | null {
  if (shared !== undefined) return shared
  const backend = idbBackend()
  shared = backend ? hotCache(backend) : null
  return shared
}
