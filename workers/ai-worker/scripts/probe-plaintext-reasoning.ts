/**
 * 取证脚本（2026-10-14）：**网关在思考模式下要的是 `reasoning_text` 明文**。
 *
 * 这一发是 0435（`companion_messages.reasoning`）与"不再剥离明文思维链"那条
 * 用户决定的直接依据。它跑在真网关上，不是模拟。
 *
 * ## 完整实验矩阵（同一份 dac3bacd 原文，逐条实测）
 *
 * 触发条件不是"以 assistant 收尾"，而是「最后一条 **user/assistant** 消息是
 * **正文非空的 assistant**」。逐条：
 *
 * | 形状（思考开 + 带工具） | 结果 |
 * |---|---|
 * | 以 user 收尾 | 过 |
 * | 以 tool 回执收尾（工具循环续跑） | 过 |
 * | assistant 收尾、正文为空 | 过 |
 * | assistant 收尾、正文非空 | **400** |
 * | assistant 收尾、正文非空 + 尾部 hostObservation system | **400**（生产的精确形状） |
 *
 * 网关把最后一种当成"上一轮没说完要接着写"，于是要求交回那条的 `reasoning_text`。
 * 尾部追加 system 观察救不了它——网关只看 user/assistant。
 *
 * 回传内容的三发对照（本脚本的 Q2/Q3/Q4，全部上述 400 形状）：
 *
 * | 回传内容 | 结果 |
 * |---|---|
 * | `reasoning` 带 `content[].reasoning_text` **明文** | 过 |
 * | 只带 `encrypted_content`（不带明文） | **400** |
 * | 完全不带 reasoning | **400** |
 *
 * 结论：明文是唯一能过的东西，而 `readResponsesReasoningHandles` 恰恰在产出时
 * 把它删掉——剥掉之后再也凑不回来。主动参与轮每一轮都是这个形状，于是思考档位
 * 为开的主动轮全灭（库里 43 条主动轮：思考关的全成，思考开的 10-13 12:45 之后全死）。
 *
 * 顺带分清一个容易搞混的点：**工具循环续跑不需要明文**（`companion_agent_tool_calls`
 * 现存 243 行 encrypted 句柄够用），所以那张表的存量不受影响。
 *
 * ## 跑法
 *
 *   docker cp scripts/probe-plaintext-reasoning.ts astella-dev-worker-1:/app/scripts/
 *   docker exec astella-dev-worker-1 ./node_modules/.bin/tsx \
 *     scripts/probe-plaintext-reasoning.ts <workspaceId> <userId>
 */
import { createProvider } from "../src/lib/ai-provider.ts";
import { resolveAllCompanionAgentTools } from "@astella/shared/companion-agent-registry";
import { resolveAIGovernanceContext, resolveProviderForTask } from "../src/lib/governance.ts";
import type { AIProvider } from "../src/lib/ai-provider.ts";

const workspaceId = process.argv[2];
const userId = process.argv[3];
if (!workspaceId || !userId) throw new Error("用法：probe-plaintext-reasoning.ts <workspaceId> <userId>");

const tools = resolveAllCompanionAgentTools("full", { visionEnabled: true, webSearchEnabled: true }) as never;
const govCtx = await resolveAIGovernanceContext(workspaceId, userId);
if (!govCtx.consentOk) throw new Error("account has no AI consent");
const textRes = resolveProviderForTask(govCtx, "companion_agent");

/** 思考钉死为开：`reasoningField` 是私有方法，运行期覆盖它，守卫的降级就不生效。 */
function thinkingOn(sessionId: string): AIProvider {
  const provider = createProvider(textRes.providerName, { ...textRes.providerConfig, sessionId });
  (provider as unknown as { reasoningField: (d: boolean) => Record<string, unknown> }).reasoningField =
    () => ({ reasoning: { effort: "high" } });
  return provider;
}

type RawBody = { output?: Array<Record<string, unknown>> } | null;
type Probed = { content: string | null };
/** `executeAgentTurn` 在 AIProvider 上是可选的；本脚本假定 opencode-go 实现了它。 */
type AgentCapable = { executeAgentTurn(request: unknown): Promise<unknown> };

const SYSTEM = "你是伴星。回答保持一两句。";

// Q1：钩住 request，取**不剥明文**的 reasoning item。
const provider = thinkingOn("probe-plain") as AIProvider & AgentCapable;
const hooked = provider as unknown as {
  endpoint: string;
  headers: (stream: boolean) => Record<string, string>;
  request: (e: string, h: Record<string, string>, b: unknown) => Promise<{ status: number; body: RawBody }>;
};
// 在回调里赋值的变量会被 TS 窄化成 null，用显式断言标注它的真实形态。
let captured: RawBody = undefined as unknown as RawBody;
const original = hooked.request.bind(hooked);
hooked.request = async (e, h, b) => { const r = await original(e, h, b); captured = r.body; return r; };

const seeded = await provider.executeAgentTurn({
  systemPrompt: SYSTEM, messages: [{ role: "user", content: "用一句话打个招呼。" }],
  tools: [], model: undefined,
}) as Probed;
console.log("[Q1] content:", JSON.stringify(seeded.content).slice(0, 70));

const capturedItems: Array<Record<string, unknown>> = captured?.output ?? [];
const rawReasoning = capturedItems.find((item: Record<string, unknown>) => item.type === "reasoning") ?? null;
if (!rawReasoning) throw new Error("Q1 没拿到 reasoning item");
console.log("[Q1] raw reasoning item keys:", Object.keys(rawReasoning).join(","));
console.log("[Q1] raw reasoning item:", JSON.stringify(rawReasoning).slice(0, 400));

const withoutPlaintext = Object.fromEntries(
  Object.entries(rawReasoning).filter(([key]) => key !== "content"));

async function probe(label: string, reasoning: unknown): Promise<void> {
  const tail: Record<string, unknown>[] = [{ role: "user", content: "用一句话打个招呼。" }];
  const assistant: Record<string, unknown> = { role: "assistant", content: seeded.content ?? "" };
  if (reasoning) assistant.reasoning = [reasoning];
  tail.push(assistant);
  try {
    const round = thinkingOn("probe-plain") as AIProvider & AgentCapable;
    const r = await round.executeAgentTurn({
      systemPrompt: SYSTEM, messages: tail, tools, toolChoice: "auto", model: undefined,
    }) as Probed;
    console.log(`[${label}] OK:`, JSON.stringify(r.content).slice(0, 80));
  } catch (err) {
    const e = err as { code?: string; providerCode?: string };
    console.log(`[${label}] FAILED`, e.code, e.providerCode);
  }
}

// Q2 带明文回传（判据）；Q3 只带 encrypted_content（对照）；Q4 完全不带（对照）。
await probe("Q2 reasoning WITH plaintext", rawReasoning);
await probe("Q3 reasoning encrypted-only", withoutPlaintext);
await probe("Q4 no reasoning at all", null);
