/**
 * 批注解释的产出合同：长度随模型档案与原文走，不再按固定字数拒收。
 *
 * 两条要钉住：
 *  1. **长解释要能存下来**——原先是 `max(650)`，模型一写长整条任务以 `output_shape`
 *     终结，用户看到的是"批注解释缺少清楚的白话说明"，而内容本身完全合法。
 *     库里那条 8000 字上限已随 0418 一并去掉，两侧不能再各留一道。
 *  2. **该拒的照拒**——不是可保存的 JSON、或者解释短到说不清，仍然是当场判不可重试
 *     （这条链没有内核重试，拒了就是拒了，不能退化成静默存下空解释）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExplanation } from "../note/note-annotation-explain.ts";
import { NoteAnnotationOutputError } from "../../lib/non-retryable-errors.ts";

const SHORT = "这句话解释了选中片段的意思。";

test("长解释整段存下：不按固定字数拒收，末尾一字不丢", () => {
  const long = "选中的这一段讲的是把复习安排在快忘的时候。".repeat(400) + "解释的最后一句完整保留。";
  assert.ok(long.length > 650, "用例长度必须真的越过原来那道 650 字闸");
  const parsed = parseExplanation(JSON.stringify({ explanation: long, example: null }));
  assert.equal(parsed.explanation, long, "长解释要原样交回来，不能被剪尾");
  assert.ok(parsed.explanation.endsWith("解释的最后一句完整保留。"));
});

test("超过库里旧上限的解释同样过得来（8000 那道已随 0418 去掉）", () => {
  const veryLong = "完整解释正文。".repeat(1_300);
  assert.ok(veryLong.length > 8_000);
  assert.equal(parseExplanation(JSON.stringify({ explanation: veryLong, example: null })).explanation, veryLong);
});

test("嵌在说明文字里的 JSON 也解得出来，且长解释不因此被剪", () => {
  const long = "先说结论，再给依据。".repeat(300) + "结尾保留。";
  const wrapped = `以下是解释结果：\n${JSON.stringify({ explanation: long, example: null })}`;
  assert.equal(parseExplanation(wrapped).explanation, long);
});

test("可选例子缺省与空串都当「没有例子」，不因为去掉长度上限就连带拒收", () => {
  assert.equal(parseExplanation(JSON.stringify({ explanation: SHORT, example: null })).example, null);
  assert.equal(parseExplanation(JSON.stringify({ explanation: SHORT, example: "" })).example, "");
});

test("不是可保存的结构化内容：当场判不可重试，不静默存下", () => {
  assert.throws(
    () => parseExplanation("这不是 JSON"),
    (error: unknown) => error instanceof NoteAnnotationOutputError,
  );
});

test("解释短到说不清仍然是拒的：放开的是长度上限，不是下限", () => {
  assert.throws(
    () => parseExplanation(JSON.stringify({ explanation: "太短了" })),
    (error: unknown) => error instanceof NoteAnnotationOutputError,
  );
  assert.throws(
    () => parseExplanation(JSON.stringify({ explanation: "" })),
    (error: unknown) => error instanceof NoteAnnotationOutputError,
  );
});
