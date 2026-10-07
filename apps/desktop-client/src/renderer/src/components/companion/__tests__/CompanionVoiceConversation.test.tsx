// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompanionVoiceConversation } from "../CompanionVoiceConversation";
import type { CompanionVoiceInput } from "../use-companion-voice-input";
import { useRoomStore } from "../../../app/room-store";
const makeVoice = (patch: Partial<CompanionVoiceInput> = {}): CompanionVoiceInput => ({
  phase: "open", activity: "listening", caption: null, lastTurn: null, note: null, noteRevision: 0, supported: true, modelMissing: false,
  toggle: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), interrupt: vi.fn(), sendNow: vi.fn(), dismissNote: vi.fn(), subscribeLevel: () => () => {}, ...patch,
});
const props = { onClose: vi.fn(), onText: vi.fn(), onActivity: vi.fn(), onModelSettings: vi.fn() };
afterEach(() => { cleanup(); vi.clearAllMocks(); useRoomStore.setState({ masterMuted: false }); });
it("等待、说话、暂停都有真实状态与不同操作，最后一句在回复期间仍可读", () => {
  const voice = makeVoice({ activity: "waiting", lastTurn: "举一个反例" });
  const view = render(<CompanionVoiceConversation {...props} voice={voice} />);
  expect(screen.getByText("伴星正在准备回复")).toBeTruthy();
  expect(screen.getByText("举一个反例")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "我想说" }));
  expect(voice.interrupt).toHaveBeenCalledOnce();
  view.rerender(<CompanionVoiceConversation {...props} voice={{ ...voice, activity: "speaking" }} />);
  expect(screen.getByText("伴星正在说")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "暂停收音" }));
  expect(voice.pause).toHaveBeenCalledOnce();
  view.rerender(<CompanionVoiceConversation {...props} voice={{ ...voice, phase: "paused", activity: "paused" }} />);
  expect(screen.queryByRole("button", { name: "我想说" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "继续收音" }));
  expect(voice.resume).toHaveBeenCalledOnce();
});
it("音量来自真实采样，字幕只读，说好了和关闭各自完成自己的动作", () => {
  let meter!: (level: number) => void;
  const voice = makeVoice({ activity: "capturing", caption: { text: "正在说的这句", sending: false }, subscribeLevel: listener => { meter = listener; return () => {}; } });
  render(<CompanionVoiceConversation {...props} voice={voice} />);
  act(() => { meter(.12); });
  expect((document.querySelector(".companion-voice-meter") as HTMLElement).style.getPropertyValue("--input-level")).toBe("0.6");
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "说好了" }));
  expect(voice.sendNow).toHaveBeenCalledOnce();
  fireEvent.keyDown(screen.getByRole("region", { name: "语音对话" }), { key: "Escape" });
  expect(props.onClose).toHaveBeenCalledOnce();
});
it("总静音与失败有说明，不误报正在收音", () => {
  useRoomStore.setState({ masterMuted: true });
  render(<CompanionVoiceConversation {...props} voice={makeVoice({ phase: "idle", activity: "idle", note: "麦克风暂时打不开" })} />);
  expect(screen.getByText("当前总静音，伴星回复会以文字显示。")).toBeTruthy();
  expect(screen.getByText("麦克风暂时打不开")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "暂停收音" })).toBeNull();
  expect(screen.getByRole("button", { name: "重新开始" })).toBeTruthy();
});
