import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANION_IDENTICAL_CALL_REPLAYS_ALLOWED,
  companionCallFingerprint,
  companionReplayExhausted,
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
test("同一个调用指纹放行一次重放，第二次原地重放才收口", () => {
  const receipts = new Map<string, number>();
  const readNote = companionCallFingerprint("companion_read_note", "sha-note-1");

  assert.equal(COMPANION_IDENTICAL_CALL_REPLAYS_ALLOWED, 1, "只放行一次重放（读类取最新状态）");
  assert.equal(companionReplayExhausted(receipts, readNote), false, "第一次执行");
  assert.equal(companionReplayExhausted(receipts, readNote), false, "第二次=重放一次，仍然放行");
  assert.equal(companionReplayExhausted(receipts, readNote), true, "第三次=第二次原地重放，收口");
  // 收口是一次性判定，不是"从此这个指纹永久作废"——判据只回答调用方此刻要不要停。
  assert.equal(companionReplayExhausted(receipts, readNote), true);
});

test("换参数、换工具、换一页都是各自独立的调用身份", () => {
  const receipts = new Map<string, number>();
  const first = companionCallFingerprint("companion_read_note", "sha-page-1");
  const secondPage = companionCallFingerprint("companion_read_note", "sha-page-2");
  const anotherTool = companionCallFingerprint("companion_search_notes", "sha-page-1");

  // 把第一个身份耗到收口。
  assert.equal(companionReplayExhausted(receipts, first), false, "第一次执行");
  assert.equal(companionReplayExhausted(receipts, first), false, "重放一次仍放行");
  assert.equal(companionReplayExhausted(receipts, first), true, "第二次原地重放收口");
  // 另外两个身份各有各的计数：换一页、换工具都是新的调用，正常推进时永远碰不到这条闸。
  assert.equal(companionReplayExhausted(receipts, secondPage), false, "换一页 = 新的调用身份");
  assert.equal(companionReplayExhausted(receipts, anotherTool), false, "换工具 = 新的调用身份");
  assert.equal(companionReplayExhausted(receipts, secondPage), false, "新身份同样允许一次重放");
  // 反过来也成立：新身份被耗掉不会把旧身份"复活"成未收口。
  assert.equal(companionReplayExhausted(receipts, first), true, "旧身份仍然处于收口状态");
});

test("默认部署没有任何计数上限：这条闸是唯一与计数无关的兜底", () => {
  assert.equal(COMPANION_AGENT_MAX_STEPS, null, "默认没有步数上限");
  assert.equal(COMPANION_AGENT_MAX_TOOL_CALLS, null, "默认没有工具调用总数上限");
});
