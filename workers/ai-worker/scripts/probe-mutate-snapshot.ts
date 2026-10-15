/**
 * 在**真实失败快照**上做变异，找出真正的触发点（2026-10-14）。
 *
 * 已知矛盾：probe-multi-assistant 的 B 发（三条 assistant、只末条带 reasoning）过了，
 * 但真实失败 run 仍 400。逐条看真实历史：`… user assistant assistant user
 * assistant assistant assistant[rs=1]`——**末尾三条连续 assistant**，只有最后一条带 rs。
 * 探针里 assistant 都被 user 隔开，从没出现过连续多条。
 *
 * 假设：网关要求**每一条"后面没有 user 接着"的 assistant**都带 reasoning_text。
 * 这一发在真实快照上变异验证：
 *  V0 原样                       → 应 400（基线）
 *  V1 去掉末尾缺 rs 的 assistant → 若过，说明就是它们触发的
 *  V2 给所有 assistant 都挂上 rs → 若过，说明逐条都要
 *  V3 只留最后一条 assistant      → 若过，说明"连续"才是关键
 */
import postgres from "postgres";

import { createProvider } from "../src/lib/ai-provider.ts";
import { resolveAllCompanionAgentTools } from "@astella/shared/companion-agent-registry";
import { resolveAIGovernanceContext, resolveProviderForTask } from "../src/lib/governance.ts";
import type { AIProvider } from "../src/lib/ai-provider.ts";

const [runId, workspaceId, userId] = process.argv.slice(2);
if (!runId || !workspaceId || !userId) throw new Error("用法：probe-mutate-snapshot.ts <runId> <workspaceId> <userId>");

const tools = resolveAllCompanionAgentTools("full", { visionEnabled: true, webSearchEnabled: true }) as never;
type AgentCapable = { executeAgentTurn(request: unknown): Promise<unknown> };
type Msg = { role: string; content: unknown; reasoning?: Array<Record<string, unknown>> };

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
let messages: Msg[] = [];
try {
  const [snap] = await sql<{ snapshot: unknown }[]>`
    SELECT snapshot FROM companion_context_handoff_snapshots WHERE run_id = ${runId}`;
  const raw = (snap?.snapshot as { modelMessages?: Msg[] } | undefined)?.modelMessages;
  if (!Array.isArray(raw)) throw new Error("modelMessages 不可用");
  messages = raw;
} finally {
  await sql.end({ timeout: 5 });
}
const [system, ...rest] = messages;
const systemPrompt = typeof system?.content === "string" ? system.content : "";
const rsSource = [...rest].reverse().find(m => m.reasoning?.length)?.reasoning?.[0];
if (!rsSource) throw new Error("快照里没有 reasoning 可用于变异");
const describe = (list: Msg[]) => list.map(m =>
  `${m.role}${m.reasoning?.length ? "[rs]" : ""}`).join(" ");

const govCtx = await resolveAIGovernanceContext(workspaceId, userId);
const textRes = resolveProviderForTask(govCtx, "companion_agent");

async function probe(label: string, list: Msg[]): Promise<void> {
  const provider = createProvider(textRes.providerName,
    { ...textRes.providerConfig, sessionId: runId }) as AIProvider & AgentCapable;
  (provider as unknown as { reasoningField: (d: boolean) => Record<string, unknown> }).reasoningField =
    () => ({ reasoning: { effort: "high" } });
  console.log(`[${label}] shape:`, describe(list));
  try {
    const r = await provider.executeAgentTurn({
      systemPrompt, messages: list, tools, toolChoice: "auto", model: undefined,
    }) as { content: string | null };
    console.log(`[${label}] OK:`, JSON.stringify(r.content).slice(0, 60));
  } catch (err) {
    const e = err as { code?: string; providerCode?: string };
    console.log(`[${label}] FAILED`, e.code, e.providerCode);
  }
}

await probe("V0 baseline", rest);
// V1：去掉末尾**缺 rs** 的 assistant（从后往前，遇到带 rs 的停）。
const v1: Msg[] = [];
for (let i = 0; i < rest.length; i += 1) {
  const m = rest[i]!;
  const isTrailingAssistantWithoutRs = m.role === "assistant" && !m.reasoning?.length
    && rest.slice(i + 1).every(next => next.role === "assistant");
  if (isTrailingAssistantWithoutRs) continue;
  v1.push(m);
}
await probe("V1 drop trailing assistants w/o rs", v1);
// V2：所有 assistant 都挂上同一条 rs。
await probe("V2 all assistants carry rs",
  rest.map(m => m.role === "assistant" ? { ...m, reasoning: [rsSource] } : m));
// V3：只留最后一条 assistant。
const lastAssistantIndex = rest.map((m, i) => ({ m, i })).filter(x => x.m.role === "assistant").at(-1)!.i;
await probe("V3 only last assistant",
  rest.filter((_, i) => i === lastAssistantIndex || rest[i]!.role !== "assistant"));
