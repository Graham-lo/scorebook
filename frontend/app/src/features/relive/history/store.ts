// 取回来的格子放哪儿：内存，一张按最近用过排序的表。
//
// 上限是两层：同一个 (品种, 周期) 最多 40 格（4 万根），整页最多 120 格。人往左
// 拖得够久，最右边那些格子早就不在视野里了，让它们先走。这里不写任何持久层——
// 行情是借来看的（三期再谈 24 小时热缓存）。
//
// `window()` 回答的是「图现在该吃哪一段」：只给包含视野的那一段连续格子，中间
// 缺一格就在缺口处断开。图永远只吃一段连续数据，历史有多长和它无关。

import type { Bar } from '../../../api/types'
import type { HoleReason } from './sources'
import { spaceKeyString, tileIndex, tileKeyString, type TileKey } from './tiles'

export interface StoredTile {
  bars: Bar[]
  complete: boolean
  hole?: HoleReason
  fetchedAt: number
}

export type SpaceKey = Omit<TileKey, 'index'>

interface Entry {
  key: TileKey
  tile: StoredTile
  touched: number
}

export interface TileStore {
  get(key: TileKey): StoredTile | null
  set(key: TileKey, tile: StoredTile): void
  touch(key: TileKey): void
  /** 包含视野的那一段连续格子里的全部 bars，升序。 */
  window(space: SpaceKey, fromMs: number, toMs: number): Bar[]
  /** 这一档已经攒了多少根。 */
  count(space: SpaceKey): number
  /** 这一档已知最早的一根。 */
  earliest(space: SpaceKey): Bar | null
  size(): number
  clear(): void
}

/** 视野那一格是空洞时，最多往外够几格找最近的一段。 */
const SPILL = 2

export function tileStore(perSpace = 40, total = 120): TileStore {
  const entries = new Map<string, Entry>()
  const spaces = new Map<string, Set<string>>()
  let clock = 0

  const bucket = (space: SpaceKey): Set<string> => {
    const id = spaceKeyString(space)
    let set = spaces.get(id)
    if (!set) { set = new Set(); spaces.set(id, set) }
    return set
  }

  function drop(id: string): void {
    const entry = entries.get(id)
    if (!entry) return
    entries.delete(id)
    spaces.get(spaceKeyString(entry.key))?.delete(id)
  }

  function oldest(ids: Iterable<string>): string | null {
    let pick: string | null = null
    let when = Number.POSITIVE_INFINITY
    for (const id of ids) {
      const entry = entries.get(id)
      if (!entry) continue
      if (entry.touched < when) { when = entry.touched; pick = id }
    }
    return pick
  }

  function evict(space: SpaceKey): void {
    const set = bucket(space)
    while (set.size > perSpace) {
      const go = oldest(set)
      if (!go) break
      drop(go)
    }
    while (entries.size > total) {
      const go = oldest(entries.keys())
      if (!go) break
      drop(go)
    }
  }

  function sorted(space: SpaceKey): Entry[] {
    const set = spaces.get(spaceKeyString(space))
    if (!set) return []
    const out: Entry[] = []
    for (const id of set) {
      const entry = entries.get(id)
      if (entry) out.push(entry)
    }
    return out.sort((a, b) => a.key.index - b.key.index)
  }

  return {
    get(key) {
      const entry = entries.get(tileKeyString(key))
      if (!entry) return null
      entry.touched = ++clock
      return entry.tile
    },
    set(key, tile) {
      const id = tileKeyString(key)
      entries.set(id, { key, tile, touched: ++clock })
      bucket(key).add(id)
      evict(key)
    },
    touch(key) {
      const entry = entries.get(tileKeyString(key))
      if (entry) entry.touched = ++clock
    },
    window(space, fromMs, toMs) {
      const list = sorted(space)
      if (!list.length) return []
      const byIndex = new Map(list.map((entry) => [entry.key.index, entry]))
      const first = tileIndex(fromMs, space.interval)
      const last = tileIndex(toMs, space.interval)
      // 视野里第一格有货的就是锚：从它往两边尽量铺开，遇到缺的一格就停。
      let anchor: number | null = null
      for (let i = first; i <= last; i += 1) {
        if (byIndex.has(i)) { anchor = i; break }
      }
      // 视野整个落在一个空洞里：往外够两格，先够右边（新的那头）。
      //
      // 上市不久的品种，「上市到现在」常常整段挤在一格里，它左边那几格调度器按
      // floor 整格跳过，永远不会有货。人把图往右拖越过上市点，视野就整个落进那
      // 个洞里——这时候回空，图上一根 K 线都没有，跟着连「现在看的是哪儿」都会
      // 走岔，再拖回来也回不来。给它最近那一段：视野左边那半截照样空着，右边该
      // 有的 bar 画得出来。够不着就还是空的——那是真的没取过。
      if (anchor === null) {
        for (let d = 1; d <= SPILL && anchor === null; d += 1) {
          if (byIndex.has(last + d)) anchor = last + d
          else if (byIndex.has(first - d)) anchor = first - d
        }
      }
      if (anchor === null) return []
      let lo = anchor
      let hi = anchor
      while (byIndex.has(lo - 1)) lo -= 1
      while (byIndex.has(hi + 1)) hi += 1
      const out: Bar[] = []
      for (let i = lo; i <= hi; i += 1) {
        const entry = byIndex.get(i)
        if (!entry) break
        entry.touched = ++clock
        out.push(...entry.tile.bars)
      }
      return out
    },
    count(space) {
      let n = 0
      for (const entry of sorted(space)) n += entry.tile.bars.length
      return n
    },
    earliest(space) {
      for (const entry of sorted(space)) {
        const bar = entry.tile.bars[0]
        if (bar) return bar
      }
      return null
    },
    size: () => entries.size,
    clear() { entries.clear(); spaces.clear() },
  }
}
