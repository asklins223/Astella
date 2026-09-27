/**
 * 星图那条边的**读侧叠加**（39d W5-6 刀七；39 §11.3）。纯函数、不碰库，所以单测跑得起来。
 *
 * §11.3 那一整句在这里被拆成三档可展示的事实：
 * "模型推测的前置、相似或应用关系先作为**待确认建议**，不自动成为实线或影响正式掌握"。
 * 关键在 `countsAsEstablished`：**只有 confirmed 算成立**。待确认建议哪怕画成一条实线，
 * 也不能进任何"正式掌握"的计算——那是本条与那些"建议边"之间的全部区别。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPersonalRelationDecisionsV2 } from "./personal-relation-decision-service.ts";

const A = "3b0f1a52-0000-4000-8000-0000000000a1";
const B = "3b0f1a52-0000-4000-8000-0000000000b2";
const C = "3b0f1a52-0000-4000-8000-0000000000c3";

const edges = [
  { fromObjectiveId: A, toObjectiveId: B, relation: "prerequisite", label: "A→B" },
  { fromObjectiveId: B, toObjectiveId: A, relation: "prerequisite", label: "B→A" },
  { fromObjectiveId: A, toObjectiveId: C, relation: "contrasts", label: "A→C" },
] as const;

test("没表态的一律是 suggested，且不算成立的关系", () => {
  const out = applyPersonalRelationDecisionsV2({ suggested: edges, decisions: [] });
  assert.equal(out.length, 3);
  for (const row of out) {
    assert.equal(row.relationStatus, "suggested");
    assert.equal(row.countsAsEstablished, false, "待确认建议不因模型推测而成为实线");
  }
});

test("确认过的才算成立；藏起来的那一条不呈现（dismissed ≠ 弱化）", () => {
  const out = applyPersonalRelationDecisionsV2({
    suggested: edges,
    decisions: [
      { fromObjectiveId: A, toObjectiveId: B, relation: "prerequisite", decision: "confirmed" },
      { fromObjectiveId: A, toObjectiveId: C, relation: "contrasts", decision: "dismissed" },
    ],
  });
  const ab = out.find((r) => r.label === "A→B");
  const ba = out.find((r) => r.label === "B→A");
  const ac = out.find((r) => r.label === "A→C");
  assert.equal(ab?.relationStatus, "confirmed");
  assert.equal(ab?.countsAsEstablished, true);
  // 方向不同就是不同的边：确认 A→B 不影响 B→A 那一档。
  assert.equal(ba?.relationStatus, "suggested");
  assert.equal(ba?.countsAsEstablished, false);
  // 藏起来的那一条**不画**，所以它不该算成立。
  assert.equal(ac?.relationStatus, "dismissed");
  assert.equal(ac?.countsAsEstablished, false);
});

test("关系种类参与匹配：同一条边、不同种类是两条决定", () => {
  const out = applyPersonalRelationDecisionsV2({
    suggested: [{ fromObjectiveId: A, toObjectiveId: B, relation: "explains", label: "A→B/explains" }],
    // 表里存的是 `prerequisite` 那一档
    decisions: [
      { fromObjectiveId: A, toObjectiveId: B, relation: "prerequisite", decision: "confirmed" },
    ],
  });
  assert.equal(out[0].relationStatus, "suggested", "种类不同却串了决定——键少了一维");
});

test("只影响本人：另一个人的决定不叠到这一份视图上", () => {
  const mine = applyPersonalRelationDecisionsV2({
    suggested: edges,
    decisions: [{ fromObjectiveId: A, toObjectiveId: B, relation: "prerequisite", decision: "confirmed" }],
  });
  const theirs = applyPersonalRelationDecisionsV2({ suggested: edges, decisions: [] });
  assert.equal(mine[0].countsAsEstablished, true);
  assert.equal(theirs[0].relationStatus, "suggested", "别人的确认漏进了我的视图");
  assert.equal(theirs[0].countsAsEstablished, false);
});

test("判据自己的灵敏度：漏掉一个分量就会串边", () => {
  // 同一对 (from,to) 两种关系，键若只按 (from,to) 建，第二个会覆盖第一个。
  const twoKinds = [
    { fromObjectiveId: A, toObjectiveId: B, relation: "prerequisite", label: "pre" },
    { fromObjectiveId: A, toObjectiveId: B, relation: "explains", label: "exp" },
  ] as const;
  const out = applyPersonalRelationDecisionsV2({
    suggested: twoKinds,
    decisions: [
      { fromObjectiveId: A, toObjectiveId: B, relation: "prerequisite", decision: "confirmed" },
    ],
  });
  assert.equal(out.find((r) => r.label === "pre")?.countsAsEstablished, true);
  assert.equal(out.find((r) => r.label === "exp")?.countsAsEstablished, false);
});
