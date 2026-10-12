/**
 * 思考字段方言的下发规则（2026-10-12 小米 MiMo 接入）。
 *
 * 这条规则错了不会报错、不落日志，表现是「配置说关了、上游还在烧思考 token」，
 * 只有账单和 reasoning_tokens 看得出来——所以每个分支都要有断言。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chatThinkingRequestFields, type ModelProfile, type PlatformOptions } from "../platform-config.ts";

const profile: ModelProfile = { reasoning: { levels: ["none", "low", "medium", "high"], default: "medium" } };
const noNone: ModelProfile = { reasoning: { levels: ["low", "medium", "high"], default: "high" } };
const effortDialect: PlatformOptions = { thinkingParam: "reasoning_effort" };

test("缺省方言仍是 enable_thinking：开/关，未声明不下发", () => {
  assert.deepEqual(chatThinkingRequestFields(undefined, profile, false), { enable_thinking: true });
  assert.deepEqual(chatThinkingRequestFields(undefined, profile, true), { enable_thinking: false });
  assert.deepEqual(chatThinkingRequestFields(undefined, { reasoning: { levels: ["none"], default: "none" } }, false),
    { enable_thinking: false });
  assert.deepEqual(chatThinkingRequestFields(undefined, undefined, false), {});
  assert.deepEqual(chatThinkingRequestFields(undefined, undefined, true), { enable_thinking: false });
});

test("reasoning_effort 方言：每发下发档案 default，关思考取声明里最接近关的一档", () => {
  assert.deepEqual(chatThinkingRequestFields(effortDialect, profile, false), { reasoning_effort: "medium" });
  assert.deepEqual(chatThinkingRequestFields(effortDialect, profile, true), { reasoning_effort: "none" });
  // 不接受 none 的模型只能落到它自己的最低档——不能据此宣称已经关闭。
  assert.deepEqual(chatThinkingRequestFields(effortDialect, noNone, true), { reasoning_effort: "low" });
});

test("reasoning_effort 方言下未声明档位：不下发；只在调用方显式关思考时给 none", () => {
  assert.deepEqual(chatThinkingRequestFields(effortDialect, undefined, false), {});
  assert.deepEqual(chatThinkingRequestFields(effortDialect, undefined, true), { reasoning_effort: "none" });
});
