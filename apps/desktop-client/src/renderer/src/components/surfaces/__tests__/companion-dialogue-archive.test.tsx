// @vitest-environment jsdom
import type { CompanionHistoryItemV1 } from "@astella/shared/companion-memory-desktop-contracts";
import type { CompanionDiscoveryEntryV1 } from "@astella/shared/desktop-ipc-contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../app/room-store";
import { publishCompanionHistoryChanged, publishCompanionRecordsChanged } from "../../companion/companion-events";
import { CompanionDialoguePage } from "../companion/companion-dialogue-page";

const LATEST = "11111111-1111-4111-8111-111111111111";
const OLDER = "22222222-2222-4222-8222-222222222222";
const ok = <T,>(data: T) => ({ ok: true as const, data, workspaceEpoch: 9, requestId: "archive-test" });
const record = (id: string, text: string): CompanionHistoryItemV1 => ({ version: 1, messageId: id, role: "assistant", kind: "text", blocks: [{ type: "text", text }], runId: null, createdAt: "2026-10-05T00:00:00Z", editedAt: null });
const list = vi.fn();
const search = vi.fn();
const collect = vi.fn();
const send = vi.fn();
const ensureConversation = vi.fn();
const getProposal = vi.fn();

beforeEach(() => {
  let entries: CompanionDiscoveryEntryV1[] = [];
  list.mockReset().mockResolvedValue(ok({ version: 1, items: [record(LATEST, "最新的原话。")], nextCursor: null }));
  search.mockReset().mockResolvedValue(ok({ version: 1, items: [record(OLDER, "查到的较早原话。")], nextCursor: null }));
  collect.mockReset().mockImplementation(async ({ request }) => {
    const entry = { ...request, entryId: OLDER, annotation: null, visibility: "private", createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" };
    entries = [entry];
    return ok({ status: "collected", entry });
  });
  send.mockReset(); ensureConversation.mockReset(); getProposal.mockReset();
  vi.stubGlobal("astella", {
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceEpoch: 9 } })) },
    companion: {
      history: { list, search },
      chat: { send, ensureConversation, getProposal },
      memory: { discovery: { get: vi.fn(async () => ok({ version: 1, entries, studyVisible: [] })), collect } },
    },
  });
  useRoomStore.setState({ companionComposerDraft: "轻聊里还没发送的草稿" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useRoomStore.setState({ pageReadableView: null, companionComposerDraft: "" }); });

// No chat provider: reading history must not initialize or depend on a live session.
const openArchive = () => render(<CompanionDialoguePage refreshKey={0} focusMessageId={null} onFocusConsumed={() => undefined} companionName="小星" />);

it("independently displays rich records without opening a conversation or loading proposal decisions", async () => {
  const rich = record(LATEST, "完整的回答正文。");
  rich.blocks.push(
    { type: "quote", label: "原文", text: "需要保留的引用。" },
    { type: "code", language: "js", code: "const answer = 156;" },
    { type: "diagram", title: "计算步骤", steps: [{ label: "先拆开" }, { label: "再相加" }] },
    { type: "card", cardId: OLDER, front: "卡片题面", summary: "卡片摘要", knowledgeForm: null },
    { type: "citation", label: "出处", target: { kind: "entity", entityRef: "note:test" } },
    { type: "image", url: "https://example.test/record.png", label: "回答中的配图", alt: "配图" },
    { type: "nav", label: "曾打开的笔记", route: { kind: "note", noteId: OLDER } },
    { type: "action_ref", proposalId: OLDER },
  );
  list.mockResolvedValue(ok({ version: 1, items: [rich], nextCursor: null }));
  openArchive();
  await screen.findByText("完整的回答正文。");
  for (const text of ["需要保留的引用。", "const answer = 156;", "计算步骤", "先拆开", "再相加", "卡片题面", "出处", "回答中的配图", "曾打开的笔记"]) expect(screen.getByText(text)).toBeTruthy();
  expect(document.querySelector(".cc-thread header strong")?.textContent).toBe("小星");
  expect(document.querySelector("textarea")).toBeNull();
  expect(screen.queryByRole("button", { name: /发送|继续交流|语音与轻聊|确认执行/ })).toBeNull();
  expect(send).not.toHaveBeenCalled(); expect(ensureConversation).not.toHaveBeenCalled(); expect(getProposal).not.toHaveBeenCalled();
});

it("searches and returns to the latest records while leaving the conversation draft intact", async () => {
  openArchive();
  await screen.findByText("最新的原话。");
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索全部对话正文" }), { target: { value: "较早" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await screen.findByText("查到的较早原话。");
  expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: { q: "较早", limit: 50 } }));
  fireEvent.click(screen.getByRole("button", { name: "返回最新对话" }));
  await screen.findByText("最新的原话。");
  expect(useRoomStore.getState().companionComposerDraft).toBe("轻聊里还没发送的草稿");
  expect(send).not.toHaveBeenCalled();
});

it("collecting an older record keeps loaded history and its reading position instead of reloading the first page", async () => {
  list.mockImplementation(async ({ query }) => ok({ version: 1, items: [query.before ? record(OLDER, "更早的原话。") : record(LATEST, "最新的原话。")], nextCursor: query.before ? null : "older" }));
  openArchive();
  fireEvent.click(await screen.findByRole("button", { name: "加载更早记录" }));
  await screen.findByText("更早的原话。");
  const thread = document.querySelector<HTMLDivElement>(".cc-thread")!;
  thread.scrollTop = 37;
  fireEvent.scroll(thread);
  const olderBookmark = document.getElementById(`companion-message-${OLDER}`)!.querySelector<HTMLButtonElement>("button")!;
  olderBookmark.focus();
  fireEvent.click(olderBookmark);
  await waitFor(() => expect(olderBookmark.getAttribute("aria-pressed")).toBe("true"));
  expect(collect).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ sourceId: OLDER, body: "更早的原话。" }) }));
  expect(screen.getByText("最新的原话。")).toBeTruthy();
  expect(screen.getByText("更早的原话。")).toBeTruthy();
  expect(thread.scrollTop).toBe(37);
  expect(document.activeElement).toBe(olderBookmark);
  expect(list).toHaveBeenCalledTimes(2);
});

it("refreshes when persisted dialogue changes, without treating unrelated bookmark changes as new dialogue", async () => {
  openArchive();
  await screen.findByText("最新的原话。");
  act(() => publishCompanionRecordsChanged());
  expect(list).toHaveBeenCalledOnce();
  list.mockResolvedValue(ok({ version: 1, items: [record(LATEST, "另一处交流保存的新记录。")], nextCursor: null }));
  act(() => publishCompanionHistoryChanged());
  await screen.findByText("另一处交流保存的新记录。");
  expect(list).toHaveBeenCalledTimes(2);
  expect(send).not.toHaveBeenCalled();
});

it("keeps keyboard focus while saving and ignores repeated activations before the receipt", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const persist = collect.getMockImplementation()!;
  collect.mockImplementationOnce(async input => { await pending; return persist(input); });
  openArchive();
  await screen.findByText("最新的原话。");
  const bookmark = screen.getByRole("button", { name: "把这一段原话留在发现簿" });
  bookmark.focus();
  fireEvent.click(bookmark);
  await waitFor(() => expect(bookmark.getAttribute("aria-busy")).toBe("true"));
  expect(bookmark.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(bookmark);
  expect(collect).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(bookmark);
  await act(async () => { release(); await pending; });
  await waitFor(() => expect(bookmark.getAttribute("aria-pressed")).toBe("true"));
  expect(document.activeElement).toBe(bookmark);
});
