import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'

/**
 * 「写全失败、读照常、文档流连不上」的后端假象（39d W4-4 那条故障注入欠账的处方）。
 *
 * 用法：桌面端主进程认 `DESKTOP_API_ORIGIN`，把它指到这个代理上，应用就以为自己是那台 API。
 *
 * 三件事，缺一不可：
 *  1. **HTTP 按方法分流**：GET/HEAD 原样转发（登录后的读、回读、订阅都还能用），
 *     其余方法在 `writes-fail` 档一律 **503**（这就是"保存失败"）。
 *  2. **不实现 WebSocket**：文档增量走的是 Hocuspocus 那条 WS（`noteDocStreamUrl`），
 *     升级请求在这里被 501 掉 ⇒ 本机改的字交不出去（`dirty` 一直留着）——这正是
 *     "离线编辑"的真实形状，也正是那两条路该出现的时候。
 *  3. **开关在跑动中翻**：登录与开笔记要先在 `pass` 档完成（否则连不进去），
 *     等笔记读完再翻到 `writes-fail`，这样"读照常、写全失败"才是可控的。
 *
 * 为什么不做 WS 帧级故障注入：那要重放 Hocuspocus 协议、还要在连接中途杀掉它，成本高而
 * 收益一样——**连不上**与**连上后写失败**对"这一份草稿交不出去"是同一件事。
 *
 * 副作用（好的那一种）：文档流没连上时，本机改的字永远不会到服务端，所以拿它跑剧本
 * **不会在共享 dev 库里留痕**。
 */
export interface FaultProxy {
  readonly origin: string
  /** `pass` = 全转发；`writes-fail` = GET/HEAD 转发、其余 503。 */
  setMode(mode: 'pass' | 'writes-fail'): void
  close(): Promise<void>
}

export async function startFaultProxy(options: {
  port: number
  upstreamOrigin: string
}): Promise<FaultProxy> {
  let mode: 'pass' | 'writes-fail' = 'pass'
  const upstream = new URL(options.upstreamOrigin)

  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const method = incoming.method ?? 'GET'
    if (mode === 'writes-fail' && method !== 'GET' && method !== 'HEAD') {
      outgoing.writeHead(503, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify({ error: { code: 'api_unavailable', message: 'fault-proxy: writes are failing' } }))
      return
    }
    const proxied = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: incoming.url,
        method,
        headers: { ...incoming.headers, host: upstream.host },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(outgoing)
      },
    )
    proxied.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify({ error: { code: 'api_unavailable', message: 'fault-proxy: upstream unreachable' } }))
    })
    incoming.pipe(proxied)
  })

  // 文档流那条 WS 明确不支持：升级请求在这里就被拒（应用那一侧会把它读成"协同口不在"）。
  server.on('upgrade', (_request, socket) => {
    socket.write('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n')
    socket.destroy()
  })

  await new Promise<void>((resolvePromise) => server.listen(options.port, '127.0.0.1', resolvePromise))

  return {
    origin: `http://127.0.0.1:${options.port}`,
    setMode(next) { mode = next },
    async close() {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    },
  }
}
