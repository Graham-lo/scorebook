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
      this.#key = crypto.randomUUID()
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
