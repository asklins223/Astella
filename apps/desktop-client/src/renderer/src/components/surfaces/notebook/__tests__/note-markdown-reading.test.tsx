// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReadingBlock } from "../notebook-reading-block";
import { noteReadingText } from "../note-reading-text";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import { noteLinkHref } from "@astella/shared/note-markdown";
import { useRoomStore } from "../../../../app/room-store";

const diagram = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 856 251"><text>图</text></svg>' })) }));
vi.mock("mermaid", () => ({ default: diagram }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("同段多图在阅读态保留并排比例、说明、目的链接与批注字符流", () => {
  const content = '<img src="https://example.com/a.png" alt="甲图" width="240" /> <a href="https://example.com/detail"><img src="https://example.com/b.png" alt="乙图" width="120" /></a>';
  const view = render(<ReadingBlock block={{ type: "paragraph", ordinal: 0, content }} mark={null} />);
  const row = view.container.querySelector(".note-image-row");
  expect(row?.querySelectorAll("img")).toHaveLength(2);
  expect(view.getByAltText("甲图").closest<HTMLElement>(".note-html-image")?.style.getPropertyValue("--note-image-width")).toBe("240");
  expect(view.getByAltText("乙图").closest<HTMLElement>(".note-html-image")?.style.getPropertyValue("--note-image-width")).toBe("120");
  expect(view.getByAltText("乙图").closest("a")?.getAttribute("href")).toBe("https://example.com/detail");
  expect(noteReadingText(view.container.querySelector("[data-note-block-content]")!)).toBe("");
});

it("HTML 图像尺寸、徽章链接、嵌套强调与表格按真实元素呈现", () => {
  const content = '<div align="center"><img src="https://example.com/logo.png" width="96" height="96" alt="标志" /></div>\n\n[![徽章](https://example.com/badge.png)](https://example.com)\n\n**重点 *强调***\n\n| 左 | 右 |\n| :--- | ---: |\n| 一 | 二 |';
  const view = render(<ReadingBlock block={{ type: "paragraph", ordinal: 0, content }} mark={null} />);
  expect(view.getByAltText("标志").closest(".note-html-image")?.getAttribute("style")).toContain("width: 96px");
  expect(view.getByAltText("徽章").closest("a")?.getAttribute("href")).toBe("https://example.com");
  expect(view.container.querySelector("strong em")?.textContent).toBe("强调");
  expect(view.container.querySelectorAll("table tr")).toHaveLength(2);
  const root = view.container.querySelector("[data-note-block-content]")!;
  expect(noteReadingText(root)).toBe(noteBlockRenderedTextV1("paragraph", content));
});

it("图片块中的徽章点击打开目的链接，保留图片画廊的独立开关", async () => {
  const openExternal = vi.fn(async () => ({ ok: true })), gallery = vi.fn();
  window.astella = { shell: { openExternal } } as never;
  const view = render(<ReadingBlock block={{ type: "image", ordinal: 0, content: '[![版本](https://example.com/version.svg)](https://example.com/release)' }} mark={null} gallery={{start: 0, openAt: gallery, close: vi.fn()}} />);
  fireEvent.click(view.getByAltText("版本"));
  await waitFor(() => expect(openExternal).toHaveBeenCalledWith(expect.objectContaining({request: {url: "https://example.com/release"}})));
  expect(gallery).not.toHaveBeenCalled();
  expect(noteReadingText(view.container.querySelector("[data-note-block-content]")!)).toBe("");
});

it("Mermaid 会生成图表，错误时保留源码，图形不改变批注字符流", async () => {
  const content = '```mermaid\nflowchart LR\nA --> B\n```';
  const view = render(<ReadingBlock block={{ type: "code", ordinal: 0, content }} mark={null} />);
  await waitFor(() => expect(view.getByAltText("Mermaid 图表").getAttribute("src")).toMatch(/^data:image\/svg\+xml/));
  const svg = decodeURIComponent(view.getByAltText("Mermaid 图表").getAttribute("src")!.split(",")[1]!);
  expect(svg).toContain('width="856" height="251"');
  expect(diagram.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", startOnLoad: false, htmlLabels: false }));
  expect(noteReadingText(view.container.querySelector("[data-note-block-content]")!)).toBe("flowchart LR\nA --> B");
  diagram.render.mockRejectedValueOnce(new Error("invalid"));
  view.rerender(<ReadingBlock block={{ type: "code", ordinal: 0, content: '```mermaid\ninvalid\n```' }} mark={null} />);
  await waitFor(() => expect(view.getByText("图表没能绘制，请核对下面的 Mermaid 源码。")).toBeTruthy());
  expect(view.container.querySelector("details")?.open).toBe(true);
});

it("库内 ID 链接核对可访问笔记后跳转；失效链接就地说明", async () => {
  const noteId = "11111111-4111-4111-8111-111111111111";
  const sourceNote = { noteId: "22222222-4222-4222-8222-222222222222", noteVersionId: null, mode: "preview" as const };
  const invoke = vi.fn();
  useRoomStore.setState({ activeNoteRef: sourceNote, invoke, workspaceScopeRevision: 1, returnTarget: null });
  window.astella = { note: { get: vi.fn(async () => ({ ok: true, data: { noteId, currentVersionId: null } })) } } as never;
  const view = render(<ReadingBlock block={{ type: "paragraph", ordinal: 0, content: `[另一篇](${noteLinkHref(noteId)})` }} mark={null} />);
  fireEvent.click(view.getByRole("link", { name: "另一篇" }));
  await waitFor(() => expect(useRoomStore.getState().activeNoteRef?.noteId).toBe(noteId));
  expect(useRoomStore.getState().returnTarget?.label).toBe("返回上一篇笔记");
  useRoomStore.getState().returnTarget!.run();
  expect(useRoomStore.getState().activeNoteRef).toEqual(sourceNote);
  (window.astella.note.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false });
  fireEvent.click(view.getByRole("link", { name: "另一篇" }));
  await waitFor(() => expect(view.getByRole("status").textContent).toContain("没有访问权限"));
});
