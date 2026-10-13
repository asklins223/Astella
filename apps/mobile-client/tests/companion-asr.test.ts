import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { companionApi } from '../src/platform/api.ts'
import { clearToken, saveToken } from '../src/platform/credentials.ts'

const artifactId = '33333333-3333-4333-8333-333333333333'
const validTranscription = {
  version: 1,
  voiceArtifactId: artifactId,
  text: '解释一下这段内容',
  transcriptSha256: 'a'.repeat(64),
  asrProvider: 'mimo',
  asrModel: 'mimo-v2.5-asr',
  language: 'zh',
  durationMs: 1240,
  expiresAt: '2026-10-12T12:00:00.000Z',
}

describe('手机小米 MiMo 语音识别上传', () => {
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

  it('把整段 WAV 和 companion purpose 发到服务端并验证 MiMo 来源 artifact', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(validTranscription), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const file = new File([new Uint8Array([1, 2, 3])], 'mobile-voice.wav', { type: 'audio/wav' })

    await expect(companionApi.transcribeDialogueAudio(file, 1_239.7)).resolves.toEqual(validTranscription)

    const [input, init] = fetchMock.mock.calls[0]!
    expect(new URL(String(input)).pathname).toBe('/voice/transcribe')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer mobile-test-token')
    expect(new Headers(init?.headers).has('content-type')).toBe(false)
    const form = init?.body as FormData
    expect(form.get('purpose')).toBe('companion_dialogue')
    expect(form.get('language')).toBe('zh-CN')
    expect(form.get('durationMs')).toBe('1240')
    expect(form.get('file')).toBeInstanceOf(File)
  })

  it('拒绝没有 MiMo provenance 的转写回执', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...validTranscription, asrProvider: 'other' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await expect(companionApi.transcribeDialogueAudio(
      new File([new Uint8Array([1])], 'mobile-voice.wav', { type: 'audio/wav' }),
      800,
    )).rejects.toThrow()
  })
})
