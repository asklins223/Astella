/**
 * 选中的候选 id 落库（0353，PRD 40 §5.7.5 / §13 A56）。
 *
 * A56 说的是「正文与选中 ID 一致」。0353 之前这一行只存了**理由的文字**，
 * 于是"正文写的是不是她选的那一段"没有任何可核对的东西——这道验收只能靠
 * 再问她一次。这些用例把两侧都钉住：
 *   - 折出溯源的那个纯函数（id 与理由必须同源）；
 *   - 真正发出去的 upsert（列在不在、参数是什么、已发布成稿的那道守卫还在不在）。
 *
 * 全部纯函数：不需要数据库，SQL 用 `PgDialect` 摊开逐句读。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  diarySelectionProvenance,
  diarySummaryUpsertSql,
  type DiaryPersistenceGuard,
} from "../companion-daily-summary.ts";
import { buildDiaryCandidates, validateDiarySelection } from "../companion-diary-candidates.ts";
import type { DayScope } from "../companion-daily-summary-eligibility.ts";
import type { DiaryDraft, DiaryMaterial, DiaryPiece } from "../companion-diary-content.ts";
import { pickDiarySubject } from "../companion-diary-content.ts";

const scope: DayScope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  date: "2026-09-30",
  timezone: "Asia/Shanghai",
  diaryEnabledSince: new Date("2026-09-30T02:00:00.000Z"),
};

const facts = {
  notesCreated: 1,
  notesUpdated: 0,
  cardsCreated: 0,
  sourcesCreated: 0,
  jobsCreated: 0,
  jobsCompleted: 0,
  learningRunsCreated: 0,
  learningRunsCompleted: 0,
  pageContexts: 1,
  conversationMessages: 2,
  userMessages: 1,
  assistantMessages: 1,
};

function material(pieces: DiaryPiece[]): DiaryMaterial {
  return { pieces, subject: pickDiarySubject(pieces), embeds: [], previousOpenings: [], previousMotifs: [], quietDay: false };
}

const draft: DiaryDraft = {
  blocks: [{ type: "text", text: "今天你把那个比例又算了一遍。" }],
  digest: "我说：这一步我也不敢直接下结论",
};

function guardOf(overrides: Partial<DiaryPersistenceGuard> = {}): DiaryPersistenceGuard {
  return {
    expectedHash: "snapshot-hash",
    govCtx: { policy: {}, consentOk: true } as unknown as DiaryPersistenceGuard["govCtx"],
    provider: { id: "mock", modelId: "mock", chatCompletion: async () => ({ content: "{}" }) } as unknown as DiaryPersistenceGuard["provider"],
    selectedId: null,
    sourceEventIds: ["msg-1"],
    selectionReason: null,
    personaProfileRevision: 1,
    personaExamplesRevision: 1,
    defaultExpressionVersion: "pet-persona-v1",
    ...overrides,
  };
}

function upsert(input: {
  draft: DiaryDraft | null;
  guard: DiaryPersistenceGuard | undefined;
  failureReason?: "model_unavailable" | "consent_required" | "diary_output_invalid" | null;
}) {
  return new PgDialect().sqlToQuery(diarySummaryUpsertSql({
    scope,
    facts,
    draft: input.draft,
    failureReason: input.failureReason ?? null,
    guard: input.guard,
  }));
}

/** 取值参数里第 n 个（0 起）；insert 列表与 values 一一对应，位置不会漂。 */
const param = (query: { params: unknown[] }, index: number) => query.params[index];

test("选 null 时 selected_id 落 null，不拿别的片段顶上", () => {
  const provenance = diarySelectionProvenance({ selected_id: null, reason_summary: "没有一段适合留下。" });
  assert.equal(provenance.selectedId, null, "§5.7.5 允许 selected_id 为 null，编一个 id 才是造事实");

  const query = upsert({ draft, guard: guardOf({ selectionReason: provenance.selectionReason }) });
  assert.equal(param(query, 8), null, "selected_id 那一列的值必须是 null");
  // 理由照旧落库（0353 不是替换 0335 的 selection_reason）。
  assert.equal(param(query, 7), "没有一段适合留下。");
});

test("选中了片段：selected_id 等于那个片段的 id，也等于成稿拿到的那份素材", () => {
  const pieces: DiaryPiece[] = [
    { text: "你说：我把这个比例又算了一遍，还是有点犹豫。", group: "his", weight: 1, at: "10:02",
      sourceId: "00000000-0000-4000-8000-000000000001", sourceType: "companion_message" },
    { text: "我说：这一步我也不敢直接下结论，我们一起对照一下原式。", group: "her", weight: 3, at: "10:05",
      sourceId: "00000000-0000-4000-8000-000000000002", sourceType: "companion_message" },
    { text: "我提醒过你：今晚继续看那段。", group: "her", weight: 2, at: "21:30",
      sourceId: "00000000-0000-4000-8000-000000000003", sourceType: "reminder" },
  ];
  const candidates = buildDiaryCandidates(material(pieces));
  assert.ok(candidates.length >= 2, "夹具要给出多个候选，否则「选中哪一段」这件事测不到");
  const chosen = candidates[candidates.length - 1];

  const selection = { selected_id: chosen.id, reason_summary: "这段把一起核对的过程留了下来。" };
  assert.equal(validateDiarySelection({ ...selection, source_ids: chosen.sourceIds }, candidates), true);

  const provenance = diarySelectionProvenance(selection);
  assert.equal(provenance.selectedId, chosen.id);
  assert.equal(provenance.selectionReason, "这段把一起核对的过程留了下来。");

  // 「与正文一致」的另一半：成稿只拿选中片段这一份素材，落库的 id 指的就是它。
  const handedToDraft = candidates.find((candidate) => candidate.id === provenance.selectedId);
  assert.ok(handedToDraft, "落库的 id 必须在候选里找得到，否则事后核对不到素材");
  assert.equal(handedToDraft.material.subject?.text, chosen.material.subject?.text);

  const query = upsert({ draft, guard: guardOf({ selectedId: provenance.selectedId, selectionReason: provenance.selectionReason }) });
  assert.equal(param(query, 8), chosen.id, "selected_id 那一列的值必须是那个候选 id");
});

test("没走到选择（失败行）时 selected_id 与 source_event_ids 都是空的", () => {
  // guard 还没建起来就失败：没有选择发生过，写一个值就是编的。
  // source_event_ids 同理（0363）——没有素材就没有来源，撤权时也就无从匹配。
  const query = upsert({ draft: null, guard: undefined, failureReason: "model_unavailable" });
  assert.equal(param(query, 8), null, "selected_id 应为 null");
  // 空**数组**而不是 null：这一列是 text[]，「没选过」是它自己的一个取值
  // （`{}`），不是「未知」。写成 null 会让 `source_event_ids @> ARRAY[...]`
  // 求值为 NULL 而不是 false，撤权遮蔽那条触发器就再也匹配不到这一篇。
  // 2026-10-05：这里原本断的是 null，而它在驱动层根本发不出去——JS 数组会被
  // postgres.js 序列化成行构造器 `()`，空数组直接是语法错误（见 pg-text-array.ts）。
  assert.equal(param(query, 9), "{}", "source_event_ids 应为空数组字面量");
  assert.equal(param(query, 13), "failed", "没有成稿时状态是 failed，不是 generated");
  assert.equal(param(query, 14), "model_unavailable");
});

test("source_event_ids 真的落库，且跟着重跑一起更新", () => {
  // 撤权遮蔽（§11.1 第 6 行）靠这一列匹配「这篇用了这份材料」。
  // 没有它，撤权时只能要么全遮要么不遮。
  const { sql } = upsert({ draft, guard: guardOf({ selectedId: "moment-abc", sourceEventIds: ["msg-1", "note-2"] }) });
  // 列清单折行了，所以只断言这一列出现在插入列表里
  assert.match(sql, /source_event_ids,/, "列清单里要有 source_event_ids");
  assert.match(sql, /source_event_ids = EXCLUDED\.source_event_ids/, "重跑更新时它要跟着一起更新");
});

test("upsert 真的写 selected_id，并且仍被「已发布成稿不重跑替换」那道守卫罩住", () => {
  const { sql } = upsert({ draft, guard: guardOf({ selectedId: "moment-abc", selectionReason: "理由" }) });
  assert.match(sql, /selection_reason, selected_id,/, "列清单里要有 selected_id");
  assert.match(sql, /selected_id = EXCLUDED\.selected_id/, "重跑更新时它要跟着一起更新");
  // §5.5 / A20：已发布成稿不被后台重跑静默替换。这条守卫必须在 SET 之后，
  // 否则新列会绕过它——那样重跑就能把已发布成稿连同它的选中 id 一起换掉。
  const guardAt = sql.indexOf("WHERE companion_daily_summaries.status <> 'generated'");
  const setAt = sql.indexOf("DO UPDATE SET");
  assert.ok(guardAt > setAt, "单版本保护必须留在 DO UPDATE 之后");
  assert.ok(
    sql.indexOf("selected_id = EXCLUDED.selected_id") > setAt
    && sql.indexOf("selected_id = EXCLUDED.selected_id") < guardAt,
    "selected_id 的赋值必须在守卫之内，而不是被守卫放行之后才做",
  );
});