// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionContentBlockV1, CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
import { desktopRouteFromAgentRoute } from "../../../app/companion-chat-session";
import { CompanionReplyPapers } from "../CompanionReplyPapers";
import { CompanionChatRecordArticle } from "../CompanionChatRecord";
import { interactionProposal, interactionSession } from "./companion-interaction-fixtures";

vi.mock("../../surfaces/source/source-image", async importOriginal => {
  const actual = await importOriginal<typeof import("../../surfaces/source/source-image")>();
  return { ...actual, useSourceImage: () => ({ state: { status: "ready", src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPioAAAAASUVORK5CYII=" }, retry: vi.fn() }) };
});

const blocks: readonly CompanionContentBlockV1[] = [
  { type: "quote", label: "引用的原文", text: "Query 找到相关的内容。" },
  { type: "diagram", title: "理解步骤", steps: [{ label: "先找线索", detail: "再核对原文" }] },
  { type: "card", cardId: "card-id", knowledgeForm: null, front: "Query 是什么？", summary: "寻找内容的线索" },
  { type: "image", url: "/api/uploads/notes/example.png", label: "相关示意图" },
  { type: "citation", label: "参考文献", target: { kind: "external_https", href: "https://example.com/reference" } },
  { type: "code", language: "ts", code: "const query = '寻找线索';" },
];
const proposalId = "55555555-5555-4555-8555-555555555555";
const message = { id: "reply", role: "assistant", kind: "text", blocks, createdAt: "2026-10-01T01:00:00Z" } as CompanionMessageV1;
const advance = (ms: number) => { act(() => vi.advanceTimersByTime(ms)); act(() => vi.advanceTimersByTime(320)); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("real message blocks in floating papers", () => {
  it("expires each content type, closes its image preview, and keeps the full record and pending choice", () => {
    const chat = interactionSession({ richReply: { messageId: "reply", blocks }, proposalStates: { [proposalId]: interactionProposal() } });
    render(<><CompanionReplyPapers chat={chat} paused={false} /><section aria-label="持久对话记录"><CompanionChatRecordArticle message={message} chat={chat} /></section></>);
    expect(screen.getAllByRole("article", { name: "引用与原文" })).toHaveLength(2);
    expect(screen.getByRole("article", { name: "学习卡片" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "一起理清的步骤" })).toBeTruthy();
    expect(document.querySelectorAll(".companion-record__code")).toHaveLength(2);
    const imagePaper = screen.getByRole("article", { name: "给你看的图片" });
    fireEvent.click(imagePaper.querySelector("img")!);
    expect(screen.getByRole("button", { name: "关闭预览" })).toBeTruthy();
    expect(screen.getByRole("dialog").getAttribute("data-companion-owned")).toBe("true");
    advance(61_000);
    expect(screen.queryByRole("article", { name: "引用与原文" })).toBeNull();
    expect(screen.queryByRole("article", { name: "一起理清的步骤" })).toBeNull();
    expect(screen.getByRole("article", { name: "给你看的图片" })).toBeTruthy();
    advance(31_000);
    expect(screen.queryByRole("article", { name: "学习卡片" })).toBeNull();
    expect(screen.queryByRole("article", { name: "给你看的图片" })).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭预览" })).toBeNull();
    expect(screen.getByRole("article", { name: "等你确认" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "持久对话记录" }).querySelector("img")).toBeTruthy();
    expect(screen.getByRole("region", { name: "持久对话记录" }).querySelector(".companion-record__code")?.textContent).toContain("寻找线索");
    expect(chat.decideProposal).not.toHaveBeenCalled();
    expect(chat.dismissRichReply).toHaveBeenCalledOnce();
  });
  it("keeps actual proposal controls, expires the result, and does not revive it after rerenders", () => {
    const chat = interactionSession({ proposalStates: { [proposalId]: interactionProposal() } });
    const view = render(<CompanionReplyPapers chat={chat} paused={false} />);
    advance(240_000);
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(chat.decideProposal).toHaveBeenCalledWith(proposalId, "confirm");
    const finished = { ...chat, proposalStates: { [proposalId]: interactionProposal("succeeded") } };
    view.rerender(<CompanionReplyPapers chat={finished} paused={false} />);
    expect(screen.getByRole("article", { name: "动作结果" })).toBeTruthy();
    advance(11_000);
    expect(screen.queryByRole("article", { name: "动作结果" })).toBeNull();
    view.rerender(<CompanionReplyPapers chat={finished} paused={false} />);
    expect(screen.queryByRole("article", { name: "动作结果" })).toBeNull();
  });
  it("does not show previously completed proposals as new papers and reflects true expiry", () => {
    const chat = interactionSession({ proposalStates: { old: interactionProposal("succeeded"), [proposalId]: interactionProposal("pending", new Date(Date.now() + 2_000).toISOString()) } });
    render(<CompanionReplyPapers chat={chat} paused={false} />);
    expect(screen.getByRole("button", { name: "确认执行" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "动作结果" })).toBeNull();
    advance(2_100);
    expect(screen.queryByRole("button", { name: "确认执行" })).toBeNull();
    expect(screen.getByRole("article", { name: "动作结果" })).toBeTruthy();
    advance(11_000);
    expect(screen.queryByRole("article", { name: "动作结果" })).toBeNull();
  });
});

const navBlock: CompanionContentBlockV1 = { type: "nav", label: "去理解星图", route: { kind: "star_map" } };
const navReply = { messageId: "nav-reply", blocks: [navBlock] };
const navMessage = { id: "nav-reply", role: "assistant", kind: "text", blocks: [navBlock], createdAt: "2026-10-01T01:00:00Z" } as CompanionMessageV1;
/**
 * 「点前往 → 纸签退场」跨两段：跳转的 Promise 链（then→catch→finally）加 React 提交，
 * 之后才轮到 280ms 的退场计时器。先只跑微任务，再推时钟，否则那 280ms 还没挂上就过去了。
 */
const settle = async (ms: number) => {
  await act(async () => { for (let tick = 0; tick < 6; tick += 1) await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

describe("the 去这一页 paper", () => {
  it("faces the page from its own centered surface, not the side corridor", () => {
    render(<CompanionReplyPapers chat={interactionSession({ richReply: navReply })} paused={false} />);
    const centered = document.querySelector(".companion-hud__nav-papers");
    expect(centered?.querySelector(".companion-hud__paper")).toBeTruthy();
    expect(document.querySelector(".companion-hud__papers .companion-hud__paper")).toBeNull();
  });
  it("retires itself once the jump lands, and keeps the record", async () => {
    const chat = interactionSession({ richReply: navReply });
    render(<><CompanionReplyPapers chat={chat} paused={false} /><section aria-label="持久对话记录"><CompanionChatRecordArticle message={navMessage} chat={chat} /></section></>);
    fireEvent.click(within(screen.getByRole("article", { name: "可以接着看这里" })).getByRole("button", { name: "去理解星图" }));
    await settle(300);
    expect(chat.goToRoute).toHaveBeenCalledOnce();
    expect(screen.queryByRole("article", { name: "可以接着看这里" })).toBeNull();
    expect(chat.dismissRichReply).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "持久对话记录" }).querySelector(".companion-record__nav button")).toBeTruthy();
  });
  it("stays put, with the failure on it, when the jump does not land", async () => {
    const chat = interactionSession({ richReply: navReply, goToRoute: vi.fn(async () => { throw new Error("跳不过去"); }) });
    render(<CompanionReplyPapers chat={chat} paused={false} />);
    fireEvent.click(screen.getByRole("button", { name: "去理解星图" }));
    await settle(300);
    expect(screen.getByRole("article", { name: "可以接着看这里" })).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });
  it("is not handed out again for a page she already jumped to", () => {
    const chat = interactionSession({
      richReply: navReply,
      autoNavigatedRoutes: new Set([JSON.stringify(desktopRouteFromAgentRoute(navBlock.route))]),
    });
    render(<CompanionReplyPapers chat={chat} paused={false} />);
    expect(document.querySelector(".companion-hud__nav-papers")).toBeNull();
    expect(chat.dismissRichReply).toHaveBeenCalledOnce();
  });
});
