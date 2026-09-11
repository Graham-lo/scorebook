import { catalog } from '../../api/history'
import type { Market } from '../../api/types'
import { INTERVAL_SECONDS, type Interval } from '../../data/session'

/** Read catalog metadata only. Selecting this preset never starts a download/job. */
export async function lifecycleRange(market: Market, symbol: string, interval: Interval): Promise<{ start: Date; end: Date }> {
  const found = await catalog({ market, symbol })
  const entry = found.items.find(item => item.symbol === symbol && item.market === market)
  if (!entry?.onboard_at || ['archive_only', 'absent_from_current_catalog'].includes(entry.status)) {
    throw new Error('没有可核实的合约上线时间，请选择明确日期和对应的数据来源。')
  }
  const seconds = INTERVAL_SECONDS[interval]
  const start = new Date(Math.ceil(new Date(entry.onboard_at).getTime() / (seconds * 1000)) * seconds * 1000)
  const delivery = entry.delivery_at ? new Date(entry.delivery_at).getTime() : Infinity
  const end = new Date(Math.floor(Math.min(Date.now(), delivery) / (seconds * 1000)) * seconds * 1000)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new Error('这个合约还没有可用于匹配的完整历史区间。')
  }
  return { start, end }
}
