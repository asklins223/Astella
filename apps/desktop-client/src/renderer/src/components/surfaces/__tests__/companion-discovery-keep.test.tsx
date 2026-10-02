// @vitest-environment jsdom

/**
 * 40 §7「自然停顿时可以提供一次『留在发现簿』」——桌面端这一条真的接上了。
 *
 * ## 这条回归盯的是**三件容易悄悄退化的事**
 *
 *  1. **只有一次**。合同原话：「用户忽略后不再催促。」而「忽略」在实现里有两个
 *     不同的时刻：点「先不留」（用户明说），以及收藏成功（已经收下，无需再问）。
 *     少认其中任何一个，那颗按钮就会变成每条回答旁的常驻控件——而界面上看不出
 *     它已经变成常驻的，只是变得很烦。
 *  2. **收藏的是原文**。收藏的正文必须来自 `messageText`（屏上正在显示的那段），
 *     而不是壳层另写一份抽取规则。两份规则一漂，收藏下来的就不是用户看到的那句话。
 *  3. **失败不静默**。收藏失败必须有一句能读懂的说明，且**不**消耗掉那一次机会
 *     ——没能送到不是「用户忽略」。
 *
 * ## 为什么还钉住空态文案
 *
 * 原来的空态写着「在日记或回答旁点『留在发现簿』」。那时那个入口**不存在**，
 * 于是这是整个发现簿里唯一一句会指向空气的话。而按 §7 那一处入口只出现一次，
 * 就算接上了，写成「在回答旁点」也仍然会在用户点过「先不留」之后变成空指针。
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialoguePanel } from "../companion/companion-center-panels.tsx";
import { DiscoveryPanel } from "../companion/companion-discovery-panel.tsx";
import {
  clipDiscoveryBody,
  discoveryAuthorFor,
  discoveryIdentityKey,
  discoveryKindFor,
  readDiscoveryKeepDeclined,
  rememberDiscoveryKeepDeclined,
  resolveDiscoveryKeepState,
} from "../companion/companion-discovery-offer.tsx";
import type { CompanionHistoryItemV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { useRoomStore } from "../../../app/room-store.ts";

const ASSISTANT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OLDER_ASSISTANT_ID = "33333333-3333-4333-8333-333333333333";

type DialoguePanelProps = Parameters<typeof DialoguePanel>[0];

function message(
  id: string,
  role: CompanionHistoryItemV1["role"],
  text: string,
  createdAt: string,
  overrides: Partial<CompanionHistoryItemV1> = {},
): CompanionHistoryItemV1 {
  return {
    version: 1,
    messageId: id,
    role,
    kind: "text",
    blocks: [{ type: "text", text }],
    runId: null,
    createdAt,
    editedAt: null,
    ...overrides,
  };
}

const noop = () => undefined;

function keepProps(overrides: Partial<NonNullable<DialoguePanelProps["keep"]>> = {}): NonNullable<DialoguePanelProps["keep"]> {
  return {
    anchorMessageId: ASSISTANT_ID,
    state: "offer",
    busy: false,
    feedback: null,
    failure: null,
    onKeep: noop,
    onDecline: noop,
    ...overrides,
  };
}

/** 屏上是「最新在前」，正好是最新的那条 assistant 消息带那一次机会。 */
function renderPanel(props: Partial<DialoguePanelProps> = {}) {
  const base: DialoguePanelProps = {
    section: {
      ok: true,
      value: {
        version: 1 as const,
        items: [
          message(ASSISTANT_ID, "assistant", "缺一条把惯性与质量分开的反例。", "2026-09-24T00:02:00.000Z"),
          message(USER_ID, "user", "帮我看看第三章还缺什么证据", "2026-09-24T00:01:00.000Z"),
          message(OLDER_ASSISTANT_ID, "assistant", "更早的一句回答。", "2026-09-23T00:02:00.000Z"),
        ],
        nextCursor: null,
      },
    },
    items: [],
    cursor: null,
    query: "",
    searching: false,
    loadingMore: false,
    error: null,
    onQuery: noop,
    onSearch: noop,
    onLoadMore: noop,
    onContinue: noop,
    onRetry: noop,
    keep: keepProps(),
  };
  const items = base.section.ok ? base.section.value.items : [];
  render(<DialoguePanel {...base} items={items} {...props} />);
}

function keepButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(".discovery-keep button")];
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
  window.localStorage.clear();
});

describe("40 §7 · 留在发现簿：只有一次机会", () => {
  it("机会只挂在最新那一条回答旁，同一屏里只有一处", () => {
    renderPanel();
    expect(keepButtons().length).toBe(2); // 「留在发现簿」+「先不留」
    const articlesWithKeep = [...document.querySelectorAll(".companion-thread article")]
      .filter((article) => article.querySelector(".discovery-keep"));
    expect(articlesWithKeep).toHaveLength(1);
    expect(articlesWithKeep[0]!.id).toBe(`companion-message-${ASSISTANT_ID}`);
  });

  it("锚点不是最新那条时那一屏什么都不显示（不是换一条继续问）", () => {
    renderPanel({ keep: keepProps({ anchorMessageId: null, state: "hidden" }) });
    expect(document.querySelector(".discovery-keep")).toBeNull();
  });

  it("点「留在发现簿」把**屏上这一段原文**交出去，作者与类别由角色推出", () => {
    const onKeep = vi.fn();
    renderPanel({ keep: keepProps({ onKeep }) });
    const keepButton = keepButtons().find((button) => button.textContent === "留在发现簿")!;
    fireEvent.click(keepButton);
    expect(onKeep).toHaveBeenCalledTimes(1);
    // 壳层把屏上的正文原样传下去（这里直接验推导规则，别让壳层自己拼）。
    expect(discoveryAuthorFor("assistant")).toBe("assistant");
    expect(discoveryKindFor("assistant")).toBe("kept_ai_suggestion");
    expect(discoveryAuthorFor("user")).toBe("user");
    expect(discoveryKindFor("user")).toBe("user_utterance");
  });

  it("成功给角标、不再给第二次；失败给一句能读懂的说明，且不消耗那一次机会", () => {
    const { rerender } = render(
      <DialoguePanel
        {...({
          section: { ok: true, value: { version: 1 as const, items: [message(ASSISTANT_ID, "assistant", "缺一条反例。", "2026-09-24T00:02:00.000Z")], nextCursor: null } },
          items: [message(ASSISTANT_ID, "assistant", "缺一条反例。", "2026-09-24T00:02:00.000Z")],
          cursor: null, query: "", searching: false, loadingMore: false, error: null,
          onQuery: noop, onSearch: noop, onLoadMore: noop, onContinue: noop, onRetry: noop,
          keep: keepProps(),
        } satisfies DialoguePanelProps)}
      />,
    );
    rerender(
      <DialoguePanel
        {...({
          section: { ok: true, value: { version: 1 as const, items: [message(ASSISTANT_ID, "assistant", "缺一条反例。", "2026-09-24T00:02:00.000Z")], nextCursor: null } },
          items: [message(ASSISTANT_ID, "assistant", "缺一条反例。", "2026-09-24T00:02:00.000Z")],
          cursor: null, query: "", searching: false, loadingMore: false, error: null,
          onQuery: noop, onSearch: noop, onLoadMore: noop, onContinue: noop, onRetry: noop,
          keep: keepProps({ state: "kept" }),
        } satisfies DialoguePanelProps)}
      />,
    );
    const badge = document.querySelector(".discovery-keep--kept");
    expect(badge?.textContent).toContain("已留在发现簿");
    expect(keepButtons().length).toBe(0);

    cleanup();
    render(
      <DialoguePanel
        {...({
          section: { ok: true, value: { version: 1 as const, items: [message(ASSISTANT_ID, "assistant", "缺一条反例。", "2026-09-24T00:02:00.000Z")], nextCursor: null } },
          items: [message(ASSISTANT_ID, "assistant", "缺一条反例。", "2026-09-24T00:02:00.000Z")],
          cursor: null, query: "", searching: false, loadingMore: false, error: null,
          onQuery: noop, onSearch: noop, onLoadMore: noop, onContinue: noop, onRetry: noop,
          keep: keepProps({ failure: "没能留在发现簿：网络不可用。可以再点一次，或者点「先不留」。" }),
        } satisfies DialoguePanelProps)}
      />,
    );
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("没能留在发现簿");
    // 失败**不是**忽略：按钮还在，用户能再试一次。
    expect(keepButtons().some((button) => button.textContent === "留在发现簿")).toBe(true);
  });

  it("「先不留」之后跨重启不再出现", () => {
    const onDecline = vi.fn();
    renderPanel({ keep: keepProps({ onDecline }) });
    fireEvent.click(keepButtons().find((button) => button.textContent === "先不留")!);
    expect(onDecline).toHaveBeenCalledTimes(1);

    // 落盘的那一份必须让下一次运行读得到——只放 React state 里的话，重开应用又来问一遍。
    rememberDiscoveryKeepDeclined();
    expect(readDiscoveryKeepDeclined()).toBe(true);
  });

  it("state 判定：只有「最新 + 没问过 + 没被忽略」才给机会", () => {
    const base = { isLatestPause: true, alreadyCollected: false, declined: false, spent: false };
    expect(resolveDiscoveryKeepState(base)).toBe("offer");
    expect(resolveDiscoveryKeepState({ ...base, alreadyCollected: true })).toBe("kept");
    expect(resolveDiscoveryKeepState({ ...base, declined: true })).toBe("declined");
    expect(resolveDiscoveryKeepState({ ...base, spent: true })).toBe("hidden");
    expect(resolveDiscoveryKeepState({ ...base, isLatestPause: false })).toBe("hidden");
    // 簿子里已经有这一份时，「忽略」不该把它说成被用户拒过——角标优先。
    expect(resolveDiscoveryKeepState({ ...base, alreadyCollected: true, declined: true })).toBe("kept");
  });

  it("超长正文在本地截到 4000 字内：超一个字符就是服务端 422", () => {
    const long = "字".repeat(5000);
    const clipped = clipDiscoveryBody(long);
    expect(clipped.length).toBe(4000);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipDiscoveryBody("  短句  ")).toBe("短句");
  });

  it("身份三元组在两处用同一份写法 —— 不拿正文当身份", () => {
    expect(discoveryIdentityKey({ kind: "kept_ai_suggestion", source: "assistant_reply", sourceId: ASSISTANT_ID }))
      .toBe(`kept_ai_suggestion|assistant_reply|${ASSISTANT_ID}`);
  });
});

describe("40 §7 · 发现簿空态不再指向不存在的按钮", () => {
  it("空态那句话不再让人去找一颗可能根本不存在的按钮", () => {
    // 原来的空态写着「在日记或回答旁点『留在发现簿』」。那时那个入口**不存在**，
    // 于是这是整个发现簿里唯一一句指向空气的话。而按 §7 那一处入口只出现一次，
    // 就算接上了，写成「在回答旁点」在用户拒过之后也仍然是空指针。
    render(
      <DiscoveryPanel
        section={{ ok: true, value: { version: 1 as const, entries: [], studyVisible: [] } }}
        busy={null}
        error={null}
        notice={null}
        onUncollect={noop}
        onAnnotate={noop}
        onRetry={noop}
      />,
    );
    const empty = document.querySelector(".companion-center__empty")?.textContent ?? "";
    expect(empty).toContain("问一次要不要留下");
    expect(empty).not.toMatch(/在日记或回答旁点/);
    expect(empty).not.toMatch(/在回答旁点/);
  });
});
