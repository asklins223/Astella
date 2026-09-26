/**
 * 轮次线上合同的自证（39d W4-5 第三刀）。
 *
 * 这一族合同测试在这个仓库里存在的理由很具体：wire 与 DB 那两侧各有一份形状时，
 * 漂移的症状不是报错，而是"读得到但字段是空的"或"写得进去但回执解析失败"。
 * 这里钉三件：
 *  1. **一份完整的回读能过**（正向对照，证明判据真读到了字段而不是恒拒）；
 *  2. **`.strict()` 真的不收多余键**——创建请求里塞 `noteVersionId` 必须被拒：
 *     "实际用哪一版正文"由服务端读（PRD §3.4），这格不是装饰；
 *  3. **哈希那格的宽度与 0282 的 CHECK 一致（8～128）**。上一版这里写的是
 *     `^[0-9a-f]{64}$`，而 `note_versions.content_hash` 今天的主形状是 **32 位 md5**
 *     （`computeContentHash`），合同比库严 ⇒ 真实笔记的每一发创建都会在回执解析上炸。
 *     两处必须同宽，这一条就是让它不能不同宽。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceNoteLearningRoundRequestV1Schema,
  createNoteLearningRoundRequestV1Schema,
  createRoundTeachingRequestV1Schema,
  noteLearningRoundHistoryItemV1Schema,
  noteLearningRoundHistoryPageV1Schema,
  noteLearningRoundPersonalHistoryPageV1Schema,
  noteLearningRoundV1Schema,
  roundTeachingViewV1Schema,
} from "./note-learning-round-contracts.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const ROUND_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
/** 真实主形状：32 位 md5（`apps/api/src/modules/note/content-hash.ts:25-28`）。 */
const MD5_HASH = "726f6b03d3d48cc646abd3b370ce97e8";

function roundFixture(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    roundId: ROUND_ID,
    noteId: NOTE_ID,
    phase: "active",
    outcome: null,
    drivingQuestion: "判断为什么有索引，查询仍然可能慢",
    drivingQuestionSource: "suggested",
    drivingQuestionRevision: 1,
    noteVersionId: VERSION_ID,
    sourceContentHash: MD5_HASH,
    evidenceSnapshotIds: [],
    budgets: { maxModelCalls: 8, maxWallClockSeconds: 900, maxTasks: 6 },
    revision: 1,
    pausedAt: null,
    resumedAt: null,
    closedAt: null,
    createdAt: "2026-09-26T04:00:00.000+08:00",
    updatedAt: "2026-09-26T04:00:00.000+08:00",
    ...overrides,
  };
}

test("一份完整的轮次回读能过合同（正向对照）", () => {
  const parsed = noteLearningRoundV1Schema.parse(roundFixture());
  assert.equal(parsed.sourceContentHash, MD5_HASH);
  assert.equal(parsed.budgets.maxTasks, 6);
  // 时间带时区偏移：桌面拿的是 ISO 字符串，`datetime({ offset: true })` 收 Z 也收 +08:00。
  assert.equal(
    noteLearningRoundV1Schema.safeParse(roundFixture({ createdAt: "2026-09-25T20:00:00Z" })).success,
    true,
  );
});

test("32 位（真实主形状）收，短于 8 与长于 128 不收——与 0282 的 CHECK 同宽", () => {
  assert.equal(noteLearningRoundV1Schema.safeParse(roundFixture({ sourceContentHash: MD5_HASH })).success, true);
  assert.equal(noteLearningRoundV1Schema.safeParse(roundFixture({ sourceContentHash: "a".repeat(64) })).success, true,
    "将来换成 sha256 那种 64 位也该收：这一格判的是\u201c有没有一串可比对的哈希\u201d，不是某一种算法");
  assert.equal(noteLearningRoundV1Schema.safeParse(roundFixture({ sourceContentHash: "a".repeat(7) })).success, false);
  assert.equal(noteLearningRoundV1Schema.safeParse(roundFixture({ sourceContentHash: "a".repeat(129) })).success, false);
  // 非十六进制的历史夹具值（'fixture-hash'）也在窗口内：库那侧收它，合同就不许拒它。
  assert.equal(noteLearningRoundV1Schema.safeParse(roundFixture({ sourceContentHash: "fixture-hash" })).success, true);
});

test("创建请求不收 `noteVersionId`：那一版由服务端读，客户端没有这一格", () => {
  assert.equal(
    createNoteLearningRoundRequestV1Schema.safeParse({
      noteId: NOTE_ID, drivingQuestion: "一句", drivingQuestionSource: "suggested",
    }).success,
    true,
  );
  assert.equal(
    createNoteLearningRoundRequestV1Schema.safeParse({
      noteId: NOTE_ID, drivingQuestion: "一句", drivingQuestionSource: "suggested",
      noteVersionId: VERSION_ID,
    }).success,
    false,
    "PRD §3.4：让客户端点名版本，等于让那个可能显示着旧屏的进程决定\u201c按哪一版学习\u201d",
  );
  // 预算也没有这一格：那是服务端的一份常量（§18.4 的试用前冻结项）。
  assert.equal(
    createNoteLearningRoundRequestV1Schema.safeParse({
      noteId: NOTE_ID, drivingQuestion: "一句", drivingQuestionSource: "suggested",
      budgets: { maxModelCalls: 999, maxWallClockSeconds: 99999, maxTasks: 999 },
    }).success,
    false,
  );
  // 空句与全空格都不收（`.trim()` 在 min 之前生效）。
  assert.equal(createNoteLearningRoundRequestV1Schema.safeParse({ noteId: NOTE_ID, drivingQuestion: "   ", drivingQuestionSource: "suggested" }).success, false);
});

test("推进请求：`expectedRevision` 必填，close 必带 outcome", () => {
  assert.equal(advanceNoteLearningRoundRequestV1Schema.safeParse({ expectedRevision: 3, action: { kind: "pause" } }).success, true);
  assert.equal(advanceNoteLearningRoundRequestV1Schema.safeParse({ action: { kind: "pause" } }).success, false,
    "每一次写都要带着它读过的那一版（§16.39 两个窗口恢复同一轮的落点）");
  assert.equal(advanceNoteLearningRoundRequestV1Schema.safeParse({ expectedRevision: 3, action: { kind: "close" } }).success, false);
  assert.equal(
    advanceNoteLearningRoundRequestV1Schema.safeParse({ expectedRevision: 3, action: { kind: "close", outcome: "partial" } }).success,
    true,
  );
  assert.equal(
    advanceNoteLearningRoundRequestV1Schema.safeParse({ expectedRevision: 3, action: { kind: "close", outcome: "done" } }).success,
    false,
    "outcome 是四值枚举，不是自由文本",
  );
});

test("终态两格与 phase 的关系在合同上也说得出（拒的是不可成立的组合）", () => {
  // `closed` 却没 outcome：合同不拒形状（那是 0282 的双向 CHECK 的活），
  // 但 `active` 带 outcome 这一发必须能被读回来不炸——两侧判据的分工在这里写清。
  assert.equal(noteLearningRoundV1Schema.safeParse(roundFixture({ phase: "closed", outcome: "superseded" })).success, true);
  assert.equal(
    noteLearningRoundV1Schema.safeParse(roundFixture({ outcome: "not_a_real_outcome" })).success,
    false,
  );
});

test("记录那一页的合同：游标坏形状拒，`hasMore` 与 `nextCursor` 不同向也拒", () => {
  const page = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    noteId: NOTE_ID,
    items: [],
    hasMore: false,
    shownCount: 0,
    totalCount: 0,
    nextCursor: null,
    ...overrides,
  });
  assert.equal(noteLearningRoundHistoryPageV1Schema.safeParse(page()).success, true, "正常回读该过");
  // 总数不许比列出来的还少：某一侧数错了，让服务端发不出这一份比让读者各自躲可靠。
  assert.equal(
    noteLearningRoundHistoryPageV1Schema.safeParse(page({ shownCount: 2, totalCount: 1 })).success,
    false,
    "总数小于本页条数竟然过得去 ⇒ 那一格会当场变成第二个事实源",
  );
  assert.equal(
    noteLearningRoundHistoryPageV1Schema.safeParse(page({ shownCount: 2, totalCount: 5 })).success,
    true,
    "翻到中途（列 2 共 5）是合法回读，不该被判成漂移",
  );
  assert.equal(
    noteLearningRoundHistoryPageV1Schema.safeParse(page({ nextCursor: "not-an-uuid" })).success,
    false,
    "游标不是 id 就拒（宁可红在解析上，不要让一个坏指针变成安静地回到第一页）",
  );
  assert.equal(
    noteLearningRoundHistoryPageV1Schema.safeParse(page({ hasMore: true, nextCursor: null })).success,
    false,
    "「还有更早的」却给不出指针：界面上就是一颗点不动的按钮，这份回信根本不该存在",
  );
  assert.equal(
    noteLearningRoundHistoryPageV1Schema.safeParse(
      page({ hasMore: true, nextCursor: ROUND_ID }),
    ).success,
    true,
    "同向的那一半必须收得下，否则上一条是在拦真实回执",
  );
  assert.equal(
    noteLearningRoundHistoryPageV1Schema.safeParse({ ...page(), extra: 1 }).success,
    false,
  );
});

/**
 * §10.3 记录那一行的两格新事实（39d W4-8 刀一）：「实际方式」与「系统不确定项」。
 * 两格都是**必填**——可选项会被读成"这次没读到"，而这一行要答的是"发生过什么"。
 */
test("记录那一行：实际方式与系统不确定项都是必填格，档位只有两档", () => {
  const item = (overrides: Record<string, unknown> = {}) => ({
    roundId: ROUND_ID,
    phase: "closed",
    outcome: "partial",
    drivingQuestion: "判断为什么有索引，查询仍然可能慢",
    drivingQuestionSource: "suggested",
    drivingQuestionRevision: 1,
    actualModes: ["explained", "practiced"],
    systemUncertain: false,
    startedAt: "2026-09-24T02:00:00.000Z",
    closedAt: "2026-09-24T03:00:00.000Z",
    ...overrides,
  });
  assert.equal(noteLearningRoundHistoryItemV1Schema.safeParse(item()).success, true, "两档都发生过该过");
  assert.equal(
    noteLearningRoundHistoryItemV1Schema.safeParse(item({ actualModes: [] })).success,
    true,
    "只开了个头（没讲也没练）是一种真实状态，不是坏数据",
  );
  assert.equal(
    noteLearningRoundHistoryItemV1Schema.safeParse({ ...item(), actualModes: undefined }).success,
    false,
    "缺这一格竟过得去 ⇒ 它会变成界面侧的第二个来源（自己猜一个默认值）",
  );
  assert.equal(
    noteLearningRoundHistoryItemV1Schema.safeParse(item({ actualModes: ["explained", "practiced", "dynamically_explained"] })).success,
    false,
    "第三档（表达方式分档）今天还没有落点，不许先占一个语义未定的键",
  );
  assert.equal(
    noteLearningRoundHistoryItemV1Schema.safeParse(item({ systemUncertain: "not_assessable" })).success,
    false,
    "这一格是布尔：把 outcome 字符串塞进来会让它变成第二个事实源",
  );
});

/**
 * §10.3 第二级（本人、跨笔记）那一页（39d W4-8 刀二）。两条分页判据与按笔记那一级
 * **共用同一份谓据**，所以这里两侧都要各测一次：只测一级就等于允许"哪天只改一边"。
 */
test("我的记录那一页：每行必带是哪一篇，两条分页判据对两个级别一起生效", () => {
  const item = {
    roundId: ROUND_ID,
    phase: "closed",
    outcome: "partial",
    drivingQuestion: "判断为什么有索引，查询仍然可能慢",
    drivingQuestionSource: "suggested",
    drivingQuestionRevision: 1,
    actualModes: ["practiced"],
    systemUncertain: false,
    startedAt: "2026-09-24T02:00:00.000Z",
    closedAt: "2026-09-24T03:00:00.000Z",
    noteId: NOTE_ID,
    noteTitle: "学习科学术语定义集",
  };
  const page = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    items: [item],
    hasMore: false,
    nextCursor: null,
    shownCount: 1,
    totalCount: 1,
    ...overrides,
  });
  assert.equal(noteLearningRoundPersonalHistoryPageV1Schema.safeParse(page()).success, true);
  assert.equal(
    noteLearningRoundPersonalHistoryPageV1Schema.safeParse({ ...page(), items: [{ ...item, noteTitle: "" }] }).success,
    false,
    "篇名空串该拒：这一级没有「眼前这篇」的上下文，出处不能是空的",
  );
  assert.equal(
    noteLearningRoundPersonalHistoryPageV1Schema.safeParse({ ...page(), items: [{ ...item, noteId: undefined }] }).success,
    false,
    "少了是哪一篇，那一行就读不出归属",
  );
  assert.equal(
    noteLearningRoundPersonalHistoryPageV1Schema.safeParse(page({ hasMore: true, nextCursor: null })).success,
    false,
    "同向判据（与按笔记那一级同一个函数）",
  );
  assert.equal(
    noteLearningRoundPersonalHistoryPageV1Schema.safeParse(page({ shownCount: 2, totalCount: 1 })).success,
    false,
    "总数判据同样吃这一份",
  );
  // 页面上没有 noteId 这一格：这一级属于"我"，不属于某一篇；带上它就会有两个出处。
  assert.equal(
    noteLearningRoundPersonalHistoryPageV1Schema.safeParse({ ...page(), noteId: NOTE_ID }).success,
    false,
    "多带 noteId 该被 strictObject 拒掉",
  );
});

/**
 * 教学面那一份读的两格新合同（39d W4-6 刀三／刀四）：练过哪几道（`practices`）、
 * 缺口帮助停没停（`gapHelp`）与「换一种解释」那一格（`regenerate`）。
 */
test("教学面读：practices／gapHelp／artifact 都是必填格，gapHelp 的三格有界，artifact 只带引用", () => {
  const base = {
    version: 1,
    round: {
      version: 1,
      roundId: "77777777-7777-4777-8777-777777777777",
      noteId: "11111111-1111-4111-8111-111111111111",
      phase: "active",
      outcome: null,
      drivingQuestion: "这一轮练过什么？",
      drivingQuestionSource: "suggested",
      drivingQuestionRevision: 1,
      noteVersionId: "22222222-4222-4222-8222-222222222222",
      sourceContentHash: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      evidenceSnapshotIds: [],
      budgets: { maxModelCalls: 8, maxWallClockSeconds: 900, maxTasks: 6 },
      revision: 1,
      pausedAt: null,
      resumedAt: null,
      closedAt: null,
      createdAt: "2026-09-26T04:00:00.000Z",
      updatedAt: "2026-09-26T04:00:00.000Z",
    },
    teaching: null,
    practices: [
      {
        runId: "44444444-4444-4444-8444-444444444444",
        phase: "completed",
        outcome: "declared_unable",
        startedAt: "2026-09-26T04:20:00.000Z",
      },
    ],
    practiceStart: null,
    gapHelp: { stopped: true, consecutiveHelpCount: 2, threshold: 2 },
    // 动态产物那一格（W4-6 刀五）：`null` = 这一条没有动态版本，**不是**失败。
    artifact: null,
  };
  assert.equal(roundTeachingViewV1Schema.safeParse(base).success, true);
  // 少任何一格都是不合法的回信（客户端不许自己补默认值）。
  for (const key of ["practices", "gapHelp", "practiceStart", "artifact"] as const) {
    const clone: Record<string, unknown> = { ...base };
    delete clone[key];
    assert.equal(roundTeachingViewV1Schema.safeParse(clone).success, false, `少了 ${key} 竟然过了`);
  }
  /**
   * 这一格**只带引用**：整份 HTML 不在这里（它由主进程按 id 另取一次落盘，渲染层拿不到）。
   * 所以"带 html 的那一份"必须被拒——这不是形状洁癖，而是刀五那条边界的唯一机械护栏：
   * 一旦这一格能装 HTML，"顺手把正文塞过 IPC"就再也没有东西拦得住。
   */
  assert.equal(
    roundTeachingViewV1Schema.safeParse({
      ...base,
      artifact: {
        version: 1,
        artifactId: "88888888-8888-4888-8888-888888888888",
        kind: "dynamic_explanation",
        createdAt: "2026-09-26T04:30:00.000Z",
      },
    }).success,
    true,
  );
  assert.equal(
    roundTeachingViewV1Schema.safeParse({
      ...base,
      artifact: {
        version: 1,
        artifactId: "88888888-8888-4888-8888-888888888888",
        kind: "dynamic_explanation",
        createdAt: "2026-09-26T04:30:00.000Z",
        html: "<section>整份 HTML</section>",
      },
    }).success,
    false,
    "教学面那一份读竟然能带 HTML——刀五那条「HTML 不穿 IPC」没有护栏了",
  );
  assert.equal(
    roundTeachingViewV1Schema.safeParse({ ...base, gapHelp: { stopped: true, consecutiveHelpCount: -1, threshold: 2 } }).success,
    false,
  );
  assert.equal(
    roundTeachingViewV1Schema.safeParse({ ...base, gapHelp: { stopped: true, consecutiveHelpCount: 2, threshold: 0 } }).success,
    false,
  );
  // 没结算的那一场：outcome 必须是 null（不是 0、不是空串）。
  assert.equal(
    roundTeachingViewV1Schema.safeParse({
      ...base,
      practices: [{ ...base.practices[0], phase: "active", outcome: null }],
    }).success,
    true,
  );
});

test("「换一种解释」那一格：缺省合法，给了必须是布尔", () => {
  assert.equal(createRoundTeachingRequestV1Schema.safeParse({ expectedRevision: 1 }).success, true);
  assert.equal(createRoundTeachingRequestV1Schema.safeParse({ expectedRevision: 1, regenerate: true }).success, true);
  assert.equal(createRoundTeachingRequestV1Schema.safeParse({ expectedRevision: 1, regenerate: "yes" }).success, false);
});
