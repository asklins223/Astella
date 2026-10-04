// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsVoiceModelCard } from "../settings-voice-model";
import type { VoiceAsrModelController } from "../use-voice-asr-model";
import { VOICE_ASR_MODEL_EXPECTED_BYTES } from "@ailearn/shared/voice-asr-model-contracts";

/**
 * 设置里那张「语音识别模型」卡（2026-10）。
 *
 * 它要回答的其实只有一个问题：**现在这一刻，用户手上能按的那颗按钮是哪一个。**
 * 四种状态各有各的下一步，所以这四条各自钉死——尤其是「下到一半」与「没下成」，
 * 它们都还不算装好，但把人领去的地方不一样。
 */
const HALF = Math.floor(VOICE_ASR_MODEL_EXPECTED_BYTES / 2);

function snapshot(status: "absent" | "downloading" | "ready" | "error", extra: Record<string, unknown> = {}) {
  const ready = status === "ready";
  return {
    version: 1,
    modelId: "sensevoice-int8-zh-en-ja-ko-yue",
    mountUrl: "ailearn-app://bundle/device/asr/",
    status,
    expectedBytes: VOICE_ASR_MODEL_EXPECTED_BYTES,
    receivedBytes: ready ? VOICE_ASR_MODEL_EXPECTED_BYTES : status === "downloading" ? HALF : 0,
    installedBytes: ready ? VOICE_ASR_MODEL_EXPECTED_BYTES : 0,
    files: [],
    failure: status === "error" ? "network" : null,
    installedAt: null,
    sources: ["魔搭社区", "hf-mirror 国内镜像", "Hugging Face 官方库"],
    activeSource: status === "downloading" ? "魔搭社区" : null,
    ...extra,
  } as never;
}

function controller(state: unknown, overrides: Partial<VoiceAsrModelController> = {}): VoiceAsrModelController {
  return {
    state,
    readFailure: null,
    actionFailure: null,
    busy: null,
    download: vi.fn(),
    cancel: vi.fn(),
    remove: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  } as unknown as VoiceAsrModelController;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("语音识别模型这一格", () => {
  it("没有模型时只给一颗下载按钮，并说清它不进安装包", () => {
    render(<SettingsVoiceModelCard model={controller(snapshot("absent"))} />);
    expect(screen.getByRole("button", { name: /下载到这台设备/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /取消下载/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /移除/ })).toBeNull();
    expect(document.body.textContent).toContain("识别时录音不离开设备");
    // 「没它也能好好用」这句是用户决定要不要花 228MB 的关键，必须在这一格里。
    expect(document.body.textContent).toContain("没下载也可以正常使用其它功能");
  });

  it("下载中：给进度条与取消，不给那颗会被反复按的下载", () => {
    render(<SettingsVoiceModelCard model={controller(snapshot("downloading"))} />);
    const meter = screen.getByRole("progressbar", { name: "模型下载进度" });
    expect(meter.getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByRole("button", { name: /取消下载/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /下载到这台设备/ })).toBeNull();
  });

  it("没下成时说的是网络，并给一颗重试", () => {
    render(<SettingsVoiceModelCard model={controller(snapshot("error"))} />);
    expect(document.body.textContent).toContain("没连上模型库");
    expect(screen.getByRole("button", { name: /重试下载/ })).toBeTruthy();
  });

  it("装好后给移除，并说明移除之后语音会暂时停用", () => {
    const model = controller(snapshot("ready"));
    render(<SettingsVoiceModelCard model={model} />);
    const remove = screen.getByRole("button", { name: /从这台设备移除/ });
    expect(remove).toBeTruthy();
    expect(screen.queryByRole("button", { name: /重新下载/ })).toBeNull();
    expect(document.body.textContent).toContain("移除之后语音输入会暂时停用");

    act(() => { remove.click(); });
    expect(model.remove).toHaveBeenCalledOnce();
  });

  it("主进程读不到状态时如实说读不到，而不是谎称「还没有下载」", () => {
    const model = controller(null, { readFailure: "窗口正在重启" });
    render(<SettingsVoiceModelCard model={model} />);
    expect(document.body.textContent).toContain("暂时读不到模型状态");
    expect(screen.queryByRole("button", { name: /下载到这台设备/ })).toBeNull();
    act(() => { screen.getByRole("button", { name: "重新读取状态" }).click(); });
    expect(model.refresh).toHaveBeenCalledOnce();
  });

  it("读数尚未返回时不会把未知状态当成未安装", () => {
    render(<SettingsVoiceModelCard model={controller(null)} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "正在读取状态…" }).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /下载到这台设备/ })).toBeNull();
  });

  it("状态读取失败后不把上次下载进度当成当前读数", () => {
    render(<SettingsVoiceModelCard model={controller(snapshot("downloading"), { readFailure: "窗口正在重启" })} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("button", { name: /取消下载/ })).toBeNull();
    expect(screen.getByRole("button", { name: "重新读取状态" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("下载会继续");
  });

  it("下载量已到总量但尚未安装时，保留 99% 和安装提示", () => {
    render(<SettingsVoiceModelCard model={controller(snapshot("downloading", { receivedBytes: VOICE_ASR_MODEL_EXPECTED_BYTES }))} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("99");
    expect(document.body.textContent).toContain("正在校验并安装");
    expect(document.querySelector("progress")).toBeNull();
  });

  it("换源后呈现当前来源，取消时呈现正在取消", () => {
    render(<SettingsVoiceModelCard model={controller(snapshot("downloading", { activeSource: "hf-mirror 国内镜像" }), { busy: "cancel" })} />);
    expect(document.body.textContent).toContain("正在从hf-mirror 国内镜像下载");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "正在取消…" }).disabled).toBe(true);
  });

  it("用户取消后不出现错误印章或警报", () => {
    render(<SettingsVoiceModelCard model={controller(snapshot("absent", { failure: "cancelled" }))} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).toContain("下载已取消");
    expect(screen.getByRole("button", { name: /下载到这台设备/ })).toBeTruthy();
  });

  it("移除操作失败的提示不假装成状态读取失败", () => {
    render(<SettingsVoiceModelCard model={controller(snapshot("ready"), { actionFailure: "目录不可写" })} />);
    expect(screen.getByRole("alert").textContent).toContain("这次操作没有完成：目录不可写");
    expect(document.body.textContent).not.toContain("暂时读不到模型状态");
  });

  it("状态替换当前操作时接续焦点，键盘可以马上取消", () => {
    const { rerender } = render(<SettingsVoiceModelCard model={controller(snapshot("absent"))} />);
    act(() => screen.getByRole("button", { name: "下载到这台设备" }).focus());
    rerender(<SettingsVoiceModelCard model={controller(snapshot("downloading"))} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消下载" }));
    rerender(<SettingsVoiceModelCard model={controller(snapshot("ready"))} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "从这台设备移除" }));
  });

  it("后台安装完成不会抢走用户在其它输入框的焦点", () => {
    const page = (status: "downloading" | "ready") => <><input aria-label="其它输入" /><SettingsVoiceModelCard model={controller(snapshot(status))} /></>;
    const { rerender } = render(page("downloading"));
    act(() => screen.getByRole("button", { name: "取消下载" }).focus());
    act(() => screen.getByRole("textbox", { name: "其它输入" }).focus());
    rerender(page("ready"));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "其它输入" }));
  });

  it("状态印章与页脚提示说的是同一件事", () => {
    render(<SettingsVoiceModelCard model={controller(snapshot("ready"))} />);
    expect(document.body.textContent).toContain("已装在这台设备上");
    expect(screen.getByRole("button", { name: /从这台设备移除/ })).toBeTruthy();
  });
});
