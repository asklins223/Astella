// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryPanel } from "../companion/companion-center-panels.tsx";
import type { CompanionMemoryItemV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { useRoomStore } from "../../../app/room-store.ts";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 伴星中心「记忆」这一块登记给伴星读的是什么（39d W2-7）。
 *
 * 这一块是 W2-7 里唯一**不在挂着 `useHudPage` 的那个组件里**登记的屏：清单
 * （候选优先、时间倒序，再按类型/固定/关键词筛）是 `MemoryPanel` 自己算的，
 * 壳层只拿着未筛的那一批。所以登记只能落在面板——落在壳层就得把那段筛选再抄一遍，
 * 那是"同一个数两个来源"（守卫 `page-readable-registration.test.ts` 的
 * `PUBLISHED_BY_PANEL` 认的就是这条路，而且要同时核对"面板真发＋壳层真引"）。
 */

const okSection = <T,>(value: T) => ({ ok: true as const, value });

/** 夹具形状照**服务端合同**（`companionMemoryItemV1Schema`），不是照组件用到哪几个字段。 */
function memory(id: string, content: string, overrides: Partial<CompanionMemoryItemV1> = {}): CompanionMemoryItemV1 {
  return {
    memoryItemId: id,
    kind: "preference",
    content,
    sourceEventId: null,
    sourceSessionId: null,
    sourceSpeaker: null,
    sourceBasis: null,
    appliesWhen: null,
    validFrom: null,
    validUntil: null,
    userStated: false,
    userConfirmed: true,
    candidate: false,
    importance: 0.6,
    confidence: 0.9,
    scope: "workspace",
    budgetTier: "active",
    pinned: false,
    archived: false,
    dismissedAt: null,
    conflictGroup: null,
    embeddingStatus: "ready",
    sourceType: "confirmed",
    revision: 1,
    authorType: "extractor",
    authorId: null,
    epistemicStatus: "supported",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

const noop = () => undefined;

type MemoryPanelProps = Parameters<typeof MemoryPanel>[0];

function renderPanel(props: Partial<MemoryPanelProps> = {}) {
  const items = [
    memory("m-1", "喜欢先给结论再讲理由"),
    memory("m-2", "这周在啃音色的跨语言迁移", { kind: "episodic", candidate: true, updatedAt: "2026-09-24T00:00:00.000Z" }),
  ];
  const base = {
    section: { ok: true as const, value: { version: 2 as const, items } },
    items,
    focus: null,
    revisions: [],
    revisionsError: null,
    onRetryRevisions: noop,
    query: "",
    kind: "all",
    pinFilter: "all",
    busy: null,
    error: null,
    notice: null,
    confirmDelete: false,
    confirmErase: false,
    createOpen: false,
    createContent: "",
    createKind: "preference",
    correctionOpen: false,
    correctionContent: "",
    onQuery: noop,
    onKind: noop,
    onPinFilter: noop,
    onFocus: noop,
    onAction: noop,
    onConfirmDelete: noop,
    onConfirmErase: noop,
    onCreateOpen: noop,
    onCreateContent: noop,
    onCreateKind: noop,
    onCreate: noop,
    onSummarize: noop,
    onCorrectionOpen: noop,
    onCorrectionContent: noop,
    onCorrect: noop,
    onRetry: noop,
  } satisfies MemoryPanelProps;
  render(<MemoryPanel {...base} {...props} />);
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

it("记忆详情会展示当前作者/版本，并可展开查看带来源的旧版本", () => {
  const current = memory("m-1", "用户刚刚纠正过的偏好", {
    revision: 2,
    authorType: "user",
    epistemicStatus: "supported",
  });
  renderPanel({
    focus: current,
    items: [current],
    revisions: [{
      revision: 1,
      kind: "preference",
      content: "旧版内容",
      sourceEventId: "evt-1",
      sourceSessionId: null,
      sourceSpeaker: "user",
      sourceBasis: "inferred_from_statement",
      appliesWhen: null,
      validFrom: null,
      validUntil: null,
      userStated: false,
      userConfirmed: true,
      importance: 0.6,
      confidence: 0.9,
      scope: "workspace",
      sourceType: "model_inferred",
      authorType: "extractor",
      authorId: null,
      epistemicStatus: "tentative",
      supersededAt: "2026-09-22T00:00:00.000Z",
    }],
  });
  expect(screen.getByText("用户修订 · 有据")).toBeTruthy();
  expect(screen.getByText(/第 2 版/)).toBeTruthy();
  expect(screen.getByText("查看旧版本（1）")).toBeTruthy();
  expect(screen.getByText("旧版内容")).toBeTruthy();
  expect(screen.getByText(/来源：模型推断/)).toBeTruthy();
});

it("记忆详情展示适用条件和有效时间窗", () => {
  const current = memory("m-1", "精力不足时先暂停提醒", {
    appliesWhen: "用户明确表示精力不足时",
    sourceSpeaker: "user",
    sourceBasis: "direct_statement",
    validFrom: "2098-12-31T00:00:00.000Z",
    validUntil: "2099-01-02T00:00:00.000Z",
  });
  renderPanel({ focus: current, items: [current] });
  expect(screen.getByText("用户明确表示精力不足时")).toBeTruthy();
  expect(screen.getByText(/2098.*至.*2099/)).toBeTruthy();
  expect(screen.getByText("用户原话")).toBeTruthy();
  expect(screen.getAllByText("尚未生效")[0]).toBeTruthy();
});

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

function filterValue(label: string): string | undefined {
  return publishedView()?.filters?.find((entry) => entry.label === label)?.value;
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("伴星中心 · 记忆：登记的清单就是屏上露出的那份", () => {
  it("条目的顺序、正文与「类型· 状态」都与 DOM 逐字相同（候选排在最前）", async () => {
    renderPanel();
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.pageId).toBe("companion");
    expect(view.title).toBe("伴星中心");

    // 后代选择器而不是 `> button`：§4.5.8 要求「关于你的」与「她的看法」分成
    // 两段，条目现在住在 <section> 里面，不是列表的直接子元素。
    const rows = [...document.querySelectorAll(".cc-memory-list button")];
    expect(rows).toHaveLength(2);
    // 候选那条排在最前——这条顺序正是"面板自己筛的"这件事的证据。
    expect(rows[0].querySelector("strong")?.textContent).toBe("这周在啃音色的跨语言迁移");
    expect(view.items?.map((entry) => entry.label)).toEqual(
      rows.map((row) => row.querySelector("strong")?.textContent),
    );
    expect(view.items?.map((entry) => entry.ordinal)).toEqual([1, 2]);
    const kind = rows[0].querySelector(".cc-memory-list__kind")!;
    const state = kind.querySelector("small")?.textContent;
    const type = kind.childNodes[0]?.textContent;
    expect(view.items?.[0].state).toBe(`${type}· ${state}`);
    expect(view.items?.[0].state).not.toMatch(/前|刚刚|今天/);
    expect(view.statusLine).toBeUndefined();
  });

  it("筛到什么都不剩时，说的是屏上那句空态而不是省略", async () => {
    renderPanel({ query: "对不上的词" });
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.items).toBeUndefined();
    expect(filterValue("关键词")).toBe("对不上的词");
    expect(view.notice).toBe(
      `${document.querySelector(".cc-state strong")?.textContent}：${document.querySelector(".cc-state p")?.textContent}`,
    );
  });

  it("列表读不到时：登记的是那一格的原话，条目清空", async () => {
    renderPanel({ section: { ok: false, message: "伴星数据暂时不可用" } });
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.statusLine).toBe(document.querySelector(".cc-state strong")?.textContent);
    expect(view.items).toBeUndefined();
    expect(view.notice).toBe(`${view.statusLine}：伴星数据暂时不可用`);
  });

  it("筛选下拉当前选中的那几个词进 filters（屏上就是那几个词）", async () => {
    renderPanel({ kind: "preference", pinFilter: "candidate" });
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const triggers = [...document.querySelectorAll(".companion-select > button span")].map((node) => node.textContent);
    expect(triggers.length).toBeGreaterThan(1);
    expect(filterValue("类型")).toBe(triggers[0]);
    expect(filterValue("状态")).toBe(triggers[1]);
  });
});
