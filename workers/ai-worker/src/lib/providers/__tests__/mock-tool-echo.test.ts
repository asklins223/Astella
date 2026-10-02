/**
 * mock provider **不许把工具结果原样搬进正文**（39d W6 的同进程演练带出来的）。
 *
 * ## 量到的实情
 *
 * 同进程演练接上伴星对话那一环时，整轮对话被 `internal_token_leak` 拦下、终止。
 * 链条是：第 1 步回 `tool_calls`（`companion_read_context`）→ 第 2 步 mock 回
 * `已读取伴星工具结果：{"pageKind":…,"currentLearningRun":{"runId":"<uuid>"…}}` →
 * `COMPANION_LEAK_PATTERN` 的 uuid 那一支命中 → 整轮终止。
 *
 * ## 为什么不改守卫
 *
 * **守卫拦得对。** 那条 uuid 支是实机 2026-09-21 加的，理由逐字写在源码里：
 * 「uuid 出现在正文里，她把 noteId/cardId 念出来今天没人管」。工具结果带 uuid
 * 是**对的**（`companion-agent-runtime.ts` 把整个结果交给模型，模型需要它），
 * 错的是**把工具结果原样搬进正文**——那不是任何真实模型会做的事：真实模型拿到
 * 上下文是为了**回答**，不是为了复述它。
 *
 * 所以修在 mock：只取 `safeSummary`（那份的注释写着「它会进她的可见轨迹」，
 * 专门为"可以让她说出来"准备），取不到就退回一句中性话，**不**回显原文。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MOCK_RAW = readFileSync(
  resolve(import.meta.dirname, "..", "..", "providers", "mock.ts"), "utf8",
);
/**
 * **只判代码，不判注释。**
 *
 * 第一版直接拿原文去 `includes`，而那句 `已读取伴星工具结果：{…}` 在我写修复说明时
 * **被保留在了注释里**（记着第一版写的是什么）——于是判据红在一个**注释**上。
 * 症状离病因两步：判据量错了对象（该量代码），而那个"红"看起来像是修复没生效。
 * 台账 §3 纪律：源码形状判据要判代码。
 */
const MOCK = MOCK_RAW
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

/** 与生产同源的那条泄露判据（不是抄一份——抄一份必然分叉）。 */
const LEAK = /(companion-persona-v\d+|companion_[a-z_]{4,}|character\.cue|"cue"|reason\s*id|tool\s*param|promptVersion|"route"\s*:|activeMemories|residentMemories|memoryDirectory|recentMessages|currentMessage|workspacePolicy|sendToExternal|piiDetection|pageContext|selectedText|groundedTarget|<memory_data>|<memory_directory>|<persona_data>|<selection_data>|<page_context>|<grounded_target>|<here_and_now>|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

test("mock 不再把工具结果原样回显进正文", () => {
  assert.match(MOCK, /mockToolResultLine\(/,
    "读不到取 safeSummary 的那条路：工具结果又回到正文里了");
  // **正向**：`已读取伴星工具结果：` 那句回显已经不在
  assert.ok(!/已读取伴星工具结果/.test(MOCK),
    "mock 还在原样回显工具结果：工具面里流通的东西被搬进了她的正文");
  // **反向**：取不到 safeSummary 时退回的是一句**中性**话，不是原文
  assert.match(MOCK, /return "我读取了一下当前上下文。";/,
    "取不到 safeSummary 时没有落到那句中性话：可能回显了原文");
  // 它**只**取 safeSummary 这一格，不取整个对象
  const fn = MOCK.slice(MOCK.indexOf("function mockToolResultLine"), MOCK.indexOf("export class"));
  assert.match(fn, /parsed\?\.safeSummary/, "取的不是 safeSummary 那一格");
  assert.ok(!/\bvalue\b\s*[,}]/.test(fn.replace(/safeSummary[^\n]*/g, "")),
    "那个函数里还碰了别的字段：它不该把整个工具结果拆开看");
});

test("那两句 mock 剧本仍然按原样回（它们是**有意**的违约形状，不能被这一刀顺手改掉）", () => {
  // `【mock:fact-span】` 与 `【mock:leak-answer】` 两条剧本是在**测**她会不会那样写，
  // 回显是它们的目的。顺带改掉会让那两条集测变成空转。
  assert.match(MOCK, /\{\{f:today_minutes\}\}/, "fact-span 剧本不见了：那条管道就没有样本了");
  assert.match(MOCK, /复利效应是本金产生利息后加入本金继续生息/, "leak-answer 剧本不见了");
});

/** 变异自证：把回显改回去，那两条判据必须红。 */
test("判据对「改回原样回显」灵敏", () => {
  const mutated = MOCK.replace(
    /\? mockToolResultLine\(toolResult\.content\)/,
    "? `已读取伴星工具结果：${String(toolResult.content).slice(0, 400)}`",
  );
  assert.notEqual(mutated, MOCK, "变异造不出差异 ⇒ 判据恒真（正则指错了地方）");
  assert.match(mutated, /已读取伴星工具结果/,
    "变异没有真的把回显改回去：守卫读不到那一处");
  // 变异版的输出**真的会被生产那条判据拦下**——不是形状相似，是同一条正则
  const leakyLine = `已读取伴星工具结果：${JSON.stringify({
    pageKind: "today",
    currentLearningRun: { runId: "0f9a5c9c-1b3f-4c1e-9c1a-6f2b7d5e4a10" },
  })}`;
  assert.match(leakyLine, LEAK, "这一版输出竟然不被拦：那判据量错了对象");
});
