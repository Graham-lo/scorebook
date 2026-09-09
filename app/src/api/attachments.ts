import { ApiError, NetworkError } from './errors'
import { getBlob, postForm, type RequestOptions } from './http'
import type { Attachment, AttachmentKind, Uuid } from './types'

export function upload(
  file: Blob,
  kind: AttachmentKind,
  idempotencyKey: string,
  options: { capturedAt?: Date; filename?: string; opts?: RequestOptions } = {},
): Promise<Attachment> {
  const form = new FormData()
  form.append('file', file, options.filename ?? 'screenshot.png')
  form.append('kind', kind)
  if (options.capturedAt) form.append('captured_at', options.capturedAt.toISOString())
  return postForm<Attachment>('/v1/attachments', form, { ...options.opts, idempotencyKey })
}

/**
 * Attachment bytes are behind Bearer auth, so they are fetched and handed to
 * the page as an object URL rather than put in a bare <img src>.
 */
export function download(id: Uuid, opts: RequestOptions = {}): Promise<Blob> {
  return getBlob(`/v1/attachments/${id}`, opts)
}

export interface UploadOptions {
  capturedAt?: Date
  filename?: string
  /** 0…1 while the bytes are on the wire. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/**
 * The same upload, over XMLHttpRequest, because fetch cannot report how much
 * of the body has gone out. A screenshot is large enough that a trader should
 * see it move.
 */
export function uploadWithProgress(
  file: Blob,
  kind: AttachmentKind,
  idempotencyKey: string,
  options: UploadOptions = {},
): Promise<Attachment> {
  const form = new FormData()
  form.append('file', file, options.filename ?? 'screenshot.png')
  form.append('kind', kind)
  if (options.capturedAt) form.append('captured_at', options.capturedAt.toISOString())

  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/v1/attachments')
    xhr.responseType = 'text'
    xhr.setRequestHeader('Idempotency-Key', idempotencyKey)
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded / e.total)
    })
    xhr.addEventListener('load', () => {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(xhr.responseText)
      } catch {
        /* handled below */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = (parsed as { data?: Attachment } | null)?.data
        if (data) resolve(data)
        else reject(new ApiError(xhr.status, { code: 'invalid_upload' }))
        return
      }
      const wire = (parsed as { error?: { code?: string } } | null)?.error
      reject(new ApiError(xhr.status, { code: wire?.code ?? 'invalid_upload', ...wire }))
    })
    xhr.addEventListener('error', () => reject(new NetworkError()))
    xhr.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    options.signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(form)
  })
}
