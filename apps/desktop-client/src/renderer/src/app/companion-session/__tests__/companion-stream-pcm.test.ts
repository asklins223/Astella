import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncrementalAudioPlayer } from '../companion-incremental-mp3.ts';
import { StreamingPcmResampler } from '../companion-pcm-resampler.ts';

afterEach(() => vi.unstubAllGlobals());

function harness(targetRate = 48000) {
  const sourceRate = 22050;
  const input = Float32Array.from({ length: 8 * 576 }, (_, i) => 0.4 * Math.sin(2 * Math.PI * 6000 * i / sourceRate));
  let output!: (data: AudioData) => void;
  let decoded = 0;
  let releaseFlush!: () => void;
  const flushGate = new Promise<void>(resolve => { releaseFlush = resolve; });
  const pending: Promise<void>[] = [];
  const close = vi.fn();
  const decoder = {
    configure: vi.fn(), close,
    decode() {
      const frame = input.slice(decoded++ * 576, decoded * 576);
      pending.push(Promise.resolve().then(() => output({
        numberOfFrames: frame.length, sampleRate: sourceRate,
        copyTo: (target: Float32Array) => target.set(frame), close() {},
      } as unknown as AudioData)));
    },
    flush: () => Promise.all(pending).then(() => flushGate),
  };
  vi.stubGlobal('AudioDecoder', class {
    constructor(options: AudioDecoderInit) { output = options.output; return decoder; }
  });
  vi.stubGlobal('EncodedAudioChunk', class { constructor(_options: unknown) {} });

  const sources: Array<{ buffer: AudioBuffer | null; at: number; onended: (() => void) | null; stop: () => void }> = [];
  const context = {
    currentTime: 0, sampleRate: targetRate,
    createBuffer(_channels: number, length: number, sampleRate: number) {
      const data = new Float32Array(length);
      return { length, sampleRate, duration: length / sampleRate,
        copyToChannel: (pcm: Float32Array) => data.set(pcm), getChannelData: () => data,
      } as unknown as AudioBuffer;
    },
    createBufferSource() {
      const source = { buffer: null as AudioBuffer | null, at: 0, onended: null as (() => void) | null,
        connect() {}, start(at: number) { source.at = at; sources.push(source); }, stop: vi.fn(),
      };
      return source;
    },
  };
  // MPEG2 / 128kbps / 22050Hz。解码器替身只负责按帧吐出可比较的 PCM。
  const mp3 = new Uint8Array(417 * 8);
  for (let at = 0; at < mp3.length; at += 417) mp3.set([0xff, 0xf3, 0xc0, 0], at);
  const done = vi.fn();
  const player = new IncrementalAudioPlayer({ context: context as unknown as AudioContext, destination: {} as AudioNode, onDone: done });
  return { input, sourceRate, targetRate, player, mp3, sources, releaseFlush, done, close };
}

describe('WebCodecs PCM → 设备输出', () => {
  it.each([44100, 48000])('输出 %iHz，拼接与整段连续转换相同，句尾播放后才完成', async targetRate => {
    const h = harness(targetRate);
    h.player.push(h.mp3);
    h.player.finish();
    await vi.waitFor(() => expect(h.sources.length).toBeGreaterThan(0));
    expect(h.done).not.toHaveBeenCalled();
    h.releaseFlush();
    await vi.waitFor(() => expect(h.sources).toHaveLength(9));

    const resampler = new StreamingPcmResampler(h.sourceRate, targetRate);
    const head = resampler.push(h.input), tail = resampler.flush();
    const expected = new Float32Array(head.length + tail.length);
    expected.set(head); expected.set(tail, head.length);
    const actual = new Float32Array(h.sources.reduce((sum, source) => sum + source.buffer!.length, 0));
    let cursor = 0;
    for (const [index, source] of h.sources.entries()) {
      expect(source.buffer!.sampleRate).toBe(targetRate);
      expect(source.at * targetRate).toBeCloseTo(Math.round(source.at * targetRate), 7);
      if (index) expect(source.at).toBeCloseTo(h.sources[index - 1]!.at + h.sources[index - 1]!.buffer!.duration, 12);
      actual.set(source.buffer!.getChannelData(0), cursor); cursor += source.buffer!.length;
    }
    expect(actual).toEqual(expected);
    expect(actual.length).toBe(Math.ceil(h.input.length * targetRate / h.sourceRate));
    for (const source of h.sources.slice(0, -1)) source.onended?.();
    expect(h.done).not.toHaveBeenCalled();
    h.sources.at(-1)!.onended?.();
    expect(h.done).toHaveBeenCalledOnce();
    expect(h.player.isLive).toBe(false);
  });

  it('停止时若解码器仍在 flush，之后也不能把残留尾音排出来', async () => {
    const h = harness();
    h.player.push(h.mp3);
    h.player.finish();
    await vi.waitFor(() => expect(h.sources).toHaveLength(8));
    h.player.stop();
    h.releaseFlush();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.sources).toHaveLength(8);
    expect(h.sources.every(source => vi.mocked(source.stop).mock.calls.length === 1)).toBe(true);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.done).not.toHaveBeenCalled();
  });
});
