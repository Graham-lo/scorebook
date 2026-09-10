// 模型这一步到底做了什么，用交易员看得懂的话说出来。
//
// 事件流里只有工具的机器名（`search_records`、`publish_review`），照原样显示等
// 于什么也没说。这里把它翻成一句人话，并且分清三种性质：只是去读、要在后台算
// 一阵、以及会真的写进记录里——最后这一种永远要你先确认。

export type ToolEffect = 'read' | 'compute' | 'mutation'

interface ToolLook {
  label: string
  effect: ToolEffect
}

const TOOLS: Record<string, ToolLook> = {
  search_knowledge: { label: '在所有记下来的东西里找', effect: 'read' },
  read_source: { label: '读一条来源的原文', effect: 'read' },
  read_source_slice: { label: '接着读原文的下一段', effect: 'read' },
  search_records: { label: '翻你的记录', effect: 'read' },
  read_record: { label: '读一条判断和它后来的结果', effect: 'read' },
  episode_context: { label: '看这段行情里都挂着哪些记录', effect: 'read' },
  list_trades: { label: '看真实成交', effect: 'read' },
  list_trade_cycles: { label: '看一轮一轮的实盘', effect: 'read' },
  read_trade_cycle: { label: '读一轮实盘的明细', effect: 'read' },
  list_imports: { label: '看成交是从哪儿导进来的', effect: 'read' },
  list_exchange_connections: { label: '看你报上来的交易账户', effect: 'read' },
  get_trade_account_summary: { label: '看账户的账面小结', effect: 'read' },
  list_account_ledger: { label: '看资金费、转账这类流水', effect: 'read' },
  get_statistics: { label: '读一次统计的结果', effect: 'read' },
  statistics_groups: { label: '读这次统计的分组', effect: 'read' },
  statistics_members: { label: '核对这次统计里的每一条记录', effect: 'read' },
  get_baseline: { label: '看参照基准算到哪儿了', effect: 'read' },
  get_chart_search: { label: '看按图找的进度', effect: 'read' },
  history_catalog: { label: '查币安有哪些合约、历史到哪年', effect: 'read' },
  history_coverage: { label: '查历史索引覆盖到哪儿、缺哪一段', effect: 'read' },
  estimate_history: { label: '估算这段历史要占多大', effect: 'read' },
  get_history_plan: { label: '看历史索引建到哪儿了', effect: 'read' },
  get_history_subscription: { label: '看历史订阅的进度', effect: 'read' },
  knowledge_index_status: { label: '看还有多少东西没收进来', effect: 'read' },
  get_market_summary: { label: '取一段真实行情的摘要', effect: 'read' },
  chart_reference: { label: '取重画这张图要用的参数', effect: 'read' },
  get_job: { label: '看后台任务的状态', effect: 'read' },
  analyze_chart: { label: '认一认这张截图上的行情', effect: 'compute' },
  search_charts: { label: '按图去找形状像的', effect: 'compute' },
  create_statistics: { label: '起一次新的统计（后台算）', effect: 'compute' },
  create_baseline: { label: '算一次参照基准 B1（后台算）', effect: 'compute' },
  create_history_plan: { label: '建一段历史索引（后台建）', effect: 'compute' },
  publish_review: { label: '发布一条正式复盘', effect: 'mutation' },
  decide_verdict: { label: '下一次人工裁决', effect: 'mutation' },
  create_history_subscription: { label: '订上持续更新的历史', effect: 'mutation' },
}

export function toolLabel(name: string): string {
  return TOOLS[name]?.label ?? name
}

export function toolEffect(name: string): ToolEffect {
  return TOOLS[name]?.effect ?? 'read'
}

/** 写入类的操作，确认之前先把「这一步会改掉什么」讲清楚。 */
export const MUTATION_MEANING: Record<string, string> = {
  publish_review:
    '把一条复盘正式发布到某一条判断上。复盘发布之后不会被改写，只会一层层叠上去。',
  decide_verdict:
    '对某一组记录下一次裁决。裁决在后端记成「明确的人工决定」，理由会一起存下来。',
  create_history_subscription:
    '订上一段会持续增量建下去的历史索引。它会一直占用本机的存储，上限由 max_vectors 定死。',
}

/** 提案参数里那些字段，逐个翻成人话；没写在这里的按原名显示。 */
export const ARGUMENT_LABELS: Record<string, string> = {
  call_id: '哪一条判断',
  note: '复盘正文',
  better_play: '下次更好的打法',
  vs_last: '和上一次比',
  expected_revision: '基于第几版',
  expected_outcome_ids: '看过的结果',
  request_id: '哪一次待裁决',
  decision: '裁决结果',
  evidence: '理由',
  market: '市场',
  symbols: '品种',
  intervals: '周期',
  start_at: '从什么时候开始',
  source: '数据来源',
  max_vectors: '容量上限',
}

const VS_LAST: Record<string, string> = {
  better: '这次更好',
  same: '和上次一样',
  worse: '这次更差',
  first: '第一次',
}

const DECISION: Record<string, string> = {
  evidence: '认它是证据',
  observe: '继续观察',
  drop: '不再当回事',
}

/** 少数几个取值本身就是术语，顺手翻掉；其余原样显示。 */
export function argumentValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return '空着'
  if (field === 'vs_last' && typeof value === 'string') return VS_LAST[value] ?? value
  if (field === 'decision' && typeof value === 'string') return DECISION[value] ?? value
  if (Array.isArray(value)) return value.length ? value.map((v) => String(v)).join('、') : '空着'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
