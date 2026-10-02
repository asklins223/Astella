// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, type Mock, type MockInstance } from "vitest";

vi.mock("../../../app/home-projection", () => ({ useHomeProjectionInvalidation: () => ({ workspaceEpoch: 1 }) }));
vi.mock("../../../app/companion-voice-playback", () => ({
  isCompanionSpeechActive: () => false,
  setCompanionVoiceHost: vi.fn(),
  stopCompanionSpeech: vi.fn(),
}));

import { HomeV2AudioController } from "../HomeV2AudioController";
import { setCompanionVoiceHost } from "../../../app/companion-voice-playback";
import { useRoomStore } from "../../../app/room-store";

let warm: () => void;
let construct: Mock<() => void>;
let suspend: Mock<() => Promise<void>>;
let resume: Mock<() => Promise<void>>;
let close: Mock<() => Promise<void>>;
let listeners: MockInstance<typeof window.addEventListener>;

beforeEach(() => {
  construct = vi.fn();
  suspend = vi.fn(async () => undefined);
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  listeners = vi.spyOn(window, "addEventListener");
  vi.stubGlobal("requestIdleCallback", vi.fn((callback: () => void) => { warm = callback; return 1; }));
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  const node = () => ({
    connect() { return this; }, start: vi.fn(), stop: vi.fn(),
    gain: { value: 0, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    frequency: { value: 0 }, Q: { value: 0 },
  });
  vi.stubGlobal("AudioContext", class {
    sampleRate = 16;
    currentTime = 0;
    destination = node();
    suspend = suspend;
    resume = resume;
    close = close;
    constructor() { construct(); }
    createBuffer() { return { getChannelData: () => new Float32Array(16) }; }
    createBufferSource = node;
    createBiquadFilter = node;
    createGain = node;
    createOscillator = node;
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
