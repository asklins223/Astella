import assert from "node:assert/strict";
import { test } from "node:test";
import { companionMemoryContentCovers, normalizeCompanionMemoryContent, sameCompanionMemoryFact } from "../companion/companion-memory-content.ts";

test("punctuation, case and a leading user/我 do not make the same memory look different", () => {
  assert.equal(normalizeCompanionMemoryContent("用户晚上九点以后不想被打扰。"), "晚上九点以后不想被打扰");
  assert.equal(normalizeCompanionMemoryContent("晚上九点以后不想被打扰！"), "晚上九点以后不想被打扰");
  assert.equal(normalizeCompanionMemoryContent("Nine O'Clock, Please."), "nineoclockplease");
});

test("an existing memory covers a shorter paraphrase but not a refinement", () => {
  assert.equal(companionMemoryContentCovers(
    "用户晚上九点以后不想被打扰。", "晚上九点以后不想被打扰"), true);
  assert.equal(companionMemoryContentCovers(
    "用户晚上九点以后不想被打扰。", "晚上九点以后不想被打扰，除非我先开口"), false,
  "a candidate that adds a condition is allowed through");
  assert.equal(companionMemoryContentCovers(
    "用户晚上九点以后不想被打扰。", "用户最近在准备线性代数补考"), false);
});

test("copies of one preference count as the same fact to forget; neighbours do not", () => {
  // Forgetting is per fact, not per row: these two are one preference stored
  // twice, and deleting either cascades through its copies.
  assert.equal(sameCompanionMemoryFact(
    "用户晚上九点以后不想被打扰。",
    "晚上九点以后不想被打扰，这段时间不要主动发消息或提醒。"), true);
  assert.equal(sameCompanionMemoryFact(
    "用户晚上九点以后不想被打扰。", "用户最近在准备线性代数补考"), false,
  "a different preference about the same period is not the same fact");
  assert.equal(sameCompanionMemoryFact("九点", "九点半"), false, "short texts must match exactly");
});
