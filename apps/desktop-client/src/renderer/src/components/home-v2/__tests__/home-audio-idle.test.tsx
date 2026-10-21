// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, type Mock, type MockInstance } from "vitest";

vi.mock("../../../app/home/home-projection", () => ({ useHomeProjectionInvalidation: () => ({ workspaceEpoch: 1 }) }));
vi.mock("../../../app/companion-session/companion-voice-playback", () => ({
  isCompanionSpeechActive: vi.fn(() => false),
  setCompanionVoiceHost: vi.fn(),
  stopCompanionSpeech: vi.fn(),
}));
vi.mock("../../../app/companion-session/companion-voice-stream-playback", () => ({
  hasStreamingSegmentChannel: vi.fn(() => false),
  playSegmentFromStream: vi.fn(),
}));

import { HomeV2AudioController, COMPANION_VOICE_STREAM_SEGMENTS } from "../HomeV2AudioController";
import { isCompanionSpeechActive, setCompanionVoiceHost } from "../../../app/companion-session/companion-voice-playback";
import { hasStreamingSegmentChannel, playSegmentFromStream } from "../../../app/companion-session/companion-voice-stream-playback";
import { resetHomeV2VoiceLevel, subscribeHomeV2VoiceLevel } from "../../../app/companion-session/companion-voice-level";
import { useRoomStore } from "../../../app/home/room-store";
import { UNKNOWN_UPDATE_STATE, useUpdateStatus } from "../../../app/gate/update-status";
import { holdCompanionMicrophone } from "../../companion/voice/companion-notification-voice";

let warm: () => void;
let construct: Mock<() => void>;
let suspend: Mock<() => Promise<void>>;
let resume: Mock<() => Promise<void>>;
let close: Mock<() => Promise<void>>;
let listeners: MockInstance<typeof window.addEventListener>;
/** 每个被 start() 的节点；空数组 = 这一轮没有任何音源自己跑起来。 */
let started: string[];
let analysers: Array<{ connect: Mock; disconnect: Mock; getFloatTimeDomainData: Mock }>;
let destinationNode: unknown;
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;

beforeEach(() => {
  vi.mocked(isCompanionSpeechActive).mockReturnValue(false);
  construct = vi.fn();
  suspend = vi.fn(async () => undefined);
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  started = [];
  analysers = [];
  frames = new Map();
  nextFrameId = 1;
  resetHomeV2VoiceLevel();
  listeners = vi.spyOn(window, "addEventListener");
  vi.stubGlobal("requestIdleCallback", vi.fn((callback: () => void) => { warm = callback; return 1; }));
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  const node = (kind: string) => ({
    connect: vi.fn(function (this: unknown) { return this; }),
    disconnect: vi.fn(),
    start: vi.fn(() => { started.push(kind); }),
    stop: vi.fn(),
    gain: { value: 0, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    frequency: { value: 0 }, Q: { value: 0 },
  });
  vi.stubGlobal("AudioContext", class {
    state = "running";
    sampleRate = 16;
    currentTime = 0;
    destination = (destinationNode = node("destination")) as unknown as AudioNode;
    suspend = suspend;
    resume = resume;
    close = close;
    constructor() { construct(); }
    createBuffer() { return { getChannelData: () => new Float32Array(16) }; }
    createBufferSource = () => node("bufferSource");
    createBiquadFilter = () => node("biquadFilter");
    createGain = () => node("gain");
    createAnalyser = () => {
      const analyserNode = {
        ...node("analyser"), fftSize: 32, smoothingTimeConstant: 0,
        getFloatTimeDomainData: vi.fn((samples: Float32Array) => samples.fill(0.1)),
      };
      analysers.push(analyserNode);
      return analyserNode;
    };
    createOscillator = () => node("oscillator");
    decodeAudioData = vi.fn(async () => ({ duration: 1 } as AudioBuffer));
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => { frames.delete(id); }));
  vi.mocked(hasStreamingSegmentChannel).mockReturnValue(false);
  vi.mocked(playSegmentFromStream).mockReset();
  useRoomStore.setState({ masterMuted: false, surface: null, windowState: "visible" });
  useUpdateStatus.setState({ state: UNKNOWN_UPDATE_STATE });
});
afterEach(() => { cleanup(); resetHomeV2VoiceLevel(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function interact(trusted = true) {
  const handler = listeners.mock.calls.find(([type]) => type === "pointerdown")?.[1];
  expect(handler).toBeTypeOf("function");
  (handler as (event: Event) => void)({ isTrusted: trusted } as Event);
}
const audible = () => vi.mocked(setCompanionVoiceHost).mock.calls.at(-1)?.[0]?.audible();

it("confirmed update startup opens the local voice channel without another click", async () => {
  useUpdateStatus.setState({ state: { ...UNKNOWN_UPDATE_STATE, currentVersion: "1.3.3", installedUpdate: { fromVersion: "1.3.2", version: "1.3.3" } } });
  render(<HomeV2AudioController />);
  await act(async () => { warm(); });
  expect(resume).toHaveBeenCalled();
  expect(audible()).toBe(true);
  expect(started).toEqual([]);
});

it.each([{ masterMuted: true, windowState: "visible" as const }, { masterMuted: false, windowState: "hidden" as const }])("update startup respects mute and hidden windows: %j", async patch => {
  useRoomStore.setState(patch);
  useUpdateStatus.setState({ state: { ...UNKNOWN_UPDATE_STATE, currentVersion: "1.3.3", installedUpdate: { fromVersion: "1.3.2", version: "1.3.3" } } });
  render(<HomeV2AudioController />);
  await act(async () => { warm(); });
  expect(resume).not.toHaveBeenCalled();
  expect(audible()).toBe(false);
  expect(started).toEqual([]);
});

it("prepares foreground startup speech in idle time without a gesture or starting any source", async () => {
  const view = render(<HomeV2AudioController />);
  expect(construct).not.toHaveBeenCalled();
  await act(async () => { warm(); });
  expect(construct).toHaveBeenCalledTimes(1);
  expect(suspend).not.toHaveBeenCalled();
  expect(audible()).toBe(true);
  expect(started).toEqual([]);
  await act(async () => { interact(); });
  expect(construct).toHaveBeenCalledTimes(1);
  expect(resume).toHaveBeenCalled();
  expect(audible()).toBe(true);
  view.unmount();
  expect(close).toHaveBeenCalledTimes(1);
});

it.each([false, true])("plays a server-issued startup greeting without a gesture (idle prepared: %s)", async prepared => {
  const speakSegment = vi.fn(async () => ({ version: 1, ok: true, data: { audioBase64: "AA==" } }));
  Object.defineProperty(window, "astella", { configurable: true, value: { companion: { voice: { speakSegment } } } });
  const playback = await vi.importActual<typeof import("../../../app/companion-session/companion-voice-playback")>("../../../app/companion-session/companion-voice-playback");
  const view = render(<HomeV2AudioController />);
  try {
    if (prepared) await act(async () => { warm(); });
    else expect(construct).not.toHaveBeenCalled();
    const host = vi.mocked(setCompanionVoiceHost).mock.calls.at(-1)![0]!;
    playback.setCompanionVoiceHost(host);
    await act(async () => {
      const speech = playback.beginCompanionSpeechLine({ strictSegments: true });
      expect(speech.mode).toBe("voice");
      speech.feedSegment({ ref: { version: 2, conversationId: "00000000-0000-4000-8000-000000000001",
        runId: "00000000-0000-4000-8000-000000000002", generation: 1, ordinal: 1, segmentId: "a".repeat(64) },
        displayText: "晚上好。", displayStart: 0, displayEnd: 4,
        cue: { version: 1, intent: "explain", emotion: "neutral", intensity: 0.3 } });
      speech.finish();
      // Drain synthesis, decoding and the playback queue without a click/key.
      for (let index = 0; index < 30; index++) await Promise.resolve();
    });
    expect(speakSegment).toHaveBeenCalledOnce();
    expect(construct).toHaveBeenCalledTimes(1);
    expect(started).toEqual(["bufferSource"]);
    await act(async () => { useRoomStore.setState({ masterMuted: true }); });
    expect(audible()).toBe(false);
    expect(playback.isCompanionSpeechActive()).toBe(false);
  } finally {
    playback.resetCompanionVoicePlayback();
    view.unmount();
    Reflect.deleteProperty(window, "astella");
  }
});

it.each([{ masterMuted: true, windowState: "visible" as const }, { masterMuted: false, windowState: "hidden" as const }])("ordinary startup respects mute and background state: %j", async patch => {
  useRoomStore.setState(patch);
  render(<HomeV2AudioController />);
  expect(audible()).toBe(false);
  await act(async () => { warm(); });
  expect(resume).not.toHaveBeenCalled();
  expect(audible()).toBe(false);
  expect(started).toEqual([]);
  await act(async () => { useRoomStore.setState({ masterMuted: false, windowState: "visible" }); });
  expect(audible()).toBe(true);
  expect(resume).toHaveBeenCalled();
  expect(started).toEqual([]);
});

it("窗口被盖住不再挂起音频通道：这一轮朗读照旧，看不见的只是房间", async () => {
  const view = render(<HomeV2AudioController />);
  await act(async () => { warm(); interact(); });
  expect(audible()).toBe(true);
  suspend.mockClear();
  // 焦点不参与（方案 35 E7）；被整块盖住时 Chromium 报的就是 document.hidden。
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  try {
    await act(async () => { useRoomStore.setState({ windowState: "hidden" }); });
    expect(suspend).not.toHaveBeenCalled();
    expect(audible()).toBe(true);
  } finally {
    delete (document as Partial<{ hidden: unknown }>).hidden;
  }
  view.unmount();
});

it("实时会话开麦后回复仍能真正启动音源，单段录音仍会挡住并打断播放", async () => {
  const view = render(<HomeV2AudioController />);
  await act(async () => { warm(); interact(); });
  const voiceHost = vi.mocked(setCompanionVoiceHost).mock.calls.at(-1)![0]!;
  let finished = false;
  const playing = voiceHost.play({ duration: 1 } as AudioBuffer, () => undefined).then(() => { finished = true; });
  await act(async () => { await Promise.resolve(); });
  expect(started).toEqual(["bufferSource"]);
  vi.mocked(isCompanionSpeechActive).mockReturnValue(true);
  const releaseConversation = holdCompanionMicrophone("conversation");
  expect(audible()).toBe(true);
  await Promise.resolve();
  expect(finished).toBe(false);
  const releaseRecording = holdCompanionMicrophone();
  expect(audible()).toBe(false);
  await playing;
  await voiceHost.play({ duration: 1 } as AudioBuffer, () => undefined);
  expect(started).toHaveLength(1);
  releaseConversation();
  expect(audible()).toBe(false);
  releaseRecording();
  expect(audible()).toBe(true);
  view.unmount();
});

// Streaming is deliberately off by default since 2026-10-21 (it stalled after a
// few characters in real windows). The wiring below still has to be correct for
// when the flag is turned back on, so this case only runs with the flag enabled.
it.skipIf(!COMPANION_VOICE_STREAM_SEGMENTS)("流式伴星语音经过输出分析器并驱动 Live2D 共用嘴型振幅", async () => {
  vi.mocked(hasStreamingSegmentChannel).mockReturnValue(true);
  let finishStream!: (played: boolean) => void;
  vi.mocked(playSegmentFromStream).mockImplementation(async args => {
    args.registerStop?.(() => undefined);
    args.registerProgress?.(() => 0.25);
    return new Promise<boolean>(resolve => { finishStream = resolve; });
  });

  const view = render(<HomeV2AudioController />);
  await act(async () => { warm(); interact(); });
  const voiceHost = vi.mocked(setCompanionVoiceHost).mock.calls.at(-1)![0]!;
  const levels: number[] = [];
  const unsubscribe = subscribeHomeV2VoiceLevel(level => levels.push(level));
  const request = {
    version: 2 as const,
    conversationId: "00000000-0000-4000-8000-000000000001",
    runId: "00000000-0000-4000-8000-000000000002",
    generation: 1,
    ordinal: 1,
    segmentId: "a".repeat(64),
  };
  let playing!: Promise<boolean>;
  await act(async () => {
    playing = voiceHost.playSegmentStream!(request, () => undefined);
    await Promise.resolve();
  });

  expect(playSegmentFromStream).toHaveBeenCalledOnce();
  expect(vi.mocked(playSegmentFromStream).mock.calls[0]![0].destination).toBe(analysers[0]);
  expect(analysers[0]!.connect).toHaveBeenCalledWith(destinationNode);
  const [frameId, sample] = [...frames.entries()][0]!;
  frames.delete(frameId);
  await act(async () => { sample(performance.now() + 100); });
  expect(levels.some(level => level > 0.1)).toBe(true);

  await act(async () => { finishStream(true); await playing; });
  expect(analysers[0]!.disconnect).toHaveBeenCalledOnce();
  unsubscribe();
  view.unmount();
});

it("an early click never creates AudioContext in the input handler", async () => {
  render(<HomeV2AudioController />);
  await act(async () => { interact(); });
  expect(construct).not.toHaveBeenCalled();
  expect(window.requestIdleCallback).toHaveBeenCalledTimes(1);
  await act(async () => { warm(); });
  expect(construct).toHaveBeenCalledTimes(1);
  expect(audible()).toBe(true);
});

it("untrusted events cannot unlock sound and unmount cancels unfinished warmup", async () => {
  useRoomStore.setState({ windowState: "hidden" });
  const view = render(<HomeV2AudioController />);
  await act(async () => { interact(false); });
  expect(audible()).toBe(false);
  view.unmount();
  expect(window.cancelIdleCallback).toHaveBeenCalledWith(1);
  warm();
  expect(construct).not.toHaveBeenCalled();
});

/**
 * 没有任何音源自己跑起来——包括解锁之后。
 *
 * 上一版首页有一层噪声环境床：建图时就把 `noise` 和 `gust` 两个节点 `start()` 了，
 * 第一次可信点击再把增益 ramp 到 0.03，于是"打开 app 之后一直有底噪"，用户只
 * 能用总静音把伴星语音一起关掉才舒服。2026-10-06 那一层删掉了。
 *
 * 这条守的是**形状**而不是某一行代码：任何人重新往建图里塞一个 `start()`，
 * 这里就会红。
 */
it("unlocking the room starts no source node at all", async () => {
  render(<HomeV2AudioController />);
  await act(async () => { warm(); });
  expect(started).toEqual([]);
  await act(async () => { interact(); });
  expect(audible()).toBe(true);
  expect(resume).toHaveBeenCalled();
  expect(started).toEqual([]);
});

it("【自证】判据认得出「建图时就把床启动起来」这个真实退化", async () => {
  render(<HomeV2AudioController />);
  await act(async () => { warm(); });
  // 把删掉之前那一版的退化形状手动跑一遍：上面那条守的不是"没有这行代码"，
  // 而是"没有任何节点被 start"——只有真的能看见 start，判据才算数。
  const source = new AudioContext().createBufferSource();
  source.start();
  expect(started).toEqual(["bufferSource"]);
});
