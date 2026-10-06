// @vitest-environment jsdom
/**
 * 「聊聊这篇」的入口行为（40 §6，验收 A08）。
 *
 * ## 为什么重点是「**不**自动发送」
 *
 * 合同原话：「点击只打开对话并附上该篇的明确引用，**不自动发送用户消息**。」
 *
 * 这半句容易被当成细节，但它决定了这个功能是不是替用户说话。用户点了
 * 「聊聊这篇」，结果她自己跳出来替用户问了一句——那是替用户发言，不是陪他聊。
 *
 * 现有机制里自动发送的条件是 `noteAnchor && initialPrompt`，所以这里
 * **刻意不填 initialPrompt**：只留下引用，等用户自己接着打字。
 */
import { describe, expect, it } from "vitest";

import {
  COMPANION_FEED_MAX_CHARS,
  feedDiaryReferenceToCompanion,
  subscribeCompanionFeed,
  type CompanionFeedSelection,
} from "../companion-feed";

function captureFeed(): { events: CompanionFeedSelection[]; opens: number } {
  const events: CompanionFeedSelection[] = [];
  const state = { events, opens: 0 };
  const listener = (event: Event) => {
    events.push((event as CustomEvent<CompanionFeedSelection>).detail);
  };
  const openListener = () => { state.opens += 1; };
  window.addEventListener("astella:companion-feed", listener);
  window.addEventListener("astella:companion-open-chat", openListener);
  return state;
}

describe("聊聊这篇的引用", () => {
  it("只打开对话并附上引用，**不带** initialPrompt（所以不会自动发送）", () => {
    const captured = captureFeed();
    feedDiaryReferenceToCompanion({ date: "2026-10-01", version: 2 });

    expect(captured.opens).toBe(1);
    expect(captured.events).toHaveLength(1);
    const selection = captured.events[0]!;
    expect(selection.initialPrompt).toBeUndefined();
    expect(selection.diaryAnchor).toEqual({ date: "2026-10-01", version: 2 });
    // 正文不进投喂：模型要按 ID 现读，不是拿一段可能已被重写的副本。
    expect(selection.text).not.toContain("晚上");
  });

  it("自动发送的前提是 noteAnchor && initialPrompt —— 引用两个都没有，所以必然不发送", () => {
    // 这条把"不发送"钉在**会话侧的真实条件**上，而不是靠我们自觉不填某个字段。
    const captured = captureFeed();
    feedDiaryReferenceToCompanion({ date: "2026-10-01", version: 1 });
    const selection = captured.events[0]!;
    expect(Boolean(selection.noteAnchor && selection.initialPrompt)).toBe(false);
  });

  it("版本必须带 —— 用户看到的那一版是稳定的（§5.5 已发布成稿不被重跑替换）", () => {
    const captured = captureFeed();
    feedDiaryReferenceToCompanion({ date: "2026-10-01", version: 3 });
    expect(captured.events[0]!.diaryAnchor?.version).toBe(3);
  });

  it("日期形状不对就**不发** —— 宁可没反应，也不要把一个坏引用递给她", () => {
    const captured = captureFeed();
    feedDiaryReferenceToCompanion({ date: "去年那天", version: 1 });
    feedDiaryReferenceToCompanion({ date: "2026-10-01", version: 0 });
    expect(captured.events).toHaveLength(0);
    expect(captured.opens).toBe(0);
  });

  it("投喂文本有长度上限，和划选投喂同一条规矩", () => {
    const captured = captureFeed();
    feedDiaryReferenceToCompanion({ date: "2026-10-01", version: 1 });
    expect(captured.events[0]!.text.length).toBeLessThanOrEqual(COMPANION_FEED_MAX_CHARS);
  });

  it("【自证】判据认得出「替用户自动问一句」这个真实退化", () => {
    // 退化形状：带上 initialPrompt，会话侧就会自动发送。
    const autoAsking: CompanionFeedSelection = {
      text: "聊聊这篇",
      source: "selection",
      initialPrompt: "你觉得这篇怎么样？",
      diaryAnchor: { date: "2026-10-01", version: 1 },
    };
    expect(autoAsking.initialPrompt).toBeDefined();
    // 正控制：我们的实现确实不填它。
    const captured = captureFeed();
    feedDiaryReferenceToCompanion({ date: "2026-10-01", version: 1 });
    expect(captured.events[0]!.initialPrompt).toBeUndefined();
  });
});

/**
 * ## 为什么上面那组测试不够
 *
 * 它们只断言**投递端**发出的事件内容。而真实的断线在**订阅端**：
 * `subscribeCompanionFeed` 的 `onFeed` 逐字段重建 selection（每个字段都要
 * 重新校验后才知道能不能带过去），日记引用曾经漏在那个重建里——
 *
 *   - 事件里 `diaryAnchor` 在（上面那组全绿）
 *   - 会话侧读到的是 `undefined` → `<diary_reference>` 永不生成
 *
 * 也就是说「点了聊聊这篇，对话打开了，但她不知道你问的是哪一篇」。
 * 这组测试走完整条 relay，才抓得到。
 */
describe("引用穿过订阅端之后还在", () => {
  function relayThroughSubscribe(): CompanionFeedSelection | null {
    let received: CompanionFeedSelection | null = null;
    const unsubscribe = subscribeCompanionFeed({
      onFeed: (selection) => { received = selection; },
      onNoteIntent: () => undefined,
      onOpenChat: () => undefined,
    });
    try {
      feedDiaryReferenceToCompanion({ date: "2026-10-01", version: 4 });
      return received;
    } finally {
      unsubscribe();
    }
  }

  it("投递 → 订阅之后，日期与版本都还在", () => {
    expect(relayThroughSubscribe()?.diaryAnchor).toEqual({ date: "2026-10-01", version: 4 });
  });

  it("仍然不自动发送 —— 引用回来了，initialPrompt 不该跟着回来", () => {
    expect(relayThroughSubscribe()?.initialPrompt).toBeUndefined();
  });

  it("坏引用不会穿过订阅端变成半个引用", () => {
    // 直接往事件里塞一个不合法形状：订阅端必须整条丢掉 diaryAnchor，
    // 而不是放行日期、放行版本中的一样。
    let received: CompanionFeedSelection | null = null;
    const unsubscribe = subscribeCompanionFeed({
      onFeed: (selection) => { received = selection; },
      onNoteIntent: () => undefined,
      onOpenChat: () => undefined,
    });
    try {
      window.dispatchEvent(new CustomEvent("astella:companion-feed", {
        detail: {
          text: "日记 2026-10-01",
          source: "selection",
          diaryAnchor: { date: "去年那天", version: 2 },
        },
      }));
      expect(received).not.toBeNull();
      expect((received as unknown as CompanionFeedSelection).diaryAnchor).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});