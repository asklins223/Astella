import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideCompactionAttempt, recordCompactionAttempt, emptyCompactionCooldownState,
  MAX_COMPACTION_ATTEMPTS, MAX_NO_PROGRESS_ATTEMPTS, COMPACTION_COOLDOWN_MS,
} from "../compaction-cooldown.ts";

/**
 * 方案 44 §5.4 后半：失败冷却与无进展状态。
 *
 * 时钟由调用方传入——这些判据必须在「冷却期刚好过了 1ms」这种边界上也能复现，
 * 读全局时间的版本没法这样测。
 */

const t0 = new Date("2026-10-05T00:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

test("第一次触发就允许尝试", () => {
  const decision = decideCompactionAttempt({ state: null, now: t0 });
  assert.equal(decision.outcome, "attempt");
  assert.equal(decision.reason, "first_attempt");
  assert.equal(decision.retryAfterMs, null);
});

test("冷却期没过：同一个失败输入不再每轮重触发", () => {
  const state = recordCompactionAttempt({
    state: null, inputTokens: 20_000, reason: "over_trigger_line", at: t0,
  });
  const within = decideCompactionAttempt({ state, now: at(1_000) });
  assert.equal(within.outcome, "cooldown");
  assert.equal(within.reason, "within_cooldown");
  assert.equal(within.retryAfterMs, COMPACTION_COOLDOWN_MS - 1_000);
  const edge = decideCompactionAttempt({ state, now: at(COMPACTION_COOLDOWN_MS) });
  assert.equal(edge.outcome, "attempt");
  assert.equal(edge.reason, "cooldown_elapsed");
});

test("折叠让请求变小算有进展，不会被当成无进展", () => {
  let state = recordCompactionAttempt({ state: null, inputTokens: 20_000, reason: "over_trigger_line", at: t0 });
  state = recordCompactionAttempt({
    state, inputTokens: 11_000, reason: "over_trigger_line", at: at(COMPACTION_COOLDOWN_MS),
  });
  assert.equal(state.noProgressStreak, 0);
  assert.equal(decideCompactionAttempt({ state, now: at(COMPACTION_COOLDOWN_MS * 2) }).outcome, "attempt");
});

test("连续无进展：这条路在当前输入上走不通，不再靠加时间重试", () => {
  let state = recordCompactionAttempt({ state: null, inputTokens: 20_000, reason: "over_trigger_line", at: t0 });
  state = recordCompactionAttempt({ state, inputTokens: 20_000, reason: "over_trigger_line", at: at(COMPACTION_COOLDOWN_MS) });
  assert.equal(state.noProgressStreak, 1);
  // 第一次尝试之后没有可比的前值，不立刻判无进展——否则每一次失败尝试都会被冤枉。
  assert.equal(decideCompactionAttempt({ state, now: at(COMPACTION_COOLDOWN_MS * 2) }).outcome, "attempt");
  state = recordCompactionAttempt({ state, inputTokens: 20_000, reason: "over_trigger_line", at: at(COMPACTION_COOLDOWN_MS * 2) });
  assert.equal(state.noProgressStreak, MAX_NO_PROGRESS_ATTEMPTS);
  const exhausted = decideCompactionAttempt({ state, now: at(COMPACTION_COOLDOWN_MS * 10) });
  assert.equal(exhausted.outcome, "exhausted");
  assert.equal(exhausted.reason, "no_progress");
});

test("尝试次数用尽后不再无限重发", () => {
  let state = emptyCompactionCooldownState();
  for (let i = 0; i < MAX_COMPACTION_ATTEMPTS; i += 1) {
    // 每次都变小，所以永远是「有进展」——这正是要靠次数上限兜住的那种情况。
    state = recordCompactionAttempt({
      state, inputTokens: 20_000 - i * 1_000, reason: "over_trigger_line", at: at(i * COMPACTION_COOLDOWN_MS),
    });
  }
  const decision = decideCompactionAttempt({ state, now: at(MAX_COMPACTION_ATTEMPTS * COMPACTION_COOLDOWN_MS) });
  assert.equal(decision.outcome, "exhausted");
  assert.equal(decision.reason, "attempt_budget_spent");
});

test("时钟倒退（多实例/恢复后）不会给出负的等待时间", () => {
  const state = recordCompactionAttempt({ state: null, inputTokens: 20_000, reason: "over_trigger_line", at: t0 });
  const backwards = decideCompactionAttempt({ state, now: at(-5_000) });
  assert.equal(backwards.outcome, "cooldown");
  assert.ok((backwards.retryAfterMs ?? 0) > COMPACTION_COOLDOWN_MS - 1_000);
});
