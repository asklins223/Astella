import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMethodV1 } from "@astella/shared/agent-growth-contracts";
import {
  selectRelevantMethods, renderMethodCatalogBlock, methodRelevanceTerms, MAX_RELEVANT_METHODS,
} from "../relevant-methods.ts";

/**
 * 方案 44 §6.1／§6.3：专业任务读**相关**经验，且只给目录。
 *
 * 判据不能是「有方法就给」：给一条不相干的做法，比不给更糟——她会按错误的先验做事。
 */

const method = (over: Partial<AgentMethodV1>): AgentMethodV1 => ({
  version: 1,
  methodId: "00000000-0000-0000-0000-000000000001",
  revision: 1,
  title: "讲公式先说适用条件",
  appliesWhen: "涉及公式或定理时",
  steps: [], exceptions: [], evidence: [], evidenceIndependentCount: 0, capabilities: [],
  state: "active", userControlled: false, epistemicStatus: "supported",
  availability: "available", author: "extractor",
  changeReason: null, sourceRunId: null, sourceRunRevision: null,
  offeredCount: 0, adoptedCount: 0, consultedCount: 0, helpfulCount: 0, unhelpfulCount: 0, lastConsultedAt: null,
  createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z",
  ...over,
});

test("44 §6.1：只挑与当前任务相关的方法，不相关的给一条都不给", () => {
  const methods = [
    method({ methodId: "00000000-0000-0000-0000-00000000000a", title: "讲公式先说适用条件", appliesWhen: "涉及公式或定理时" }),
    method({ methodId: "00000000-0000-0000-0000-00000000000b", title: "复习安排按周滚动", appliesWhen: "安排下周的复习计划时" }),
  ];
  const hit = selectRelevantMethods(methods, "帮我把这几道公式的卡片做出来");
  assert.equal(hit.length, 1);
  assert.match(hit[0]!.title, /公式/);
  assert.equal(selectRelevantMethods(methods, "把这段散文读一遍").length, 0,
    "判不出相关就不给：塞一条不相干的做法比不给更糟");
});

test("44 §6.1：目录有界，且按命中多少排序", () => {
  const methods = Array.from({ length: 9 }, (_, index) => method({
    methodId: `00000000-0000-0000-0000-00000000000${index}`,
    title: `做法 ${index}：公式与定理的讲法`,
    appliesWhen: "涉及公式或定理时",
  }));
  const picked = selectRelevantMethods(methods, "公式 定理");
  assert.equal(picked.length, MAX_RELEVANT_METHODS);
  const strong = selectRelevantMethods([
    method({ methodId: "00000000-0000-0000-0000-00000000000a", title: "只沾一个词", appliesWhen: "别的时候" }),
    method({ methodId: "00000000-0000-0000-0000-00000000000b", title: "公式 定理 公式 定理", appliesWhen: "公式" }),
  ], "公式 定理");
  assert.match(strong[0]!.title, /公式 定理 公式 定理/);
});

test("44 §6.1：目录块写清「只是指引、不改事实、适用条件对不上就别用」", () => {
  const block = renderMethodCatalogBlock(selectRelevantMethods(
    [method({ methodId: "00000000-0000-0000-0000-00000000000a" })],
    "公式卡片",
  ));
  assert.match(block, /<related_methods>/);
  assert.match(block, /合作指引/);
  assert.match(block, /不改变原文事实/);
  assert.match(block, /不授予任何权限/);
  assert.match(block, /适用条件/);
  // 正文不在目录里——展开才记「读过」（§6.3）。
  assert.match(block, /正文不在其中/);
  assert.equal(renderMethodCatalogBlock([]), "", "没有相关方法时不要留一个空壳块");
});

test("44 §6.3：目录出现不等于采用——措辞不能把「提供过」说成「用过」", () => {
  const block = renderMethodCatalogBlock([method({})]);
  assert.ok(!block.includes("你采用了"), "目录只是让她看见");
  assert.match(block, /可能与这次任务相关，也可能不相关/);
});

test("关键词提取与记忆检索同纪律：短词与虚词不进", () => {
  const terms = methodRelevanceTerms("的 了 和 公式 定理 the of card");
  assert.ok(terms.includes("公式"));
  assert.ok(terms.includes("定理"));
  assert.ok(terms.includes("card"));
  assert.ok(!terms.includes("的"));
  assert.ok(!terms.includes("the"));
});
