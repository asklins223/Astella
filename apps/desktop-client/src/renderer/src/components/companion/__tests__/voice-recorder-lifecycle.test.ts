// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanionVoiceRecorder } from "../voice-recorder";

let getUserMedia: ReturnType<typeof vi.fn>;
let track: { stop: ReturnType<typeof vi.fn>; onended: (() => void) | null };
let stream: MediaStream;
let resume: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
beforeEach(() => {
  track = { stop: vi.fn(), onended: null };
  stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  resume = vi.fn().mockResolvedValue(undefined); close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("AudioContext", class {
    sampleRate = 16000;
    destination = {};
    resume = resume; close = close;
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createScriptProcessor() { return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }; }
  });
  vi.stubGlobal("URL", { createObjectURL: () => "blob:recorder", revokeObjectURL: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("权限结果迟到时，已取消的录音器交还设备且不建音频图", async () => {
  let allow!: (stream: MediaStream) => void;
  getUserMedia.mockImplementation(() => new Promise(resolve => { allow = resolve; }));
  const recorder = new CompanionVoiceRecorder();
  const starting = recorder.start();
  await recorder.stop();
  allow(stream); await starting;
  expect(track.stop).toHaveBeenCalledOnce();
  expect(resume).not.toHaveBeenCalled();
  expect(recorder.active).toBe(false);
});
it("拿到设备后建图失败也会关闭设备，不要求已进入 recording", async () => {
  resume.mockRejectedValue(new Error("声卡失联"));
  const recorder = new CompanionVoiceRecorder();
  await expect(recorder.start()).rejects.toThrow("声卡失联");
  expect(track.stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(recorder.active).toBe(false);
});
it("麦克风被拔掉会通知会话，主动关闭不会制造错误", async () => {
  const onError = vi.fn();
  const recorder = new CompanionVoiceRecorder({ onError });
  await recorder.start();
  expect(recorder.active).toBe(true);
  track.onended?.();
  expect(recorder.active).toBe(false);
  expect(onError).toHaveBeenCalledOnce();
  await recorder.stop();
  expect(track.onended).toBeNull();
});
