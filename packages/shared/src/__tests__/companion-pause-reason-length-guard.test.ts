/**
 * 40 §8.2「今天别催学习」的**长度契约**。
 *
 * ## 这个 bug 是怎么来的
 *
 * worker 执行体里写的是 `user_asked:<用户原话>`，原话切到 **200** 字；
 * 而 `companionSuggestionPauseSchema` 的 `reasonCodes` 单项上限是 **100**。
 * 两者一撞：**用户说一句 90 字以上的话，整份 `suggestion_pause` 就过不了校验**——
 * 而它挂在**账号读写**那条路上，于是整个伴星设置面板跟着打不开。
 *
 * 静态测试抓不到，因为四个包各自的单测都只喂自己那半边：
 * worker 的用例喂 200 字进执行体，shared 的用例喂短字符串进 schema，
 * 谁都没把「worker 的输出」和「schema 的输入」接起来。
 *
 * 这条判据就是把那两个半边接起来。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { companionSuggestionPauseSchema } from "../contracts/companion-shell-contracts.ts";

const REPO = resolve(import.meta.dirname, "..", "..", "..", "..");
const executor = readFileSync(
  join(REPO, "workers", "ai-worker", "src", "handlers", "companion-tool-execution.ts"), "utf8",
);

const PAUSE_PREFIX = "user_asked:";

test("用户原话**再长**也写得进 `suggestion_pause`", () => {
  // 关键是模拟**执行体实际写出的那一段**（它会截断），而不是原话本身。
  // 直接拿原话去试 schema 是在测一个执行体根本不会写出去的东西——
  // 那样这条判据要么恒红，要么在有人把截断删掉时仍然是绿的。
  //
  // 逐档试而不是只试一个长度：上限这种判据最容易被"只试了短的"骗过。
  const cap = Number(/PAUSE_REASON_MAX_CHARS = (\d+);/.exec(executor)?.[1] ?? "200");
  for (const quoteLength of [1, 40, 89, 90, 120, 200, 2000]) {
    const quote = "x".repeat(quoteLength).slice(0, cap);   // ← 执行体的那一刀
    const row = {
      paused: true,
      localDate: "2026-10-02",
      timezone: "Asia/Shanghai",
      reasonCodes: [`${PAUSE_PREFIX}${quote}`],
    };
    const parsed = companionSuggestionPauseSchema.safeParse(row);
    assert.ok(parsed.success,
      `原话 ${quoteLength} 字 → 截成 ${quote.length} 字后仍写不进：`
      + `${parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(";")}`
      + ` —— 而这一列挂在账号读写上，会连带整个设置面板打不开`);
  }
});

test("执行体切的是那个**算出来的**上限", () => {
  assert.match(executor, /PAUSE_REASON_MAX_CHARS/,
    "执行体没有用一个算出来的上限 —— 将来改前缀时没人会记得回来改这里");
  // 上界必须是「前缀 + 内容 ≤ 100」，而不是随手取的整数。
  const bound = /const PAUSE_REASON_MAX_CHARS = (\d+);/.exec(executor);
  assert.ok(bound, "找不到 PAUSE_REASON_MAX_CHARS 的定义");
  const value = Number(bound[1]);
  assert.ok(value + PAUSE_PREFIX.length <= 100,
    `上限 ${value} 加前缀 ${PAUSE_PREFIX.length} 字超过了 schema 的 100 字 —— 长句会把账号面板打不开`);
});

test("【自证】判据认得出「切到 200 字」这个真实退化", () => {
  // 退化形状就是它原来的样子：切 200，配 100 字上限。
  const degraded = { quote: "x".repeat(200) };
  const row = { paused: true, reasonCodes: [`${PAUSE_PREFIX}${degraded.quote}`] };
  const parsed = companionSuggestionPauseSchema.safeParse(row);
  assert.equal(parsed.success, false, "自证：200 字确实过不了 —— 所以上面那条判据不是恒真");
  // 正控制：现在切的长度过得去。
  const current = "x".repeat(Number(/PAUSE_REASON_MAX_CHARS = (\d+)/.exec(executor)?.[1] ?? 200));
  assert.equal(
    companionSuggestionPauseSchema.safeParse({ paused: true, reasonCodes: [`${PAUSE_PREFIX}${current}`] }).success,
    true,
    "自证：当前长度过得去，所以判据今天是绿的",
  );
});
