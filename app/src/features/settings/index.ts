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
import {
  MARKET_LABELS,
  capabilityDetail,
  capabilityState,
  defaultMarket,
  loadCapabilities,
  qualityAccepted,
} from '../../data/session'
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
  /** 已经做好、但这台机器上还差一步时，那一步是什么。 */
  setup?: string
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
    cannot: '本机的视觉模型没有启动，所以只能按走势形状比较。',
    setup: '在后端目录里运行 python3 vision/server.py，然后刷新这一页。',
  },
  {
    key: 'screenshot_ocr',
    title: '认截图上的字',
    can: '可以从你自己的截图里读出品种、周期这些标注，读不准的地方仍然要你确认。',
    cannot: '本机没有开识字服务，所以按图搜索时品种和周期要你自己填。',
    setup: '把 native/ocr.swift 编成本机可执行文件，配好 SCOREBOOK_OCR_EXECUTABLE 再重启后端。',
  },
  {
    key: 'historical_search',
    title: '在币安历史里搜',
    can: '可以在已经建好索引的那部分币安历史里找相似结构，来源会逐段核验。',
    cannot: '还不能在币安历史里搜。',
  },
  {
    key: 'trade_ledger',
    title: '真实成交账本',
    can: '导入的成交按原样保存，持仓轮次和账本快照由它们推出来，不覆盖交易所给的价格。',
    cannot: '成交账本没有就绪。',
  },
  {
    key: 'exchange_accounts',
    title: '连交易所账户',
    can: '可以按只读权限把成交读进来，和当时那条判断对上。',
    cannot: '还没有配只读账户，现在只能用 CSV 或者交易所导出的账单导入。',
    setup: '在本机 Keychain 里放好只读密钥，再在这里建立连接；密钥不经过浏览器。',
  },
  {
    key: 'formal_statistics',
    title: '正式统计',
    can: '可以按固定的一次统计，看它由哪些记录组成、代表样本和分组。',
    cannot: '正式统计没有就绪，这里不会给你任何一个看起来像胜率的数字。',
  },
  {
    key: 'baseline',
    title: '参照基准',
    can: '可以拿同一段历史的 250 日参照来对比，它是参照，不是预测。',
    cannot: '参照基准没有就绪。',
  },
  {
    key: 'knowledge_index',
    title: '在自己的记录里检索',
    can: '可以按意思检索自己的原话、复盘和资料，命中的片段都能回到原文。',
    cannot: '本机的中文检索模型没有启动，按意思检索暂时用不了。',
    setup: '在后端目录里运行 python3 text_encoder/server.py，然后刷新这一页。',
  },
  {
    key: 'chat_generation',
    title: '对着记录提问',
    can: '可以用自然语言问自己的记录，答案按来源引用给出。',
    cannot: '还没有选定问答用的模型，后端会明说没有配置。现在不会给你一个编出来的答案。',
    setup: '先决定用哪个模型供应商并在后端配好，这一步不在浏览器里做。',
  },
  {
    key: 'encrypted_backup',
    title: '加密备份',
    can: '可以把记录和截图加密备份出去，恢复只往空库里做。',
    cannot: '备份还没配好，现在这台机器上的东西只有一份。',
    setup: '装好备份引擎并指定一个独立的仓库位置；密码放 Keychain，不进浏览器。',
  },
]

const STATE_WORD: Record<string, string> = {
  ready: '现在可用',
  needs_setup: '还差一步',
  unknown: '不清楚',
}

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
      const state = capabilityState(row.key)
      const live = state === 'ready'
      const detail = capabilityDetail(row.key)
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
                text: STATE_WORD[state] ?? '不清楚',
              }),
            ),
            h('div.tip', { text: live ? row.can : row.cannot }),
            !live && row.setup ? h('div.tip.dim', { text: row.setup }) : null,
            live && detail ? h('div.tip.dim', { text: `用的是 ${detail}` }) : null,
          ),
        ),
      )
    })
    body.appendChild(list)
    stagger(list.children)

    // 配好了不等于验过。后端自己就是这么说的，页面照抄，不替它下结论。
    body.appendChild(
      note(
        'info',
        qualityAccepted('image_structure_search')
          ? '上面写的是后端此刻自报的状态。'
          : '上面写的是“做了没有、这台机器配了没有”，不是“效果验过了没有”。按图搜索的匹配质量还没有用真实截图盲测验收过，成交、备份和问答也都还要用真实数据走一遍才算数。',
      ),
    )

    body.appendChild(exportPanel())

    // 接上模型它就是一个真的入口，没接上才是「以后会有」。标题跟着实际情况走，
    // 不把已经能用的东西继续摆在「以后」里，也不把没接的说成能用。
    const chat = chatPanel()
    body.appendChild(
      h(
        'div',
        { style: 'margin-top:18px' },
        h('div.eyebrow', { text: chat.live ? '对着自己的记录提问' : '以后会有' }),
        h('div', { style: 'margin-top:10px' }, chat.node),
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
          kv('后端版本', health?.version ?? caps.backend_version ?? '问不到'),
          kv('默认市场', MARKET_LABELS[defaultMarket()]),
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
