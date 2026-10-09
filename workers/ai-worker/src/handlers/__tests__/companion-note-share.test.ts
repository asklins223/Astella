import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { companionShareStepResult } from "../companion-note-share.ts";
import { CompanionToolNotExecutedError } from "../companion-tool-result.ts";

const noteId = randomUUID();
const receipt = (shareScope: "private" | "shared", changed: boolean) => ({
  kind: "note_share", noteId, shareScope, changed, updatedAt: "2026-10-09T03:09:12Z",
});

/**
 * 三档回执不许混（2026-10-09）。
 *
 * 这一条能力是"把内容拿给别人看"的开关，说错的代价不对称：
 * 把 unknown 当成 failed，她会补一句"没改成"，用户再点一次，而共享可能已经生效过一轮；
 * 把 failed 当成成功，就是一句冒领。所以这里钉的不是文案，是**哪一档能说什么**。
 */
test("共享与撤回的成功回执只说真实发生的那一半", () => {
  const shared = companionShareStepResult(receipt("shared", true));
  assert.match(shared.safeSummary ?? "", /已共享给空间/);
  assert.match(shared.safeSummary ?? "", /空间里的人现在能读到它/);
  const withdrawn = companionShareStepResult(receipt("private", true));
  assert.match(withdrawn.safeSummary ?? "", /仅自己可见/);
  assert.match(withdrawn.safeSummary ?? "", /之后别人再也读不到它/);
  assert.ok((withdrawn.blocks ?? []).some(block => block.type === "nav"
    && JSON.stringify(block).includes(noteId)), "要给出回到那篇的入口，而不是只有一句话");
});

test("本来就是那个档位时，不许说她改动了什么", () => {
  const unchanged = companionShareStepResult(receipt("shared", false));
  assert.match(unchanged.safeSummary ?? "", /本来就是/);
  assert.doesNotMatch(unchanged.safeSummary ?? "", /现在能读到/);
});

test("没做成停在 not_executed：可以说没改，也可以重来", () => {
  assert.throws(() => companionShareStepResult(
    { kind: "note_share_failed", message: "这篇笔记不是这位用户写的。" }),
  (error: unknown) => error instanceof CompanionToolNotExecutedError && /不是这位用户写的/.test(String(error)));
});

test("结果未知不许掉进 not_executed：它必须走 outcome_unknown 那一档", () => {
  // `CompanionToolNotExecutedError` 会被分类成 not_executed（"这一步从未开始执行，
  // 可以重新调用一次"）。把 unknown 抛成它，就等于告诉用户"没发生，再点一次"。
  assert.throws(() => companionShareStepResult({ kind: "note_share_unknown", message: "待核对" }),
    (error: unknown) => !(error instanceof CompanionToolNotExecutedError)
      && String(error).includes("note_share_save_unconfirmed"));
});

test("回执不合结构合同时报错：既不当成成功，也不降格成没改动", () => {
  assert.throws(() => companionShareStepResult({ kind: "note_share", noteId, shareScope: "public", changed: true }));
  assert.throws(() => companionShareStepResult({ kind: "note_share", noteId, changed: true }));
});
