import { apiOrigin } from './config.ts'
import { getToken } from './credentials.ts'

/** 服务端错误信封是 `{error, message?}`；这一层把它变成能判读的异常。 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly body: unknown

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message || code)
    this.status = status
    this.code = code
    this.body = body
  }

  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | null | undefined>
  headers?: Record<string, string>
  signal?: AbortSignal
  idempotencyKey?: string
}

export function urlFor(path: string, query?: RequestOptions['query']): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, apiOrigin)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

function authHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const token = getToken()
  // 只有 Bearer 一条路：CSRF 那一道闸只在凭据来自 cookie 时才落，浏览器端不必两头带。
  return token ? { ...headers, authorization: `Bearer ${token}` } : headers
}

async function failure(response: Response): Promise<ApiError> {
  let code = `http_${response.status}`
  let message = response.statusText
  let body: unknown
  try {
    body = await response.json()
    const envelope = body as { error?: string; message?: string }
    if (envelope.error) code = envelope.error
    if (envelope.message) message = envelope.message
  } catch {
    /* 非 JSON 的错误体（网关、413 纯文本）保留状态码作为判据 */
  }
  return new ApiError(response.status, code, message, body)
}

export async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(urlFor(path, options.query), {
    method: options.method ?? 'GET',
    headers: authHeaders({
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      ...options.headers,
    }),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  })
  if (!response.ok) throw await failure(response)
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/**
 * Multipart uploads keep the browser-generated boundary intact. Do not set
 * `content-type` here: doing so drops the boundary some servers need to read
 * the file stream.
 */
export async function requestFormData<T>(path: string, body: FormData, options: Pick<RequestOptions, 'signal'> = {}): Promise<T> {
  const response = await fetch(urlFor(path), {
    method: 'POST',
    headers: authHeaders(),
    body,
    signal: options.signal,
  })
  if (!response.ok) throw await failure(response)
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** Read a private image with the same Bearer session used by JSON requests. */
export async function requestBlob(path: string, options: Pick<RequestOptions, 'signal'> = {}): Promise<Blob> {
  const response = await fetch(urlFor(path), {
    headers: authHeaders(),
    signal: options.signal,
  })
  if (!response.ok) throw await failure(response)
  return response.blob()
}

/** 取一段属于本人、不缓存的原始文本（动态讲解的成品 HTML 就靠这一条）。 */
export async function requestText(path: string, options: RequestOptions = {}): Promise<string> {
  const response = await fetch(urlFor(path, options.query), {
    method: options.method ?? 'GET',
    headers: authHeaders(options.headers),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  })
  if (!response.ok) throw await failure(response)
  return response.text()
}

export { apiOrigin }
