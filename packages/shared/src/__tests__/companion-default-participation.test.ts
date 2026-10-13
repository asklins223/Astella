import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANION_DEFAULT_PARTICIPATION, COMPANION_DEFAULT_PARTICIPATION_POLICY_V1,
  isCompanionDefaultHelpPage, isCompanionDefaultParticipationOpportunity } from "../companion-default-participation.ts";

test("the shared default behaviour is explicit for every new account", () => {
  assert.deepEqual(COMPANION_DEFAULT_PARTICIPATION.map(item => item.id), ["natural-exchange", "page-help", "app-greeting", "study-break"]);
  assert.match(COMPANION_DEFAULT_PARTICIPATION_POLICY_V1, /每个账号自带/);
  assert.match(COMPANION_DEFAULT_PARTICIPATION_POLICY_V1, /用户明确给出的时长优先/);
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
  assert.equal(isCompanionDefaultParticipationOpportunity("context.updated", {}), false);
});
