/** A period belongs to this screenshot/region, never a global search preference. */
export const SEARCH_PERIODS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
export type SearchPeriod = typeof SEARCH_PERIODS[number]

export class QueryPeriod {
  value: SearchPeriod | null = null

  select(value: string): void {
    if (!SEARCH_PERIODS.some(period => period === value)) throw new Error('请选择支持的 K 线周期。')
    this.value = value as SearchPeriod
  }

  reset(): void { this.value = null }

  /** Recognition is a suggestion. The trader confirms it using the same selector. */
  suggestion(value: string | null | undefined): SearchPeriod | null {
    return SEARCH_PERIODS.some(period => period === value) ? value as SearchPeriod : null
  }
}
