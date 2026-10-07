// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanionHistoryComposer } from "../CompanionHistoryComposer";
import type { CompanionVoiceInput } from "../use-companion-voice-input";

const voice: CompanionVoiceInput = {
  phase: "idle", activity: "idle", lastTurn: null, pause: () => {}, resume: () => {}, interrupt: () => {}, sendNow: () => {}, note: null, noteRevision: 0, supported: true,
  toggle: () => {}, cancel: () => {}, dismissNote: () => {}, subscribeLevel: () => () => {},
  modelMissing: false, caption: null,
};
const props = {
  input: "", onInputChange: vi.fn(), onSend: vi.fn(async () => {}), voice,
  voiceEnabled: true, companionName: "小鲸", sending: false, stopping: false,
  onStop: vi.fn(), onVoiceToggle: vi.fn(), onPageActions: vi.fn(),
  image: null, imageUploading: false, imageError: null,
  onPickImage: vi.fn(), onRemoveImage: vi.fn(),
};
let contentHeight = 0;
let limits: CSSStyleDeclaration;
beforeEach(() => {
  contentHeight = 0;
  limits = document.createElement("textarea").style;
  limits.minHeight = "52px";
  limits.maxHeight = "100px";
  vi.spyOn(window, "getComputedStyle").mockReturnValue(limits);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => contentHeight);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("releases empty input space when the viewport switches to its compact budget", () => {
  render(<CompanionHistoryComposer {...props} />);
  const field = screen.getByRole("textbox", { name: "继续问 小鲸" });
  expect(field.style.height).toBe("52px");
  limits.minHeight = "28px";
  limits.maxHeight = "58px";
  act(() => { window.dispatchEvent(new Event("resize")); });
  expect(field.style.height).toBe("28px");
  limits.minHeight = "52px";
  limits.maxHeight = "100px";
  act(() => { window.dispatchEvent(new Event("resize")); });
  expect(field.style.height).toBe("52px");
});

it("keeps a long draft intact while capping its height at the current reading budget", () => {
  limits.minHeight = "28px";
  limits.maxHeight = "58px";
  contentHeight = 248;
  const draft = "第一行\n第二行\n第三行\n第四行\n第五行";
  const view = render(<CompanionHistoryComposer {...props} input={draft} />);
  const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "继续问 小鲸" });
  expect(field.style.height).toBe("58px");
  expect(field.value).toBe(draft);
  expect(screen.getByRole("button", { name: "发送" }).getAttribute("disabled")).toBeNull();
  contentHeight = 0;
  view.rerender(<CompanionHistoryComposer {...props} />);
  expect(field.style.height).toBe("28px");
  expect(field.value).toBe("");
});

it("hands the picked file to the upload path and clears the input so the same file can be retried", () => {
  const onPickImage = vi.fn();
  const { container } = render(<CompanionHistoryComposer {...props} onPickImage={onPickImage} />);
  fireEvent.click(screen.getByRole("button", { name: "传一张图给伴星" }));
  const picker = container.querySelector("input[type=file]") as HTMLInputElement;
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "截屏.png", { type: "image/png" });
  fireEvent.change(picker, { target: { files: [file] } });
  expect(onPickImage).toHaveBeenCalledWith(file);
  expect(picker.value).toBe("");
});

it("shows the pending attachment and keeps send off until the upload has an answer", () => {
  const onRemoveImage = vi.fn();
  const view = render(<CompanionHistoryComposer {...props} imageUploading />);
  expect(screen.getByRole("status").textContent).toContain("图片上传中");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "传一张图给伴星" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送" }).disabled).toBe(true);

  view.rerender(<CompanionHistoryComposer {...props} input="看看这张"
    image={{ url: "/api/uploads/11111111-1111-4111-8111-111111111111/companion/22222222-2222-4222-8222-222222222222.png", label: "截屏" }}
    onRemoveImage={onRemoveImage} />);
  expect(screen.getByText("截屏")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "移除这张图" }));
  expect(onRemoveImage).toHaveBeenCalledTimes(1);

  view.rerender(<CompanionHistoryComposer {...props} imageError="图片超过 5MB，请压缩后重试" />);
  expect(screen.getByRole("status").textContent).toContain("图片超过 5MB");
});

/**
 * 抽屉开着的时候 HUD 那层的语音气泡是被遮住的（`obscured`），所以手记这一面
 * 必须自己把字幕长出来——否则用户在一整面对话里对着麦克风说话，眼前只有一个转圈的图标。
 */
it("把实时字幕摆在手记这一面，跟着说话进度长", () => {
  const view = render(<CompanionHistoryComposer {...props} voice={{ ...voice, phase: "open" }} />);
  expect(screen.getByRole("status").textContent).toContain("正在听你说话，停顿后自动发送");
  view.rerender(<CompanionHistoryComposer {...props}
    voice={{ ...voice, phase: "open", caption: { text: "这一段我没看懂", sending: false } }} />);
  expect(screen.getByRole("status").textContent).toBe("这一段我没看懂");
  view.rerender(<CompanionHistoryComposer {...props}
    voice={{ ...voice, phase: "closing", caption: { text: "这一段我没看懂", sending: true } }} />);
  expect(screen.getByRole("status").textContent).toBe("这一段我没看懂");
});

/** 麦克风按钮在这一面也是**进入／退出对话**：会话正开着时它写的是"结束"。 */
it("会话进行中，麦克风按钮的意思改成结束语音对话", () => {
  const view = render(<CompanionHistoryComposer {...props} voice={{ ...voice, phase: "open" }} />);
  expect(screen.getByRole("button", { name: "结束语音对话" })).toBeTruthy();
  view.rerender(<CompanionHistoryComposer {...props} />);
  expect(screen.getByRole("button", { name: "开始语音对话" })).toBeTruthy();
});
