// 一条命中来自哪一类记录。
//
// 后端的 `source_kind` 是表名一样的词（`episode_link`、`submission_feedback`），
// 交易者不该在界面上读到它们。这里只做一件事：把它翻成人话，并且说清楚这类东西
// 是谁写的——自己当时写的、后来复盘写的，还是系统按规则算出来的。分不清这一点，
// 「我早就说过」和「系统事后给的结论」就会混成一句话。

export interface KindLook {
  label: string
  /** 谁留下的：`mine` 自己写的，`system` 系统算的，`market` 实盘或行情那边来的。 */
  hand: 'mine' | 'system' | 'market'
}

const KINDS: Record<string, KindLook> = {
  call: { label: '当时的判断', hand: 'mine' },
  review: { label: '后来的复盘', hand: 'mine' },
  outcome: { label: '系统给的结论', hand: 'system' },
  tag: { label: '局面类别', hand: 'mine' },
  tag_lineage: { label: '类别改过的样子', hand: 'mine' },
  playbook: { label: '我的做法', hand: 'mine' },
  playbook_event: { label: '做法的变化', hand: 'mine' },
  episode: { label: '一段行情', hand: 'market' },
  episode_link: { label: '记录挂在哪段行情上', hand: 'mine' },
  episode_review: { label: '一段行情的复盘', hand: 'mine' },
  execution_link: { label: '记录对上的实盘', hand: 'mine' },
  execution_summary: { label: '实盘小结', hand: 'market' },
  import_receipt: { label: '一次成交导入', hand: 'market' },
  position_seed: { label: '报上来的起始仓位', hand: 'mine' },
  reconciliation: { label: '一次对账', hand: 'market' },
  submission_feedback: { label: '记录时的提醒', hand: 'system' },
  attachment: { label: '我传的图', hand: 'mine' },
  statistics: { label: '一次统计', hand: 'system' },
  verdict: { label: '一次裁决', hand: 'mine' },
  baseline: { label: '一次参照基准', hand: 'system' },
  tool_result: { label: '问答时查到的资料', hand: 'system' },
}

export function kindLook(kind: string): KindLook {
  return KINDS[kind] ?? { label: kind, hand: 'system' }
}

/**
 * 能直接跳过去的那两类。命中里的 `source_id` 是那一类自己的编号——复盘的编号不是
 * 记录的编号，行情复盘的编号也不是那段行情的编号，所以别的类不给跳转链接，免得
 * 点过去落到一个不存在的页面上。其余的就在这里读原文。
 */
export function routeFor(kind: string, id: string): string | null {
  if (kind === 'call') return `call/${id}`
  if (kind === 'episode') return `episode/${id}`
  return null
}
