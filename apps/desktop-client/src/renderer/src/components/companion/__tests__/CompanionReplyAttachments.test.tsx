// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionContentBlockV1 } from "@astella/shared/companion-conversation-contracts";
import { desktopRouteFromAgentRoute } from "../../../app/companion-chat-session";
import { CompanionReplyAttachments } from "../CompanionReplyAttachments";
import { interactionSession } from "./companion-interaction-fixtures";
import { useSourceImage } from "../../surfaces/source/source-image";
import { copyText } from "../../../app/clipboard";

vi.mock("../../surfaces/source/source-image", () => ({ useSourceImage: vi.fn() }));
vi.mock("../../../app/clipboard", () => ({ copyText: vi.fn() }));

const note: CompanionContentBlockV1 = { type: "quote", label: "《中国朝代历程总揽》· 7 小时前", text: "# 先秦\n\n| 朝代 | 年代 |\n| --- | --- |\n| 夏 | 约前2070年 |" };
const other: CompanionContentBlockV1 = { type: "quote", label: "《中国近代史总揽》", text: "从鸦片战争到新中国成立。" };
const nav: Extract<CompanionContentBlockV1, { type: "nav" }> = { type: "nav", label: "打开《中国古代史总揽》", route: { kind: "note", noteId: "created-note" } };
const open = (details: HTMLDetailsElement, value = true) => act(() => {
  details.open = value;
  fireEvent(details, new Event("toggle"));
});
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const image: CompanionContentBlockV1 = { type: "image", url: "/api/uploads/example.png", label: "注意力示意图" };
const code: CompanionContentBlockV1 = { type: "code", language: "python", code: "output = weights @ values\nprint(output)" };
const diagram: CompanionContentBlockV1 = { type: "diagram", title: "理解步骤", steps: [{ label: "找线索", detail: "比较 **Query** 与 Key。" }, { label: "核对相关程度" }] };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.mocked(useSourceImage).mockReturnValue({ state: { status: "ready", src: "blob:test" }, retry: vi.fn(), reload: vi.fn() });
  vi.mocked(copyText).mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("one reply delivery", () => {
  it("leads with the created note, keeps material closed and deduplicates repeated reads", () => {
    render(<CompanionReplyAttachments chat={interactionSession({ richReply: { messageId: "one", blocks: [note, other, note, nav] } })} paused={false} onDismiss={vi.fn()} />);
    expect(screen.getByRole("button", { name: nav.label })).toBeTruthy();
    const materials = document.querySelector<HTMLDetailsElement>(".companion-reply-attachments__materials")!;
    expect(materials.open).toBe(false);
    expect(within(materials).getByText("2", { selector: "small" })).toBeTruthy();
    expect(screen.queryByText("从鸦片战争到新中国成立。")).toBeNull();
    open(materials);
    const excerpt = screen.getByText(note.label, { selector: "summary > span" }).closest("details") as HTMLDetailsElement;
    expect(excerpt.open).toBe(false);
    open(excerpt);
    expect(screen.getByRole("heading", { name: "先秦" })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("cell", { name: "约前2070年" })).toBeTruthy();
  });

  it("pauses retirement while reading, resumes after folding and never closes the saved record", () => {
    const onDismiss = vi.fn();
    render(<CompanionReplyAttachments chat={interactionSession({ richReply: { messageId: "one", blocks: [note, nav] } })} paused={false} onDismiss={onDismiss} />);
    advance(50_000);
    const materials = document.querySelector<HTMLDetailsElement>(".companion-reply-attachments__materials")!;
    open(materials);
    advance(240_000);
    expect(onDismiss).not.toHaveBeenCalled();
    open(materials, false);
    advance(11_000);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("opens actual destinations and retires the delivery only after success", async () => {
    const onDismiss = vi.fn();
    const goToRoute = vi.fn(async () => undefined);
    render(<CompanionReplyAttachments chat={interactionSession({ richReply: { messageId: "one", blocks: [nav] }, goToRoute })} paused={false} onDismiss={onDismiss} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: nav.label })));
    expect(goToRoute).toHaveBeenCalledWith({ kind: "note.detail", noteId: "created-note" });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps the destination and failure in place, and allows retry", async () => {
    const onDismiss = vi.fn();
    const goToRoute = vi.fn().mockRejectedValueOnce(new Error("跳不过去")).mockResolvedValueOnce(undefined);
    render(<CompanionReplyAttachments chat={interactionSession({ richReply: { messageId: "one", blocks: [nav] }, goToRoute })} paused={false} onDismiss={onDismiss} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: nav.label })));
    expect(screen.getByRole("status")).toBeTruthy();
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: nav.label })));
    expect(goToRoute).toHaveBeenCalledTimes(2);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("does not ask to open an already visited destination or leak preceding material into a new reply", () => {
    function Harness() {
      const [second, setSecond] = useState(false);
      const chat = interactionSession({ richReply: second ? { messageId: "two", blocks: [other] } : { messageId: "one", blocks: [note, nav] },
        autoNavigatedRoutes: new Set([JSON.stringify(desktopRouteFromAgentRoute(nav.route))]) });
      return <><button onClick={() => setSecond(true)}>下一轮</button><CompanionReplyAttachments key={chat.richReply?.messageId} chat={chat} paused={false} onDismiss={vi.fn()} /></>;
    }
    render(<Harness />);
    expect(screen.queryByRole("button", { name: nav.label })).toBeNull();
    open(document.querySelector<HTMLDetailsElement>(".companion-reply-attachments__materials")!);
    expect(screen.getByText(note.label, { selector: "summary > span" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一轮" }));
    expect(document.querySelector<HTMLDetailsElement>(".companion-reply-attachments__materials")?.open).toBe(false);
    open(document.querySelector<HTMLDetailsElement>(".companion-reply-attachments__materials")!);
    expect(screen.queryByText(note.label)).toBeNull();
    expect(screen.getByText(other.label, { selector: "summary > span" })).toBeTruthy();
  });

  it("retires an empty delivery after automatic navigation without dismissing the spoken reply", () => {
    const dismissRichReply = vi.fn();
    const onDismiss = vi.fn();
    render(<CompanionReplyAttachments chat={interactionSession({
      richReply: { messageId: "opened", blocks: [nav] }, dismissRichReply,
      autoNavigatedRoutes: new Set([JSON.stringify(desktopRouteFromAgentRoute(nav.route))]),
    })} paused={false} onDismiss={onDismiss} />);
    expect(document.querySelector(".companion-reply-attachments")).toBeNull();
    expect(dismissRichReply).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("shows the image immediately, pages through unique objects and copies the original code", async () => {
    render(<CompanionReplyAttachments chat={interactionSession({ richReply: { messageId: "rich", blocks: [image, code, image, diagram] } })} paused={false} onDismiss={vi.fn()} />);
    expect(screen.getByRole("img", { name: image.label })).toBeTruthy();
    expect(screen.getByText("1 / 3 · 图片")).toBeTruthy();
    expect(screen.getByRole("button", { name: "上一份内容" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "下一份内容" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector("pre code")?.textContent).toBe(code.code);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制代码" })));
    expect(copyText).toHaveBeenCalledWith(code.code);
    expect(screen.getByText("代码已复制")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一份内容" }));
    expect(screen.getByText("理解步骤")).toBeTruthy();
    expect(screen.getByText("Query", { selector: "strong" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "下一份内容" }).hasAttribute("disabled")).toBe(true);
  });

  it("pauses the reply throughout fullscreen viewing and restores keyboard focus on close", () => {
    const onDismiss = vi.fn();
    render(<CompanionReplyAttachments chat={interactionSession({ richReply: { messageId: "rich", blocks: [image] } })} paused={false} onDismiss={onDismiss} />);
    advance(50_000);
    const trigger = screen.getByRole("button", { name: `放大查看：${image.label}` });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog").parentElement).toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭预览" }));
    advance(180_000);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    advance(13_000);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps the caption on loading/error and connects manual retries", () => {
    const reload = vi.fn();
    vi.mocked(useSourceImage).mockReturnValue({ state: { status: "loading" }, retry: vi.fn(), reload });
    const chat = interactionSession({ richReply: { messageId: "rich", blocks: [image] } });
    const view = render(<CompanionReplyAttachments chat={chat} paused={false} onDismiss={vi.fn()} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(image.label)).toBeTruthy();
    vi.mocked(useSourceImage).mockReturnValue({ state: { status: "unavailable" }, retry: vi.fn(), reload });
    view.rerender(<CompanionReplyAttachments chat={chat} paused={false} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("pauses expanded reading, returns the next object to a compact preview and reports copy failure", async () => {
    const onDismiss = vi.fn();
    vi.mocked(copyText).mockResolvedValue(false);
    render(<CompanionReplyAttachments chat={interactionSession({ richReply: { messageId: "rich", blocks: [diagram, code] } })} paused={false} onDismiss={onDismiss} />);
    advance(50_000);
    fireEvent.click(screen.getByRole("button", { name: "展开阅读" }));
    advance(180_000);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "下一份内容" }));
    expect(screen.getByRole("button", { name: "展开阅读" }).getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "复制代码" })));
    expect(screen.getByText("没能复制，请再试一次。")).toBeTruthy();
    expect(screen.queryByText("代码已复制")).toBeNull();
    advance(13_000);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("starts a new reply at its first object with no preceding viewer or expanded state", () => {
    const view = render(<CompanionReplyAttachments chat={interactionSession({ richReply: { messageId: "one", blocks: [image, code] } })} paused={false} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: `放大查看：${image.label}` }));
    view.rerender(<CompanionReplyAttachments chat={interactionSession({ richReply: { messageId: "two", blocks: [diagram, image] } })} paused={false} onDismiss={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("1 / 2 · 步骤图")).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开阅读" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps an open viewer visible during image recovery", () => {
    const reload = vi.fn();
    const chat = interactionSession({ richReply: { messageId: "one", blocks: [image] } });
    const view = render(<CompanionReplyAttachments chat={chat} paused={false} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: `放大查看：${image.label}` }));
    vi.mocked(useSourceImage).mockReturnValue({ state: { status: "unavailable" }, retry: vi.fn(), reload });
    view.rerender(<CompanionReplyAttachments chat={chat} paused={false} onDismiss={vi.fn()} />);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "重试" }));
    expect(reload).toHaveBeenCalledOnce();
    vi.mocked(useSourceImage).mockReturnValue({ state: { status: "loading" }, retry: vi.fn(), reload });
    view.rerender(<CompanionReplyAttachments chat={chat} paused={false} onDismiss={vi.fn()} />);
    expect(within(screen.getByRole("dialog")).getByText("正在载入图片…")).toBeTruthy();
  });
});
