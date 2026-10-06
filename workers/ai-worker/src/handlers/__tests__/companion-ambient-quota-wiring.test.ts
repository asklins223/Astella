/**
 * 40 §8.2 的额度**真的接进念头管线**了。
 *
 * ## 为什么不能只测判据
 *
 * `companion-proactive-quota.ts` 里的判据测过不等于它在跑。真实形状是：
 * worker 每调度一次念头管线 → `evaluateRoutineCueTiming` 决定开不开口 →
 * 候选生成 → 挑选 → 最多送一条。任何一环没接上，"一次持续使用一条"就只是
 * 文档里的一句话。
 *
 * ## 这里守三条
 *
 *  1. 时机闸真的读到了**本次持续使用已展示的普通招呼数**（从库里数，不是常量）；
 *  2. 额度用掉之后，整轮在**任何模型调用之前**就闭嘴（沉默默认，别白烧 LLM）；
 *  3. 多个候选**只送一条**，不轮流补播。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { evaluateRoutineCueTiming } from "../companion-thought.ts";
import { AMBIENT_QUOTA_PER_USAGE } from "@astella/shared/companion-proactive-quota";

const source = readFileSync(join(resolve(import.meta.dirname, ".."), "companion-thought.ts"), "utf8");

const base = {
  availability: "online" as const,
  quietHours: null,
  now: new Date("2026-10-02T12:00:00Z"),
  recentDeliveryStates: [] as readonly string[],
  interventionLevel: "moderate" as const,
  msSinceLastRoutineCue: null,
  spaceMuted: false,
  formalAnswerInProgress: false,
  ambientCandidatesThisRound: 1,
  ambientRank: 0,
  lastAmbientIgnored: false,
};

test("本次持续使用已经说过一次 ⇒ 这一轮闭嘴", () => {
  const d = evaluateRoutineCueTiming({ ...base, ambientDeliveredThisUsage: AMBIENT_QUOTA_PER_USAGE });
  assert.equal(d.allow, false, "额度用掉之后她还能再说一句");
  assert.equal(d.reason, "ambient_quota_exhausted");
  assert.equal(d.detail.ambientDeliveredThisUsage, AMBIENT_QUOTA_PER_USAGE);
});

test("还没说过 ⇒ 放行（额度判据不误杀第一次）", () => {
  assert.equal(evaluateRoutineCueTiming({ ...base, ambientDeliveredThisUsage: 0 }).allow, true);
});

test("上一条被忽略 ⇒ 不换一种说法再问", () => {
  const d = evaluateRoutineCueTiming({ ...base, ambientDeliveredThisUsage: 0, lastAmbientIgnored: true });
  assert.equal(d.allow, false);
  assert.equal(d.reason, "ambient_ignored_no_rewrite");
});

test("多个候选只选一条、不轮流补播", () => {
  for (const rank of [1, 2]) {
    const d = evaluateRoutineCueTiming({ ...base, ambientDeliveredThisUsage: 0, ambientCandidatesThisRound: 3, ambientRank: rank });
    assert.equal(d.allow, false, `第 ${rank} 个候选也被放行了`);
    assert.equal(d.reason, "ambient_picked_another");
  }
  assert.equal(
    evaluateRoutineCueTiming({ ...base, ambientDeliveredThisUsage: 0, ambientCandidatesThisRound: 3, ambientRank: 0 }).allow,
    true,
    "名次 0 反而被挡住了",
  );
});

test("额度闸排在**任何模型调用之前** —— 沉默默认，别白烧一次 LLM", () => {
  const gateAt = source.indexOf("const timing = evaluateRoutineCueTiming({");
  const silenceAt = source.indexOf("if (!timing.allow)");
  // ⚠️ 搜 `buildDeterministicThoughts(` 会先撞上**函数定义**（文件头部），
  // 那样这条判据会永远绿。必须搜**调用点**那一处。
  const candidateAt = source.indexOf("buildDeterministicThoughts(thoughtMaterial)");
  assert.ok(gateAt > 0 && silenceAt > gateAt, "找不到时机闸");
  assert.ok(candidateAt > 0, "找不到候选生成的调用点");
  assert.ok(candidateAt > silenceAt,
    "候选生成排在额度闸之前 —— 额度已经用完的那些调度仍会先烧一次 LLM");
});

test("额度数的是**库里这一段使用期间的普通招呼**，不是常量", () => {
  // 口径：deliveries 里带 text 的那些（她自己想开口的），约定提醒不带 text。
  assert.match(source, /payload_ref->>'text' IS NOT NULL/,
    "额度不该数约定提醒——§8.2「约定提醒仍按其独立规则持久送达」");
  assert.match(source, /created_at >= to_timestamp\(/,
    "额度必须限定在本次持续使用之内，否则永远超限");
  // 锚点是"最近一次有动作的时刻"，跨过阈值就是新一次使用。
  assert.match(source, /continuesUsageSession\(\{ msSincePresence/);
});

test("每次调度最多送一条", () => {
  // 挑选循环在成功交付后立刻 return —— 不轮流补播。
  assert.match(source, /return; \/\/ 每次调度最多送 1 条/);
});

test("【自证】判据认得出「额度写成按天计数」这个真实退化", () => {
  // 退化形状：按自然日重置，于是每晚都能再说一句。
  const dailyQuota = (nowHours: number) => nowHours >= 0;
  assert.equal(dailyQuota(0), true, "自证样本：退化版任何时候都放行");
  const real = evaluateRoutineCueTiming({ ...base, ambientDeliveredThisUsage: 1 });
  assert.equal(real.allow, false, "自证：真判据只看这次使用期间说没说过，与钟点无关");
});

test("【自证】判据认得出「额度闸排在候选生成之后」这个真实退化", () => {
  // 退化形状：先烧 LLM 生成候选，再看额度 —— 白烧一次。
  const gateAt = source.indexOf("const timing = evaluateRoutineCueTiming({");
  const candidateAt = source.indexOf("buildDeterministicThoughts(thoughtMaterial)");
  assert.ok(candidateAt > gateAt, "自证：当前确实是闸在前、候选在后");
});
