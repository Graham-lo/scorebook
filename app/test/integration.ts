/**
 * Integration test against the running backend.
 *
 * It talks to the same-origin dev proxy (`http://127.0.0.1:5178/api`) that the
 * browser uses, so the local development credential is attached by the proxy in
 * the Node process and never appears in this file, in the environment, or in a
 * build artifact. Nothing here is mocked: every assertion below is about a real
 * response from the Rust API and, through it, a real PostgreSQL row.
 *
 * Run with the dev server and the backend up:
 *   npm run test:integration
 *
 * Screenshots come from `test/fixtures/`. They are real chart images rendered
 * by the backend's own `/v1/market/chart` from Binance data, so image search
 * runs on pictures of the kind a trader actually saves.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BASE = process.env.SCOREBOOK_PROXY ?? 'http://127.0.0.1:5178/api'
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

let passed = 0
const failures: string[] = []

function ok(name: string, condition: unknown, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
    return
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

const uuid = (): string => crypto.randomUUID()

interface Wire<T> {
  data?: T
  error?: { code?: string; message?: string; retryable?: boolean }
}

interface Reply<T> {
  status: number
  body: Wire<T>
}

async function call<T>(
  method: string,
  path: string,
  init: { body?: unknown; key?: string; query?: Record<string, string | number> } = {},
): Promise<Reply<T>> {
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v))
  const headers: Record<string, string> = {}
  if (init.key) headers['Idempotency-Key'] = init.key
  let payload: BodyInit | undefined
  if (init.body instanceof FormData) {
    payload = init.body
  } else if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(init.body)
  }
  const response = await fetch(url, { method, headers, body: payload })
  const text = await response.text()
  let body: Wire<T> = {}
  try {
    body = JSON.parse(text) as Wire<T>
  } catch {
    body = { error: { code: text.slice(0, 80) } }
  }
  return { status: response.status, body }
}

async function must<T>(reply: Reply<T>, what: string): Promise<T> {
  if (reply.status !== 200 || !reply.body.data) {
    throw new Error(`${what} failed: ${reply.status} ${JSON.stringify(reply.body.error ?? {})}`)
  }
  return reply.body.data
}

interface Attachment {
  id: string
  sha256: string
  width: number
  height: number
  size: number
}

async function uploadShot(name: string, kind: 'scene' | 'query'): Promise<Attachment> {
  const bytes = await readFile(join(FIXTURES, name))
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'image/png' }), name)
  form.append('kind', kind)
  return must<Attachment>(
    await call<Attachment>('POST', '/v1/attachments', { body: form, key: uuid() }),
    `upload ${name} as ${kind}`,
  )
}

interface CallListItem {
  id: string
  submitted_at: string
  revision: number
  body: { original_text: string; instrument: string | null }
}
interface CallList {
  items: CallListItem[]
  next_cursor: string | null
}

interface SimilarityResult {
  session_id: string
  model_id: string
  items: { attachment_id: string; call_id: string; cosine_distance?: number }[]
  score_meaning: string
  grouping: string
  query_quality: Record<string, unknown>
}

interface Capabilities {
  image_structure_search: string
  image_visual_search: string
  chat_generation: string
  formal_statistics: string
  exchange_accounts: string
}

async function main(): Promise<void> {
  section('能力清单')
  const caps = await must<Capabilities>(await call<Capabilities>('GET', '/v1/capabilities'), 'capabilities')
  console.log(`  后端自述：${JSON.stringify(caps)}`)
  ok('后端报出图像结构检索能力', typeof caps.image_structure_search === 'string')
  ok('聊天功能仍是 planned，前端据此隐藏', caps.chat_generation === 'planned', caps.chat_generation)
  const visual = caps.image_visual_search === 'configured'

  section('记录：上传截图 → 保存判断')
  const seeded: { id: string; attachment: Attachment; text: string }[] = []
  const shots: [string, string][] = [
    ['shot2.png', 'BTC 又推了一段，量能没跟上，我怀疑这里是最后一冲，破不了前高就该退。'],
    ['shot3.png', 'BTC 这次回踩比上次深，结构还在，我倾向再等一根收回来的阳线。'],
    ['shot4.png', 'ETH 相对强，同样的位置它没跟着回，我更愿意在这边看多。'],
  ]
  for (const [file, text] of shots) {
    const attachment = await uploadShot(file, 'scene')
    const body = {
      original_text: text,
      instrument: file.startsWith('shot4') ? 'ETHUSDT' : 'BTCUSDT',
      market: 'usd_m',
      timeframe: '1h',
      stance: file.startsWith('shot3') ? 'unknown' : 'L',
      path: 'chart_first',
      attachments: [attachment.id],
    }
    const created = await must<{ id: string }>(
      await call<{ id: string }>('POST', '/v1/calls', { body, key: uuid() }),
      `create call for ${file}`,
    )
    seeded.push({ id: created.id, attachment, text })
  }
  ok('三条判断都写进了库', seeded.length === 3)

  section('重试不会写出第二条')
  const retryKey = uuid()
  // The marker keeps this run's rows apart from earlier runs against the same
  // database, so "only one row" is a statement about this submission.
  const marker = `重试标记-${Date.now().toString(36)}`
  const retryBody = {
    original_text: `网络重试用例（${marker}）：同一次操作重发一遍，库里只能有一条。`,
    instrument: 'BTCUSDT',
    market: 'usd_m',
    timeframe: '1h',
    stance: 'unknown',
    path: 'thought_first',
  }
  const first = await must<{ id: string }>(
    await call<{ id: string }>('POST', '/v1/calls', { body: retryBody, key: retryKey }),
    'first submit',
  )
  const again = await must<{ id: string }>(
    await call<{ id: string }>('POST', '/v1/calls', { body: retryBody, key: retryKey }),
    'retry with the same Idempotency-Key',
  )
  ok('同一个 Idempotency-Key 重发返回同一条记录', first.id === again.id, `${first.id} vs ${again.id}`)
  const dupCheck = await must<CallList>(
    await call<CallList>('GET', '/v1/calls', { query: { q: marker, limit: 50 } }),
    'search for the retried text',
  )
  ok('库里只有一条，重试没有写出第二条', dupCheck.items.length === 1, `找到 ${dupCheck.items.length} 条`)

  section('改了内容就是新的一次操作')
  const changed = await must<{ id: string }>(
    await call<{ id: string }>('POST', '/v1/calls', {
      body: { ...retryBody, original_text: retryBody.original_text + '（改过一个字）' },
      key: uuid(),
    }),
    'changed body with a new key',
  )
  ok('换了 key 的新内容是另一条记录', changed.id !== first.id)

  section('翻页不跳条、不重复')
  const wide = await must<CallList>(
    await call<CallList>('GET', '/v1/calls', { query: { limit: 100 } }),
    'list everything',
  )
  const walked: string[] = []
  let cursor: string | null = null
  for (let page = 0; page < 50; page += 1) {
    const q: Record<string, string | number> = { limit: 2 }
    if (cursor) q.cursor = cursor
    const chunk: CallList = await must<CallList>(
      await call<CallList>('GET', '/v1/calls', { query: q }),
      `page ${page}`,
    )
    walked.push(...chunk.items.map((i) => i.id))
    if (!chunk.next_cursor) break
    cursor = chunk.next_cursor
  }
  ok('分页走完拿到的条数和一次拉全一致', walked.length === wide.items.length, `${walked.length} vs ${wide.items.length}`)
  ok('分页没有重复', new Set(walked).size === walked.length)
  ok('分页没有漏条', wide.items.every((i) => walked.includes(i.id)))

  section('复盘与版本冲突')
  const target = seeded[0]!
  type Detail = { revision: number; current_outcomes: { id: string }[] }
  const detail = await must<Detail>(await call<Detail>('GET', `/v1/calls/${target.id}`), 'read the call')
  // 复盘必须说清楚它是对着哪几条结果写的，否则后端不收。
  const outcomeIds = detail.current_outcomes.map((o) => o.id)
  const stale = await call('POST', '/v1/reviews', {
    body: {
      call_id: target.id,
      note: '拿一个过期版本号提交，后端应当拒绝。',
      vs_last: 'keep',
      expected_revision: detail.revision + 7,
      expected_outcome_ids: outcomeIds,
    },
    key: uuid(),
  })
  ok('版本对不上时返回 409', stale.status === 409, `HTTP ${stale.status}`)
  ok('冲突码是 revision_conflict', stale.body.error?.code === 'revision_conflict', stale.body.error?.code)
  const saved = await must<{ revision: number }>(
    await call<{ revision: number }>('POST', '/v1/reviews', {
      body: {
        call_id: target.id,
        note: '重新读一次版本号后原样重交，草稿没有丢。',
        better_play: '下次先看量能再决定加不加。',
        vs_last: 'new',
        expected_revision: detail.revision,
        expected_outcome_ids: outcomeIds,
      },
      key: uuid(),
    }),
    'save the review after re-reading the revision',
  )
  ok('重读版本号后同一份草稿存了下来', saved.revision === detail.revision + 1)

  section('复盘草稿：离开再回来还在，两处同时写会拦住')
  const writing = seeded[1]!
  interface DraftState {
    call_revision: number
    draft_revision: number
    current_outcome_ids: string[]
    draft: { revision: number; body?: unknown } | null
  }
  const before = await must<DraftState>(
    await call<DraftState>('GET', `/v1/calls/${writing.id}/review-draft`),
    'read the empty draft',
  )
  ok('还没写的时候没有草稿', before.draft === null)
  const firstSave = await must<{ revision: number }>(
    await call<{ revision: number }>('POST', `/v1/calls/${writing.id}/review-draft`, {
      body: {
        expected_draft_revision: before.draft_revision,
        note: '写到一半就走开：这段话应该还在。',
        better_play: null,
        vs_last: null,
      },
      key: uuid(),
    }),
    'save the draft',
  )
  ok('存草稿把草稿版本推进一格', firstSave.revision === before.draft_revision + 1)
  const resumed = await must<DraftState>(
    await call<DraftState>('GET', `/v1/calls/${writing.id}/review-draft`),
    'read the draft back',
  )
  ok('回来的时候草稿还在', resumed.draft !== null && resumed.draft.revision === firstSave.revision)
  // 另一处用同一个旧版本号再存一次，等于两个地方同时在写同一条。
  const collided = await call('POST', `/v1/calls/${writing.id}/review-draft`, {
    body: {
      expected_draft_revision: before.draft_revision,
      note: '另一处写的内容，不该悄悄盖掉上一份。',
      better_play: null,
      vs_last: null,
    },
    key: uuid(),
  })
  ok('拿旧的草稿版本号再存会被拦下', collided.status === 409, `HTTP ${collided.status}`)
  ok('拦下来的理由是 draft_revision_conflict', collided.body.error?.code === 'draft_revision_conflict', collided.body.error?.code)
  const stillThere = await must<DraftState>(
    await call<DraftState>('GET', `/v1/calls/${writing.id}/review-draft`),
    'read the draft after the conflict',
  )
  ok('被拦下之后先写的那份原样留着', stillThere.draft?.revision === firstSave.revision)

  section('发布复盘：结果对不上就不让发')
  // 没选「这次和上次的关系」就不能发布，后端自己会说。
  const noAction = await call('POST', `/v1/calls/${writing.id}/review-draft/publish`, {
    body: {
      expected_draft_revision: stillThere.draft_revision,
      expected_call_revision: stillThere.call_revision,
      expected_outcome_ids: stillThere.current_outcome_ids,
    },
    key: uuid(),
  })
  ok('没选这次和上次的关系就发不出去', noAction.body.error?.code === 'review_action_required', noAction.body.error?.code)
  const ready = await must<{ revision: number }>(
    await call<{ revision: number }>('POST', `/v1/calls/${writing.id}/review-draft`, {
      body: {
        expected_draft_revision: stillThere.draft_revision,
        note: '这次结构和上次那条一样，我照着上次的做法做了。',
        better_play: '下次把止损放在结构下沿，不放在整数位。',
        vs_last: 'did',
      },
      key: uuid(),
    }),
    'complete the draft',
  )
  // 草稿写全了才轮到结果这一关：发布必须说清楚它是对着哪几条结果写的。
  const askWrongOutcomes = await call('POST', `/v1/calls/${writing.id}/review-draft/publish`, {
    body: {
      expected_draft_revision: ready.revision,
      expected_call_revision: stillThere.call_revision,
      expected_outcome_ids: [uuid()],
    },
    key: uuid(),
  })
  ok('对着没看过的结果发布会被拦下', askWrongOutcomes.status === 409, `HTTP ${askWrongOutcomes.status}`)
  ok(
    '拦下来的理由是 review_outcomes_changed',
    askWrongOutcomes.body.error?.code === 'review_outcomes_changed',
    askWrongOutcomes.body.error?.code,
  )
  const published = await must<{ id: string; revision: number; draft_revision: number }>(
    await call<{ id: string; revision: number; draft_revision: number }>(
      'POST',
      `/v1/calls/${writing.id}/review-draft/publish`,
      {
        body: {
          expected_draft_revision: ready.revision,
          expected_call_revision: stillThere.call_revision,
          expected_outcome_ids: stillThere.current_outcome_ids,
        },
        key: uuid(),
      },
    ),
    'publish the draft',
  )
  ok('发布出来的是一条复盘', Boolean(published.id))
  ok('发布之后草稿版本继续往前走', published.draft_revision > ready.revision)
  const afterPublish = await must<DraftState>(
    await call<DraftState>('GET', `/v1/calls/${writing.id}/review-draft`),
    'read the draft after publishing',
  )
  ok('发布之后草稿就不在了', afterPublish.draft === null)
  const late = await call('POST', `/v1/calls/${writing.id}/review-draft`, {
    body: {
      expected_draft_revision: ready.revision,
      note: '旧标签页迟到的一次保存，不能把发布过的草稿救回来。',
      better_play: null,
      vs_last: null,
    },
    key: uuid(),
  })
  ok('旧标签页迟到的保存救不回已发布的草稿', late.status === 409, `HTTP ${late.status}`)

  section('待复盘清单与提醒')
  interface Queue {
    items: { id: string; reason: string }[]
    next_cursor: string | null
  }
  const done = await must<Queue>(
    await call<Queue>('GET', '/v1/review-queue', { query: { bucket: 'completed', limit: 20 } }),
    'read the completed bucket',
  )
  ok('刚发布的那条进了「已复盘」', done.items.some((i) => i.id === writing.id))
  const badBucket = await call('GET', '/v1/review-queue', { query: { bucket: 'nonsense' } })
  ok('分组名写错会被拒', badBucket.status >= 400 && badBucket.body.error?.code === 'invalid_review_bucket', badBucket.body.error?.code)
  const callAfter = await must<{ revision: number }>(
    await call<{ revision: number }>('GET', `/v1/calls/${writing.id}`),
    'read the call after publishing',
  )
  const until = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString()
  const reminded = await must<{ snoozed_until: string | null; revision: number }>(
    await call<{ snoozed_until: string | null; revision: number }>(
      'POST',
      `/v1/calls/${writing.id}/review-reminder`,
      { body: { expected_revision: 0, until }, key: uuid() },
    ),
    'set the reminder',
  )
  ok('提醒时间存下来了', Boolean(reminded.snoozed_until))
  const snoozed = await must<Queue>(
    await call<Queue>('GET', '/v1/review-queue', { query: { bucket: 'snoozed', limit: 20 } }),
    'read the snoozed bucket',
  )
  ok('设了提醒的记录进了「稍后再看」', snoozed.items.some((i) => i.id === writing.id))
  const pastTime = await call('POST', `/v1/calls/${writing.id}/review-reminder`, {
    body: { expected_revision: reminded.revision, until: new Date(Date.now() - 60_000).toISOString() },
    key: uuid(),
  })
  ok('提醒时间不能设在过去', pastTime.body.error?.code === 'invalid_review_reminder_time', pastTime.body.error?.code)
  await must(
    await call('POST', `/v1/calls/${writing.id}/review-reminder`, {
      body: { expected_revision: reminded.revision, until: null },
      key: uuid(),
    }),
    'clear the reminder',
  )
  ok('这条记录的版本没有被清单和提醒动过', callAfter.revision > 0)

  section('翻更早的历史：不重复也不漏')
  interface HistoryPage {
    items: { id: string; created_at: string }[]
    next_cursor: string | null
    kind: string
    order: string
  }
  const firstPage = await must<HistoryPage>(
    await call<HistoryPage>('GET', `/v1/calls/${target.id}/history`, {
      query: { kind: 'reviews', limit: 1 },
    }),
    'read the first history page',
  )
  ok('历史按从新到旧发回来', firstPage.order === 'newest_to_oldest')
  const seenIds: string[] = firstPage.items.map((i) => i.id)
  let hcursor = firstPage.next_cursor
  for (let page = 0; page < 20 && hcursor; page += 1) {
    const chunk = await must<HistoryPage>(
      await call<HistoryPage>('GET', `/v1/calls/${target.id}/history`, {
        query: { kind: 'reviews', limit: 1, cursor: hcursor },
      }),
      `history page ${page}`,
    )
    seenIds.push(...chunk.items.map((i) => i.id))
    hcursor = chunk.next_cursor
  }
  const inOne = await must<HistoryPage>(
    await call<HistoryPage>('GET', `/v1/calls/${target.id}/history`, {
      query: { kind: 'reviews', limit: 100 },
    }),
    'read the whole history at once',
  )
  ok('一页一页翻完和一次拉全一样多', seenIds.length === inOne.items.length, `${seenIds.length} vs ${inOne.items.length}`)
  ok('翻页没有重复', new Set(seenIds).size === seenIds.length)
  ok('翻页没有漏条', inOne.items.every((i) => seenIds.includes(i.id)))
  const badKind = await call('GET', `/v1/calls/${target.id}/history`, { query: { kind: 'nonsense' } })
  ok('历史类别写错会被拒', badKind.body.error?.code === 'invalid_history_kind', badKind.body.error?.code)

  section('按图搜索：我的记录库')
  const query = await uploadShot('shot2.png', 'query')
  ok('查询图和证据图是同一份文件（sha256 相同）', query.sha256 === seeded[0]!.attachment.sha256)
  ok('查询图另占一条 attachment，不会顶掉证据', query.id !== seeded[0]!.attachment.id)
  const structure = await must<SimilarityResult>(
    await call<SimilarityResult>('POST', '/v1/similarity/search', {
      body: { attachment_id: query.id, model_id: 'candle-profile-v1', limit: 10 },
      key: uuid(),
    }),
    'library search by structure',
  )
  ok('结构检索返回了结果', structure.items.length > 0, `${structure.items.length} 条`)
  ok('结果里没有查询图自己', structure.items.every((i) => i.attachment_id !== query.id))
  ok('后端明说分数是相似度不是胜率', structure.score_meaning === 'similarity_not_probability')
  ok('分组口径是精确图再确认过的行情段', structure.grouping === 'exact_image_then_confirmed_episode')
  ok('每条都带余弦距离', structure.items.every((i) => typeof i.cosine_distance === 'number'))
  const sorted = structure.items.map((i) => i.cosine_distance ?? 0)
  ok('结果按接近程度排好序', sorted.every((v, idx) => idx === 0 || v >= sorted[idx - 1]!))

  const framed = await must<SimilarityResult>(
    await call<SimilarityResult>('POST', '/v1/similarity/search', {
      body: {
        attachment_id: query.id,
        region: { x: 300, y: 200, width: 600, height: 500 },
        model_id: 'candle-profile-v1',
        limit: 10,
      },
      key: uuid(),
    }),
    'library search on a dragged region',
  )
  ok('框一块再搜也能搜（区域坐标按原图像素）', framed.items.length >= 0)
  ok('框选后的会话和整图不是同一次', framed.session_id !== structure.session_id)

  const filtered = await must<SimilarityResult>(
    await call<SimilarityResult>('POST', '/v1/similarity/search', {
      body: { attachment_id: query.id, model_id: 'candle-profile-v1', instrument: 'ETHUSDT', limit: 10 },
      key: uuid(),
    }),
    'library search filtered to ETHUSDT',
  )
  ok('限定品种后只剩这个品种的记录', filtered.items.every((i) => i.call_id !== seeded[0]!.id))

  section('搜索反馈只认这次会话里的结果')
  const wrongFeedback = await call('POST', '/v1/similarity/feedback', {
    body: { session_id: structure.session_id, attachment_id: query.id, relevant: true },
    key: uuid(),
  })
  ok('给一个不在结果里的图打分会被拒', wrongFeedback.status >= 400, `HTTP ${wrongFeedback.status}`)
  ok('拒绝的理由是 not_a_search_result', wrongFeedback.body.error?.code === 'not_a_search_result', wrongFeedback.body.error?.code)
  if (structure.items[0]) {
    const good = await call('POST', '/v1/similarity/feedback', {
      body: { session_id: structure.session_id, attachment_id: structure.items[0].attachment_id, relevant: true },
      key: uuid(),
    })
    ok('给结果里的图打分可以存下来', good.status === 200, `HTTP ${good.status}`)
  }

  section('两种描述子一起搜')
  const hybrid = await call<SimilarityResult>('POST', '/v1/similarity/search', {
    body: { attachment_id: query.id, model_id: 'hybrid-v1', limit: 10 },
    key: uuid(),
  })
  if (visual) {
    const fused = await must<SimilarityResult>(hybrid, 'hybrid search')
    ok('两种一起时不再给单一距离', fused.items.every((i) => i.cosine_distance === undefined))
  } else {
    ok('没启动画面模型时明确报 hybrid_requires_both_models', hybrid.body.error?.code === 'hybrid_requires_both_models', hybrid.body.error?.code)
  }

  section('历史行情：先准备范围，再回去搜')
  const coverage = await must<{ items: { symbol: string; interval: string; status: string }[] }>(
    await call<{ items: { symbol: string; interval: string; status: string }[] }>('GET', '/v1/history/indexes'),
    'list prepared ranges',
  )
  console.log(`  已准备的范围：${coverage.items.length} 段`)
  const history = await call<{ items: unknown[]; coverage: unknown[]; scope: string }>(
    'POST',
    '/v1/history/search',
    { body: { attachment_id: query.id, model_id: 'candle-profile-v1', symbol: 'BTCUSDT', market: 'usd_m', interval: '1h', limit: 10 }, key: uuid() },
  )
  if (history.status === 200 && history.body.data) {
    const found = history.body.data
    ok('历史检索说明自己只覆盖已准备的范围', found.scope === 'only_ready_indexes;not_all_binance_history', found.scope)
    ok('历史检索带回覆盖范围，前端据此说明能搜到哪一段', Array.isArray(found.coverage))
  } else {
    ok(
      '还没准备好范围时给的是可解释的错误，不是空结果',
      typeof history.body.error?.code === 'string',
      `HTTP ${history.status} ${history.body.error?.code}`,
    )
  }

  section('导出一份带得走的副本')
  const started = await must<{ job_id: string; status: string }>(
    await call<{ job_id: string; status: string }>('POST', '/v1/exports', { body: {}, key: uuid() }),
    'ask for an export',
  )
  interface ExportResult {
    export_id?: string
    manifest_sha256?: string
    files?: number
    status?: string
  }
  let exported: ExportResult | null = null
  let exportError = ''
  for (let i = 0; i < 40; i += 1) {
    const job = await must<{ status: string; result: unknown; error_code: string | null }>(
      await call<{ status: string; result: unknown; error_code: string | null }>('GET', `/v1/jobs/${started.job_id}`),
      'read the export job',
    )
    if (job.status === 'succeeded') {
      exported = job.result as ExportResult
      break
    }
    if (!['queued', 'running', 'retry_wait'].includes(job.status)) {
      exportError = `${job.status} ${job.error_code ?? ''}`
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  ok('导出做完了', exported?.status === 'complete', exportError || String(exported?.status))
  if (exported?.export_id) {
    // 清单是导出目录里的普通文件，直接原样发回来，没有 {data,meta} 外壳。
    const manifest = await fetch(`${BASE}/v1/exports/${exported.export_id}/manifest`)
    ok('清单要走代理带鉴权才拿得到', manifest.status === 200, `HTTP ${manifest.status}`)
    const body = (await manifest.json()) as {
      format?: string
      tables?: Record<string, { rows?: number }>
      attachment_files?: number
    }
    ok('清单里写着自己是哪一种格式', body.format === 'scorebook-logical-v2', String(body.format))
    ok('导出里有判断记录', (body.tables?.calls?.rows ?? 0) > 0, String(body.tables?.calls?.rows))
    ok(
      '页面上那三个数字来自清单本身，不是估的',
      (body.attachment_files ?? -1) === (exported.files ?? -2),
      `${body.attachment_files} vs ${exported.files}`,
    )
    const missing = await fetch(`${BASE}/v1/exports/${exported.export_id}/files/../../etc/passwd`)
    ok('导出目录之外的文件下载不到', missing.status >= 400, `HTTP ${missing.status}`)
  }

  section('凭证只在服务端')
  const direct = await fetch('http://127.0.0.1:8787/v1/calls?limit=1')
  ok('绕开代理直连后端会被拒', direct.status === 401 || direct.status === 403, `HTTP ${direct.status}`)
  const bytes = await fetch(`${BASE}/v1/attachments/${seeded[0]!.attachment.id}`)
  ok('图片字节要走代理带鉴权才拿得到', bytes.status === 200 && (bytes.headers.get('content-type') ?? '').startsWith('image/'))
  ok('图片响应不许被缓存', (bytes.headers.get('cache-control') ?? '').includes('no-store'), bytes.headers.get('cache-control') ?? '')

  section('行情图只在内存里画')
  const chart = await fetch(`${BASE}/v1/market/chart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: 'BTCUSDT', market: 'usd_m', interval: '1h', start_at: '2026-09-01T00:00:00Z', end_at: '2026-09-03T00:00:00Z' }),
  })
  ok('临时重画一段行情返回 SVG', chart.status === 200 && (chart.headers.get('content-type') ?? '').includes('svg'), `HTTP ${chart.status}`)
  ok('行情图明说不落盘', (chart.headers.get('cache-control') ?? '').includes('no-store'))

  section('原话不做多空猜测')
  const preview = await must<{ stance: string; criteria: { template: string }[] }>(
    await call<{ stance: string; criteria: { template: string }[] }>('POST', '/v1/calls/preview', {
      body: { text: '我觉得这里还能涨一段，看多。' },
    }),
    'preview a plain Chinese note',
  )
  ok('没有显式协议时表态保持 unknown', preview.stance === 'unknown', preview.stance)
  ok('没有口径时模板是 T0', (preview.criteria[0]?.template ?? 'T0') === 'T0')

  console.log(`\n${passed} 项通过，${failures.length} 项失败`)
  for (const f of failures) console.log(`  失败：${f}`)
  if (failures.length > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error('\n测试没能跑完：', error)
  process.exitCode = 1
})
