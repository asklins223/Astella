// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanionHistoryComposer } from "../CompanionHistoryComposer";
import type { CompanionVoiceInput } from "../use-companion-voice-input";

const voice: CompanionVoiceInput = {
  phase: "idle", note: null, noteRevision: 0, supported: true,
  toggle: () => {}, cancel: () => {}, dismissNote: () => {}, subscribeLevel: () => () => {},
};
const props = {
  input: "", onInputChange: vi.fn(), onSend: vi.fn(async () => {}), voice,
  voiceEnabled: true, companionName: "小鲸", sending: false, stopping: false,
  onStop: vi.fn(), onVoiceToggle: vi.fn(), onPageActions: vi.fn(),
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
