// 「去准备历史」这一步会把人从检索结果带走。带走之前把这次问的是什么记下来，
// 准备页上就能给一条回去的路——回去之后图、框、周期、范围都还在原处（检索页
// 的状态本来就活在模块里，不随路由重建）。
//
// 只在内存里放着。刷新页面就没了，那时候检索页的状态也一起没了，两边一致。

export interface QueryContext {
  /** 查询图的附件 id。只是个引用，图本身不在这儿。 */
  attachmentId: string
  /** 当时选的周期，可能还没选。 */
  interval: string | null
  scope: 'private' | 'binance_history'
  symbol: string | null
  market: 'usd_m' | 'coin_m' | null
}

let pending: QueryContext | null = null

export function rememberQuery(context: QueryContext): void {
  pending = context
}

export function pendingQuery(): QueryContext | null {
  return pending
}

export function forgetQuery(): void {
  pending = null
}
