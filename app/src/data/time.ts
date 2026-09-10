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

/* ------------------------------------------------------------------
   下面两个是 UTC 口径，只给公开行情用。
   K 线图是后端画的，横轴刻度写的是 UTC；如果卡片上按本地时区写日期，同一段
   行情会出现八小时的错位。所以跟图配套的那几处日期改成读 UTC，并且把「UTC」
   写在旁边——不是只换句说法，是真的换了取值的时区。
   记录、复盘这些属于用户自己的时间，仍然按读的人所在时区显示。
   ------------------------------------------------------------------ */

/** 2026-06-12 08:00 UTC。 */
export function utcDateTime(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return DASH
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** 一段行情的起止，同一天就只写一次日期。 */
export function utcRange(from: string | null | undefined, to: string | null | undefined): string {
  const a = parse(from)
  const b = parse(to)
  if (!a || !b) return DASH
  const sameDay = a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)
  return sameDay
    ? `${utcDateTime(from)} – ${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}`
    : `${utcDateTime(from)} – ${utcDateTime(to)}`
}

/**
 * 两个时刻之间隔了多久，说成人话。
 *
 * 记录详情把一次判断按发生顺序摊开，两段之间要说清「中间等了多久」——判断
 * 和答案之间隔了三天还是三个月，是这一条记录的分量本身。不满一分钟就说
 * 「几乎同时」，不编一个 0 分钟出来。
 */
export function elapsed(from: string | null | undefined, to: string | null | undefined): string | null {
  const a = parse(from)
  const b = parse(to)
  if (!a || !b) return null
  const ms = b.getTime() - a.getTime()
  if (ms < 60_000) return ms < 0 ? null : '几乎同时'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 24) {
    const rest = minutes - hours * 60
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
  }
  const days = Math.floor(ms / 86_400_000)
  if (days < 60) {
    const rest = hours - days * 24
    return rest ? `${days} 天 ${rest} 小时` : `${days} 天`
  }
  const months = Math.floor(days / 30)
  const rest = days - months * 30
  return rest ? `${months} 个月 ${rest} 天` : `${months} 个月`
}
