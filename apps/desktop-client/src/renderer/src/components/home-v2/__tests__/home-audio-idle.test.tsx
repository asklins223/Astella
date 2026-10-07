// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, type Mock, type MockInstance } from "vitest";

vi.mock("../../../app/home-projection", () => ({ useHomeProjectionInvalidation: () => ({ workspaceEpoch: 1 }) }));
vi.mock("../../../app/companion-voice-playback", () => ({
  isCompanionSpeechActive: vi.fn(() => false),
  setCompanionVoiceHost: vi.fn(),
  stopCompanionSpeech: vi.fn(),
}));

import { HomeV2AudioController } from "../HomeV2AudioController";
import { isCompanionSpeechActive, setCompanionVoiceHost } from "../../../app/companion-voice-playback";
import { useRoomStore } from "../../../app/room-store";
import { holdCompanionMicrophone } from "../../companion/companion-notification-voice";

let warm: () => void;
let construct: Mock<() => void>;
let suspend: Mock<() => Promise<void>>;
let resume: Mock<() => Promise<void>>;
let close: Mock<() => Promise<void>>;
let listeners: MockInstance<typeof window.addEventListener>;
/** 每个被 start() 的节点；空数组 = 这一轮没有任何音源自己跑起来。 */
let started: string[];

beforeEach(() => {
  vi.mocked(isCompanionSpeechActive).mockReturnValue(false);
  construct = vi.fn();
  suspend = vi.fn(async () => undefined);
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  started = [];
  listeners = vi.spyOn(window, "addEventListener");
  vi.stubGlobal("requestIdleCallback", vi.fn((callback: () => void) => { warm = callback; return 1; }));
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  const node = (kind: string) => ({
    connect() { return this; },
    disconnect: vi.fn(),
    start: vi.fn(() => { started.push(kind); }),
    stop: vi.fn(),
    gain: { value: 0, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    frequency: { value: 0 }, Q: { value: 0 },
  });
  vi.stubGlobal("AudioContext", class {
    sampleRate = 16;
    currentTime = 0;
    destination = node("destination");
    suspend = suspend;
    resume = resume;
    close = close;
    constructor() { construct(); }
    createBuffer() { return { getChannelData: () => new Float32Array(16) }; }
    createBufferSource = () => node("bufferSource");
    createBiquadFilter = () => node("biquadFilter");
    createGain = () => node("gain");
    createAnalyser = () => ({ ...node("analyser"), fftSize: 32, getFloatTimeDomainData: vi.fn() });
    createOscillator = () => node("oscillator");
  });
  useRoomStore.setState({ masterMuted: false, surface: null, windowState: "visible" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function interact(trusted = true) {
  const handler = listeners.mock.calls.find(([type]) => type === "pointerdown")?.[1];
  expect(handler).toBeTypeOf("function");
  (handler as (event: Event) => void)({ isTrusted: trusted } as Event);
}
const audible = () => vi.mocked(setCompanionVoiceHost).mock.calls.at(-1)?.[0]?.audible();

it("constructs the graph in idle time, stays silent before a gesture, and reuses it on the first click", async () => {
  const view = render(<HomeV2AudioController />);
  expect(construct).not.toHaveBeenCalled();
  await act(async () => { warm(); });
  expect(construct).toHaveBeenCalledTimes(1);
  expect(suspend).toHaveBeenCalled();
  expect(audible()).toBe(false);
  await act(async () => { interact(); });
  expect(construct).toHaveBeenCalledTimes(1);
  expect(resume).toHaveBeenCalled();
  expect(audible()).toBe(true);
  view.unmount();
  expect(close).toHaveBeenCalledTimes(1);
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
