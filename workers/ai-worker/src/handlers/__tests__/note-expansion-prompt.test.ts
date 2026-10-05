import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNoteExpansionPrompt } from "../note-expansion-prompt.ts";

test("拓展引用使用真实块号和读到的文字，不把行内语法当成依据", () => {
  const prompt = buildNoteExpansionPrompt([
    { ordinal: 7, type: "paragraph", content: "**半开区间**也可换成`闭区间`。" },
    { ordinal: 11, type: "code", content: "if (a[mid] < target) left = mid + 1;" },
  ], false);
  const material = prompt.split("笔记原文：\n\n")[1];
  assert.equal(material, "[原文第 8 段，blockOrdinal=7]\n半开区间也可换成闭区间。\n\n[原文第 12 段，blockOrdinal=11]\nif (a[mid] < target) left = mid + 1;");
});

test("选区生成保留原位置和全部输入文字，不把选区编号重新从零起", () => {
  const blocks = [{ ordinal: 23, type: "paragraph", content: "循环结束时 left=right；返回值允许等于 n。" }];
  const focused = buildNoteExpansionPrompt(blocks, true);
  assert.equal(focused.split("笔记原文：\n\n")[1], "[原文第 24 段，blockOrdinal=23]\n循环结束时 left=right；返回值允许等于 n。");
  assert.notEqual(focused, buildNoteExpansionPrompt(blocks, false));
});
