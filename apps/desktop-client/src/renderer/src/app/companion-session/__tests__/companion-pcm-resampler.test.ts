import { describe, expect, it } from 'vitest';
import { StreamingPcmResampler } from '../companion-pcm-resampler.ts';

function join(chunks: Float32Array[]): Float32Array {
  const result = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
  return result;
}

function convert(input: Float32Array, sourceRate: number, targetRate: number, chunkSize: number) {
  const resampler = new StreamingPcmResampler(sourceRate, targetRate);
  const chunks: Float32Array[] = [];
  for (let at = 0; at < input.length; at += chunkSize) chunks.push(resampler.push(input.subarray(at, at + chunkSize)));
  chunks.push(resampler.flush());
  return join(chunks);
}

function tone(hz: number, rate: number, seconds = 0.2): Float32Array {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, index) => 0.5 * Math.sin(2 * Math.PI * hz * index / rate));
}

function amplitude(pcm: Float32Array, rate: number, hz: number): number {
  let sin = 0;
  let cos = 0;
  // 去掉音频首尾，只测稳定段的频谱，不把补零边界当作混叠。
  const skip = Math.round(rate * 0.02);
  for (let index = skip; index < pcm.length - skip; index += 1) {
    const phase = 2 * Math.PI * hz * index / rate;
    sin += pcm[index]! * Math.sin(phase);
    cos += pcm[index]! * Math.cos(phase);
  }
  return 2 * Math.hypot(sin, cos) / (pcm.length - 2 * skip);
}

describe('连续 PCM 重采样', () => {
  it.each([[22050, 48000], [22050, 44100], [24000, 48000], [44100, 16000], [48000, 44100]])(
    '%i → %i：网络/解码帧怎么分块都与整段转换逐样本一致', (sourceRate, targetRate) => {
      const input = Float32Array.from({ length: 6173 }, (_, index) => Math.sin(index * 1.79) * Math.cos(index * 0.013));
      const expected = convert(input, sourceRate, targetRate, input.length);
      expect(convert(input, sourceRate, targetRate, 576)).toEqual(expected);
      expect(convert(input, sourceRate, targetRate, 17)).toEqual(expected);
      expect(expected.length).toBe(Math.ceil(input.length * targetRate / sourceRate));
    },
  );

  it('同采样率原样保留 PCM，包括齿音与气音中的高频成分', () => {
    const input = tone(9000, 22050);
    expect(convert(input, 22050, 22050, 576)).toEqual(input);
  });

  it('保留 6kHz 齿音，抑制升采样后出现在 16.05kHz 的高频镜像', () => {
    const output = convert(tone(6000, 22050), 22050, 48000, 576);
    expect(amplitude(output, 48000, 6000)).toBeCloseTo(0.5, 2);
    expect(amplitude(output, 48000, 16050)).toBeLessThan(0.0005);
  });

  it('降采样前滤掉超过新 Nyquist 的成分，不能折回成可闻噪声', () => {
    const output = convert(tone(10000, 48000), 48000, 16000, 576);
    expect(amplitude(output, 16000, 6000)).toBeLessThan(0.0005);
  });

  it('10 秒音频不随每帧取整而变快或丢样本', () => {
    const input = new Float32Array(22050 * 10 + 7);
    const output = convert(input, 22050, 48000, 576);
    expect(output.length).toBe(Math.ceil(input.length * 48000 / 22050));
    expect(Math.abs(output.length / 48000 - input.length / 22050)).toBeLessThan(1 / 48000);
  });

  it('等待前瞻，flush 时释放短句尾音；重复 flush 不会重复播放', () => {
    const resampler = new StreamingPcmResampler(22050, 48000);
    const input = new Float32Array([0.3, -0.2, 0.1]);
    expect(resampler.push(input)).toHaveLength(0);
    const tail = resampler.flush();
    expect(tail.length).toBe(Math.ceil(3 * 48000 / 22050));
    expect(tail.some(sample => Math.abs(sample) > 0.01)).toBe(true);
    expect(resampler.flush()).toHaveLength(0);
    expect(resampler.push(input)).toHaveLength(0);
  });
});
