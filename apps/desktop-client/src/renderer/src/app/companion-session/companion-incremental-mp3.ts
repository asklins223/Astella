/**
 * 增量音频排播（2026-10-17；2026-10-18 改用 WebCodecs 流式解码）。
 *
 * 原来一段语音必须**整段到齐**才能 `decodeAudioData` 再播：HTTP 那条路把 MP3 收完
 * 才返回，客户端拿到的是一个完整 buffer。服务端其实早就在流式合成（千问 WS 逐块
 * 吐字节），被客户端这一侧"收齐再解"抹平了——本地实测首段可播相差 0.6–1.2 秒。
 *
 * ── 为什么最终不用 `decodeAudioData` 分包 ──────────────────────────────────
 *
 * 它把每次调用当成**一个完整的音频文件**：新开解码器、自带预滚、自己定重采样。
 * 拿它去解一段从流中间切出来的字节，三处都会出问题：
 *
 * 1. 单元开头是一段 30–35ms 静音（解码器预滚），内容整体后移；
 * 2. 补前文再裁掉能修 ①，但 qwen 出 22050Hz、播放上下文是 48000Hz，
 *    2.176:1 不是整数倍，重采样滤波器逐块截断，每 0.2 秒吃一次失真——
 *    听感是持续的电流"滋滋"声（实测分段拼接误差 0.0529，整段 0.000011）；
 * 3. 每次调用都是一次独立解码，完成顺序不可信，按完成顺序排播会把音频拼乱。
 *
 * `AudioDecoder`（WebCodecs）是**有状态**的流式解码器：同一个实例逐帧喂进去，
 * 它跨帧保持解码器内部状态（bit reservoir、预滚），输出的源采样率 PCM 与
 * "把整段文件一次解码"逐样本完全一致（实测 173 帧喂入，差值恰为 0）。
 * 解码之后还要连续重采样到设备采样率：逐帧新建 AudioBufferSourceNode 会重置
 * 播放插值状态，且不做抗镜像滤波，气音/齿音仍会变成刺耳的呲滋声。
 *
 * 帧解析仍然只做一件事：**切出完整帧的边界**，保证喂给解码器的是整帧。
 */

import { StreamingPcmResampler } from './companion-pcm-resampler.ts';

/** 一段可独立喂给 `AudioDecoder` 的连续完整 MP3 帧。 */
export interface Mp3FrameUnit {
  readonly bytes: Uint8Array;
  /** 该单元在整条流里的起始字节位置（诊断用）。 */
  readonly offset: number;
}

interface Mp3FrameInfo {
  /** -1 = 不是可信帧头；0 = 字节不够，等更多数据。 */
  readonly length: number;
  readonly samplesPerFrame: number;
  readonly sampleRate: number;
}

/** MPEG Layer III 帧头解析。 */
function mp3FrameInfo(bytes: Uint8Array, offset: number): Mp3FrameInfo {
  const none = { length: 0, samplesPerFrame: 0, sampleRate: 0 } as const;
  if (offset + 4 > bytes.length) return none;
  if (bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xe0) !== 0xe0) return { ...none, length: -1 };
  const versionBits = (bytes[offset + 1]! >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (bytes[offset + 1]! >> 1) & 0x03; // 1 = Layer III
  if (layerBits !== 1) return { ...none, length: -1 };
  const bitrateIndex = (bytes[offset + 2]! >> 4) & 0x0f;
  const rateIndex = (bytes[offset + 2]! >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return { ...none, length: -1 };
  const padding = (bytes[offset + 2]! >> 1) & 0x01;
  const sampleRate = versionBits === 3
    ? [44100, 48000, 32000][rateIndex]
    : versionBits === 2
      ? [22050, 24000, 16000][rateIndex]
      : [11025, 12000, 8000][rateIndex];
  const bitrate = (versionBits === 3
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0][bitrateIndex]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0][bitrateIndex])! * 1000;
  if (!sampleRate || !bitrate) return { ...none, length: -1 };
  const length = versionBits === 3
    ? Math.floor((144 * bitrate) / sampleRate) + padding
    : Math.floor((72 * bitrate) / sampleRate) + padding;
  if (length <= 4) return { ...none, length: -1 };
  return { length, samplesPerFrame: versionBits === 3 ? 1152 : 576, sampleRate };
}

/**
 * MPEG Layer III 帧长。
 * 返回 -1 表示这里不是可信的帧头；返回 0 表示"字节还不够判断，等更多数据"。
 */
export function mp3FrameLength(bytes: Uint8Array, offset: number): number {
  return mp3FrameInfo(bytes, offset).length;
}

/** 一帧的样本数（MPEG1 = 1152，MPEG2/2.5 = 576）。 */
function frameSamplesAt(bytes: Uint8Array, offset = 0): number {
  return mp3FrameInfo(bytes, offset).samplesPerFrame;
}

/**
 * 这片 MP3 字节的源采样率（第一个可信帧头），认不出返回 null。
 * `AudioDecoder` 需要它来配置解码器。
 */
export function mp3SourceSampleRate(bytes: Uint8Array): number | null {
  let cursor = skipId3v2(bytes);
  const end = Math.min(bytes.length, cursor + 4096);
  while (cursor < end) {
    const info = mp3FrameInfo(bytes, cursor);
    if (info.length === 0) return null;
    if (info.length > 0 && info.sampleRate > 0) return info.sampleRate;
    cursor += 1;
  }
  return null;
}

/** 跳过 ID3v2 标签，返回第一个可能的帧起点。 */
export function skipId3v2(bytes: Uint8Array): number {
  if (bytes.length < 10) return 0;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14)
    | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  const footer = (bytes[5]! & 0x10) !== 0 ? 10 : 0;
  return Math.min(bytes.length, 10 + size + footer);
}

/**
 * 把不断到达的字节切成**连续完整帧**。
 *
 * 解码器有状态，所以这里不再关心"多少帧一批"——攒到有整帧就交出去，批次大小只
 * 影响"多早能开始出声"。默认 8 帧（约 0.2 秒）是首响与开销的折中。
 */
export class Mp3FrameAssembler {
  private readonly chunks: Uint8Array[] = [];
  private buffered = 0;
  private consumed = 0;
  private frameStart = -1;
  private id3Skipped = false;
  private framesInUnit = 0;
  private unitStart = 0;
  private unitBytes: Uint8Array[] = [];

  constructor(private readonly targetFrames = 8) {}

  /** 压入新到的字节，返回本次凑满的整帧批次。 */
  push(chunk: Uint8Array): Mp3FrameUnit[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    return this.drain(false);
  }

  /** 流结束：把剩下的完整帧一起交出去。 */
  flush(): Mp3FrameUnit[] {
    return this.drain(true);
  }

  private view(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0]!;
    const merged = new Uint8Array(this.buffered);
    let at = 0;
    for (const chunk of this.chunks) { merged.set(chunk, at); at += chunk.length; }
    this.chunks.length = 0;
    this.chunks.push(merged);
    return merged;
  }

  private drain(ending: boolean): Mp3FrameUnit[] {
    const bytes = this.view();
    if (!this.id3Skipped) {
      // 标签可能还没收全：收全之前先不动。
      if (!ending && bytes.length < 10) return [];
      this.consumed = skipId3v2(bytes);
      this.id3Skipped = true;
      this.frameStart = this.consumed;
    }
    const out: Mp3FrameUnit[] = [];
    let cursor = Math.max(this.frameStart, this.consumed);
    while (cursor < bytes.length) {
      const info = mp3FrameInfo(bytes, cursor);
      if (info.length === 0) break;                       // 头还没收全，等下一块
      if (info.length < 0) {
        // 不是帧头：可能中间夹了标签或有损坏，往后挪一个字节重新对齐。
        cursor += 1;
        continue;
      }
      if (cursor + info.length > bytes.length) break;     // 这一帧还没收全
      if (this.framesInUnit === 0) this.unitStart = cursor;
      // 复制一份：下面的缓冲马上会被丢掉，视图会失效。
      this.unitBytes.push(bytes.slice(cursor, cursor + info.length));
      this.framesInUnit += 1;
      cursor += info.length;
      if (this.framesInUnit >= this.targetFrames) out.push(this.takeUnit());
    }
    this.frameStart = cursor;
    // 丢掉已经交出去的字节，避免越攒越大。
    if (cursor > 0 && cursor >= bytes.length) {
      this.chunks.length = 0;
      this.buffered = 0;
      this.frameStart = 0;
      this.consumed = 0;
    }
    if (ending) {
      if (this.framesInUnit > 0) out.push(this.takeUnit());
      this.chunks.length = 0;
      this.buffered = 0;
      this.frameStart = 0;
    }
    return out;
  }

  private takeUnit(): Mp3FrameUnit {
    const size = this.unitBytes.reduce((sum, frame) => sum + frame.length, 0);
    const merged = new Uint8Array(size);
    let at = 0;
    for (const frame of this.unitBytes) { merged.set(frame, at); at += frame.length; }
    const unit: Mp3FrameUnit = { bytes: merged, offset: this.unitStart };
    this.unitBytes = [];
    this.framesInUnit = 0;
    return unit;
  }
}

export interface IncrementalPlaybackOptions {
  readonly context: AudioContext;
  readonly destination: AudioNode;
  /** 已播秒数变化（用于进度与口型）。 */
  readonly onProgress?: (seconds: number) => void;
  /** 整条流结束且全部播完。 */
  readonly onDone?: () => void;
  /** 是否还能出声（静音/窗口不可见时直接停）。 */
  readonly audible?: () => boolean;
  /**
   * 测试接缝：注入"整块解码"代替 WebCodecs（纯 node / jsdom 单测里没有 `AudioDecoder`）。
   * 生产**不传**——那条路一律走下面的 `AudioDecoder`。
   */
  readonly decodeAllForTest?: (bytes: Uint8Array) => Promise<AudioBuffer | null>;
  /**
   * 首播前预缓冲的秒数（默认 0.35）。测试可显式给 0 或别的值；
   * 注入解码器的旧用例不传就等于 0，保持原断言形状。
   */
  readonly prebufferSeconds?: number;
}

/**
 * 用 WebCodecs 的 `AudioDecoder` 把陆续到达的 MP3 帧解成 PCM，
 * 再按 PCM 的**实际时长**在 AudioContext 时钟上首尾相接。
 *
 * 与上一版的区别是根本性的：上一版每次都调 `decodeAudioData`（把一块当完整文件），
 * 全程共用一个解码器和一个重采样器；两层都保留跨帧状态。
 * 交给 AudioContext 的 buffer 已是设备采样率，播放器无需再逐块插值。
 */
export class IncrementalAudioPlayer {
  private readonly context: AudioContext;
  private readonly assembler = new Mp3FrameAssembler();
  private readonly sources: AudioBufferSourceNode[] = [];
  private decoder: AudioDecoder | null = null;
  private resampler: StreamingPcmResampler | null = null;
  private decoderError: string | null = null;
  /** 已交给解码器、还没收到输出的帧数（用于收尾判定）。 */
  private queuedFrames = 0;
  /** 兜底路径在途的整块解码数（只有测试接缝会用到）。 */
  private pendingFallbacks = 0;
  private fedFrames = 0;
  private sourceSampleRate = 0;
  private samplesPerFrame = 0;
  /** 设备样本时钟上的下一个起点；整样本排播避免逐块小数取整的缝隙。 */
  private nextStartFrame: number | null = null;
  /** 已排播音频结束于设备时钟的哪一秒（欠载判定用；不依赖 context.sampleRate）。 */
  private scheduledEndAt: number | null = null;
  /**
   * 抖动缓冲（2026-10-19）。流式音频到达不匀速：过去每块到了直接排
   * `currentTime + 5ms`，晚到多久就插多长的静音缝；突发到达又截掉上一块尾巴。
   * 现在先攒一小段再开口，欠载时暂停排播、重新攒够再续，不留缝。
   * 注意：**缓冲状态不参与"说完"判定**——`finished` 之后一律排空并收尾，
   * 否则流会卡在第一段（2026-10-19 实机回归）。
   */
  private static readonly REBUFFER_SECONDS = 0.5;
  private pendingBuffers: AudioBuffer[] = [];
  private pendingSeconds = 0;
  private buffering = true;
  /** 缓冲重排之前已经播掉的秒数：续播后进度继续往上走，字幕不回跳。 */
  private playedOffset = 0;
  private decodedSeconds = 0;
  private startedAt: number | null = null;
  private reportedFraction = 0;
  private live = true;
  private finished = false;
  private flushing = false;
  private frame = 0;

  constructor(private readonly options: IncrementalPlaybackOptions) {
    this.context = options.context;
  }

  push(chunk: Uint8Array): void {
    if (!this.live) return;
    for (const unit of this.assembler.push(chunk)) this.feed(unit);
  }

  finish(): void {
    if (!this.live) return;
    for (const unit of this.assembler.flush()) this.feed(unit);
    this.finished = true;
    // 结束态立即排空一次：这是"流在半缓冲处结束"也能收尾的关键（实机卡壳回归）。
    this.pump();
    const decoder = this.decoder;
    if (decoder) {
      // 让解码器把内部残留吐出来；吐完才算整段结束。
      this.flushing = true;
      void decoder.flush()
        .catch(() => undefined)
        .then(() => {
          if (this.live && this.resampler) this.schedulePcm(this.resampler.flush());
          this.flushing = false;
          this.pump();
          this.maybeComplete();
        });
    }
    this.maybeComplete();
  }

  stop(): void {
    if (!this.live) return;
    this.live = false;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    for (const source of this.sources) {
      try { source.stop(); } catch { /* 已经自然结束 */ }
    }
    this.sources.length = 0;
    this.pendingBuffers.length = 0;
    this.pendingSeconds = 0;
    try { this.decoder?.close(); } catch { /* 已经关了 */ }
    this.decoder = null;
    this.resampler = null;
  }

  get isLive(): boolean {
    return this.live;
  }

  /**
   * 解码器是否已经彻底不可用（建不起来 / 报了错）。
   *
   * 调用方据此**尽早**放弃这一段并退回整段合成，而不是干等到排空截止：
   * 没有这段读数时，"解码器一声不响地坏了"与"音频正在播"在外部长得一模一样。
   */
  get failed(): boolean {
    return this.decoderError !== null;
  }

  /**
   * 这一条流**此刻播到几成**（0..1），没有在播返回 null。
   *
   * 单调：分母是"已排播的总时长"，边合成边播时它会随新块变大；逐块重算会让
   * 比例忽大忽小，字幕就会往回跳。
   */
  playedFraction(): number | null {
    if (!this.live || this.startedAt === null || this.decodedSeconds <= 0) return null;
    // 缓冲期间不把等待算成播放进度，字幕停在已播位置。
    const elapsed = this.buffering ? this.playedOffset : this.context.currentTime - this.startedAt;
    if (!Number.isFinite(elapsed)) return null;
    const next = Math.min(1, Math.max(0, elapsed / this.decodedSeconds));
    this.reportedFraction = Math.max(this.reportedFraction, next);
    return this.reportedFraction;
  }

  /** 建解码器（按第一帧的真实采样率配置），只建一次。 */
  private ensureDecoder(bytes: Uint8Array): boolean {
    if (this.decoder) return true;
    if (this.decoderError) return false;
    const rate = mp3SourceSampleRate(bytes);
    if (rate === null) {
      this.decoderError = "unknown-sample-rate";
      return false;
    }
    const first = mp3FrameInfo(bytes, skipId3v2(bytes));
    this.sourceSampleRate = rate;
    this.samplesPerFrame = first.samplesPerFrame > 0 ? first.samplesPerFrame : 576;
    if (typeof AudioDecoder === "undefined") {
      this.decoderError = "webcodecs-unavailable";
      return false;
    }
    try {
      const decoder = new AudioDecoder({
        output: (data) => this.publish(data),
        error: (error) => {
          this.decoderError = String(error);
          // 解码器坏了：后面的帧都解不出来，别让整段挂在"等输出"上。
          this.queuedFrames = 0;
          this.maybeComplete();
        },
      });
      decoder.configure({ codec: "mp3", sampleRate: rate, numberOfChannels: 1 });
      this.decoder = decoder;
      return true;
    } catch (error) {
      this.decoderError = String(error);
      return false;
    }
  }

  private feed(unit: Mp3FrameUnit): void {
    if (!this.live) return;
    // 测试接缝：没有 WebCodecs 的环境走整块解码（生产不走这条）。
    if (this.options.decodeAllForTest) { void this.feedViaFallback(unit, this.options.decodeAllForTest); return; }
    if (!this.ensureDecoder(unit.bytes)) return;
    const decoder = this.decoder;
    if (!decoder) return;
    let cursor = 0;
    while (cursor < unit.bytes.length) {
      const length = mp3FrameLength(unit.bytes, cursor);
      if (length <= 0) break;
      if (cursor + length > unit.bytes.length) break;
      const frameBytes = unit.bytes.subarray(cursor, cursor + length);
      const samplesPerFrame = this.samplesPerFrame || frameSamplesAt(frameBytes) || 576;
      const timestampSec = (this.fedFrames * samplesPerFrame) / this.sourceSampleRate;
      try {
        decoder.decode(new EncodedAudioChunk({
          // MP3 每帧自带完整信息，按关键帧喂即可。
          type: "key",
          timestamp: Math.round(timestampSec * 1_000_000),
          data: frameBytes,
        }));
      } catch (error) {
        this.decoderError = String(error);
        break;
      }
      this.fedFrames += 1;
      this.queuedFrames += 1;
      cursor += length;
    }
  }

  /** 兜底 / 测试接缝：整块解码后整体排播。 */
  private async feedViaFallback(
    unit: Mp3FrameUnit,
    decode: (bytes: Uint8Array) => Promise<AudioBuffer | null>,
  ): Promise<void> {
    this.pendingFallbacks += 1;
    try {
      const buffer = await decode(unit.bytes);
      if (!buffer || !this.live) return;
      this.enqueue(buffer);
    } finally {
      // 在途计数要跟着收尾判定走：字节还在路上时不能判"整段播完"，
      // 否则 `finish()` 会先把播放器关掉，这一块就永远排不上（实测踩到）。
      this.pendingFallbacks -= 1;
      this.maybeComplete();
    }
  }

  /** 解码器吐出一段 PCM：排到播放时钟上。 */
  private publish(data: AudioData): void {
    if (!this.live) { data.close(); return; }
    this.queuedFrames = Math.max(0, this.queuedFrames - 1);
    const frames = data.numberOfFrames;
    const rate = data.sampleRate;
    if (frames <= 0 || rate <= 0) { data.close(); this.maybeComplete(); return; }
    const pcm = new Float32Array(frames);
    try {
      data.copyTo(pcm, { planeIndex: 0, format: "f32-planar" });
    } catch {
      data.close();
      this.maybeComplete();
      return;
    }
    data.close();
    this.resampler ??= new StreamingPcmResampler(rate, this.context.sampleRate);
    if (rate !== this.resampler.sourceRate) {
      this.decoderError = 'sample-rate-changed';
      this.maybeComplete();
      return;
    }
    this.schedulePcm(this.resampler.push(pcm));
    this.maybeComplete();
  }

  private schedulePcm(pcm: Float32Array): void {
    if (!pcm.length) return;
    const buffer = this.context.createBuffer(1, pcm.length, this.context.sampleRate);
    buffer.getChannelData(0).set(pcm);
    this.enqueue(buffer);
  }

  private prebufferSeconds(): number {
    return this.options.prebufferSeconds ?? (this.options.decodeAllForTest ? 0 : 0.35);
  }

  /** 解码后的音频先进抖动缓冲，攒够阈值再排播。 */
  private enqueue(buffer: AudioBuffer): void {
    if (!this.live) return;
    if (this.options.audible && !this.options.audible()) { this.stop(); return; }
    if (!(buffer.duration > 0)) return;
    this.pendingBuffers.push(buffer);
    this.pendingSeconds += buffer.duration;
    this.pump();
  }

  private pump(): void {
    if (!this.live) return;
    // 流已经结束：无条件排空，缓冲状态不再拦收尾（实机卡壳回归）。
    if (this.finished) this.buffering = false;
    const now = this.context.currentTime;
    if (!this.buffering && this.scheduledEndAt !== null && now > this.scheduledEndAt + 0.02) {
      // 欠载：结账已播秒数，暂停排播重新攒，而不是在当前位置插一个缝。
      this.playedOffset += Math.max(0, this.scheduledEndAt - (this.startedAt ?? now));
      this.startedAt = null;
      this.nextStartFrame = null;
      this.scheduledEndAt = null;
      this.buffering = true;
    }
    const target = this.finished ? 0
      : this.buffering ? (this.playedOffset > 0 ? IncrementalAudioPlayer.REBUFFER_SECONDS : this.prebufferSeconds())
        : 0;
    if (this.buffering && this.pendingSeconds < target) { this.maybeComplete(); return; }
    if (this.buffering) { this.buffering = false; this.nextStartFrame = null; }
    while (this.pendingBuffers.length > 0) {
      const next = this.pendingBuffers.shift()!;
      this.pendingSeconds = Math.max(0, this.pendingSeconds - next.duration);
      this.scheduleAt(next);
    }
    this.maybeComplete();
  }

  private scheduleAt(buffer: AudioBuffer): void {
    if (!this.live) return;
    if (this.options.audible && !this.options.audible()) { this.stop(); return; }
    if (!(buffer.duration > 0)) return;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.options.destination);
    const rate = buffer.sampleRate;
    const startFrame = this.nextStartFrame === null
      ? Math.ceil((this.context.currentTime + 0.02) * rate)
      : Math.max(this.nextStartFrame, Math.ceil((this.context.currentTime + 0.005) * rate));
    const startAt = startFrame / rate;
    this.nextStartFrame = startFrame + buffer.length;
    this.scheduledEndAt = (startFrame + buffer.length) / rate;
    this.sources.push(source);
    const first = this.startedAt === null;
    if (first) this.startedAt = startAt - this.playedOffset;
    this.decodedSeconds = Math.max(this.decodedSeconds, this.nextStartFrame / rate - this.startedAt!);
    source.onended = () => {
      const index = this.sources.indexOf(source);
      if (index >= 0) this.sources.splice(index, 1);
      this.maybeComplete();
    };
    // 先真的开播再启动进度循环：进度循环在纯 node 环境没有 rAF 会抛，
    // 抛在 start() 之前就等于这一段根本没响（单测抓到的正是这个顺序）。
    source.start(startAt);
    if (first) this.tick();
  }

  /** 没有 rAF 的环境（纯 node 单测）只播不报进度。 */
  private scheduleFrame(): void {
    if (typeof requestAnimationFrame === 'function') this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (): void => {
    if (!this.live) return;
    const report = this.options.onProgress;
    if (report && this.startedAt !== null) {
      const played = Math.max(0, this.context.currentTime - this.startedAt);
      report(Math.min(played, this.decodedSeconds));
    }
    this.scheduleFrame();
  };

  /** 收尾：流结束、解码器吐完、所有已排的 source 播完。 */
  private maybeComplete(): void {
    if (!this.finished || !this.live) return;
    if (this.queuedFrames > 0 || this.flushing || this.pendingFallbacks > 0 || this.sources.length > 0
      || this.pendingBuffers.length > 0 || this.pendingSeconds > 0) return;
    this.live = false;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    this.options.onDone?.();
  }
}
