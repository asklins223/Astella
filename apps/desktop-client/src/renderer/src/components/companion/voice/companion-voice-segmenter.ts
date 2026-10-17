/**
 * 对话模式下的分段缓冲（2026-10-07）。
 *
 * 常驻对话不再是"一次录音一个结果"，而是**一条麦克风流被切成若干段**：短停顿切一段
 * 送去识别，长停顿结束这一轮。这个类只管把连续帧攒成可以交出去的一段音频，
 * 不判断什么时候切——判定在 `companion-voice-vad`，这里切开的口子由它决定。
 *
 * 两个细节是要它的原因：
 *
 * - **静音尾巴也算进段里**。切段的判定看的是电平，所以决定要切的时候，最近 450ms
 *   本来就都是静音；把这些帧一起交出去，段与段之间不会凭空多出被吃掉的字。
 * - **开放一段时把环形缓冲垫在开头**。电平阈值看到的是 20Hz 的采样，用户真正开口
 *   可能在上一拍之前，不垫这 250ms 就会把每个字的首音截掉——识别成别的词。
 *   环形里此时装的只有静音（切段必然发生在静音里），所以垫它不会重复上段的尾音。
 */

import { downsampleTo16k } from "./voice-recorder";

const TARGET_SAMPLE_RATE = 16_000;

export interface CompanionVoiceSegmenterOptions {
  /** 开口前垫进去的时长。 */
  readonly preRollMs?: number;
  /** 短于这么长的段不值得送去识别（呼吸、碰桌子的声音）。 */
  readonly minSegmentMs?: number;
}

export class CompanionVoiceSegmenter {
  private readonly preRollFrames: number;
  private readonly minSegmentFrames: number;
  private ring: Float32Array[] = [];
  private ringFrames = 0;
  private pending: Float32Array[] = [];
  private pendingFrames = 0;
  private open = false;
  private sampleRate = TARGET_SAMPLE_RATE;

  constructor(options: CompanionVoiceSegmenterOptions = {}) {
    const preRollMs = options.preRollMs ?? 250;
    const minSegmentMs = options.minSegmentMs ?? 220;
    // 帧长换算要等第一帧才知道输入采样率，这里先按 16kHz 存个数，
    // `push` 里降采样之后再按实际率裁剪环形缓冲。
    this.preRollFrames = Math.max(1, Math.round((preRollMs * TARGET_SAMPLE_RATE) / 1000));
    this.minSegmentFrames = Math.round((minSegmentMs * TARGET_SAMPLE_RATE) / 1000);
  }

  /** 当前未交出的一段有多长（毫秒），调用方用它给"一口气说了很久"兜底。 */
  get pendingDurationMs(): number {
    return (this.pendingFrames / this.sampleRate) * 1000;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * 收一帧原始麦克风数据。
   *
   * 降采样放在这里而不是录音器里：整条会话的帧都要过一遍，而录音器原来只在
   * `stop()` 时对合并后的整段做一次——常驻模式下没有那个"整段"了。
   */
  push(chunk: Float32Array, inputSampleRate: number): void {
    this.sampleRate = TARGET_SAMPLE_RATE;
    const frame = inputSampleRate === TARGET_SAMPLE_RATE ? chunk : downsampleTo16k(chunk, inputSampleRate);
    if (frame.length === 0) return;
    const target = this.open ? this.pending : this.ring;
    target.push(frame);
    if (this.open) this.pendingFrames += frame.length;
    else {
      this.ringFrames += frame.length;
      // 环形只留最近 preRoll 那么长；多了从头部裁掉，不重建数组。
      while (this.ringFrames > this.preRollFrames && this.ring.length > 0) {
        const overflow = this.ringFrames - this.preRollFrames;
        const first = this.ring[0]!;
        if (first.length > overflow) {
          this.ring[0] = first.subarray(overflow);
          this.ringFrames -= overflow;
          break;
        }
        this.ring.shift();
        this.ringFrames -= first.length;
      }
    }
  }

  /** 电平判定"开始说话了"：把环形里垫着的开头接进当前段。 */
  openSegment(): void {
    if (this.open) return;
    this.open = true;
    if (this.ring.length === 0) return;
    for (const frame of this.ring) {
      this.pending.push(frame);
      this.pendingFrames += frame.length;
    }
    this.ring = [];
    this.ringFrames = 0;
  }

  /**
   * 取走当前段并关门。短到不值得识别时返回 null（仍然清空，别让半口气留着污染下一段）。
   */
  drain(): Float32Array | null {
    this.open = false;
    const frames = this.pending;
    const total = this.pendingFrames;
    this.pending = [];
    this.pendingFrames = 0;
    if (total < this.minSegmentFrames) return null;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const frame of frames) {
      merged.set(frame, offset);
      offset += frame.length;
    }
    return merged;
  }

  /** 结束会话（或换一轮之前）：丢掉所有攒着的音频，不带任何判定。 */
  reset(): void {
    this.ring = [];
    this.ringFrames = 0;
    this.pending = [];
    this.pendingFrames = 0;
    this.open = false;
  }
}
