/**
 * 一次性诊断（2026-10-14）：把失败那一轮**已经存下来**的原文原样重放一次，拿网关的错误体。
 *
 * 为什么必须重放：`jobs.last_error` 只留 category/name/code，`ai_audit_log.error_message`
 * 只到 `operational_error:provider:Error`——400 到底说哪一句非法，库里一条都不剩
 * （这也正是同一天在 `provider-request-error.ts` 里补 code 的原因）。失败请求的
 * `modelMessages` 恰好在交接快照里，逐字重放就是最省的取证路径。
 *
 * 跑法（容器里有 env 与依赖）：
 *   docker exec astella-dev-worker-1 ./node_modules/.bin/tsx scripts/replay-provider-400.ts <runId>
 */
import postgres from "postgres";

import { createProvider } from "../src/lib/ai-provider.ts";
import { resolveAllCompanionAgentTools } from "@astella/shared/companion-agent-registry";
import { createGovernedProvider, resolveAIGovernanceContext, resolveProviderForTask } from "../src/lib/governance.ts";

const runId = process.argv[2];
if (!runId) throw new Error("用法：replay-provider-400.ts <runId>");

// 读用超户串：这一条只做取证，worker 角色在裸连接上没有 app.* 会话变量，
// RLS 会把行全部挡掉（现象是"run 不在库里"而不是报权限错）。
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
try {
  const [run] = await sql<{ workspace_id: string; user_id: string; created_at: Date }[]>`
    SELECT workspace_id, user_id, created_at FROM companion_turn_runs WHERE id = ${runId}`;
  if (!run) throw new Error(`run ${runId} 不在库里`);
  const [snap] = await sql<{ snapshot: unknown }[]>`
    SELECT snapshot FROM companion_context_handoff_snapshots WHERE run_id = ${runId}`;
  if (!snap) throw new Error("这个 run 没有交接快照，拿不到当时的原文");
  const messages = (snap.snapshot as { modelMessages?: unknown }).modelMessages;
  if (!Array.isArray(messages) || messages.length < 2) throw new Error("modelMessages 不可用");
  console.log(`[replay] run=${runId} messages=${messages.length} when=${run.created_at.toISOString()}`);

  const govCtx = await resolveAIGovernanceContext(run.workspace_id, run.user_id);
  if (!govCtx.consentOk) throw new Error("account has no AI consent");
  const textRes = resolveProviderForTask(govCtx, "companion_agent");
  const provider = createGovernedProvider(
    createProvider(textRes.providerName, textRes.providerConfig),
    govCtx,
    run.workspace_id,
    { userId: run.user_id, operation: "companion_summarizer" },
  );
  console.log(`[replay] provider=${textRes.providerName} model=${provider.modelId}`);

  try {
    const result = await provider.chatCompletion(messages as never, { responseFormat: "text", maxTokens: 64 });
    console.log("[replay] OK（内容这一步不 400）:", JSON.stringify(result.content).slice(0, 200));
  } catch (err) {
    const error = err as { code?: string; providerCode?: string; message?: string; detail?: unknown };
    console.log("[replay] FAILED");
    console.log("  code:", error.code);
    console.log("  providerCode:", error.providerCode);
    console.log("  message:", error.message);
    console.log("  detail:", String(JSON.stringify(error.detail) ?? "n/a").slice(0, 1200));
    console.log("  raw:", String(error).slice(0, 1200));
  }

  // 第二发：走失败那一轮真正走的那条路（execute_agent_turn），先不带工具，
  // 用来区分「这些原文本身就不合法」与「tools/步骤那一层不合法」。
  // 治理包装层不一定暴露 agent 那一口，所以这里直接用原始 provider。
  const raw = createProvider(textRes.providerName, textRes.providerConfig);
  console.log("[replay] raw.executeAgentTurn:", typeof raw.executeAgentTurn);
  if (typeof raw.executeAgentTurn === "function") {
    try {
      const [system, ...rest] = messages as Array<{ role: string; content: unknown }>;
      const turn = await raw.executeAgentTurn({
        systemPrompt: typeof system?.content === "string" ? system.content : "",
        messages: rest as never,
        tools: [],
        model: raw.modelId,
      } as never);
      console.log("[replay:agent,tools=0] OK:", JSON.stringify(turn.content).slice(0, 160));
    } catch (err) {
      const error = err as { code?: string; providerCode?: string; message?: string; detail?: unknown };
      console.log("[replay:agent,tools=0] FAILED");
      console.log("  code:", error.code);
      console.log("  providerCode:", error.providerCode);
      console.log("  message:", error.message);
      console.log("  detail:", String(JSON.stringify(error.detail) ?? "n/a").slice(0, 1500)); // detail 缺席时 JSON.stringify 返回 undefined，直接 .slice 会把诊断脚本打崩
      console.log("  raw:", String(error).slice(0, 800));
    }

    // 第三发：把声明那一整份工具面带上（失败的那几轮都是 toolUse=uncertain，
    // 工具是发下去的）。这一步真 400 时，stderr 里会有 logOpenCodeRejection 留下的
    // 网关原话——那正是平时丢失、只能靠重放猜的那句话。
    const tools = resolveAllCompanionAgentTools("full", { visionEnabled: true, webSearchEnabled: true }) as never;
    console.log(`[replay] tools=${(tools as unknown[]).length}`);
    try {
      const [system, ...rest] = messages as Array<{ role: string; content: unknown }>;
      const turn = await raw.executeAgentTurn({
        systemPrompt: typeof system?.content === "string" ? system.content : "",
        messages: rest as never,
        tools,
        model: raw.modelId,
      } as never);
      console.log("[replay:agent,tools=full] OK:", JSON.stringify(turn.content).slice(0, 160));
    } catch (err) {
      const error = err as { code?: string; providerCode?: string; message?: string; detail?: unknown };
      console.log("[replay:agent,tools=full] FAILED");
      console.log("  code:", error.code);
      console.log("  providerCode:", error.providerCode);
      console.log("  message:", error.message);
      console.log("  detail:", String(JSON.stringify(error.detail) ?? "n/a").slice(0, 1500)); // detail 缺席时 JSON.stringify 返回 undefined，直接 .slice 会把诊断脚本打崩
      console.log("  raw:", String(error).slice(0, 800));
    }

    // 第四发：同样的工具面，只把思考关掉——验证「历史里没有 reasoning 句柄时，
    // 思考模式这一步就会被网关拦下」这条假设，也是候选修法（关思考或回传句柄）。
    if (typeof raw.executeAgentTurn === "function") {
      try {
        const [system, ...rest] = messages as Array<{ role: string; content: unknown }>;
        const turn = await raw.executeAgentTurn({
          systemPrompt: typeof system?.content === "string" ? system.content : "",
          messages: rest as never,
          tools,
          model: raw.modelId,
          disableThinking: true,
        } as never);
        console.log("[replay:agent,tools=full,thinking=off] OK:", JSON.stringify(turn.content).slice(0, 140));
      } catch (err) {
        const error = err as { code?: string; providerCode?: string; message?: string };
        console.log("[replay:agent,tools=full,thinking=off] FAILED", error.code, error.providerCode, error.message);
      }
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
