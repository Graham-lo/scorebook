// 界面偏好：涨跌配色、截图时区、动效。
//
// 三样都只关这台机器上的这个人，后端不认，所以只写 localStorage。读的时候一律
// 兜底：存过的值不认识就当没设过。

export type UpDown = 'red_up' | 'green_up'
export type MotionPref = 'system' | 'off'

const KEY = 'sb.prefs.v1'

interface Prefs {
  updown: UpDown
  /** `local` 跟随本机，其余是 `+08:00` 这样的固定偏移。 */
  shotZone: string
  motion: MotionPref
}

const FALLBACK: Prefs = { updown: 'green_up', shotZone: 'local', motion: 'system' }

let cache: Prefs | null = null

function read(): Prefs {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<Prefs>) : {}
    cache = {
      updown: parsed.updown === 'red_up' ? 'red_up' : 'green_up',
      shotZone: typeof parsed.shotZone === 'string' ? parsed.shotZone : 'local',
      motion: parsed.motion === 'off' ? 'off' : 'system',
    }
  } catch {
    cache = { ...FALLBACK }
  }
  return cache
}

export function prefs(): Prefs {
  return { ...read() }
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  const next = { ...read(), [key]: value }
  cache = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 无痕窗口写不进去，这一次就只在内存里生效 */
  }
  applyPrefs()
}

/** 动效关掉的时候，整站的过渡和动画都不跑。 */
export function motionOff(): boolean {
  return read().motion === 'off'
}

export function shotZone(): string {
  return read().shotZone
}

/**
 * 把偏好挂到根元素上，剩下的交给 CSS。
 *
 * 涨跌配色换的是 `--up`/`--down` 两个变量本身，所以画 K 线和写结果的地方一句
 * 都不用改——它们本来就只认这两个变量。
 */
export function applyPrefs(): void {
  const root = document.documentElement
  const now = read()
  root.dataset['updown'] = now.updown
  root.dataset['motion'] = now.motion
  if (now.updown === 'red_up') {
    root.style.setProperty('--up', 'var(--unrealized)')
    root.style.setProperty('--down', 'var(--realized)')
  } else {
    root.style.removeProperty('--up')
    root.style.removeProperty('--down')
  }
  window.dispatchEvent(new Event('scorebook:prefs'))
}
