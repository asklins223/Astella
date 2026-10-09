import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomStore } from "../../app/room-store";
import { useUpdateStatus } from "../../app/update-status";
import {
  createRequestMeta,
  gatewayErrorMessage,
  unwrapGatewayResult,
} from "../../app/desktop-client";
import { useHomeProjectionInvalidation } from "../../app/home-projection";
import { shouldPlayCompanionReplyVoice, shouldPlayHomeV2Feedback } from "./home-v2";
import { setHomeV2VoiceLevel } from "../../app/companion-voice-level";
import {
  isCompanionMicrophoneActive, isCompanionNotificationSpeechActive,
  isCompanionReplyBlockedByMicrophone,
  setCompanionNotificationVoiceHost, stopCompanionNotificationSpeech, subscribeCompanionAudioPriority, isPausedCompanionGuidanceSpeech,
  type NotificationVoicePurpose,
} from "../companion/companion-notification-voice";
import type { CompanionNotificationAudio } from "../companion/companion-notifications";
import {
  isCompanionSpeechActive,
  setCompanionVoiceHost,
  CompanionCachedAudioError,
  stopCompanionSpeech,
} from "../../app/companion-voice-playback";
import {
  companionMouthTarget,
  smoothCompanionMouthLevel,
} from "../../app/companion-mouth-meter";
import type {
  CompanionVoicePlaybackOutcomeRequestV1,
  CompanionVoiceSpeakSegmentRequestV2,
  CompanionCachedVoiceReadRequestV1,
} from "@astella/shared/companion-voice-contracts";

type HomeV2SoundKind = "page" | "footstep" | "magic" | "success";

export type HomeV2VoiceRequest = {
  readonly text: string;
  readonly reason: "cue" | "touch";
};

/**
 * Frozen audio tuning for the cottage.
 *
 * Every deliberate sound must sit inside the band a laptop or desktop speaker can
 * actually reproduce. The first revision of this file used a 92 Hz sine for the
 * footstep body, below the useful output of ordinary speakers, which made the
 * step inaudible in practice. Keep every new cue inside the mid band.
 *
 * 这里没有任何常驻音源。上一版首页挂着一层噪声环境床（带通 520 Hz、增益 0.03、
 * 叠 0.07 Hz 阵风）：指针第一次解锁就开始响，待到离开房间才停——阅读应用底下
 * 一层不会自己结束的底噪是噪音，不是氛围。2026-10-06 用户裁决删掉它，声音只跟
 * 着事情发生。
 */
export const HOME_V2_AUDIO_TUNING = Object.freeze({
  page: Object.freeze({ highpassHz: 650, gain: 0.032, seconds: 0.11 }),
  footstep: Object.freeze({
    tapHz: 1_150,
    tapQ: 1.1,
    bodyFromHz: 150,
    bodyToHz: 95,
    tapGain: 0.05,
    bodyGain: 0.042,
    seconds: 0.13,
  }),
  magic: Object.freeze({
    fromHz: 420,
    toHz: 690,
    shimmerFromHz: 630,
    shimmerToHz: 980,
    gain: 0.028,
    shimmerGain: 0.012,
    seconds: 0.3,
  }),
  success: Object.freeze({ notesHz: [660, 880, 990] as const, gain: 0.022, noteSeconds: 0.27, intervalSeconds: 0.1 }),
  voice: Object.freeze({
    cooldownMs: 6_000,
    failureBackoffMs: 60_000,
    analyserFftSize: 256,
    analyserSmoothing: 0.82,
  }),
});

type HomeV2AudioGraph = {
  readonly context: AudioContext;
};

type VoicePlayback = {
  readonly source: AudioBufferSourceNode;
  readonly analyser: AnalyserNode;
  readonly samples: Float32Array;
  frame: number;
  /**
   * 播完或被 stopVoicePlayback 打断时收尾，让等待这次播放的人一定拿到结果。
   * 参数是**这一段到底响没响**：自然播完才是 true，被喊停的一律 false——
   * 播放服务靠它把没出声的段报成 dropped，而不是记成一次成功播放。
   */
  readonly settle: (heard: boolean) => void;
};

function whiteNoise(context: AudioContext, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.max(1, Math.round(context.sampleRate * seconds)), context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < channel.length; index += 1) channel[index] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * 音频图现在只有一条通道：一个 AudioContext。
 *
 * 这里**不启动任何节点**。瞬态音和台词都由事件现场合成，建图本身必须安静——
 * 一个"建好就一直响"的图正是上一版环境床的形状，`home-audio-idle` 钉住这条。
 */
function buildAudioGraph(): HomeV2AudioGraph {
  return { context: new AudioContext() };
}

function decayEnvelope(
  gain: GainNode,
  context: AudioContext,
  peak: number,
  seconds: number,
): void {
  const now = context.currentTime;
  gain.gain.setValueAtTime(Math.max(0.0001, peak), now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
}

function playNoiseTap(
  context: AudioContext,
  destination: AudioNode,
  options: { readonly hz: number; readonly q: number; readonly gain: number; readonly seconds: number },
): void {
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  source.buffer = whiteNoise(context, options.seconds);
  filter.type = "bandpass";
  filter.frequency.value = options.hz;
  filter.Q.value = options.q;
  decayEnvelope(gain, context, options.gain, options.seconds);
  source.connect(filter).connect(gain).connect(destination);
  source.start(context.currentTime);
  source.stop(context.currentTime + options.seconds);
}

function playTransient(graph: HomeV2AudioGraph, kind: HomeV2SoundKind): void {
  const { context } = graph;
  const now = context.currentTime;

  if (kind === "success") {
    // A short, soft three-note arrival cue; the evidence and Companion line
    // carry the meaning, so this remains optional and never blocks results.
    const tuning = HOME_V2_AUDIO_TUNING.success;
    tuning.notesHz.forEach((frequency, index) => {
      const start = now + index * tuning.intervalSeconds;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(tuning.gain, start + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + tuning.noteSeconds);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + tuning.noteSeconds + 0.01);
    });
    return;
  }

  if (kind === "page") {
    // Paper is broadband air: a filtered noise burst with a fast decay.
    const tuning = HOME_V2_AUDIO_TUNING.page;
    const sampleCount = Math.round(context.sampleRate * tuning.seconds);
    const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = (Math.random() * 2 - 1) * (1 - index / sampleCount);
    }
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    filter.type = "highpass";
    filter.frequency.value = tuning.highpassHz;
    decayEnvelope(gain, context, tuning.gain, tuning.seconds);
    source.buffer = buffer;
    source.connect(filter).connect(gain).connect(context.destination);
    source.start(now);
    source.stop(now + tuning.seconds + 0.01);
    return;
  }

  if (kind === "footstep") {
    // A step on wood reads as a mid-band tap plus a short body thump. Both
    // components stay inside the reproducible band.
    const tuning = HOME_V2_AUDIO_TUNING.footstep;
    playNoiseTap(context, context.destination, {
      hz: tuning.tapHz,
      q: tuning.tapQ,
      gain: tuning.tapGain,
      seconds: tuning.seconds,
    });
    const body = context.createOscillator();
    const gain = context.createGain();
    body.type = "sine";
    body.frequency.setValueAtTime(tuning.bodyFromHz, now);
    body.frequency.exponentialRampToValueAtTime(tuning.bodyToHz, now + tuning.seconds);
    decayEnvelope(gain, context, tuning.bodyGain, tuning.seconds);
    body.connect(gain).connect(context.destination);
    body.start(now);
    body.stop(now + tuning.seconds);
    return;
  }

  const tuning = HOME_V2_AUDIO_TUNING.magic;
  const glow = context.createOscillator();
  const shimmer = context.createOscillator();
  const glowGain = context.createGain();
  const shimmerGain = context.createGain();
  glow.type = "triangle";
  glow.frequency.setValueAtTime(tuning.fromHz, now);
  glow.frequency.exponentialRampToValueAtTime(tuning.toHz, now + tuning.seconds);
  shimmer.type = "triangle";
  shimmer.frequency.setValueAtTime(tuning.shimmerFromHz, now);
  shimmer.frequency.exponentialRampToValueAtTime(tuning.shimmerToHz, now + tuning.seconds);
  decayEnvelope(glowGain, context, tuning.gain, tuning.seconds);
  decayEnvelope(shimmerGain, context, tuning.shimmerGain, tuning.seconds);
  glow.connect(glowGain).connect(context.destination);
  shimmer.connect(shimmerGain).connect(context.destination);
  glow.start(now);
  shimmer.start(now);
  glow.stop(now + tuning.seconds);
  shimmer.stop(now + tuning.seconds);
}

function decodeBase64Audio(context: AudioContext, base64: string): Promise<AudioBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return context.decodeAudioData(bytes.buffer);
}

/**
 * Audio is created only inside a trusted user gesture and stays silent in tasks.
 * It is also the single owner of companion voice playback, so the interface
 * transients and speech share one context, one mute gate and one amplitude
 * channel for the Live2D mouth. Nothing plays on its own: every cue is built at
 * the moment something happens.
 */
export function HomeV2AudioController() {
  const [unlocked, setUnlocked] = useState(false);
  const graphRef = useRef<HomeV2AudioGraph | null>(null);
  const voiceRef = useRef<VoicePlayback | null>(null);
  const mouthLevelRef = useRef(0);
  const mouthReleaseFrameRef = useRef(0);
  const voiceRequestGenerationRef = useRef(0);
  const lastVoiceRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const voiceFailureAtRef = useRef(0);
  const masterMuted = useRoomStore((state) => state.masterMuted);
  const surface = useRoomStore((state) => state.surface);
  const windowState = useRoomStore((state) => state.windowState);
  const installedUpdateVersion = useUpdateStatus(state => state.state.installedUpdate?.version);
  const startupAudioAllowed = useRef(false);
  startupAudioAllowed.current = Boolean(installedUpdateVersion) && !masterMuted && windowState === "visible" && !document.hidden;
  const invalidation = useHomeProjectionInvalidation();
  const workspaceEpochRef = useRef(invalidation.workspaceEpoch);
  workspaceEpochRef.current = invalidation.workspaceEpoch;
  const audibleRef = useRef(false);
  const notificationAudioCache = useRef(new Map<CompanionNotificationAudio, Promise<AudioBuffer>>());

  const stopVoicePlayback = useCallback((immediate = true, heard = false) => {
    const playback = voiceRef.current;
    voiceRef.current = null;
    activePlaybackRef.current = null;
    window.cancelAnimationFrame(mouthReleaseFrameRef.current);
    if (!playback) {
      if (immediate) {
        mouthLevelRef.current = 0;
        setHomeV2VoiceLevel(0);
      }
      return;
    }
    cancelAnimationFrame(playback.frame);
    try {
      playback.source.stop();
    } catch {
      // Already stopped: nothing to release.
    }
    playback.source.disconnect();
    playback.analyser.disconnect();
    if (immediate) {
      mouthLevelRef.current = 0;
      setHomeV2VoiceLevel(0);
    } else {
      let previousAt = performance.now();
      const release = (at: number) => {
        const next = smoothCompanionMouthLevel(mouthLevelRef.current, 0, at - previousAt);
        previousAt = at;
        mouthLevelRef.current = next;
        setHomeV2VoiceLevel(next);
        if (next > 0.01) mouthReleaseFrameRef.current = window.requestAnimationFrame(release);
        else {
          mouthLevelRef.current = 0;
          setHomeV2VoiceLevel(0);
        }
      };
      mouthReleaseFrameRef.current = window.requestAnimationFrame(release);
    }
    // 等待这次播放的人必须拿到结果，否则它会一直以为自己还在播。
    playback.settle(heard);
  }, []);

  /**
   * 播一段已经解码好的语音，按帧回报进度。
   *
   * 这是全应用唯一的语音播放出口：界面音效、伴星台词都走同一个
   * AudioContext 和同一条振幅通道。喊停永远由 stopVoicePlayback 统一处理，
   * 所以 cue 与对话台词天然互斥——谁抢到谁播，被抢的那个立刻拿到 resolve。
   *
   * 返回值是**这一段响没响**。闸门关着的时候这里直接返回 false，绝不"默默 resolve"：
   * 调用方拿不到这个区分，就会把没出声的段当成播完了（2026-10-09：窗口被盖住的
   * 那一瞬间，剩下每一段都这样被记成 played）。
   */
  const playVoiceBuffer = useCallback(async (
    buffer: AudioBuffer,
    onProgress: (fraction: number) => void,
    /** 这一路声音自己的闸门：对话台词、主动提示音、界面 cue 各有各的理由被关掉。 */
    allowed: () => boolean = () => replyAudibleRef.current,
    offset = 0,
  ): Promise<boolean> => {
    const graph = graphRef.current;
    if (!graph || !allowed() || isCompanionReplyBlockedByMicrophone()) {
      return false;
    }
    await graph.context.resume();
    if (graphRef.current !== graph || !allowed() || isCompanionReplyBlockedByMicrophone()) return false;
    stopVoicePlayback();
    return new Promise<boolean>((resolve) => {
      const source = graph.context.createBufferSource();
      const analyser = graph.context.createAnalyser();
      const tuning = HOME_V2_AUDIO_TUNING.voice;
      analyser.fftSize = tuning.analyserFftSize;
      analyser.smoothingTimeConstant = tuning.analyserSmoothing;
      source.buffer = buffer;
      source.connect(analyser).connect(graph.context.destination);
      const samples = new Float32Array(analyser.fftSize);
      const startedAt = graph.context.currentTime - offset;
      activePlaybackRef.current = { context: graph.context, startedAt, duration: buffer.duration };
      let previousMeterAt = performance.now();
      const playback: VoicePlayback = { source, analyser, samples, frame: 0, settle: resolve };
      const meter = (at: number) => {
        if (voiceRef.current !== playback) return;
        analyser.getFloatTimeDomainData(samples);
        const target = companionMouthTarget(samples);
        const level = smoothCompanionMouthLevel(mouthLevelRef.current, target, at - previousMeterAt);
        previousMeterAt = at;
        mouthLevelRef.current = level;
        setHomeV2VoiceLevel(level);
        const elapsed = graph.context.currentTime - startedAt;
        onProgress(buffer.duration > 0 ? Math.min(1, elapsed / buffer.duration) : 1);
        playback.frame = requestAnimationFrame(meter);
      };
      playback.frame = requestAnimationFrame(meter);
      source.onended = () => {
        if (voiceRef.current !== playback) return;
        stopVoicePlayback(false, true);
      };
      voiceRef.current = playback;
      if (offset > 0) source.start(0, offset); else source.start();
    });
  }, [stopVoicePlayback]);

  useEffect(() => {
    let disposed = false;
    let interacted = false;
    let idle: number | null = null;
    let timer: number | null = null;
    const prepare = () => {
      idle = null;
      timer = null;
      if (disposed) return;
      try {
        const graph = graphRef.current ?? buildAudioGraph();
        graphRef.current = graph;
        if (interacted || startupAudioAllowed.current) {
          void graph.context.resume().catch(() => undefined);
          setUnlocked(true);
        } else {
          // Warm the audio device before the first click; keep playback locked
          // until a real user gesture has arrived.
          void graph.context.suspend().catch(() => undefined);
        }
      } catch (err) {
        // Audio is progressive enhancement; the room and controls stay usable.
        //
        // 但**不要静默**：这里以前是 `catch {}`，一旦建图失败，`graphRef` 永远是
        // null，于是 `synthesize` / `synthesizeSegment` 每次都在**本地**抛
        // 「语音通道还没准备好」——一个请求都到不了服务端，日志里一条 TTS 错误
        // 都没有，而用户只看到「语音合成失败，已继续显示文字」。这种"哪儿都查不到
        // 原因"的形态比建图失败本身更贵。
        console.warn("[companion-voice] audio graph build failed", err);
      }
    };
    const schedule = () => {
      if (idle !== null || timer !== null) return;
      if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(prepare);
      else timer = window.setTimeout(prepare, 100);
    };
    const unlock = (event: Event) => {
      if (!event.isTrusted) return;
      interacted = true;
      const graph = graphRef.current;
      if (graph) {
        void graph.context.resume().catch(() => undefined);
        setUnlocked(true);
      } else schedule();
    };
    // Creating AudioContext synchronously in pointerdown blocked the first
    // navigation for ~186ms on the test machine. The event only unlocks a
    // prepared graph now; a very early click still never constructs one.
    schedule();
    window.addEventListener("pointerdown", unlock, { capture: true, once: true });
    window.addEventListener("keydown", unlock, { capture: true, once: true });
    return () => {
      disposed = true;
      if (idle !== null) window.cancelIdleCallback(idle);
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      const graph = graphRef.current;
      graphRef.current = null;
      void graph?.context.close().catch(() => undefined);
    };
  }, []);

  /**
   * 房间里**自己**发声的那一路：翻页、脚步、魔法这类瞬态音，和伴星的主动提示音。
   * 它们不是用户要的回答，所以进了任务页就收声——用户在读东西时，房间不该替他
   * 制造动静。
   */
  const audible = shouldPlayHomeV2Feedback({
    unlocked,
    masterMuted,
    surfaceOpen: Boolean(surface),
    windowVisible: windowState === "visible" && !document.hidden,
  });
  audibleRef.current = audible;

  /**
   * 伴星**主动**发声的那一路：提示音、手边念想、带路旁白，以及 success 这一记音效。
   * 它们不是用户要的回答，所以进任务页、窗口被盖住都得收声——用户在读东西或已经
   * 走开了，房间不该替他制造动静。
   */
  const proactiveAudible = shouldPlayHomeV2Feedback({
    unlocked,
    masterMuted,
    surfaceOpen: false,
    windowVisible: windowState === "visible" && !document.hidden,
  });
  const proactiveAudibleRef = useRef(false);

  /**
   * 用户亲口问出来的那条回复走第三条闸门：只看解锁与总静音，**不看可见性**
   * （2026-10-09）。窗口被别的程序整块盖住时 Chromium 报 `document.hidden`，旧口径
   * 把它当成"别说了"，当场挂起 AudioContext——话念到一半就断。屏幕在不在前面
   * 不改变这句话还该不该说完。
   *
   * 它与 §2026-09-16 裁决 3 是同一条线："按页静音只抑制主动输出、不阻断用户主动
   * 触发的互动"；看不见同样只该抑制主动输出。
   */
  const replyAudible = shouldPlayCompanionReplyVoice({ unlocked, masterMuted });
  const replyAudibleRef = useRef(false);
  /**
   * 正在播的那一段的**音频时钟读数**（方案 29 §14.11 修复 ⑤）。
   *
   * 字幕要的是"现在念到哪了"，而这个问题的唯一正确答案在音频时钟里
   * （`AudioContext.currentTime`）——不是 rAF 采样的最后值：窗口不可见/被遮挡时
   * rAF 会被节流甚至停住，采样值冻住而声音照走，字幕立刻与声音脱开。
   */
  const activePlaybackRef = useRef<{ context: AudioContext; startedAt: number; duration: number } | null>(null);
  proactiveAudibleRef.current = proactiveAudible;
  replyAudibleRef.current = replyAudible;

  /**
   * 取出音频图；没有就**当场建一个**。
   *
   * 为什么不能只报「语音通道还没准备好」了事：建图只在第一次 pointerdown/keydown
   * 时做一次，那一次若因为任何原因失败（AudioContext 不可用、采样资源缺失），
   * `graphRef` 就永远是 null，此后**每一次**朗读都在本地抛错——一个请求都发不出去，
   * 而用户只看到「语音合成失败」。这里按需重建，把"一次失败"降级成"一次重试"。
   */
  const ensureGraph = useCallback((): HomeV2AudioGraph => {
    const existing = graphRef.current;
    if (existing) return existing;
    const built = buildAudioGraph();
    graphRef.current = built;
    void built.context.resume().catch(() => undefined);
    setUnlocked(true);
    return built;
  }, []);

  // A confirmed update is an expected startup message. Reopen the existing
  // local audio channel for it while respecting mute and window visibility.
  useEffect(() => {
    if (!installedUpdateVersion || masterMuted || windowState !== "visible" || document.hidden) return;
    const graph = ensureGraph();
    void graph.context.resume().then(() => {
      if (graphRef.current === graph && graph.context.state === "running") setUnlocked(true);
    }).catch(() => undefined);
  }, [installedUpdateVersion, masterMuted, windowState, ensureGraph]);

  const synthesizeVoice = useCallback(async (text: string): Promise<AudioBuffer> => {
    const speakApi = window.astella?.companion?.voice?.speak;
    if (!speakApi) throw new Error("语音通道还没准备好");
    // 图按需建：第一次解锁失败不该让这一整轮会话都没有声音。
    const graph = ensureGraph();
    const response = await speakApi.call(window.astella.companion.voice, {
      meta: createRequestMeta(workspaceEpochRef.current ?? undefined),
      request: { version: 1, text },
    });
    return decodeBase64Audio(graph.context, unwrapGatewayResult(response).audioBase64);
  }, [ensureGraph]);

  const synthesizeVoiceSegment = useCallback(async (request: CompanionVoiceSpeakSegmentRequestV2): Promise<AudioBuffer> => {
    const speakApi = window.astella?.companion?.voice?.speakSegment;
    if (!speakApi) throw new Error("语音通道还没准备好");
    const graph = ensureGraph();
    const response = await speakApi.call(window.astella.companion.voice, {
      meta: createRequestMeta(workspaceEpochRef.current ?? undefined),
      request,
    });
    const result = unwrapGatewayResult(response);
    window.dispatchEvent(new Event("astella:companion-audio-cache-changed"));
    return decodeBase64Audio(graph.context, result.audioBase64);
  }, [ensureGraph]);

  const readCachedVoiceSegment = useCallback(async (request: CompanionCachedVoiceReadRequestV1): Promise<AudioBuffer> => {
    const readApi = window.astella?.companion?.voice?.cachedRead;
    if (!readApi) throw new CompanionCachedAudioError("本机音频读取通道还没准备好。");
    const graph = ensureGraph();
    const epoch = workspaceEpochRef.current;
    const result = unwrapGatewayResult(await readApi({ meta: createRequestMeta(epoch ?? undefined), request }));
    if (workspaceEpochRef.current !== epoch) throw new Error("学习空间已切换。");
    if (!result) throw new CompanionCachedAudioError("这条消息的本机音频已清理或损坏。");
    const buffer = await decodeBase64Audio(graph.context, result.audioBase64);
    if (workspaceEpochRef.current !== epoch) throw new Error("学习空间已切换。");
    return buffer;
  }, [ensureGraph]);

  const synthesizeNotification = useCallback(async (text: string, clip?: CompanionNotificationAudio, purpose: NotificationVoicePurpose = "notification"): Promise<AudioBuffer> => {
    const graph = ensureGraph();
    if (clip) {
      const cached = notificationAudioCache.current.get(clip);
      if (cached) return cached;
      const pending = fetch(new URL(`/assets/companion-notifications/${clip}.mp3`, window.location.href))
        .then(async response => {
          if (!response.ok) throw new Error("notification audio unavailable");
          return graph.context.decodeAudioData(await response.arrayBuffer());
        });
      notificationAudioCache.current.set(clip, pending);
      void pending.catch(() => notificationAudioCache.current.delete(clip));
      return pending;
    }
    const speakApi = window.astella?.companion?.voice?.speak;
    if (!speakApi) throw new Error("notification voice unavailable");
    const response = await speakApi.call(window.astella.companion.voice, {
      meta: createRequestMeta(workspaceEpochRef.current ?? undefined),
      request: { version: 1, text, purpose },
    });
    return decodeBase64Audio(graph.context, unwrapGatewayResult(response).audioBase64);
  }, [ensureGraph]);

  /**
   * 一段音频的结局上报（0247）。不 await、不 unwrap、不抛——**上报反噬朗读**是
   * 比"少一行统计"严重得多的失败，所以这里把所有异常咽掉。
   */
  const reportSegmentOutcome = useCallback((request: CompanionVoicePlaybackOutcomeRequestV1): void => {
    const reportApi = window.astella?.companion?.voice?.reportPlaybackOutcome;
    if (!reportApi) return;
    void reportApi.call(window.astella.companion.voice, {
      meta: createRequestMeta(workspaceEpochRef.current ?? undefined),
      request,
    }).catch(() => undefined);
  }, []);

  /**
   * 此刻的播放位置 0..1；没有在播返回 null。
   *
   * 从音频时钟现算（不是缓存上一次 rAF 的值）：这是"字幕跟着声音走"的唯一可靠来源。
   */
  const voiceProgress = useCallback((): number | null => {
    const active = activePlaybackRef.current;
    if (!active || !(active.duration > 0)) return null;
    const elapsed = active.context.currentTime - active.startedAt;
    if (!Number.isFinite(elapsed)) return null;
    return Math.min(1, Math.max(0, elapsed / active.duration));
  }, []);

  // 把音频出口交给伴星台词播放服务：它只管排队与计时，解码、播放、振幅仍在这里，
  // 全应用因此只有一个 AudioContext 和一条嘴型通道。
  useEffect(() => {
    setCompanionVoiceHost({
      audible: () => replyAudibleRef.current && !isCompanionReplyBlockedByMicrophone(),
      synthesize: synthesizeVoice,
      synthesizeSegment: synthesizeVoiceSegment,
      readCachedSegment: readCachedVoiceSegment,
      play: playVoiceBuffer,
      progress: voiceProgress,
      stop: stopVoicePlayback,
      reportSegmentOutcome,
    });
    return () => setCompanionVoiceHost(null);
  }, [playVoiceBuffer, stopVoicePlayback, synthesizeVoice, synthesizeVoiceSegment, readCachedVoiceSegment, reportSegmentOutcome, voiceProgress]);

  useEffect(() => {
    setCompanionNotificationVoiceHost({
      available: () => proactiveAudibleRef.current && !isCompanionSpeechActive() && !isCompanionMicrophoneActive(),
      synthesize: synthesizeNotification,
      // 提示音自己那道路仍看可见性；播没播响这里不关心，它按自己的 phase 收尾。
      play: async (buffer, allowed, offset) => {
        await playVoiceBuffer(buffer, () => undefined, () => proactiveAudibleRef.current && allowed(), offset);
      },
      progress: voiceProgress,
      stop: stopVoicePlayback,
    });
    return () => setCompanionNotificationVoiceHost(null);
  }, [playVoiceBuffer, stopVoicePlayback, synthesizeNotification, voiceProgress]);

  useEffect(() => subscribeCompanionAudioPriority(() => {
    if (!isCompanionMicrophoneActive()) return;
    // Recording also invalidates a touch/cue request that has not finished decoding.
    voiceRequestGenerationRef.current++;
    // 会话开麦可以保留正在念的回复，但手边念想等背景声音必须让路。
    if (isCompanionReplyBlockedByMicrophone() || !isCompanionSpeechActive()) stopVoicePlayback();
  }), [stopVoicePlayback]);

  /**
   * 通道开关：分两层，**别把"听不见"当成"别说"**。
   *
   * - 静音或没解锁：整条音频通道关掉，挂起 AudioContext，正在念的和在路上的都作废。
   * - 只是窗口被盖住：收掉伴星**主动**那点动静（提示音、念想、带路旁白），正在念的
   *   回复继续念完。旧口径把这两层合成一条，失焦那一刻声音当场断掉。
   *
   * 这里以前还负责把环境床的增益 ramp 上去——那一层删掉之后，这一段只剩"该不该
   * 有声音"。房间自己那点瞬态音由各自的入口现查 `audibleRef`，不在这里改运行期参数。
   */
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    // 带路的旁白暂停时要留着位置等回来看，不能被"收声"顺手取消（两条出口同一判据）。
    const mayReleaseProactiveSpeech = useRoomStore.getState().windowState === "visible"
      || !isPausedCompanionGuidanceSpeech();
    if (!replyAudible) {
      voiceRequestGenerationRef.current += 1;
      if (mayReleaseProactiveSpeech) stopCompanionNotificationSpeech();
      stopVoicePlayback();
      void graph.context.suspend().catch(() => undefined);
      return;
    }
    if (!proactiveAudible) {
      voiceRequestGenerationRef.current += 1;
      if (mayReleaseProactiveSpeech) stopCompanionNotificationSpeech();
    }
    void graph.context.resume().catch(() => undefined);
  }, [stopVoicePlayback, replyAudible, proactiveAudible]);

  useEffect(() => {
    const play = (event: Event) => {
      const kind = (event as CustomEvent<{ kind?: HomeV2SoundKind }>).detail?.kind;
      const graph = graphRef.current;
      const allowed = kind === "success" ? proactiveAudibleRef.current : audibleRef.current;
      if (!graph || !allowed || !kind) return;
      playTransient(graph, kind);
    };
    window.addEventListener("astella:home-v2-sound", play);
    return () => window.removeEventListener("astella:home-v2-sound", play);
  }, []);

  useEffect(() => {
    const speak = (event: Event) => {
      const detail = (event as CustomEvent<Partial<HomeV2VoiceRequest>>).detail;
      const text = typeof detail?.text === "string" ? detail.text.trim() : "";
      const graph = graphRef.current;
      const tuning = HOME_V2_AUDIO_TUNING.voice;
      if (!text || !graph || !audibleRef.current) return;
      // A voice cue is a progressive enhancement, never a queue: a newer line
      // replaces the one being spoken instead of stacking behind it.
      const now = Date.now();
      if (voiceFailureAtRef.current && now - voiceFailureAtRef.current < tuning.failureBackoffMs) return;
      const previous = lastVoiceRef.current;
      if (previous.text === text && now - previous.at < tuning.cooldownMs) return;
      // 回复朗读优先（2026-09-19）：用户主动问出来的那条回复是他要的反馈，提示音是背景。
      // 背景抢掉正在念的回复，听感上就是"气泡回来了却没发音"——所以正在念的时候，
      // 这次提示音直接丢弃（不排队、也不打断），连请求都不发。
      if (isCompanionSpeechActive() || isCompanionNotificationSpeechActive() || isCompanionMicrophoneActive()) return;
      const requestGeneration = ++voiceRequestGenerationRef.current;
      // 提示音和对话台词共用同一路音频：没有回复在念时，提示音先到就先占住。
      stopVoicePlayback();
      stopCompanionSpeech();
      lastVoiceRef.current = { text, at: now };

      const speakApi = window.astella?.companion?.voice?.speak;
      if (!speakApi) return;
      void speakApi.call(window.astella.companion.voice, {
        meta: createRequestMeta(workspaceEpochRef.current ?? undefined),
        // thought：这一句会留在本机，手记里回读同一句时不再重新合成。
        request: { version: 1, text, purpose: "thought" },
      })
        .then(async (response) => {
          if (requestGeneration !== voiceRequestGenerationRef.current) return;
          const result = unwrapGatewayResult(response);
          const active = graphRef.current;
          if (!active || !audibleRef.current || graphRef.current !== active) return;
          const buffer = await decodeBase64Audio(active.context, result.audioBase64);
          if (
            requestGeneration !== voiceRequestGenerationRef.current
            || graphRef.current !== active
            || !audibleRef.current
            || isCompanionSpeechActive() || isCompanionNotificationSpeechActive() || isCompanionMicrophoneActive()
          ) return;
          await playVoiceBuffer(buffer, () => undefined, () => audibleRef.current
            && requestGeneration === voiceRequestGenerationRef.current
            && !isCompanionSpeechActive() && !isCompanionNotificationSpeechActive() && !isCompanionMicrophoneActive());
        })
        .catch((error: unknown) => {
          if (requestGeneration !== voiceRequestGenerationRef.current) return;
          // Speech is optional: a missing engine, an expired session or a
          // rejected contract must leave the room silent and fully usable.
          voiceFailureAtRef.current = Date.now();
          void gatewayErrorMessage(error);
          setHomeV2VoiceLevel(0);
        });
    };

    window.addEventListener("astella:home-v2-speak", speak);
    return () => {
      window.removeEventListener("astella:home-v2-speak", speak);
      voiceRequestGenerationRef.current += 1;
      stopVoicePlayback();
    };
  }, [playVoiceBuffer, stopVoicePlayback]);

  return null;
}
