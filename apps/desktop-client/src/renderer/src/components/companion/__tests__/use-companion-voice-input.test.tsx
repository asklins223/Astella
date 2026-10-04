// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompanionVoiceInput } from "../use-companion-voice-input";
import { useRoomStore } from "../../../app/room-store";
import { useCompanionNotifications } from "../companion-notifications";
import { SETTINGS_ATTENTION_VOICE_MODEL } from "../open-voice-model-settings";
import { isCompanionMicrophoneActive } from "../companion-notification-voice";

const recorder = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
const transcribe = vi.hoisted(() => vi.fn());
const asrReady = vi.hoisted(() => vi.fn());
vi.mock("../voice-recorder", () => ({ CompanionVoiceRecorder: class {
  static isSupported() { return true; }
  start = recorder.start;
  stop = recorder.stop;
} }));
vi.mock("../local-speech-recognition", () => ({
  transcribeRecording: transcribe,
  isLocalAsrReady: asrReady,
  isAsrModelMissing: (error: unknown) => error instanceof Error && error.name === "AsrModelMissingError",
}));
vi.mock("../voice-asr-model", async importOriginal => ({ ...await importOriginal<typeof import("../voice-asr-model")>(), readVoiceAsrModel: vi.fn() }));
vi.mock("../../../app/desktop-client", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../app/desktop-client")>();
  return { ...actual, requireWorkspaceEpoch: async () => "epoch" };
});

const recording = { sampleRate: 16000, samples: new Float32Array(3200), wav: new ArrayBuffer(44), durationMs: 200 };
beforeEach(() => {
  recorder.start.mockReset().mockResolvedValue(undefined);
  recorder.stop.mockReset().mockResolvedValue(recording);
  transcribe.mockReset();
  asrReady.mockReset().mockResolvedValue(true);
  useRoomStore.setState({ surface: null, settingsSection: "account", settingsAttention: null });
  useCompanionNotifications.setState({ items: [] });
});
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
    await act(async () => finish({ route: "local", text: "迟到的识别结果" }));
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
    // 两次 toggle 之间隔着一次「本机有没有模型」的 await，所以这里用 async act：
    // 它会把那次 await 冲掉，正好停在"起录还没落定"的那一刻。
    await act(async () => { result.current.toggle(); result.current.toggle(); });
    expect(recorder.start).toHaveBeenCalledOnce();
    await act(async () => started());
    expect(result.current.phase).toBe("listening");
    act(() => result.current.cancel());
    expect(result.current.phase).toBe("idle");
  });

  /**
   * 2026-10：模型是用户在设置里下的附加功能，没装就不说话。
   *
   * 这一格钉的是**判断的时机**：在麦克风已经打开之后才等模型状态，用户就白说了半句
   * 还要被挡一次。所以开录那一刻先判一次，判定不通过就连麦克风都还回去。
   */
  it("does not open the microphone when this device has no recognition model yet", async () => {
    asrReady.mockResolvedValue(false);
    const onModelMissing = vi.fn();
    const { result } = renderHook(() => useCompanionVoiceInput({ onTranscript: vi.fn(), onModelMissing }));

    await act(async () => result.current.toggle());

    expect(result.current.modelMissing).toBe(true);
    expect(result.current.phase).toBe("idle");
    expect(result.current.note).toContain("还没有语音识别模型");
    // 麦克风一个字节都没要：为一个说不了话的功能弹一次授权弹窗，是最难解释的一种浪费。
    expect(recorder.start).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(onModelMissing).toHaveBeenCalledOnce();
    expect(useRoomStore.getState()).toMatchObject({ surface: "settings", settingsSection: "companion", settingsAttention: SETTINGS_ATTENTION_VOICE_MODEL });
    expect(useCompanionNotifications.getState().items[0]).toMatchObject({ id: "voice-model-needed", delivery: "immediate", audio: { clip: "voice-model-needed" } });
    expect(isCompanionMicrophoneActive()).toBe(false);
  });

  it("does not navigate when a cancelled model check returns late", async () => {
    let finish!: (ready: boolean) => void;
    asrReady.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useCompanionVoiceInput({ onTranscript: vi.fn() }));
    act(() => result.current.toggle());
    act(() => result.current.cancel());
    await act(async () => finish(false));
    expect(useRoomStore.getState().surface).toBeNull();
    expect(useCompanionNotifications.getState().items).toHaveLength(0);
    expect(recorder.start).not.toHaveBeenCalled();
  });

  it("leaves an unreadable model state recoverable without blaming microphone permission", async () => {
    asrReady.mockRejectedValueOnce(new Error("IPC unavailable"));
    const { result } = renderHook(() => useCompanionVoiceInput({ onTranscript: vi.fn() }));
    await act(async () => result.current.toggle());
    expect(result.current.note).toContain("暂时读不到本机语音状态");
    expect(useRoomStore.getState().surface).toBeNull();
    expect(recorder.start).not.toHaveBeenCalled();
    await act(async () => result.current.toggle());
    expect(result.current.phase).toBe("listening");
    expect(isCompanionMicrophoneActive()).toBe(true);
    act(() => result.current.cancel());
    expect(isCompanionMicrophoneActive()).toBe(false);
  });

  it("a missing model during transcription is a way out, not a dead end", async () => {
    const error = Object.assign(new Error("本地识别模型尚未安装"), { name: "AsrModelMissingError" });
    transcribe.mockRejectedValue(error);
    const { result } = renderHook(() => useCompanionVoiceInput({ onTranscript: vi.fn() }));

    await act(async () => result.current.toggle());
    await act(async () => result.current.toggle());

    expect(result.current.modelMissing).toBe(true);
    expect(result.current.note).toContain("还没有语音识别模型");
    // 不是「识别失败」：那句话没有下一步，而这一句有。
    expect(result.current.note ?? "").not.toContain("识别失败");
  });
});
