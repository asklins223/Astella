/**
 * 伴星语音录制器（2026-09-18 接线；2026-10-07 增加常驻会话的流模式）。
 *
 * getUserMedia 采集麦克风 → AudioWorklet 收 Float32 帧 → 交给消费方。
 *
 * 两种用法共用一个采集器：
 * - **一次一段**（`run-voice-input` 那种按一句）：不传 `onFrame`，帧攒在内部，
 *   `stop()` 返回整段 16kHz 音频与 WAV。
 * - **常驻对话**（伴星这套）：传 `onFrame`，每一帧**立刻**交出去，内部一片不留。
 *   切段与降采样归 `CompanionVoiceSegmenter`。这里必须真的不留——一条开着十分钟的
 *   麦克风流按 48kHz Float32 攒着就是 180MB，而它只是要被切成一句一句送走的。
 */

export interface VoiceRecording {
  readonly sampleRate: 16000;
  readonly samples: Float32Array;
  readonly wav: ArrayBuffer;
  readonly durationMs: number;
}

export interface CompanionVoiceRecorderOptions {
  /**
   * 实时电平（RMS，0..1），约 20Hz。麦克风按钮的呼吸环与静音自动结束判定都读
   * 它；worklet 每 ~2.7ms 推一帧，所以这里做了节流，不让它牵着 React 每帧重渲。
   */
  readonly onLevel?: (level: number) => void;
  /**
   * 每一帧原始麦克风数据（未经降采样，采样率见 `inputSampleRate`）。
   *
   * 传了它就等于进入**流模式**：帧立刻外发、内部不再攒，`stop()` 只负责交还麦克风。
   */
  readonly onFrame?: (chunk: Float32Array, inputSampleRate: number) => void;
  /**
   * 录到 `maxDurationMs` 上限时通知调用方，**不由录音器自己停**。
   *
   * 以前这一句是 `void this.stop()`：返回值没人接，于是调用方（`use-companion-voice-input`）
   * 一直停在 `listening`——气泡写着「我在听」、按钮还在脉动，麦克风灯其实已经灭了，
   * 那 60 秒音频当场丢掉；用户再点一次只会得到「好像没录到内容」（方案 35 E2）。
   * 交回调用方走正常的收尾路径，这段录音才还会被送去识别。
   */
  readonly onLimit?: () => void;
  readonly onError?: () => void;
  /** 上限时长；常驻会话要的是"这一轮别说太久"，不是"会话只能一分钟"。 */
  readonly maxDurationMs?: number;
}

const TARGET_SAMPLE_RATE = 16000;
const MAX_DURATION_MS = 60_000;
const LEVEL_INTERVAL_MS = 50;

/** 单帧 RMS 电平。抽成纯函数，既给回调用也便于单测。 */
export function companionVoiceLevel(chunk: Float32Array): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < chunk.length; index += 1) sum += chunk[index] * chunk[index];
  return Math.sqrt(sum / chunk.length);
}

const WORKLET_SOURCE = `
class CompanionTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("companion-tap", CompanionTapProcessor);
`;

export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return input;
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    output[i] = end > start ? sum / (end - start) : 0;
  }
  return output;
}

function floatToPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm;
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const pcm = floatToPcm16(samples);
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  let offset = 44;
  for (let i = 0; i < pcm.length; i += 1, offset += 2) view.setInt16(offset, pcm[i], true);
  return buffer;
}

export class CompanionVoiceRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private silentOutput: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private totalFrames = 0;
  private startedAt = 0;
  private recording = false;
  private contextSampleRate = TARGET_SAMPLE_RATE;
  private readonly levelListener: ((level: number) => void) | null = null;
  private readonly frameListener: ((chunk: Float32Array, inputSampleRate: number) => void) | null = null;
  private readonly limitListener: (() => void) | null = null;
  private readonly maxDurationMs: number;
  private limitFired = false;
  private cancelled = false;
  private readonly errorListener: (() => void) | null;

  constructor(options?: CompanionVoiceRecorderOptions) {
    this.levelListener = options?.onLevel ?? null;
    this.frameListener = options?.onFrame ?? null;
    this.limitListener = options?.onLimit ?? null;
    this.errorListener = options?.onError ?? null;
    this.maxDurationMs = options?.maxDurationMs ?? MAX_DURATION_MS;
  }

  static isSupported(): boolean {
    return typeof navigator !== "undefined"
      && Boolean(navigator.mediaDevices?.getUserMedia)
      && typeof AudioContext !== "undefined";
  }

  get active(): boolean {
    return this.recording;
  }

  /** 流模式为真：帧外发、内部不攒。 */
  get streaming(): boolean {
    return this.frameListener !== null;
  }

  /** 麦克风的实际采样率（一般是声卡的 48kHz），降采样由拿到帧的一方做。 */
  get inputSampleRate(): number {
    return this.contextSampleRate;
  }

  async start(): Promise<void> {
    if (this.recording) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // 权限弹窗还开着时也能取消；迟到的授权只负责交还设备。
    if (this.cancelled) { for (const track of stream.getTracks()) track.stop(); return; }
    this.stream = stream;
    for (const track of stream.getAudioTracks()) track.onended = () => {
      if (this.recording) { void this.stop(); this.errorListener?.(); }
    };
    try {
      this.context = new AudioContext();
      await this.context.resume();
      if (this.cancelled) return;
      this.contextSampleRate = this.context.sampleRate;
      this.source = this.context.createMediaStreamSource(this.stream);
      this.chunks = [];
      this.totalFrames = 0;
      this.startedAt = Date.now();
      this.limitFired = false;
      let lastLevelAt = 0;
      let levelSquares = 0;
      let levelFrames = 0;
      const levelListener = this.levelListener;
      const frameListener = this.frameListener;
      const onChunk = (chunk: Float32Array) => {
        if (!this.recording) return;
        const copy = chunk.slice(0);
        if (frameListener) {
          // 流模式：这片音频归调用方（分段缓冲）持有，这里一片不留。
          frameListener(copy, this.contextSampleRate);
        } else {
          this.chunks.push(copy);
          this.totalFrames += copy.length;
        }
        const now = Date.now();
        for (const sample of copy) levelSquares += sample * sample;
        levelFrames += copy.length;
        if (levelListener && now - lastLevelAt >= LEVEL_INTERVAL_MS) {
          lastLevelAt = now;
          levelListener(Math.sqrt(levelSquares / Math.max(1, levelFrames)));
          levelSquares = 0; levelFrames = 0;
        }
        // 到上限：交回调用方收尾（它会 `stop()` 并把这段送去识别），不自己悄悄停掉。
        if (now - this.startedAt >= this.maxDurationMs && !this.limitFired) {
          this.limitFired = true;
          this.limitListener?.();
        }
      };
      try {
        const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
        try {
          await this.context.audioWorklet.addModule(workletUrl);
          if (this.cancelled) return;
          this.worklet = new AudioWorkletNode(this.context, "companion-tap");
          this.worklet.port.onmessage = (event) => onChunk(event.data as Float32Array);
          this.source.connect(this.worklet);
          // 保持处理图被声卡拉取，但麦克风输出始终为零。
          this.silentOutput = this.context.createGain();
          this.silentOutput.gain.value = 0;
          this.worklet.connect(this.silentOutput).connect(this.context.destination);
        } finally {
          URL.revokeObjectURL(workletUrl);
        }
      } catch {
        if (this.cancelled) return;
        // ScriptProcessor 兜底（已弃用但行为一致，防极端环境）。
        this.scriptNode = this.context.createScriptProcessor(4096, 1, 1);
        this.scriptNode.onaudioprocess = (event) => onChunk(event.inputBuffer.getChannelData(0));
        this.source.connect(this.scriptNode);
        this.scriptNode.connect(this.context.destination);
      }
      this.recording = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<VoiceRecording | null> {
    this.cancelled = true;
    const wasRecording = this.recording;
    this.recording = false;
    try { this.worklet?.disconnect(); } catch { /* already gone */ }
    try { this.scriptNode?.disconnect(); } catch { /* already gone */ }
    try { this.source?.disconnect(); } catch { /* already gone */ }
    try { this.silentOutput?.disconnect(); } catch { /* already gone */ }
    for (const track of this.stream?.getTracks() ?? []) { track.onended = null; track.stop(); }
    const sampleRate = this.contextSampleRate;
    await this.context?.close().catch(() => undefined);
    this.worklet = null;
    this.scriptNode = null;
    this.source = null;
    this.silentOutput = null;
    this.stream = null;
    this.context = null;
    const durationMs = Date.now() - this.startedAt;
    // 流模式下 `totalFrames` 一直是 0：音频早就一帧帧交出去了，这里只是把麦克风还掉。
    if (!wasRecording || this.totalFrames < (sampleRate * 200) / 1000) { this.chunks = []; this.totalFrames = 0; return null; }
    const merged = new Float32Array(this.totalFrames);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.totalFrames = 0;
    const samples = downsampleTo16k(merged, sampleRate);
    return {
      sampleRate: TARGET_SAMPLE_RATE,
      samples,
      wav: encodeWav(samples, TARGET_SAMPLE_RATE),
      durationMs,
    };
  }
}
