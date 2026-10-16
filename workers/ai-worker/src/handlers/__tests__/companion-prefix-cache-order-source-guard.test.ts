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
  new URL("../companion-dialogue-content.ts", import.meta.url),
  "utf8",
);

test("前台学习时段块排在稳定块之后（prefix cache 的可复用前缀不被它截断）", () => {
  const stableBlock = source.indexOf('add("here_and_now"');
  const volatileBlock = source.indexOf('add("participation_awareness"');
  assert.ok(stableBlock > 0, "找不到 here_and_now 的装配点（形状变了，这条判据要先跟着改）");
  assert.ok(volatileBlock > 0, "找不到 participation_awareness 的装配点");
  assert.ok(stableBlock < volatileBlock,
    "participation_awareness 又排到稳定块前面了：它每轮都变，站在前面会把整份工具面推出可复用前缀");
});
