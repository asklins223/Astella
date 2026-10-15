/**
 * 主/副模型互换的验证（2026-10-15）。
 *
 * 当前主/文本槽均为 MiMo Responses / mimo-v2.6-flash，无独立备用槽。
 * 验证解析、工厂和真实调用；任一真实请求失败即返回非零。
 *
 *   docker cp scripts/verify-model-swap.ts astella-dev-worker-1:/app/scripts/
 *   docker exec astella-dev-worker-1 ./node_modules/.bin/tsx \
 *     scripts/verify-model-swap.ts <workspaceId> <userId>
 */
import { resolveSystemPlatform } from "@astella/shared/platform-config-node";
import { createProvider } from "../src/lib/ai-provider.ts";
import { resolveAIGovernanceContext, resolveProviderForTask } from "../src/lib/governance.ts";
import type { AIProvider } from "../src/lib/ai-provider.ts";

const [workspaceId, userId] = process.argv.slice(2);
if (!workspaceId || !userId) throw new Error("用法：verify-model-swap.ts <workspaceId> <userId>");

const expect: Record<string, { platform: string; type: string; model: string }> = {
  agent_turn: { platform: "mimo-agent", type: "mimo_responses", model: "mimo-v2.6-flash" },
  text_generation: { platform: "mimo-agent", type: "mimo_responses", model: "mimo-v2.6-flash" },
};
let failed = false;
if (resolveSystemPlatform("companion_fallback")) throw new Error("MiMo-only configuration must not contain a fallback slot");

// ── ① 解析层 ─────────────────────────────────────────────────────────
for (const [cap, want] of Object.entries(expect)) {
  const resolved = resolveSystemPlatform(cap as never);
  if (!resolved) { console.log(`[swap] FAIL ${cap}: 解析为 null（缺 key 或配置未生效）`); failed = true; continue; }
  const platformId = (resolved as unknown as { platformId?: string }).platformId ?? "(none)";
  const ok = resolved.model === want.model && resolved.type === want.type && platformId === want.platform;
  console.log(`[swap] ${cap}: type=${resolved.type} model=${resolved.model} platformId=${platformId} ${ok ? "OK" : "≠ 期望 " + JSON.stringify(want)}`);
  if (!ok) failed = true;
}

// ── ② 能力闸（工厂注册 + 形状）与 ③ 真调用 ──────────────────────────
const govCtx = await resolveAIGovernanceContext(workspaceId, userId);
console.log("[swap] governance: agent=", govCtx.providerName, " text=", govCtx.textProviderName,
  " fallback=", govCtx.companionFallbackProviderName);

async function probeSlot(label: string, providerName: string, config: unknown): Promise<void> {
  let provider: AIProvider;
  try {
    provider = createProvider(providerName, config as never);
  } catch (err) {
    // 这一类错误＝接线错了，必须红。
    console.log(`[swap] FAIL ${label}: createProvider 抛错 —`, (err as Error).message);
    failed = true;
    return;
  }
  console.log(`[swap] ${label}: createProvider OK modelId=${provider.modelId}`,
    `executeAgentTurn=${typeof provider.executeAgentTurn}`,
    `chatCompletion=${typeof provider.chatCompletion}`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  const started = Date.now();
  try {
    const r = await (label === "主 agent_turn"
      ? provider.executeAgentTurn?.({
          role: "companion_agent", systemPrompt: "只回复：好", messages: [{ role: "user", content: "在吗" }] as never,
          tools: [], maxTokens: 32, temperature: 0.2,
        }, ctrl.signal)
      : provider.chatCompletion?.([{ role: "user", content: "只回复：好" }] as never,
          { responseFormat: "text", maxTokens: 32 }, ctrl.signal));
    console.log(`[swap] ${label} 调用 OK ${Date.now() - started}ms:`,
      JSON.stringify((r as { content?: unknown } | undefined)?.content ?? r).slice(0, 60));
  } catch (err) {
    const e = err as { name?: string; message?: string; code?: string; providerCode?: string };
    const msg = `${e.name ?? ""} ${e.message ?? ""}`;
    // 接线、网络和上游错误均为验收失败。
    const wiring = /not configured|未注册|does not exist|Cannot read/.test(msg);
    console.log(`[swap] ${label} 调用 ${Date.now() - started}ms ${wiring ? "FAIL(接线)" : "FAIL(上游)"}:`,
      e.code ?? "", msg.slice(0, 110));
    failed = true;
  } finally { clearTimeout(timer); }
}

const agent = resolveProviderForTask(govCtx, "companion_agent");
// `analyze_image` 是 TASK_CAPABILITY_MAP 里**唯一**映射到 text_generation 的任务
// （注释明写该槽"当前无任务分配至此"，已过时）；用别的任务名会落到复杂度兜底、
// 返回主模型，测出来的就不是副槽了 —— 第一版探针正是这样误判的。
const text = resolveProviderForTask(govCtx, "analyze_image");
await probeSlot("主 agent_turn", agent.providerName, agent.providerConfig);
await probeSlot("副 text_generation", text.providerName, text.providerConfig);

console.log(failed ? "[swap] FAIL：有接线问题" : "[swap] PASS：两个槽位解析与能力闸都正确");
if (failed) process.exit(1);
