import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANION_DEFAULT_PARTICIPATION, COMPANION_DEFAULT_PARTICIPATION_POLICY_V1,
  companionParticipationRegister, isCompanionDefaultHelpPage, isCompanionDefaultParticipationOpportunity } from "../companion-default-participation.ts";

test("the shared default behaviour is explicit for every new account", () => {
  assert.deepEqual(COMPANION_DEFAULT_PARTICIPATION.map(item => item.id),
    ["natural-exchange", "page-help", "app-greeting", "study-break", "quiet-presence"]);
  assert.match(COMPANION_DEFAULT_PARTICIPATION_POLICY_V1, /每个账号自带/);
  assert.match(COMPANION_DEFAULT_PARTICIPATION_POLICY_V1, /用户明确给出的时长优先/);
  // 问候与闲聊要能问近况，但不知道的事不能说成知道——这两句是同一件事的两面。
  assert.match(COMPANION_DEFAULT_PARTICIPATION_POLICY_V1, /不知道的事直接问，问近况是相处不是越界/);
  assert.match(COMPANION_DEFAULT_PARTICIPATION_POLICY_V1, /不要把推测说成知道/);
  assert.match(COMPANION_DEFAULT_PARTICIPATION_POLICY_V1, /人还在前台、这一阵安静下来时，是一个可以开口的时机/);
});

test("参与依据决定她的口气，不是内容长度", () => {
  for (const topic of ["app.started", "app.foreground", "study.started", "preference.changed", "presence.quiet"])
    assert.equal(companionParticipationRegister(topic), "conversation", topic);
  for (const topic of ["page.arrived", "help.available", "result.available", "reply.finished"])
    assert.equal(companionParticipationRegister(topic), "knowledge", topic);
  for (const topic of ["attention.due", "self_note.due"])
    assert.equal(companionParticipationRegister(topic), "task", topic);
});

test("only a content-bearing page or an eligible event wakes a default consideration", () => {
  for (const page of ["note-read", "source-detail:abc", "assessment:run", "result:run", "reader:abc", "explain:abc"])
    assert.equal(isCompanionDefaultHelpPage(page), true);
  for (const page of ["home", "settings", "companion-center", "source-library", null])
    assert.equal(isCompanionDefaultHelpPage(page), false);
  assert.equal(isCompanionDefaultParticipationOpportunity("page.arrived", { context: { page: { key: "home" } } }), false);
  assert.equal(isCompanionDefaultParticipationOpportunity("page.arrived", { context: { page: { key: "reader:abc" } } }), true);
  assert.equal(isCompanionDefaultParticipationOpportunity("app.started", {}), true);
  assert.equal(isCompanionDefaultParticipationOpportunity("reply.finished", {}), true);
  assert.equal(isCompanionDefaultParticipationOpportunity("study.started", {}), true);
  assert.equal(isCompanionDefaultParticipationOpportunity("presence.quiet", {}), true);
  assert.equal(isCompanionDefaultParticipationOpportunity("context.updated", {}), false);
});
