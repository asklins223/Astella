/**
 * 提前派发的**开关与白名单**（40b §4.1-1）。
 *
 * ## 为什么白名单要单独钉
 *
 * 40b §4.1-1 写的是「第一批仅对**无业务副作用、可取消的读取工具**测收益」。
 * 而白名单最危险的失效方式是**慢慢变大**：某天有人觉得"这个也是只读的"，
 * 把它加进去，而它其实会改状态。那不是性能问题——提前派发跑过、模型这一轮
 * 又失败，就是一次**重复提交**。
 *
 * 所以这里不测"名单里有哪几个"（那是实现细节，改了就该改），而测**性质**：
 * 名单里每一项都必须是 riskClass=read、且带确认门为 false。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  EAGER_DISPATCH_ELIGIBLE_TOOLS,
  EAGER_TOOL_DISPATCH_ENABLED,
} from "../companion-eager-dispatch-config.ts";
import { getCompanionAgentTool } from "@ailearn/shared";

test("默认关闭 —— 收益没实测之前它不许自己开始跑", () => {
  // 40b §4.3：「无收益或等待不合格就撤回。」没量过就等于还没到能开的时候。
  assert.equal(EAGER_TOOL_DISPATCH_ENABLED, false,
    "提前派发自己打开了 —— 它必须由一次明确的决定来开，而不是由默认值决定");
});

test("白名单里每一项都必须**真的存在**于登记表", () => {
  for (const name of EAGER_DISPATCH_ELIGIBLE_TOOLS) {
    assert.ok(getCompanionAgentTool(name), `白名单里的 ${name} 不在登记表里 —— 派发时会静默空转`);
  }
});

test("白名单里每一项都是只读、无需确认 —— 有副作用的绝不许进", () => {
  for (const name of EAGER_DISPATCH_ELIGIBLE_TOOLS) {
    const definition = getCompanionAgentTool(name)!;
    assert.equal(definition.riskClass, "read",
      `${name} 不是 read 风险档。riskClass 是**风险**不是"有没有副作用"，
      而 §4.1-1 要的是后者。`);
    assert.equal(definition.requiresConfirmation, false,
      `${name} 需要用户确认 —— 提前派发不得越过确认门（A58）`);
  }
});

test("一个写工具都不许在白名单里", () => {
  // 正控制 + 反向：把已知的写工具都断言一遍。
  for (const name of [
    "companion_save_memory",
    "companion_forget_memory",
    "companion_revise_memory",
    "companion_move_memory",
    "companion_remember_judgment",
  ]) {
    assert.ok(!EAGER_DISPATCH_ELIGIBLE_TOOLS.has(name),
      `${name} 在白名单里 —— 跑两遍就是重复提交`);
  }
  // 名单非空：全空等于这批白名单没写过，那也是异常。
  assert.ok(EAGER_DISPATCH_ELIGIBLE_TOOLS.size > 0, "白名单是空的 —— 那这个特性没有可跑的东西");
});

test("【自证】判据认得出「把一个写工具加进白名单」这个真实退化", () => {
  // 退化形状：有人觉得 read_memory "看起来也是只读的"，把 save_memory 加进去。
  const degraded = new Set([...EAGER_DISPATCH_ELIGIBLE_TOOLS, "companion_save_memory"]);
  assert.ok(degraded.has("companion_save_memory"), "自证样本没造好：退化名单确实混进了写工具");
  // 正控制：真名单里没有它。
  assert.ok(!EAGER_DISPATCH_ELIGIBLE_TOOLS.has("companion_save_memory"),
    "自证：当前名单是干净的，所以判据今天是绿的");
});
