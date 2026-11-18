import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPANION_CHARACTER_BASE_V8, COMPANION_CHARACTER_BASE_V19,
  COMPANION_IDENTITY_BOUNDARY_V3, COMPANION_IDENTITY_BOUNDARY_V4,
} from "@astella/shared";
import { buildCompanionPersonaMessages } from "../../handlers/turn/companion-dialogue-content.ts";
import { resolveCompanionPersonaContext } from "../../handlers/memory/companion-identity-context.ts";
import { qualityPersonaVariant, selectQualityCases } from "../quality-persona-variant.ts";
import { selectedRuntimeTurns, selectQualityCases as selectRuntimeQualityCases } from "../runtime-quality-cases.ts";
import { parseQualityVerdicts, qualityJudgeMessages } from "../quality-cases.ts";

test("baseline replaces the actual current persona and fails if its input drifts", () => {
  const messages = buildCompanionPersonaMessages({ userText: "synthetic input", recentMessages: [],
    pageContext: null, petProfile: resolveCompanionPersonaContext(null) });
  const current = String(messages[0]!.content);
  const baseline = qualityPersonaVariant(current, "baseline");
  assert.ok(current.includes(COMPANION_CHARACTER_BASE_V19));
  assert.ok(current.includes(COMPANION_IDENTITY_BOUNDARY_V4));
  assert.ok(baseline.includes(COMPANION_CHARACTER_BASE_V8));
  assert.ok(baseline.includes(COMPANION_IDENTITY_BOUNDARY_V3));
  assert.ok(!baseline.includes(COMPANION_CHARACTER_BASE_V19));
  assert.ok(!baseline.includes(COMPANION_IDENTITY_BOUNDARY_V4));
  assert.throws(() => qualityPersonaVariant(current.replace(COMPANION_CHARACTER_BASE_V19, ""), "baseline"), /current persona/);
  assert.throws(() => qualityPersonaVariant(current + COMPANION_CHARACTER_BASE_V19, "baseline"), /current persona/);
  assert.equal(qualityPersonaVariant(current, "current"), current);
});

test("case selection rejects unknown, empty, and duplicate IDs rather than silently omitting them", () => {
  const fixtures = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(selectQualityCases(fixtures, "b"), [fixtures[1]]);
  assert.deepEqual(selectQualityCases(fixtures, undefined), fixtures);
  for (const selection of ["a,typo", "a,", "a,a", ""]) {
    assert.throws(() => selectQualityCases(fixtures, selection), /distinct known fixture IDs/);
  }
  assert.equal(selectRuntimeQualityCases("correlation")[0]?.id, "correlation");
  assert.throws(() => selectRuntimeQualityCases("unknown"), /LIVE_RUNTIME_CASES/);
});

test("runtime quality fixtures retain independent synthetic history without exposing evaluation references", () => {
  const turns = selectedRuntimeTurns("correlation,self-coffee");
  assert.deepEqual(turns.map(turn => turn.caseId), ["correlation", "self-coffee"]);
  assert.deepEqual(turns[0]?.history, []);
  assert.equal(turns[1]?.history.length, 2);
  assert.match(turns[1]!.history[0]!.text, /咖啡/);
  assert.ok(turns.every(turn => !Object.hasOwn(turn, "reference") && !Object.hasOwn(turn, "criteria")));
});

test("the content judge receives reference facts and cannot pass on a fabricated quote", () => {
  const [fixture] = selectRuntimeQualityCases("correlation");
  assert.ok(fixture);
  const answer = "An observed association alone is insufficient.";
  const [, judgeData] = qualityJudgeMessages(fixture, answer);
  assert.deepEqual(JSON.parse(String(judgeData?.content)).referenceFacts, fixture.reference);
  const verdicts = [
    { criterionId: "causation", pass: true, evidence: answer, reason: "States the limit." },
    { criterionId: "third-factor", pass: false, evidence: "", reason: "Omits a plausible common cause." },
  ];
  assert.deepEqual(parseQualityVerdicts(JSON.stringify({ verdicts }), answer, fixture), verdicts);
  verdicts[1] = { ...verdicts[1]!, pass: true, evidence: "The temperature might explain the relationship." };
  assert.throws(() => parseQualityVerdicts(JSON.stringify({ verdicts }), answer, fixture), /invalid verdict evidence/);
});
