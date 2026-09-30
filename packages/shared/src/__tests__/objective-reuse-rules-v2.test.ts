/**
 * 同目标复用的判据（39d W7-5；39 §4.2 第三段、§9.5）。
 *
 * 钉的是三件**代价不对称**的事——所以它们各自要一条正控制：
 *
 *  1. **≥2 个候选 ⇒ 不复用**。错并不可发现（能力记录记到另一件事上，而库里的
 *     目标 id 看不出错），多建是可发现的。正控制是"两个都命中 ⇒ 仍然 create_new，
 *     且 reason 说的是 ambiguous 而不是 no_match"。
 *  2. **形态不同 ⇒ 不复用**，哪怕块完全一样（§4.2「不同能力维度仍可分别需要回访」）。
 *     正控制是"块一样、形态不同 ⇒ different_form"。
 *  3. **判据证据要能复核**：交回的是**交集**与形态，不是一句"判定为同一条"。
 *     正控制是"交回的 sharedBlockIds 恰好是交集，不是候选的全部块"。
 *
 * 另有一条负对照钉住锚点纪律：**连块锚都没有的既有目标不会被认领**——把"不知道"
 * 当成"是同一条"是这一族最容易犯的错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideObjectiveReuseV2, type ObjectiveReuseCandidateV2 } from "../objective-reuse-rules-v2.ts";

const BLOCK_A = "b-1";
const BLOCK_B = "b-2";

const existing = (over: Partial<ObjectiveReuseCandidateV2> = {}): ObjectiveReuseCandidateV2 => ({
  objectiveId: "11111111-1111-4111-8111-111111111111",
  blockIds: [BLOCK_A],
  knowledgeForm: "fact",
  ...over,
});

test("§4.2 同篇 ＋ 同块 ＋ 同形态 ⇒ 落到既有那一颗上，并交回可复核的判据", () => {
  const decided = decideObjectiveReuseV2({
    candidateBlockIds: [BLOCK_A, BLOCK_B],
    knowledgeForm: "fact",
    existing: [existing()],
  });
  assert.equal(decided.outcome, "reuse");
  if (decided.outcome !== "reuse") return;
  assert.equal(decided.objectiveId, "11111111-1111-4111-8111-111111111111");
  assert.equal(decided.basis, "same_note_same_block_same_form");
  // 交回的是**交集**，不是候选的全部块——"当初凭什么说它们同一条"要能读出来。
  assert.deepEqual([...decided.evidence.sharedBlockIds], [BLOCK_A]);
  assert.deepEqual([...decided.evidence.candidateBlockIds], [BLOCK_A, BLOCK_B]);
  assert.equal(decided.evidence.knowledgeForm, "fact");
});

test("§4.2 无法确定时保留差异：两个都命中 ⇒ 仍然新建，且说的是 ambiguous", () => {
  const decided = decideObjectiveReuseV2({
    candidateBlockIds: [BLOCK_A],
    knowledgeForm: "fact",
    existing: [
      existing({ objectiveId: "11111111-1111-4111-8111-111111111111" }),
      existing({ objectiveId: "22222222-2222-4222-8222-222222222222" }),
    ],
  });
  // 选一个的后果不可发现：能力记录会记到另一件事上，而库里的目标 id 看不出错。
  assert.equal(decided.outcome, "create_new");
  assert.equal(decided.outcome === "create_new" ? decided.reason : "", "ambiguous");
});

test("§4.2 不同能力维度分别记：块完全一样但形态不同 ⇒ 不复用", () => {
  const decided = decideObjectiveReuseV2({
    candidateBlockIds: [BLOCK_A],
    // 「记住定义」与「在综合情境中使用」是两条不同的回访需求。
    knowledgeForm: "application_rule",
    existing: [existing({ knowledgeForm: "fact" })],
  });
  assert.equal(decided.outcome, "create_new");
  // reason 要与"根本没交集"分开：屏上与台账得能说清是"形态不同"还是"没有同一处出处"。
  assert.equal(decided.outcome === "create_new" ? decided.reason : "", "different_form");
});

test("正对照：没有块锚的既有目标**不被认领**（把「不知道」当成「是同一条」是最容易犯的错）", () => {
  const decided = decideObjectiveReuseV2({
    candidateBlockIds: [BLOCK_A],
    knowledgeForm: "fact",
    // 老数据：没有块锚。
    existing: [existing({ blockIds: [] })],
  });
  assert.equal(decided.outcome, "create_new");
  assert.equal(decided.outcome === "create_new" ? decided.reason : "", "no_match");
});

test("新候选自己没有块锚时也不复用——那是「无法确定」，不是「是新东西」", () => {
  const decided = decideObjectiveReuseV2({
    candidateBlockIds: [],
    knowledgeForm: "fact",
    existing: [existing()],
  });
  assert.equal(decided.outcome, "create_new");
  // 理由与"没命中"分开：这一个是判据输入缺失，另一个是判下来确实没有。
  assert.equal(decided.outcome === "create_new" ? decided.reason : "", "no_block_anchor");
});

test("真的没有任何既有目标 ⇒ 建新的（首篇笔记那一档）", () => {
  const decided = decideObjectiveReuseV2({
    candidateBlockIds: [BLOCK_A],
    knowledgeForm: "fact",
    existing: [],
  });
  assert.equal(decided.outcome, "create_new");
  assert.equal(decided.outcome === "create_new" ? decided.reason : "", "no_match");
});

test("块不交集 ⇒ 建新的（同一篇里另一处出处，是确实新增的内容）", () => {
  const decided = decideObjectiveReuseV2({
    candidateBlockIds: [BLOCK_B],
    knowledgeForm: "fact",
    existing: [existing({ blockIds: [BLOCK_A] })],
  });
  assert.equal(decided.outcome, "create_new");
  assert.equal(decided.outcome === "create_new" ? decided.reason : "", "no_match");
});
