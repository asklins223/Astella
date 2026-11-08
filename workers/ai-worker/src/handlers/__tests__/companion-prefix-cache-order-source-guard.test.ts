import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 源码守卫：每轮易变的「前台学习时段」块必须排在**稳定块之后**（2026-10-16）。
 *
 * ## 它保护什么
 *
 * 请求的 system 前缀是逐段拼出来的，prefix cache 只能复用"从头到第一处变化"的
 * 那一段。`participation_awareness` 里写着分钟数——闲聊里它每轮都在变。它原来排在
 * 稳定协议块中间，于是**整段工具面与协议文本每一轮都被重付**。
 *
 * 方案 54 §5 的最小切法就是把它挪到稳定块之后：普通轮的第一块易变内容变成
 * `<here_and_now>`（≈7,648 字符前缀可复用），主动轮也从 3,627 字符提到 7,584 字符。
 * 实测两轮真实请求的复用率：主动轮 0.61 → 0.854（首轮）、0.732 → 0.995（次轮），
 * 次轮重付 4,494 → 78 token（见 outputs/audits/agent-design-audit-fixes-ab-2026-10-16.json）。
 *
 * 这条守卫防的是"下一次重构顺手把它挪回稳定块中间"——那不会让任何行为测试变红，
 * 只会让每一轮悄悄多付一次整份工具面的钱。
 */
const source = readFileSync(
  new URL("../turn/companion-dialogue-content.ts", import.meta.url),
  "utf8",
);

test("每轮会变的现场数据不进入可缓存的指令前缀", () => {
  const local = source.slice(source.indexOf("const TURN_LOCAL_CONTEXT_SOURCES"), source.indexOf("export function buildCompanionPersonaMessages"));
  for (const id of ["here_and_now", "conversation_timeline", "participation_awareness", "delivery_observation"]) {
    assert.match(local, new RegExp(`"${id}"`), `${id} 必须留在本轮现场，不能回到稳定指令前缀`);
  }
  assert.match(source, /hostObservation: true as const/);
});

test("后台任务的当次材料不写进可缓存的出题和回顾规则", () => {
  const card = readFileSync(new URL("../note/note-learning-card-generate.ts", import.meta.url), "utf8");
  const reflection = readFileSync(new URL("../journal/companion-reflection-content.ts", import.meta.url), "utf8");
  assert.match(card, /role: "system", content: CARD_RULES/);
  assert.doesNotMatch(card, /role: "system", content: agentContext\.instructions/);
  assert.match(reflection, /role: "system", content: REFLECTION_RULES/);
  assert.match(reflection, /reflectionSnapshotHeader\(snapshot\)/);
});
