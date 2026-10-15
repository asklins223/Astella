import assert from "node:assert/strict";
import test from "node:test";
import { REPAIR_HEAD_V1, buildRepairAttempt, repairInstruction } from "../model-repair-attempt.ts";

const base = [
  { role: "system" as const, content: "只依据用户笔记。" },
  { role: "user" as const, content: "[原文段落 3]\n- 天空是蓝的。" },
];

test("重试带上被拒的那一版，模型才知道「其余保持不变」指什么", () => {
  const rejected = '{"candidates":[{"title":"为什么是蓝的"}]}';
  const attempt = buildRepairAttempt(base, rejected, repairInstruction("root.drafts:too_small", "兜底检查项。"));
  assert.deepEqual(attempt.map(message => message.role), ["system", "user", "assistant", "user"]);
  assert.deepEqual(attempt[2], { role: "assistant", content: rejected });
  assert.match(String(attempt[3]!.content), /root\.drafts:too_small/);
});

test("没有上一版时不编造 assistant 轮", () => {
  const attempt = buildRepairAttempt(base, null, repairInstruction(null, "请重新检查结构。"));
  assert.deepEqual(attempt.map(message => message.role), ["system", "user", "user"]);
  assert.match(String(attempt[2]!.content), /请重新检查结构。/);
});

test("修正指令的开头只有这一处", () => {
  // 两条链共用同一个模板；措辞各写一份就会各自漂移，模型收到的"改一处"也就两种强度。
  assert.match(repairInstruction("具体原因", "x"), new RegExp(REPAIR_HEAD_V1.slice(0, 12)));
  assert.match(repairInstruction(null, "x"), new RegExp(REPAIR_HEAD_V1.slice(0, 12)));
});
