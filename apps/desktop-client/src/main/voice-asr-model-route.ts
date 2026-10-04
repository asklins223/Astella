import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createAssetResponsePlan, mimeTypeForPath } from './asset-response'
import { VOICE_ASR_MODEL_ROUTE_PREFIX } from '@ailearn/shared/voice-asr-model-contracts'
import type { VoiceAsrModelStore } from './voice-asr-model-store'

/**
 * `device/asr/<file>` 这一条路由的响应体（2026-10）。
 *
 * 模型由用户自己下到 `<userData>/voice-models/`，渲染进程经**同一条 app scheme**
 * 读它——所以这一段是「本机文件」与「页面可读」之间唯一的一道闸，单独成文件以便对着测。
 *
 * 三件事都在这里收口：
 *  1. **只认清单里那两个文件名。** 路径是保留前缀，前缀之后给 `settings.json`、
 *     `../../` 或别的什么都回 404——这一段没有能力读出目录里的任何别的东西。
 *  2. **Range 与 HEAD 与普通静态资源同一套语义。** 共用 `createAssetResponsePlan`，
 *     否则一个大文件被 Range 请求时会走成另一种行为，而那条路只在这里被用到。
 *  3. **不发 CORS 头。** 这条路由只在**与页面同源**时用得上（打包后页面在
 *     `ailearn-app://bundle`，模型挂在同一 host 的 `/device/asr/`；开发时由 Vite
 *     开发服务器在同一 origin 提供）。开发模式曾经打算让页面跨源读它，实测那种
 *     自定义 scheme 根本不做 CORS 放行，`fetch` 直接 `TypeError: Failed to fetch`
 *     ——于是改成同源。**同源是这里唯一成立的前提**，不发 ACAO 就是让"跨源读本机文件"
 *     这件事不存在，而不是靠一个以后会被改成 `*` 的头挡着。
 */
function plainText(status: number, message: string, method: string, extraHeaders: Readonly<Record<string, string>> = {}): Response {
  return new Response(method === 'HEAD' ? null : message, {
    status,
    headers: {
      'Content-Length': String(Buffer.byteLength(message)),
      'Content-Type': 'text/plain; charset=utf-8',
      ...extraHeaders
    }
  })
}

/**
 * 模型在**页面所在 origin** 下的挂载点。
 *
 * 两种形态都**同源**，这是整条链路成立的前提：
 *  - 打包后页面在 `ailearn-app://bundle/index.html` → `ailearn-app://bundle/device/asr/`，
 *    由主进程的 app scheme 路由提供；
 *  - 开发时页面在 `http://localhost:5173/`，而 `developmentUrl` 也是它
 *    → `http://localhost:5173/device/asr/`，由 Vite 开发服务器提供。
 *
 * ⚠️ **不要**改写成 `new URL(pageUrl).origin` 当基底。`ailearn-app` 是 Electron 注册出来的
 * 标准 scheme，Node 的 URL 实现不知道这件事，于是它的 `origin` 是 `"null"`——
 * 拼出来是 `Invalid URL`，而且**只在打包形态犯**（开发形态的 origin 恰好是对的）。
 * 所以基底一律是完整页面 URL。
 */
export function voiceAsrModelMountUrl(pageUrl: string, developmentUrl?: string): string {
  const base = developmentUrl ? new URL(developmentUrl).toString() : pageUrl;
  return new URL(VOICE_ASR_MODEL_ROUTE_PREFIX, base).toString();
}

export function createVoiceAsrModelResponder(
  store: VoiceAsrModelStore
): (requestedName: string, request: Request) => Promise<Response> {
  return async (requestedName: string, request: Request): Promise<Response> => {
    const method = request.method === 'HEAD' ? 'HEAD' : 'GET'
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plainText(405, 'Method not allowed', method, { Allow: 'GET, HEAD' })
    }

    let name: string
    try {
      name = decodeURIComponent(requestedName)
    } catch {
      return plainText(400, 'Invalid path encoding', method)
    }
    if (name.includes('\0')) return plainText(400, 'Invalid path', method)

    // 准入名单就在 store 里（`resolveReadablePath` 只认那两文件），
    // 所以这一段没有能力读出目录里的其它东西。
    const filePath = await store.resolveReadablePath(name)
    if (!filePath) return plainText(404, 'Not found', method)

    const fileStat = await stat(filePath)
    const plan = createAssetResponsePlan(method, fileStat.size, mimeTypeForPath(filePath), request.headers.get('range'))
    if (!plan.bodyRange) {
      return new Response(null, { status: plan.status, headers: plan.headers })
    }

    return new Response(Readable.toWeb(createReadStream(filePath, plan.bodyRange)) as ReadableStream, {
      status: plan.status,
      headers: { ...plan.headers }
    })
  }
}
