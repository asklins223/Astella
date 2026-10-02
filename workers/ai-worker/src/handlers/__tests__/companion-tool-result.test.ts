/**
 * 工具面共用的报错与结果类型（`companion-tool-result.ts`）。
 *
 * ## 为什么这两样值得一条测试
 *
 * 2026-10-01 记忆工具族被搬出执行器时，它们被上提到这个叶子模块，因为
 * 「执行器 ←→ 记忆族」互相 import 会成环。搬完之后，最容易悄悄坏掉的不是类型，
 * 而是**类的身份**：
 *
 * - `classifyCompanionToolFailure` 靠 `error instanceof CompanionToolError` 分流，
 *   拿到另一个模块的副本就会把「用户看得见的失败」降级成「内部错误」；
 * - `companion-agent-runtime.ts` 与 `companion-tool-execution.ts` 都对外导出这两个类，
 *   下游拿到的**必须是同一个构造器**，否则 `instanceof` 一边成立一边不成立。
 *
 * 复制一份类比多写一行更糟：两条路径会各自演化，最后同一个错误在两处被判成两种。
 * 所以下面钉的是**身份**，不是形状。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CompanionToolError as FromResult,
  CompanionToolBlockedError as BlockedFromResult,
  CompanionToolOutcomeUnknownError as OutcomeUnknown,
  CompanionToolNotExecutedError as NotExecutedFromResult,
  CompanionToolUnavailableError as UnavailableFromResult,
} from "../companion-tool-result.ts";
import {
  CompanionToolError as FromOutcome,
  CompanionToolBlockedError as BlockedFromOutcome,
  CompanionToolNotExecutedError as NotExecutedFromOutcome,
  CompanionToolUnavailableError as UnavailableFromOutcome,
} from "../companion-tool-outcome.ts";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  classifyCompanionToolFailure,
  TOOL_OUTCOME_UNKNOWN_SAFE_SUMMARY,
} from "../companion-tool-outcome.ts";
import { executeCompanionMemoryTool } from "../companion-memory-tools.ts";

test("失败分类器与叶子模块拿到的是**同一个构造器**，不是各写一份", () => {
  // 这条断言的全部意义：只要有人「顺手复制一份类」，这里当场红。
  assert.equal(FromOutcome, FromResult, "失败分类器拿到的不是叶子模块那个类");
  assert.equal(BlockedFromOutcome, BlockedFromResult, "失败分类器拿到的 blocked 类不是同一个");
  // 40b §3.2 新增的两类同理：它们靠 instanceof 分流，身份错了两档就永远读不到。
  assert.equal(NotExecutedFromOutcome, NotExecutedFromResult, "not_executed 的类不是同一个");
  assert.equal(UnavailableFromOutcome, UnavailableFromResult, "unavailable 的类不是同一个");
});

test("记忆工具族抛出的错，分类器认得——否则那句中文失败说明会被换成通用话术", () => {
  // 账本与记忆族都只是 import、不再对外导出，所以拿不到它们的构造器；
  // 这里改钉**真正会坏的那条链**：记忆族抛出的错必须被分类成用户看得见的 failed，
  // 而不是掉进 `TOOL_FAILURE_SAFE_SUMMARY`（一句话废话）或更糟的 outcome_unknown。
  return executeCompanionMemoryTool(
    { } as never,
    { name: "companion_search_notes" } as never,
    {},
  ).then(
    () => assert.fail("非记忆工具竟然没有抛错"),
    (error: unknown) => {
      assert.ok(error instanceof FromResult,
        "记忆族抛的不是 CompanionToolError——`instanceof` 一旦不成立，"
        + "classifyCompanionToolFailure 会把它当成未知异常");
      const classified = classifyCompanionToolFailure(error, "read", false);
      assert.equal(classified.status, "failed");
      assert.match(classified.safeSummary, /不是记忆工具/,
        "失败说明被换成了通用话术，用户看不到到底发生了什么");
    },
  );
});

test("blocked 与普通失败分得开——降级到 unknown 会误导成「可能已经改过东西」", () => {
  assert.equal(classifyCompanionToolFailure(new FromResult("没找到这条"), "reversible_low", true).status, "failed");
  assert.equal(
    classifyCompanionToolFailure(new BlockedFromResult("超出你给的权限"), "reversible_low", true).status,
    "blocked",
  );
  // 对照：真正未知的异常必须仍然是 outcome_unknown，不能被这两级吃掉。
  assert.equal(classifyCompanionToolFailure(new Error("boom"), "reversible_low", true).status, "outcome_unknown");
});

test("「回执没落下来」必须是 outcome_unknown，不能降级成 failed", () => {
  // 2026-10-01 修的那个缺陷就靠这一条钉住：账本这一写没落下来时，
  // `executeTool` 抛出来的就是它。若它继承自 CompanionToolError，
  // 这里会变成 failed——把「可能已经改了东西」说成「确定没发生」，
  // 用户据此再操作一次就可能重复提交。
  const error = new OutcomeUnknown(TOOL_OUTCOME_UNKNOWN_SAFE_SUMMARY);
  assert.ok(!(error instanceof FromResult),
    "它继承自 CompanionToolError——分类器会把它判成 failed（确定没发生）");
  assert.equal(classifyCompanionToolFailure(error, "reversible_low", true).status, "outcome_unknown");
  // 读类工具没有副作用，报 failed 是对的（不能让它挂成 unknown 吓人）。
  assert.equal(classifyCompanionToolFailure(error, "read", true).status, "failed");
  // 【自证】若它继承了 CompanionToolError，上面第一条必定红——证明这条判据不是恒真。
  class IfItInherited extends FromResult {}
  assert.equal(classifyCompanionToolFailure(new IfItInherited("x"), "reversible_low", true).status, "failed",
    "自证样本没造好：继承之后分类结果变了，这条判据才有意义");
});

test("【源码守卫】账本写不下来的那一刻不许把结果当成功返回", () => {
  // 行为层的「抛不抛」要真库才测得动，但 `!recorded` 那一支的**形状**是纯文本能钉的。
  // 真发生过的版本就是它：`if (!recorded) return result;`。
  // ⚠️ 必须**先剥掉行注释**再匹配：解释这次修复的那段注释里，正文就写着
  // `if (!recorded) return result;` 这七个字。不剥的话判据会读到自己的注释，
  // 于是「已经修好了」也判红——这正是 AGENTS.md 记的「扫源码的守卫会撞上注释」。
  const raw = readFileSync(join(resolve(import.meta.dirname, ".."), "companion-tool-call-ledger.ts"), "utf8");
  const code = raw.replace(/\/\/.*$/gm, "");
  const idx = code.indexOf("if (!recorded)");
  assert.ok(idx >= 0, "账本里找不到 `if (!recorded)`——这段被改动过，先核对再改判据");
  const window = code.slice(idx, idx + 400);
  assert.ok(!/if\s*\(!recorded\)\s*return\s+result/.test(window),
    "`!recorded` 又变回 `return result` 了：账本说 outcome_unknown、模型却拿到 ok:true，"
    + "40b §6.4 的「禁止把 fail-closed 解释成静默成功」被绕回去了");
  assert.match(window, /if\s*\(!recorded\)\s*throw\s+new\s+CompanionToolOutcomeUnknownError/,
    "账本写不下来的那一支必须抛出 outcome_unknown 那一类");
  // 【自证】判据对「真发生过的那个形状」确实会红——否则上面两条可能是恒真。
  assert.ok(
    /if\s*\(!recorded\)\s*return\s+result/.test("if (!recorded) return result;"),
    "自证样本没造好：判据对历史形状应当匹配",
  );
});

test("blocked 是 blocked 的子类，而普通错误不是——两级报错不能被并成一个", () => {
  assert.ok(BlockedFromResult.prototype instanceof FromResult);
  assert.ok(new BlockedFromResult("权限不足") instanceof FromResult);
  assert.ok(!(new FromResult("普通失败") instanceof BlockedFromResult));
});

test("name 是给日志与序列化看的，各写各的", () => {
  assert.equal(new FromResult("x").name, "CompanionToolError");
  assert.equal(new BlockedFromResult("x").name, "CompanionToolBlockedError");
  // 新增两类的 name 是同一个理由存在的：串行化与日志按它区分档位。
  assert.equal(new NotExecutedFromResult("x").name, "CompanionToolNotExecutedError");
  assert.equal(new UnavailableFromResult("x").name, "CompanionToolUnavailableError");
});

test("【自证】判据认得出「复制一份类」这种真实退化", () => {
  // 复制类是最可能的退化方式，正文会红但**形状完全一样**。
  // 这里用同一个构造器冒充一次：断言相等判据确实会把它抓住。
  class DuplicatedToolError extends Error {}
  const wouldPassIfLoose = (a: unknown, b: unknown) => a instanceof Object && b instanceof Object;
  assert.equal(wouldPassIfLoose(FromResult, DuplicatedToolError), true,
    "自证样本没造好：两个类实例都该通过这种松判据");
  assert.notEqual(FromResult, DuplicatedToolError,
    "两个不同的构造器不该相等——本测试的正判据就是靠它抓复制");
});

test("子步骤预算的 signal 被**向下传进**执行器（40b §4.1-2「向下传播 abort」）", () => {
  // 此前 runtime 把回调写成 `() => {...}`，signal 被整个丢掉：超时只让调用方
  // 停止等待，在途的工具照跑照写。这里钉住两件事——
  //   ① callback 收下 signal 并把它交给 executeTool；
  //   ② executeTool 在成功记账**之前**复查它。
  /**
   * 扫描范围：`companion-agent-runtime.ts` 与 `companion-tool-execution-run.ts`。
   *
   * 2026-10-01 执行段从工具步循环搬进了 `companion-tool-execution-run.ts`
   * （提前派发要与循环共用同一份），于是 `executeTool` 不再在 runtime 里。
   * 判据的对象是**契约**（「子步骤 signal 必须到达执行器」）而不是某个文件，
   * 所以范围要覆盖承载这条契约的全部文件——否则它会报"读到的文本变少了"，
   * 而那不是它要抓的东西。
   */
  const dir = resolve(import.meta.dirname, "..");
  const candidate = ["companion-tool-execution-run.ts", "companion-agent-runtime.ts"];
  const holder = candidate.map((name) => [name, readFileSync(join(dir, name), "utf8")])
    .find(([, source]) => source.includes("executeTool("));
  assert.ok(holder, `工具执行段不在任何一个候选文件里：${candidate.join(" / ")}`);
  const runtime = holder[1];
  // 这一个文件里有**两处** runWithAbortBudget（provider 与工具），所以从 executeTool
  // 那一处往回取窗口——否则判据会读到 provider 的那次，一直绿。
  const toolCallIdx = runtime.indexOf("executeTool(");
  const start = runtime.lastIndexOf("runWithAbortBudget(", toolCallIdx);
  const window = runtime.slice(start, toolCallIdx + 200);
  assert.match(window, /\(childSignal\)\s*=>/,
    "runWithAbortBudget 的回调没有接住 signal —— abort 传不下去");
  assert.match(window, /executeTool\([\s\S]{0,200}childSignal/,
    "signal 没有交给 executeTool");
  assert.ok(!/runWithAbortBudget\(\s*\(\)\s*=>/.test(runtime),
    "又变回 `() =>` 了：signal 在这里被丢掉");

  const ledger = readFileSync(join(resolve(import.meta.dirname, ".."), "companion-tool-call-ledger.ts"), "utf8");
  const idx = ledger.indexOf("if (!recorded) throw new CompanionToolOutcomeUnknownError");
  assert.ok(idx >= 0, "账本里找不到 `!recorded` 那一支");
  const after = ledger.slice(idx, idx + 600);
  assert.match(after, /if \(signal\?\.aborted\) throw new CompanionToolOutcomeUnknownError/,
    "成功记账之前没有复查 signal —— 一次结果不确定的写会被说成成功");
});

test("【自证】判据认得出「signal 接住了但没往下传」这个半截退化", () => {
  const halfWired = "runWithAbortBudget((childSignal) => { void childSignal; executeTool(a, b); }, sig, 10);";
  assert.match(halfWired, /\(childSignal\) =>/, "自证样本没造好");
  assert.ok(!/executeTool\([\s\S]{0,200}childSignal/.test(halfWired),
    "自证：半截形状里 signal 没有进 executeTool");
});
