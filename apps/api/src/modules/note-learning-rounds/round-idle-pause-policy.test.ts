/**
 * 「该不该把这一轮标成可恢复暂停」的纯判据半边（39d W4-5 ④）。
 *
 * 这一份不碰库：四格证据怎么拼成一个决定、终态那几档怎么归类、宽限期与总控那两个值
 * 怎么签发。真库里的读法与那条 `pause` 转移在 `round-activity-sweep.ts` 与集测
 * `note-round-idle-pause-postgres.integration.ts` 那一侧。
 *
 * 每条断言都挑的是"抽掉对应那条判据就会翻"的那一格：四条各自有一条会红的用例，
 * 而不是四条混成一句"应当暂停"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { learningRunPhaseSchema } from "@ailearn/shared/learning-run-contracts";
import { CONTEXT_LEASE_SECONDS } from "../companion-bridge/context-hydration.ts";
import {
  DEFAULT_ROUND_ACTIVITY_SWEEP_INTERVAL_MS,
  ENV_ROUND_ACTIVITY_SWEEP_INTERVAL,
  LEARNING_RUN_PHASE_TERMINALITY_V1,
  LEARNING_RUN_TERMINAL_PHASES_V1,
  ROUND_IDLE_PAUSE_GRACE_MS_V1,
  evaluateRoundIdlePauseV1,
  isLearningRunPhaseTerminalV1,
  roundActivitySweepIntervalMsV1,
  type RoundIdlePauseEvidenceV1,
} from "./round-idle-pause-policy.ts";

const NOW = new Date("2026-09-26T10:00:00.000Z");
/** 四条全成立的那一份底稿：每条用例只改自己那一格。 */
function evidence(patch: Partial<RoundIdlePauseEvidenceV1> = {}): RoundIdlePauseEvidenceV1 {
  return {
    phase: "active",
    livePageContextCount: 0,
    openLearningRunCount: 0,
    lastChangedAt: new Date(NOW.getTime() - ROUND_IDLE_PAUSE_GRACE_MS_V1 - 1),
    now: NOW,
    ...patch,
  };
}

test("四条判据同时成立 ⇒ 该停，且没有哪一条在挡", () => {
  const decision = evaluateRoundIdlePauseV1(evidence());
  assert.equal(decision.shouldPause, true);
  assert.equal(decision.blockedBy, null);
  assert.ok(decision.idleMs !== null && decision.idleMs > ROUND_IDLE_PAUSE_GRACE_MS_V1);
});

test("判据①：只有进行中的轮次会被停；已停的与已收尾的不碰", () => {
  // `paused` 再停一次会把共用计数器白推一格（幂等那一条集测钉的是库里的读数，这里钉的是判据）。
  assert.equal(evaluateRoundIdlePauseV1(evidence({ phase: "paused" })).shouldPause, false);
  assert.equal(evaluateRoundIdlePauseV1(evidence({ phase: "paused" })).blockedBy, "phase");
  assert.equal(evaluateRoundIdlePauseV1(evidence({ phase: "closed" })).blockedBy, "phase");
  // 认不出来的 phase 同样按"不停"处理：宁可少停一轮，不可把别的东西停掉。
  assert.equal(evaluateRoundIdlePauseV1(evidence({ phase: "archived" })).blockedBy, "phase");
  assert.equal(evaluateRoundIdlePauseV1(evidence({ phase: "active" })).shouldPause, true);
});

test("判据②：还有一份未过期未撤销的 live 租约就不许停（0 与 1 是相反的两格）", () => {
  assert.equal(evaluateRoundIdlePauseV1(evidence({ livePageContextCount: 1 })).blockedBy, "live-page-context");
  assert.equal(evaluateRoundIdlePauseV1(evidence({ livePageContextCount: 7 })).blockedBy, "live-page-context");
  assert.equal(evaluateRoundIdlePauseV1(evidence({ livePageContextCount: 0 })).shouldPause, true);
  // 读不出来（NaN／负数）不算"0 份"：证据不全时不动用户的东西。
  assert.equal(evaluateRoundIdlePauseV1(evidence({ livePageContextCount: Number.NaN })).blockedBy, "live-page-context");
  assert.equal(evaluateRoundIdlePauseV1(evidence({ livePageContextCount: -1 })).blockedBy, "live-page-context");
});

test("判据③：这一轮还挂着一场没走完的 run 就不许停", () => {
  assert.equal(evaluateRoundIdlePauseV1(evidence({ openLearningRunCount: 1 })).blockedBy, "open-learning-run");
  assert.equal(evaluateRoundIdlePauseV1(evidence({ openLearningRunCount: 0 })).shouldPause, true);
  assert.equal(evaluateRoundIdlePauseV1(evidence({ openLearningRunCount: Number.NaN })).blockedBy, "open-learning-run");
});

test("判据④：宽限期内不停，恰好走到宽限期那一刻算已过", () => {
  assert.equal(
    evaluateRoundIdlePauseV1(evidence({ lastChangedAt: new Date(NOW.getTime() - ROUND_IDLE_PAUSE_GRACE_MS_V1 + 1) }))
      .blockedBy,
    "grace-period",
  );
  assert.equal(
    evaluateRoundIdlePauseV1(evidence({ lastChangedAt: new Date(NOW.getTime() - ROUND_IDLE_PAUSE_GRACE_MS_V1) }))
      .shouldPause,
    true,
    "恰好等于宽限期应当放行：判据钉的是「超过」，把边界放在停的那一侧才不会因一毫秒而永远停不下",
  );
  // 时间戳读不出来／在未来，都不算"很久没变"。
  assert.equal(evaluateRoundIdlePauseV1(evidence({ lastChangedAt: null })).blockedBy, "unknown-last-change");
  assert.equal(
    evaluateRoundIdlePauseV1(evidence({ lastChangedAt: new Date(NOW.getTime() + 60_000) })).blockedBy,
    "grace-period",
  );
});

test("四条挡住时的先后就是判据编号的先后（「没停」必须有主语）", () => {
  const allFour = evidence({ phase: "closed", livePageContextCount: 3, openLearningRunCount: 2, lastChangedAt: NOW });
  assert.equal(evaluateRoundIdlePauseV1(allFour).blockedBy, "phase");
  assert.equal(
    evaluateRoundIdlePauseV1(evidence({ livePageContextCount: 3, openLearningRunCount: 2, lastChangedAt: NOW })).blockedBy,
    "live-page-context",
  );
  assert.equal(
    evaluateRoundIdlePauseV1(evidence({ openLearningRunCount: 2, lastChangedAt: NOW })).blockedBy,
    "open-learning-run",
  );
  assert.equal(evaluateRoundIdlePauseV1(evidence({ lastChangedAt: NOW })).blockedBy, "grace-period");
});

test("run 的 12 档 phase 一档不漏地归类，终态恰是五档", () => {
  const phases = learningRunPhaseSchema.options;
  assert.equal(phases.length, 12, "shared 那边动了 phase 枚举，这里的归类要一起改（不是自动跟上的）");
  for (const phase of phases) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(LEARNING_RUN_PHASE_TERMINALITY_V1, phase),
      `${phase} 没有被归类`,
    );
    assert.equal(isLearningRunPhaseTerminalV1(phase), LEARNING_RUN_PHASE_TERMINALITY_V1[phase]);
  }
  assert.deepEqual(
    [...LEARNING_RUN_TERMINAL_PHASES_V1].sort(),
    ["cancelled", "completed", "ended", "skipped", "stale"],
  );
  // 停在半路但会回来的那两档不许混进终态：那等于"人还在做题就把外面那一轮停掉"。
  for (const phase of ["preparing", "active", "assessing", "checkpoint", "committing", "paused", "recoverable_error"] as const) {
    assert.equal(isLearningRunPhaseTerminalV1(phase), false, phase);
  }
  // 认不出来的档按"没走完"处理（SQL 侧 `NOT IN 终态` 的语义与之一致）。
  assert.equal(isLearningRunPhaseTerminalV1("whatever"), false);
});

test("宽限期由那份 30 秒租约派生，且必须严格大于租约本身", () => {
  assert.equal(ROUND_IDLE_PAUSE_GRACE_MS_V1, CONTEXT_LEASE_SECONDS * 1000 * 3);
  assert.equal(ROUND_IDLE_PAUSE_GRACE_MS_V1, 90_000);
  assert.ok(
    ROUND_IDLE_PAUSE_GRACE_MS_V1 > CONTEXT_LEASE_SECONDS * 1000,
    "宽限期不大于租约＝把「租约到点」当成「人走了」的证据，那是 D1 §3.1 明确不认的读法",
  );
});

test("总控三档读数：未设＝默认、off＝关掉整条链路、坏值＝回落默认而不是起不来", () => {
  const previous = process.env[ENV_ROUND_ACTIVITY_SWEEP_INTERVAL];
  try {
    delete process.env[ENV_ROUND_ACTIVITY_SWEEP_INTERVAL];
    assert.equal(roundActivitySweepIntervalMsV1(), DEFAULT_ROUND_ACTIVITY_SWEEP_INTERVAL_MS);
    assert.equal(DEFAULT_ROUND_ACTIVITY_SWEEP_INTERVAL_MS, 60_000);

    for (const off of ["off", "OFF", " off ", "disabled", "none", "0"]) {
      process.env[ENV_ROUND_ACTIVITY_SWEEP_INTERVAL] = off;
      assert.equal(roundActivitySweepIntervalMsV1(), null, `off 档没收进来：${off}`);
    }

    for (const bad of ["abc", "-1", "1000", "60.5", ""]) {
      process.env[ENV_ROUND_ACTIVITY_SWEEP_INTERVAL] = bad;
      assert.equal(roundActivitySweepIntervalMsV1(), DEFAULT_ROUND_ACTIVITY_SWEEP_INTERVAL_MS, `坏值没回落：${bad}`);
    }

    process.env[ENV_ROUND_ACTIVITY_SWEEP_INTERVAL] = "120000";
    assert.equal(roundActivitySweepIntervalMsV1(), 120_000);
  } finally {
    if (previous === undefined) delete process.env[ENV_ROUND_ACTIVITY_SWEEP_INTERVAL];
    else process.env[ENV_ROUND_ACTIVITY_SWEEP_INTERVAL] = previous;
  }
});
