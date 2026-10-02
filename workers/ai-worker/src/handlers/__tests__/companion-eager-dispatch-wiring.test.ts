/**
 * 提前派发（40b §4.1-1 / §4.3 / R7）的**装配形状**守卫。
 *
 * ## 它守什么
 *
 * 装配已经落地（2026-10-01），所以本文件守的不再是"还没接"，而是**接完之后
 * 这几条不能被破坏**。它们每一条都对应一个具体的、可静默发生的错：
 *
 *  1. **默认关闭**。§4.3 说「无收益就撤回」，而收益没实测过（要真 provider
 *     流与真库）。开着就等于在一个没量过的东西上押注每一轮对话。
 *  2. **收口在循环之前**。提前派发是"不 await 地开跑"，所以流结束时账本里
 *     可能还有停在 `requested` 的行。循环拿到 `requested` 会认为**可重放**，
 *     于是**再跑一遍**——那是重复提交。整个特性里最不能出的错。
 *  3. **执行段只有一份**。工具步循环与提前派发共用 `runCompanionToolExecution`；
 *     出现第二份就意味着两条路会分叉，而分叉不报错。
 *  4. **不新写"跳过已派发调用"的分支**。跑过的工具靠循环**已有的**重放路径
 *     （`!replayable` → 重发事件 + 推 tool 消息 + `continue`）被免掉。自写跳过
 *     会漏掉 tool 消息，下一次 provider 请求会因缺 tool 响应被拒。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const HANDLERS = resolve(import.meta.dirname, "..");
const read = (name: string) => readFileSync(join(HANDLERS, name), "utf8");
const runtime = read("companion-agent-runtime.ts");

/** 工具步循环体。 */
function dispatchLoop(): string {
  const start = runtime.indexOf("for (const call of calls) {");
  assert.ok(start > 0, "找不到工具步循环 —— 守卫的扫描范围要跟着代码走");
  return runtime.slice(start, runtime.indexOf("\n    }", start));
}

test("默认关闭：没有环境变量时，运行时压根不建调度器", () => {
  const config = read("companion-eager-dispatch-config.ts");
  assert.match(config, /process\.env\.COMPANION_EAGER_TOOL_DISPATCH === "1"/,
    "开关的判据变了 —— 它必须是显式的 \"1\"，不能是任何非空即真");
  // 运行时确实**按开关**建，而不是无条件建。
  assert.match(runtime, /EAGER_TOOL_DISPATCH_ENABLED\s*\n?\s*\?\s*new EagerDispatchScheduler/,
    "调度器不再受开关控制 —— 它现在会无条件建起来");
});

test("收口在循环看到 toolCalls 之前 —— 否则会重复执行", () => {
  // close 必须在第一次派发**之前**，因为 `calls` 是从 `result.toolCalls` 来的。
  const close = runtime.indexOf("eagerScheduler.close(false)");
  const ledger = runtime.indexOf("for (const call of calls) {");
  assert.ok(close >= 0, "成功路上没有 close —— 提前派发开跑过的格会以 requested 状态进循环，然后被跑第二遍");
  assert.ok(close < ledger, "close 排在工具步循环之后 —— 顺序反了");
});

test("流炸了也要收口 —— 提前派发开跑过的格不会因为流断了就消失", () => {
  assert.ok(runtime.includes("eagerScheduler.close(true)"),
    "异常路上没有 close —— 一条流断了，提前派发却已经改了状态，没人去对账");
});

test("执行段只有一份：循环与提前派发都调它", () => {
  const loop = dispatchLoop();
  assert.ok(loop.includes("runCompanionToolExecution("), "工具步循环不走共用执行段了");
  const dispatchSource = read("companion-eager-dispatch-config.ts");
  assert.ok(dispatchSource.includes("runCompanionToolExecution("), "提前派发不走共用执行段了");
  // 而且**不能**各有一份：模块里只有一个定义。
  const definition = /export async function runCompanionToolExecution\(/g;
  const hits = (read("companion-tool-execution-run.ts").match(definition) ?? []).length;
  assert.equal(hits, 1, "执行段出现了第二份实现 —— 两条路迟早分叉");
});

test("不新写「跳过已派发调用」的分支：靠的是循环已有的重放路径", () => {
  const loop = dispatchLoop();
  const branch = loop.indexOf("if (!replayable) {");
  assert.ok(branch > 0, "重放分支不见了 —— 跑过的工具会被再跑一遍");
  const tail = loop.slice(branch, loop.indexOf("if (record.isNew && toolCallCount"));
  assert.ok(tail.includes("continue;"), "重放分支不再 continue —— 它会往下走到执行");
  assert.ok(tail.includes('role: "tool"'), "重放分支不推 tool 消息 —— 下一次请求会被 provider 拒");
  // 明确不许出现"跳过提前派发过的调用"这种自写分支。
  assert.ok(!/skippedEager|已提前派发|eagerDispatched|skipEager/.test(loop),
    "循环里出现了一条自写的跳过分支 —— 它会漏掉 tool 消息");
});

test("账本仍然先于执行", () => {
  const loop = dispatchLoop();
  const ledger = loop.indexOf("ensureAgentToolCall(");
  const execute = loop.indexOf("runCompanionToolExecution(");
  assert.ok(ledger >= 0, "工具步循环里找不到 ensureAgentToolCall");
  assert.ok(execute >= 0, "工具步循环里找不到 runCompanionToolExecution");
  assert.ok(ledger < execute, "执行排在 ensureAgentToolCall 之后这件事不成立了");
});

test("【自证】判据认得出「把 close 删掉」这个真实退化", () => {
  // 退化形状：没有 close。症状是提前派发跑过的工具**被跑两遍**。
  const degraded = 'if (canStream) { result = await step(); }';
  assert.ok(!degraded.includes("close("), "自证样本没造好：退化形状确实没有收口");
  // 正控制：真代码里有三处。
  const count = (runtime.match(/eagerScheduler\.close\(/g) ?? []).length;
  assert.ok(count >= 2, `自证：当前只找到 ${count} 处收口，判据今天本该是绿的`);
  assert.ok(count >= 2, "收口出现在成功路与异常路两处以上");
});

test("【自证】判据认得出「自写跳过分支」这个真实退化", () => {
  const degraded = 'if (eagerDispatched.has(call.id)) { continue; }';
  assert.ok(/continue;/.test(degraded) && !/role: "tool"/.test(degraded),
    "自证样本没造好：这条退化分支确实跳过了、且不推 tool 消息");
  assert.ok(!/eagerDispatched\.has/.test(dispatchLoop()),
    "自证：当前循环里没有这条分支，所以判据今天是绿的");
});
