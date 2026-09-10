import { ApiError, NetworkError, type WireError } from './errors'

const BASE = '/api'

export interface RequestOptions {
  signal?: AbortSignal
  /** Sent as Idempotency-Key. Required by every persisting write. */
  idempotencyKey?: string
  query?: Record<string, string | number | boolean | null | undefined>
}

function url(path: string, query?: RequestOptions['query']): string {
  const u = new URL(BASE + path, location.origin)
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
  }
  return u.pathname + u.search
}

/**
 * 同源的接口地址，给 <a href> 这类由浏览器自己发起的请求用。凭证仍然由代理在
 * 服务端加上，页面里不会出现。
 */
export function apiUrl(path: string): string {
  return BASE + path
}

async function send(path: string, init: RequestInit, opts: RequestOptions): Promise<Response> {
  const headers = new Headers(init.headers)
  if (opts.idempotencyKey) headers.set('Idempotency-Key', opts.idempotencyKey)
  let response: Response
  try {
    response = await fetch(url(path, opts.query), { ...init, headers, signal: opts.signal })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new NetworkError(cause)
  }
  if (!response.ok) throw await wireError(response)
  return response
}

async function wireError(response: Response): Promise<ApiError> {
  let wire: Partial<WireError> = {}
  try {
    const body = (await response.json()) as { error?: Partial<WireError> }
    wire = body.error ?? {}
  } catch {
    /* a non-JSON failure body carries nothing useful to a trader */
  }
  return new ApiError(response.status, { code: wire.code ?? 'invalid_request', ...wire })
}

/** Unwraps the {data, meta} success envelope. */
export async function getJson<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const response = await send(path, { method: 'GET' }, opts)
  const body = (await response.json()) as { data: T }
  return body.data
}

export async function postJson<T>(
  path: string,
  payload: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const response = await send(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    opts,
  )
  const body = (await response.json()) as { data: T }
  return body.data
}

/** 覆盖式的写：同一个位置只有一行，重发一次结果一样。 */
export async function putJson<T>(
  path: string,
  payload: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const response = await send(
    path,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    opts,
  )
  const body = (await response.json()) as { data: T }
  return body.data
}

/** 204，没有回执体。 */
export async function sendDelete(path: string, opts: RequestOptions = {}): Promise<void> {
  await send(path, { method: 'DELETE' }, opts)
}

export async function postForm<T>(
  path: string,
  form: FormData,
  opts: RequestOptions = {},
): Promise<T> {
  const response = await send(path, { method: 'POST', body: form }, opts)
  const body = (await response.json()) as { data: T }
  return body.data
}

/** Binary and text media (attachments, SVG charts) bypass the JSON envelope. */
export async function getBlob(path: string, opts: RequestOptions = {}): Promise<Blob> {
  return (await send(path, { method: 'GET' }, opts)).blob()
}

export async function postText(
  path: string,
  payload: unknown,
  opts: RequestOptions = {},
): Promise<string> {
  const response = await send(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    opts,
  )
  return response.text()
}

/**
 * One idempotency key per user action.
 *
 * A network retry of the same action must reuse the key so the backend replays
 * the first result instead of writing a second record. Editing the request and
 * submitting again is a new action, so a changed body mints a new key.
 */
export class WriteAction {
  #key: string | null = null
  #signature = ''

  keyFor(body: unknown): string {
    const signature = JSON.stringify(body ?? null)
    if (this.#key === null || signature !== this.#signature) {
      // randomUUID requires HTTPS or loopback; LAN HTTP still supports getRandomValues.
      const bytes = crypto.getRandomValues(new Uint8Array(16))
      bytes[6] = (bytes[6]! & 0x0f) | 0x40
      bytes[8] = (bytes[8]! & 0x3f) | 0x80
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
      this.#key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      this.#signature = signature
    }
    return this.#key
  }

  /** Call after the action succeeds so the next one starts a fresh key. */
  reset(): void {
    this.#key = null
    this.#signature = ''
  }
}

/**
 * Keeps only the newest in-flight request for a given lane. A late response
 * from a superseded request can never overwrite fresher results.
 */
export class Latest {
  #controller: AbortController | null = null

  begin(): AbortSignal {
    this.#controller?.abort()
    this.#controller = new AbortController()
    return this.#controller.signal
  }

  cancel(): void {
    this.#controller?.abort()
    this.#controller = null
  }

  static aborted(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError'
  }
}

/** 一条 SSE 事件：`id` 是后端的序号，续读时原样带回去。 */
export interface StreamEvent {
  id: number | null
  event: string
  data: string
}

export interface StreamOptions {
  /**
   * 上一次读到的最后一个序号。断线重连时带上它，后端从它之后接着发；
   * 不要因为断线就再发起一次任务。
   */
  lastEventId?: number | null
  signal?: AbortSignal
}

/**
 * 读一条 SSE 流，逐条把事件交给 `onEvent`。
 *
 * 断线不在这里自动重连——是继续读还是回头用 GET 把当前状态问清楚，由调用方
 * 按它自己的语义决定；这里只保证续读用的是 `Last-Event-ID`，而不是新任务。
 * 流正常结束（后端发完终止事件把连接关掉）或被 `signal` 取消时返回。
 */
export async function readEventStream(
  path: string,
  onEvent: (event: StreamEvent) => void,
  opts: StreamOptions = {},
): Promise<void> {
  const headers = new Headers({ Accept: 'text/event-stream' })
  if (opts.lastEventId !== undefined && opts.lastEventId !== null) {
    headers.set('Last-Event-ID', String(opts.lastEventId))
  }
  let response: Response
  try {
    response = await fetch(url(path), { method: 'GET', headers, signal: opts.signal })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new NetworkError(cause)
  }
  if (!response.ok) throw await wireError(response)
  if (!response.body) throw new NetworkError(new Error('no stream body'))

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      // 事件之间用空行分隔；最后一段可能还没收完，留在缓冲里。
      let cut = buffer.indexOf('\n\n')
      while (cut !== -1) {
        const frame = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const parsed = parseFrame(frame)
        if (parsed) onEvent(parsed)
        cut = buffer.indexOf('\n\n')
      }
    }
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new NetworkError(cause)
  } finally {
    // 取消订阅时把底层连接一起收掉，不留半开的流。
    void reader.cancel().catch(() => {})
  }
}

function parseFrame(frame: string): StreamEvent | null {
  let id: number | null = null
  let event = 'message'
  const data: string[] = []
  let payload = false
  for (const raw of frame.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line || line.startsWith(':')) continue // 冒号开头是保活注释
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') {
      const n = Number(value)
      if (Number.isFinite(n)) id = n
    } else if (field === 'event') {
      event = value
    } else if (field === 'data') {
      data.push(value)
      payload = true
    }
  }
  return payload || id !== null ? { id, event, data: data.join('\n') } : null
}

/** 后端翻页一律是游标：拿到 `next_cursor` 就还有下一页，没有就是到底了。 */
export interface Page<T> {
  items: T[]
  next_cursor?: string | null
}

/**
 * 一条列表的翻页状态。只往后翻，不猜总数——后端也不报总数。
 *
 * 同一个筛选条件配一个 Pager；条件一变就换一个新的，不能拿旧游标去翻新条件的
 * 列表（后端会以 `cycle_cursor_filter_mismatch` 这类错误拒绝）。
 */
export class Pager<T> {
  readonly items: T[] = []
  #cursor: string | null = null
  #started = false
  #done = false
  #latest = new Latest()

  constructor(private readonly fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>) {}

  get exhausted(): boolean {
    return this.#done
  }

  /** 已经取过至少一页——用来区分“还没读”和“读了但是空的”。 */
  get loaded(): boolean {
    return this.#started
  }

  get more(): boolean {
    return this.#started && !this.#done
  }

  async next(): Promise<T[]> {
    if (this.#done) return []
    const page = await this.fetchPage(this.#cursor, this.#latest.begin())
    const items = page.items ?? []
    this.items.push(...items)
    this.#cursor = page.next_cursor ?? null
    this.#started = true
    if (!this.#cursor) this.#done = true
    return items
  }

  /** 条件变了就从头来：丢掉旧游标，取消还在路上的那一页。 */
  reset(): void {
    this.#latest.cancel()
    this.items.length = 0
    this.#cursor = null
    this.#started = false
    this.#done = false
  }
}
