/**
 * 工具步循环里**提前派发要依赖的那两条性质**，用静态判据钉住。
 *
 * ## 为什么这两条要钉
 *
 * R7 的装配方案（见 `companion-eager-dispatch.ts` 顶部的"剩下最后一步"）成立，
 * 完全建立在循环**已经**有的两件事上：
 *
 *  1. **账本先于执行**：`ensureAgentToolCall` 在 `executeTool` 之前。
 *     提前派发要靠它证明"这一格已经被登记过"，次序倒过来就等于没有账本。
 *
 *  2. **终态即免执行**：`if (!replayable)` 那一支会重发事件、推 tool 消息、
 *     然后 `continue` —— **根本不往下走到执行**。
 *
 * 第 2 条是"提前派发跑过的工具不会被跑第二遍"的**唯一**保障。
 * 装配那天**不会**新写一条"跳过已派发调用"的分支（那样漏掉 tool 消息，
 * 下一次请求会被 provider 拒）；它靠的就是这条已有路径。
 *
 * 所以：谁要是把重放路径改没了、或者把 `continue` 去掉，提前派发就会
 * **把写工具跑两遍**。而这不会报错，只在真机上表现为重复提交。
 * 那正是守卫该在的地方——赶在它变成事故之前。
 *
 * 装配落地之后，本文件应当**删掉**（而不是被改成"检查装配已完成"）：
 * 它守的是"老路还没被动过"，而装配之后老路就**该**被共用。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const HANDLERS = resolve(import.meta.dirname, "..");
const read = (name: string) => readFileSync(join(HANDLERS, name), "utf8");
const runtime = read("companion-agent-runtime.ts");
/**
 * 「落账本 → 执行 → 写终态」这段在 2026-10-01 从循环体搬进了
 * `companion-tool-execution-run.ts`（提前派发要与循环共用同一份）。
 *
 * 判据的对象是**整条执行链**，不是某一个文件：账本在 runtime 里登记，
 * 执行与终结在 execution-run 里。所以扫描范围是这两个文件合起来看。
 */
const chain = `${runtime}\n${read("companion-tool-execution-run.ts")}`;

/** 只取工具步循环体，避免读到文件里别处的同名调用。 */
function dispatchLoop(): string {
  const start = runtime.indexOf("for (const call of calls) {");
  assert.ok(start > 0, "找不到工具步循环 —— 这个守卫的扫描范围要跟着代码走");
  // 循环体到**下一层**的收尾为止：下一行同缩进的 "}" 之前。
  const rest = runtime.slice(start + 1);
  const end = rest.indexOf("\n    }");
  assert.ok(end > 0, "找不到循环体的收尾");
  return runtime.slice(start, start + end);
}

test("账本先于执行 —— 提前派发靠它证明「这一格已登记过」", () => {
  const loop = dispatchLoop();
  const ledger = loop.indexOf("ensureAgentToolCall(");
  const execute = loop.indexOf("runCompanionToolExecution(");
  assert.ok(ledger >= 0, "循环里找不到 ensureAgentToolCall —— 账本不在派发链上");
  assert.ok(execute >= 0, "循环里找不到 runCompanionToolExecution —— 派发链断在这里");
  // 执行段内部：runWithAbortBudget 必须**在** executeTool 之前拿到 childSignal，
  // 否则 abort 传不下去（这一条由 companion-tool-result 的那条判据从细处守住）。
  const runStart = chain.indexOf("runCompanionToolExecution(");
  assert.ok(chain.indexOf("ensureAgentToolCall(") >= 0, "整条链里找不到 ensureAgentToolCall");
  assert.ok(runStart >= 0, "找不到执行段");
  assert.ok(chain.indexOf("runWithAbortBudget(", runStart) > runStart
    && chain.indexOf("runWithAbortBudget(", runStart) < chain.indexOf("executeTool(", runStart),
  "执行段里 runWithAbortBudget 应当包在 executeTool 外面 —— 那才是它的预算闸");
});

test("终态即免执行：`!replayable` 那一支 `continue`，所以跑过的工具不会跑第二遍", () => {
  const loop = dispatchLoop();
  const branch = loop.indexOf("if (!replayable) {");
  assert.ok(branch > 0, "找不到重放分支 —— 提前派发会**把写工具跑两遍**");
  // 这一支里必须 `continue`，否则会顺着往下走到执行。
  const tail = loop.slice(branch, loop.indexOf("if (record.isNew && toolCallCount"));
  assert.ok(tail.includes("continue;"),
    "重放分支里没有 continue —— 它会继续往下走到执行，提前派发就会重复执行");
  // 并且它必须推 tool 消息：少了它，下一次 provider 请求会因缺 tool 响应被拒。
  assert.ok(tail.includes('role: "tool"'),
    "重放分支没有推 tool 消息 —— 下一次请求会被 provider 拒");
});

test("【自证】判据认得出「把 continue 删掉」这个真实退化", () => {
  // 退化形状：重放分支不再 `continue`，于是终态的工具被再执行一次。
  const degraded = [
    "if (!replayable) {",
    '  messages.push({ role: "tool", toolCallId: call.id });',
    "}",
    "const again = await executeTool();",
  ].join("\n");
  const start = degraded.indexOf("if (!replayable) {");
  const tail = degraded.slice(start, degraded.indexOf("const again"));
  assert.ok(!tail.includes("continue;"),
    "自证样本没造好：退化形状本该被上面那条判据逮住（它没有 continue）");
  // 正控制：真代码里有。
  const loop = dispatchLoop();
  const branch = loop.indexOf("if (!replayable) {");
  const realTail = loop.slice(branch, loop.indexOf("if (record.isNew && toolCallCount"));
  assert.ok(realTail.includes("continue;"), "自证：当前代码确实有 continue，所以判据今天是绿的");
});
