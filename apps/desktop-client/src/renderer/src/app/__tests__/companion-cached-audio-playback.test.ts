import { afterEach, expect, it, vi } from "vitest";
import {
  playCachedCompanionMessage, resetCompanionVoicePlayback, setCompanionVoiceHost,
  stopCompanionSpeech, subscribeCompanionSpeech, type CompanionVoiceHost,
} from "../companion-voice-playback";
const runId = "11111111-1111-4111-8111-111111111111";
const clip = { duration: 1 } as AudioBuffer;
afterEach(() => resetCompanionVoicePlayback());
function host(overrides: Partial<CompanionVoiceHost> = {}): CompanionVoiceHost {
  return { audible: () => true, synthesize: vi.fn(), synthesizeSegment: vi.fn(),
    readCachedSegment: vi.fn(async () => clip), play: vi.fn(async () => true), stop: vi.fn(),
    reportSegmentOutcome: vi.fn(), ...overrides };
}

it("plays ordered original segments without synthesis or live playback reports", async () => {
  const audio = host(), phases: string[] = [];
  setCompanionVoiceHost(audio);
  subscribeCompanionSpeech(progress => phases.push(progress.phase));
  playCachedCompanionMessage(runId, [3, 1, 2, 2]);
  await vi.waitFor(() => expect(phases.at(-1)).toBe("finished"));
  expect(vi.mocked(audio.readCachedSegment!).mock.calls.map(([request]) => request.ordinal)).toEqual([1, 2, 3]);
  expect(audio.play).toHaveBeenCalledTimes(3);
  expect(audio.synthesize).not.toHaveBeenCalled();
  expect(audio.synthesizeSegment).not.toHaveBeenCalled();
  expect(audio.reportSegmentOutcome).not.toHaveBeenCalled();
});

it("a later click supersedes a pending local read and old bytes cannot reclaim playback", async () => {
  let release!: (buffer: AudioBuffer) => void;
  const old = { duration: 1, marker: "old" } as unknown as AudioBuffer;
  const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(clip);
  const audio = host({ readCachedSegment: read });
  setCompanionVoiceHost(audio);
  const first = playCachedCompanionMessage(runId, [1]);
  playCachedCompanionMessage("22222222-2222-4222-8222-222222222222", [2]);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  first.stop(); // The old button must not stop the new message.
  release(old);
  await Promise.resolve(); await Promise.resolve();
  expect(audio.play).toHaveBeenCalledOnce();
  expect(audio.play).toHaveBeenCalledWith(clip, expect.any(Function));
});

it("stops immediately during playback and never advances to another segment", async () => {
  let settle!: (heard: boolean) => void;
  const audio = host({ play: vi.fn(() => new Promise<boolean>(resolve => { settle = resolve; })), stop: vi.fn(() => settle?.(false)) });
  setCompanionVoiceHost(audio);
  const phases: string[] = [];
  subscribeCompanionSpeech(progress => phases.push(progress.phase));
  const handle = playCachedCompanionMessage(runId, [1, 2]);
  await vi.waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
  handle.stop();
  expect(phases.at(-1)).toBe("stopped");
  await Promise.resolve(); await Promise.resolve();
  expect(audio.readCachedSegment).toHaveBeenCalledOnce();
});

// 2026-10-09：宿主"没播但照样 resolve"时不能再往下走。旧形状会把剩下的 ordinal
// 一段一段安静地"放完"，最后报一次 finished。
it("宿主说这一段没响时就此收住，不放完后面的段", async () => {
  const audio = host({ play: vi.fn(async () => false) });
  setCompanionVoiceHost(audio);
  const phases: string[] = [];
  subscribeCompanionSpeech(progress => phases.push(progress.phase));
  playCachedCompanionMessage(runId, [1, 2]);
  await vi.waitFor(() => expect(phases.at(-1)).toBe("stopped"));
  expect(audio.play).toHaveBeenCalledOnce();
  expect(audio.readCachedSegment).toHaveBeenCalledOnce();
});

it("a missing recording fails locally instead of asking TTS for a replacement", async () => {
  const audio = host({ readCachedSegment: vi.fn(async () => { throw new Error("missing"); }) });
  setCompanionVoiceHost(audio);
  const phases: string[] = [];
  subscribeCompanionSpeech(progress => phases.push(progress.phase));
  playCachedCompanionMessage(runId, [1, 2]);
  await vi.waitFor(() => expect(phases.at(-1)).toBe("failed"));
  expect(audio.synthesizeSegment).not.toHaveBeenCalled();
  expect(audio.play).not.toHaveBeenCalled();
});

it("respects silent and unavailable hosts without disturbing a different active plan", () => {
  setCompanionVoiceHost(host({ audible: () => false }));
  expect(() => playCachedCompanionMessage(runId, [1])).toThrow("请先开启声音");
  stopCompanionSpeech();
  setCompanionVoiceHost(null);
  expect(() => playCachedCompanionMessage(runId, [1])).toThrow("请先开启声音");
});
