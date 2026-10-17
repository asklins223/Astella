import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderSummaryInjection,
  type SummaryInjectionInput,
} from "../context/companion-summary-injection.ts";

const input = (over: Partial<SummaryInjectionInput> = {}): SummaryInjectionInput => ({
  source: { title: "一段方言笑话", keyEvents: ["讲过两回笑话"] },
  coverageVerified: true,
  chainGaps: [],
  throughSeq: "541",
  ...over,
});

/** 造一段可见历史：seq 从 from 到 through，每条都算"线上消息"。 */
const page = (from: number, through: number) => Array.from(
  { length: Math.max(0, through - from + 1) },
  (_, index) => ({
    role: "user" as const,
    text: `第 ${index + 1} 句`,
    seq: String(from + index),
  }),
);

test("摘要盖到 541、回放从 561 起：注入块点出中间那一段，并给出取回入口", () => {
  const block = renderSummaryInjection(input(), "561", page(440, 565));
  assert.match(block!, /更早还有 1 段没有任何摘要覆盖/);
  assert.match(block!, /消息 542–560/);
  assert.match(block!, /companion_read_history/);
});

test("两条线接得上或互相盖住时不报洞——有洞才说，没洞不制造限制", () => {
  assert.ok(!renderSummaryInjection(input(), "542", page(440, 565))!.includes("没有任何摘要覆盖"));
  // 摘要覆盖伸进回放窗口（折叠的正常形状）：那一段由摘要代表，不是洞。
  assert.ok(!renderSummaryInjection(input(), "500", page(440, 565))!.includes("没有任何摘要覆盖"));
});

test("那一格里没有线上消息时不报洞（seq 差值不等于条数）", () => {
  // 542–560 之间只剩被排除的非对话消息（cancelled／error），可见页里读不到它们——
  // 这时报「那一段没人代表」就是谎报。
  const block = renderSummaryInjection(input(), "561", page(600, 620));
  assert.ok(!block!.includes("没有任何摘要覆盖"));
});

test("链上的洞照带，而最近那一段排在前面（渲染出的那句话只点第一段）", () => {
  const block = renderSummaryInjection(
    input({ chainGaps: [{ fromSeq: "322", throughSeq: "439" }] }), "561", page(322, 565),
  );
  assert.match(block!, /更早还有 2 段没有任何摘要覆盖/);
  assert.match(block!, /消息 542–560/);
});

test("没有链头那份摘要时整块不注入，也不编出一块空摘要", () => {
  assert.equal(renderSummaryInjection(input({ source: null }), "561", page(440, 565)), null);
});
