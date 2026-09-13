// 部署之后，还开着旧页签的人第一次点开一个按需加载的模块会 404：那一份带哈希
// 的文件已经被新构建换掉了。刷新一次就好——但只刷一次，不然遇到真正的网络问题
// 会原地打转。刷过的时间戳记在 sessionStorage 里，一分钟之内不再刷第二次。

const KEY = 'sb.chunk-reload'
const WINDOW_MS = 60_000

const MARKS = [
  'Failed to fetch dynamically imported module',
  'Importing a module script failed',
  'error loading dynamically imported module',
]

/** 把浏览器那几样单独拎出来，纯逻辑就能单测。 */
export interface ChunkEnv {
  now(): number
  read(key: string): string | null
  write(key: string, value: string): void
  reload(): void
}

const browser: ChunkEnv = {
  now: () => Date.now(),
  read: (key) => {
    try {
      return window.sessionStorage.getItem(key)
    } catch {
      return null
    }
  },
  write: (key, value) => {
    try {
      window.sessionStorage.setItem(key, value)
    } catch {
      /* 隐私模式下写不进去：那就当没刷过，最多多刷一次 */
    }
  },
  reload: () => {
    window.location.reload()
  },
}

/** 这个错是不是「旧页签拿不到新文件」。 */
export function isChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (MARKS.some((mark) => message.includes(mark))) return true
  return error instanceof TypeError
}

/**
 * 命中就刷新一次并返回 true；已经刷过（一分钟内）就返回 false，交给调用方
 * 把「页面已更新，刷新一下再看」摆出来。
 */
export function recoverChunk(error: unknown, env: ChunkEnv = browser): boolean {
  if (!isChunkError(error)) return false
  const last = Number(env.read(KEY))
  if (Number.isFinite(last) && last > 0 && env.now() - last <= WINDOW_MS) return false
  env.write(KEY, String(env.now()))
  env.reload()
  return true
}
