// @vitest-environment jsdom
import { Activity, StrictMode, type ReactNode } from "react";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_ASR_MODEL_FILES, type VoiceAsrModelSnapshotV1 } from "@astella/shared/voice-asr-model-contracts";
import { useVoiceAsrModel, type VoiceAsrModelController } from "../use-voice-asr-model";
import { readVoiceAsrModel, downloadVoiceAsrModel, removeVoiceAsrModel } from "../../../companion/voice-asr-model";

vi.mock("../../../companion/voice-asr-model", () => ({ readVoiceAsrModel: vi.fn(), downloadVoiceAsrModel: vi.fn(), cancelVoiceAsrModel: vi.fn(), removeVoiceAsrModel: vi.fn() }));
vi.mock("../../../../app/desktop-client", () => ({ gatewayErrorMessage: (error: unknown) => error instanceof Error ? error.message : "失败" }));

const snapshot = (status: VoiceAsrModelSnapshotV1["status"]): VoiceAsrModelSnapshotV1 => ({
  version: 1, modelId: "sensevoice-int8-zh-en-ja-ko-yue", mountUrl: "astella-app://bundle/device/asr/",
  status, expectedBytes: 239_549_735, receivedBytes: status === "ready" ? 239_549_735 : 0,
  installedBytes: status === "ready" ? 239_549_735 : 0, failure: null, installedAt: null,
  files: VOICE_ASR_MODEL_FILES.map(file => ({ name: file.name, expectedBytes: file.expectedBytes, bytes: status === "ready" ? file.expectedBytes : 0, complete: status === "ready" })),
  sources: ["魔搭社区"], activeSource: status === "downloading" ? "魔搭社区" : null,
});

beforeEach(() => { vi.resetAllMocks(); vi.mocked(readVoiceAsrModel).mockResolvedValue(snapshot("absent")); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("模型状态的读取与操作", () => {
  it("StrictMode 重新启用 effects 后仍能显示本机状态", async () => {
    const { result } = renderHook(useVoiceAsrModel, { wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> });
    await waitFor(() => expect(result.current.state?.status).toBe("absent"));
  });

  it("切走再回来能看见后台下载完成，读取没有被旧的卸载标记挡住", async () => {
    let model: VoiceAsrModelController | undefined;
    const Probe = () => { model = useVoiceAsrModel(); return <span>{model.state?.status}</span>; };
    const { rerender } = render(<Activity mode="visible"><Probe /></Activity>);
    await waitFor(() => expect(model!.state?.status).toBe("absent"));
    rerender(<Activity mode="hidden"><Probe /></Activity>);
    vi.mocked(readVoiceAsrModel).mockResolvedValue(snapshot("ready"));
    rerender(<Activity mode="visible"><Probe /></Activity>);
    await waitFor(() => expect(model!.state?.status).toBe("ready"));
  });

  it("一次读取失败可以直接重试恢复", async () => {
    vi.mocked(readVoiceAsrModel).mockRejectedValueOnce(new Error("暂时读不到"));
    const { result } = renderHook(useVoiceAsrModel);
    await waitFor(() => expect(result.current.readFailure).toBe("暂时读不到"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state?.status).toBe("absent"));
    expect(result.current.readFailure).toBeNull();
  });

  it("操作失败不会被收尾时成功的状态读取抹掉", async () => {
    vi.mocked(readVoiceAsrModel).mockResolvedValue(snapshot("ready"));
    vi.mocked(removeVoiceAsrModel).mockRejectedValue(new Error("不能写入"));
    const { result } = renderHook(useVoiceAsrModel);
    await waitFor(() => expect(result.current.state?.status).toBe("ready"));
    act(() => result.current.remove());
    await waitFor(() => expect(result.current.actionFailure).toBe("不能写入"));
    await waitFor(() => expect(result.current.busy).toBeNull());
    expect(result.current.readFailure).toBeNull();
    expect(result.current.actionFailure).toBe("不能写入");
  });

  it("同一帧连点不会发出两条下载请求", async () => {
    vi.mocked(downloadVoiceAsrModel).mockResolvedValue(snapshot("downloading"));
    const { result } = renderHook(useVoiceAsrModel);
    await waitFor(() => expect(result.current.state?.status).toBe("absent"));
    act(() => { result.current.download(); result.current.download(); });
    await waitFor(() => expect(result.current.busy).toBeNull());
    expect(downloadVoiceAsrModel).toHaveBeenCalledOnce();
  });

  it("迟到的旧读取不能覆盖更新后的安装状态", async () => {
    let finishOld: ((value: VoiceAsrModelSnapshotV1) => void) | undefined;
    vi.mocked(readVoiceAsrModel).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const { result } = renderHook(useVoiceAsrModel);
    vi.mocked(readVoiceAsrModel).mockResolvedValue(snapshot("ready"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state?.status).toBe("ready"));
    await act(async () => finishOld!(snapshot("absent")));
    expect(result.current.state?.status).toBe("ready");
  });
});
