/**
 * 语音等待上限的**取值依据**。
 *
 * ## 为什么要有这条
 *
 * 2026-10-02 用户报「一直都听不到声音」，提示是「语音合成超时」。查下来：
 *
 *  - 服务端两个引擎都健康，端到端 V2 分段 1676ms 就回；
 *  - 但客户端截止是 4000ms，而**5 路并发**实测 p90 2037/2862、max **3690/5132**；
 *  - 4000ms 正好切在分布中间 → 慢的那一条必然越过 → 若它是**首段**，
 *    `playedCount === 0`，整轮降级成「语音合成超时」。
 *
 * 上一版的注释引的是 2026-09-22 的**单发**测量（qwen p95 3071ms）。单发
 * 不是真实形状——客户端是流水线，几段一起要。所以这条守卫把当时的实测值
 * 钉在文件里：**截止可以被改，但不能改回低于这些数字**，而改的人会立刻
 * 看到为什么当初调过。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

import {
  COMPANION_SPEECH_FIRST_AUDIO_DEADLINE_MS,
  COMPANION_SPEECH_GAP_DEADLINE_MS,
} from "../companion-voice-playback.ts";

/** 2026-10-02 真容器 / 真引擎 / 真会话，5 路并发的两批观测值（ms）。 */
const MEASURED_5X_CONCURRENT = {
  p50: [1980, 2845],
  p90: [2037, 2862],
  max: [3690, 5132],
} as const;
const OBSERVED_MAX = Math.max(...MEASURED_5X_CONCURRENT.max);

test("首段截止高于 5 路并发的观测最大值，并留出余量", () => {
  expect(COMPANION_SPEECH_FIRST_AUDIO_DEADLINE_MS).toBeGreaterThan(OBSERVED_MAX);
  // 余量是给"机器更慢"留的。低于 1.5 倍观测 max 就等于把余量收没了。
  expect(COMPANION_SPEECH_FIRST_AUDIO_DEADLINE_MS).toBeGreaterThanOrEqual(OBSERVED_MAX * 1.5);
});

test("段间截止也不低于观测最大值", () => {
  expect(COMPANION_SPEECH_GAP_DEADLINE_MS).toBeGreaterThan(OBSERVED_MAX);
});

test("截止的**注释里带着这次实测**，不是上一次的单发数字", () => {
  const source = readFileSync(join(resolve(import.meta.dirname, ".."), "companion-voice-playback.ts"), "utf8");
  // 2026-09-22 那次量的是单发 p95 3071；正是它让人以为 4000 够用。
  // 注释里必须同时留着"并发"与"max"这两个词，否则下一个���会拿旧数字改回去。
  // 说明写在赋值的**上方**，所以从赋值处往回看。
  const at = source.indexOf("COMPANION_SPEECH_FIRST_AUDIO_DEADLINE_MS =");
  expect(at).toBeGreaterThan(0);
  const before = source.slice(Math.max(0, at - 1600), at);
  expect(before).toMatch(/并发/);
  expect(before).toMatch(/5132|观测 max/);
});

test("被放弃的重试会**停下**，不在后台继续压服务", () => {
  const source = readFileSync(join(resolve(import.meta.dirname, ".."), "companion-voice-playback.ts"), "utf8");
  // `withDeadline` 只是不再等，不会取消。所以重试循环必须自己看"是否已被放弃"。
  expect(source).toMatch(/abandoned\.has\(segment\)/);
  expect(source).toMatch(/abandoned\.add\(segment\)/);
  // 而且放弃只发生在**截止**命中时——真错误仍值得重试。
  expect(source).toMatch(/if \(deadlineHit\) abandoned\.add\(segment\)/);
});

test("【自证】判据认得出「把截止改回单发基线」这个真实退化", () => {
  // 2026-09-22 的单发 p95 是 3071，3000 当时就压在它上面。回到那个口径 = 回到 4000。
  const singleShotP95 = 3071;
  expect(COMPANION_SPEECH_FIRST_AUDIO_DEADLINE_MS).not.toBe(4000);
  expect(singleShotP95, "自证：单发基线低于并发观测值，所以按它定截止就是低估").toBeLessThan(OBSERVED_MAX);
});
