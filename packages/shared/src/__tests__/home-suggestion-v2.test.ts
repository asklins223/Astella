/**
 * 首页「只推一件」的判据（39d W7-4 刀四；39 §12.1）。
 *
 * §12.1 那几句今天没有执法点，这一组把它们钉住。**每条都带正控制**，因为每一条被写成
 * 别的样子时后果都具体：
 *
 *  1. **只推一件**（正对照：三档优先级按序排，同档新的在前）。四套排序就是四个答案，
 *     而屏上读不出来——每处各自都说得通。
 *  2. **已暂停的旧轮次既不占位也不挡路**（§12.1「不因一个旧暂停轮次存在就永久挡住其他
 *     需求」）。这一条最容易被写成"有暂停轮次就显示那个暂停轮次"，于是首页永远停在
 *     三周前那一件事上。
 *  3. **「暂不处理」过的本次不再推**，但**只限本次**（正对照：换一次会话又照常推）。
 *  4. **没有到期需求 ⇒ 不制造"今日任务"**（正对照：候选只剩空的/被排除的那些 ⇒ 交回
 *     `nothing_due` ＋ 三个**入口**，而不是塞一件"值得做的事"）。
 *  5. **理由必填**（正对照：排第一的那件没有理由 ⇒ 交回 `nothing_due`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideHomeSuggestionV2, type NextStepCandidateV2 } from "../home-suggestion-v2.ts";

const NOW = new Date("2026-09-27T09:00:00.000Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function item(over: Partial<NextStepCandidateV2> = {}): NextStepCandidateV2 {
  return {
    kind: "authorized_review",
    headline: "用几个小问题回访这篇笔记",
    reasonLine: "3 天前学过，今天该回访",
    itemKey: "obj-1",
    updatedAt: ago(1),
    ...over,
  };
}

test("W7-4 刀四：只推一件，且按 §12.1 的三档排序", () => {
  const decided = decideHomeSuggestionV2({
    candidates: [
      item({ kind: "authorized_review", itemKey: "review", updatedAt: ago(1) }),
      item({ kind: "unfinished_run", itemKey: "run", updatedAt: ago(5) }),
      // 「明确指定」排第一不是因为它更新——它在这里是**最旧**的。
      item({ kind: "user_named", itemKey: "named", updatedAt: ago(30) }),
    ],
    dismissedThisSession: [],
  });
  assert.equal(decided.kind, "suggested");
  assert.equal(decided.kind === "suggested" && decided.item.itemKey, "named",
    "§12.1「优先考虑用户明确指定的任务」——它排在最前，哪怕它最旧");
});

test("W7-4 刀四 正对照：同档内新的在前", () => {
  const decided = decideHomeSuggestionV2({
    candidates: [
      item({ itemKey: "older", updatedAt: ago(9) }),
      item({ itemKey: "newer", updatedAt: ago(1) }),
    ],
    dismissedThisSession: [],
  });
  assert.equal(decided.kind === "suggested" && decided.item.itemKey, "newer");
  assert.equal(decided.kind === "suggested" && decided.swappableCount, 1,
    "「可换一个」数的是同档剩下的那一件");
});

test("W7-4 刀四：已暂停的旧轮次**既不占位也不挡路**（§12.1 末句）", () => {
  // 正控制：把暂停轮次排在最前（它 `updatedAt` 最新），主建议仍要是别的——
  // 「不因一个旧暂停轮次存在就永久挡住其他需求」。
  const decided = decideHomeSuggestionV2({
    candidates: [
      item({ itemKey: "stale-paused", updatedAt: ago(1), pausedRun: true }),
      item({ itemKey: "real", updatedAt: ago(10) }),
    ],
    dismissedThisSession: [],
  });
  assert.equal(decided.kind === "suggested" && decided.item.itemKey, "real",
    "首页永远停在三周前那一件事上，就是这一条被写反了");
  assert.equal(decided.kind === "suggested" && decided.swappableCount, 0,
    "暂停轮次不算「可换一个」：换了它也是一件停着的事");
});

test("W7-4 刀四：「暂不处理」过的本次不再推，但**只限本次**", () => {
  const candidates = [item({ itemKey: "a" }), item({ itemKey: "b" })];
  const dismissed = decideHomeSuggestionV2({ candidates, dismissedThisSession: ["a"] });
  assert.equal(dismissed.kind === "suggested" && dismissed.item.itemKey, "b",
    "她刚说「暂不处理」，首页下一刷还推同一件");
  // 下一次会话：照常推回 a。
  const nextSession = decideHomeSuggestionV2({ candidates, dismissedThisSession: [] });
  assert.equal(nextSession.kind === "suggested" && nextSession.item.itemKey, "a",
    "§12.1「本次不反复推荐同一项」——**本次**，不是永久");
});

test("W7-4 刀四 正对照：没有到期需求 ⇒ `nothing_due` ＋ 三个**入口**", () => {
  // §12.1「没有到期需求**不制造"今日任务"**」。空态给的是入口，不是建议。
  const decided = decideHomeSuggestionV2({
    candidates: [item({ pausedRun: true })],
    dismissedThisSession: ["a", "b"],
  });
  assert.equal(decided.kind, "nothing_due");
  assert.deepEqual(
    decided.kind === "nothing_due" ? decided.emptyActions : [],
    ["new_note", "write_from_source", "resume_reading"],
    "空态给的是「新建笔记／从资料写笔记／最近阅读」三个**入口**",
  );
});

test("W7-4 刀四 正对照：排第一的那件**没有理由** ⇒ 不推它", () => {
  // §12.1「推荐附一句理由」。空理由会让首页那一行变成一句没有出处的断言——
  // 而这一章的用意正是"说得清为什么是这一件"。
  const decided = decideHomeSuggestionV2({
    candidates: [item({ itemKey: "no-reason", reasonLine: "   " }), item({ itemKey: "with-reason" })],
    dismissedThisSession: [],
  });
  assert.equal(decided.kind, "nothing_due",
    "没有理由的那一件不许当主建议：宁可空着，也不要一句没有出处的断言");
});
