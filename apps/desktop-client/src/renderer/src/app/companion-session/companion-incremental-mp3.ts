/**
 * 增量音频排播（2026-10-17）。
 *
 * 原来一段语音必须**整段到齐**才能 `decodeAudioData` 再播：HTTP 那条路把 MP3 收完
 * 才返回，客户端拿到的是一个完整 buffer。服务端其实早就在流式合成（千问 WS 逐块
 * 吐字节），被客户端这一侧"收齐再解"抹平了——本地实测首段可播相差 0.6–1.2 秒。
 *
 * 这里把播放拆成"按 MP3 帧切 → 逐段解码 → 在音频时钟上首尾相接排播"：
 *
 * - 只要**第一个解码单元**到手就能开口，其余单元在播的时候继续解；
 * - 所有单元都排在同一个 AudioContext 时钟上，不用每段重开一个 source，
 *   段间不会有调度缝隙（那正是"一顿一顿"的来源）；
 * - 进度按"已播时长 / 已知总时长"折算，未知时按已解码部分折算，避免字幕停在 0；
 * - 取消时把后面的单元全部撤下（已排的 source.stop()）。
 *
 * 帧解析是纯函数，单独可测（见 `__tests__/companion-incremental-mp3.test.ts`）。
 */

/** 一个可独立解码的单元：连续若干完整 MP3 帧。 */
export interface Mp3FrameUnit {
  readonly bytes: Uint8Array;
  /** 该单元在整条流里的起始字节位置（诊断用）。 */
  readonly offset: number;
}

/**
 * MPEG Layer III 帧长。
 * 返回 -1 表示这里不是可信的帧头；返回 0 表示"字节还不够判断，等更多数据"。
 */
export function mp3FrameLength(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  if (bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xe0) !== 0xe0) return -1;
  const versionBits = (bytes[offset + 1]! >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (bytes[offset + 1]! >> 1) & 0x03; // 1 = Layer III
  if (layerBits !== 1) return -1;
  const bitrateIndex = (bytes[offset + 2]! >> 4) & 0x0f;
  const rateIndex = (bytes[offset + 2]! >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return -1;
  const padding = (bytes[offset + 2]! >> 1) & 0x01;
  const sampleRate = versionBits === 3
    ? [44100, 48000, 32000][rateIndex]
    : versionBits === 2
      ? [22050, 24000, 16000][rateIndex]
      : [11025, 12000, 8000][rateIndex];
  const bitrate = (versionBits === 3
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0][bitrateIndex]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0][bitrateIndex])! * 1000;
  if (!sampleRate || !bitrate) return -1;
  const length = versionBits === 3
    ? Math.floor((144 * bitrate) / sampleRate) + padding
    : Math.floor((72 * bitrate) / sampleRate) + padding;
  return length > 4 ? length : -1;
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
 * 把不断到达的字节切成解码单元。
 *
 * `targetFrames` 是每个单元包含的帧数：8 帧约 0.2 秒（44.1kHz、128kbps），
 * 小到足够早开口，大到不会让每个单元都短到解码开销反超。
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
  private unitSize = 0;

  constructor(private readonly targetFrames = 8) {}

  /** 压入新到的字节，返回本次凑满的解码单元。 */
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
      const length = mp3FrameLength(bytes, cursor);
      if (length === 0) break;                       // 头还没收全，等下一块
      if (length < 0) {
        // 不是帧头：可能中间夹了标签或有损坏，往后挪一个字节重新对齐。
        cursor += 1;
        continue;
      }
      if (cursor + length > bytes.length) break;     // 这一帧还没收全
      if (this.framesInUnit === 0) this.unitStart = cursor;
      this.unitBytes.push(bytes.subarray(cursor, cursor + length));
      this.unitSize += length;
      this.framesInUnit += 1;
      cursor += length;
      if (this.framesInUnit >= this.targetFrames) {
        out.push({ bytes: this.mergeUnit(), offset: this.unitStart });
        this.resetUnit();
      }
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
      if (this.framesInUnit > 0) out.push({ bytes: this.mergeUnit(), offset: this.unitStart });
      this.resetUnit();
      this.chunks.length = 0;
      this.buffered = 0;
      this.frameStart = 0;
    }
    return out;
  }

  private mergeUnit(): Uint8Array {
    const merged = new Uint8Array(this.unitSize);
    let at = 0;
    for (const frame of this.unitBytes) { merged.set(frame, at); at += frame.length; }
    return merged;
  }

  private resetUnit(): void {
    this.unitBytes = [];
    this.unitSize = 0;
    this.framesInUnit = 0;
  }
}

export interface IncrementalPlaybackOptions {
  readonly context: AudioContext;
  readonly destination: AudioNode;
  /** 解码一个单元；失败返回 null（坏单元跳过，不影响后面的）。 */
  readonly decode: (bytes: Uint8Array) => Promise<AudioBuffer | null>;
  /** 已播秒数变化（用于进度与口型）。 */
  readonly onProgress?: (seconds: number) => void;
  /** 整条流结束且全部播完。 */
  readonly onDone?: () => void;
  /** 是否还能出声（静音/窗口不可见时直接停）。 */
  readonly audible?: () => boolean;
}

/**
 * 在同一个 AudioContext 时钟上把陆续解码出来的单元首尾相接。
 *
 * 关键在 `nextStartAt`：每个单元都排在"上一个单元的结束时刻"，而不是
 * "现在 + 一点延迟"。后者会在每段之间引入一次小的空档，听感是"一顿一顿"。
 */
export class IncrementalAudioPlayer {
  private readonly context: AudioContext;
  private readonly assembler = new Mp3FrameAssembler();
  private readonly sources: AudioBufferSourceNode[] = [];
  private readonly queued: Promise<void>[] = [];
  /** 下一个单元的起播时刻；null 表示还没排过。 */
  private nextStartAt: number | null = null;
  private decodedSeconds = 0;
  private startedAt: number | null = null;
  private live = true;
  private finished = false;
  private frame = 0;

  constructor(private readonly options: IncrementalPlaybackOptions) {
    this.context = options.context;
  }

  push(chunk: Uint8Array): void {
    if (!this.live) return;
    for (const unit of this.assembler.push(chunk)) void this.enqueue(unit);
  }

  finish(): void {
    if (!this.live) return;
    for (const unit of this.assembler.flush()) void this.enqueue(unit);
    this.finished = true;
    void Promise.all(this.queued).then(() => this.maybeComplete());
  }

  stop(): void {
    if (!this.live) return;
    this.live = false;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    for (const source of this.sources) {
      try { source.stop(); } catch { /* 已经自然结束 */ }
    }
    this.sources.length = 0;
  }

  get isLive(): boolean {
    return this.live;
  }

  private async enqueue(unit: Mp3FrameUnit): Promise<void> {
    const task = (async () => {
      if (!this.live) return;
      const buffer = await this.options.decode(unit.bytes);
      if (!buffer || !this.live) return;
      if (this.options.audible && !this.options.audible()) { this.stop(); return; }
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.options.destination);
      const startAt = this.nextStartAt === null
        ? this.context.currentTime + 0.02   // 第一个单元：留一点调度余量
        : Math.max(this.nextStartAt, this.context.currentTime + 0.005);
      this.nextStartAt = startAt + buffer.duration;
      this.sources.push(source);
      const first = this.startedAt === null;
      if (first) this.startedAt = startAt;
      this.decodedSeconds = Math.max(this.decodedSeconds, this.nextStartAt - this.startedAt!);
      // 先真的开播再启动进度循环：进度循环在纯 node 环境没有 rAF 会抛，
      // 抛在 start() 之前就等于这一段根本没响（单测抓到的正是这个顺序）。
      source.start(startAt);
      if (first) this.tick();
      await new Promise<void>((resolve) => {
        source.onended = () => {
          const index = this.sources.indexOf(source);
          if (index >= 0) this.sources.splice(index, 1);
          resolve();
        };
      });
      this.maybeComplete();
    })();
    this.queued.push(task);
    // 不 await 自己：`enqueue` 是 fire-and-forget 的排播，等它会把下一块
    // 的解码推迟到这一段播完之后（实测只排上第一段）。
    task.catch(() => undefined);
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
      // 已解码的总时长还可能是 0（第一个单元刚排上），此时报 0 即可。
      report(Math.min(played, this.decodedSeconds));
    }
    this.scheduleFrame();
  };

  private maybeComplete(): void {
    if (!this.finished || !this.live || this.sources.length > 0) return;
    this.live = false;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    this.options.onDone?.();
  }
}
