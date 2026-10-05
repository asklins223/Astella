import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdCompanionMicrophone, isCompanionNotificationSpeechActive, setCompanionNotificationVoiceHost, speakCompanionNotification, stopCompanionNotificationSpeech, type NotificationVoiceHost } from "../companion-notification-voice";
import { beginCompanionSpeechLine, setCompanionVoiceHost } from "../../../app/companion-voice-playback";

const buffer = { duration: .1 } as AudioBuffer;
let host: { -readonly [K in keyof NotificationVoiceHost]: NotificationVoiceHost[K] };
const run = (patch: Partial<Parameters<typeof speakCompanionNotification>[0]> = {}) => speakCompanionNotification({ id: "notice", text: "模型装好了", allowed: () => true, report: vi.fn(), ...patch });
beforeEach(() => {
  host = { available: () => true, synthesize: vi.fn().mockResolvedValue(buffer), play: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
  setCompanionNotificationVoiceHost(host);
});
afterEach(() => { setCompanionNotificationVoiceHost(null); setCompanionVoiceHost(null); vi.useRealTimers(); });

describe("shared notification voice channel", () => {
  it("passes guidance purpose through the existing graph and drops an interrupted guide's late audio", async () => {
    let resolve!: (buffer: AudioBuffer) => void;
    host.synthesize = vi.fn(() => new Promise<AudioBuffer>(done => { resolve = done; }));
    const pending = run({ id: "guide", purpose: "guidance" });
    expect(host.synthesize).toHaveBeenCalledWith("模型装好了", undefined, "guidance");
    stopCompanionNotificationSpeech("guide"); resolve(buffer); await pending;
    expect(host.play).not.toHaveBeenCalled();
  });
  it("does not request audio while a reply, mute or another policy blocks it", async () => {
    await run({ allowed: () => false }); expect(host.synthesize).not.toHaveBeenCalled();
    setCompanionNotificationVoiceHost({ ...host, available: () => false }); await run(); expect(host.synthesize).not.toHaveBeenCalled();
  });
  it("drops late audio if a reply begins during synthesis", async () => {
    let resolve!: (buffer: AudioBuffer) => void;
    host.synthesize = vi.fn(() => new Promise<AudioBuffer>(done => { resolve = done; }));
    const pending = run(); expect(isCompanionNotificationSpeechActive()).toBe(true);
    beginCompanionSpeechLine(); resolve(buffer); await pending;
    expect(host.play).not.toHaveBeenCalled(); expect(host.stop).not.toHaveBeenCalled(); expect(isCompanionNotificationSpeechActive()).toBe(false);
  });
  it("lets the next reply interrupt narration immediately", async () => {
    let finish!: () => void;
    host.play = vi.fn(() => new Promise<void>(done => { finish = done; }));
    const report = vi.fn(), pending = run({ report }); await Promise.resolve(); await Promise.resolve();
    expect(report).toHaveBeenCalledWith("speaking");
    beginCompanionSpeechLine(); expect(host.stop).toHaveBeenCalledOnce(); finish(); await pending;
    expect(report).toHaveBeenLastCalledWith("silent");
  });
  it("revokes playback permission if a reply begins while the audio device resumes", async () => {
    let allowed!: () => boolean, finish!: () => void;
    host.play = vi.fn((_, canPlay) => {
      allowed = canPlay;
      return new Promise<void>(resolve => { finish = resolve; });
    });
    const pending = run(); await Promise.resolve(); await Promise.resolve();
    expect(allowed()).toBe(true);
    beginCompanionSpeechLine(); expect(allowed()).toBe(false);
    finish(); await pending;
  });
  it("microphone ownership suppresses audio and is released independently", async () => {
    const releaseA = holdCompanionMicrophone(), releaseB = holdCompanionMicrophone();
    releaseA(); await run(); expect(host.synthesize).not.toHaveBeenCalled();
    releaseB(); await run(); expect(host.play).toHaveBeenCalledOnce();
  });
  it("does not let an old stop button cut off a newer notification", async () => {
    let finish!: () => void;
    host.play = vi.fn(() => new Promise<void>(done => { finish = done; }));
    const pending = run({ id: "new" }); await Promise.resolve(); await Promise.resolve();
    stopCompanionNotificationSpeech("old"); expect(host.stop).not.toHaveBeenCalled(); finish(); await pending;
  });
  it("bounds synthesis failures and keeps the message independent of audio", async () => {
    vi.useFakeTimers(); host.synthesize = vi.fn(() => new Promise<AudioBuffer>(() => {}));
    const report = vi.fn(), pending = run({ report }); await vi.advanceTimersByTimeAsync(8_000); await pending;
    expect(report).toHaveBeenLastCalledWith("failed"); expect(isCompanionNotificationSpeechActive()).toBe(false);
  });
});
