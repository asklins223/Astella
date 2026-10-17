import { describe, expect, it } from 'vitest'
import { IncrementalAudioPlayer, Mp3FrameAssembler, mp3FrameLength, skipId3v2 } from '../companion-incremental-mp3.ts'

/**
 * 增量解码的两块纯逻辑（2026-10-17）：
 *   1. 按 MP3 帧边界切单元——切错会把音频变成噪声或丢掉整帧；
 *   2. 在同一个 AudioContext 时钟上首尾相接——每段各自"现在 + 延迟"会顿。
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
})

describe('按帧切解码单元', () => {
  it('每 8 帧一个单元，末尾不足的单独交出', () => {
    const assembler = new Mp3FrameAssembler(8)
    const bytes = concat([frame(1), frame(2), frame(3), frame(4), frame(5),
      frame(6), frame(7), frame(8), frame(9), frame(10)])
    const units = [...assembler.push(bytes), ...assembler.flush()]
    expect(units.map(unit => unit.bytes.length)).toEqual([417 * 8, 417 * 2])
  })

  it('跨块到达时不会重复也不会丢帧', () => {
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
    expect(units[0]!.bytes.length).toBe(417)
    expect(units[0]!.bytes[0]).toBe(0xff)
  })
})

describe('增量排播', () => {
  /** 最小 AudioContext 替身：只记录排了哪些开始时刻。 */
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
    }
    return { context, starts }
  }

  it('第二个单元紧接第一个的结束时刻，不各自"现在 + 延迟"', async () => {
    const { context, starts } = fakeContext()
    const player = new IncrementalAudioPlayer({
      context: context as unknown as AudioContext,
      destination: {} as AudioNode,
      decode: async () => ({ duration: 1 } as AudioBuffer),
    })
    // 每个单元要 8 帧；推两批，才会排出两个单元。
    player.push(concat(Array.from({ length: 8 }, (_, i) => frame(i))))
    player.push(concat(Array.from({ length: 8 }, (_, i) => frame(i + 8))))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(starts).toHaveLength(2)
    // 第一个在 currentTime + 0.02，第二个正好接在它之后 1 秒。
    expect(starts[0]).toBeCloseTo(0.02, 3)
    expect(starts[1]).toBeCloseTo(1.02, 3)
    player.stop()
  })

  it('坏单元被跳过，不影响后面的单元', async () => {
    const { context, starts } = fakeContext()
    let call = 0
    const player = new IncrementalAudioPlayer({
      context: context as unknown as AudioContext,
      destination: {} as AudioNode,
      decode: async () => (call++ === 0 ? null : ({ duration: 0.5 } as AudioBuffer)),
    })
    player.push(concat(Array.from({ length: 8 }, (_, i) => frame(i))))
    player.push(concat(Array.from({ length: 8 }, (_, i) => frame(i + 8))))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(starts).toHaveLength(1)
    player.stop()
  })

  it('stop() 之后不再排新单元', async () => {
    const { context, starts } = fakeContext()
    const player = new IncrementalAudioPlayer({
      context: context as unknown as AudioContext,
      destination: {} as AudioNode,
      decode: async () => ({ duration: 1 } as AudioBuffer),
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
})
