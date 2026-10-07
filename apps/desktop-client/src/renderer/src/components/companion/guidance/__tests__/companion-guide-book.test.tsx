// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { CompanionGuideBook } from "../CompanionGuideBook";
import { CompanionGuidanceStage } from "../CompanionGuidanceStage";
import { hasForeignModal } from "../../companion-modal-ownership";
import type { CompanionGuideController } from "../use-companion-guide";
const runFeature = vi.fn();
vi.mock("../../../home-v2/HomeV2Experience", () => ({ useHomeV2: () => ({ runFeature }) }));
const guide = () => ({ account: null, identity: { name: "共享书房", role: "member", isPersonal: false }, session: { topic: "welcome", index: 1, scope: "account" }, invitation: null, contents: { status: "ready", total: 0, notes: [] }, consent: "granted", consentLoading: false, consentSaving: false, consentError: null, signConsent: vi.fn(), retryConsent: vi.fn(), openConsentSettings: vi.fn(), start: vi.fn(), skip: vi.fn(), pause: vi.fn(), next: vi.fn(), end: vi.fn(), resume: null, reloadContents: vi.fn(), pending: false, revision: 0 }) as CompanionGuideController;
beforeEach(() => { runFeature.mockReset(); useRoomStore.setState({ windowState: "visible", surface: null, destination: "room", motionMode: "off", reducedMotion: false, masterMuted: true, hudPage: "home", spaceIdentity: { name: "共享书房", role: "member", isPersonal: false } }); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("keeps the companion running during its own film while still recognizing unrelated modals", () => {
  render(<CompanionGuidanceStage guide={guide()} />);
  expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
  expect(hasForeignModal(document)).toBe(false);
  const foreign = document.createElement("div"); foreign.setAttribute("role", "dialog"); foreign.setAttribute("aria-modal", "true");
  document.body.append(foreign);
  expect(hasForeignModal(document)).toBe(true);
  foreign.remove();
});
it("offers a complete first walk before the individual topics and closes the directory when started", () => {
  const controller = guide(), close = vi.fn(); controller.session = null;
  render(<CompanionGuideBook guide={controller} onClose={close} />);
  fireEvent.click(screen.getByRole("button", { name: /播放书房介绍/ }));
  expect(controller.start).toHaveBeenCalledWith("welcome", false);
  expect(close).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: /读懂一篇笔记/ }));
  expect(controller.start).toHaveBeenLastCalledWith("reading", false);
  expect(screen.queryByText("用自己的话，记下来")).toBeNull();
});
it("presents the entire route and a complete static scene when motion is Off", () => {
  const controller = guide();
  const { container } = render(<CompanionGuidanceStage guide={controller} />);
  expect(container.querySelector(".guidance-stage")).toBeNull();
  expect(document.body.querySelector('.guidance-scene[data-phase="2"]')).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "动画章节" }).querySelectorAll("li")).toHaveLength(5);
  expect(screen.getByRole("button", { name: "第 2 段：找到笔记" }).getAttribute("aria-current")).toBe("step");
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "暂停引导动画" }));
  expect(screen.getByRole("button", { name: "播放引导动画" })).toBeTruthy();
  expect(controller.pause).not.toHaveBeenCalled();
});
it("keeps the tour alive through a real visit and continues to the next chapter", () => {
  const controller = guide();
  runFeature.mockImplementation(() => useRoomStore.setState({ surface: "note-library" }));
  render(<CompanionGuidanceStage guide={controller} />);
  fireEvent.click(screen.getByRole("button", { name: "打开我的笔记" }));
  expect(runFeature).toHaveBeenCalledWith("all-notes");
  expect(controller.pause).not.toHaveBeenCalled();
  expect(document.body.querySelector('.guidance-stage[data-view="practice"]')).toBeTruthy();
  expect(screen.getByRole("button", { name: "返回动画" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "返回动画" }));
  expect(document.body.querySelector('.guidance-stage[data-view="film"]')).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "让资料，变成自己的理解" }));
  expect(useRoomStore.getState().surface).toBe("note-library");
  fireEvent.click(screen.getByRole("button", { name: "第 3 段：读懂一句" }));
  expect(controller.next).toHaveBeenCalledWith(1);
  expect(document.body.querySelector('.guidance-stage[data-view="film"]')).toBeTruthy();
});
it("carries the same sheet from the note to its explanation, including a quick reversal", () => {
  const controller = guide();
  const { rerender } = render(<CompanionGuidanceStage guide={controller} />);
  const paper = document.body.querySelector(".guidance-scene__folio");
  controller.session = { topic: "welcome", index: 2, scope: "account" };
  rerender(<CompanionGuidanceStage guide={controller} />);
  expect(document.body.querySelector(".guidance-scene__folio")).toBe(paper);
  expect(screen.getByRole("button", { name: "演示：选中这句请伴星解释" })).toBeTruthy();
  controller.session = { topic: "welcome", index: 1, scope: "account" };
  rerender(<CompanionGuidanceStage guide={controller} />);
  expect(document.body.querySelector(".guidance-scene__folio")).toBe(paper);
  expect(controller.pause).not.toHaveBeenCalled();
});
it("shows a dedicated agreement before mounting any tour or narration", () => {
  const controller = guide(); controller.consent = "required";
  render(<CompanionGuidanceStage guide={controller} />);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(document.body.querySelector(".guidance-scene")).toBeNull();
  expect(document.body.querySelector(".guidance-narration")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "动画章节" })).toBeNull();
  const submit = screen.getByRole("button", { name: "同意并开始带路" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "我已阅读并同意《AI 使用协议》" }));
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  expect(controller.signConsent).toHaveBeenCalledOnce();
  expect(controller.openConsentSettings).not.toHaveBeenCalled();
});
it("makes a failed consent read retryable and preserves the pause choice", () => {
  const controller = guide(); controller.consent = "unknown"; controller.consentError = "连接暂时中断";
  render(<CompanionGuidanceStage guide={controller} />);
  expect(screen.getByRole("alert").textContent).toContain("暂时没能读取你的签署状态");
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  expect(controller.retryConsent).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "暂不签署" }));
  expect(controller.pause).toHaveBeenCalledOnce(); expect(controller.end).not.toHaveBeenCalled();
});
it("keeps keyboard focus inside the consent paper and restores background access", () => {
  const controller = guide(); controller.consent = "required";
  const outside = document.createElement("button"); outside.textContent = "背景入口"; document.body.append(outside); outside.focus();
  const { unmount } = render(<CompanionGuidanceStage guide={controller} />);
  expect(outside.inert).toBe(true);
  const heading = screen.getByRole("heading", { name: "先了解 AI 的使用方式" });
  expect(document.activeElement).toBe(heading);
  fireEvent.keyDown(heading, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "暂不签署" }));
  unmount(); expect(outside.inert).toBe(false); expect(document.activeElement).toBe(outside); outside.remove();
});
it("keeps pause, completion and real conversation separate", () => {
  const controller = guide();
  render(<CompanionGuidanceStage guide={controller} />);
  fireEvent.click(screen.getByRole("button", { name: "暂停引导动画" }));
  expect(controller.pause).not.toHaveBeenCalled(); expect(controller.end).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "跳过引导" }));
  expect(controller.end).toHaveBeenCalledOnce();
  const chat = vi.fn(); window.addEventListener("astella:companion-open-chat", chat);
  fireEvent.click(screen.getByRole("button", { name: "问一句" }));
  expect(chat).toHaveBeenCalledOnce();
  window.removeEventListener("astella:companion-open-chat", chat);
});

it("does not show an unsigned agreement while an existing account is still being checked", () => {
  const controller = guide(); controller.consent = "unknown"; controller.consentLoading = true;
  const { rerender } = render(<CompanionGuidanceStage guide={controller} />);
  expect(screen.getByRole("heading", { name: "正在确认你的使用状态" })).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "同意并开始带路" })).toBeNull();
  controller.consent = "required"; controller.consentLoading = false;
  rerender(<CompanionGuidanceStage guide={controller} />);
  expect(screen.getByRole("heading", { name: "使用哪些内容" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "你的数据选择" })).toBeTruthy();
  expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
});

it("keeps playback controls focused during automatic chapter changes and releases the borrowed seat", () => {
  const controller = guide();
  const original = { x: .3, y: .65 };
  useRoomStore.setState({ companionUserAnchor: original, companionPlacementOwner: "user" });
  const { rerender, unmount } = render(<CompanionGuidanceStage guide={controller} />);
  const play = screen.getByRole("button", { name: "暂停引导动画" }); play.focus();
  expect(useRoomStore.getState().companionGuideFilm).toBe(true);
  controller.session = { topic: "welcome", index: 2, scope: "account" };
  rerender(<CompanionGuidanceStage guide={controller} />);
  expect(document.activeElement).toBe(play);
  expect(useRoomStore.getState().companionUserAnchor).toBe(original);
  unmount(); expect(useRoomStore.getState().companionGuideFilm).toBe(false);
});

it("lands a paused chapter selection on a fully readable still and starts that chapter when played", () => {
  const controller = guide(); useRoomStore.setState({ motionMode: "full" });
  const { rerender } = render(<CompanionGuidanceStage guide={controller} />);
  fireEvent.click(screen.getByRole("button", { name: "暂停引导动画" }));
  fireEvent.click(screen.getByRole("button", { name: "第 3 段：读懂一句" }));
  controller.session = { topic: "welcome", index: 2, scope: "account" };
  rerender(<CompanionGuidanceStage guide={controller} />);
  expect(document.body.querySelector('.guidance-scene__explanation[aria-hidden="false"]')).toBeTruthy();
  expect((document.body.querySelector('[data-guide-content]') as HTMLElement).style.opacity).toBe("");
  expect(screen.getByRole("button", { name: "播放引导动画" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "播放引导动画" }));
  expect(screen.getByRole("button", { name: "暂停引导动画" })).toBeTruthy();
});
