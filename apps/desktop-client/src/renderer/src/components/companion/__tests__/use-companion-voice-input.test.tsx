// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompanionVoiceInput } from "../use-companion-voice-input";

const recorder = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
const transcribe = vi.hoisted(() => vi.fn());
vi.mock("../voice-recorder", () => ({ CompanionVoiceRecorder: class {
  static isSupported() { return true; }
  start = recorder.start;
  stop = recorder.stop;
} }));
vi.mock("../local-speech-recognition", () => ({ transcribeRecording: transcribe }));
vi.mock("../../../app/desktop-client", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../app/desktop-client")>();
  return { ...actual, requireWorkspaceEpoch: async () => "epoch" };
});

const recording = { sampleRate: 16000, samples: new Float32Array(3200), wav: new ArrayBuffer(44), durationMs: 200 };
beforeEach(() => { recorder.start.mockReset().mockResolvedValue(undefined); recorder.stop.mockReset().mockResolvedValue(recording); transcribe.mockReset(); });
afterEach(cleanup);

describe("separate voice preview lifecycle", () => {
  it("ignores a transcription that returns after the voice bubble is cancelled", async () => {
    let finish!: (value: unknown) => void;
    transcribe.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useCompanionVoiceInput({ onTranscript }));
    await act(async () => result.current.toggle());
    expect(result.current.phase).toBe("listening");
    await act(async () => result.current.toggle());
    expect(result.current.phase).toBe("transcribing");
    act(() => result.current.cancel());
    await act(async () => finish({ route: "local", text: "迟到的识别结果", voiceArtifactId: null }));
    expect(result.current.phase).toBe("idle");
    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.note ?? "").not.toContain("识别好了");
  });

  it("returns to idle with a recoverable message when stopping the recorder fails", async () => {
    recorder.stop.mockRejectedValueOnce(new Error("录音设备断开"));
    const { result } = renderHook(() => useCompanionVoiceInput({ onTranscript: vi.fn() }));
    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());
    expect(result.current.phase).toBe("idle");
    expect(result.current.note).toContain("识别失败");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("starts only one recorder while permission or device startup is pending", async () => {
    let started!: () => void;
    recorder.start.mockImplementationOnce(() => new Promise<void>(resolve => { started = resolve; }));
    const { result } = renderHook(() => useCompanionVoiceInput({ onTranscript: vi.fn() }));
    act(() => { result.current.toggle(); result.current.toggle(); });
    expect(recorder.start).toHaveBeenCalledOnce();
    await act(async () => started());
    expect(result.current.phase).toBe("listening");
    act(() => result.current.cancel());
    expect(result.current.phase).toBe("idle");
  });
});
