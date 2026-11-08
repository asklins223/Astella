// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompanionVoiceConversation } from "../voice/CompanionVoiceConversation";
import type { CompanionVoiceInput } from "../voice/use-companion-voice-input";
import { useRoomStore } from "../../../app/home/room-store";
const makeVoice = (patch: Partial<CompanionVoiceInput> = {}): CompanionVoiceInput => ({
  phase: "open", activity: "listening", caption: null, lastTurn: null, note: null, noteRevision: 0, supported: true, modelMissing: false,
  toggle: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), interrupt: vi.fn(), sendNow: vi.fn(), dismissNote: vi.fn(), subscribeLevel: () => () => {}, ...patch,
});
const props = { onClose: vi.fn(), onActivity: vi.fn(), onModelSettings: vi.fn() };
afterEach(() => { cleanup(); vi.clearAllMocks(); useRoomStore.setState({ masterMuted: false }); });
it("等待、说话、暂停都有真实状态与不同操作", () => {
  const voice = makeVoice({ activity: "waiting", lastTurn: "举一个反例" });
  const view = render(<CompanionVoiceConversation {...props} voice={voice} />);
  expect(screen.getByText("她在想")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "我想说" }));
  expect(voice.interrupt).toHaveBeenCalledOnce();
  view.rerender(<CompanionVoiceConversation {...props} voice={{ ...voice, activity: "speaking" }} />);
  expect(screen.getByText("她在说")).toBeTruthy();
  view.rerender(<CompanionVoiceConversation {...props} voice={{ ...voice, phase: "paused", activity: "paused" }} />);
  expect(screen.getByText("已暂停，点一下球继续")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "继续收音" }));
  expect(voice.resume).toHaveBeenCalledOnce();
});
it("音量来自真实采样，说好了、关闭和 Esc 各自完成自己的动作", () => {
  let meter!: (level: number) => void;
  const voice = makeVoice({ activity: "capturing", caption: { text: "正在说的这句", sending: false }, subscribeLevel: listener => { meter = listener; return () => {}; } });
  render(<CompanionVoiceConversation {...props} voice={voice} />);
  const orb = document.querySelector(".companion-voice") as HTMLElement;
  act(() => { meter(.12); });
  // 收音振幅是麦克风 RMS 乘增益，再开方交给画面；它只写一个 CSS 变量，不触发 React 重渲。
  expect(Number(orb.style.getPropertyValue("--voice-level"))).toBeCloseTo(Math.sqrt(.6), 6);
  // 只要球：画面上没有输入框，也没有对话文字。
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(document.querySelector(".companion-voice__said")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "说好了" }));
  expect(voice.sendNow).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关掉语音对话" }));
  expect(props.onClose).toHaveBeenCalledOnce();
  fireEvent.keyDown(screen.getByRole("region", { name: "语音对话" }), { key: "Escape" });
  expect(props.onClose).toHaveBeenCalledTimes(2);
});
it("总静音有说明，失败不误报正在收音", () => {
  useRoomStore.setState({ masterMuted: true });
  render(<CompanionVoiceConversation {...props} voice={makeVoice({ phase: "idle", activity: "idle", note: "麦克风暂时打不开" })} />);
  expect(screen.getByText("麦克风暂时打不开")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新开始" })).toBeTruthy();
});
it("只有一颗烟球：没有卡片、没有底板、没有按钮行", () => {
  const { container } = render(<CompanionVoiceConversation {...props} voice={makeVoice({ lastTurn: "刚才那句" })} />);
  // 用户的原话是「我只要球」：纸卡、面板、标题栏、对话记录、底部按钮都不在。
  expect(container.querySelector(".companion-hud__panel")).toBeNull();
  expect(container.querySelector(".companion-voice-dock")).toBeNull();
  expect(container.querySelector("header")).toBeNull();
  expect(container.querySelector(".companion-voice__thread")).toBeNull();
  expect(container.querySelector(".companion-voice__controls")).toBeNull();
  // 一颗球：球体里是一张实时云图，没有玻璃高光，也没有球外的光晕。
  expect(container.querySelector(".companion-voice__canvas")).toBeTruthy();
  expect(container.querySelector(".companion-voice__cloud")).toBeNull();
  expect(container.querySelector(".companion-voice__ball")).toBeTruthy();
  expect(container.querySelector(".companion-voice__shell")).toBeTruthy();
  expect(container.querySelector(".companion-voice__orb")).toBeTruthy();
  expect(container.querySelector(".companion-voice__glow")).toBeNull();
});
it("她的声音也在呼吸同一颗球", () => {
  const voice = makeVoice({ activity: "speaking" });
  const { container } = render(<CompanionVoiceConversation {...props} voice={voice} />);
  const orb = container.querySelector(".companion-voice") as HTMLElement;
  expect(orb.getAttribute("data-activity")).toBe("speaking");
  expect(screen.getByText("她在说")).toBeTruthy();
  // 说完/暂停之后把球收回静止大小，不留上一轮的残影。
  expect(orb.style.getPropertyValue("--voice-level")).toBe("0");
});
