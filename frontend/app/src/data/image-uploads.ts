import { uploadWithProgress } from '../api/attachments'
import { WriteAction } from '../api/http'
import { md5Bytes } from '../api/md5'
import type { Attachment, AttachmentKind, Uuid } from '../api/types'

export interface UploadImage {
  file?: File
  preview?: string
  id?: Uuid
  progress: number
  error: string | null
  uploading: boolean
  action: WriteAction
  fingerprint?: Promise<string>
  controller?: AbortController
}

/** Per-image identities prevent late upload responses from replacing another image. */
export class ImageUploads {
  readonly items: UploadImage[] = []
  duplicates = 0
  private tasks = new Set<Promise<void>>()
  onChange: () => void = () => {}
  constructor(readonly kind: AttachmentKind, readonly limit = 20, private upload = uploadWithProgress) {}
  get ids(): Uuid[] { return [...new Set(this.items.flatMap(item => item.id ? [item.id] : []))] }
  get pending(): boolean { return this.items.some(item => !item.id) }
  get uploading(): boolean { return this.items.some(item => item.uploading) }

  add(files: File[]): void {
    const accepted = files.filter(file => /^image\/(png|jpeg|webp)$/.test(file.type))
    if (accepted.length !== files.length) throw new Error('请选择 PNG、JPEG 或 WebP 图片。')
    if (this.items.length + files.length > this.limit) throw new Error(`每次最多上传 ${this.limit} 张截图。`)
    for (const file of files) {
      const item: UploadImage = { file, preview: URL.createObjectURL(file), progress: 0, error: null, uploading: false, action: new WriteAction() }
      this.items.push(item)
      void this.send(item)
    }
    this.onChange()
  }

  restore(ids: Uuid[]): void {
    this.clear()
    this.items.push(...[...new Set(ids)].map(id => ({ id, progress: 1, error: null, uploading: false, action: new WriteAction() })))
    this.onChange()
  }

  remove(item: UploadImage): void {
    const index = this.items.indexOf(item)
    if (index < 0) return
    this.items.splice(index, 1)
    item.controller?.abort()
    if (item.preview) URL.revokeObjectURL(item.preview)
    this.onChange()
  }

  clear(): void {
    for (const item of this.items) {
      item.controller?.abort()
      if (item.preview) URL.revokeObjectURL(item.preview)
    }
    this.items.length = 0
    this.duplicates = 0
  }

  async wait(): Promise<void> { await Promise.all([...this.tasks]) }

  send(item: UploadImage): Promise<void> {
    const task = this.transmit(item)
    this.tasks.add(task)
    void task.finally(() => this.tasks.delete(task))
    return task
  }

  private async transmit(item: UploadImage): Promise<void> {
    if (!item.file || item.uploading || !this.items.includes(item)) return
    item.uploading = true
    item.error = null
    const controller = new AbortController()
    item.controller = controller
    this.onChange()
    try {
      const file = item.file
      const fingerprint = (other: UploadImage) => other.fingerprint ??= other.file!.arrayBuffer().then(bytes => `${bytes.byteLength}:${md5Bytes(new Uint8Array(bytes))}`)
      const hash = await fingerprint(item)
      for (const earlier of this.items.slice(0, this.items.indexOf(item))) {
        if (!earlier.file || earlier.file.size !== file.size || await fingerprint(earlier) !== hash) continue
        // Compare bytes too: even a hash collision must never discard a different screenshot.
        const [a, b] = await Promise.all([earlier.file.arrayBuffer(), file.arrayBuffer()])
        const left = new Uint8Array(a), right = new Uint8Array(b)
        if (this.items.includes(earlier) && left.every((byte, i) => byte === right[i])) {
          this.duplicates++; this.remove(item); return
        }
      }
      if (!this.items.includes(item)) return
      const attachment: Attachment = await this.upload(file, this.kind, item.action.keyFor({ name: file.name, size: file.size, modified: file.lastModified }), {
        filename: file.name,
        capturedAt: file.lastModified > 0 && file.lastModified < Date.now() ? new Date(file.lastModified) : undefined,
        signal: controller.signal,
        onProgress: progress => {
          if (!this.items.includes(item)) return
          item.progress = progress
          this.onChange()
        },
      })
      if (!this.items.includes(item)) return
      if (this.items.some(other => other !== item && other.id === attachment.id)) {
        this.duplicates++; this.remove(item); return
      }
      item.id = attachment.id
      item.progress = 1
    } catch (error) {
      if (!this.items.includes(item)) return
      item.error = error instanceof Error ? error.message : '图片上传失败，请重试。'
    } finally {
      item.uploading = false
      if (this.items.includes(item)) this.onChange()
    }
  }
}
