// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../../../app/room-store";
import { SourceLibrarySurface } from "../source-library-surface";
import { SourceDetailSurface } from "../source-detail-surface";
import { CaptureStrip } from "../source-capture";

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });
const source = (id: string, title: string) => ({ id, title, type: "text", status: "ready", origin: null,
  workspaceId: "workspace", createdBy: "reader", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  noteCount: 0, metadata: null, cardProgress: { pendingReviewRuns: 0, activeObjectives: 0 } });
const sources = [source("first", "记忆研究"), source("second", "阅读节奏")];
const segments = [{ id: "segment-0", sourceId: "first", workspaceId: "workspace", ordinal: 0, text: "# 第一节", segmentType: "heading", charStart: 0, charEnd: 5 },
  { id: "segment-1", sourceId: "first", workspaceId: "workspace", ordinal: 1, text: "慢慢读这一段。", segmentType: "paragraph", charStart: 6, charEnd: 14 }];
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
}
function installApi() {
  const api = {
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "workspace" } })) },
    capabilities: { get: vi.fn(async () => ok({ actionCapabilities: { "source.create": "allowed", "source.update": "allowed", "source.createNote": "allowed", "source.archive": "allowed" } })) },
    source: {
      list: vi.fn(async ({ status }: { status?: string }): Promise<unknown> => ok({ items: status === "archived" ? [] : sources, total: status === "archived" ? 0 : 2, nextCursor: null })),
      get: vi.fn(async ({ sourceId }: { sourceId: string }): Promise<unknown> => ok({ source: sources.find(row => row.id === sourceId), segments })),
      listNotes: vi.fn(async (): Promise<unknown> => ok({ items: [], total: 0, nextCursor: null })),
      create: vi.fn(async (_input: { request: { url?: string; content?: string; title?: string; force?: boolean } }): Promise<unknown> => ok({ source: sources[0], segments, duplicateOf: null })),
      createNote: vi.fn(async (): Promise<unknown> => ok({ kind: "created", noteId: "note", noteVersionId: "version" })),
    },
    search: { global: vi.fn(async (): Promise<unknown> => ok({ items: [], total: 0 })) },
  };
  window.ailearn = api as unknown as typeof window.ailearn;
  return api;
}
const cards = () => [...document.querySelectorAll(".source-sheet strong")].map(node => node.textContent);
const paste = (target: Element | Document, text: string) => fireEvent.paste(target, { clipboardData: { getData: () => text } });
function capture(onCaptured = vi.fn(), onOpenExisting = vi.fn()) {
  const view = render(<CaptureStrip disabled={false} lockedReason={null} epochRef={{ current: 1 }} receipt={null}
    summary={<p>材料架</p>} onCaptured={onCaptured} onOpenExisting={onOpenExisting} />);
  return { ...view, onCaptured, onOpenExisting };
}
beforeEach(() => {
  useRoomStore.setState(state => ({ workspaceScopeRevision: state.workspaceScopeRevision + 1,
    sourceIndexTab: "all", activeSourceId: null, activeNoteRef: null, returnTarget: null, pageReadableView: null,
    noteReturnTo: "library", motionMode: "off", reducedMotion: false }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "ailearn"); });

describe("来源资料架的连续操作", () => {
  it("清空后丢弃迟到的正文检索，不重新缩窄资料架", async () => {
    const api = installApi(), pending = deferred(); api.search.global.mockReturnValueOnce(pending.promise);
    render(<SourceLibrarySurface />); await waitFor(() => expect(cards()).toHaveLength(2));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索标题或正文" }), { target: { value: "正文关键词" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    await act(async () => pending.resolve(ok({ items: [{ objectId: "first" }], total: 1 })));
    expect(cards()).toEqual(["记忆研究", "阅读节奏"]);
    expect(useRoomStore.getState().pageReadableView?.view.filters?.some(filter => filter.label === "搜索")).toBe(false);
  });

  it("连续提交不同关键词，只采用最后一份结果", async () => {
    const api = installApi(), first = deferred(), second = deferred();
    api.search.global.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<SourceLibrarySurface />); await waitFor(() => expect(cards()).toHaveLength(2));
    const input = screen.getByRole("textbox", { name: "搜索标题或正文" });
    fireEvent.change(input, { target: { value: "第一份正文" } }); fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    fireEvent.change(input, { target: { value: "第二份正文" } }); fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await act(async () => second.resolve(ok({ items: [{ objectId: "second" }], total: 1 })));
    await act(async () => first.resolve(ok({ items: [{ objectId: "first" }], total: 1 })));
    expect(cards()).toEqual(["阅读节奏"]);
  });

  it("从材料返回保留关键词和资料架位置，换工作区则不带过去", async () => {
    installApi(); const view = render(<SourceLibrarySurface />); await waitFor(() => expect(cards()).toHaveLength(2));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索标题或正文" }), { target: { value: "阅读节奏" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" })); await waitFor(() => expect(cards()).toHaveLength(1));
    const list = document.querySelector<HTMLElement>(".source-list")!; list.scrollTop = 190; fireEvent.scroll(list);
    view.unmount(); render(<SourceLibrarySurface />); await waitFor(() => expect(cards()).toHaveLength(1));
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "搜索标题或正文" }).value).toBe("阅读节奏");
    expect(document.querySelector(".source-list")?.scrollTop).toBe(190);
    act(() => useRoomStore.setState(state => ({ workspaceScopeRevision: state.workspaceScopeRevision + 1 })));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "搜索标题或正文" }).value).toBe("");
  });
});

describe("少一步的材料录入", () => {
  it("页外主动粘贴直接展开草稿，收起重开保留内容和标题", () => {
    installApi(); capture(); paste(document, "这是一份正文");
    const body = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "正文" });
    expect(body.value).toBe("这是一份正文");
    fireEvent.change(screen.getByRole("textbox", { name: /标题/ }), { target: { value: "自己的标题" } });
    fireEvent.keyDown(body, { key: "Escape" }); expect(document.activeElement).toBe(screen.getByRole("button", { name: "采集新来源" }));
    fireEvent.click(screen.getByRole("button", { name: "采集新来源" }));
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "正文" }).value).toBe("这是一份正文");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: /标题/ }).value).toBe("自己的标题");
  });

  it("在搜索字段粘贴不抢走输入，也不展开采集", async () => {
    installApi(); render(<SourceLibrarySurface />); await waitFor(() => expect(cards()).toHaveLength(2));
    paste(screen.getByRole("textbox", { name: "搜索标题或正文" }), "正在查找的词");
    expect(screen.queryByRole("dialog", { name: "采集新来源" })).toBeNull();
  });

  it("纯网址自动用链接采集，标题可留空，连续提交只发送一次", async () => {
    const api = installApi(), pending = deferred(); api.source.create.mockReturnValueOnce(pending.promise); capture();
    fireEvent.click(screen.getByRole("button", { name: "采集新来源" }));
    fireEvent.change(screen.getByRole("textbox", { name: "正文" }), { target: { value: "https://example.com/material" } });
    const form = document.querySelector("form")!; fireEvent.submit(form); fireEvent.submit(form);
    expect(api.source.create).toHaveBeenCalledTimes(1);
    expect(api.source.create.mock.calls[0][0]).toMatchObject({ request: { url: "https://example.com/material" } });
    await act(async () => pending.resolve(ok({ source: sources[0], segments, duplicateOf: null })));
  });

  it("重复材料不再留通用提交入口，打开已有来源实际进入它", async () => {
    const api = installApi(); api.source.create.mockResolvedValueOnce(ok({ source: sources[0], segments,
      duplicateOf: { sourceId: "first", title: "记忆研究", createdAt: sources[0].createdAt, status: "ready" } }));
    render(<SourceLibrarySurface />); await waitFor(() => expect(cards()).toHaveLength(2)); paste(document, "重复正文");
    fireEvent.click(screen.getByRole("button", { name: "开始解析" }));
    const open = await screen.findByRole("button", { name: "打开已有来源" });
    expect(screen.queryByRole("button", { name: "开始解析" })).toBeNull();
    fireEvent.submit(document.querySelector(".capture-form")!); expect(api.source.create).toHaveBeenCalledTimes(1);
    fireEvent.click(open); expect(useRoomStore.getState().activeSourceId).toBe("first");
    expect(useRoomStore.getState().returnTarget?.label).toBe("返回来源库");
  });

  it("文件读完后不覆盖标题，也不抢走正在输入标题的焦点", async () => {
    installApi(); capture(); const pending = deferred();
    const file = new File(["content"], "source.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: () => pending.promise });
    fireEvent.change(screen.getByLabelText("文本文件"), { target: { files: [file] } });
    const title = screen.getByRole<HTMLInputElement>("textbox", { name: /标题/ });
    title.focus(); fireEvent.change(title, { target: { value: "自己的标题" } });
    await act(async () => pending.resolve("文件正文"));
    const body = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "正文" });
    expect(body.value).toBe("文件正文");
    expect(title.value).toBe("自己的标题");
    expect(document.activeElement).toBe(title);
  });

  it("文件选择器交回页面焦点后，读完立即聚焦正文", async () => {
    installApi(); capture(); const pending = deferred();
    const file = new File(["content"], "source.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: () => pending.promise });
    fireEvent.change(screen.getByLabelText("文本文件"), { target: { files: [file] } });
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "正文" }).blur();
    await act(async () => pending.resolve("文件正文"));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "正文" }));
  });

  it("文件读取晚于收起操作时，不重新打开附页", async () => {
    installApi(); capture(); const pending = deferred();
    const file = new File(["content"], "材料.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: () => pending.promise });
    fireEvent.change(screen.getByLabelText("文本文件"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "收起采集" }));
    await act(async () => pending.resolve("迟到的文件正文"));
    expect(screen.queryByRole("dialog", { name: "采集新来源" })).toBeNull();
  });
});

describe("原文与附页", () => {
  it("与材料标题相同的第一个标题只排一次，但仍是可定位的真实片段", async () => {
    const api = installApi();
    api.source.get.mockResolvedValueOnce(ok({ source: sources[0], segments: [{ ...segments[0], text: "# 记忆研究" }, segments[1]] }));
    useRoomStore.setState({ activeSourceId: "first" }); render(<SourceDetailSurface />);
    await screen.findByRole("heading", { name: "记忆研究", level: 2 });
    expect(screen.getAllByRole("heading", { name: "记忆研究" })).toHaveLength(1);
    const target = document.querySelector<HTMLElement>("[data-source-segment='segment-0']")!;
    expect(target.textContent).toBe("记忆研究");
    target.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: "片段 2" }));
    fireEvent.click(screen.getByRole("button", { name: /小标题.*记忆研究/ }));
    expect(document.activeElement).toBe(target);
  });

  it("只有一篇关联笔记也能打开，并记录返回来源的路径", async () => {
    const api = installApi(); api.source.listNotes.mockResolvedValueOnce(ok({ items: [{ id: "note", title: "我的笔记", currentVersionId: "version", updatedAt: sources[0].updatedAt }], total: 1 }));
    useRoomStore.setState({ activeSourceId: "first" }); render(<SourceDetailSurface />);
    fireEvent.click(await screen.findByRole("button", { name: "笔记 1" }));
    fireEvent.click(screen.getByRole("button", { name: /《我的笔记》/ }));
    expect(useRoomStore.getState().activeNoteRef).toMatchObject({ noteId: "note", noteVersionId: "version", mode: "preview" });
    expect(useRoomStore.getState().returnTarget?.label).toBe("返回来源资料");
    expect(useRoomStore.getState().activeSourceId).toBeNull();
    act(() => useRoomStore.getState().returnTarget?.run());
    expect(useRoomStore.getState().activeSourceId).toBe("first");
    expect(useRoomStore.getState().returnTarget?.label).toBe("返回来源库");
  });

  it("片段跳转收起附页，直接滚到原句并移交焦点", async () => {
    installApi(); useRoomStore.setState({ activeSourceId: "first" }); render(<SourceDetailSurface />);
    fireEvent.click(await screen.findByRole("button", { name: "片段 2" }));
    const target = document.querySelector<HTMLElement>("[data-source-segment='segment-1']")!;
    const scroll = vi.fn(); target.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole("button", { name: /慢慢读这一段/ }));
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
    expect(document.activeElement).toBe(target); expect(target.dataset.selected).toBe("true");
    expect(screen.getByRole("button", { name: "片段 2" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("静默刷新保留原文节点、阅读位置和已打开的附页", async () => {
    const api = installApi(); useRoomStore.setState({ activeSourceId: "first" }); render(<SourceDetailSurface />);
    const paper = await screen.findByRole("article", { name: "来源正文" }); paper.scrollTop = 220; fireEvent.scroll(paper);
    fireEvent.click(screen.getByRole("button", { name: "片段 2" }));
    const pending = deferred(); api.source.get.mockReturnValueOnce(pending.promise); fireEvent(window, new Event("focus"));
    await waitFor(() => expect(api.source.get).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("article", { name: "来源正文" })).toBe(paper); expect(paper.scrollTop).toBe(220);
    expect(screen.queryByText("正在读取来源详情")).toBeNull();
    await act(async () => pending.resolve(ok({ source: sources[0], segments })));
    expect(screen.getByRole("article", { name: "来源正文" })).toBe(paper); expect(paper.scrollTop).toBe(220);
    expect(screen.getByRole("button", { name: "片段 2" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("另一份来源打开后，旧来源的迟到建笔记结果不抢回导航", async () => {
    const api = installApi(), pending = deferred(); api.source.createNote.mockReturnValueOnce(pending.promise);
    useRoomStore.setState({ activeSourceId: "first" }); render(<SourceDetailSurface />);
    fireEvent.click(await screen.findByRole("button", { name: "开始写笔记" }));
    act(() => useRoomStore.setState({ activeSourceId: "second" }));
    await screen.findByRole("heading", { name: "阅读节奏", level: 2 });
    await act(async () => pending.resolve(ok({ kind: "created", noteId: "old-note", noteVersionId: "old-version" })));
    expect(useRoomStore.getState().activeNoteRef).toBeNull(); expect(useRoomStore.getState().activeSourceId).toBe("second");
  });
});
