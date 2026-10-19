/**
 * 连续 PCM 重采样。保留跨块的滤波历史与小数相位，输出设备采样率的 PCM。
 *
 * AudioBufferSourceNode 对不同采样率的 buffer 使用逐点插值；每个新节点又从
 * 头开始。26ms 一块的 MP3 解码输出直接交给它，会在边界外推并引入高频镜像。
 * 这里采用 32 点 Blackman 窗 sinc，在源 Nyquist 附近留出抗混叠过渡带，
 * 与当前 Electron 整段 decodeAudioData 的重采样保持一致。只等待 16 个源样本
 * 的前瞻，22050Hz 时约 0.73ms；流末尾补零，不增加音频时长。
 */
const BASE_TAPS = 32;
const PHASES = 32;

export class StreamingPcmResampler {
  private readonly kernels: Float32Array;
  private readonly taps: number;
  private readonly half: number;
  private buffered: Float32Array = new Float32Array(0);
  private bufferStart = 0;
  private received = 0;
  private produced = 0;
  private ended = false;

  constructor(readonly sourceRate: number, readonly targetRate: number) {
    if (![sourceRate, targetRate].every(rate => Number.isFinite(rate) && rate > 0)) {
      throw new RangeError('PCM sample rates must be positive finite numbers');
    }
    // 降采样时过渡带也会收窄，按比例加长窗口，避免高频折回可闻频段。
    this.taps = BASE_TAPS * Math.max(1, Math.ceil(sourceRate / targetRate));
    this.half = this.taps / 2;
    this.kernels = new Float32Array((PHASES + 1) * this.taps);
    if (sourceRate === targetRate) return;
    const cutoff = 0.90 * Math.min(1, targetRate / sourceRate);
    for (let phase = 0; phase <= PHASES; phase += 1) {
      for (let tap = 0; tap < this.taps; tap += 1) {
        const distance = tap - this.half - phase / PHASES;
        const angle = Math.PI * distance;
        const window = 0.42 + 0.5 * Math.cos(2 * angle / this.taps)
          + 0.08 * Math.cos(4 * angle / this.taps);
        this.kernels[phase * this.taps + tap] = window
          * (angle === 0 ? cutoff : Math.sin(cutoff * angle) / angle);
      }
    }
  }

  push(pcm: Float32Array): Float32Array {
    if (this.ended || pcm.length === 0) return new Float32Array(0);
    if (this.sourceRate === this.targetRate) return pcm;
    const joined = new Float32Array(this.buffered.length + pcm.length);
    joined.set(this.buffered);
    joined.set(pcm, this.buffered.length);
    this.buffered = joined;
    this.received += pcm.length;
    return this.drain(false);
  }

  /** 只在解码器 flush 完成后调用，交出剩余前瞻；重复调用不重复尾音。 */
  flush(): Float32Array {
    if (this.ended) return new Float32Array(0);
    this.ended = true;
    const tail = this.sourceRate === this.targetRate ? new Float32Array(0) : this.drain(true);
    this.buffered = new Float32Array(0);
    return tail;
  }

  private drain(ending: boolean): Float32Array {
    const available = ending ? this.received : Math.max(0, this.received - this.half);
    const limit = Math.ceil(available * this.targetRate / this.sourceRate);
    const out = new Float32Array(Math.max(0, limit - this.produced));
    for (let index = 0; index < out.length; index += 1) {
      // 从总样本序号计算，不能按每块独立取整，也不能累计小数误差。
      const position = this.produced * this.sourceRate / this.targetRate;
      const center = Math.floor(position);
      const phase = (position - center) * PHASES;
      const lower = Math.floor(phase);
      const blend = phase - lower;
      const kernel = lower * this.taps;
      const first = center - this.half - this.bufferStart;
      let left = 0;
      let right = 0;
      for (let tap = 0; tap < this.taps; tap += 1) {
        const sample = this.buffered[first + tap] ?? 0;
        left += sample * this.kernels[kernel + tap]!;
        right += sample * this.kernels[kernel + this.taps + tap]!;
      }
      out[index] = left + (right - left) * blend;
      this.produced += 1;
    }
    const nextCenter = Math.floor(this.produced * this.sourceRate / this.targetRate);
    const discard = Math.min(this.buffered.length, Math.max(0, nextCenter - this.half - this.bufferStart));
    this.buffered = this.buffered.slice(discard);
    this.bufferStart += discard;
    return out;
  }
}
