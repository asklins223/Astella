import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANION_ACTION_REPLAYS_ALLOWED,
  COMPANION_ARITHMETIC_REPEAT_ALLOWED,
  COMPANION_ARITHMETIC_TOTAL_ALLOWED,
  COMPANION_REQUIREMENT_RETRIES_ALLOWED,
  COMPANION_IDENTICAL_CALL_REPLAYS_ALLOWED,
  COMPANION_INVALID_TOOL_CALLS_ALLOWED,
  COMPANION_MALFORMED_TOOL_ATTEMPTS_ALLOWED,
  companionCallFingerprint,
  companionMalformedToolExhausted,
  companionReplayExhausted,
  companionReplayLimitFor,
} from "../agent/companion-progress-guard.ts";
import { COMPANION_AGENT_MAX_STEPS, COMPANION_AGENT_MAX_TOOL_CALLS } from "@astella/shared";

/**
 * agent 里没有预算上限，所以"她转不出来"必须由**事实**收口：同一个工具调用
 * （工具名 + 参数）拿到成功回执后又被原样要了第二次。
 *
 * 这一条与既有的 `invalidArgumentCalls` / `rejectedExecutionConstraints` 同族
 * （"同样输入还不改就失败"），区别只在它们管输入非法、这里管调用成功还重复。
 * 它不数总步数、不数总工具数，也不砍内容。
 */
test("同一个调用指纹放行多次重放，达到上限后才收口", () => {
  const receipts = new Map<string, number>();
  const readNote = companionCallFingerprint("companion_read_note", "sha-note-1");

  assert.equal(COMPANION_IDENTICAL_CALL_REPLAYS_ALLOWED, 5, "允许模型多次核对同一份新鲜证据");
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(companionReplayExhausted(receipts, readNote), false, `第 ${attempt} 次调用`);
  }
  assert.equal(companionReplayExhausted(receipts, readNote), false, "第 6 次仍在上限内");
  assert.equal(companionReplayExhausted(receipts, readNote), true, "超过上限才收口");
  // 收口是一次性判定，不是"从此这个指纹永久作废"——判据只回答调用方此刻要不要停。
  assert.equal(companionReplayExhausted(receipts, readNote), true);
});

test("生成/写/导航动作同参只执行一次，读操作仍保留多次", () => {
  assert.equal(COMPANION_ACTION_REPLAYS_ALLOWED, 0);
  assert.equal(companionReplayLimitFor("visual.diagram", "read"), 0, "画图是 read 声明，但会生成可见产物");
  assert.equal(companionReplayLimitFor("open.page", "read"), 0);
  assert.equal(companionReplayLimitFor("notes.write.edit", "reversible_low"), 0);
  assert.equal(companionReplayLimitFor("notes.read.read", "read"), 5);
  const receipts = new Map<string, number>();
  const diagram = companionCallFingerprint("companion_visual", "sha-diagram");
  const limit = companionReplayLimitFor("visual.diagram", "read");
  assert.equal(companionReplayExhausted(receipts, diagram, limit), false, "第一次成功");
  assert.equal(companionReplayExhausted(receipts, diagram, limit), true, "第二次同参改成复用回执");
});

test("换参数、换工具、换一页都是各自独立的调用身份", () => {
  const receipts = new Map<string, number>();
  const first = companionCallFingerprint("companion_read_note", "sha-page-1");
  const secondPage = companionCallFingerprint("companion_read_note", "sha-page-2");
  const anotherTool = companionCallFingerprint("companion_search_notes", "sha-page-1");

  // 把第一个身份耗到收口。
  for (let attempt = 1; attempt <= COMPANION_IDENTICAL_CALL_REPLAYS_ALLOWED + 1; attempt += 1) {
    assert.equal(companionReplayExhausted(receipts, first), false, `第 ${attempt} 次仍放行`);
  }
  assert.equal(companionReplayExhausted(receipts, first), true, "超过上限才收口");
  // 另外两个身份各有各的计数：换一页、换工具都是新的调用，正常推进时永远碰不到这条闸。
  assert.equal(companionReplayExhausted(receipts, secondPage), false, "换一页 = 新的调用身份");
  assert.equal(companionReplayExhausted(receipts, anotherTool), false, "换工具 = 新的调用身份");
  assert.equal(companionReplayExhausted(receipts, secondPage), false, "新身份同样允许一次重放");
  // 反过来也成立：新身份被耗掉不会把旧身份"复活"成未收口。
  assert.equal(companionReplayExhausted(receipts, first), true, "旧身份仍然处于收口状态");
});

test("different invalid payloads for the same tool are allowed several times, then capped", () => {
  const attempts = new Map<string, number>();
  assert.equal(COMPANION_MALFORMED_TOOL_ATTEMPTS_ALLOWED, 5);
  assert.equal(COMPANION_INVALID_TOOL_CALLS_ALLOWED, 12);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(companionMalformedToolExhausted(attempts, "companion_attention_write"), attempt);
  }
  // A different tool starts its own count.
  assert.equal(companionMalformedToolExhausted(attempts, "companion_memory_write"), 1);
});

test("算术纠正给足尝试，只对反复同一个错误收口", () => {
  assert.equal(COMPANION_ARITHMETIC_REPEAT_ALLOWED, 3);
  assert.equal(COMPANION_ARITHMETIC_TOTAL_ALLOWED, 6);
  assert.equal(COMPANION_REQUIREMENT_RETRIES_ALLOWED, 3);
});

test("默认部署没有任何计数上限：这条闸是唯一与计数无关的兜底", () => {
  assert.equal(COMPANION_AGENT_MAX_STEPS, null, "默认没有步数上限");
  assert.equal(COMPANION_AGENT_MAX_TOOL_CALLS, null, "默认没有工具调用总数上限");
});
