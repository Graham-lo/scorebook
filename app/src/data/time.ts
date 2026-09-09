// Instants travel as UTC RFC 3339 and are shown in the reader's own zone.
// Nothing here re-computes a timestamp; it only formats one.

const MONTHS = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
]

export const DASH = '—'

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 9月9日 18:24 — the everyday stamp, in the local zone. */
export function dateTime(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return DASH
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function dateOnly(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return DASH
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

export function shortDate(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return DASH
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** The three lines of the ledger's date column. */
export function columnParts(iso: string): { day: string; month: string; time: string } {
  const d = parse(iso)
  if (!d) return { day: DASH, month: '', time: '' }
  return {
    day: String(d.getDate()),
    month: MONTHS[d.getMonth()] ?? '',
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/** "3 小时前" for anything inside a week, an absolute date beyond it. */
export function relative(iso: string | null | undefined, now = Date.now()): string {
  const d = parse(iso)
  if (!d) return DASH
  const delta = now - d.getTime()
  const minutes = Math.round(delta / 60_000)
  if (Math.abs(minutes) < 1) return '刚刚'
  if (Math.abs(minutes) < 60) return minutes > 0 ? `${minutes} 分钟前` : `${-minutes} 分钟后`
  const hours = Math.round(delta / 3_600_000)
  if (Math.abs(hours) < 24) return hours > 0 ? `${hours} 小时前` : `${-hours} 小时后`
  const days = Math.round(delta / 86_400_000)
  if (Math.abs(days) <= 7) return days > 0 ? `${days} 天前` : `${-days} 天后`
  return dateTime(iso)
}

/** A closed range, collapsed when both ends land on the same day. */
export function range(from: string | null, to: string | null): string {
  if (!from || !to) return DASH
  const a = parse(from)
  const b = parse(to)
  if (!a || !b) return DASH
  const sameDay = a.toDateString() === b.toDateString()
  return sameDay ? `${dateTime(from)} – ${pad(b.getHours())}:${pad(b.getMinutes())}` : `${dateTime(from)} – ${dateTime(to)}`
}

/** Hours as a trader says them: 72 小时, 7 天. */
export function horizon(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return DASH
  if (hours % 24 === 0 && hours >= 24) return `${hours / 24} 天`
  return `${hours} 小时`
}

export function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null
}
