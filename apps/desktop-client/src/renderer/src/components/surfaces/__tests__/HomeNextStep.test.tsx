// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HomeNextStep } from "../library/HomeNextStep.tsx";

/**
 * 首页「只推一件」（39 §12.1）。
 *
 * 这一条链此前**整条没有渲染层**：服务端、路由、IPC、preload、合同全齐，
 * 连「理由必填非空」「swappableCount 为 0 时那颗按钮不画」都写进合同了，
 * 但渲染层一个调用都没有——「换一个」「暂不处理」两颗按钮在产品里**不存在**。
 */
const SUGGESTED = {
  kind: "suggested" as const,
  itemKey: "unfinished_run:abc",
  kindOfItem: "unfinished_run" as const,
  headline: "接着弄懂昨天没弄通的那个条件",
  reasonLine: "你上次停在这一轮的第三个要点，还差一步没做完。",
  swappableCount: 2,
};

const NOTHING_DUE = {
  kind: "nothing_due" as const,
  emptyActions: ["new_note", "resume_reading"] as ("new_note" | "write_from_source" | "resume_reading")[],
};

function stubApi(overrides: Partial<Record<string, unknown>> = {}) {
  const readHomeSuggestion = vi.fn(async () => ({
    ok: true, data: SUGGESTED,
  }));
  const actOnHomeSuggestion = vi.fn(async () => ({
    ok: true, data: { action: "swapped", suggestion: SUGGESTED },
  }));
  // `useSurfaceProjection` **先认证再读**，所以替身必须带 `auth.getState`；
  // 缺了它第一发就抛，整条链落进"读不到"分支（这正是本文件最初四��全红的原因）。
  const auth = {
    getState: vi.fn(async () => ({
      workspaceEpoch: 1,
      ok: true,
      data: { status: "authenticated", workspace: { id: "w1", name: "工作区" } },
    })),
  };
  Reflect.set(window, "ailearn", { auth, review: { readHomeSuggestion, actOnHomeSuggestion, ...overrides } });
  return { readHomeSuggestion, actOnHomeSuggestion, auth };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
});

describe("HomeNextStep · §12.1 的那两句承诺", () => {
  it("把服务端那一句理由**原样**念出来，一个字都不改写", async () => {
    stubApi();
    render(<HomeNextStep timeZone="Asia/Shanghai" epochRef={{ current: 1 }} onOpen={() => {}} />);
    await waitFor(() => screen.getByText(SUGGESTED.headline));
    expect(screen.getByText(SUGGESTED.reasonLine)).toBeTruthy();
  });

  it("「换一个」「暂不处理」两颗按钮**存在**（此前整个产品里都没有）", async () => {
    const { actOnHomeSuggestion } = stubApi();
    render(<HomeNextStep timeZone="Asia/Shanghai" epochRef={{ current: 1 }} onOpen={() => {}} />);
    await waitFor(() => screen.getByText(SUGGESTED.headline));
    fireEvent.click(screen.getByRole("button", { name: /暂不处理/ }));
    await waitFor(() => expect(actOnHomeSuggestion).toHaveBeenCalledOnce());
    const sent = actOnHomeSuggestion.mock.calls[0] as unknown as [{ request: unknown }];
    expect(sent[0].request).toMatchObject({
      itemKey: SUGGESTED.itemKey,
      action: "dismissed",
      timeZone: "Asia/Shanghai",
    });
  });

  it("swappableCount 为 0 时**不画**那颗「换一个」——画一颗按了没反应的更糟", async () => {
    stubApi();
    render(<HomeNextStep timeZone="Asia/Shanghai" epochRef={{ current: 1 }} onOpen={() => {}} />);
    await waitFor(() => screen.getByText(SUGGESTED.headline));
    // 换掉 state：用另一份读数重挂
    cleanup();
    Reflect.set(window, "ailearn", {
      auth: { getState: vi.fn(async () => ({ workspaceEpoch: 1, ok: true, data: { status: "authenticated", workspace: { id: "w1" } } })) },
      review: {
        readHomeSuggestion: vi.fn(async () => ({ ok: true, data: { ...SUGGESTED, swappableCount: 0 } })),
        actOnHomeSuggestion: vi.fn(),
      },
    });
    render(<HomeNextStep timeZone="Asia/Shanghai" epochRef={{ current: 1 }} onOpen={() => {}} />);
    await waitFor(() => screen.getByText(SUGGESTED.headline));
    expect(screen.queryByRole("button", { name: /换一个/ })).toBeNull();
    expect(screen.getByRole("button", { name: /暂不处理/ })).toBeTruthy();
  });

  it("没有到期需求：给入口，**一句建议都不造**（§12.1 不制造「今日任务」）", async () => {
    stubApi({ readHomeSuggestion: vi.fn(async () => ({ ok: true, data: NOTHING_DUE })) });
    render(<HomeNextStep timeZone="Asia/Shanghai" epochRef={{ current: 1 }} onOpen={() => {}} />);
    await waitFor(() => screen.getByText(/今天没有到期的事/));
    expect(screen.getByText("新建一篇笔记")).toBeTruthy();
    expect(screen.getByText("接着读最近那篇")).toBeTruthy();
    // emptyActions 里没有的入口不画
    expect(screen.queryByText("从资料写一篇笔记")).toBeNull();
    expect(screen.queryByRole("button", { name: /暂不处理/ })).toBeNull();
  });

  it("读不到就说读不到，**不画成「今天没有任务」**（那是把两件事说成一件事）", async () => {
    stubApi({ readHomeSuggestion: vi.fn(async () => { throw new Error("offline"); }) });
    render(<HomeNextStep timeZone="Asia/Shanghai" epochRef={{ current: 1 }} onOpen={() => {}} />);
    await waitFor(() => screen.getByText(/今天的位置暂时读不到/));
    expect(screen.queryByText(/今天没有到期的事/)).toBeNull();
    expect(screen.getByRole("button", { name: /再读一次/ })).toBeTruthy();
  });
});
