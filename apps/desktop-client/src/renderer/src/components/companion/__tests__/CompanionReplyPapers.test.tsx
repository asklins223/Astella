// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionContentBlockV1, CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
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
  it("leaves reply blocks with the reply rather than creating independent papers", () => {
    const chat = interactionSession({ richReply: { messageId: "reply", blocks }, proposalStates: { [proposalId]: interactionProposal() } });
    render(<><CompanionReplyPapers chat={chat} paused={false} /><section aria-label="持久对话记录"><CompanionChatRecordArticle message={message} chat={chat} /></section></>);
    expect(document.querySelectorAll(".companion-hud__paper")).toHaveLength(1);
    expect(screen.getByRole("article", { name: "等你确认" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "引用与原文" })).toBeNull();
    advance(240_000);
    expect(screen.getByRole("region", { name: "持久对话记录" }).querySelector("img")).toBeTruthy();
    expect(screen.getByRole("region", { name: "持久对话记录" }).querySelector(".companion-record__code")?.textContent).toContain("寻找线索");
    expect(chat.dismissRichReply).not.toHaveBeenCalled();
    expect(chat.decideProposal).not.toHaveBeenCalled();
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
  it("keeps historical snapshot hydration quiet, including loading failures and expired pending snapshots", () => {
    const chat = interactionSession({ mode: "history", proposalStates: { old: { phase: "loading" }, older: { phase: "loading" } } });
    const view = render(<CompanionReplyPapers chat={chat} paused />);
    expect(screen.queryByRole("article")).toBeNull();
    view.rerender(<CompanionReplyPapers chat={{ ...chat, proposalStates: { old: interactionProposal("expired"), older: { phase: "error", message: "读取失败" } } }} paused />);
    view.rerender(<CompanionReplyPapers chat={{ ...chat, mode: "closed", proposalStates: { old: interactionProposal("pending", new Date(Date.now() - 60_000).toISOString()), older: interactionProposal("succeeded") } }} paused={false} />);
    expect(screen.queryByRole("article")).toBeNull();
  });
  it("shows one real decision at a time, then groups the batch into a short receipt", () => {
    const proposalIds = ["one", "two", "three"];
    const chat = interactionSession({ liveReply: { messageId: "new", text: "有几件事等你确认", hasActionBlocks: true, proposalIds }, proposalStates: Object.fromEntries(proposalIds.map(id => [id, interactionProposal()])) });
    const view = render(<CompanionReplyPapers chat={chat} paused={false} />);
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("1 / 3 项")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一项待处理动作" }));
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(chat.decideProposal).toHaveBeenCalledWith("two", "confirm");
    view.rerender(<CompanionReplyPapers chat={{ ...chat, proposalStates: { one: interactionProposal("succeeded"), two: interactionProposal("rejected"), three: interactionProposal() } }} paused={false} />);
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByRole("article", { name: "等你确认" }).textContent).toContain("已完成 1 项 · 已跳过 1 项");
    const finished = { ...chat, proposalStates: { one: interactionProposal("succeeded"), two: interactionProposal("rejected"), three: interactionProposal("expired") } };
    view.rerender(<CompanionReplyPapers chat={finished} paused={false} />);
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("已完成 1 项 · 已跳过 1 项 · 已过期 1 项")).toBeTruthy();
    expect(screen.queryByText("目标")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看对话记录" }));
    expect(chat.setMode).toHaveBeenCalledWith("history");
    advance(11_000);
    view.rerender(<CompanionReplyPapers chat={finished} paused={false} />);
    expect(screen.queryByRole("article")).toBeNull();
  });
  it("keeps an executing action and a failed receipt available without treating either as completed", () => {
    const chat = interactionSession({ liveReply: { messageId: "new", text: "处理中", hasActionBlocks: true, proposalIds: ["live"] }, proposalStates: { live: interactionProposal("executing") } });
    const view = render(<CompanionReplyPapers chat={chat} paused={false} />);
    advance(120_000);
    expect(screen.getByRole("article", { name: "正在执行" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "确认执行" })).toBeNull();
    view.rerender(<CompanionReplyPapers chat={{ ...chat, proposalStates: { live: interactionProposal("failed") } }} paused={false} />);
    advance(120_000);
    expect(screen.getByText("执行失败 1 项")).toBeTruthy();
    expect(screen.queryByText(/Infinity/)).toBeNull();
  });
  it("continues keyboard focus on the next decision and receipt, without taking focus from the page", () => {
    const chat = interactionSession({ proposalStates: { one: interactionProposal(), two: interactionProposal() } });
    const view = render(<><input aria-label="页面内容" /><CompanionReplyPapers chat={chat} paused={false} /></>);
    act(() => screen.getByRole("button", { name: "确认执行" }).focus());
    const firstDone = { ...chat, proposalStates: { one: interactionProposal("succeeded"), two: interactionProposal() } };
    view.rerender(<><input aria-label="页面内容" /><CompanionReplyPapers chat={firstDone} paused={false} /></>);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "确认执行" }));
    const finished = { ...chat, proposalStates: { one: interactionProposal("succeeded"), two: interactionProposal("succeeded") } };
    view.rerender(<><input aria-label="页面内容" /><CompanionReplyPapers chat={finished} paused={false} /></>);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "查看对话记录" }));
    act(() => screen.getByRole("textbox", { name: "页面内容" }).focus());
    view.rerender(<><input aria-label="页面内容" /><CompanionReplyPapers chat={{ ...finished, proposalStates: { ...finished.proposalStates, later: interactionProposal() } }} paused={false} /></>);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "页面内容" }));
  });
});
