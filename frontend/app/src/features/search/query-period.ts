import { INTERVALS } from '../../data/session'

/** A period belongs to this screenshot/region, never a global search preference. */
export const SEARCH_PERIODS = INTERVALS
export type SearchPeriod = typeof SEARCH_PERIODS[number]

/** 「不限周期」：只比形状，周期交给命中的那一条自己说。它不是周期，是另一种选择。 */
export const ANY_PERIOD = 'any'
export type PeriodChoice = SearchPeriod | typeof ANY_PERIOD

export class QueryPeriod {
  /** 三种状态：选了某个周期 / 选了「不限」/ 还没选。 */
  value: PeriodChoice | null = null

  select(value: string): void {
    if (!SEARCH_PERIODS.some(period => period === value)) throw new Error('请选择支持的 K 线周期。')
    this.value = value as SearchPeriod
  }

  /** 人明说了「不限周期」。它只能是人点出来的，不从形状猜，也没有默认值。 */
  selectAny(): void { this.value = ANY_PERIOD }

  reset(): void { this.value = null }

  /** 人做过选择没有——具体周期和「不限」都算做过。 */
  get chosen(): boolean { return this.value !== null }

  get anyInterval(): boolean { return this.value === ANY_PERIOD }

  /** 挑中的那个具体周期；选了「不限」或者还没选就是 null。 */
  get interval(): SearchPeriod | null {
    return this.value === null || this.value === ANY_PERIOD ? null : this.value
  }

  /** Recognition is a suggestion. The trader confirms it using the same selector. */
  suggestion(value: string | null | undefined): SearchPeriod | null {
    return SEARCH_PERIODS.some(period => period === value) ? value as SearchPeriod : null
  }
}
