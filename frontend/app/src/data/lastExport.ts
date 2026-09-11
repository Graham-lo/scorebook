// 「上一次导出交给后端了没有」要记在本地：后端能按编号查一份导出的进度，但没有
// 「列出我导过哪些」的接口，刷新一下页面进度就找不回来了。
//
// 这里只存编号和开始时间。导出的内容一条都不进浏览器——要看要下载，都是现去后端拿。

export interface ExportEntry {
  /** 任务编号，也是这份导出的编号，两者是同一个。 */
  id: string
  started_at: string
}

const KEY = 'scorebook.export.v1'

export function read(): ExportEntry | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    const e = v as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.started_at !== 'string') return null
    return { id: e.id, started_at: e.started_at }
  } catch {
    return null
  }
}

export function remember(entry: ExportEntry): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entry))
  } catch {
    // 存不下就算了，只是刷新之后要重新导一次才能看到进度。
  }
}

export function forget(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 同上 */
  }
}
