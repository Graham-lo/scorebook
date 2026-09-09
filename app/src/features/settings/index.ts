// 设置 —— 这台机器现在到底能做什么，以及做不到什么。
//
// Everything on this page comes from `/v1/capabilities` and `/v1/health`,
// which is the only honest source: a capability the backend calls `planned`
// is shown as not available, with the reason, instead of being hidden or
// dressed up as "coming soon" next to a button that does nothing. The one
// thing this page will never show is a credential — the development token
// lives in the server-side proxy and never reaches the browser.

import * as catalog from '../../api/catalog'
import { explain } from '../../api/errors'
import * as exportsApi from '../../api/exports'
import { Latest, WriteAction } from '../../api/http'
import * as jobs from '../../api/jobs'
import type { Capabilities, JobRecord, Uuid } from '../../api/types'
import * as lastExport from '../../data/lastExport'
import { MARKET_LABELS, capability, defaultMarket, isLive, loadCapabilities } from '../../data/session'
import { clear, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { prefersReducedMotion, stagger } from '../../ui/motion'
import { actions, empty, note, progressLine, spinner } from '../../ui/states'
import { chatPanel } from '../chat'

const lane = new Latest()
const exportAction = new WriteAction()
const retryAction = new WriteAction()

interface Row {
  key: string
  title: string
  /** What the trader can do, in their words, when this is live. */
  can: string
  /** What is missing, in their words, when it is not. */
  cannot: string
}

const ROWS: Row[] = [
  {
    key: 'records',
    title: '记录和查找',
    can: '可以写下判断、传截图，之后按原话、品种、周期、标签找出来。',
    cannot: '记录服务没有就绪，这台机器现在存不下东西。',
  },
  {
    key: 'reviews',
    title: '复盘',
    can: '可以给任何一条记录追加复盘，原来的话不会被改。',
    cannot: '复盘服务没有就绪。',
  },
  {
    key: 'image_structure_search',
    title: '按走势形状搜索',
    can: '可以用一张截图，在自己的记录和已准备的历史里找走势形状接近的画面。',
    cannot: '这台机器还不能按走势形状检索。',
  },
  {
    key: 'image_visual_search',
    title: '按画面样子搜索',
    can: '本机的视觉模型在运行，可以按整张图看起来像不像来检索，也可以两种一起排。',
    cannot: '本机的视觉模型没有启动，所以只能按走势形状比较。启动它之后刷新页面就会多出这两种。',
  },
  {
    key: 'formal_statistics',
    title: '正式统计',
    can: '可以按每条记录写下的标准，统计胜率一类的数字。',
    cannot: '统计方式还在做。在它做完之前，这里不会给你任何一个看起来像胜率的数字——算错的统计比没有统计更糟。',
  },
  {
    key: 'chat_generation',
    title: '对着记录提问',
    can: '可以用自然语言问自己的记录。',
    cannot: '问答还没有接上。现在不会给你一个编出来的答案。',
  },
  {
    key: 'exchange_accounts',
    title: '连交易所账户',
    can: '可以把成交记录接进来，和判断对上。',
    cannot: '还不能连交易所。原型里那个「已连接」是画出来的，不是真的。',
  },
]

export function settingsPage(host: HTMLElement): () => void {
  let alive = true
  /** 正在盯着导出进度的那个循环，离开页面时停掉。 */
  const watchers: (() => void)[] = []

  const head = h(
    'div.sheet.pad',
    {},
    h('h1.h1', { text: '这台机器现在能做什么' }),
    h('div.tip', {
      style: 'margin-top:6px;max-width:58ch',
      text: '下面这些不是计划表，是后端此刻自己报上来的状态。做不到的事写清楚做不到，比先摆一个按钮再说要好。',
    }),
  )
  const body = h('div', { style: 'margin-top:18px' })
  host.append(head, body)
  body.appendChild(spinner('正在问后端…'))

  void load()

  async function load(): Promise<void> {
    const signal = lane.begin()
    try {
      const [caps, health] = await Promise.all([
        loadCapabilities(),
        catalog.health({ signal }).catch(() => null),
      ])
      if (!alive) return
      paint(caps, health)
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      clear(body)
      body.appendChild(
        empty({
          art: 'info',
          title: '连不上本机后端',
          tip: '确认后端在 127.0.0.1:8787 上运行，然后重试。' +
            (error instanceof Error ? ` 服务说：${error.message}` : ''),
          action: h('button.btn.sm', { text: '重试', on: { click: () => void load() } }),
        }),
      )
    }
  }

  function paint(caps: Capabilities, health: { status: string; version: string } | null): void {
    clear(body)

    const list = h('div.stack', { style: 'gap:12px' })
    ROWS.forEach((row, index) => {
      const live = isLive(row.key)
      const raw = capability(row.key)
      list.appendChild(
        h(
          'div.caprow',
          { class: live ? 'on' : 'off', style: `--i:${index}` },
          h('div.mark', {}, icon(live ? 'check' : 'close')),
          h(
            'div',
            {},
            h(
              'div.row',
              { style: 'gap:8px;align-items:baseline;flex-wrap:wrap' },
              h('span.h3', { text: row.title }),
              h('span', {
                class: ['badge', live ? 'ready' : 'wait'],
                text: live ? '现在可用' : stateWord(raw),
              }),
            ),
            h('div.tip', { text: live ? row.can : row.cannot }),
          ),
        ),
      )
    })
    body.appendChild(list)
    stagger(list.children)

    if (capability('exports')) body.appendChild(exportPanel())

    body.appendChild(
      h(
        'div',
        { style: 'margin-top:18px' },
        h('div.eyebrow', { text: '以后会有' }),
        h('div', { style: 'margin-top:10px' }, chatPanel().node),
      ),
    )

    body.appendChild(
      h(
        'div.sheet.pad',
        { style: 'margin-top:18px' },
        h('div.eyebrow.noline', { text: '这台机器' }),
        h(
          'div.kv',
          { style: 'margin-top:10px' },
          kv('后端状态', health ? (health.status === 'ok' ? '正常' : health.status) : '问不到'),
          kv('后端版本', health?.version ?? '问不到'),
          kv('默认市场', MARKET_LABELS[caps.default_market ?? defaultMarket()]),
          kv('动效', prefersReducedMotion() ? '按系统设置减弱' : '正常'),
        ),
      ),
    )

    body.appendChild(
      note(
        'info',
        '浏览器只和本机的开发代理说话，凭证由代理在服务端加上，不会出现在页面里，也不会存进浏览器。行情 K 线和临时画出来的图只在内存里，关掉页面就没有了。',
      ),
    )
  }

  /**
   * 把记录导出一份。
   *
   * 导出跑在后端，不在这个页面里：交出去之后关掉页面它照样在做。编号记在本机，
   * 刷新之后接着看进度、接着下载。页面只拿编号，导出的内容一条都不进浏览器。
   */
  function exportPanel(): HTMLElement {
    const stage = h('div', { style: 'margin-top:14px' })
    const box = h(
      'div.sheet.pad',
      { style: 'margin-top:18px' },
      h('div.eyebrow.noline', { text: '你的记录是你的' }),
      h('h2.h2', { style: 'margin-top:8px', text: '随时导出一份完整的副本' }),
      h('div.tip', {
        style: 'margin-top:6px;max-width:58ch',
        text: '当时说的每一句判断、后来市场给出的结果、每一次复盘，连同当时的截图，一起导成一份自己保管的副本。几年的记分不该锁在一台机器里。导到一半断了也不用从头来，接着做就行。',
      }),
      stage,
    )

    let stopped = false
    watchers.push(() => {
      stopped = true
    })

    const saved = lastExport.read()
    if (saved) {
      stage.appendChild(spinner('正在看上一次导出做到哪儿了…'))
      void watch(saved.id)
    } else {
      idle()
    }
    return box

    function show(...children: (Node | null)[]): void {
      if (stopped || !alive) return
      clear(stage)
      for (const child of children) if (child) stage.appendChild(child)
    }

    function idle(lead?: HTMLElement): void {
      show(
        lead ?? null,
        actions(
          h('button.btn.primary.sm', { text: '导出一份', on: { click: () => void start() } }),
          h('span.faint', { text: '记录越多导得越久，可以放着不管。' }),
        ),
      )
    }

    async function start(): Promise<void> {
      show(spinner('正在交给后端…'))
      try {
        const started = await exportsApi.create(exportAction.keyFor({ at: Date.now() }))
        exportAction.reset()
        lastExport.remember({ id: started.job_id, started_at: new Date().toISOString() })
        await watch(started.job_id)
      } catch (error) {
        if (stopped || !alive) return
        idle(note('warn', error instanceof Error ? error.message : '这次没有交出去，再试一次。'))
      }
    }

    /** 每两秒问一次后端做到哪儿了；它停下来就交给 settle 决定怎么说。 */
    async function watch(id: Uuid): Promise<void> {
      for (;;) {
        let job: JobRecord
        try {
          job = await jobs.get(id)
        } catch {
          // 这份导出后端已经不认了：过期或者被清掉了，重新导一次就好。
          lastExport.forget()
          if (stopped || !alive) return
          idle(note('info', '上一次的导出后端已经不留着了，重新导一份就好。'))
          return
        }
        if (stopped || !alive) return
        if (!jobs.isRunning(job)) {
          await settle(job)
          return
        }
        const line = jobs.jobLine(job.status)
        show(
          progressLine(line.text, line.progress),
          h('div.faint', { style: 'margin-top:6px', text: '在后端做，关掉页面也不影响。' }),
        )
        await sleep(2_000)
        if (stopped || !alive) return
      }
    }

    async function settle(job: JobRecord): Promise<void> {
      const finished = exportsApi.done(job.result)
      if (job.status === 'succeeded' && finished) {
        await finish(finished)
        return
      }
      if (job.status === 'cancelled') {
        lastExport.forget()
        idle(note('info', '上一次导出取消了。'))
        return
      }
      show(
        note('warn', job.error_code ? explain(job.error_code) : '这份导出没有做完。'),
        actions(
          ...(jobs.canRetry(job)
            ? [
                h('button.btn.sm', {
                  text: '接着做',
                  on: {
                    click: () => {
                      void resume(job)
                    },
                  },
                }),
              ]
            : []),
          h('button.btn.ghost.sm', {
            text: '重新导一份',
            on: {
              click: () => {
                lastExport.forget()
                void start()
              },
            },
          }),
        ),
      )
    }

    /** 接着做：做好的那部分留着，后端从断掉的地方往下走。 */
    async function resume(job: JobRecord): Promise<void> {
      show(spinner('正在接着做…'))
      try {
        await jobs.retry(job.id, job.generation, retryAction.keyFor({ id: job.id, g: job.generation }))
        await watch(job.id)
      } catch (error) {
        if (stopped || !alive) return
        show(note('warn', error instanceof Error ? error.message : '没有接上，刷新一下再试。'))
      }
    }

    async function finish(finished: exportsApi.ExportDone): Promise<void> {
      let counts: exportsApi.ExportManifest | null = null
      try {
        counts = await exportsApi.manifest(finished.export_id)
      } catch {
        // 清单读不到，多半是这份导出已经过期；下面按过期说。
        lastExport.forget()
        if (stopped || !alive) return
        idle(note('info', '上一次的导出已经过期了，重新导一份就好。'))
        return
      }
      if (stopped || !alive) return
      const rows = (table: string): number => counts?.tables?.[table]?.rows ?? 0
      const shots = counts.attachment_files ?? finished.files ?? 0
      show(
        h(
          'div.exdone',
          {},
          h(
            'div.row',
            { style: 'gap:8px;align-items:center' },
            h('span.badge.ready', { text: '导好了' }),
            h('span.faint', { text: '后端只保留 7 天，要留久一点就把它复制走。' }),
          ),
          h(
            'div.exnums',
            { style: 'margin-top:10px' },
            exnum(rows('calls'), '条判断'),
            exnum(rows('reviews'), '次复盘'),
            exnum(shots, '张截图'),
          ),
          actions(
            h('a.btn.sm', {
              text: '下载清单',
              href: exportsApi.manifestUrl(finished.export_id),
              attrs: { download: 'manifest.json', rel: 'noopener' },
            }),
            h('button.btn.ghost.sm', {
              text: '再导一份新的',
              on: {
                click: () => {
                  lastExport.forget()
                  void start()
                },
              },
            }),
            h('span.faint.mono', {
              title: finished.manifest_sha256,
              text: `校验码 ${finished.manifest_sha256.slice(0, 12)}`,
            }),
          ),
          note(
            'info',
            '清单里逐个文件写着校验码。完整的一份（含截图）存在这台机器的后端目录里；把它装回去要用后端自带的恢复命令，页面上没有这一步。',
          ),
        ),
      )
    }

    function exnum(value: number, label: string): HTMLElement {
      return h(
        'div.exnum',
        {},
        h('span.v', { text: String(value) }),
        h('span.k', { text: label }),
      )
    }
  }

  function kv(label: string, value: string): HTMLElement {
    return h('div.kvrow', {}, h('span.k', { text: label }), h('span.v', { text: value }))
  }

  return () => {
    alive = false
    lane.cancel()
    for (const stop of watchers) stop()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Turns the backend's own word into something a trader can read. */
function stateWord(raw: string): string {
  switch (raw) {
    case 'planned':
      return '还没有做'
    case 'implementation_in_progress':
      return '正在做'
    case 'not_configured':
      return '本机没有启动'
    case '':
      return '不清楚'
    default:
      return raw
  }
}
