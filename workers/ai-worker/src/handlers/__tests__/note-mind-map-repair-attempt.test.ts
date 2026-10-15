import assert from "node:assert/strict";
import test from "node:test";
import { buildMindMapRepairAttempt } from "../note-mind-map-output.ts";

const base = [
  { role: "system" as const, content: "只依据用户笔记整理。" },
  { role: "user" as const, content: "[原文段落 2]\n## 现象\n\n[原文段落 3]\n- 大白天抬头，天空是蓝的。" },
];

test("repair 那一发带着被拒的那版图：不然「其余保持不变」没有所指", () => {
  const rejected = '{"rootId":"root","nodes":[{"id":"n1","references":[{"blockOrdinal":2,"quote":"大白天抬头"}]}]}';
  const attempt = buildMindMapRepairAttempt(base, rejected, "节点 n1 引用第 2 段的「大白天抬头」（这句实际在段落 3，把 blockOrdinal 改成它就行）");
  assert.deepEqual(attempt.map(message => message.role), ["system", "user", "assistant", "user"]);
  assert.deepEqual(attempt[2], { role: "assistant", content: rejected }, "上一版原样带回去，模型才知道要保住什么");
  assert.match(String(attempt[3]!.content), /这句实际在段落 3/);
});

test("没有上一版可带时不编造 assistant 轮", () => {
  const attempt = buildMindMapRepairAttempt(base, null, null);
  assert.deepEqual(attempt.map(message => message.role), ["system", "user", "user"]);
  assert.match(String(attempt[2]!.content), /请重新检查唯一根节点、父子关系与逐字引用/);
});
