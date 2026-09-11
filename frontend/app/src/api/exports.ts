// 把自己的记录导出一份。
//
// 导出是一项后台任务：交出去之后拿到编号，页面关掉它照样在做。这份导出的编号和
// 任务编号是同一个，所以刷新之后凭编号既能接着看进度，也能接着下载。中途断了不用
// 从头来——同一份导出接着做就行。
//
// 下载走同源的开发代理，凭证由代理在服务端加上，页面本身不碰凭证；导出的内容也
// 不会被存进浏览器，链接指向后端，点一次下一次。

import { apiUrl, getBlob, postJson, type RequestOptions } from './http'
import type { Uuid } from './types'

/** POST /v1/exports 交出去之后拿到的东西。 */
export interface ExportStarted {
  job_id: Uuid
  status: string
}

export function create(idempotencyKey: string, opts: RequestOptions = {}): Promise<ExportStarted> {
  return postJson('/v1/exports', {}, { ...opts, idempotencyKey })
}

/** 任务做完之后，结果里写着这一份导出是什么。 */
export interface ExportDone {
  export_id: Uuid
  /** 整份导出的校验码，后端的校验命令比对的就是它。 */
  manifest_sha256: string
  /** 一起打包进去的截图张数。 */
  files?: number
}

/** 任务的结果字段是自由格式，用之前先确认它确实是一份做完的导出。 */
export function done(result: unknown): ExportDone | null {
  if (!result || typeof result !== 'object') return null
  const v = result as Record<string, unknown>
  if (v.status !== 'complete') return null
  if (typeof v.export_id !== 'string' || typeof v.manifest_sha256 !== 'string') return null
  return {
    export_id: v.export_id,
    manifest_sha256: v.manifest_sha256,
    files: typeof v.files === 'number' ? v.files : undefined,
  }
}

/** 清单里按类别记着各有多少条，以及一起打包的截图张数。 */
export interface ExportManifest {
  tables: Record<string, { rows?: number } | undefined>
  attachment_files?: number
  created_at?: string
}

/**
 * 读这份导出的清单。
 *
 * 它是导出目录里的一个普通文件，直接原样发回来，没有接口那层 `{data, meta}` 外壳，
 * 所以这里自己解析，不走 getJson。
 */
export async function manifest(id: Uuid, opts: RequestOptions = {}): Promise<ExportManifest> {
  const text = await (await getBlob(`/v1/exports/${id}/manifest`, opts)).text()
  return JSON.parse(text) as ExportManifest
}

/** 给 <a href> 用的地址：浏览器直接下载，中间是同源代理。 */
export function manifestUrl(id: Uuid): string {
  return apiUrl(`/v1/exports/${id}/manifest`)
}

export function fileUrl(id: Uuid, name: string): string {
  return apiUrl(`/v1/exports/${id}/files/${name}`)
}
