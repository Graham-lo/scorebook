/**
 * MD5，只为一件事存在：算出一次工具调用的证据编号。
 *
 * 后端把每一次工具调用的结果存成一条可以引用的证据，它的编号是写死在契约里的
 * 算式 —— `md5(run_id::text || ':' || tool_call_id)`，再按 8-4-4-4-12 分段当成
 * UUID。前端要拿到「模型想写什么」这件事的正文，就得按同一个算式算出这个编号，
 * 再用 `/v1/knowledge/source` 把它读回来。
 *
 * 浏览器自带的 `crypto.subtle` 没有 MD5（它是故意不提供的，因为 MD5 不能用来
 * 防篡改），所以这里自己算。它在这里只是个「按规则拼出来的地址」，不承担任何
 * 安全用途：真正的防篡改用的是后端给的 `source_version` 和 `arguments_sha256`。
 */

const SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
  14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

const SINE = new Uint32Array(64)
for (let i = 0; i < 64; i += 1) SINE[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)

export function md5Hex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const size = bytes.length
  const blocks = ((size + 8) >> 6) + 1
  const padded = new Uint8Array(blocks * 64)
  padded.set(bytes)
  padded[size] = 0x80
  const view = new DataView(padded.buffer)
  // 末尾八个字节是原文的比特数，小端。超过 512MB 的输入这里用不到。
  view.setUint32(blocks * 64 - 8, (size << 3) >>> 0, true)
  view.setUint32(blocks * 64 - 4, Math.floor(size / 536870912), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const m = new Uint32Array(16)

  for (let block = 0; block < blocks; block += 1) {
    for (let i = 0; i < 16; i += 1) m[i] = view.getUint32(block * 64 + i * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i += 1) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      f = (f + a + (SINE[i] as number) + (m[g] as number)) >>> 0
      a = d
      d = c
      c = b
      const shift = SHIFT[i] as number
      b = (b + ((f << shift) | (f >>> (32 - shift)))) >>> 0
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  return little(a0) + little(b0) + little(c0) + little(d0)
}

function little(word: number): string {
  let out = ''
  for (let i = 0; i < 4; i += 1) out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')
  return out
}

/** 后端的 `md5(...)::uuid` —— 就是把这 32 位十六进制按 UUID 的分段写出来。 */
export function md5Uuid(text: string): string {
  const hex = md5Hex(text)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
