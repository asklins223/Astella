// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Activity } from "react";
import type { CompanionHistoryItemV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { DialoguePanel } from "../companion/companion-dialogue-panel";
import { DiscoveryKeepAction, DiscoveryKeepFeedback, clipDiscoveryBody, type DiscoveryKeepProps } from "../companion/companion-discovery-offer";
import { dialogueDiscoveryRequest } from "../companion/companion-discovery-targets";
import { useDiscoveryBookmarks } from "../companion/use-discovery-bookmarks";
import { useRoomStore } from "../../../app/room-store";
import { CompanionDiscoveryPage } from "../companion/companion-discovery-page";

const ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OLDER = "33333333-3333-4333-8333-333333333333";
const noop = () => undefined;
const ok = <T,>(data: T) => ({ ok: true as const, data, workspaceEpoch: 9, requestId: "test" });
const message = (id: string, role: "assistant" | "user", createdAt: string): CompanionHistoryItemV1 => ({ version: 1, messageId: id, role, kind: "text", blocks: [{ type: "text", text: `原话 ${id}` }], runId: null, createdAt, editedAt: null });
const items = [message(OLDER, "assistant", "2026-10-04T00:00:00Z"), message(USER_ID, "user", "2026-10-05T00:00:00Z"), message(ID, "assistant", "2026-10-05T00:01:00Z")];
const action = (overrides: Partial<DiscoveryKeepProps> = {}): DiscoveryKeepProps => ({ state: "offer", busy: false, feedback: null, failure: null, onKeep: noop, onRemove: noop, ...overrides });
const get = vi.fn();
const collect = vi.fn();
const uncollect = vi.fn();

beforeEach(() => {
  let entries: unknown[] = [];
  get.mockReset().mockImplementation(async () => ok({ version: 1, entries, studyVisible: [] }));
  collect.mockReset().mockImplementation(async ({ request }) => {
    const entry = { ...request, entryId: ID, annotation: null, visibility: "private", createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" };
    entries = [entry]; return ok({ status: "collected", entry });
  });
  uncollect.mockReset().mockImplementation(async () => { entries = []; return ok({ status: "uncollected" }); });
  vi.stubGlobal("ailearn", { auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: {}, workspaceEpoch: 9 })) }, companion: { memory: { discovery: { get, collect, uncollect } } } });
});
afterEach(() => { cleanup(); window.localStorage.clear(); vi.unstubAllGlobals(); useRoomStore.setState({ pageReadableView: null }); });

describe("稳定的手动收藏入口", () => {
  it("较早回答、用户原话和最新回答都可操作", () => {
    const keep = vi.fn();
    render(<DialoguePanel section={{ ok: true, value: { version: 1, items, nextCursor: null } }} items={items} cursor={null} query="" searching={false} loadingMore={false} error={null} onQuery={noop} onSearch={noop} onLoadMore={noop} onRetry={noop} discoveryFor={item => action({ onKeep: () => keep(item.messageId) })} />);
    const buttons = screen.getAllByRole("button", { name: "把这一段原话留在发现簿" });
    expect(buttons).toHaveLength(3);
    expect(buttons.every(button => button.closest("header") && !button.textContent)).toBe(true);
    expect(screen.queryByText("留在发现簿")).toBeNull();
    fireEvent.click(buttons[0]!);
    expect(keep).toHaveBeenCalledWith(OLDER);
    expect(dialogueDiscoveryRequest(items[1]!)?.author).toBe("user");
    expect(dialogueDiscoveryRequest(items[1]!)?.kind).toBe("user_utterance");
  });

  it("旧忽略记录不屏蔽手动书签，关闭和重开仍能收藏", async () => {
    window.localStorage.setItem("ailearn:companion-discovery-declined", "declined");
    const request = dialogueDiscoveryRequest(items[2]!)!;
    window.localStorage.setItem("ailearn:companion-discovery-dismissed:v2", JSON.stringify([`${request.kind}|${request.source}|${request.sourceId}`]));
    const hook = renderHook(() => useDiscoveryBookmarks(0));
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(hook.result.current.forRequest(request).state).toBe("offer");
    hook.unmount();
    const reopened = renderHook(() => useDiscoveryBookmarks(0));
    act(() => reopened.result.current.forRequest(request).onKeep());
    await waitFor(() => expect(collect).toHaveBeenCalledOnce());
  });

  it("连续点击只提交一次；收到回执显示已收藏，取消后两处恢复可收藏", async () => {
    const request = dialogueDiscoveryRequest(items[0]!)!;
    const hook = renderHook(() => useDiscoveryBookmarks(0));
    await waitFor(() => expect(get).toHaveBeenCalled());
    const keep = hook.result.current.forRequest(request);
    act(() => { keep.onKeep(); keep.onKeep(); });
    await waitFor(() => expect(hook.result.current.forRequest(request).state).toBe("kept"));
    expect(collect).toHaveBeenCalledOnce();
    expect(collect.mock.calls[0]![0].request).toEqual(dialogueDiscoveryRequest(items[0]!));
    act(() => hook.result.current.forRequest(request).onRemove?.());
    await waitFor(() => expect(hook.result.current.forRequest(request).state).toBe("offer"));
    expect(uncollect.mock.calls[0]![0].request).toEqual({ kind: "kept_ai_suggestion", source: "assistant_reply", sourceId: OLDER });
  });

  it("失败留在对应原话旁，可重试，不转移到另一条消息", async () => {
    collect.mockRejectedValueOnce(new Error("offline"));
    const request = dialogueDiscoveryRequest(items[0]!)!;
    const hook = renderHook(() => useDiscoveryBookmarks(0));
    await waitFor(() => expect(get).toHaveBeenCalled());
    act(() => hook.result.current.forRequest(request).onKeep());
    await waitFor(() => expect(hook.result.current.forRequest(request).failure).toBeTruthy());
    expect(hook.result.current.forRequest(dialogueDiscoveryRequest(items[2]!)!).failure).toBeNull();
    render(<><DiscoveryKeepAction {...hook.result.current.forRequest(request)} /><DiscoveryKeepFeedback {...hook.result.current.forRequest(request)} /></>);
    expect(screen.getByRole("alert").textContent).toContain("这段话还没存下");
    fireEvent.click(screen.getByRole("button", { name: "重试把这一段原话留在发现簿" }));
    await waitFor(() => expect(hook.result.current.forRequest(request).state).toBe("kept"));
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("正文过长时只留明确摘录", () => {
    expect(clipDiscoveryBody("字".repeat(5000))).toHaveLength(4000);
    expect(clipDiscoveryBody("字".repeat(5000)).endsWith("…")).toBe(true);
  });

  it("跨页重新收藏后，返回发现簿刷新正文并清掉上一趟的取消提示", async () => {
    const entry = { ...dialogueDiscoveryRequest(items[0]!)!, entryId: ID, annotation: "已有批注", visibility: "private", createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" };
    let entries = [entry];
    get.mockImplementation(async () => ok({ version: 1, entries, studyVisible: [] }));
    uncollect.mockImplementation(async () => { entries = []; return ok({ status: "uncollected" }); });
    const page = (mode: "visible" | "hidden") => <Activity mode={mode}><CompanionDiscoveryPage refreshKey={0} onBrowse={noop} onSource={noop} /></Activity>;
    const view = render(page("visible"));
    await screen.findByText(entry.body);
    fireEvent.click(screen.getByRole("button", { name: "取消收藏" }));
    await screen.findByText("已取消收藏，原始回答和日记仍然保留。");
    view.rerender(page("hidden"));
    entries = [entry];
    view.rerender(page("visible"));
    await screen.findByText(entry.body);
    expect(screen.queryByText("已取消收藏，原始回答和日记仍然保留。")).toBeNull();
    expect(screen.getByText("你的批注：已有批注")).toBeTruthy();
  });
});
