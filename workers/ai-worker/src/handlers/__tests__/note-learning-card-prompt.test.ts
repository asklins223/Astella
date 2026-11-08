import assert from "node:assert/strict";
import test from "node:test";
import { noteLearningCardGenerationMessages } from "../note/note-learning-card-generate.ts";

test("出题规则不随笔记、题量和合作约束改变", () => {
  const first = noteLearningCardGenerationMessages(
    [{ ordinal: 1, text: "电压与电流成正比。" }], [], 4, "语气短一点",
  );
  const second = noteLearningCardGenerationMessages(
    [{ ordinal: 2, text: "完全不同的另一篇笔记，讲光合作用。" }],
    [{ title: "教材", text: "叶绿体" }], 8, "",
  );
  assert.equal(first[0]?.role, "system");
  assert.equal(first[0]?.content, second[0]?.content);
  assert.equal(typeof first[0]?.content, "string");
  assert.ok(!String(first[0]?.content).includes("电压与电流"));
  assert.ok(!String(first[0]?.content).includes("光合作用"));
  assert.ok(!String(first[0]?.content).includes("语气短一点"));
  assert.match(String(first[1]?.content), /电压与电流成正比/);
  assert.match(String(first[1]?.content), /恰好生成 4 道题/);
  assert.match(String(second[1]?.content), /恰好生成 8 道题/);
  assert.match(String(second[1]?.content), /光合作用/);
});
