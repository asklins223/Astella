import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sharedAlias } from './shared-alias.ts'

const here = resolve(fileURLToPath(new URL('.', import.meta.url)))

/**
 * 开发时把手机端**同源**地接到本机 API。
 *
 * 为什么走代理而不是给 API 加一条 CORS 来源：本机那台 dev 容器是共享的，改它的
 * `CORS_ORIGIN` 会连别人的跑查一起影响；同源代理只动这一份新工程。
 * 生产形态本来就是同源（前端构建产物与 API 同一来源），所以这条不是绕开问题。
 *
 * 路径表跟着 `src/platform/api.ts` 实际调用的路由走，多写一条就是白给；
 * 手机端加了新前缀，这里要一起加。
 */
const DEV_API_PATHS = '^/(auth|me|companion|notes|search|v2|voice|uploads)($|[/\\?])'

function injectApiOrigin() {
  const configuredOrigin = (process.env.VITE_API_ORIGIN ?? '').replace(/\/+$/, '')
  const connectOrigins = configuredOrigin
    ? (() => {
        const api = new URL(configuredOrigin)
        const websocket = new URL(api.origin)
        websocket.protocol = api.protocol === 'https:' ? 'wss:' : 'ws:'
        return ` ${api.origin} ${websocket.origin}`
      })()
    : ''
  return {
    name: 'astella-csp-origin',
    transformIndexHtml(html: string) {
      // 没设就是同源：保留 'self'。外部 API 则只放行配置的 HTTP 与对应 WS 来源。
      return html.replace('__API_ORIGIN__', connectOrigins)
    },
  }
}

export default defineConfig({
  plugins: [react(), injectApiOrigin()],
  resolve: {
    alias: [...sharedAlias, { find: '@', replacement: resolve(here, 'src') }],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: { allow: [resolve(here, '../..')] },
    proxy: {
      [DEV_API_PATHS]: {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // Live2D 的三个 vendor 脚本与模型是运行时按需加载的静态资源，不进 bundle。
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom'] } } },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/__tests__/*.test.{ts,tsx}'],
    alias: [...sharedAlias, { find: '@', replacement: resolve(here, 'src') }],
  },
})
