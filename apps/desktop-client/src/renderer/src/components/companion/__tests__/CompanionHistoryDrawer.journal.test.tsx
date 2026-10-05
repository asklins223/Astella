// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanionHistoryDrawer } from "../CompanionHistoryDrawer";
import { interactionSession } from "./companion-interaction-fixtures";

const state = vi.hoisted(() => ({ chat: null as unknown }));
vi.mock("../../../app/companion-chat-session", async importOriginal => ({
  ...await importOriginal<typeof import("../../../app/companion-chat-session")>(), useCompanionChat: () => state.chat,
}));
vi.mock("../../../app/desktop-client", async importOriginal => ({
  ...await importOriginal<typeof import("../../../app/desktop-client")>(), requireWorkspaceEpoch: async () => 1,
  createRequestMeta: () => ({}), unwrapGatewayResult: (value: unknown) => value,
}));
vi.mock("../use-companion-paper-placement", () => ({ useCompanionPaperPlacement: () => "left" }));

const listThoughts = vi.fn();
const item = (id: string, text: string) => ({ id, text, status: "delivered", deliveredAt: "2026-10-05T01:00:00Z", openedAt: null });
function Journal() {
  const anchor = useRef<HTMLDivElement>(null);
  return <CompanionHistoryDrawer open motionMode="off" input="还没有发送的草稿" onInputChange={vi.fn()} onSend={vi.fn()}
    onVoiceToggle={vi.fn()} voice={{ phase: "idle", supported: false, subscribeLevel: () => () => undefined } as never}
    voiceEnabled={false} anchorRef={anchor} side="left" onBack={vi.fn()} onClose={vi.fn()} />;
}
beforeEach(() => {
  vi.useFakeTimers(); state.chat = interactionSession();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(window, "ailearn", { configurable: true, value: { companion: { chat: { listThoughts } } } });
  listThoughts.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("keeps already loaded older thoughts when visiting another page and retains the shared input draft", async () => {
  listThoughts.mockResolvedValueOnce({ version: 1, items: [item("first", "第一句念想")], nextBefore: "first" })
    .mockResolvedValueOnce({ version: 1, items: [item("older", "较早的一句念想")], nextBefore: null });
  render(<Journal />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "伴星念想" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "更早的念想" })));
  expect(screen.getByText("较早的一句念想")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "全部对话" }));
  expect(screen.queryByRole("region", { name: "伴星念想" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "伴星念想" }));
  expect(screen.getByText("较早的一句念想")).toBeTruthy(); expect(listThoughts).toHaveBeenCalledTimes(2);
  expect((screen.getByRole("textbox", { name: "继续问 小鲸" }) as HTMLTextAreaElement).value).toBe("还没有发送的草稿");
});

it("returns to the saved conversation position after viewing confirmations or entering and leaving search", () => {
  render(<Journal />);
  const list = document.querySelector<HTMLElement>(".companion-history__list")!;
  Object.defineProperties(list, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 300 } });
  list.scrollTop = 234; fireEvent.wheel(list, { deltaY: -20 }); fireEvent.scroll(list);
  fireEvent.click(screen.getByRole("button", { name: "待确认 0" }));
  fireEvent.click(screen.getByRole("button", { name: "全部对话" }));
  act(() => vi.advanceTimersByTime(32)); expect(list.scrollTop).toBe(234);
  fireEvent.click(screen.getByRole("button", { name: "聊天记录" }));
  list.scrollTop = 0;
  fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
  act(() => vi.advanceTimersByTime(32)); expect(list.scrollTop).toBe(234);
});

it("search previews show readable assistant text, retain user literals and jump to the original message", async () => {
  const messages = [
    { id: "assistant-search", role: "assistant", blocks: [{ type: "text", text: "12×13 = **156**。" }], createdAt: "2026-10-05T09:01:00Z" },
    { id: "user-search", role: "user", blocks: [{ type: "text", text: "请保留字面量 **156**" }], createdAt: "2026-10-05T09:00:00Z" },
  ];
  state.chat = interactionSession({ messages: messages as never, fetchAllMessages: vi.fn(async () => messages as never) });
  render(<Journal />);
  fireEvent.click(screen.getByRole("button", { name: "聊天记录" }));
  await act(async () => fireEvent.change(screen.getByRole("textbox", { name: "搜索聊天记录" }), { target: { value: "156" } }));
  const hit = screen.getByRole("button", { name: /12×13 = 156/ });
  expect(hit.textContent).not.toContain("**");
  expect(hit.querySelector("mark")?.textContent).toBe("156");
  expect(screen.getByRole("button", { name: /请保留字面量/ }).textContent).toContain("**156**");
  fireEvent.click(hit);
  expect(screen.getByRole("textbox", { name: "继续问 小鲸" })).toBeTruthy();
});
