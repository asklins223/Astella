// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompanionChatListThoughtsResultV1, CompanionThoughtV1 } from "@ailearn/shared/companion-chat-desktop-contracts";
import { CompanionThoughtJournal } from "../CompanionThoughtJournal";

const state = vi.hoisted(() => ({ scope: 1 }));
vi.mock("../../../app/room-store", () => ({ useRoomStore: Object.assign(
  (select: (value: { workspaceScopeRevision: number }) => unknown) => select({ workspaceScopeRevision: state.scope }),
  { getState: () => ({ workspaceScopeRevision: state.scope }) },
) }));
vi.mock("../../../app/desktop-client", () => ({ createRequestMeta: () => ({ epoch: 1 }), requireWorkspaceEpoch: async () => 1,
  unwrapGatewayResult: (value: unknown) => value, gatewayErrorMessage: (error: Error) => error.message }));

const listThoughts = vi.fn(), openThought = vi.fn(), send = vi.fn();
const thought = (id: string, text: string): CompanionThoughtV1 => ({ id, text, status: "delivered",
  createdAt: "2026-10-05T00:00:00Z", deliveredAt: "2026-10-05T01:00:00Z", expiresAt: "2026-10-06T01:00:00Z", openedAt: null });
const page = (items: CompanionThoughtV1[], nextBefore: string | null = null): CompanionChatListThoughtsResultV1 => ({ version: 1, items, nextBefore });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => {
  state.scope = 1; vi.clearAllMocks();
  Object.defineProperty(window, "ailearn", { configurable: true, value: { companion: { chat: { listThoughts, openThought, send } } } });
});
afterEach(cleanup);

it("reads expressed thoughts without opening a cue or starting a turn; the reply action only brings a reference", async () => {
  listThoughts.mockResolvedValue(page([thought("one", "今天想起你提过的间隔重复。"), { ...thought("two", "后来你把这句聊开了。"), openedAt: "2026-10-05T02:00:00Z", status: "spent" }]));
  const onBringToChat = vi.fn();
  render(<CompanionThoughtJournal companionName="小鲸" onBringToChat={onBringToChat} />);
  await screen.findByText("今天想起你提过的间隔重复。");
  expect(listThoughts).toHaveBeenCalledWith({ meta: { epoch: 1 }, request: { version: 1, limit: 30 } });
  expect(screen.getByText("后来聊起过")).toBeTruthy();
  expect(onBringToChat).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "聊聊这句" })[0]);
  expect(onBringToChat).toHaveBeenCalledWith("今天想起你提过的间隔重复。", expect.any(String));
  expect(openThought).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
});

it("retries a failed older page at the same cursor, preserving entries and removing duplicate boundary rows", async () => {
  listThoughts.mockResolvedValueOnce(page([thought("one", "较新的念想。")], "one"))
    .mockRejectedValueOnce(new Error("连接暂时中断"))
    .mockResolvedValueOnce(page([thought("one", "较新的念想。"), thought("two", "更早的念想。") ]));
  const onReady = vi.fn();
  render(<CompanionThoughtJournal companionName="小鲸" onBringToChat={vi.fn()} onReady={onReady} />);
  await screen.findByText("较新的念想。");
  expect(onReady).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "更早的念想" }));
  await screen.findByText("连接暂时中断");
  expect(screen.getByText("较新的念想。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await screen.findByText("更早的念想。");
  expect(screen.getAllByText("较新的念想。")).toHaveLength(1);
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(listThoughts.mock.calls.slice(1).every(([input]) => input.request.before === "one")).toBe(true);
  expect(screen.queryByRole("button", { name: "更早的念想" })).toBeNull();
});

it("a failed first read stays retryable and a successful empty read is an honest empty page", async () => {
  listThoughts.mockRejectedValueOnce(new Error("念想暂时读不回来")).mockResolvedValueOnce(page([]));
  render(<CompanionThoughtJournal companionName="小鲸" onBringToChat={vi.fn()} />);
  await screen.findByRole("button", { name: "重新读取" });
  expect(screen.queryByText("让念想慢慢留下来")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await screen.findByText("让念想慢慢留下来");
  expect(screen.queryByRole("button", { name: "重新读取" })).toBeNull();
});

it("hides the old space immediately and discards its late page after switching spaces", async () => {
  const old = deferred<CompanionChatListThoughtsResultV1>();
  listThoughts.mockResolvedValueOnce(page([thought("one", "旧空间的念想。")], "one"))
    .mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([thought("current", "当前空间的念想。") ]));
  const view = render(<CompanionThoughtJournal companionName="小鲸" onBringToChat={vi.fn()} />);
  await screen.findByText("旧空间的念想。");
  fireEvent.click(screen.getByRole("button", { name: "更早的念想" }));
  await waitFor(() => expect(listThoughts).toHaveBeenCalledTimes(2));
  state.scope = 2; view.rerender(<CompanionThoughtJournal companionName="小鲸" onBringToChat={vi.fn()} />);
  expect(screen.queryByText("旧空间的念想。")).toBeNull();
  await screen.findByText("当前空间的念想。");
  await act(async () => old.resolve(page([thought("late", "过时响应里的念想。") ])));
  expect(screen.queryByText("过时响应里的念想。")).toBeNull();
  expect(screen.getByText("当前空间的念想。")).toBeTruthy();
});
