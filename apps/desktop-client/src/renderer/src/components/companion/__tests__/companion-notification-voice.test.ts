import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCompanionReplyBlockedByMicrophone, holdCompanionMicrophone, isCompanionNotificationSpeechActive, setCompanionNotificationVoiceHost, speakCompanionNotification, stopCompanionNotificationSpeech, pauseCompanionNotificationSpeech, resumeCompanionNotificationSpeech, type NotificationVoiceHost } from "../companion-notification-voice";
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
  it("pauses and resumes the same decoded narration at its audio position, including a quick reversal", async () => {
    const report = vi.fn(); let finish!: () => void;
    host.progress = () => .4;
    host.play = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    host.stop = vi.fn(() => finish());
    const pending = run({ id: "film", purpose: "guidance", report });
    await Promise.resolve(); await Promise.resolve();
    pauseCompanionNotificationSpeech("film"); resumeCompanionNotificationSpeech("film");
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(host.synthesize).toHaveBeenCalledOnce();
    expect(host.play).toHaveBeenCalledTimes(2);
    expect(vi.mocked(host.play).mock.calls[1]?.[2]).toBeCloseTo(buffer.duration * .4);
    finish(); await pending; expect(report).toHaveBeenLastCalledWith("finished");
  });
  it("cancels a paused pending narration without leaving its wait or channel behind", async () => {
    let finish!: () => void;
    host.play = vi.fn(() => new Promise<void>(resolve => { finish = resolve; })); host.stop = vi.fn(() => finish());
    const pending = run({ id: "film", purpose: "guidance" });
    await Promise.resolve(); await Promise.resolve(); pauseCompanionNotificationSpeech("film");
    await Promise.resolve(); await Promise.resolve(); stopCompanionNotificationSpeech("film");
    await pending; expect(isCompanionNotificationSpeechActive()).toBe(false);
    resumeCompanionNotificationSpeech("film"); expect(host.play).toHaveBeenCalledOnce();
  });
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
  it("会话占用只压住背景播报，不把用户等的回复变成静音", async () => {
    const release = holdCompanionMicrophone("conversation");
    try {
      expect(isCompanionReplyBlockedByMicrophone()).toBe(false);
      await run();
      expect(host.synthesize).not.toHaveBeenCalled();
      const releaseRecording = holdCompanionMicrophone();
      expect(isCompanionReplyBlockedByMicrophone()).toBe(true);
      releaseRecording();
      expect(isCompanionReplyBlockedByMicrophone()).toBe(false);
    } finally { release(); }
    await run();
    expect(host.play).toHaveBeenCalledOnce();
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
  it("reports missing AI consent separately and releases the channel without playing", async () => {
    host.synthesize = vi.fn().mockRejectedValue(Object.assign(new Error("consent required"), { code: "ai_consent_required" }));
    const report = vi.fn(); await run({ purpose: "guidance", report });
    expect(report).toHaveBeenLastCalledWith("consent_required");
    expect(host.play).not.toHaveBeenCalled();
    expect(isCompanionNotificationSpeechActive()).toBe(false);
  });

  it("念想整条念出来：超过单次请求上限的那一句是切成几句念，不是被截掉", async () => {
    const long = "这一句先说书房里的那条线。" + "第二句接着说它断在哪儿，以及为什么要从五分钟接上。".repeat(6) + "最后收一句不留标点的尾巴";
    await run({ text: long, purpose: "thought" });
    const calls = (host.synthesize as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    // 一个字都不丢：拼回去必须还是原文（trim 后），这是"不设朗读上限"的全部含义。
    expect(calls.map(call => String(call[0])).join("")).toBe(long.trim());
    expect(calls.every(call => call[1] === undefined)).toBe(true);
    expect(calls.every(call => call[2] === "thought")).toBe(true);
    expect(host.play).toHaveBeenCalledTimes(calls.length);
  });

  it("固定提示音仍是一条预制音频，不因为分段被念成两截", async () => {
    await run({ text: "今天有学过的知识到了复习时间。方便的时候，和我一起温习一下吧。", clip: "review-due", purpose: "notification" });
    expect(host.synthesize).toHaveBeenCalledOnce();
    expect(host.play).toHaveBeenCalledOnce();
  });

  it("她念到一半被停掉时，后面的句子不再往外取", async () => {
    let release: ((buffer: AudioBuffer) => void) | undefined;
    host.synthesize = vi.fn(() => new Promise<AudioBuffer>(done => { release = done; }));
    const pending = run({ text: "第一句讲完了。第二句还排在后面。", purpose: "thought" });
    await Promise.resolve();
    release!(buffer);
    await Promise.resolve();
    stopCompanionNotificationSpeech("notice");
    await pending;
    expect((host.synthesize as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
