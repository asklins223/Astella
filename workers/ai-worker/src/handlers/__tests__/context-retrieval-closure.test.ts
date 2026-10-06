import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { COMPANION_AGENT_TOOL_DEFINITIONS } from "@astella/shared/companion-agent-registry";
import { renderConversationSummary } from "../companion-summarizer.ts";

/**
 * 方案 44 §5.5：取回入口闭合回路。
 *
 * 闭合的定义是三件事同时成立：
 *   1. 模型**知道**自己没读过哪一段（覆盖回执/摘要块说了）；
 *   2. 模型**知道怎么取回**（说了工具与参数）；
 *   3. 那条取回路径**真的存在**，且参数名对得上。
 *
 * 只做前两条最常见：提示词里写「请取回原文」，而根本没有那条工具——于是模型要么
 * 假装读过，要么干脆不提，而这两样都是用户看不见的损失。
 */

/** 工具定义里的 parameters 是 **JSON Schema**（zod 编译而来），属性在 `properties`。 */
interface JsonSchemaParameters { properties?: Record<string, unknown> }
const toolDef = (name: string) =>
  COMPANION_AGENT_TOOL_DEFINITIONS.find((definition) => definition.name === name) as
    { name: string; description: string; parameters: JsonSchemaParameters } | undefined;
const hasParam = (name: string, param: string): boolean =>
  param in ((toolDef(name)?.parameters.properties ?? {}) as Record<string, unknown>);

test("44 §5.5：摘要块给出的取回入口，指向一条真实存在且带 fromSeq 的工具", () => {
  const block = renderConversationSummary(
    { title: "复习安排" },
    { coverageVerified: true, coverageGaps: [{ fromSeq: "20", throughSeq: "29" }] },
  );
  const mentioned = block!.match(/companion_\w+/g) ?? [];
  assert.ok(mentioned.length > 0, "有洞时必须点名取回工具");
  for (const name of mentioned) {
    const definition = toolDef(name);
    assert.ok(definition, `摘要块点名了不存在的工具：${name}`);
    assert.ok(hasParam(name, "fromSeq"),
      `${name} 没有 fromSeq 参数——摘要块教她传了一个不存在的参数`);
  }
});

test("44 §5.5：会话内取回复用 read_history，跨会话取回复用 recall_past_conversation", () => {
  // 两条路径都真的读库；摘要块指向的是会话内那条。
  const history = toolDef("companion_read_history");
  assert.ok(history);
  assert.match(history!.description, /fromSeq/);
  assert.ok(hasParam("companion_read_history", "fromSeq"));
  // 跨会话那条的 conversationId 必填 —— seq 是会话内局部序号（44 §8.3）。
  const recall = toolDef("companion_recall_past_conversation");
  assert.ok(recall);
  assert.ok(hasParam("companion_recall_past_conversation", "fromSeq"));
});

test("44 §5.5：取回路径真的连到会话范围校验，而不是上下文里的转述", () => {
  const source = readFileSync(
    new URL("../companion-tool-execution.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /readPastConversationMessages\(/);
  // 范围校验在会话上：只给 seq 不给会话就会读到另一个会话的同号消息。
  assert.match(source, /conversationId: event\.read\.conversationId, fromSeq: String\(fromSeq\)/);
});

test("44 §3.2：跨会话找回同时给会话摘要、方法与长期目标", () => {
  const source = readFileSync(
    new URL("../companion-tool-execution.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /searchPastConversationSummaries\(/);
  assert.match(source, /listAgentMethods\(/);
  assert.match(source, /listAgentLongGoals\(/);
  const recall = toolDef("companion_recall_past_conversation");
  assert.match(recall!.description, /方法/);
  assert.match(recall!.description, /长期目标/);
});
