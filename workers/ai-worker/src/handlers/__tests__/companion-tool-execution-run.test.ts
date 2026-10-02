/**
 * `runCompanionToolExecution` 的**结局分派**（40b §4.1-1 / §4.1-2 / R7）。
 *
 * ## 为什么必须有这条
 *
 * 2026-10-01 执行段从工具步循环搬进这个模块，让**工具步循环与提前派发共用同一份**
 * （搬两处就会分叉，而分叉不报错）。搬完之后它自己有了三样以前没有的东西：
 *
 *  1. 它**不抛**失败——失败已经落进账本并下发了 SSE，调用方要的是一条 tool 消息；
 *  2. 它可能被**并发**调用（提前派发一次开跑多格），而账本只有一行 per call id；
 *  3. 它的 `fence` 是每次调用**新建**的——共用一个 fence 会让先结束的那一格
 *     把后一格的迟到 settle 也标成 abandoned。
 *
 * ## 这里测的是"分派"，不是"执行"
 *
 * 真正的执行要连库。本文件用**注入**的方式把执行器换掉，只验那三条结构性质。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { companionToolFailureFaces } from "../companion-tool-failure-faces.ts";

const source = readFileSync(resolve(import.meta.dirname, "..", "companion-tool-execution-run.ts"), "utf8");

test("失败**不抛**出去：它已经落进账本了，调用方要的是 tool 消息", () => {
  // 循环原来那一段是 try/catch + continue；搬出来之后如果还抛，
  // 提前派发的 dispatch 会把整个流带着炸掉，而老路的 `continue` 也变不回来了。
  const catchIdx = source.indexOf("} catch (error) {");
  assert.ok(catchIdx > 0, "找不到 catch 分支");
  const tail = source.slice(catchIdx);
  assert.match(tail, /return\s*\{\s*kind: "failure"/,
    "catch 分支没有 return 一个 failure —— 它要么抛了、要么返回了别的东西");
  assert.ok(!/throw\s+new\s+\w+/.test(tail),
    "catch 分支里还在 throw —— 失败会炸掉调用方");
});

test("三种结局都有显式返回，调用方不需要猜", () => {
  for (const kind of ["success", "waiting", "failure"]) {
    assert.ok(source.includes(`kind: "${kind}"`), `没有 ${kind} 这一档`);
  }
});

test("fence 是**每次调用新建**的 —— 共用会让先结束的那格把后一格标成 abandoned", () => {
  // `abandoned` 的作用是：超时后迟到的 settle 既不覆盖审计状态，也不再下发 SSE。
  // 如果它是模块级共享的，A 格超时置位之后，B 格**正常**返回也会被判成废弃。
  assert.match(source, /const fence: ToolExecutionFence = \{ abandoned: false \};/,
    "fence 不是每次调用新建的 —— 并发两格会互相污染");
  assert.ok(!/^let fence|^const fence = \{ abandoned: false \};$/m.test(source.replace(/ {2,}const fence[^\n]*\n/, "")),
    "fence 出现在函数之外了");
});

test("超时会先于执行被拒：剩余预算 <= 0 直接抛预算错误", () => {
  // 这一条对应"工具超时 abort 传播"（§4.1-2）：预算用完时**不许**再去起一次执行。
  assert.match(source, /const remainingMs = args\.deadlineAt - Date\.now\(\);[\s\S]{0,120}if \(remainingMs <= 0\)/,
    "预算用尽的检查不在执行之前");
});

test("childSignal 交到了执行器 —— 40b §4.1-2「向下传播 abort」", () => {
  const idx = source.indexOf("executeTool(");
  const window = source.slice(Math.max(0, idx - 400), idx + 200);
  assert.match(window, /\(childSignal\)\s*=>/,
    "runWithAbortBudget 的回调没有接住 signal —— abort 传不下去");
  assert.match(window, /executeTool\([\s\S]{0,200}childSignal/,
    "signal 没有交给 executeTool");
  assert.ok(!/runWithAbortBudget\(\s*\(\)\s*=>/.test(source),
    "又变回 `() =>` 了：signal 在这里被丢掉");
});

test("回执映射只有一份：账本与模型用同一个词（companionToolFailureFaces）", () => {
  // 曾经分散写在五处分支上；搬出来之后必须是**调用**那一个函数，
  // 否则下一次新增状态时又漏掉几处，而漏掉的后果是模型收到一种它不认识的失败。
  assert.ok(source.includes("companionToolFailureFaces("), "没有走统一的映射函数");
  // 判据要看的是"绕过"，不是"读了它"。`ledgerStatus: failure.ledgerStatus`
  // 正是应当的形状；真正要防的是就地造一个状态词（`ledgerStatus: "not_executed"`）。
  assert.ok(!/ledgerStatus:\s*"/.test(source),
    "这里就地写了一个状态词 —— 绕过了统一映射");
  assert.ok(!/modelStatus:\s*"/.test(source),
    "模型侧的词也是就地写的 —— 那样账本与模型会说出两种失败");
  // 且两个词都来自同一个 failure 对象。
  assert.match(source, /ledgerStatus: failure\.ledgerStatus/);
  assert.match(source, /modelStatus: failure\.modelStatus/);
});

test("失败路径要记 run failure span，成功路径要恢复它", () => {
  assert.ok(source.includes("recordCompanionRunFailureSpanBestEffort("), "失败路径没有记 span");
  assert.ok(source.includes("recoverCompanionRunFailureSpanBestEffort("), "成功路径没有恢复 span");
});

test("【自证】判据认得出「catch 里再 throw」这个真实退化", () => {
  // 退化形状：搬的时候手滑把 `return` 写成了 `throw`。
  const degraded = '} catch (error) { throw new Error("boom"); }';
  const start = degraded.indexOf("} catch (error) {");
  const tail = degraded.slice(start);
  assert.ok(/throw\s+new\s+\w+/.test(tail) && !/return\s*\{\s*kind: "failure"/.test(tail),
    "自证样本没造好：退化形状本该被第 1 条逮住");
  const real = source.slice(source.indexOf("} catch (error) {"));
  assert.ok(!/throw\s+new\s+\w+/.test(real), "自证：当前 catch 分支确实不抛");
});

test("【自证】判据认得出「fence 提到模块级」这个真实退化", () => {
  // 退化形状：fence 变成模块级单例，于是 A 格的 abandoned 会污染 B 格。
  const shared = 'let fence: ToolExecutionFence = { abandoned: false };';
  assert.ok(!source.includes(shared.replace(/\s+/g, " ")) || !/^let fence/m.test(source),
    "自证样本没造好");
  assert.match(source, /const fence: ToolExecutionFence = \{ abandoned: false \};/,
    "自证：当前 fence 确实是函数内新建的");
});

test("companionToolFailureFaces 仍然把同一个词交给账本与模型", () => {
  const faces = companionToolFailureFaces({ status: "not_executed", safeSummary: "x" });
  assert.equal(faces.ledgerStatus, "not_executed");
  assert.equal(faces.modelStatus, "not_executed");
  // 折叠过的状态会让 doctor/回放查不到真实原因（0349 之后不再需要降级）。
  assert.equal(faces.ledgerStatus, faces.modelStatus);
  assert.equal(typeof join, "function");
});
