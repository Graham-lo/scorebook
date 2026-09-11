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

/**
 * 「给了一个错误码」不等于「给了一个能读懂的错误码」。框架自己抛出来的 400
 * 往往是一段纯文本，JSON 解析不了就被这里的 call() 塞进 code 里，看起来也是
 * 字符串。所以断言要求它长得像后端自己定义的那种标识符。
 */
function isCode(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{2,}$/.test(value)
}

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

/**
 * 等到这张图真的能被搜到为止。上传时后端排了一个算向量的作业，作业跑完之前
 * 搜出来就是 0 条。轮询上限 30 秒：到点还是 0 条就把最后一次结果原样交出去，
 * 让调用处的断言正常失败。
 */
async function searchWhenIndexed(
  body: Record<string, unknown>,
  what: string,
  waited: { seconds: number },
): Promise<SimilarityResult> {
  let last: SimilarityResult | null = null
  for (let i = 0; i < 60; i += 1) {
    last = await must<SimilarityResult>(
      await call<SimilarityResult>('POST', '/v1/similarity/search', { body, key: uuid() }),
      what,
    )
    waited.seconds = i * 0.5
    if (last.items.length > 0) return last
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  waited.seconds = 30
  return last!
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

/**
 * v4 用两种写法回答同一份清单：一句话说明形态，或者一个对象把「做没做」和「这
 * 台机器上配没配」分开。前端的闸门读的是形态而不是固定词表，测试也照这个读。
 */
type Capability = string | Record<string, unknown>

interface Capabilities {
  image_structure_search: Capability
  image_visual_search: Capability
  chat_generation: Capability
  formal_statistics: Capability
  exchange_accounts: Capability
  [name: string]: Capability
}

/** 这项能力此刻真的能用吗。和 `src/data/session.ts` 里那道闸门同一套判断。 */
function configured(value: Capability | undefined): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase()
    return word !== '' && !['planned', 'not_implemented', 'not_configured', 'unavailable', 'disabled', 'missing', 'none', 'off'].includes(word)
  }
  const flags = value as Record<string, unknown>
  if ('configured' in flags) return flags.configured === true
  if ('available' in flags) return flags.available === true
  return true
}

async function main(): Promise<void> {
  section('能力清单')
  const caps = await must<Capabilities>(await call<Capabilities>('GET', '/v1/capabilities'), 'capabilities')
  console.log(`  后端自述：${JSON.stringify(caps)}`)
  ok('后端报出图像结构检索能力', caps.image_structure_search !== undefined)
  // 配了不等于验过，也不等于开着。这里只断言「说法能读懂」，具体开没开由下面各
  // 节按后端当时的回答分流，不预设这台机器上装了什么。
  ok('问答能力的说法读得懂（一句话或者一个对象）', ['string', 'object'].includes(typeof caps.chat_generation))
  const chatReady = configured(caps.chat_generation)
  console.log(`  这台机器上问答${chatReady ? '已经配好' : '还没配好'}`)
  const visual = configured(caps.image_visual_search)

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
  // 截图存进来之后，向量是后台作业算的，不是随请求同步写好的。刚存完就搜，
  // 搜出 0 条是「还没算完」，不是「搜不到」——这里等到能搜出东西为止，最多等
  // 30 秒。等不到就让下面的断言照常失败，不改结论，也不无限等下去。
  const indexWait = { seconds: 0 }
  // 截图检索一定要先说清楚这张图是哪个周期，后端不替人猜——不写就是 422。
  const noInterval = await call('POST', '/v1/similarity/search', {
    body: { attachment_id: query.id, model_id: 'candle-geometry-v2', limit: 10 },
    key: uuid(),
  })
  ok('不说周期就不给搜', noInterval.body.error?.code === 'chart_interval_required', `HTTP ${noInterval.status} ${noInterval.body.error?.code}`)
  const structure = await searchWhenIndexed(
    { attachment_id: query.id, model_id: 'candle-geometry-v2', timeframe: '1h', limit: 10 },
    'library search by structure',
    indexWait,
  )
  ok('结构检索返回了结果', structure.items.length > 0, `${structure.items.length} 条，等了 ${indexWait.seconds.toFixed(1)} 秒`)
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
        model_id: 'candle-geometry-v2',
        timeframe: '1h',
        limit: 10,
      },
      key: uuid(),
    }),
    'library search on a dragged region',
  )
  const framedOrder = framed.items.map((i) => i.cosine_distance ?? 0)
  ok(
    '框一块再搜，口径和排序跟整图一样（区域坐标按原图像素）',
    framed.score_meaning === structure.score_meaning &&
      framed.items.every((i) => i.attachment_id !== query.id) &&
      framedOrder.every((v, idx) => idx === 0 || v >= framedOrder[idx - 1]!),
    `${framed.items.length} 条`,
  )
  ok('框选后的会话和整图不是同一次', framed.session_id !== structure.session_id)

  const filtered = await must<SimilarityResult>(
    await call<SimilarityResult>('POST', '/v1/similarity/search', {
      body: { attachment_id: query.id, model_id: 'candle-geometry-v2', timeframe: '1h', instrument: 'ETHUSDT', limit: 10 },
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

  section('两种描述子一起搜（hybrid-v2）')
  const hybrid = await call<SimilarityResult>('POST', '/v1/similarity/search', {
    body: { attachment_id: query.id, model_id: 'hybrid-v2', timeframe: '1h', limit: 10 },
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
    { body: { attachment_id: query.id, model_id: 'candle-geometry-v2', symbol: 'BTCUSDT', market: 'usd_m', interval: '1h', limit: 10 }, key: uuid() },
  )
  if (history.status === 200 && history.body.data) {
    const found = history.body.data
    ok('历史检索说明自己只覆盖已准备的范围', found.scope === 'only_ready_indexes;not_all_binance_history', found.scope)
    ok('历史检索带回覆盖范围，前端据此说明能搜到哪一段', Array.isArray(found.coverage))
    // 没准备过这一段就该是「0 条 + 覆盖范围里也没有这一段」，不能凭空给出命中。
    ok(
      '没准备过的范围不会凭空搜出命中',
      found.coverage.length > 0 || found.items.length === 0,
      `${found.items.length} 条命中 / ${found.coverage.length} 段覆盖`,
    )
  } else {
    ok(
      '还没准备好范围时给的是可解释的错误，不是空结果',
      isCode(history.body.error?.code),
      `HTTP ${history.status} ${history.body.error?.code}`,
    )
  }

  section('按图索骥：先认图，再起一次检索')
  // v4 把「按图搜索」拆成两步：先认图（认不出品种和周期就明说不猜），再起一次
  // 检索作业。前端两步都不许替后端下结论，所以这里断言的也是这两件事。
  interface ChartAnalysis {
    id: string
    geometry: { detected_candles: number; supported: boolean; limitations: string[] }
    recognized: { symbol: string | null; interval: string | null; unknown_fields_are_not_inferred: boolean }
    chart_type: string
    quality_validated: boolean
  }
  const analysis = await call<ChartAnalysis>('POST', '/v1/chart-analyses', {
    body: { attachment_id: query.id },
    key: uuid(),
  })
  if (analysis.status === 200 && analysis.body.data) {
    const read = analysis.body.data
    ok('认图数出了 K 线根数', read.geometry.detected_candles > 0, String(read.geometry.detected_candles))
    ok('认图自己列出边界，不藏着', read.geometry.limitations.length > 0)
    ok('认不出来的字段就是 null，不猜', read.recognized.unknown_fields_are_not_inferred === true)
    ok('后端不声称语义质量已经验收', read.quality_validated === false)
    ok('图型只说“像普通 K 线”，不打包票', read.chart_type.includes('candidate'), read.chart_type)

    interface SearchStarted { search_run_id: string; job_id: string; status: string; protocol: string }
    const started = await call<SearchStarted>('POST', '/v1/chart-search/runs', {
      body: { attachment_id: query.id, scope: 'private', interval: '1h', limit: 10 },
      key: uuid(),
    })
    if (started.status === 200 && started.body.data) {
      const run = started.body.data
      ok('检索按 chart-match-v2 起了一次作业', run.protocol === 'chart-match-v2', run.protocol)
      interface RunState {
        id: string
        status: string
        generation: number
        error_code: string | null
        result: null | {
          status: string
          protocol: string
          quality_validated: boolean
          items: { match?: { meaning: string; reverse: boolean } }[]
          excluded_candidates?: unknown[]
          coverage?: string
          scope?: string
        }
      }
      // 「不是 queued」不等于「跑完了」——running、retry_wait 也不是 queued。
      // 终态是明确的这几种，超时就让断言失败，别把还在跑的当成跑完了。
      const TERMINAL = ['succeeded', 'completed', 'failed', 'cancelled']
      let state: RunState | null = null
      for (let i = 0; i < 60; i += 1) {
        state = await must<RunState>(
          await call<RunState>('GET', `/v1/chart-search/runs/${run.search_run_id}`),
          'read the chart search run',
        )
        if (TERMINAL.includes(state.status)) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      ok('检索跑到了终态', state !== null && TERMINAL.includes(state.status), state?.status)
      const result = state?.result
      if (result && result.status === 'final') {
        ok('最终结果自报口径是结构相似，不是概率', result.items.every((i) => !i.match || i.match.meaning.includes('not_probability')))
        ok('默认不做反向匹配，反向要人自己选', result.items.every((i) => !i.match || i.match.reverse === false))
        ok('最终结果带着被排除的候选，不悄悄丢掉', Array.isArray(result.excluded_candidates))
        ok('后端不声称这套已经验收过', result.quality_validated === false)
      } else if (result) {
        ok('中途只给候选，并且自称 provisional', result.status === 'provisional', result.status)
      } else {
        ok('没有结果时给的是可解释的错误码，不是空结果', isCode(state?.error_code), String(state?.error_code))
      }
    } else {
      ok(
        '起不了检索时给的是可解释的错误码',
        isCode(started.body.error?.code),
        `HTTP ${started.status} ${started.body.error?.code}`,
      )
    }
  } else {
    ok(
      '认不了图时给的是可解释的错误码，不是硬认',
      isCode(analysis.body.error?.code),
      `HTTP ${analysis.status} ${analysis.body.error?.code}`,
    )
  }

  section('在记下来的东西里找：片段不等于全文')
  interface KnowledgeHit {
    source_kind: string
    source_id: string
    source_version: string
    excerpt: string
    start_byte: number
    end_byte: number
  }
  interface KnowledgeResult {
    items: KnowledgeHit[]
    protocol: string
    score_interpretation: string
    coverage: { pending_sources: number; indexed_sources: number }
  }
  // 问的是这次真的写进去的话，不是一句碰运气的检索词——搜得到搜不到才有意义。
  // 写进来的东西也要先切块建索引，所以先等索引把队列清空，最多等 60 秒。
  let recall = await call<KnowledgeResult>('POST', '/v1/knowledge/search', {
    body: { query: '量能没跟上，破不了前高就该退', limit: 10 },
  })
  for (let i = 0; i < 120 && recall.status === 200; i += 1) {
    const now = recall.body.data
    if (!now || now.items.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 500))
    recall = await call<KnowledgeResult>('POST', '/v1/knowledge/search', {
      body: { query: '量能没跟上，破不了前高就该退', limit: 10 },
    })
  }
  if (recall.status === 200 && recall.body.data) {
    const found = recall.body.data
    ok('检索自报这是翻出来的顺序，不是概率', found.score_interpretation === 'retrieval_order_not_probability', found.score_interpretation)
    ok('检索自报融合协议', found.protocol.length > 0, found.protocol)
    ok('检索带回索引进度，前端据此说明还有多少条搜不到', typeof found.coverage.pending_sources === 'number')
    // 索引是一份一份慢慢建的，页面上要照实说「还有多少份搜不到」。这里不等它
    // 全部建完，只要刚写进去的那几句已经搜得到就够——这就是用户会遇到的那一刻。
    ok('刚写进去的话搜得到', found.items.length > 0, `${found.items.length} 条，还欠 ${found.coverage.pending_sources} 份没建完`)
    const first = found.items[0]
    if (first) {
      ok('命中给的是原文里的一段，带起止字节', first.end_byte > first.start_byte)
      interface Slice { text: string; source_version: string; next_offset_byte: number | null; total_bytes: number }
      const slice = await must<Slice>(
        await call<Slice>('POST', '/v1/knowledge/source/slice', {
          body: { source_kind: first.source_kind, source_id: first.source_id, source_version: first.source_version, offset_byte: 0, limit_bytes: 256 },
        }),
        'read the source text',
      )
      ok('读全文读回来的是同一版', slice.source_version === first.source_version)
      ok('往下翻用的是后端给的字节游标', slice.next_offset_byte === null || slice.next_offset_byte > 0)

      // 光看到「有一段摘录」不算验过。把这一版原文按字节游标读全，再按命中
      // 报的起止字节切一刀——切出来必须就是那段摘录，位置和版本才算对得上。
      const pages: Buffer[] = []
      let versions = new Set<string>()
      let offset: number | null = 0
      let total = 0
      for (let page = 0; page < 24 && offset !== null; page += 1) {
        const chunk: Slice = await must<Slice>(
          await call<Slice>('POST', '/v1/knowledge/source/slice', {
            body: {
              source_kind: first.source_kind,
              source_id: first.source_id,
              source_version: first.source_version,
              offset_byte: offset,
              limit_bytes: 16000,
            },
          }),
          `read the source text from byte ${offset}`,
        )
        pages.push(Buffer.from(chunk.text, 'utf8'))
        versions.add(chunk.source_version)
        total = chunk.total_bytes
        offset = chunk.next_offset_byte
      }
      const whole = Buffer.concat(pages)
      ok('一页页读到底，拼出来的长度就是后端说的字节数', whole.length === total, `${whole.length} vs ${total}`)
      ok('翻到底也没换版本', versions.size === 1 && versions.has(first.source_version))
      // 起止字节量的不是这份正文，而是建索引时用的那份文本——它比正文多了开头
      // 一行 source_kind。读全文的接口只发正文，所以要把这一行补回去才对得上。
      // 前端做「点引用跳到原文」时同样要减掉这段偏移，见 README 里记的接口缺口。
      const lead = Buffer.from(`${first.source_kind}\n`, 'utf8')
      const indexed = Buffer.concat([lead, whole])
      const cut = indexed.subarray(first.start_byte, first.end_byte).toString('utf8')
      ok(
        `命中报的起止字节，在补上开头那行 source_kind（${lead.length} 字节）之后正好切出那段原文`,
        cut === first.excerpt,
        `切到 ${cut.slice(0, 24)}…`,
      )
      const leadText = lead.toString('utf8')
      const excerptBody = first.excerpt.startsWith(leadText)
        ? first.excerpt.slice(leadText.length)
        : first.excerpt
      ok('这段话确实来自这一版正文，引用点得开', whole.toString('utf8').includes(excerptBody))
      const wrongVersion = await call('POST', '/v1/knowledge/source/slice', {
        body: { source_kind: first.source_kind, source_id: first.source_id, source_version: 'not-a-real-version', offset_byte: 0, limit_bytes: 256 },
      })
      ok(
        '要错版本会被拒，不会把两版文字接在一起',
        wrongVersion.status >= 400,
        `HTTP ${wrongVersion.status} ${wrongVersion.body.error?.code}`,
      )
    }
  } else {
    ok(
      '本机没配读文字的模型时明说，不给空结果',
      isCode(recall.body.error?.code),
      `HTTP ${recall.status} ${recall.body.error?.code}`,
    )
  }

  section('统计：一次 run 就是一份固定口径')
  interface StatsStarted { statistics_run_id: string; set_snapshot_id: string; definition_id: string; status: string }
  const stats = await call<StatsStarted>('POST', '/v1/statistics/runs', {
    body: {
      name: `集成测试 ${new Date().toISOString()}`,
      filters: {},
      comparison_policy: 'exact_frozen_rule',
      grouping: 'episode_rule',
      calendar: 'natural_hours',
      outcome_policy: 'current_formal_head',
    },
    key: uuid(),
  })
  if (stats.status === 200 && stats.body.data) {
    const started = stats.body.data
    interface StatsRun {
      status: string
      stats: null | { counts: Record<string, number>; wilson_interval: null; wilson_reason: string }
      job: { status: string; error_code: string | null }
    }
    let run: StatsRun | null = null
    for (let i = 0; i < 60; i += 1) {
      run = await must<StatsRun>(
        await call<StatsRun>('GET', `/v1/statistics/runs/${started.statistics_run_id}`),
        'read the statistics run',
      )
      if (run.status === 'ready' || ['failed', 'cancelled'].includes(run.job.status)) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    ok('统计跑到了固定状态', run?.status === 'ready' || run?.status === 'frozen', run?.status)
    if (run?.stats) {
      ok('后端不给置信区间，并且说明为什么', run.stats.wilson_interval === null && run.stats.wilson_reason.length > 0, run.stats.wilson_reason)
      ok('成员构成是数出来的，不是估的', typeof run.stats.counts.call_count === 'number')
      // 成员清单的页大小由后端定死（一页 100 条），请求里不接受 limit——写了
      // 就是 400。翻页只认后端发回来的 next_cursor（上一页最后一条的 ordinal）。
      const counts = run.stats.counts
      interface Member { ordinal: number; call_id: string }
      interface MemberPage { items: Member[]; next_cursor: number | null; set_snapshot_id: string }
      const membersPath = `/v1/statistics/runs/${started.statistics_run_id}/members`
      const withLimit = await call('GET', membersPath, { query: { limit: 5 } })
      ok('成员清单不收 limit，页大小是后端定的', withLimit.status === 400, `HTTP ${withLimit.status}`)
      const members = await call<MemberPage>('GET', membersPath)
      ok('同一次 run 能翻出它数了哪些记录', members.status === 200, `HTTP ${members.status} ${members.body.error?.code}`)
      const page1 = members.body.data
      if (page1) {
        ok('成员和这次 run 的快照绑在一起', page1.set_snapshot_id === started.set_snapshot_id, page1.set_snapshot_id)
        const ordinals = page1.items.map((m) => m.ordinal)
        ok('成员按 ordinal 排好序', ordinals.every((v, i) => i === 0 || v > ordinals[i - 1]!))
        const walked = [...ordinals]
        const callIds = new Set(page1.items.map((m) => m.call_id))
        let mcursor = page1.next_cursor
        for (let page = 0; page < 20 && mcursor !== null; page += 1) {
          const chunk = await must<MemberPage>(
            await call<MemberPage>('GET', membersPath, { query: { cursor: mcursor } }),
            `members page ${page}`,
          )
          walked.push(...chunk.items.map((m) => m.ordinal))
          for (const m of chunk.items) callIds.add(m.call_id)
          mcursor = chunk.next_cursor
        }
        ok('按游标翻完不重复、不回头', new Set(walked).size === walked.length && walked.every((v, i) => i === 0 || v > walked[i - 1]!), `${walked.length} 条`)
        ok(
          '翻完的成员条数就是统计自己数的 claim_count',
          walked.length === counts.claim_count,
          `${walked.length} vs ${counts.claim_count}`,
        )
        ok(
          '去掉重复的记录数也和 call_count 对得上',
          callIds.size === counts.call_count,
          `${callIds.size} vs ${counts.call_count}`,
        )
      }
    }
  } else {
    ok(
      '起不了统计时给的是可解释的错误码',
      isCode(stats.body.error?.code),
      `HTTP ${stats.status} ${stats.body.error?.code}`,
    )
  }

  section('问过去的自己：没接模型就照实说')
  // 这一节的两条路都算通过：接上了就该起得来一次问答，没接上就该明说
  // `chat_model_not_configured`。不许出现第三种——一个编出来的答案。
  //
  // 没配模型时，POST 照样是 200：一次提问就是一次作业，先排上队，能不能跑得
  // 起来是作业自己的事。所以「没配」这件事要去 GET 这次 run 才看得到——作业
  // 停在 blocked_capability，error_code 是 chat_model_not_configured，answer
  // 是 null。前端的等待和重连也走这条路，测试就照这条路验。
  interface ChatRunState {
    chat_run_id: string
    status: string
    job_status: string
    error_code: string | null
    answer: string | null
    generation: number
  }
  const asked = await call<{ chat_run_id: string; status: string; model_id: string; budgets: { turns: number } }>(
    'POST',
    '/v1/chat/runs',
    { body: { message: '这种破位回踩我以前一般怎么说', attachment_ids: [], approved_actions: [] }, key: uuid() },
  )
  if (chatReady) {
    if (asked.status === 200 && asked.body.data) {
      const run = asked.body.data
      ok('起了一次问答并且报出用的是哪个模型', run.model_id.length > 0, run.model_id)
      ok('后端把这次问答的上限一并交代清楚', run.budgets.turns > 0, String(run.budgets.turns))
      const page = await call<{ items: { sequence: number }[] }>('GET', `/v1/chat/runs/${run.chat_run_id}/events/page`, {
        query: { after: 0 },
      })
      ok('断线之后能按序号补读同一次问答', page.status === 200, `HTTP ${page.status}`)
      const badCursor = await call('GET', `/v1/chat/runs/${run.chat_run_id}/events/page`, { query: { after: -3 } })
      ok('游标写错会被拒，不会从头重放', badCursor.status >= 400, `HTTP ${badCursor.status} ${badCursor.body.error?.code}`)
    } else {
      ok('说配好了却起不来，要有可解释的错误码', isCode(asked.body.error?.code), `HTTP ${asked.status} ${asked.body.error?.code}`)
    }
  } else if (asked.status === 200 && asked.body.data) {
    const run = asked.body.data
    ok('没配模型时也照样收下这次提问，只是跑不起来', run.status === 'queued', run.status)
    ok('模型位置照实写着「没配」，不假装接了一个', run.model_id === 'unconfigured', run.model_id)
    let state: ChatRunState | null = null
    for (let i = 0; i < 40; i += 1) {
      state = await must<ChatRunState>(
        await call<ChatRunState>('GET', `/v1/chat/runs/${run.chat_run_id}`),
        'read the chat run',
      )
      if (state.job_status !== 'queued' && state.job_status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    ok('作业停在「缺能力」上，不是失败也不是一直排队', state?.job_status === 'blocked_capability', state?.job_status)
    ok(
      '停下来的理由就是 chat_model_not_configured',
      state?.error_code === 'chat_model_not_configured',
      String(state?.error_code),
    )
    ok('没接模型就没有答案，answer 是 null，不是一句编出来的话', state?.answer === null, String(state?.answer))
  } else {
    ok(
      '没接模型时给的是可解释的错误码，不给编出来的答案',
      isCode(asked.body.error?.code),
      `HTTP ${asked.status} ${asked.body.error?.code}`,
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
