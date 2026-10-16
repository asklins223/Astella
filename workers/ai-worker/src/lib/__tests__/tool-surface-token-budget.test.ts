import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAllCompanionAgentTools } from "@astella/shared/companion-agent-registry";
import { countModelTextTokens } from "../model-tokenizers.ts";

/**
 * 工具面的**真 tokenizer** 预算（2026-10-16）。
 *
 * 为什么这条守卫要另立一份，而不是接着用 shared 里那份字符预算：
 *   - shared 里量的是**声明的字符数**，它能在声明长大时报警，但它不知道该长多少钱；
 *   - 真正每步随请求付一次的是序列化之后的 token，而工具面是固定开销里最大的一块
 *     （一轮闲聊里 tool schema ≈ 9,000 token，runtimePolicy 与场景指引加起来只有几百）。
 *
 * 方案 52 就是在这一步量出「8,800 token/步」的，但那次量尺是**用完即删的一次性脚本**，
 * 所以 2026-10-11 → 10-16 这五天里聊天面从 57 条长到 65 条、从 7,741 涨到 8,999 token
 * （+16%），没有任何东西报过警。这条守卫把那次量尺留在仓库里。
 *
 * 抬上限之前先回答：新加的这一格，能不能并进现役工具？有没有真实调用频次说明它值得？
 * （`companion_agent_tool_calls` 表里 `GROUP BY name` 就是那份依据。）
 */
const MODEL = "deepseek-v4.1-flash";
/** 全量聊天面（含受图片外发政策管的那一条，它就是最宽的那一面）。 */
const SURFACE_TOKEN_LIMIT = 9_500;
/** 三个组成部分各自的上限，让增长可归因——parameters 才是大头（实测占 60%）。 */
const DESCRIPTIONS_TOKEN_LIMIT = 2_600;
const PARAMETERS_TOKEN_LIMIT = 6_000;
const NAMES_TOKEN_LIMIT = 800;

const surface = resolveAllCompanionAgentTools("full", { visionEnabled: true, webSearchEnabled: true });

async function count(text: string): Promise<number> {
  const tokens = await countModelTextTokens(MODEL, text);
  assert.notEqual(tokens, null, `没有 ${MODEL} 的 tokenizer，这条预算就量不出来`);
  return tokens!;
}

test("聊天面工具面的真 token 不超过预算（工具面是每步固定开销里最大的一块）", async () => {
  const wire = surface.map(tool => JSON.stringify({ type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters } })).join("\n");
  const total = await count(wire);
  const names = await count(surface.map(tool => JSON.stringify({ name: tool.name })).join("\n"));
  const descriptions = await count(surface.map(tool => tool.description).join("\n"));
  const parameters = await count(surface.map(tool => JSON.stringify(tool.parameters)).join("\n"));
  const message = `聊天面 ${surface.length} 条工具，工具面 ${total} token`
    + `（names ${names} / descriptions ${descriptions} / parameters ${parameters}）；`
    + `预算 ${SURFACE_TOKEN_LIMIT}。这一面每步都随请求付一次，该并的要并，别只加。`;
  assert.ok(total <= SURFACE_TOKEN_LIMIT, message);
  assert.ok(names <= NAMES_TOKEN_LIMIT, `names ${names} token 超过 ${NAMES_TOKEN_LIMIT}：${message}`);
  assert.ok(descriptions <= DESCRIPTIONS_TOKEN_LIMIT,
    `descriptions ${descriptions} token 超过 ${DESCRIPTIONS_TOKEN_LIMIT}：${message}`);
  assert.ok(parameters <= PARAMETERS_TOKEN_LIMIT,
    `parameters ${parameters} token 超过 ${PARAMETERS_TOKEN_LIMIT}：${message}`);
});
