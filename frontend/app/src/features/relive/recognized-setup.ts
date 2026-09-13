// 截图上认出来的那几条指标，怎么变成一份「图上画什么」。
//
// 这一份只是**种子**：记一笔的时候把它写进记录，以后想画的时候有个现成的参数，
// 不是「认出来就自动画」。任何一张图默认只有 K 线，指标一律要人自己开。
//
// 认出来的名字比能画的线多（KDJ、持仓量这两样这里不算），多出来的只出现在
// 「认出来：…」那一行事实里，不进 setup。

import type { RecognizedIndicator } from '../../api/chart'
import type { ChartSetup } from '../../api/types'
import { normalizeSetup } from './setup'

/** 一个都没读到参数时各用这一套，和截图上那一套对齐。 */
const FALLBACK = {
  ma: [30, 120, 256],
  ema: [12, 144, 169],
  boll: { n: 20, k: 2 },
  mavol: [5, 10, 30, 60, 120],
  macd: { fast: 10, slow: 30, signal: 9 },
  rsi: 14,
}

/** 显示用的名字，以及它们在一行里的先后。 */
const DISPLAY: Record<string, string> = {
  MA: 'MA',
  EMA: 'EMA',
  BOLL: 'BOLL',
  VOL: '成交量',
  MAVOL: '量均线',
  MACD: 'MACD',
  RSI: 'RSI',
  KDJ: 'KDJ',
  持仓量: '持仓量',
}

const NAME_ORDER = ['MA', 'EMA', 'BOLL', '成交量', '量均线', 'MACD', 'RSI', 'KDJ', '持仓量']

function key(name: string): string {
  return name.trim().toUpperCase()
}

function label(name: string): string {
  const found = DISPLAY[key(name)]
  return found ?? name.trim()
}

function numbers(values: unknown): number[] {
  if (!Array.isArray(values)) return []
  return values.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
}

/**
 * 把认出来的那一串换成一份 setup。出来的一份过一次 normalizeSetup，
 * 所以周期越界、快慢线反了这类脏数据到不了画图那一步。
 */
export function setupFromRecognized(list: RecognizedIndicator[] | undefined): ChartSetup {
  const wire: Record<string, unknown> = { ma: [], ema: [] }
  let volumeOn = false
  let volumeMa: number[] | null = null
  for (const item of list ?? []) {
    const p = numbers(item.parameters)
    switch (key(item.name)) {
      case 'MA':
        wire['ma'] = [...(wire['ma'] as number[]), ...(p.length ? p : FALLBACK.ma)]
        break
      case 'EMA':
        wire['ema'] = [...(wire['ema'] as number[]), ...(p.length ? p : FALLBACK.ema)]
        break
      case 'BOLL':
        wire['boll'] = { n: p[0] ?? FALLBACK.boll.n, k: String(p[1] ?? FALLBACK.boll.k) }
        break
      case 'MACD': {
        const fast = p[0] ?? FALLBACK.macd.fast
        const slow = p[1] ?? FALLBACK.macd.slow
        const signal = p[2] ?? FALLBACK.macd.signal
        wire['macd'] = fast < slow ? { fast, slow, signal } : { ...FALLBACK.macd }
        break
      }
      case 'VOL':
        volumeOn = true
        break
      case 'MAVOL':
        volumeOn = true
        volumeMa = p.length ? p : [...FALLBACK.mavol]
        break
      case 'RSI':
        wire['rsi'] = { n: p[0] ?? FALLBACK.rsi }
        break
      default:
        // KDJ、持仓量和认不出来的：只出现在名字里，不画。
        break
    }
  }
  if (volumeOn) wire['volume'] = { ma: volumeMa ?? [] }
  return normalizeSetup(wire)
}

/** 显示用名字，去重并按固定顺序排好。 */
export function recognizedNames(list: RecognizedIndicator[] | undefined): string[] {
  const seen: string[] = []
  for (const item of list ?? []) {
    const name = label(item.name)
    if (name && !seen.includes(name)) seen.push(name)
  }
  return seen.sort((a, b) => {
    const ia = NAME_ORDER.indexOf(a)
    const ib = NAME_ORDER.indexOf(b)
    return (ia === -1 ? NAME_ORDER.length : ia) - (ib === -1 ? NAME_ORDER.length : ib)
  })
}

/** 鼠标停上去那一句：每一项的参数，以及参数是图上读到的还是按默认给的。 */
export function recognizedTip(list: RecognizedIndicator[] | undefined): string {
  const parts: string[] = []
  for (const item of list ?? []) {
    const name = label(item.name)
    const p = numbers(item.parameters)
    let text = name
    if (p.length) {
      const source =
        item.parameter_source === 'visible_text'
          ? '（图上读到）'
          : item.parameter_source === 'user_default'
            ? '（默认）'
            : ''
      text = `${name} ${p.join('/')}${source}`
    }
    if (text && !parts.includes(text)) parts.push(text)
  }
  return parts.join(' · ')
}
