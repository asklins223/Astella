/**
 * 「补一节前置」提案判据的用例（39d W4-6 刀四·正面要求那一档；§16.3、§5.3、§4.3）。
 *
 * 这一组判的是**三条不变量**（见 `prerequisite-policy.ts` 文件头）：
 *   1. 候选只来自本轮冻结材料，材料里挑不出来时答案是 `none` 而**不是编一个**；
 *   2. 已经讲过的块不算前置（那是 `switch_explanation` 那一档的职责）；
 *   3. 学习量是"要读几段"而不是几个字，且「较大分支」由冻结阈值判、不写死。
 *
 * 纯函数全部在这里量，所以不需要数据库也不花模型调用——§5.3 那句"较大分支交给用户
 * 选择"的界线要能被单独试出来，靠的就是这一层。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countPrerequisiteStepsV1,
  DEFAULT_PREREQUISITE_LARGE_BRANCH_STEPS_V1,
  prerequisiteLargeBranchThresholdV1,
  proposePrerequisiteV1,
  type PrerequisiteCandidateBlockV1,
} from "./prerequisite-policy.ts";

function block(
  ordinal: number,
  text: string,
  overrides: Partial<PrerequisiteCandidateBlockV1> = {},
): PrerequisiteCandidateBlockV1 {
  return { ordinal, type: "paragraph", text, usedByCurrentRound: false, ...overrides };
}

/** 一段够长的正文（判据有 24 字符的下限，太短的不算候选）。 */
const LONG = "索引在查找时把整棵 B+ 树读进内存，这个代价与树的高度成正比。";

test("材料里挑不出东西 ⇒ none，且不给出 label（§5.3 不生成貌似确定的过程）", () => {
  for (const blocks of [[], [block(1, ""), block(2, "   ")], [block(1, "太短了")]]) {
    const proposal = proposePrerequisiteV1({ blocks, largeBranchThreshold: 2 });
    assert.equal(proposal.kind, "none", "有材料却给出了候选");
    assert.equal("label" in proposal, false, "none 那一档带 label ⇒ 界面会念出一句没有依据的话");
  }
});

test("不变量①：候选只来自本轮冻结材料（不外求、不联网、不补造）", () => {
  // 判据只吃调用方给的 blocks；它自己没有任何"去找材料"的入口，所以这一条由**入参形状**
  // 保证：下面这条用例同时钉住"它不会凭空造出 ordinal 不在入参里的依据"。
  const proposal = proposePrerequisiteV1({
    blocks: [block(7, LONG)],
    largeBranchThreshold: 2,
  });
  assert.equal(proposal.kind, "candidate");
  assert.deepEqual(proposal.kind === "candidate" ? proposal.evidenceBlockOrdinals : [], [7],
    "依据的块序号不在本轮冻结材料里 ⇒ 它去别处找了内容");
});

test("不变量②：已经讲过的块不算前置", () => {
  const proposal = proposePrerequisiteV1({
    blocks: [
      block(1, LONG, { usedByCurrentRound: true }),
      block(2, `${LONG}补一句说明。`, { usedByCurrentRound: true }),
      block(3, `真正没讲过的一节：${LONG}`),
    ],
    largeBranchThreshold: 2,
  });
  assert.equal(proposal.kind, "candidate");
  const ordinals = proposal.kind === "candidate" ? proposal.evidenceBlockOrdinals : [];
  assert.ok(!ordinals.includes(1) && !ordinals.includes(2),
    `把用户刚看过的块 ${JSON.stringify(ordinals)} 摆成「补前置」——那是「换解释」那一档的职责`);
});

test("不变量②的反面：全部块都讲过 ⇒ nothing_beyond_current（与「材料不够」分开说）", () => {
  const proposal = proposePrerequisiteV1({
    blocks: [block(1, LONG, { usedByCurrentRound: true }), block(2, LONG, { usedByCurrentRound: true })],
    largeBranchThreshold: 2,
  });
  assert.deepEqual(proposal, { kind: "none", reason: "nothing_beyond_current" },
    "这一档与 no_usable_material 是两句不同的话，合并了界面就只能念成「没有可补的」");
});

test("不变量③：学习量数的是「要读几段」，不是几个字", () => {
  const short = proposePrerequisiteV1({ blocks: [block(1, LONG)], largeBranchThreshold: 99 });
  const long = proposePrerequisiteV1({
    blocks: [block(1, `${LONG}${LONG}${LONG}${LONG}`)],
    largeBranchThreshold: 99,
  });
  assert.equal(short.kind === "candidate" ? short.estimatedSteps : null, 1);
  assert.equal(long.kind === "candidate" ? long.estimatedSteps : null, 1,
    "同一个块写成四倍长，学习量就变了 ⇒ 量的不是「要读几段」，用户拿它做不了决定");
});

test("可教要点：标题与列表项各算一，散段落整组算一", () => {
  assert.equal(countPrerequisiteStepsV1([
    block(1, "一、前置定义是什么", { type: "heading" }),
    block(2, "第一条要点，需要单独讲。", { type: "listItem" }),
    block(3, "第二条要点，同样需要单独讲。", { type: "listItem" }),
    block(4, LONG),
  ]), 3, "两个列表项 + 一个标题 = 3 个可教要点（散段落不单独计，它作为一段被读）");
  assert.equal(countPrerequisiteStepsV1([]), 0, "没有块时不该凭空说有一步");
});

test("「较大分支」由冻结阈值判，不写死：阈值放大后同一份材料不再算大", () => {
  // 每一块都要够长（判据有 24 字符下限），否则这条用例测的是长度下限而不是阈值。
  const blocks = [
    block(1, "一、前置定义：先把这个词的边界说清楚，再谈它在流程里的位置。", { type: "heading" }),
    block(2, "二、它解决的是哪一类问题，以及它不解决什么，这两句要分开讲。", { type: "listItem" }),
  ];
  const strict = proposePrerequisiteV1({ blocks, largeBranchThreshold: 1 });
  const loose = proposePrerequisiteV1({ blocks, largeBranchThreshold: 5 });
  assert.equal(strict.kind, "candidate", "样本本身被判成 none ⇒ 这条用例在测别的东西");
  assert.equal(strict.kind === "candidate" ? strict.largeBranch : null, true);
  assert.equal(loose.kind === "candidate" ? loose.largeBranch : null, false,
    "阈值放大后仍判「较大」⇒ 那一档是写死的，§18.4 冻结的数改了它也不动");
});

test("连续才是一「节」：序号断开就停，不把两处不相干的补在一起", () => {
  const proposal = proposePrerequisiteV1({
    blocks: [block(1, LONG), block(5, `${LONG}另起一处。`)],
    largeBranchThreshold: 99,
  });
  assert.deepEqual(proposal.kind === "candidate" ? proposal.evidenceBlockOrdinals : [], [1],
    "跳着序号取块 ⇒ 「补一节前置」变成了两处不相干的补充");
});

test("最多三块：再多就不是「补一节」而是「上一堂课」（§5.3 不自动扩张）", () => {
  const proposal = proposePrerequisiteV1({
    blocks: [1, 2, 3, 4, 5].map((n) => block(n, `${LONG}${n}`)),
    largeBranchThreshold: 99,
  });
  const ordinals = proposal.kind === "candidate" ? proposal.evidenceBlockOrdinals : [];
  assert.equal(ordinals.length, 3, `取了 ${ordinals.length} 块：超过三块就不是补一节了`);
});

test("候选措辞是「可能缺」而不是「你缺」（§16.3 原文、§5.3「可能卡在……」）", () => {
  const proposal = proposePrerequisiteV1({ blocks: [block(1, LONG)], largeBranchThreshold: 2 });
  assert.equal(proposal.kind, "candidate");
  const label = proposal.kind === "candidate" ? proposal.label : "";
  assert.match(label, /可能/,
    "label 断言了用户缺什么：模型相似度只能提供建议、不能独立授权（D3 那条线）");
  assert.doesNotMatch(label, /你缺|你不懂|你不会/, "label 在替用户下诊断结论");
});

test("冻结阈值：坏值回落默认且保持可预测（与 gap-help 那条同一形状）", () => {
  const original = process.env.NOTE_ROUND_PREREQUISITE_LARGE_BRANCH_STEPS;
  try {
    delete process.env.NOTE_ROUND_PREREQUISITE_LARGE_BRANCH_STEPS;
    assert.equal(prerequisiteLargeBranchThresholdV1(), DEFAULT_PREREQUISITE_LARGE_BRANCH_STEPS_V1);
    process.env.NOTE_ROUND_PREREQUISITE_LARGE_BRANCH_STEPS = "4";
    assert.equal(prerequisiteLargeBranchThresholdV1(), 4);
    // `0` 合法（任何多于一格的都算较大分支）；负数与非整数按坏值回落。
    process.env.NOTE_ROUND_PREREQUISITE_LARGE_BRANCH_STEPS = "0";
    assert.equal(prerequisiteLargeBranchThresholdV1(), 0);
    for (const bad of ["-1", "2.5", "abc", ""]) {
      process.env.NOTE_ROUND_PREREQUISITE_LARGE_BRANCH_STEPS = bad;
      assert.equal(prerequisiteLargeBranchThresholdV1(), DEFAULT_PREREQUISITE_LARGE_BRANCH_STEPS_V1,
        `坏值 ${JSON.stringify(bad)} 没有回落默认`);
    }
  } finally {
    if (original === undefined) delete process.env.NOTE_ROUND_PREREQUISITE_LARGE_BRANCH_STEPS;
    else process.env.NOTE_ROUND_PREREQUISITE_LARGE_BRANCH_STEPS = original;
  }
});

test("判据对不变量②灵敏：把「剔掉已用过的」放掉，同一个样本必须翻", () => {
  // 同一份逻辑的内存变异：去掉"剔掉已用过的"那一行之后，§不变量②的样本必须翻。
  const blocks = [block(1, LONG, { usedByCurrentRound: true }), block(2, `${LONG}新的。`)];
  const guarded = proposePrerequisiteV1({ blocks, largeBranchThreshold: 2 });
  assert.deepEqual(guarded.kind === "candidate" ? guarded.evidenceBlockOrdinals : [], [2]);
  // 把「已用过」这一层整个去掉之后，块 1 重新进入候选，而且因为它与块 2 连续，会连它一起取。
  const unguarded = proposePrerequisiteV1({
    blocks: blocks.map((b) => ({ ...b, usedByCurrentRound: false })),
    largeBranchThreshold: 2,
  });
  const guardedOrdinals = guarded.kind === "candidate" ? guarded.evidenceBlockOrdinals : [];
  const unguardedOrdinals = unguarded.kind === "candidate" ? unguarded.evidenceBlockOrdinals : [];
  assert.deepEqual(guardedOrdinals, [2], "样本前提不成立：剔除已用过的之后本该只剩块 2");
  assert.deepEqual(unguardedOrdinals, [1, 2],
    "去掉「已用过」这一层之后判据没有把块 1 放回候选 ⇒ 它其实没在读那个标记（这条判据恒真）");
  assert.ok(!guardedOrdinals.includes(1) && unguardedOrdinals.includes(1),
    "两侧样本没有差别：拿不到「剔掉已用过的」这一层到底起没起作用");
});
