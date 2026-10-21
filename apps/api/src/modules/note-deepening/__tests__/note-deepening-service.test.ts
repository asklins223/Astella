/**
 * Star-map deepening read-side tests (Plan 57).
 *
 * These pin the product decisions, not the SQL: one card per note, questions
 * carry the whole-paper best stars, and a note with no card reports `null`
 * instead of a synthesized empty card.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  resolveNoteDeepeningLimit,
  NOTE_DEEPENING_MAX_LIMIT,
  NOTE_DEEPENING_DEFAULT_LIMIT,
} from "../note-deepening-service.ts";

const here = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const SERVICE = codeOnly(here("../note-deepening-service.ts"));

test("limit 缺省与越界都有确定答案", () => {
  assert.equal(resolveNoteDeepeningLimit(undefined), NOTE_DEEPENING_DEFAULT_LIMIT);
  assert.equal(resolveNoteDeepeningLimit("0"), NOTE_DEEPENING_DEFAULT_LIMIT);
  assert.equal(resolveNoteDeepeningLimit("10"), 10);
  assert.equal(resolveNoteDeepeningLimit(String(NOTE_DEEPENING_MAX_LIMIT + 100)), NOTE_DEEPENING_MAX_LIMIT);
});

test("读侧只碰新学习卡三张表，不再问目标 / 轮次 / 复习", () => {
  for (const table of ["noteLearningCards", "noteLearningCardQuestions", "noteLearningCardAttempts"]) {
    assert.ok(SERVICE.includes(table), `读侧没有读 ${table}`);
  }
  for (const retired of [
    "learning_objectives_v2",
    "learning_cards_v2",
    "learning_runs",
    "review_schedules",
    "note_learning_rounds",
  ]) {
    assert.equal(SERVICE.includes(retired), false, `读侧仍在读退役表 ${retired}`);
  }
});

test("没有学习卡时如实给 null，而不是编一张空卡", () => {
  assert.ok(SERVICE.includes("let card: NoteDeepeningCardV3 | null = null;"));
  assert.ok(SERVICE.includes("if (cardRow) {"));
});

test("最好星级取完成过的那次作答，不看进行中的一轮", () => {
  assert.ok(SERVICE.includes(`row.status === "completed"`), "最好星级只取完成过的那一次");
});

test("正文版本落后时轴三说材料状态，不改写练习表现", () => {
  assert.ok(SERVICE.includes("sourceUpdated:"));
  assert.ok(SERVICE.includes("cardRow.noteVersionId !== note.currentVersionId"));
});
