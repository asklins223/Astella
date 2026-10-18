import { describe, expect, it } from 'vitest'
import {
  IncrementalAudioPlayer,
  Mp3FrameAssembler,
  mp3FrameLength,
  mp3SourceSampleRate,
  skipId3v2,
} from '../companion-incremental-mp3.ts'

/**
 * 增量音频的两块纯逻辑（2026-10-17，2026-10-18 改为 WebCodecs 流式解码）：
 *   1. 按 MP3 帧边界切——切错会把音频变成噪声，喂给解码器时还会错帧；
 *   2. 在同一个 AudioContext 时钟上首尾相接——每段各自"现在 + 延迟"会顿。
 *
 * 2026-10-18 之前这里是"每块独立 `decodeAudioData` + 前文裁切"。那套做法在
 * qwen 的 22050Hz 上会逐块重采样、边缘被截断，听感是持续的电流滋滋声；
 * WebCodecs 的 `AudioDecoder` 是有状态的，逐帧喂进去与整段解码逐样本一致。
 */

/** 造一个合法的 MPEG1 Layer III 帧头（128kbps / 44.1kHz / 无 padding）。 */
function frame(byte: number, size = 417): Uint8Array {
  const out = new Uint8Array(size)
  out[0] = 0xff
  out[1] = 0xfb               // MPEG1, Layer III
  out[2] = 0x90               // 128kbps, 44.1kHz
  out[3] = 0x00
  out.fill(byte, 4)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

/** 测试替身：一块 PCM 的 AudioBuffer。 */
function fakeBuffer(duration: number) {
  return {
    duration,
    length: Math.round(duration * 48000),
    sampleRate: 48000,
    copyToChannel() {},
  } as unknown as AudioBuffer
}

describe('MP3 帧解析', () => {
  it('认得 128kbps/44.1kHz 的帧长', () => {
    expect(mp3FrameLength(frame(0), 0)).toBe(417)
  })

  it('字节不够时返回 0（等更多数据），不是当成坏帧', () => {
    expect(mp3FrameLength(new Uint8Array([0xff, 0xfb]), 0)).toBe(0)
  })

  it('非帧头返回 -1', () => {
    expect(mp3FrameLength(new Uint8Array([0, 1, 2, 3]), 0)).toBe(-1)
  })

  it('跳过带 footer 的 ID3v2 头', () => {
    const header = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10])
    const bytes = concat([header, new Uint8Array(16), frame(1)])
    // 0x10 的 size 是 16 字节正文 + 10 字节头 + 10 字节 footer。
    expect(skipId3v2(bytes)).toBe(36)
  })

  it('读出源采样率——解码器要按它配置', () => {
    expect(mp3SourceSampleRate(frame(1))).toBe(44100)
  })
})

describe('按帧切块', () => {
  it('每 8 帧一块，末尾不足的单独交出', () => {
    const assembler = new Mp3FrameAssembler(8)
    const bytes = concat([frame(1), frame(2), frame(3), frame(4), frame(5),
      frame(6), frame(7), frame(8), frame(9), frame(10)])
    const units = [...assembler.push(bytes), ...assembler.flush()]
    expect(units.map(unit => unit.bytes.length)).toEqual([417 * 8, 417 * 2])
  })

  it('跨块到达时不重复也不丢帧', () => {
    const frames = Array.from({ length: 10 }, (_, index) => frame(index + 1))
    const all = concat(frames)
    const assembler = new Mp3FrameAssembler(4)
    const units = []
    // 故意在帧中间切开，模拟网络分块。
    for (let at = 0; at < all.length; at += 200) {
      units.push(...assembler.push(all.subarray(at, Math.min(all.length, at + 200))))
    }
    units.push(...assembler.flush())
    const rebuilt = concat(units.map(unit => unit.bytes))
    expect(rebuilt.length).toBe(all.length)
    expect(rebuilt).toEqual(all)
  })

  it('带 ID3 头的流也能对齐到第一帧', () => {
    const header = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20])
    const all = concat([header, new Uint8Array(32), frame(1), frame(2)])
    const assembler = new Mp3FrameAssembler(1)
    const units = [...assembler.push(all), ...assembler.flush()]
    expect(units.length).toBe(2)
    expect(units[0]!.bytes).toEqual(frame(1))
  })

  /**
   * 2026-10-18：不再有"前文重叠"。解码器是有状态的，帧按流顺序原样喂即可；
   * 任何重叠都会让解码器把同一帧解两遍，等于重复音频。
   */
  it('块与块之间不重叠、不重复任何一帧', () => {
    const assembler = new Mp3FrameAssembler(8)
    const frames = Array.from({ length: 16 }, (_, index) => frame(index + 1))
    const units = assembler.push(concat(frames))
    expect(units).toHaveLength(2)
    expect(units[0]!.bytes).toEqual(concat(frames.slice(0, 8)))
    expect(units[1]!.bytes).toEqual(concat(frames.slice(8, 16)))
  })
})

describe('增量排播', () => {
  /** 最小 AudioContext 替身：记录排了哪些开始时刻。 */
  function fakeContext() {
    const starts: number[] = []
    const context = {
      currentTime: 0,
      createBufferSource: () => {
        const source = {
          buffer: null as unknown,
          connected: false,
          onended: null as (() => void) | null,
          connect(node: unknown) { source.connected = true; return node },
          start(at: number) { starts.push(at) },
          stop() { source.onended?.() },
        }
        return source
      },
      createBuffer: (_channels: number, length: number, sampleRate: number) => ({
        duration: length / sampleRate,
        length,
        sampleRate,
        copyToChannel() {},
      }),
    }
    return { context, starts }
  }

  it('第二块紧接第一块的结束时刻，不各自"现在 + 延迟"', async () => {
    const { context, starts } = fakeContext()
    const player = new IncrementalAudioPlayer({
      context: context as unknown as AudioContext,
      destination: {} as AudioNode,
      decodeAllForTest: async () => fakeBuffer(0.2),
    })
    player.push(concat(Array.from({ length: 8 }, (_, i) => frame(i))))
    player.push(concat(Array.from({ length: 8 }, (_, i) => frame(i + 8))))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(starts).toHaveLength(2)
    // 第一块在 currentTime + 0.02，第二块正好接在它之后 0.2 秒。
    expect(starts[0]).toBeCloseTo(0.02, 3)
    expect(starts[1]).toBeCloseTo(0.22, 3)
    player.stop()
  })

  it('坏块被跳过，不影响后面的块', async () => {
    const { context, starts } = fakeContext()
    let call = 0
    const player = new IncrementalAudioPlayer({
      context: context as unknown as AudioContext,
      destination: {} as AudioNode,
      decodeAllForTest: async () => (call++ === 0 ? null : fakeBuffer(0.1)),
    })
    player.push(concat(Array.from({ length: 8 }, (_, i) => frame(i))))
    player.push(concat(Array.from({ length: 8 }, (_, i) => frame(i + 8))))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(starts).toHaveLength(1)
    player.stop()
  })

  it('stop() 之后不再排新块', async () => {
    const { context, starts } = fakeContext()
    const player = new IncrementalAudioPlayer({
      context: context as unknown as AudioContext,
      destination: {} as AudioNode,
      decodeAllForTest: async () => fakeBuffer(0.1),
    })
    player.push(concat(Array.from({ length: 8 }, (_, i) => frame(i))))
    await new Promise(resolve => setTimeout(resolve, 5))
    const before = starts.length
    player.stop()
    player.push(concat(Array.from({ length: 8 }, (_, i) => frame(i + 8))))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(starts.length).toBe(before)
    expect(player.isLive).toBe(false)
  })

  /**
   * 字幕位置：气泡只读音频时钟现算的位置。这条钉住"会前进、不超过 1、不回退"。
   */
  it('位置读数跟着音频时钟前进，且不回退', async () => {
    let now = 0
    const context = {
      get currentTime() { return now },
      createBufferSource: () => ({
        buffer: null as unknown, onended: null as (() => void) | null,
        connect(node: unknown) { return node },
        start() {}, stop() {},
      }),
      createBuffer: (_c: number, length: number, sampleRate: number) => ({
        duration: length / sampleRate, length, sampleRate, copyToChannel() {},
      }),
    }
    const player = new IncrementalAudioPlayer({
      context: context as unknown as AudioContext,
      destination: {} as AudioNode,
      decodeAllForTest: async () => fakeBuffer(0.5),
    })
    // 播放前：没有位置。
    expect(player.playedFraction()).toBeNull()

    player.push(concat(Array.from({ length: 8 }, (_, i) => frame(i))))
    await new Promise(resolve => setTimeout(resolve, 10))
    // 第一块 0.5 秒、0.02 秒调度余量；到 0.27 秒时约播了一半。
    now = 0.27
    const first = player.playedFraction()
    expect(first).not.toBeNull()
    expect(first!).toBeGreaterThan(0.4)
    expect(first!).toBeLessThan(0.6)

    now = 0.4
    expect(player.playedFraction()!).toBeGreaterThan(first!)

    now = 100
    expect(player.playedFraction()!).toBe(1)
    player.stop()
  })
})
