import { describe, expect, it, vi } from 'vitest'

/**
 * 接线级验证（2026-10-17）：IPC 往返 → 增量解码 → 出声。
 *
 * 真窗口这趟跑不了（共享包正在重构，vite 解析不了 renderer 入口），
 * 所以把三段的接缝在单测里对起来：主进程推来的 chunk 形状、preload 归一化、
 * 播放器按顺序排播、失败退回整段。
 */

const FRAME = (() => {
  const bytes = new Uint8Array(417)
  bytes[0] = 0xff; bytes[1] = 0xfb; bytes[2] = 0x90; bytes[3] = 0x00
  return bytes
})()

function unitOf(frames: number, tag: number): Uint8Array {
  const out = new Uint8Array(FRAME.length * frames)
  for (let index = 0; index < frames; index += 1) {
    const copy = FRAME.slice()
    copy[4] = tag
    out.set(copy, index * FRAME.length)
  }
  return out
}

describe('流式朗读的 IPC 往返', () => {
  it('chunk 事件：Uint8Array 与普通数组两种形状都被收下并归一化', async () => {
    const { companionVoiceSpeakChunkEventV1Schema } = await import('@astella/shared/companion-voice-contracts')
    const asTyped = companionVoiceSpeakChunkEventV1Schema.parse({
      version: 1, kind: 'chunk', requestId: 'r1', bytes: unitOf(1, 1),
    })
    expect(asTyped.kind).toBe('chunk')
    if (asTyped.kind !== 'chunk') throw new Error('unreachable')
    expect(asTyped.bytes).toBeInstanceOf(Uint8Array)
    expect(asTyped.bytes.length).toBe(417)

    // 某些 ipc 序列化会给回普通数组；归一化必须发生在 schema 这一处。
    const asArray = companionVoiceSpeakChunkEventV1Schema.parse({
      version: 1, kind: 'chunk', requestId: 'r1', bytes: Array.from(unitOf(1, 2)),
    })
    if (asArray.kind !== 'chunk') throw new Error('unreachable')
    expect(asArray.bytes).toBeInstanceOf(Uint8Array)
    expect(asArray.bytes.length).toBe(417)
  })

  it('end 事件带整段字节数，error 带失败分类', async () => {
    const { companionVoiceSpeakChunkEventV1Schema } = await import('@astella/shared/companion-voice-contracts')
    expect(companionVoiceSpeakChunkEventV1Schema.parse({
      version: 1, kind: 'end', requestId: 'r1', byteLength: 96639,
    })).toEqual({ version: 1, kind: 'end', requestId: 'r1', byteLength: 96639 })
    expect(companionVoiceSpeakChunkEventV1Schema.parse({
      version: 1, kind: 'error', requestId: 'r1',
      failure: { code: 'api_unavailable', retry: 'safe_retry' },
    }).kind).toBe('error')
  })

  it('按到达顺序喂给播放器：两个单元首尾相接，不是各自重开', async () => {
    const { IncrementalAudioPlayer } = await import('../companion-incremental-mp3.ts')
    const starts: number[] = []
    const context = {
      currentTime: 0,
      createBufferSource: () => ({
        buffer: null as unknown, onended: null as (() => void) | null,
        connect(node: unknown) { return node },
        start(at: number) { starts.push(at) },
        stop() {},
      }),
    }
    const player = new IncrementalAudioPlayer({
      context: context as unknown as AudioContext,
      destination: {} as AudioNode,
      decodeAllForTest: async () => ({
        duration: 0.2, length: 9600, sampleRate: 48000, copyToChannel() {},
      } as unknown as AudioBuffer),
    })
    player.push(unitOf(8, 1))
    player.push(unitOf(8, 2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(starts.length).toBe(2)
    // 第二个紧接第一个结束（0.02 + 0.2），不是"现在 + 延迟"。
    expect(starts[1]! - starts[0]!).toBeCloseTo(0.2, 3)
    player.stop()
  })

  it('流式一条路都没走通时，调用方可以退回整段（返回 false 且没出过声）', async () => {
    const { playSegmentFromStream } = await import('../companion-voice-stream-playback.ts')
    const starts: number[] = []
    const context = {
      currentTime: 0,
      decodeAudioData: vi.fn(async () => ({ duration: 0.2 })),
      createBuffer: (_c: number, length: number, sampleRate: number) => ({
        duration: length / sampleRate, length, sampleRate, copyToChannel() {},
      }),
      createBufferSource: () => ({
        buffer: null as unknown, onended: null as (() => void) | null,
        connect(node: unknown) { return node },
        start(at: number) { starts.push(at) },
        stop() {},
      }),
    }
    // 主进程不存在这条通道 → 必须立刻返回 false，不产生任何声音。
    const original = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      astella: { companion: { voice: {} } },
    }
    try {
      const played = await playSegmentFromStream({
        request: {
          version: 2, conversationId: '11111111-1111-4111-8111-111111111111',
          runId: '22222222-2222-4222-8222-222222222222', generation: 1, ordinal: 1,
          segmentId: 'a'.repeat(64),
        },
        workspaceEpoch: 1,
        context: context as unknown as AudioContext,
        destination: {} as AudioNode,
        audible: () => true,
        onProgress: () => undefined,
      })
      expect(played).toBe(false)
      expect(starts).toHaveLength(0)
    } finally {
      ;(globalThis as { window?: unknown }).window = original
    }
  })

  it('只认发起 invoke 时那份 meta.requestId：自己另生成一个就永远收不到块', async () => {
    const { playSegmentFromStream } = await import('../companion-voice-stream-playback.ts')
    const starts: number[] = []
    const context = {
      currentTime: 0,
      decodeAudioData: vi.fn(async () => ({ duration: 0.2 })),
      createBuffer: (_c: number, length: number, sampleRate: number) => ({
        duration: length / sampleRate, length, sampleRate, copyToChannel() {},
      }),
      createBufferSource: () => ({
        buffer: null as unknown, onended: null as (() => void) | null,
        connect(node: unknown) { return node },
        start(at: number) {
          starts.push(at)
          timeline.push('start')
          // 真的 AudioBufferSourceNode 播完会发 onended；替身不发就等于
          // 一个永远播不完的单元，整段排空永远不会发生。
          setTimeout(() => { timeline.push('ended'); this.onended?.() }, 0)
        },
        stop() {},
      }),
    }
    const original = (globalThis as { window?: unknown }).window
    let emit: ((event: unknown) => void) | null = null
    const pushedIds: string[] = []
    const timeline: string[] = []
    ;(globalThis as { window?: unknown }).window = {
      astella: {
        companion: {
          voice: {
            // 主进程回推的 requestId 永远是"发起时那份 meta"的 id。
            speakSegmentStream: async ({ meta }: { meta: { requestId: string } }) => {
              pushedIds.push(meta.requestId)
              queueMicrotask(() => emit?.({ version: 1, kind: 'chunk', requestId: meta.requestId, bytes: unitOf(8, 1) }))
              queueMicrotask(() => emit?.({ version: 1, kind: 'end', requestId: meta.requestId, byteLength: 417 * 8 }))
              return { version: 1, ok: true, data: { version: 1, accepted: true, requestId: meta.requestId } }
            },
            onSegmentChunk: (listener: (event: unknown) => void) => {
              emit = listener
              return () => { emit = null }
            },
          },
        },
      },
    }
    try {
      const played = await playSegmentFromStream({
        request: {
          version: 2, conversationId: '11111111-1111-4111-8111-111111111111',
          runId: '22222222-2222-4222-8222-222222222222', generation: 1, ordinal: 1,
          segmentId: 'a'.repeat(64),
        },
        workspaceEpoch: 1,
        context: context as unknown as AudioContext,
        destination: {} as AudioNode,
        audible: () => true,
        onProgress: () => undefined,
        // jsdom 里没有 AudioDecoder：注入整块解码，只为跑通接线。
        decodeAllForTest: async () => ({
          duration: 0.2, length: 9600, sampleRate: 48000, copyToChannel() {},
        } as unknown as AudioBuffer),
      })
      expect(played).toBe(true)
      expect(pushedIds).toHaveLength(1)
      expect(starts).toHaveLength(1)
      // 返回 true 的语义是"这一段已经念完"，调用方随即进下一段并停掉当前播放。
      // 早于 onended 返回，每一段都只会念第一个单元就被掐掉。
      expect(timeline).toEqual(['start', 'ended'])
    } finally {
      ;(globalThis as { window?: unknown }).window = original
    }
  })
})
