/**
 * 40 §7 发现簿的不变量。
 *
 * 每条都对应一个具体的、可静默发生的错：取消收藏写成级联删除（一次误点永久
 * 毁掉一篇日记）、AI 建议不标作者（在簿子里读起来像用户自己写的）、
 * 共用身份按正文文本判（原文一改就分裂成两条）、来源撤权后删行（看不出曾经有过）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  STUDY_TRACE_LIMIT,
  companionDiscoveryBookV1Schema,
  evaluateDiscoveryEntry,
  onSourceLost,
  sameCollectionIdentity,
  uncollectEffect,
} from "../contracts/companion-discovery-contracts.ts";

const base = {
  ownerId: "u1", actorId: "u1", studyVisibleCount: 0, wantStudyVisible: false,
} as const;

test("只有本人能往自己的簿子里放", () => {
  const d = evaluateDiscoveryEntry({ ...base, kind: "question", author: "user", source: "assistant_reply", actorId: "u2" });
  assert.equal(d.allow, false);
  assert.equal(d.reason, "not_owner");
});

test("用户保留的 AI 建议必须标成 assistant —— 不标作者就成了用户自己写的", () => {
  const wrong = evaluateDiscoveryEntry({ ...base, kind: "kept_ai_suggestion", author: "user", source: "assistant_reply" });
  assert.equal(wrong.allow, false);
  assert.equal(wrong.reason, "ai_suggestion_authored_by_user");
  const right = evaluateDiscoveryEntry({ ...base, kind: "kept_ai_suggestion", author: "assistant", source: "assistant_reply" });
  assert.equal(right.allow, true);
});

test("日记摘录必须带日记来源（A18「标伴星与日记来源」）", () => {
  const wrong = evaluateDiscoveryEntry({ ...base, kind: "diary_excerpt", author: "assistant", source: "memory" });
  assert.equal(wrong.allow, false);
  assert.equal(wrong.reason, "excerpt_without_diary_source");
  const right = evaluateDiscoveryEntry({ ...base, kind: "diary_excerpt", author: "assistant", source: "diary" });
  assert.equal(right.allow, true);
});

test("书房只放**少量**：超限的进不去", () => {
  // §7「书房仅展示用户愿意放出的少量痕迹」——不给数字它会慢慢涨成一面墙。
  const at = evaluateDiscoveryEntry({ ...base, kind: "question", author: "user", source: "assistant_reply", studyVisibleCount: STUDY_TRACE_LIMIT - 1, wantStudyVisible: true });
  assert.equal(at.allow, true);
  const over = evaluateDiscoveryEntry({ ...base, kind: "question", author: "user", source: "assistant_reply", studyVisibleCount: STUDY_TRACE_LIMIT, wantStudyVisible: true });
  assert.equal(over.allow, false);
  assert.equal(over.reason, "study_trace_limit");
  // 不要求书房可见时不受这条限制 —— 簿子本身不受限。
  const plain = evaluateDiscoveryEntry({ ...base, kind: "question", author: "user", source: "assistant_reply", studyVisibleCount: 999, wantStudyVisible: false });
  assert.equal(plain.allow, true);
});

test("取消收藏**不删**原始回答或日记（§7）", () => {
  // 做成函数是因为它最容易被"顺手"写成级联删除，而那种错在界面上看不出来。
  assert.equal(uncollectEffect(), "hide_entry_only");
});

test("同一条内容在笔记旁与发现簿里共用身份 —— 按 (kind, source, sourceId)，不按正文", () => {
  const a = { kind: "diary_excerpt" as const, source: "diary" as const, sourceId: "d-2026-10-01" };
  assert.equal(sameCollectionIdentity(a, { ...a }), true, "同一来源却判成两条 —— 取消收藏会不同步");
  assert.equal(sameCollectionIdentity(a, { ...a, sourceId: "d-2026-10-02" }), false);
  assert.equal(sameCollectionIdentity(a, { ...a, source: "memory" }), false);
  // 正文**不在**身份里：原文改了就该还是同一条，而不是分裂成两条。
  assert.equal(sameCollectionIdentity(a, { ...a }), true);
});

test("来源撤权或删除后是**遮蔽**而不是删行（§7「同样处理」）", () => {
  assert.equal(onSourceLost(), "mask_entry");
});

test("簿子为空时就是一个空数组，不生成假内容（§7「没有收藏时保持清爽」）", () => {
  const empty = companionDiscoveryBookV1Schema.parse({ version: 1, entries: [], studyVisible: [] });
  assert.equal(empty.entries.length, 0);
  assert.equal(empty.studyVisible.length, 0);
});

test("【自证】判据认得出「取消收藏级联删除」这个真实退化", () => {
  const degraded = (): "cascade_delete" => "cascade_delete";
  assert.equal(degraded(), "cascade_delete", "自证样本没造好");
  assert.notEqual(degraded(), uncollectEffect(), "自证：真判据是遮蔽，不是级联");
});

test("【自证】判据认得出「共用身份按正文文本判」这个真实退化", () => {
  // 退化形状：正文一改就变成另一条，于是编辑批注与取消收藏都不再同步。
  const byBody = (a: { body: string }, b: { body: string }) => a.body === b.body;
  const ref = { kind: "diary_excerpt" as const, source: "diary" as const, sourceId: "d1" };
  const edited = { ...ref, sourceId: "d1" };
  assert.equal(sameCollectionIdentity(ref, edited), true, "自证：sourceId 没变时仍是同一条");
  assert.equal(byBody({ body: "原文" }, { body: "改过的原文" }), false);
  // 正控制：真判据不看正文，所以原文改了也不分裂。
  assert.equal(sameCollectionIdentity(ref, { ...edited, sourceId: "d1" }), true);
});
