import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { companionApi } from '../src/platform/api.ts'
import { clearToken, saveToken } from '../src/platform/credentials.ts'

const imageUrl = '/api/uploads/11111111-1111-4111-8111-111111111111/companion/22222222-2222-4222-8222-222222222222.png'
const assetId = '33333333-3333-4333-8333-333333333333'

describe('手机伴星图片上传', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    saveToken('mobile-test-token')
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('用带 Bearer 的 multipart 上传，并返回可直接加入回合的站内图片块', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      assetId,
      url: imageUrl,
      objectKey: imageUrl.slice('/api/uploads/'.length),
      size: 1024,
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      width: 1200,
      height: 800,
    }), { status: 201, headers: { 'content-type': 'application/json' } }))

    const file = new File([new Uint8Array([1, 2, 3])], '白板.png', { type: 'image/png' })
    const block = await companionApi.uploadImage(file)

    expect(block).toEqual({
      type: 'image', url: imageUrl, label: '白板.png', alt: '白板.png', assetId,
    })
    const [input, init] = fetchMock.mock.calls[0]!
    expect(new URL(String(input)).pathname).toBe('/uploads/companion-images')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer mobile-test-token')
    expect(headers.has('content-type')).toBe(false)
    expect(init?.body).toBeInstanceOf(FormData)
    expect((init?.body as FormData).get('file')).toBeInstanceOf(File)
  })

  it('拒绝无法由当前图片合同显示的服务端 URL', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      assetId,
      url: 'https://outside.example/photo.png',
      size: 1024,
      mimeType: 'image/png',
      width: 1200,
      height: 800,
    }), { status: 201, headers: { 'content-type': 'application/json' } }))

    await expect(companionApi.uploadImage(new File([new Uint8Array([1])], '图.png', { type: 'image/png' })))
      .rejects.toThrow()
  })
})
