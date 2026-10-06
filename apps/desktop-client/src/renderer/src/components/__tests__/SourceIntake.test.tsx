// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardLinkPrompt, GlobalDropOverlay } from "../SourceIntake.tsx";
import {
  NOTE_PAPER_IMAGE_DROP_ATTR,
  SOURCE_CAPTURED_EVENT,
  type SourceCapturedDetail,
} from "../../app/source-intake.ts";
import { useRoomStore } from "../../app/room-store.ts";

/**
 * 跨页面收录的合同：
 * - 弹窗确认后走 source.create（url 原样），成功广播收录事件，不强制跳页面；
 * - 没有采集权限时主键禁用并说清原因，不发请求；
 * - 全局拖入文本文件自动收进来源库，报告里点名每份的去向。
 */

const TEST_URL = "https://example.com/deep-dive";

function stubDialog() {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & {
    showModal?: () => void;
    close?: () => void;
  };
  if (typeof proto.showModal === "function") {
    vi.spyOn(proto, "showModal").mockImplementation(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
  } else {
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (typeof proto.close === "function") {
    vi.spyOn(proto, "close").mockImplementation(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
  } else {
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
}

function stubGateway(options: { capture?: "allowed" | "denied"; createTitle?: string; createWait?: Promise<void> } = {}) {
  const calls = { create: [] as unknown[] };
  const gateway = {
    capabilities: {
      get: async () => ({
        ok: true,
        data: { actionCapabilities: { "source.create": options.capture ?? "allowed" } },
      }),
    },
    source: {
      create: async (input: unknown) => {
        calls.create.push(input);
        await options.createWait;
        return {
          ok: true,
          data: { source: { id: "source-1", title: options.createTitle ?? "深潜" } },
        };
      },
    },
  };
  window.astella = gateway as unknown as typeof window.astella;
  return calls;
}

beforeEach(() => {
  stubDialog();
  useRoomStore.setState({ surface: null, motionMode: "off", reducedMotion: false, returnTarget: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useRoomStore.setState({ surface: null });
});

describe("ClipboardLinkPrompt", () => {
  it("确认后用原链接创建来源并广播，留在原地不跳页", async () => {
    const calls = stubGateway();
    const seen: boolean[] = [];
    const captured: SourceCapturedDetail[] = [];
    const onCaptured = (event: Event) => captured.push((event as CustomEvent<SourceCapturedDetail>).detail);
    window.addEventListener(SOURCE_CAPTURED_EVENT, onCaptured);
    try {
      render(<ClipboardLinkPrompt url={TEST_URL} onClose={(value) => seen.push(value)} />);
      const primary = await screen.findByRole("button", { name: "开始解析" });
      await waitFor(() => expect((primary as HTMLButtonElement).disabled).toBe(false));
      expect(primary).toBeTruthy();
      fireEvent.click(primary);
      await screen.findByText("已经收下啦");
      expect(calls.create).toHaveLength(1);
      expect(calls.create[0]).toMatchObject({ request: { url: TEST_URL } });
      expect(captured).toEqual([{ sourceId: "source-1", title: "深潜" }]);
      // 成功态不强制导航：用户点"好"才关，之前一直在原页面。
      expect(useRoomStore.getState().surface).toBeNull();
      expect(seen).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "好" }));
      expect(seen).toEqual([true]);
    } finally {
      window.removeEventListener(SOURCE_CAPTURED_EVENT, onCaptured);
    }
  });

  it("没有采集权限时主键禁用并说清原因", async () => {
    const calls = stubGateway({ capture: "denied" });
    render(<ClipboardLinkPrompt url={TEST_URL} onClose={() => undefined} />);
    await screen.findByText("只有工作区所有者可以采集来源，这条链接先不收。");
    const primary = await screen.findByRole("button", { name: "开始解析" });
    expect((primary as HTMLButtonElement).disabled).toBe(true);
    expect(calls.create).toHaveLength(0);
  });

  it("成功后的打开按钮进入这份材料而不是整个来源库", async () => {
    stubGateway();
    render(<ClipboardLinkPrompt url={TEST_URL} onClose={() => undefined} />);
    const primary = await screen.findByRole("button", { name: "开始解析" });
    await waitFor(() => expect((primary as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(primary);
    fireEvent.click(await screen.findByRole("button", { name: "打开这份材料" }));
    expect(useRoomStore.getState().activeSourceId).toBe("source-1");
    expect(useRoomStore.getState().surface).toBe("source-detail");
    act(() => useRoomStore.getState().returnTarget?.run());
    expect(useRoomStore.getState().surface).toBe("source-library");
  });

  it.each(["cancel", "unmount", "workspace"])("%s 后忽略迟到的采集结果，也不重复提交", async reason => {
    let release!: () => void;
    const createWait = new Promise<void>(resolve => { release = resolve; });
    const calls = stubGateway({ createWait });
    const captured = vi.fn();
    window.addEventListener(SOURCE_CAPTURED_EVENT, captured);
    try {
      const view = render(<ClipboardLinkPrompt url={TEST_URL} onClose={() => undefined} />);
      const primary = await screen.findByRole("button", { name: "开始解析" });
      await waitFor(() => expect((primary as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(primary);
      fireEvent.click(primary);
      expect(calls.create).toHaveLength(1);
      if (reason === "cancel") fireEvent(screen.getByRole("dialog"), new Event("cancel"));
      else if (reason === "unmount") view.unmount();
      else act(() => useRoomStore.setState(state => ({ workspaceScopeRevision: state.workspaceScopeRevision + 1 })));
      await act(async () => { release(); await createWait; });
      expect(captured).not.toHaveBeenCalled();
      expect(screen.queryByText("已经收下啦")).toBeNull();
    } finally {
      window.removeEventListener(SOURCE_CAPTURED_EVENT, captured);
    }
  });
});

describe("GlobalDropOverlay", () => {
  it.each(["file", "create"])("切换空间后忽略迟到的 %s，不把剩余材料收进新空间", async reason => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const calls = stubGateway(reason === "create" ? { createWait: pending } : {});
    render(<GlobalDropOverlay />);
    const first = new File(["body"], "first.md"), second = new File(["body"], "second.md");
    Object.defineProperty(first, "text", { value: async () => { if (reason === "file") await pending; return "first body"; } });
    Object.defineProperty(second, "text", { value: async () => "second body" });
    const transfer = { files: [first, second], types: ["Files"], getData: () => "", dropEffect: "none" };
    fireEvent.dragEnter(document.body, { dataTransfer: transfer });
    fireEvent.drop(document.body, { dataTransfer: transfer });
    if (reason === "create") await waitFor(() => expect(calls.create).toHaveLength(1));
    act(() => useRoomStore.setState(state => ({ workspaceScopeRevision: state.workspaceScopeRevision + 1 })));
    await act(async () => { release(); await pending; });
    expect(calls.create).toHaveLength(reason === "create" ? 1 : 0);
    expect(screen.queryByText("收好了")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("拖入文本文件自动收进来源库并点名报告", async () => {
    const calls = stubGateway({ createTitle: "拖入的笔记" });
    render(<GlobalDropOverlay />);
    const file = new File(["# 拖入的正文"], "note.md", { type: "text/markdown" });
    // jsdom 的 File 没有可用的 text()，桩掉实例方法；读失败分支由组件内的
    // try/catch 覆盖，这里只验证"读出 → 创建 → 报告"的 happy path。
    Object.defineProperty(file, "text", { value: async () => "# 拖入的正文" });
    const transfer = {
      files: [file],
      types: ["Files"],
      getData: () => "",
      dropEffect: "none" as const,
    };
    fireEvent.dragEnter(document.body, { dataTransfer: transfer });
    expect(await screen.findByText("松开，收进来源库")).toBeTruthy();
    fireEvent.drop(document.body, { dataTransfer: transfer });
    await screen.findByText("收好了");
    expect(screen.getByText("note.md")).toBeTruthy();
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({ request: { content: "# 拖入的正文", title: "note" } });
    fireEvent.click(screen.getByRole("button", { name: /去来源库看看/ }));
    expect(useRoomStore.getState().surface).toBe("source-library");
  });

  it("不支持的文件点名说清，不发请求", async () => {
    const calls = stubGateway();
    render(<GlobalDropOverlay />);
    const file = new File(["%PDF"], "deck.pdf", { type: "application/pdf" });
    const transfer = {
      files: [file],
      types: ["Files"],
      getData: () => "",
      dropEffect: "none" as const,
    };
    fireEvent.dragEnter(document.body, { dataTransfer: transfer });
    expect(await screen.findByText("松开，收进来源库")).toBeTruthy();
    fireEvent.drop(document.body, { dataTransfer: transfer });
    await screen.findByText("这次没收进来");
    expect(screen.getByText("deck.pdf")).toBeTruthy();
    expect(calls.create).toHaveLength(0);
  });

  /**
   * 笔记编辑页的纸面：`notebook-surface` 在编辑态挂上归属属性，采集器只认它。
   * 这里不渲染整个 surface，只要那一格 DOM 长得对。
   */
  function withNotePaper() {
    const paper = document.createElement("div");
    paper.setAttribute(NOTE_PAPER_IMAGE_DROP_ATTR, "");
    const spot = document.createElement("span");
    paper.appendChild(spot);
    document.body.appendChild(paper);
    return {
      spot,
      dispose: () => { paper.remove(); },
      transferFor: (name: string, type: string) => ({
        files: [new File(["内容"], name, { type })],
        types: ["Files"],
        getData: () => "",
        dropEffect: "copy" as const,
      }),
    };
  }

  it("图片落在笔记纸面上不 arm，同一处落点的文本文件照收", async () => {
    const calls = stubGateway();
    render(<GlobalDropOverlay />);
    const { spot, dispose, transferFor } = withNotePaper();
    try {
      fireEvent.dragEnter(spot, { dataTransfer: transferFor("截屏.png", "image/png") });
      expect(screen.queryByText("松开，收进来源库")).toBeNull();
      // 判据跟着拖拽内容走：纸面只认领整份图片，换成 Markdown 就该说"收进来源库"。
      fireEvent.dragEnter(spot, { dataTransfer: transferFor("note.md", "text/markdown") });
      expect(await screen.findByText("松开，收进来源库")).toBeTruthy();
      expect(calls.create).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("松手那一下被纸面接走时，「松开」那句要收回去", async () => {
    const calls = stubGateway();
    render(<GlobalDropOverlay />);
    const { spot, dispose, transferFor } = withNotePaper();
    try {
      const image = transferFor("截屏.png", "image/png");
      // 从别处拖起来，浮层已经 arm。
      fireEvent.dragEnter(document.body, { dataTransfer: image });
      expect(await screen.findByText("松开，收进来源库")).toBeTruthy();
      fireEvent.drop(spot, { dataTransfer: image });
      expect(screen.queryByText("松开，收进来源库")).toBeNull();
      expect(calls.create).toHaveLength(0);
    } finally {
      dispose();
    }
  });
});
