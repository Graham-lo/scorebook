// 一条结果跟手里这张图有多像，只说三个词：很像 / 像 / 有点像。
//
// 词从后端来。它按档位抽样跑过一遍同样的检索，知道这个分在同类窗口里稀不稀奇，
// 于是给出 `level`；前端不再把 0.347 这种数摆出来——那既读不出轻重，又容易被
// 当成涨跌概率。
//
// 后端还没给 `level` 的时候按旧的分数分档，界限是交付文档定的：
// ≥0.75 很像、≥0.6 像、≥0.45 有点像，再低就不说像，也就不显示这一条。

import type { MatchScore } from '../../api/chart'

export const LEVELS = ['很像', '像', '有点像'] as const
export type Level = (typeof LEVELS)[number]

/** 后端要是用标识符写这一格，翻回那三个词。 */
const CODES: Record<string, Level> = {
  sure: '很像',
  likely: '像',
  strong: '很像',
  high: '很像',
  very_similar: '很像',
  similar: '像',
  medium: '像',
  mid: '像',
  moderate: '像',
  weak: '有点像',
  low: '有点像',
  somewhat_similar: '有点像',
}

function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value)
}

/** 没有 `level` 的旧后端：按分数分档。 */
export function levelFromScore(score: number): Level | null {
  if (!Number.isFinite(score)) return null
  if (score >= 0.75) return '很像'
  if (score >= 0.6) return '像'
  if (score >= 0.45) return '有点像'
  return null
}

/** 这一条该念哪个词；哪个词都算不上就是 null，不显示。 */
export function levelWord(match: MatchScore | null | undefined): Level | null {
  if (!match) return null
  const given = typeof match.level === 'string' ? match.level.trim() : ''
  if (given) {
    if (isLevel(given)) return given
    const word = CODES[given.toLowerCase()]
    if (word) return word
    if (given.toLowerCase() === 'none') return null
  }
  return levelFromScore(match.score)
}
