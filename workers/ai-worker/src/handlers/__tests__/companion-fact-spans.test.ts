import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FACT_SPAN_KEYS,
  pickFactSpanValues,
  renderFactSpansBlock,
  resolveFactSpans,
  withholdPartialFactSpanTail,
} from "../turn/companion-fact-spans.ts";


test("目录只收有值的键，且渲染成 <fact_spans> 块", () => {
  const values = pickFactSpanValues({ today_minutes: 42, streak_days: 0, card_count: null }, [
    "today_minutes", "streak_days", "card_count",
  ]);
  assert.deepEqual(values, { today_minutes: "42", streak_days: "0" }, "算不出来的键不能进目录");
  const block = renderFactSpansBlock(values);
  assert.ok(block?.startsWith("<fact_spans>"));
  assert.ok(block?.endsWith("</fact_spans>"));
  assert.ok(block?.includes("today_minutes = 42"));
  assert.equal(renderFactSpansBlock({}), null, "空目录不发块");
});

test("已知键逐字渲染：渲染值与目录里的值**完全一样**", () => {
  for (const key of Object.keys(FACT_SPAN_KEYS) as (keyof typeof FACT_SPAN_KEYS)[]) {
    const values = { [key]: "17" } as Record<string, string>;
    const resolved = resolveFactSpans(`现在是 {{f:${key}}} 。`, values);
    assert.equal(resolved.text, "现在是 17 。", `${key} 的渲染值不是目录里那个值`);
    assert.deepEqual(resolved.dropped, []);
  }
});

test("未知键（含目录为空的整轮）丢半句、留正文，且不漏标记到屏幕", () => {
  const dropped = resolveFactSpans("今天你学了 {{f:today_minutes}} 分钟了。别急，慢慢来。", {});
  assert.equal(dropped.text, "别急，慢慢来。");
  assert.equal(dropped.dropped.length, 1);
  assert.ok(!dropped.text.includes("{{"), "标记漏到屏幕上了");

  const partial = resolveFactSpans("你已经练了 {{f:card_count}} 张卡，要现在再过一遍吗？", { card_count: "3" });
  assert.equal(partial.text, "你已经练了 3 张卡，要现在再过一遍吗？");
});

test("未闭合的残留一样丢，不让半个标记出现在正文里", () => {
  const resolved = resolveFactSpans("今天学了 {{f:today_min", {});
  assert.ok(!resolved.text.includes("{{"));
  assert.equal(resolved.text, "");
  assert.equal(resolved.dropped.length, 1);
});

test("没有占位符时逐字不动（没写标记的正文零改动）", () => {
  const text = "嗯嗯，我在听。你说的那篇我记住了，回头去看看。";
  const resolved = resolveFactSpans(text, { card_count: "3" });
  assert.equal(resolved.text, text);
  assert.deepEqual(resolved.dropped, []);
});

test("流式扣住半截标记：完整的不动，没写完的切到标记之前", () => {
  assert.equal(withholdPartialFactSpanTail("今天学了{{f:today_min"), "今天学了");
  assert.equal(withholdPartialFactSpanTail("今天学了{{"), "今天学了");
  assert.equal(withholdPartialFactSpanTail("今天学了{{f:today_minutes}}"), "今天学了{{f:today_minutes}}");
  assert.equal(withholdPartialFactSpanTail("今天学了{{f:today_minutes}} 分钟"), "今天学了{{f:today_minutes}} 分钟");
  assert.equal(withholdPartialFactSpanTail("今天学了 42 分钟"), "今天学了 42 分钟");
});


test("ordinary template syntax and reserved syntax inside code remain literal", () => {
  for (const text of ["模板是 {{name}}。", "Use {{ title }} in Handlebars.", "`{{f:today_minutes}}`", "```js\nconst template = '{{f:missing}}';\n```", "单独的 {{ 也可以作为模板说明。"])
    assert.deepEqual(resolveFactSpans(text, { today_minutes: "42" }), { text, dropped: [] });
  assert.equal(withholdPartialFactSpanTail("模板 {{name"), "模板 {{name");
  assert.equal(withholdPartialFactSpanTail("`{{f:today_min"), "`{{f:today_min");
});

test("fact replacement changes only prose placeholders and requires an own string value", () => {
  const text = "值为 {{f:today_minutes}}，例子 `{{f:today_minutes}}`。";
  assert.equal(resolveFactSpans(text, { today_minutes: "42" }).text, "值为 42，例子 `{{f:today_minutes}}`。");
  assert.equal(resolveFactSpans("{{f:__proto__}}", {}).text, "");
});
