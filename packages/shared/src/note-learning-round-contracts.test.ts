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
  noteLearningRoundHistoryPageV1Schema,
  noteLearningRoundV1Schema,
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
    nextCursor: null,
    ...overrides,
  });
  assert.equal(noteLearningRoundHistoryPageV1Schema.safeParse(page()).success, true, "正常回读该过");
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
