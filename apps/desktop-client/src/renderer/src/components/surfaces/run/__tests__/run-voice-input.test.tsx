// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceTeachbackEditor } from "../run-voice-input";
import { isCompanionMicrophoneActive } from "../../../companion/companion-notification-voice";

const mock = vi.hoisted(() => ({ ready: vi.fn(), probe: vi.fn(), start: vi.fn(), stop: vi.fn(), transcribe: vi.fn(), guide: vi.fn() }));
vi.mock("../../../companion/voice-recorder", () => ({ CompanionVoiceRecorder: class { start = mock.start; stop = mock.stop; } }));
vi.mock("../../../companion/local-speech-recognition", () => ({ isLocalAsrReady: mock.ready, transcribeRecording: mock.transcribe, isAsrModelMissing: () => false }));
vi.mock("../../../companion/voice-model-notifications", () => ({ guideVoiceModelDownload: mock.guide }));
vi.mock("../../../voice-capability", () => ({ probeMicrophone: mock.probe, microphoneAvailabilityCopy: () => "麦克风未准备好" }));

const mount = (onChange = vi.fn()) => render(<VoiceTeachbackEditor maxSeconds={60} value={{ confirmedTranscript: "" }} onChange={onChange} onBusyChange={vi.fn()} />);
beforeEach(() => {
  vi.resetAllMocks();
  mock.ready.mockResolvedValue(true); mock.probe.mockResolvedValue({ state: "ready" });
  mock.start.mockResolvedValue(undefined);
  mock.stop.mockResolvedValue({ samples: new Float32Array(8_000), sampleRate: 16_000, durationMs: 500 });
  mock.transcribe.mockResolvedValue({ text: "我的理解是……" });
});
afterEach(cleanup);

describe("voice teachback model guidance", () => {
  it("guides before recording and allows another attempt after installation", async () => {
    mock.ready.mockResolvedValueOnce(false);
    mount();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "开始说" })));
    expect(mock.guide).toHaveBeenCalledOnce(); expect(mock.start).not.toHaveBeenCalled();
    expect(isCompanionMicrophoneActive()).toBe(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "开始说" })));
    expect(mock.start).toHaveBeenCalledOnce(); expect(isCompanionMicrophoneActive()).toBe(true);
  });

  it("keeps one recorder when the model check and microphone startup are pending", async () => {
    let ready!: (value: boolean) => void;
    mock.ready.mockImplementationOnce(() => new Promise<boolean>(resolve => { ready = resolve; }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "开始说" }));
    fireEvent.click(screen.getByRole("button", { name: "开始说" }));
    expect(mock.ready).toHaveBeenCalledOnce();
    await act(async () => ready(true));
    expect(mock.start).toHaveBeenCalledOnce();
  });
  it("lets missing-model guidance run even when microphone availability is blocked", async () => {
    mock.ready.mockResolvedValue(false); mock.probe.mockResolvedValue({ state: "no-permission" });
    mount(); await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "开始说" })));
    expect(mock.guide).toHaveBeenCalledOnce(); expect(mock.start).not.toHaveBeenCalled();
  });

  it("ignores a missing model receipt after the editor was left", async () => {
    let ready!: (value: boolean) => void;
    mock.ready.mockImplementationOnce(() => new Promise<boolean>(resolve => { ready = resolve; }));
    const view = mount(); fireEvent.click(screen.getByRole("button", { name: "开始说" })); view.unmount();
    await act(async () => ready(false));
    expect(mock.guide).not.toHaveBeenCalled(); expect(mock.start).not.toHaveBeenCalled();
    expect(isCompanionMicrophoneActive()).toBe(false);
  });

  it("returns microphone priority after transcription fails and can be retried", async () => {
    mock.transcribe.mockRejectedValueOnce(new Error("device error"));
    const onChange = vi.fn(); mount(onChange);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "开始说" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /说完了/ })));
    expect(isCompanionMicrophoneActive()).toBe(false); expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/这段没能转成文字/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "开始说" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /说完了/ })));
    expect(onChange).toHaveBeenCalledWith({ confirmedTranscript: "我的理解是……", correctionMethod: "none" });
    expect(isCompanionMicrophoneActive()).toBe(false);
  });
});
