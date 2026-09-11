import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Local development BFF.
//
// The browser only ever talks to this dev server on the same origin, at /api.
// The Scorebook development credential is read here, in the Node process, from
// the backend's protected file and attached to each forwarded request. It is
// never written into the bundle, into HTML, or into any VITE_* variable, so it
// cannot reach the browser. This arrangement is for a single local developer;
// a real deployment needs per-user sessions instead of one shared key.

const HOST = '127.0.0.1'
const PORT = 5178
const ORIGIN = `http://${HOST}:${PORT}`
const API = process.env.SCOREBOOK_API ?? 'http://127.0.0.1:8787'
// 这个仓库有两种摆法：开发机上前后端是并排的两棵树（../../scorebook-backend），
// 公开仓里它们是同一棵树下的 backend/ 和 frontend/（../../backend）。默认值挨个
// 试一遍，谁在就用谁，这样两种摆法都不必额外配环境变量。
const TOKEN_DEFAULT = resolve(import.meta.dirname, '../../scorebook-backend/data/local-token')
const TOKEN_CANDIDATES = [
  TOKEN_DEFAULT,
  resolve(import.meta.dirname, '../../backend/data/local-token'),
]
const TOKEN_FILE =
  process.env.SCOREBOOK_TOKEN_FILE ??
  TOKEN_CANDIDATES.find((path) => existsSync(path)) ??
  TOKEN_DEFAULT

function credential(): string {
  try {
    const token = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (!token) throw new Error('empty')
    return token
  } catch {
    const looked = process.env.SCOREBOOK_TOKEN_FILE
      ? TOKEN_FILE
      : TOKEN_CANDIDATES.join('\n  ')
    throw new Error(
      `无法读取本机开发凭证，找过这些位置：\n  ${looked}\n` +
        '请先按后端 README 执行 ops/run.sh create-user local --token-file data/local-token，' +
        '或设置 SCOREBOOK_TOKEN_FILE 指向凭证文件。',
    )
  }
}

export default defineConfig({
  root: import.meta.dirname,
  server: {
    host: HOST,
    port: PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: API,
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure(proxy) {
          const token = credential()
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Authorization', `Bearer ${token}`)
            // The backend compares Origin against SCOREBOOK_ALLOWED_ORIGIN.
            proxyReq.setHeader('Origin', ORIGIN)
            proxyReq.removeHeader('cookie')
          })
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['cache-control'] = 'private, no-store'
          })
        },
      },
    },
  },
  build: { target: 'es2022', sourcemap: true },
})
