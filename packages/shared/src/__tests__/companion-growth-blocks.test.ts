import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPANION_GROWTH_BLOCKS, renderCompanionGrowthBlocks, renderCompanionSelfNotes,
  type CompanionSelfNoteV1,
} from "../companion/companion-autonomy.ts";

const note = (key: string, body: string, tier: CompanionSelfNoteV1["tier"] = "resident", userDisabled = false): CompanionSelfNoteV1 => ({
  userDisabled, key, revision: 1, title: key, body, tier,
  nextReviewAt: null, expiresAt: null, reason: "test", updatedAt: "2026-11-11T00:00:00.000Z",
});

test("growth blocks render in fixed order and leave ordinary notes in the drawer", () => {
  const notes = [
    note("growth:stance", "不急着替人下结论。"),
    note("growth:voice", "先说结论，再举一个例子。"),
    note("other", "一条普通记事。"),
  ];
  const growth = renderCompanionGrowthBlocks(notes);
  assert.match(growth, /说话方式/);
  assert.match(growth, /看事情的角度/);
  assert.ok(growth.indexOf("说话方式") < growth.indexOf("看事情的角度"));
  assert.deepEqual(COMPANION_GROWTH_BLOCKS.map((block) => block.key),
    ["growth:voice", "growth:stance", "growth:relationship", "growth:open-questions"]);
  const rest = renderCompanionSelfNotes(notes);
  assert.match(rest, /一条普通记事/);
  assert.doesNotMatch(rest, /先说结论/);
});

test("growth blocks ignore active, archived and disabled notes", () => {
  assert.equal(renderCompanionGrowthBlocks([note("growth:voice", "x", "active")]), "");
  assert.equal(renderCompanionGrowthBlocks([note("growth:voice", "x", "archived")]), "");
  assert.equal(renderCompanionGrowthBlocks([note("growth:voice", "x", "resident", true)]), "");
});

test("growth blocks cap each block and escape angle brackets", () => {
  const text = renderCompanionGrowthBlocks([note("growth:voice", `<script>${"长".repeat(700)}`)]);
  assert.ok(text.length < 800);
  assert.match(text, /\\u003cscript/);
});
