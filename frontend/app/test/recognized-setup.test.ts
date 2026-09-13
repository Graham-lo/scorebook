// 截图上认出来的指标 → 记录里的那份种子。
//
// 这一份只是种子：写进记录以后画不画由人决定，所以这里只验「换算对不对」，
// 不验「会不会自动画」。

import assert from 'node:assert/strict'
import test from 'node:test'
import type { RecognizedIndicator } from '../src/api/chart'
import {
  recognizedNames,
  recognizedTip,
  setupFromRecognized,
} from '../src/features/relive/recognized-setup'

function ind(
  name: string,
  parameters: number[] = [],
  parameter_source: RecognizedIndicator['parameter_source'] = 'visible_text',
): RecognizedIndicator {
  return { name, parameters, source: 'legend', parameter_source }
}

test('图上读到的参数原样进 setup', () => {
  const setup = setupFromRecognized([
    ind('MA', [7, 25, 99]),
    ind('BOLL', [21, 2]),
    ind('MACD', [12, 26, 9]),
    ind('RSI', [6]),
    ind('MAVOL', [5, 10]),
  ])
  assert.deepEqual(setup.ma, [7, 25, 99])
  assert.deepEqual(setup.boll, { n: 21, k: '2' })
  assert.deepEqual(setup.macd, { fast: 12, slow: 26, signal: 9 })
  assert.deepEqual(setup.rsi, { n: 6 })
  assert.deepEqual(setup.volume, { ma: [5, 10] })
})

test('只认出名字没读到参数：按默认那一套补上', () => {
  const setup = setupFromRecognized([ind('MA'), ind('EMA'), ind('BOLL'), ind('MACD'), ind('RSI')])
  assert.deepEqual(setup.ma, [30, 120, 256])
  assert.deepEqual(setup.ema, [12, 144, 169])
  assert.deepEqual(setup.boll, { n: 20, k: '2' })
  assert.deepEqual(setup.macd, { fast: 10, slow: 30, signal: 9 })
  assert.deepEqual(setup.rsi, { n: 14 })
})

test('只有成交量柱：量均线是空的，不替人补一串', () => {
  const setup = setupFromRecognized([ind('VOL')])
  assert.deepEqual(setup.volume, { ma: [] })
  // 认出量均线才有那几条线。
  assert.deepEqual(setupFromRecognized([ind('MAVOL')]).volume, { ma: [5, 10, 30, 60, 120] })
})

test('KDJ 和持仓量画不了：只出现在名字里，不进 setup', () => {
  const list = [ind('KDJ', [9, 3, 3]), ind('持仓量'), ind('MA', [30])]
  const setup = setupFromRecognized(list)
  assert.deepEqual(setup.ma, [30])
  assert.equal(setup.macd, null)
  assert.equal(setup.rsi, null)
  assert.equal(setup.volume, null)
  // 名字那一行还是要把它们说出来。
  assert.deepEqual(recognizedNames(list), ['MA', 'KDJ', '持仓量'])
})

test('快慢线反了的 MACD 不要，退回默认', () => {
  assert.deepEqual(setupFromRecognized([ind('MACD', [26, 12, 9])]).macd, {
    fast: 10,
    slow: 30,
    signal: 9,
  })
})

test('名字去重、按固定顺序排；一个都没有就是空', () => {
  const names = recognizedNames([ind('RSI'), ind('VOL'), ind('MA', [30]), ind('MA', [120])])
  assert.deepEqual(names, ['MA', '成交量', 'RSI'])
  assert.deepEqual(recognizedNames(undefined), [])
  assert.deepEqual(recognizedNames([]), [])
})

test('鼠标停上去那一句：参数是图上读到的还是按默认给的，分开说', () => {
  const tip = recognizedTip([
    ind('MA', [30, 120], 'visible_text'),
    ind('RSI', [14], 'user_default'),
    ind('VOL'),
  ])
  assert.equal(tip, 'MA 30/120（图上读到） · RSI 14（默认） · 成交量')
  assert.equal(recognizedTip(undefined), '')
})
