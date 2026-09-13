// 设置 —— 这台机器现在能做什么，备份放哪儿，界面听谁的。
//
// 三组：账户与备份、行情与识图、界面。能力一律只显示状态词，不显示模型名、
// 环境变量名和启动命令——那些是后端的事，写在界面上既没人照着做，也让这一页
// 看起来像一份安装说明。能启动的才给「启动」，不能启动的就只有状态。
//
// 凭证一个字都不进浏览器：令牌由本机代理在服务端加上，备份口令在 Keychain 里。

import * as catalog from '../../api/catalog'
import { ApiError, explain } from '../../api/errors'
import * as exportsApi from '../../api/exports'
import { Latest, WriteAction } from '../../api/http'
import * as jobs from '../../api/jobs'
import type { Capabilities, JobRecord, Uuid } from '../../api/types'
import * as lastExport from '../../data/lastExport'
import { prefs, setPref, type MotionPref, type UpDown } from '../../data/prefs'
import {
  capabilityState,
  loadCapabilities,
} from '../../data/session'
import { append, clear, h, type Child } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { actions, empty, jobLine, note, spinner } from '../../ui/states'
import { marketGroup } from './market'

const lane = new Latest()
const exportAction = new WriteAction()
const retryAction = new WriteAction()


export function settingsPage(host: HTMLElement): () => void {
  let alive = true
  /** 正在盯着后台作业的那几个循环，离开页面时停掉。 */
  const watchers: (() => void)[] = []

  const body = h('div.stack', { style: 'gap:18px' })
  const anchors = h('div.anchors')
  host.appendChild(h('div.spread', {}, h('div.lead', {}, anchors), h('div.bulk', {}, body)))
  body.appendChild(spinner('正在加载'))
  let watchGroups: (() => void) | null = null

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
          title: '连不上本机服务',
          action: h('button.btn.sm', { text: '重试', on: { click: () => void load() } }),
        }),
      )
    }
  }

  function paint(caps: Capabilities, health: { status: string; version: string } | null): void {
    clear(body)
    body.append(backupGroup(caps), marketGroup({ alive: () => alive, stop: stop => watchers.push(stop) }, health), faceGroup())
    stagger(body.children)
    paintAnchors()
  }

  /** 左柱那一列锚点：只在宽屏显示（样式里管），点一下滚到那一组。 */
  function paintAnchors(): void {
    watchGroups?.()
    watchGroups = null
    clear(anchors)
    const groups = Array.from(body.querySelectorAll<HTMLElement>('.setgroup'))
    const links = groups.map((group) => {
      const name = group.querySelector('.eyebrow')?.textContent ?? ''
      return h('button', {
        type: 'button',
        text: name,
        on: { click: () => group.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
      })
    })
    anchors.append(...links)
    const seen = new Map<Element, boolean>()
    const spy = new IntersectionObserver((entries) => {
      for (const entry of entries) seen.set(entry.target, entry.isIntersecting)
      let at = groups.findIndex((group) => seen.get(group))
      if (at < 0) at = 0
      links.forEach((link, index) => link.classList.toggle('on', index === at))
    }, { rootMargin: '-140px 0px -60% 0px' })
    for (const group of groups) spy.observe(group)
    links[0]?.classList.add('on')
    watchGroups = () => spy.disconnect()
    watchers.push(() => watchGroups?.())
  }

  /* ------------------------------------------------------ 账户与备份 */

  function backupGroup(caps: Capabilities): HTMLElement {
    const backup = capabilityState('encrypted_backup') === 'ready'
    return group(
      '账户与备份',
      exportRow(),
      row('从备份恢复', h('span.faint', { text: '需在本机恢复工具中操作' }), h('span.faint', { text: '恢复到独立的空数据库并核验附件；这个页面不执行恢复。' })),
      row('加密备份配置', word(backup ? '已配置' : '未配置', backup)),
      row('本机令牌', h('span.faint', { text: '不进浏览器' })),
      row('后端版本', h('span.faint.mono', { text: caps.backend_version ?? '—' })),
    )
  }

  /**
   * 导出一份。
   *
   * 导出跑在后端，不在这个页面里：交出去之后关掉页面它照样在做。编号记在本机，
   * 刷新之后接着看进度、接着下载。导出的内容一条都不进浏览器。
   */
  function exportRow(): HTMLElement {
    const stage = h('div')
    let stopped = false
    watchers.push(() => {
      stopped = true
    })

    let generation = 0
    let starting = false
    const startButton = h('button.btn.sm', { text: '导出', on: { click: () => void start() } }) as HTMLButtonElement
    const saved = lastExport.read()
    if (saved) {
      stage.appendChild(spinner('正在加载'))
      void watch(saved.id)
    } else {
      idle()
    }
    return row('导出全部', startButton, stage)

    function show(...children: Child[]): void {
      if (stopped || !alive) return
      clear(stage)
      append(stage, children)
    }

    function idle(lead?: HTMLElement): void {
      show(lead ?? null)
    }

    async function start(): Promise<void> {
      if (starting) return
      starting = true
      startButton.disabled = true
      generation += 1
      show(spinner('正在加载'))
      try {
        const started = await exportsApi.create(exportAction.keyFor({ export: 'all' }))
        exportAction.reset()
        lastExport.remember({ id: started.job_id, started_at: new Date().toISOString() })
        void watch(started.job_id)
      } catch (error) {
        if (stopped || !alive) return
        idle(note('warn', error instanceof Error ? error.message : '没保存上，再试一次'))
      } finally { starting = false; startButton.disabled = false }
    }

    /** 每两秒问一次后端做到哪儿了；它停下来就交给 settle 决定怎么说。 */
    async function watch(id: Uuid): Promise<void> {
      const round = ++generation
      for (;;) {
        let job: JobRecord
        try {
          job = await jobs.get(id)
        } catch (error) {
          if (stopped || !alive || round !== generation) return
          if (error instanceof ApiError && error.status === 404) { lastExport.forget(); idle(note('info', '这份导出已经过期或被清掉了')) }
          else show(note('warn', '暂时没读到进度，导出编号已保留'), h('button.btn.sm', { text: '重试读取', on: { click: () => void watch(id) } }))
          return
        }
        if (stopped || !alive || round !== generation) return
        if (!jobs.isRunning(job)) {
          await settle(job)
          return
        }
        const line = jobs.jobLine(job.status)
        show(jobLine(line.text, line.progress))
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
        idle(note('info', '上一份不做了'))
        return
      }
      show(
        note('warn', job.error_code ? explain(job.error_code) : '没做完'),
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
            text: '重新导',
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
      show(spinner('正在加载'))
      try {
        await jobs.retry(job.id, job.generation, retryAction.keyFor({ id: job.id, g: job.generation }))
        await watch(job.id)
      } catch (error) {
        if (stopped || !alive) return
        show(note('warn', error instanceof Error ? error.message : '没保存上，再试一次'))
      }
    }

    async function finish(finished: exportsApi.ExportDone): Promise<void> {
      const round = generation
      let counts: exportsApi.ExportManifest | null = null
      try {
        counts = await exportsApi.manifest(finished.export_id)
      } catch (error) {
        if (stopped || !alive || round !== generation) return
        if (error instanceof ApiError && error.status === 404) { lastExport.forget(); idle(note('info', '这份导出已经过期或被清掉了')) }
        else show(note('warn', '暂时没读到导出清单'), h('button.btn.sm', { text: '重试读取', on: { click: () => void finish(finished) } }))
        return
      }
      if (stopped || !alive || round !== generation) return
      const rows = (table: string): number => counts?.tables?.[table]?.rows ?? 0
      const shots = counts.attachment_files ?? finished.files ?? 0
      show(
        h(
          'div.exdone',
          {},
          h(
            'div.exnums',
            {},
            exnum(rows('calls'), '记录'),
            exnum(rows('reviews'), '复盘'),
            exnum(shots, '截图'),
          ),
          h('span.faint', { text: '完整导出保存在本机，下面下载的是核对清单。' }),
          actions(
            h('a.btn.sm', {
              text: '下载清单',
              href: exportsApi.manifestUrl(finished.export_id),
              attrs: { download: 'manifest.json', rel: 'noopener' },
            }),
            h('button.btn.ghost.sm', {
              text: '重新导',
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
        ),
      )
    }

    function exnum(value: number, label: string): HTMLElement {
      return h('div.exnum', {}, h('span.v', { text: String(value) }), h('span.k', { text: label }))
    }
  }

  /* ------------------------------------------------------------ 界面 */

  function faceGroup(): HTMLElement {
    const now = prefs()
    return group(
      '界面',
      row(
        '涨跌配色',
        choices<UpDown>(
          [
            ['red_up', '红涨绿跌'],
            ['green_up', '绿涨红跌'],
          ],
          now.updown,
          (value) => {
            setPref('updown', value)
            repaintFace()
          },
        ),
      ),
      row('截图时区', zonePick(now.shotZone)),
      row(
        '动效',
        choices<MotionPref>(
          [
            ['system', '跟随系统'],
            ['off', '关闭'],
          ],
          now.motion,
          (value) => {
            setPref('motion', value)
            repaintFace()
          },
        ),
      ),
    )
  }

  /** 改完偏好只重画这一组，别让整页跳一下。 */
  function repaintFace(): void {
    const old = body.querySelector('.setgroup:last-child')
    if (!old) return
    old.replaceWith(faceGroup())
  }

  function zonePick(current: string): HTMLElement {
    const pick = h('select.input', {}) as HTMLSelectElement
    pick.appendChild(h('option', { value: 'local', text: '跟随本机' }))
    for (let offset = -12; offset <= 14; offset += 1) {
      const sign = offset < 0 ? '-' : '+'
      const value = `${sign}${String(Math.abs(offset)).padStart(2, '0')}:00`
      pick.appendChild(h('option', { value, text: `UTC${value}` }))
    }
    pick.value = current
    pick.addEventListener('change', () => setPref('shotZone', pick.value))
    return pick
  }

  return () => {
    alive = false
    lane.cancel()
    for (const stop of watchers) stop()
  }
}

/* --------------------------------------------------------------- 零件 */

function group(name: string, ...rows: Child[]): HTMLElement {
  const box = h('section.sheet.pad.setgroup', {}, h('div.eyebrow.noline', { text: name }))
  const stack = h('div.setrows')
  append(stack, rows)
  box.appendChild(stack)
  return box
}

/** 设置里的一行：左边名字，右边状态或控件，需要时底下再挂一块。 */
function row(label: string, right: Child, body: Child = null): HTMLElement {
  return h(
    'div.setrow',
    {},
    h('span.l', { text: label }),
    h('span.r', {}, right),
    body ? h('div.b', {}, body) : null,
  )
}

/** 能力状态词，全站只有这一种。 */
function word(text: string, ok: boolean): HTMLElement {
  return h('span', { class: ['badge', ok ? 'ready' : 'wait'], text })
}

function choices<T extends string>(
  options: [T, string][],
  current: T,
  onPick: (value: T) => void,
): HTMLElement {
  const seg = h('span.seg')
  for (const [value, label] of options) {
    seg.appendChild(
      h('button', {
        class: current === value ? 'on' : '',
        text: label,
        on: { click: () => onPick(value) },
      }),
    )
  }
  return seg
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
