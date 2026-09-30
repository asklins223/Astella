import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRoundAction,
  isRoundRecoverable,
  RoundTransitionError,
  type RoundStateV1,
} from "../round-reducer.ts";

/**
 * D1 §5.1 那张转移表的单测。
 *
 * 这一组钉的不是"函数跑不跑得通"，是三件**只有这里能钉**的事：
 *  1. 终态之后**任何**动作都是拒绝——`closed` 只读是 §3.2/§16.39 的产品承诺，
 *     而不是"目前还没写重开路径"；
 *  2. 重复的 pause／resume 是**不推进计数器**的 noop——`revision` 是状态与计划修订
 *     共用的那一个 CAS 计数器（§6.3），把它吹大等于把"什么都没变"伪装成"改过一次"；
 *  3. `close` 同时写下 outcome 与 closedAt——与 0282 那两条双向 CHECK 同向，
 *     两份判据只要分叉，症状就是"服务层觉得自己写对了而库里进不去"。
 */

const T1 = new Date("2026-09-26T02:00:00.000Z");
const T2 = new Date("2026-09-26T02:05:00.000Z");

function openState(overrides: Partial<RoundStateV1> = {}): RoundStateV1 {
  return { phase: "active", outcome: null, pausedAt: null, resumedAt: null, closedAt: null, ...overrides };
}

function rejectionReason(action: () => unknown): string | null {
  try {
    action();
  } catch (err) {
    if (err instanceof RoundTransitionError) return err.reason;
    throw err;
  }
  return null;
}

test("active → pause → resume：两个时间戳各自记在自己那一格", () => {
  const paused = applyRoundAction(openState(), { kind: "pause" }, T1);
  assert.equal(paused.changed, true);
  assert.deepEqual(paused.state, {
    phase: "paused", outcome: null, pausedAt: T1, resumedAt: null, closedAt: null,
  });

  const resumed = applyRoundAction(paused.state, { kind: "resume" }, T2);
  assert.equal(resumed.changed, true);
  assert.deepEqual(resumed.state, {
    phase: "active", outcome: null, pausedAt: T1, resumedAt: T2, closedAt: null,
  });
  // 暂停过这件事是历史，不该因为"回来了"就被抹掉。
  assert.equal(resumed.state.pausedAt?.toISOString(), T1.toISOString());
});

test("重复的 pause／resume 是什么都不改的 noop（不许把 revision 计数器吹大）", () => {
  const alreadyPaused = openState({ phase: "paused", pausedAt: T1 });
  const againPaused = applyRoundAction(alreadyPaused, { kind: "pause" }, T2);
  assert.equal(againPaused.changed, false, "第二次 pause 必须报「没改任何事」，调用方据此不推进 revision");
  assert.deepEqual(againPaused.state, alreadyPaused);
  assert.equal(
    againPaused.state.pausedAt?.toISOString(),
    T1.toISOString(),
    "noop 也不许把 pausedAt 换成第二次的时间——那会读成「这一轮在 T2 才暂停」",
  );

  const alreadyActive = openState({ resumedAt: T1 });
  const againActive = applyRoundAction(alreadyActive, { kind: "resume" }, T2);
  assert.equal(againActive.changed, false);
  assert.deepEqual(againActive.state, alreadyActive);
});

test("收尾把 phase／outcome／closedAt 三件一起写（与 0282 的双向 CHECK 同向）", () => {
  const closed = applyRoundAction(openState({ pausedAt: T1 }), { kind: "close", outcome: "partial" }, T2);
  assert.equal(closed.changed, true);
  assert.deepEqual(closed.state, {
    phase: "closed", outcome: "partial", pausedAt: T1, resumedAt: null, closedAt: T2,
  });
});

test("终态只读：closed 之后 pause／resume／再收尾一律拒绝", () => {
  const closed = openState({
    phase: "closed", outcome: "completed", closedAt: T1,
  });
  assert.equal(rejectionReason(() => applyRoundAction(closed, { kind: "pause" }, T2)), "round_closed");
  assert.equal(rejectionReason(() => applyRoundAction(closed, { kind: "resume" }, T2)), "round_closed");
  assert.equal(
    rejectionReason(() => applyRoundAction(closed, { kind: "close", outcome: "superseded" }, T2)),
    "round_closed",
    "迟到判定不是「把轮次打开再结算一次」（§16.19）",
  );
});

test("不认识的动作为拒绝，而不是静当 noop", () => {
  const reason = rejectionReason(() =>
    applyRoundAction(openState(), { kind: "restart" } as unknown as { kind: "pause" }, T1),
  );
  assert.equal(reason, "invalid_transition");
});

test("「继续学习」只认未终结的两档（§3.2）", () => {
  assert.equal(isRoundRecoverable("active"), true);
  assert.equal(isRoundRecoverable("paused"), true);
  assert.equal(isRoundRecoverable("closed"), false);
});
