import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { AgentRole, COMPANION_AGENT_TOOL_DEFINITIONS, validateCompanionAgentToolArguments,
  type AgentTurnRequest } from "@astella/shared";
import { companionStepRuntimePolicy } from "../handlers/companion-step-plan.ts";
import { platform, observedProvider, save, type WireReceipt } from "./acceptance-common.ts";
import { fileURLToPath } from "node:url";

/**
 * 方案 52 §6 的宽对照：改写前后两臂，只换 description 的文字，其余（工具面、参数形状、
 * 运行时策略、模型档）完全同一份代码路径。判据按 §6 三条：该调没调、调错格子、参数填错。
 * 合成上下文，不读任何真实笔记与会话。
 */
const root = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * 对照臂的旧文案**不落成第二份文件**（那正是这份仓库要避免的第二套真相）：运行时从
 * `git show HEAD:` 里按 `tool("name", "…")` 的字面量取，取不满 57 条就当场失败。
 */
function headToolDescriptions(): Record<string, string> {
  const files = ["packages/shared/src/companion-capability-manifest.ts", "packages/shared/src/agent-capability-manifests.ts"];
  const out: Record<string, string> = {};
  for (const file of files) {
    const source = execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8", cwd: root });
    const re = /(?:tool|manifest)\(\s*"([a-z_0-9]+)"\s*,\s*"/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) {
      let i = re.lastIndex, buf = "";
      while (i < source.length) {
        if (source[i] === "\\") { buf += source[i] + source[i + 1]; i += 2; continue; }
        if (source[i] === '"') break;
        buf += source[i]; i += 1;
      }
      out[match[1]] = buf.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  return out;
}

const head: Record<string, string> = (() => {
  const parsed = headToolDescriptions();
  // 有的格子 HEAD 文案不是字面量（open_page 那格的词表由代码生成），字面量解析取不到。
  // 这类只允许由 HEAD worktree 落成 outputs 里的工作材料，不写进仓库当第二套真相。
  const cache = `${root}outputs/audits/description-ab/head-descriptions.json`;
  if (!existsSync(cache)) return parsed;
  const cached = JSON.parse(readFileSync(cache, "utf8")) as Record<string, string>;
  return { ...cached, ...parsed };
})();
const face = COMPANION_AGENT_TOOL_DEFINITIONS.map(definition => ({ definition, head: head[definition.name] }));
const missing = face.filter(entry => typeof entry.head !== "string").map(entry => entry.definition.name);
assert.deepEqual(missing, [], `对照臂取不到 HEAD 文案（生成式文案的格子请从 HEAD worktree 落到 ${root}outputs/audits/description-ab/head-descriptions.json）`);
// 两臂体量按**这一面的 57 格**算（HEAD 文件里还有目标面的格子，不计进来）。
const headOnFace = face.map(entry => entry.head as string);
console.log(JSON.stringify({ event: "arms", faceTools: face.length,
  headChars: headOnFace.reduce((n, v) => n + v.length, 0),
  headOver150: headOnFace.filter(v => v.length > 150).length,
  currentChars: COMPANION_AGENT_TOOL_DEFINITIONS.reduce((n, d) => n + d.description.length, 0) }));

const noteId = "11111111-1111-4111-8111-111111111111";
const noteVersionId = "22222222-2222-4222-8222-222222222222";
const sourceId = "66666666-6666-4666-8666-666666666666";
const memoryId = "88888888-8888-4888-8888-888888888888";

type AbCase = { name: string; text: string; accept: string[]; also?: string[];
  intent: "task" | "question" | "conversation"; fieldCheck?: (args: Record<string, unknown>) => boolean };

const cases: AbCase[] = [
  { name: "read_source", text: `这份材料里讲并发上限那一段原文是怎么写的\n${JSON.stringify({ context: { sourceId } })}`,
    accept: ["companion_read_source"], intent: "task" },
  { name: "search_notes", text: "我库里有没有讲 CAP 定理的笔记", accept: ["companion_search_notes"], intent: "task" },
  { name: "read_history", text: "刚才那段被折掉的原话你再给我看一下", accept: ["companion_read_history"], intent: "task" },
  { name: "recall_past_conversation", text: "我们上次聊的那个复习安排当时是怎么定的",
    accept: ["companion_recall_past_conversation"], intent: "task" },
  { name: "read_self_notes", text: "你自己记的关于我复习节奏那条是怎么写的", accept: ["companion_read_self_notes"], intent: "task" },
  { name: "read_current_page", text: "这一页怎么这么多张卡到期了", accept: ["companion_read_current_page"], intent: "task" },
  { name: "open_page", text: "帮我打开复习队列", accept: ["companion_open_page"], intent: "task",
    fieldCheck: (args) => args.page === "review" },
  { name: "learning_stats", text: "我这周一共学了多久", accept: ["companion_get_learning_stats"], intent: "task" },
  { name: "due_reviews", text: "今天有什么要复习的", accept: ["companion_list_due_reviews"],
    also: ["companion_read_current_page"], intent: "task" },
  { name: "read_note_by_version", text: `这篇笔记第三块讲的是什么\n${JSON.stringify({ context: { noteId, noteVersionId } })}`,
    accept: ["companion_read_note"], intent: "task" },
  { name: "read_memory_by_id", text: `你说记住过我这一条，具体写的是什么\n${JSON.stringify({ facts: { memoryCatalog: [{ memoryId, revision: 1, title: "复习偏好" }] } })}`,
    accept: ["companion_read_memory"], also: ["companion_recall_memory"], intent: "task" },
  { name: "negative_greeting", text: "在吗", accept: [], intent: "conversation" },
] as const;

type Outcome = { case: string; arm: "current" | "head"; called: string | null; accepted: boolean;
  argumentsValid: boolean | null; fieldOk: boolean | null; elapsedMs: number };

const route = platform("agent_turn"), wire: WireReceipt[] = [];
const provider = observedProvider(route, "description-ab", wire);
const outcomes: Outcome[] = [];

function toolsFor(arm: "current" | "head") {
  return face.map(({ definition, head }) => ({ name: definition.name,
    description: arm === "head" ? head : definition.description, parameters: definition.parameters }));
}

async function runOnce(item: AbCase, arm: "current" | "head"): Promise<Outcome> {
  const request: AgentTurnRequest = { role: AgentRole.COMPANION_AGENT,
    messages: [{ role: "user", content: item.text }],
    systemPrompt: companionStepRuntimePolicy({ permissionLevel: "full", toolCount: face.length,
      stepBudget: 1, finalAnswerOnly: false, attentionIntent: item.intent }),
    tools: toolsFor(arm), toolChoice: "auto",
    maxTokens: route.modelProfile?.maxOutputTokens ?? 8_192, temperature: 0.2 };
  const start = Date.now();
  const result = await provider.executeAgentTurn!(request, new AbortController().signal);
  const call = (result.toolCalls ?? [])[0] ?? null;
  const accepted = !!call && (item.accept.includes(call.name) || (item.also?.includes(call.name) ?? false));
  let argumentsValid: boolean | null = null, fieldOk: boolean | null = null;
  if (call) {
    const checked = validateCompanionAgentToolArguments(call.name, call.arguments);
    argumentsValid = checked.success;
    if (checked.success && item.fieldCheck) fieldOk = item.fieldCheck(checked.data as Record<string, unknown>);
  }
  return { case: item.name, arm, called: call?.name ?? null, accepted, argumentsValid, fieldOk, elapsedMs: Date.now() - start };
}

for (const [index, item] of cases.entries()) {
  const order: Array<"current" | "head"> = index % 2 === 0 ? ["current", "head"] : ["head", "current"];
  for (const arm of order) {
    const outcome = await runOnce(item, arm);
    outcomes.push(outcome);
    save("description-ab-20261012", { model: route.model, outcomes, wire,
      scope: "synthetic context only; description text is the only difference between arms" });
    console.log(JSON.stringify(outcome));
  }
}

const summarise = (arm: "current" | "head") => {
  const rows = outcomes.filter(row => row.arm === arm);
  const expectedCalls = cases.filter(item => item.accept.length);
  return { arm, n: rows.length,
    missed: rows.filter(row => row.called === null && expectedCalls.some(item => item.name === row.case)).map(r => r.case),
    wrongTool: rows.filter(row => row.called !== null && !row.accepted).map(r => `${r.case}→${r.called}`),
    badArgs: rows.filter(row => row.argumentsValid === false).map(r => r.case),
    badField: rows.filter(row => row.fieldOk === false).map(r => r.case),
    falseCallOnChitchat: rows.filter(row => row.case === "negative_greeting" && row.called !== null).map(r => r.called) };
};
const report = { current: summarise("current"), head: summarise("head"), outcomes, wire };
save("description-ab-20261012", { model: route.model, report, scope: "synthetic context only" });
console.log(JSON.stringify({ current: report.current, head: report.head }));
