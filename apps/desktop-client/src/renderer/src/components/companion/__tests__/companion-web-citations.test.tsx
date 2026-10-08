// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderCompanionMarkdown } from "../companion-markdown";
import { companionWebCitations, CompanionWebSources } from "../companion-web-citations";
import { companionMessageCopyText } from "../companion-message-copy";
import { companionMessageText } from "../../../app/companion-chat-routing";
import { companionBubblePreviewText } from "../companion-bubble-reveal";

const { copied, opened } = vi.hoisted(() => ({ copied: vi.fn(async () => true), opened: vi.fn(async () => true) }));
vi.mock("../../../app/clipboard", () => ({ copyText: copied }));
vi.mock("../../../app/external-link", () => ({ openExternalLink: opened }));
const source = { type: "citation" as const, referenceId: "web-1234567890abcdef", label: "官方说明", media: "示例网站",
  target: { kind: "external_https" as const, href: "https://example.com/docs?chapter=2" }, publishDate: "2026-10-08" };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("renders inline numbers tied to saved sources; copy/open receive the exact destination", async () => {
  render(<div>{renderCompanionMarkdown(`按官方说明执行。[^${source.referenceId}]`, companionWebCitations([source]))}</div>);
  const citation = screen.getByRole("button", { name: "来源 1：官方说明" });
  expect(citation.textContent).toBe("1"); fireEvent.click(citation);
  expect(screen.getByRole("dialog", { name: "网页来源 1" })).toBeTruthy();
  fireEvent.scroll(window);
  expect(screen.getByRole("dialog", { name: "网页来源 1" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "复制链接" }));
  await waitFor(() => expect(copied).toHaveBeenCalledWith(source.target.href));
  fireEvent.click(screen.getByRole("button", { name: "浏览器打开" }));
  await waitFor(() => expect(opened).toHaveBeenCalledWith(source.target.href));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(citation);
});

it("untrusted/unknown markers cannot become citations, and code stays literal", () => {
  const view = render(<div>{renderCompanionMarkdown("正文[^web-ffffffffffffffff]；错字[^web-3c284a008b00842]；`[^web-1234567890abcdef]`", companionWebCitations([source]))}</div>);
  expect(screen.queryByRole("button")).toBeNull();
  expect(view.container.textContent).not.toContain("3c284a008b00842");
  expect(screen.getByText("[^web-1234567890abcdef]").tagName).toBe("CODE");
  expect(companionMessageCopyText({ role: "assistant", blocks: [{ type: "text", text: "说明[^web-3c284a008b00842]" }] } as never)).toBe("说明");
});

it("deduplicates sources and includes numbered original URLs when copying a reply", () => {
  const sources = companionWebCitations([source, source]); expect(sources.length).toBe(1);
  render(<CompanionWebSources sources={sources} />); expect(screen.getByText("搜索到 1 个网页")).toBeTruthy();
  expect(companionMessageCopyText({ role: "assistant", blocks: [{ type: "text", text: `说明[^${source.referenceId}]` }, source] } as never))
    .toBe(`说明[1]\n\n[1] 官方说明\n${source.target.href}`);
  expect(companionMessageText({ blocks: [{ type: "text", text: "正文" }, source] } as never)).toBe("正文");
});

it("streaming and moving previews never expose partial citation identities", () => {
  const view = render(<div data-testid="stream">{renderCompanionMarkdown("正在说明[^web-12345", companionWebCitations([source]))}</div>);
  expect(screen.getByTestId("stream").textContent).toBe("正在说明");
  view.rerender(<div data-testid="stream">{renderCompanionMarkdown(`正在说明[^${source.referenceId}]`, companionWebCitations([source]))}</div>);
  expect(screen.getByRole("button", { name: "来源 1：官方说明" })).toBeTruthy();
  const text = `前文[^${source.referenceId}]${"后".repeat(310)}`;
  const preview = companionBubblePreviewText(text, text.length);
  expect(preview).toBe(`…${"后".repeat(310)}`);
});
