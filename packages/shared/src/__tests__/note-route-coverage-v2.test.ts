/**
 * 跨轮聚合判据（39d W4-5 ③；PRD §4.4、§16.23）。
 *
 * 每一条判据都对着 §4.4 的一句话写，并且都做过**变异自证**：临时改坏实现，确认红在
 * **这一条**断言上（不是红在语法错误或文件没加载），然后还原。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NOTE_ROUTE_COVERED_STATES_V1,
  decideAttemptHelpConditionV1,
  decideNoteRouteQuestionV1,
  noteRouteCoverageV1Schema,
  noteRouteQuestionIdForConflictV1,
  noteRouteQuestionIdForObjectiveV1,
  summarizeNoteRouteCoverageV1,
  type NoteRouteAttemptFactsV1,
  type NoteRouteExposureFactsV1,
  type NoteRouteQuestionV1,
} from "../note-route-coverage-v2.ts";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const ROUND_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROUND_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OBJECTIVE = "33333333-3333-4333-8333-333333333333";

const attempt = (over: Partial<NoteRouteAttemptFactsV1> = {}): NoteRouteAttemptFactsV1 => ({
  runId: RUN_A,
  outcome: "demonstrated",
  lockedAt: "2026-09-27T10:00:00.000Z",
  settledAt: "2026-09-27T10:05:00.000Z",
  ...over,
});

const exposure = (over: Partial<NoteRouteExposureFactsV1> = {}): NoteRouteExposureFactsV1 => ({
  kind: "answer_reveal",
  exposedAt: "2026-09-27T09:00:00.000Z",
  ...over,
});

const objectiveQuestion = (over: Partial<Parameters<typeof decideNoteRouteQuestionV1>[0]> = {}) =>
  decideNoteRouteQuestionV1({
    questionId: noteRouteQuestionIdForObjectiveV1(OBJECTIVE),
    kind: "objective",
    label: "索引为什么在组合查询里更慢",
    roundIds: [ROUND_A],
    attempts: [attempt()],
    exposures: [],
    ...over,
  });

// ─── §14.1.1：帮助条件的界是回答锁定先后 ───────────────────────────────

test("§14.1.1：锁定前呈现过的暴露让这一次落成「借助完成」", () => {
  assert.equal(decideAttemptHelpConditionV1({ attempt: attempt(), exposures: [exposure()] }), "assisted");
});

test("§14.1.1：锁定**后**才送达的暴露不追溯降低那份已锁定的回答", () => {
  // 正常提交成功之后才显示答案/反馈是常态（§14.1.1 明写不追溯）。
  const after = exposure({ exposedAt: "2026-09-27T10:30:00.000Z" });
  assert.equal(decideAttemptHelpConditionV1({ attempt: attempt(), exposures: [after] }), "independent");
});

test("§14.1.1：多笔暴露里**任何一笔**落在锁定前就算有过帮助（不只看最后一笔）", () => {
  // 真实缺陷形状：`target-snapshot-adapter.ts:293` 那一处就是"只看最近一笔"。
  // 这里锁住的是**先看答案 → 提交 → 事后又来一笔无关呈现**这一串：事后那笔不能洗掉前面那笔。
  const exposures = [exposure({ exposedAt: "2026-09-27T09:00:00.000Z" }),
    exposure({ kind: "evidence_reveal", exposedAt: "2026-09-27T10:30:00.000Z" })];
  assert.equal(decideAttemptHelpConditionV1({ attempt: attempt(), exposures }), "assisted");
  // 只看最后一笔的实现会在这里给 independent。
  assert.equal(decideAttemptHelpConditionV1({ attempt: attempt(), exposures: [exposures[1]] }), "independent");
});

test("§14.1.1：没有锁定的回答就是「没有能判的东西」，不救成独立", () => {
  // 变异自证：把 lockedAt 为 null 强行当成"无暴露"⇒ 独立。
  assert.equal(decideAttemptHelpConditionV1({ attempt: attempt({ lockedAt: null }), exposures: [] }),
    "unknown_no_evidence");
});

// ─── §4.4 门槛：哪一档算「已覆盖」 ─────────────────────────────────────

test("§4.4：独立做过与借助完成都算已覆盖；其余每一档都不算", () => {
  // 变异自证：把 still_needs_help 加进 COVERED ⇒ 本条红。
  assert.equal(NOTE_ROUTE_COVERED_STATES_V1.has("learned_independently"), true);
  assert.equal(NOTE_ROUTE_COVERED_STATES_V1.has("learned_with_help"), true);
  for (const state of ["still_needs_help", "help_condition_unknown", "not_assessable",
    "skipped_by_user", "blocked_by_material_conflict", "not_attempted"] as const) {
    assert.equal(NOTE_ROUTE_COVERED_STATES_V1.has(state), false, `${state} 不许算已覆盖`);
  }
});

test("§4.4：判不出帮助条件的那一次不算独立，也不冒充「学会了」", () => {
  // 没有锁定回答 ⇒ 条件无法确认 ⇒ 单独一档，不进分子（§14.1.1「不签发独立证据」）。
  const q = objectiveQuestion({ attempts: [attempt({ lockedAt: null })] });
  assert.equal(q.state, "help_condition_unknown");
  assert.equal(NOTE_ROUTE_COVERED_STATES_V1.has(q.state), false);
});

// ─── §4.4 优先级：材料矛盾 / 跳过 / 判不了 ─────────────────────────────

test("§4.4：待核对的问题不假装已覆盖，哪怕它底下真的有一发做对了", () => {
  // §16.23 验收原话：「未解决的材料矛盾不假装已覆盖」。
  const q = decideNoteRouteQuestionV1({
    questionId: noteRouteQuestionIdForConflictV1("unit-7"),
    kind: "material_conflict",
    label: "「写入一定比批量慢」这一句与下面那段互相矛盾",
    roundIds: [ROUND_A],
    attempts: [attempt()],
    exposures: [],
    conflictReason: "同一段里两句话给出的结论相反",
  });
  assert.equal(q.state, "blocked_by_material_conflict");
  assert.equal(q.conflictReason, "同一段里两句话给出的结论相反");
  // 变异自证：把材料矛盾这一档排到最后（先看 attempts）⇒ 本条红。
});

test("§4.4：用户主动跳过是单独一档，不进分子，也不被读成「不会」", () => {
  // 变异自证：把 skipped 归进 not_assessable 或 still_needs_help ⇒ 本条红。
  const q = objectiveQuestion({
    attempts: [attempt({ runId: RUN_B, outcome: "skipped", settledAt: "2026-09-27T11:00:00.000Z" })],
  });
  assert.equal(q.state, "skipped_by_user");
  assert.equal(NOTE_ROUTE_COVERED_STATES_V1.has(q.state), false);
});

test("§4.4：跳过的那一发不盖掉同题另一发真的做出来了", () => {
  // 「用户主动跳过」判的是**这一题**，不是**这一轮里某一发**。
  const q = objectiveQuestion({
    attempts: [
      attempt({ runId: RUN_B, outcome: "skipped", settledAt: "2026-09-27T11:00:00.000Z" }),
      attempt({ runId: RUN_A, outcome: "demonstrated" }),
    ],
  });
  assert.equal(q.state, "learned_independently");
});

test("§4.4：系统判不了（not_assessable）不进分子", () => {
  const q = objectiveQuestion({ attempts: [attempt({ outcome: "not_assessable" })] });
  assert.equal(q.state, "not_assessable");
  assert.equal(NOTE_ROUTE_COVERED_STATES_V1.has(q.state), false);
});

test("§4.1：练习过但缺口仍在是「还差着」，不是「学会了」", () => {
  for (const outcome of ["partial", "needs_repair", "declared_unable"] as const) {
    const q = objectiveQuestion({ attempts: [attempt({ outcome })] });
    assert.equal(q.state, "still_needs_help", outcome);
    assert.equal(NOTE_ROUTE_COVERED_STATES_V1.has(q.state), false);
  }
});

test("§5.5：正在跑/评分待返回是附加原因，不是「不会」，也不是「没开始」", () => {
  // §5.5 末句：「系统故障与评分待返回是附加原因，不作为『不会』的终态」。
  // 拿 not_attempted（"纳入但还没练过"）来接一个正在跑的发，两句话完全不同。
  const q = objectiveQuestion({ attempts: [attempt({ outcome: null, lockedAt: null, settledAt: null })] });
  assert.equal(q.state, "in_progress");
  assert.notEqual(q.state, "not_attempted");
  assert.equal(NOTE_ROUTE_COVERED_STATES_V1.has(q.state), false);
});

test("§5.5：正在跑的那一发不盖掉同题另一发已经判完的结论", () => {
  const q = objectiveQuestion({
    attempts: [
      attempt({ runId: RUN_B, outcome: null, lockedAt: null, settledAt: null }),
      attempt({ runId: RUN_A, outcome: "demonstrated" }),
    ],
  });
  assert.equal(q.state, "learned_independently");
});

test("§4.1：一次都没练过是「还没练过」，不发任何能力结论", () => {
  const q = objectiveQuestion({ attempts: [] });
  assert.equal(q.state, "not_attempted");
  assert.equal(q.stateHelpCondition, null);
});

// ─── §4.4：整条路线的那句结论 ─────────────────────────────────────────

const coveredQuestion = (id: string, assisted = false): NoteRouteQuestionV1 => decideNoteRouteQuestionV1({
  questionId: noteRouteQuestionIdForObjectiveV1(id),
  kind: "objective",
  label: `问题 ${id.slice(0, 4)}`,
  roundIds: [ROUND_A],
  attempts: [attempt()],
  exposures: assisted ? [exposure()] : [],
});

test("§4.4：每个纳入的问题都学过 ⇒ 可以说已走完这份核心路线", () => {
  const summary = summarizeNoteRouteCoverageV1({
    noteId: "44444444-4444-4444-8444-444444444444",
    questions: [coveredQuestion(OBJECTIVE), coveredQuestion("55555555-5555-4555-8555-555555555555", true)],
  });
  assert.equal(summary.verdict.kind, "route_complete");
  assert.equal(summary.summary.coveredCount, 2);
  // 「借助完成另外列出」：它进分子，但要单独报数，屏上不许说"全部会用"。
  assert.equal(summary.summary.assistedCount, 1);
  assert.equal(summary.summary.independentCount, 1);
  assert.deepEqual(summary.verdict.uncovered, []);
});

test("§4.4：还有没覆盖的就不能说完成，且未覆盖按状态逐条列出", () => {
  const summary = summarizeNoteRouteCoverageV1({
    noteId: "44444444-4444-4444-8444-444444444444",
    questions: [coveredQuestion(OBJECTIVE), decideNoteRouteQuestionV1({
      questionId: noteRouteQuestionIdForConflictV1("unit-7"),
      kind: "material_conflict", label: "自相矛盾的一段", roundIds: [ROUND_B], attempts: [], exposures: [],
      conflictReason: "两句话结论相反",
    })],
  });
  // 变异自证：把 route_incomplete 也发成 route_complete ⇒ 本条红。
  assert.equal(summary.verdict.kind, "route_incomplete");
  assert.equal(summary.summary.uncoveredCount, 1);
  assert.equal(summary.verdict.uncovered[0]?.state, "blocked_by_material_conflict");
});

test("§4.4：范围被缩小过时结论改口径，但**不把没覆盖的藏起来**", () => {
  // §4.4 头一句禁止的正是"悄悄缩小范围让剩余内容从分母消失"：
  // 变的是 verdict.kind，不是 questions/uncovered。
  const summary = summarizeNoteRouteCoverageV1({
    noteId: "44444444-4444-4444-8444-444444444444",
    questions: [coveredQuestion(OBJECTIVE)],
    scopeAdjustedAt: "2026-09-26T08:00:00.000Z",
    scopeAdjustmentReason: "这次只走前两节",
  });
  assert.equal(summary.verdict.kind, "route_complete_within_adjusted_scope");
  assert.equal(summary.verdict.scopeAdjustmentReason, "这次只走前两节");
  // 变异自证：缩小范围时把 questions 过滤一遍 ⇒ 本条红（questions 恒为纳入过的全部）。
  assert.equal(summary.questions.length, 1);
});

test("§4.4：范围缩小过**也不能**把没覆盖的那些说成已完成", () => {
  // 这是"悄悄缩小分母"最危险的那一种：缩小本身合法，但**不许**拿它把没覆盖的抹掉。
  // 变异自证：缩小范围时过滤 questions ⇒ 本条红（这里有两道断言同时会红）。
  const summary = summarizeNoteRouteCoverageV1({
    noteId: "44444444-4444-4444-8444-444444444444",
    questions: [
      coveredQuestion(OBJECTIVE),
      decideNoteRouteQuestionV1({
        questionId: noteRouteQuestionIdForConflictV1("unit-7"),
        kind: "material_conflict", label: "自相矛盾的一段", roundIds: [ROUND_B], attempts: [], exposures: [],
        conflictReason: "两句话结论相反",
      }),
    ],
    scopeAdjustedAt: "2026-09-26T08:00:00.000Z",
    scopeAdjustmentReason: "这次只走前两节",
  });
  assert.equal(summary.verdict.kind, "route_incomplete");
  assert.equal(summary.questions.length, 2, "缩小范围不改变分母");
  assert.equal(summary.verdict.uncovered.length, 1, "缩小范围不隐藏未覆盖");
});

test("§4.1：一个纳入的问题都没有时是「不承诺覆盖」，不是「已完成」", () => {
  // 变异自证：空集合也发 route_complete ⇒ 本条红（那会让"没开始"读成"已走完"）。
  const summary = summarizeNoteRouteCoverageV1({
    noteId: "44444444-4444-4444-8444-444444444444",
    questions: [],
  });
  assert.equal(summary.verdict.kind, "no_questions");
  assert.equal(summary.summary.totalCount, 0);
  assert.deepEqual(summary.verdict.uncovered, []);
});

// ─── 跨轮归并本身 ─────────────────────────────────────────────────────

test("§4.4：同一个问题在三轮里各做一次，按**最好的一发**归并成一条", () => {
  // §16.23 的形状：三轮走完纳入的核心问题，其中一处借助完成。
  // 最早那一次只答了一半（还差着），后两次在另两轮里做出来了 ⇒ 归并成"学会了"。
  const q = objectiveQuestion({
    roundIds: [ROUND_A, ROUND_B],
    attempts: [
      attempt({ runId: RUN_A, outcome: "partial", lockedAt: "2026-09-20T10:00:00.000Z", settledAt: "2026-09-20T10:05:00.000Z" }),
      attempt({ runId: RUN_B, outcome: "demonstrated", lockedAt: "2026-09-27T10:00:00.000Z", settledAt: "2026-09-27T10:05:00.000Z" }),
    ],
  });
  assert.equal(q.state, "learned_independently");
  assert.equal(q.attempts.length, 2);
  assert.deepEqual(q.roundIds, [ROUND_A, ROUND_B]);
  // 变异自证：位次改成"取最早"或"取最差"⇒ 本条红。
});

test("§4.4：只有最早那一次做出来了时，后续几轮的「还差着」不把它拉回去", () => {
  // 归并取**最好的一发**，不是为了安慰——§4.4 要的是"纳入的每个核心问题都实际学过"，
  // 读过就是读过；后来的没做好不抹掉它（但它也不进"下一处该练什么"那一串，那是别的读数）。
  const q = objectiveQuestion({
    attempts: [
      attempt({ runId: RUN_A, outcome: "demonstrated", lockedAt: "2026-09-20T10:00:00.000Z", settledAt: "2026-09-20T10:05:00.000Z" }),
      attempt({ runId: RUN_B, outcome: "partial", lockedAt: "2026-09-27T10:00:00.000Z", settledAt: "2026-09-27T10:05:00.000Z" }),
    ],
  });
  assert.equal(q.state, "learned_independently");
  // 变异自证：改成"取最差"⇒ 本条红。
});

test("§5.6：借助完成的那一条如实保留，且屏上拿得到它属于哪几轮", () => {
  const q = objectiveQuestion({
    roundIds: [ROUND_A, ROUND_B],
    attempts: [attempt({ lockedAt: "2026-09-27T10:00:00.000Z" })],
    exposures: [exposure({ exposedAt: "2026-09-27T09:30:00.000Z" })],
  });
  assert.equal(q.state, "learned_with_help");
  assert.equal(q.stateHelpCondition, "assisted");
  assert.equal(NOTE_ROUTE_COVERED_STATES_V1.has(q.state), true);
});

// ─── 合同形状 ─────────────────────────────────────────────────────────

test("线上合同：整条路线那份回信过 zod，且缺格会被挡", () => {
  const summary = summarizeNoteRouteCoverageV1({
    noteId: "44444444-4444-4444-8444-444444444444",
    questions: [coveredQuestion(OBJECTIVE)],
  });
  const parsed = noteRouteCoverageV1Schema.safeParse(summary);
  assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  // 变异自证：summary / verdict 缺一格 ⇒ 解析失败（本条红在"缺格被挡"这一句）。
  const { summary: _dropSummary, ...withoutSummary } = summary;
  assert.equal(noteRouteCoverageV1Schema.safeParse(withoutSummary).success, false);
  const { uncovered: _dropUncovered, ...verdict } = summary.verdict;
  assert.equal(noteRouteCoverageV1Schema.safeParse({ ...summary, verdict }).success, false);
});

test("§4.4 读侧口径：待核对那一档的 id 不是 uuid，屏上不能把它当成真目标", () => {
  const id = noteRouteQuestionIdForConflictV1("unit-7");
  assert.equal(id, "material_conflict:unit-7");
  assert.equal(z_isUuid(id), false, "编一个假目标 id 迟早会被当成真目标去点");
  assert.equal(noteRouteQuestionIdForObjectiveV1(OBJECTIVE), `objective:${OBJECTIVE}`);
});

function z_isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
