// A small in-memory cache in front of the read endpoints.
//
// Nothing here touches localStorage, IndexedDB or any other persistent store:
// records, market data and rendered charts live only as long as the tab does.
// The cache exists so that opening a record from the ledger does not re-fetch
// what the ledger already read, and is dropped as soon as a write lands.

import * as callsApi from '../api/calls'
import * as knowledge from '../api/knowledge'
import type { CallDetail, TagRecord, Uuid } from '../api/types'

const details = new Map<Uuid, CallDetail>()

export function cachedDetail(id: Uuid): CallDetail | null {
  return details.get(id) ?? null
}

export async function detail(id: Uuid, options: { refresh?: boolean } = {}): Promise<CallDetail> {
  if (!options.refresh) {
    const hit = details.get(id)
    if (hit) return hit
  }
  const fresh = await callsApi.get(id)
  details.set(id, fresh)
  return fresh
}

/** Called after any write so the next read sees the server's version. */
export function invalidate(id?: Uuid): void {
  if (id) details.delete(id)
  else details.clear()
}

let tags: Map<Uuid, TagRecord> | null = null

export async function tagIndex(options: { refresh?: boolean } = {}): Promise<Map<Uuid, TagRecord>> {
  if (tags && !options.refresh) return tags
  const map = new Map<Uuid, TagRecord>()
  let cursor: string | null = null
  for (let page = 0; page < 50; page += 1) {
    const result = await knowledge.tags(cursor)
    for (const tag of result.items) map.set(tag.id, tag)
    if (!result.next_cursor) break
    cursor = result.next_cursor
  }
  tags = map
  return map
}

export function tagName(id: Uuid): string | null {
  return tags?.get(id)?.name ?? null
}

export function knownTags(): TagRecord[] {
  return tags ? [...tags.values()] : []
}

export function forgetTags(): void {
  tags = null
}

/**
 * Runs at most `width` jobs at once. The ledger enriches its rows one detail
 * request at a time so a long page does not open twenty connections at once.
 */
export class Gate {
  #running = 0
  #waiting: (() => void)[] = []

  constructor(private readonly width: number) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.#running >= this.width) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve))
    }
    this.#running += 1
    try {
      return await job()
    } finally {
      this.#running -= 1
      this.#waiting.shift()?.()
    }
  }
}
