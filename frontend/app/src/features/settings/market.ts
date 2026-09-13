import * as catalog from '../../api/catalog'
import { imageIndexStatus, indexAllImages, type ImageIndexStatus } from '../../api/chart'
import { ApiError, explain } from '../../api/errors'
import * as history from '../../api/history'
import { Pager, WriteAction } from '../../api/http'
import * as jobs from '../../api/jobs'
import type { HistoryIndexRecord, Instrument, JobRecord, Market } from '../../api/types'
import * as prep from '../../data/prep'
import { capabilityState, defaultMarket, INTERVALS, MARKET_LABELS } from '../../data/session'
import { shortDate } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { actions, foldout, jobLine, note, spinner } from '../../ui/states'
import { hot } from '../relive/history/store-idb'

export interface SettingsLife { alive: () => boolean; stop: (stop: () => void) => void }
const message = (error: unknown) => error instanceof Error ? error.message : '没读出来，请重试'
const button = (text: string, click: () => void) => h('button.btn.sm', { type: 'button', text, on: { click } }) as HTMLButtonElement
const lock = (box: HTMLElement, disabled: boolean) => box.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = disabled })
const field = (label: string, control: HTMLElement) => h('label.field', {}, h('span', { text: label }), control)
const INPUT_TASK = 'scorebook.settings.image-job.v1'
const CATALOG_TASK = 'scorebook.settings.catalog-job.v1'
function stored(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } }
function remember(key: string, id: string | null): void { try { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key) } catch { /* progress can still be read on this page */ } }

/** Counts are per model: a finished shape index cannot hide an unfinished visual one. */
export function imageCoverage(status: ImageIndexStatus): { label: string; ready: number; pending: number; unsupported: number }[] {
  return [['candle-geometry-v2', '形状'], ['dinov2-small-v1', '画面']].map(([model, label]) => {
    const count = (state: string) => status.items.filter(v => v.model_id === model && v.status === state).reduce((n, v) => n + v.count, 0)
    const ready = count('ready'), unsupported = count('unsupported')
    return { label: label!, ready, unsupported, pending: Math.max(0, status.originals - ready - unsupported) }
  })
}

export function marketGroup(life: SettingsLife, health: { status: string } | null): HTMLElement {
  const visual = capabilityState('image_visual_search') === 'ready'
  const structure = capabilityState('image_structure_search') === 'ready'
  const monitors = new WeakMap<HTMLElement, () => void>()
  const root = h('section.sheet.pad.setgroup', {}, h('div.eyebrow.noline', { text: '行情与识图' }))
  const rows = h('div.setrows')
  root.appendChild(rows)
  const row = (name: string, text: string, detail?: HTMLElement) => h('div.setrow', {}, h('span.l', { text: name }), h('span.r.faint', { text }), detail ? h('div.b', {}, detail) : null)
  rows.append(
    row('本机服务', health?.status === 'ok' ? '运行中' : '暂时没读到状态'),
    row('行情来源', '币安公开行情'),
    row('识图', capabilityState('screenshot_ocr') === 'ready' ? '已配置' : '未配置'),
    hotCacheRow(),
    row('私库找相似图', visual && structure ? '已配置' : '服务未齐', imageStage()),
    h('div.setfold', {}, ranges()),
    h('div.setfold', {}, subscriptions()),
  )
  return root

  /**
   * 全屏那张图临时落在本机的那点行情：只是热缓存，24 小时自己过期，这里也能一
   * 键清掉。清完就地把那一行改成 0 段，不用刷新页面。
   */
  function hotCacheRow(): HTMLElement {
    const label = h('span.l')
    const wipe = button('清空本机行情缓存', () => {
      wipe.disabled = true
      void (hot()?.clear() ?? Promise.resolve()).catch(() => { /* 清不掉就还留着，下次过期照样会掉 */ })
        .then(() => {
          if (!life.alive()) return
          wipe.disabled = false
          label.textContent = '本机缓存 0 段，24 小时自动过期'
        })
    })
    const node = h('div.setrow', {}, label, h('span.r', {}, wipe))
    label.textContent = '本机缓存 0 段，24 小时自动过期'
    void hotCacheText().then((text) => { if (life.alive()) label.textContent = text })
    return node
  }

  /** A failed read never discards a job. Retry reads this same id, not a new job. */
  function follow(stage: HTMLElement, id: string, done: () => void): void {
    monitors.get(stage)?.()
    let stopped = false, serial = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const retry = new WriteAction()
    const stop = () => { stopped = true; if (timer) clearTimeout(timer) }
    monitors.set(stage, stop)
    life.stop(stop)
    const current = (round: number) => life.alive() && !stopped && round === serial
    async function read(): Promise<void> {
      const round = ++serial
      if (timer) clearTimeout(timer)
      stage.replaceChildren(spinner('正在读进度'))
      try {
        const job = await jobs.get(id)
        if (!current(round)) return
        const line = jobs.jobLine(job.status)
        stage.replaceChildren(jobLine(line.text, line.progress))
        if (jobs.isRunning(job)) { timer = setTimeout(() => void read(), 2000); return }
        if (job.status === 'succeeded' || job.status === 'cancelled') { done(); return }
        stage.appendChild(note('warn', job.error_code ? explain(job.error_code) : line.text))
        const controls = actions(button('刷新进度', () => void read()))
        if (jobs.canRetry(job)) controls.prepend(button('接着做', () => void resume(job)))
        stage.appendChild(controls)
      } catch (error) {
        if (!current(round)) return
        stage.replaceChildren(note('warn', error instanceof ApiError && error.status === 404 ? '找不到这项任务，编号仍保留在本机' : '暂时没读到进度，任务编号已保留'), button('重试读取', () => void read()))
      }
    }
    async function resume(job: JobRecord): Promise<void> {
      stage.replaceChildren(spinner('正在提交'))
      try { await jobs.retry(id, job.generation, retry.keyFor({ id, generation: job.generation })); retry.reset(); if (life.alive()) void read() }
      catch (error) { if (life.alive()) stage.replaceChildren(note('warn', message(error)), button('刷新进度', () => void read())) }
    }
    void read()
  }

  function imageStage(): HTMLElement {
    const box = h('div.stack'), counts = h('div.stack'), task = h('div')
    const action = new WriteAction()
    box.append(counts, task)
    async function load(): Promise<void> {
      counts.replaceChildren(spinner('正在读截图范围'))
      try {
        const status = await imageIndexStatus()
        if (!life.alive()) return
        clear(counts)
        const coverage = imageCoverage(status)
        if (!status.originals) { counts.appendChild(h('span.faint', { text: '还没有现场截图' })); return }
        for (const one of coverage) counts.appendChild(h('span.faint', { text: `${one.label}：${one.ready}/${status.originals} 张已准备${one.pending ? ` · ${one.pending} 张待准备` : ''}${one.unsupported ? ` · ${one.unsupported} 张暂不支持` : ''}` }))
        if (coverage.some(one => one.pending)) {
          const fill = button('补上待准备的图', () => void start(fill)); fill.disabled = !visual || !structure || stored(INPUT_TASK) !== null
          counts.appendChild(fill)
          if (!visual || !structure) counts.appendChild(h('span.faint', { text: '两项找图服务配置齐后可以补上' }))
        }
      } catch (error) { if (life.alive()) counts.replaceChildren(note('warn', message(error)), button('重试', () => void load())) }
    }
    async function start(fill: HTMLButtonElement): Promise<void> {
      fill.disabled = true
      try {
        const started = await indexAllImages(action.keyFor({ all: true })); action.reset(); remember(INPUT_TASK, started.job_id)
        if (life.alive()) follow(task, started.job_id, () => { remember(INPUT_TASK, null); void load() })
      } catch (error) { if (life.alive()) { fill.disabled = false; task.replaceChildren(note('warn', message(error))) } }
    }
    void load()
    const id = stored(INPUT_TASK)
    if (id) follow(task, id, () => { remember(INPUT_TASK, null); void load() })
    return box
  }

  function contractForm(archiveOnly = false): { node: HTMLElement; read: () => Promise<Pick<Instrument, 'symbol' | 'market'>>; interval: HTMLSelectElement; source: HTMLSelectElement } {
    const symbol = h('input.input', { placeholder: '搜索品种，如 BTC', attrs: { 'aria-label': '品种' } }) as HTMLInputElement
    const market = h('select.input', { attrs: { 'aria-label': '市场' } }) as HTMLSelectElement
    for (const value of ['usd_m', 'coin_m'] as Market[]) market.appendChild(h('option', { value, text: MARKET_LABELS[value] }))
    market.value = defaultMarket()
    const interval = h('select.input', { attrs: { 'aria-label': '周期' } }) as HTMLSelectElement
    for (const value of INTERVALS) interval.appendChild(h('option', { value, text: value }))
    interval.value = '1h'
    const source = h('select.input', { attrs: { 'aria-label': '来源' } }) as HTMLSelectElement
    source.append(h('option', { value: 'rest', text: '交易所接口' }), h('option', { value: 'monthly_archive', text: '官方月度归档' }))
    if (archiveOnly) source.value = 'monthly_archive'
    const results = h('div.acts')
    let selected: Pick<Instrument, 'symbol' | 'market'> | null = null, generation = 0
    const clearChoice = () => { selected = null; generation += 1; clear(results) }
    symbol.addEventListener('input', clearChoice); market.addEventListener('change', clearChoice); source.addEventListener('change', clearChoice)
    async function lookup(): Promise<Pick<Instrument, 'symbol' | 'market'>> {
      const round = ++generation
      const q = symbol.value.trim().toUpperCase()
      if (!q) throw new Error('先写品种，再选择合约')
      const page = await catalog.instruments({ q, market: market.value as Market, limit: 20 })
      if (!life.alive() || round !== generation) throw new Error('品种已改变，请重新选择')
      let exact: Pick<Instrument, 'symbol' | 'market'> | undefined = page.items.find(one => one.symbol === q)
      if (!exact && source.value === 'monthly_archive') {
        const past = await history.catalog({ symbol: q, market: market.value as Market })
        if (!life.alive() || round !== generation) throw new Error('品种已改变，请重新选择')
        exact = past.items.find(one => one.symbol === q)
      }
      if (exact) { selected = exact; symbol.value = exact.symbol; clear(results); return exact }
      clear(results)
      for (const one of page.items) results.appendChild(button(one.symbol, () => { selected = one; symbol.value = one.symbol; clear(results) }))
      if (!page.items.length) throw new Error('目录里没有这个合约；可先重新核对目录')
      throw new Error('请从查到的合约中选择一项')
    }
    const search = button('查找合约', () => { void lookup().catch(error => { if (life.alive()) results.prepend(note('info', message(error))) }) })
    return {
      node: h('div.stack', {}, field('市场', market), field('品种', symbol), search, results, field('周期', interval), archiveOnly ? null : field('来源', source)), interval, source,
      read: () => selected && selected.symbol === symbol.value.trim() && selected.market === market.value ? Promise.resolve(selected) : lookup(),
    }
  }

  function ranges(): HTMLElement {
    const list = h('div.stack'), footer = h('div.acts'), editor = h('div'), tasks = h('div.stack')
    let pager = new Pager<HistoryIndexRecord>((cursor, signal) => history.indexes(cursor, { signal })), loading = false
    const tracked = new Set<string>()
    const catalogTask = h('div')
    async function load(reset = false): Promise<void> {
      if (loading && !reset) return
      if (reset) { pager.reset(); pager = new Pager((cursor, signal) => history.indexes(cursor, { signal })); clear(list) }
      const current = pager; loading = true
      footer.replaceChildren(spinner('正在读范围'))
      try {
        const page = await current.next()
        if (!life.alive() || current !== pager) return
        for (const one of page) {
          const b = one.body
          const row = h('div.rangerow', { style: 'display:flex;flex-wrap:wrap;gap:8px' }, h('span.s', { text: `${b.symbol} · ${b.interval}` }), h('span.d', { text: `${shortDate(b.start_at)} – ${shortDate(b.end_at)}`, style: 'white-space:normal' }), h('span.w', { text: one.status === 'ready' ? '已准备' : '尚未完成' }))
          if (one.status !== 'ready') row.appendChild(button('查看进度', () => track(one.id, `${b.symbol} · ${b.interval}`)))
          list.appendChild(row)
        }
        if (!current.items.length) list.appendChild(h('div.faint', { text: '还没准备过' }))
        footer.replaceChildren(h('span.faint', { text: `已读 ${current.items.length} 段${current.more ? '，还有更多' : ''}` }))
        if (current.more) footer.appendChild(button('加载更多范围', () => void load()))
      } catch (error) { if (life.alive() && current === pager) footer.replaceChildren(note('warn', message(error)), button('重试读取', () => void load())) }
      finally { if (current === pager) loading = false }
    }
    function track(id: string, name: string): void {
      if (tracked.has(id)) return
      tracked.add(id)
      const progress = h('div'), box = h('div.stack', {}, h('span.faint', { text: name }), progress)
      tasks.appendChild(box)
      follow(progress, id, () => { prep.forget(id); void load(true) })
    }
    for (const saved of prep.list()) track(saved.id, `${saved.symbol} · ${saved.interval}`)
    function form(): void {
      const contract = contractForm(), from = h('input.input', { type: 'date' }) as HTMLInputElement, to = h('input.input', { type: 'date' }) as HTMLInputElement
      const status = h('div'), action = new WriteAction()
      const submit = button('准备', () => void save())
      const box = h('div.prepform', { style: 'display:flex;flex-direction:column;min-width:0' }, contract.node, field('起始日（UTC）', from), field('截止日（不含，UTC）', to), status, actions(submit, button('收起', () => clear(editor))))
      editor.replaceChildren(box)
      async function save(): Promise<void> {
        if (submit.disabled) return
        lock(box, true); status.replaceChildren(spinner('正在提交'))
        try {
          if (!from.value || !to.value || from.value >= to.value) throw new Error('请写起止日期，起始日要早于截止日')
          const one = await contract.read()
          const input: history.IndexRequest = { symbol: one.symbol, market: one.market, interval: contract.interval.value, source: contract.source.value as history.HistorySource, start_at: `${from.value}T00:00:00Z`, end_at: `${to.value}T00:00:00Z`, window_bars: 96, stride_bars: 16, models: [...history.HISTORY_MODELS] }
          const started = await history.requestIndex(input, action.keyFor(input)); action.reset()
          prep.remember({ kind: 'index', id: started.job_id, symbol: one.symbol, market: one.market, interval: input.interval, start_at: input.start_at, end_at: input.end_at, started_at: new Date().toISOString() })
          if (life.alive()) { if (editor.contains(box)) clear(editor); track(started.job_id, `${one.symbol} · ${input.interval}`) }
        } catch (error) { if (life.alive()) status.replaceChildren(note('warn', message(error))) }
        finally { lock(box, false) }
      }
    }
    const catalogAction = new WriteAction()
    async function recheck(): Promise<void> {
      refresh.disabled = true
      try { const started = await history.refreshCatalog(catalogAction.keyFor({ refresh: true })); catalogAction.reset(); remember(CATALOG_TASK, started.job_id); if (life.alive()) follow(catalogTask, started.job_id, () => remember(CATALOG_TASK, null)) }
      catch (error) { if (life.alive()) catalogTask.replaceChildren(note('warn', message(error))) }
      finally { refresh.disabled = false }
    }
    const refresh = button('重新核对目录', () => void recheck())
    const saved = stored(CATALOG_TASK)
    if (saved) follow(catalogTask, saved, () => remember(CATALOG_TASK, null))
    void load()
    return foldout('币安历史范围', list, footer, tasks, catalogTask, editor, actions(button('准备一段', form), button('查看归档', () => archive(editor)), refresh, button('刷新范围', () => void load(true))))
  }

  function archive(editor: HTMLElement): void {
    const contract = contractForm(true), output = h('div'), action = button('查看归档', () => void read(true))
    const box = h('div.prepform', { style: 'display:flex;flex-direction:column;min-width:0' }, contract.node, actions(action, button('收起', () => clear(editor))), output)
    editor.replaceChildren(box)
    let selection: { market: Market; symbol: string; interval: string } | null = null, cursor: string | null = null, busy = false
    async function read(reset = false): Promise<void> {
      if (busy) return
      busy = true; lock(box, true)
      try {
        if (reset) { const one = await contract.read(); selection = { market: one.market, symbol: one.symbol, interval: contract.interval.value }; cursor = null; clear(output) }
        if (!selection) return
        const listing = await history.archiveCatalog({ ...selection, cursor })
        if (!life.alive() || !editor.contains(box)) return
        output.querySelector('[data-more]')?.remove()
        output.querySelector('[data-error]')?.remove()
        for (const file of listing.items) output.appendChild(h('div.rangerow', {}, h('span.s', { text: file.source_key, style: 'overflow-wrap:anywhere;white-space:normal;min-width:0'  }), h('span.d', { text: `${Math.round(file.size_bytes / 1_048_576)} MB` })))
        cursor = listing.next_cursor
        if (cursor) { const more = button('加载更多归档', () => void read()); more.dataset.more = 'true'; output.appendChild(more) }
        else if (!listing.complete_listing) output.appendChild(note('warn', '来源没有列完文件，请重新读取'))
        else if (!output.children.length) output.appendChild(h('span.faint', { text: '没有归档文件' }))
      } catch (error) { if (life.alive() && editor.contains(box)) { output.querySelector('[data-error]')?.remove(); output.appendChild(h('div', { data: { error: true } }, note('warn', message(error)), button('重试读取', () => void read(reset)))) } }
      finally { busy = false; lock(box, false) }
    }
  }

  function subscriptions(): HTMLElement {
    const list = h('div.stack'), editor = h('div'), progress = h('div')
    const cards = new Map<string, HTMLElement>()
    function show(id: string): void {
      if (cards.has(id)) return
      const card = h('div.stack'); cards.set(id, card); list.prepend(card)
      let serial = 0, busy = false
      const controlAction = new WriteAction(), budgetAction = new WriteAction()
      void read()
      async function read(): Promise<void> {
        const round = ++serial; card.replaceChildren(spinner('正在读订阅'))
        try { const sub = await history.subscription(id); if (life.alive() && round === serial) paint(sub) }
        catch (error) { if (life.alive() && round === serial) card.replaceChildren(h('span.faint', { text: `订阅 ${id}`, style: 'overflow-wrap:anywhere' }), note('warn', message(error)), button('重试读取', () => void read())) }
      }
      function paint(sub: history.Subscription): void {
        const d = sub.body.definition
        prep.rememberFollow({ id: sub.id, market: d.market, symbols: sub.body.resolved_symbols, intervals: d.intervals, start_at: d.start_at, source: d.source, started_at: sub.created_at })
        const statuses = { active: '跟进中', paused: '已暂停', needs_attention: '需要处理', cancelled: '已取消' }
        const error = h('div'), controls = actions(button('刷新', () => void read()))
        const budget = h('input.input', { type: 'number', value: String(d.max_vectors), attrs: { min: 1, step: 1, 'aria-label': '每轮准备上限' } }) as HTMLInputElement
        card.replaceChildren(h('div.h3', { text: `${d.symbols.length ? d.symbols.join('、') : '目录中的合约'} · ${d.intervals.join('、')}` }), h('span.faint', { text: `${statuses[sub.status]} · 每轮上限 ${d.max_vectors.toLocaleString()} 条` }), h('span.faint', { text: sub.watermark ? `已准备到 ${shortDate(sub.watermark)}` : '还没有完成一轮' }), error, controls)
        if (sub.error_code || sub.last_error) error.appendChild(note('warn', explain((sub.error_code || sub.last_error)!)))
        if (sub.job_status && sub.status === 'active') card.appendChild(h('span.faint', { text: jobs.jobLine(sub.job_status as JobRecord['status']).text }))
        if (sub.status === 'active') controls.appendChild(button('暂停订阅', () => void change(sub, 'pause')))
        if (sub.status === 'paused' || sub.status === 'needs_attention') {
          controls.appendChild(button('继续订阅', () => void change(sub, 'resume')))
          card.append(field('每轮准备上限（条）', budget), button('保存上限', () => void saveBudget()), h('span.faint', { text: '保存上限后，按“继续订阅”开始下一轮' }))
        }
        if (sub.status !== 'cancelled') controls.appendChild(button('取消订阅', () => void change(sub, 'cancel')))
        if (sub.job_id) controls.appendChild(button('查看本轮进度', () => follow(progress, sub.job_id!, () => void read())))
        if (sub.status === 'paused') card.appendChild(h('span.faint', { text: '已经开始的一小段会做完，之后暂停' }))
        async function perform(work: () => Promise<unknown>): Promise<void> {
          if (busy) return
          busy = true; card.querySelectorAll('button').forEach(one => { one.disabled = true })
          try { await work(); if (life.alive()) await read() }
          catch (problem) { if (life.alive()) { error.replaceChildren(note('warn', message(problem))); if (problem instanceof ApiError && problem.status === 409) error.appendChild(button('读取最新状态', () => void read())) } }
          finally { busy = false; card.querySelectorAll('button').forEach(one => { one.disabled = false }) }
        }
        async function change(current: history.Subscription, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
          const input = { expected_revision: current.revision, action }
          await perform(async () => { await history.subscriptionControl(id, input, controlAction.keyFor({ id, ...input })); controlAction.reset() })
        }
        async function saveBudget(): Promise<void> {
          const max_vectors = Number(budget.value)
          if (!Number.isSafeInteger(max_vectors) || max_vectors < 1) { error.replaceChildren(note('warn', '上限要填大于 0 的整数')); return }
          const input = { expected_revision: sub.revision, max_vectors }
          await perform(async () => { await history.subscriptionBudget(id, input, budgetAction.keyFor({ id, ...input })); budgetAction.reset() })
        }
      }
    }
    for (const saved of prep.follows()) show(saved.id)
    function create(): void {
      const contract = contractForm(), from = h('input.input', { type: 'date' }) as HTMLInputElement
      const budget = h('input.input', { type: 'number', value: '2000000', attrs: { min: 1, step: 1 } }) as HTMLInputElement
      const feedback = h('div'), action = new WriteAction(), submit = button('开始订阅', () => void save())
      const box = h('div.prepform', { style: 'display:flex;flex-direction:column;min-width:0' }, contract.node, field('起始日（UTC）', from), field('每轮准备上限（条）', budget), feedback, actions(submit, button('收起', () => clear(editor))))
      editor.replaceChildren(box)
      async function save(): Promise<void> {
        if (submit.disabled) return
        lock(box, true); feedback.replaceChildren(spinner('正在提交'))
        try {
          if (!from.value) throw new Error('先写起始日期')
          const max_vectors = Number(budget.value)
          if (!Number.isSafeInteger(max_vectors) || max_vectors < 1) throw new Error('上限要填大于 0 的整数')
          const one = await contract.read()
          const input: history.SubscriptionInput = { market: one.market, symbols: [one.symbol], intervals: [contract.interval.value], start_at: `${from.value}T00:00:00Z`, source: contract.source.value as history.HistorySource, max_vectors }
          const started = await history.subscribe(input, action.keyFor(input)); action.reset()
          prep.rememberFollow({ id: started.subscription_id, ...input, started_at: new Date().toISOString() })
          if (life.alive()) { if (editor.contains(box)) clear(editor); show(started.subscription_id) }
        } catch (error) { if (life.alive()) feedback.replaceChildren(note('warn', message(error))) }
        finally { lock(box, false) }
      }
    }
    const id = h('input.input', { placeholder: '粘贴订阅编号', attrs: { 'aria-label': '订阅编号' } }) as HTMLInputElement
    const recovery = h('div'), find = button('按编号找回', () => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.value.trim())) { recovery.replaceChildren(note('warn', '请粘贴完整的订阅编号')); return }
      clear(recovery); show(id.value.trim())
    })
    return foldout('持续准备行情', h('span.faint', { text: '这里显示本机记下的订阅；其他设备创建的可按编号找回' }), list, editor, progress, actions(button('新建订阅', create)), field('找回订阅', id), find, recovery)
  }
}

/** 本机缓存占多少：浏览器肯说字节就说字节，不肯说就说存了几段。 */
export function cacheSizeText(bytes: number | null, tiles: number): string {
  if (bytes !== null && Number.isFinite(bytes) && bytes > 0) {
    const mb = bytes / (1024 * 1024)
    const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
    return `本机缓存 ${size}，24 小时自动过期`
  }
  return `本机缓存 ${Math.max(0, Math.floor(tiles))} 段，24 小时自动过期`
}

async function hotCacheText(): Promise<string> {
  const cache = hot()
  const tiles = cache ? await cache.count().catch(() => 0) : 0
  if (!tiles) return cacheSizeText(null, 0)
  let bytes: number | null = null
  try {
    const estimate = await navigator.storage?.estimate?.()
    bytes = typeof estimate?.usage === 'number' ? estimate.usage : null
  } catch { bytes = null }
  return cacheSizeText(bytes, tiles)
}
