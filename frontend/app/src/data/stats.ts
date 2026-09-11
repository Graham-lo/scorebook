// 一次正式统计对应一份冻结下来的成员表。后端能按编号查一份统计，但没有「列出
// 我做过哪些统计」的接口——所以编号要记在本机，否则页面一刷新，刚才那份就找不
// 回来了，只能重新数一遍（换来的还是另一份快照）。
//
// 这里只存定位信息：编号、当时起的名字、口径、开始时间，以及为它算过的那一份
// 参照基准的编号。数出来的比例、成员、分组一律不存——那些要以后端那份快照为准。

export interface StatEntry {
  id: string
  name: string
  grouping: string
  started_at: string
  /** 为这份统计算过的 B1 参照。没算过就是空。 */
  baseline_id?: string | null
}

const KEY = 'scorebook.statistics.v1'
const CURRENT = 'scorebook.statistics.current.v1'

function read(): StatEntry[] {
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

function isEntry(value: unknown): value is StatEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.grouping === 'string' &&
    typeof v.started_at === 'string'
  )
}

function write(entries: StatEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(-12)))
  } catch {
    // 存不下就算了，只是下次要重新数一份。
  }
}

/** 最近做的排在最前面。 */
export function list(): StatEntry[] {
  return read().reverse()
}

export function remember(entry: StatEntry): void {
  write([...read().filter((e) => e.id !== entry.id), entry])
}

export function forget(id: string): void {
  write(read().filter((e) => e.id !== id))
  if (current() === id) setCurrent(null)
}

export function find(id: string): StatEntry | null {
  return read().find((e) => e.id === id) ?? null
}

/** 给某份统计记上它的参照基准编号。 */
export function rememberBaseline(id: string, baselineId: string | null): void {
  const entry = find(id)
  if (!entry) return
  remember({ ...entry, baseline_id: baselineId })
}

/**
 * 当前正在看的那一份。分组、成员、参照、待裁决全都挂在同一个编号上——换一份就
 * 是换一套数字，不能半路把其中一段换掉。
 */
export function current(): string | null {
  try {
    return localStorage.getItem(CURRENT)
  } catch {
    return null
  }
}

export function setCurrent(id: string | null): void {
  try {
    if (id) localStorage.setItem(CURRENT, id)
    else localStorage.removeItem(CURRENT)
  } catch {
    // 记不住就每次进来重新挑一份。
  }
}
