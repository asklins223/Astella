import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { COMPANION_MODEL_ROUTE_PREFIX } from '@astella/shared/companion-model-contracts'
import { createAssetResponsePlan } from '../artifact/asset-response'
import type { CompanionModelStore } from './companion-model-store'

/**
 * `device/models/<modelId>/<file>` 这一条路由的响应体（2026-11-18）。
 *
 * 模型文件在 `<userData>/companion-models/<modelId>/`，渲染层经**页面同源**的
 * app scheme 读它——与识别模型同一条理由：跨源读本机文件不可行，同源就意味着
 * CSP 的 `'self'` 直接命中，不需要为下载模型给页面开外连。
 *
 * 准入名单就是安装标记（`installed.json`）里列出的那些路径：前缀之后给任何
 * 未登记的名字（包括 `../../`）都回 404——这条路由没有能力读出目录里的别的东西。
 */

function plainText(status: number, message: string, method: string): Response {
  return new Response(method === 'HEAD' ? null : message, {
    status,
    headers: { 'Content-Length': String(Buffer.byteLength(message)), 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

/** 模型在页面所在 origin 下的挂载点（开发形态由 Vite 插件提供同一前缀）。 */
export function companionModelMountUrl(pageUrl: string, modelId: string, developmentUrl?: string): string {
  const base = developmentUrl ? new URL(developmentUrl).toString() : pageUrl
  return new URL(`${COMPANION_MODEL_ROUTE_PREFIX}${modelId}/`, base).toString()
}

export function createCompanionModelResponder(
  stores: ReadonlyMap<string, CompanionModelStore>,
): (requestedPath: string, request: Request) => Promise<Response> {
  return async (requestedPath: string, request: Request): Promise<Response> => {
    const method = request.method === 'HEAD' ? 'HEAD' : 'GET'
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plainText(405, 'Method not allowed', method)
    }
    const separator = requestedPath.indexOf('/')
    if (separator <= 0) return plainText(404, 'Not found', method)
    const modelId = requestedPath.slice(0, separator)
    const relativePath = requestedPath.slice(separator + 1)
    const store = stores.get(modelId)
    if (!store || relativePath.length === 0 || relativePath.includes('\0')) {
      return plainText(404, 'Not found', method)
    }
    const file = await store.resolveReadableFile(relativePath)
    if (!file) return plainText(404, 'Not found', method)
    const fileStat = await stat(file.path)
    const plan = createAssetResponsePlan(method, fileStat.size, file.contentType, request.headers.get('range'))
    if (!plan.bodyRange) {
      return new Response(null, { status: plan.status, headers: plan.headers })
    }
    return new Response(Readable.toWeb(createReadStream(file.path, plan.bodyRange)) as ReadableStream, {
      status: plan.status,
      headers: { ...plan.headers },
    })
  }
}