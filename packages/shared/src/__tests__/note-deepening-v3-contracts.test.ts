/**
 * 星图三层展开与状态三轴的判据（39d W8-1、W8-3；39 §11.2、§11.4、§11.5、§16.12）。
 *
 * 判据钉的是**产品决定**，不是实现细节。四条：
 *
 *  1. **三轴分开**（§11.4）。`noteStateAxesV3` 就是三个并列的具名事实，没有第四个
 *     键；值域是字面量枚举而不是数字，所以"把三轴折成一个亮度"在类型层就无处安放。
 *  2. **不用数量画理解百分比**（§11.4 逐字）。做法不是"断言某个函数里没有除法"
 *     （那钉的是实现），而是**行为钉**：把记录从 1 条放大到 400 条，三轴**逐字不动**。
 *     任何"按条数算一算"的实现都会在这一条上红，而一个只是多查了几行的实现不会。
 *  3. **没有学习记录时不伪造内部要点与关系**（§11.2 逐字）。零目标、零记录时层二是
 *     **空的**，不是"正在建立理解"这类句子。
 *  4. **有正文的笔记无需制卡即可出现**（§11.2、§16.12）。这一格是**结构**上的：
 *     `buildNoteDeepeningV3` 的入参里根本没有"卡片"这一项——把"有没有卡"当成
 *     "这篇笔记能不能被读到"的前置，那正是 §11.2 删掉的那个门槛。
 *
 * 另加两条**互不干扰**的判据（§11.4 第二、三行的"不能混成的含义"）：
 *   - 到期不改写表现轴（「到期就变成'不会'」）
 *   - 材料变化不改写表现轴（「资料变化就是用户退步」）
 * 它们与第 1 条不是同一句话：第 1 条说"不许合成一个数"，这两条说"不许让一轴
 * 悄悄改写另一轴"。只钉第 1 条的实现，照样可能把 `due_for_review` 顺手写成
 * `performance: "met_once"`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildNoteDeepeningV3,
  deriveNoteStateAxesV3,
  noteDeepeningV3Schema,
  type NoteDeepeningInputV3,
  type NoteDeepeningObjectiveV3,
  type NoteDeepeningRecordV3,
} from "../contracts/note-deepening-v3-contracts.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const OBJECTIVE_A = "22222222-2222-4222-8222-222222222222";
const OBJECTIVE_B = "33333333-3333-4333-8333-333333333333";
const EVIDENCE = "44444444-4444-4444-8444-444444444444";

function objective(overrides: Partial<NoteDeepeningObjectiveV3> = {}): NoteDeepeningObjectiveV3 {
  return {
    objectiveId: OBJECTIVE_A,
    label: "为什么有索引查询仍然可能慢",
    summary: "索引缩小了扫描范围，但结果规模仍会影响代价。",
    state: "stable",
    runId: null,
    cardId: null,
    ...overrides,
  };
}

let recordSeq = 0;
function record(overrides: Partial<NoteDeepeningRecordV3> = {}): NoteDeepeningRecordV3 {
  recordSeq += 1;
  return {
    recordId: `55555555-5555-4555-8555-${String(recordSeq).padStart(12, "0")}`,
    runId: "66666666-6666-4666-8666-666666666666",
    objectiveId: OBJECTIVE_A,
    objectiveLabel: "为什么有索引查询仍然可能慢",
    answerForm: "prose",
    answerText: "索引把要扫的行数降下来了，但还是要看它捞出来多少行。",
    feedback: [{ verdict: "partial", reason: "结果规模那一半还没有自己的例子。" }],
    occurredAt: "2026-09-20T10:00:00.000Z",
    materialBasis: [{ evidenceSnapshotId: EVIDENCE, supportSummary: "讲义第 3 段：选择率与代价的关系。" }],
    cardId: "77777777-7777-4777-8777-777777777777",
    ...overrides,
  };
}

function input(overrides: Partial<NoteDeepeningInputV3> = {}): NoteDeepeningInputV3 {
  return {
    noteId: NOTE_ID,
    noteTitle: "索引与代价",
    hasBody: true,
    sourceId: "88888888-8888-4888-8888-888888888888",
    openDrivingQuestion: null,
    objectives: [objective()],
    relations: [{
      edgeId: "rel-1",
      otherObjectiveId: OBJECTIVE_B,
      otherLabel: "选择率",
      relation: "prerequisite",
      status: "suggested",
      reasonCodes: ["prerequisite"],
    }],
    records: [record()],
    recordsComplete: true,
    independentCount: 1,
    assistedCount: 0,
    independentDayCount: 1,
    paused: false,
    reviewDue: false,
    basis: "holds",
    ...overrides,
  };
}

// ── 判据 1：三轴就是三个并列的具名事实 ──────────────────────────────────

test("§11.4：三轴分开表达，三份都是具名事实而不是分数", () => {
  const axes = noteDeepeningV3Schema.parse(buildNoteDeepeningV3(input())).axes;
  assert.deepEqual(Object.keys(axes).sort(), ["applicability", "nextStep", "performance"],
    "三轴必须恰好是这三格：多一格就是那个被合成出来的'整篇亮度'");
  for (const [axis, value] of Object.entries(axes)) {
    assert.equal(typeof value, "string", `${axis} 必须是陈述句，不是可以求平均的数字`);
  }
  // 值域里没有"已掌握"：§11.4「不能混成的含义＝自动等于长期掌握」。
  assert.ok(!(["mastered", "mastery", "proficient"] as string[]).includes(axes.performance));
});

test("§11.4：值域是字面量枚举，所以'按比例算一个理解度'在类型层无处安放", () => {
  const axes = deriveNoteStateAxesV3({
    recordCount: 12, independentCount: 5, assistedCount: 4, independentDayCount: 3,
    paused: false, openJourney: true, reviewDue: false, needsRelearn: false, basis: "holds",
  });
  for (const value of Object.values(axes)) {
    assert.equal(typeof value, "string");
  }
  // 整份读里一个数字都不许有：`strictObject` 会在多写一格时当场红。
  assert.throws(
    () => noteDeepeningV3Schema.parse({
      ...buildNoteDeepeningV3(input()),
      understandingPercent: 73,
    }),
    /unrecognized|Strict|Unsafe/i,
    "多带一格必须在解析层就被拒，而不是渲染层悄悄把它画成更亮的一颗星",
  );
});

// ── 判据 2：不按数量画理解百分比 ─────────────────────────────────────────

test("§11.4：把学习记录从 1 条放大到 400 条，三轴逐字不动", () => {
  const facts = {
    independentCount: 1, assistedCount: 0, independentDayCount: 1,
    paused: false, openJourney: false, reviewDue: false, needsRelearn: false, basis: "holds",
  } as const;
  const one = deriveNoteStateAxesV3({ ...facts, recordCount: 1 });
  const many = deriveNoteStateAxesV3({ ...facts, recordCount: 400 });
  assert.deepEqual(many, one,
    "记录条数只允许分'有没有'这一档；一旦它能改写任一轴，就是'证据条数画成理解百分比'");

  // **第二个场景，而且是必须的那一个**：上一次那一组事实里 `independentCount: 1`
  // 会把两边的答案都钉在 `used_independently` 上，于是"按条数升级"的一个实现
  // 恰好蒙对（第一版变异就是在这儿空转的）。这一组不同：一次都没独立用过，
  // 独立次数与独立天数都是 0，**唯一变的是条数**——于是任何"练得越多越亮"的
  // 实现在这里必然露馅。
  const assistedOnly = {
    independentCount: 0, assistedCount: 1, independentDayCount: 0,
    paused: false, openJourney: false, reviewDue: false, needsRelearn: false, basis: "holds",
  } as const;
  const assistedOnce = deriveNoteStateAxesV3({ ...assistedOnly, recordCount: 1 });
  const assistedOften = deriveNoteStateAxesV3({ ...assistedOnly, recordCount: 400 });
  assert.equal(assistedOnce.performance, "assisted_once");
  assert.equal(assistedOften.performance, "assisted_once",
    "400 次借助完成仍然是'借助完成'：条数多不等于独立用过（§11.4 第一行）");

  // 卡片数同理：目标从 1 条到 40 条，三轴也不许动（§11.4 逐字点名的四种量之一）。
  const oneObjective = buildNoteDeepeningV3(input());
  const fortyObjectives = buildNoteDeepeningV3(input({
    objectives: Array.from({ length: 40 }, (_, index) => objective({
      objectiveId: `99999999-9999-4999-8999-${String(index).padStart(12, "0")}`,
    })),
  }));
  assert.deepEqual(fortyObjectives.axes, oneObjective.axes,
    "目标条数与三轴无关：多画几颗星不等于更懂");
});

// ── 判据 3：不伪造内部要点与关系 ─────────────────────────────────────────

test("§11.2：没有学习记录时不伪造内部要点与关系，只留笔记与真实材料链接", () => {
  const empty = buildNoteDeepeningV3(input({
    objectives: [],
    relations: [],
    records: [],
    independentCount: 0,
    assistedCount: 0,
    independentDayCount: 0,
  }));
  assert.deepEqual(empty.local.coreQuestions, [], "零目标时'核心问题'是空的，不是一句编出来的问句");
  assert.deepEqual(empty.local.objectives, []);
  assert.deepEqual(empty.local.relations, [], "零目标时不许凭空长出关系");
  assert.deepEqual(empty.local.gaps, []);
  assert.deepEqual(empty.records, []);
  // 留下来的只有**真的**：这一篇笔记本身，以及它背后真实的来源。
  assert.equal(empty.noteId, NOTE_ID);
  assert.equal(empty.hasBody, true);
  assert.equal(empty.sourceId, "88888888-8888-4888-8888-888888888888");
  assert.equal(empty.axes.performance, "no_record_yet");
  assert.equal(empty.axes.nextStep, "nothing_to_do");
});

test("§11.2：有正文的笔记无需制卡即可出现——展开结果不因'有没有卡'而变", () => {
  // 正对照：同一篇笔记，一份每条都挂着记忆卡，一份一条都没有。
  // **要比的是"这一篇展开出来是什么"**（三轴、核心问题、缺口、关系），
  // 不是逐字相同——`cardId` 本身是 §11.2 第三行明写的一格（"可选卡片"），
  // 把它一起比掉，这条判据就会逼着实现把"可选卡片"这一格删了才算过。
  const withCard = buildNoteDeepeningV3(input());
  const withoutCard = buildNoteDeepeningV3(input({
    objectives: [objective({ cardId: null })],
    records: [record({ cardId: null })],
  }));
  assert.deepEqual(withoutCard.axes, withCard.axes);
  assert.deepEqual(withoutCard.local.coreQuestions, withCard.local.coreQuestions);
  assert.deepEqual(withoutCard.local.gaps, withCard.local.gaps);
  assert.deepEqual(withoutCard.local.relations, withCard.local.relations);
  assert.equal(withoutCard.records.length, withCard.records.length,
    "有没有卡不改变记录条数：卡片是目标详情里的一条记忆工具链接（§11.2 末段），"
    + "不是这一篇能不能被展开的前置");
  // 而且类型上就不存在"先有卡才读得到"这一说：入参里根本没有卡片清单。
  assert.ok(!("cards" in (input() as unknown as Record<string, unknown>)));
});

test("§11.3：本人收起的关系不进'这一篇里有哪些关系'这一层", () => {
  const hidden = buildNoteDeepeningV3(input({
    relations: [{
      edgeId: "rel-hidden", otherObjectiveId: OBJECTIVE_B, otherLabel: "选择率",
      relation: "prerequisite", status: "dismissed", reasonCodes: ["prerequisite"],
    }],
  }));
  assert.deepEqual(hidden.local.relations, [],
    "收起来的关系在公共拓扑里还在（那是公共结构），但不该继续在本人这一层占一行");
});

// ── 判据 4：三轴互不干扰（§11.4 第二、三行的"不能混成的含义"）──────────

test("§11.4 轴二：到期不把表现轴改写成'没学会'", () => {
  const due = deriveNoteStateAxesV3({
    recordCount: 3, independentCount: 1, assistedCount: 1, independentDayCount: 1,
    paused: false, openJourney: false, reviewDue: true, needsRelearn: false, basis: "holds",
  });
  assert.equal(due.nextStep, "due_for_review");
  assert.equal(due.performance, "used_independently",
    "到期是'适合回访'，不是'不会'——表现轴不许被下一步那一列改写");
});

test("§11.4 轴三：材料变化不把表现轴改写成用户退步", () => {
  const outdated = deriveNoteStateAxesV3({
    recordCount: 3, independentCount: 3, assistedCount: 0, independentDayCount: 2,
    paused: false, openJourney: false, reviewDue: false, needsRelearn: false, basis: "updated",
  });
  assert.equal(outdated.applicability, "basis_updated");
  assert.equal(outdated.performance, "repeated_over_time",
    "资料变化是**材料**的状态，与她过去做过什么无关");
});

test("§11.4 轴二：本人暂停排在到期与缺口前面", () => {
  const paused = deriveNoteStateAxesV3({
    recordCount: 3, independentCount: 1, assistedCount: 0, independentDayCount: 1,
    paused: true, openJourney: true, reviewDue: true, needsRelearn: true, basis: "holds",
  });
  assert.equal(paused.nextStep, "paused_by_user",
    "'我先停一下'是她的决定；下一次到期不该把它顶掉");
});

// ── 判据 5：§11.5 截断诚实 ──────────────────────────────────────────────

test("§11.5：记录被截断时如实说明，屏上才不许报总数", () => {
  const truncated = buildNoteDeepeningV3(input({ recordsComplete: false }));
  assert.equal(truncated.recordsComplete, false);
  // 这一格是**必填**：缺了它，渲染层只能拿"本页几条"去冒充"一共几条"。
  assert.throws(
    () => noteDeepeningV3Schema.parse({ ...buildNoteDeepeningV3(input()), recordsComplete: undefined }),
    /recordsComplete|Required|Invalid/i,
  );
});
