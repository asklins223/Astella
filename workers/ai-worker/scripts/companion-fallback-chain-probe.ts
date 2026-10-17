/**
 * 「换模型重说」那条降级链的真机验证（2026-10-16）。
 *
 * 判据（`companion-answer-repair.ts`）一直写着"换**另一个模型**把这一步重跑一次"，
 * 但降级要用的 `companion_fallback` 槽在生产配置里根本不存在：
 * `governance.companionFallbackProviderName` 为空 → `fallbackProvider` undefined →
 * `canRepair` false → 一次调用都不花，也一次都不会降级。所以这条链此前是零执行。
 *
 * 这个探针在**容器内**跑，用的是那份环境的真实 `config/ai-platforms.json` + `production.env`：
 *   ① 列出两个槽按现有档案各自解析到哪个平台/模型（配错、缺 key 都在这里红）；
 *   ② 用主档的模型 id 配一段真退化形态的正文，走**现役的修复阶梯**，
 *      第二轮由兜底模型真出声——打印由哪个模型答、耗时、token（代价）；
 *   ③ 反面对照：把兜底槽撤掉，同一份输入必须一次调用都不花。
 *
 *   docker cp scripts/companion-fallback-chain-probe.ts astella-dev-worker-1:/app/scripts/
 *   docker exec -w /app astella-dev-worker-1 ./node_modules/.bin/tsx \
 *     scripts/companion-fallback-chain-probe.ts <workspaceId> <userId>
 */
import { resolveSystemPlatform } from "@astella/shared/platform-config-node";
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";
import { createProvider } from "../src/lib/ai-provider.ts";
import { resolveAIGovernanceContext, resolveProviderForTask } from "../src/lib/governance.ts";
import { repairDegenerateCompanionAnswer } from "../src/handlers/agent/companion-answer-repair.ts";
import { looksTruncatedReply } from "../src/handlers/turn/companion-dialogue-content.ts";
import type { AIProvider } from "../src/lib/ai-provider.ts";

const [workspaceId, userId] = process.argv.slice(2);
if (!workspaceId || !userId) throw new Error("用法：companion-fallback-chain-probe.ts <workspaceId> <userId>");

let failed = false;
const fail = (line: string) => { failed = true; console.log(`[fallback] FAIL ${line}`); };

// ── ① 档案解析 ───────────────────────────────────────────────────────
const primarySlot = resolveSystemPlatform("agent_turn");
const fallbackSlot = resolveSystemPlatform("companion_fallback");
console.log(`[fallback] agent_turn       = ${primarySlot?.type}/${primarySlot?.model}`);
console.log(`[fallback] companion_fallback= ${fallbackSlot?.type}/${fallbackSlot?.model}`);
if (!fallbackSlot) fail("companion_fallback 槽没配——降级链在这份配置里仍然是死的");
if (fallbackSlot && primarySlot && fallbackSlot.model === primarySlot.model) {
  fail("兜底槽和主档是同一个模型，重说一遍换不来任何东西");
}

const gov = await resolveAIGovernanceContext(workspaceId, userId);
console.log(`[fallback] governance: agent=${gov.providerName} fallback=${gov.companionFallbackProviderName ?? "(无)"} text=${gov.textProviderName}`);
if (!gov.companionFallbackProviderName || !gov.companionFallbackProviderConfig) fail("governance 没把兜底槽透出来");

// 主槽用现役解析（含思考档等档案项），兜底槽按 governance 给的 name/config 建——
// 与 `companion-turn-providers.ts` 的 `fallbackProvider` 同一构造路径。
const main = resolveProviderForTask(gov, "companion_agent");
const primaryProvider = createProvider(main.providerName, main.providerConfig as never);
const fallbackProvider = gov.companionFallbackProviderName && gov.companionFallbackProviderConfig
  ? createProvider(gov.companionFallbackProviderName, gov.companionFallbackProviderConfig as never)
  : undefined;
console.log(`[fallback] providers built: primary=${primaryProvider.modelId} fallback=${fallbackProvider?.modelId ?? "(无)"}`);

const DEGENERATE = "今天已经学了1";   // 实机退化形态：句子说了一半
const USER_TEXT = "我今天学了多久？只回一句短话，不要用省略号。";

function repairInput(provider: AIProvider | undefined, calls: string[]) {
  const stepRequest = { role: "companion_agent", systemPrompt: "只回一句短话。",
    messages: [{ role: "user", content: USER_TEXT }], tools: [], maxTokens: 128,
    temperature: 0.3 } as unknown as AgentTurnRequest;
  const result = { content: DEGENERATE, toolCalls: [], finishReason: "stop", usage: null,
    providerRequestId: null, providerModelIds: [provider?.modelId ?? primaryProvider.modelId] } as unknown as AgentTurnResult;
  return {
    result, calls: [], stepRequest, stepEmitted: false, alreadyRetried: false,
    deadlineAt: Date.now() + 60_000, stepCount: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    fallbackProvider: provider, ctxSignal: new AbortController().signal,
    isTruncated: looksTruncatedReply,
    invokeProvider: async ({ provider: rung, request, signal }: { provider: AIProvider; request: AgentTurnRequest; signal: AbortSignal }) => {
      calls.push(rung.modelId);
      const started = Date.now();
      const out = await (rung.executeAgentTurn!(request, signal) as Promise<AgentTurnResult>);
      console.log(`[fallback]   第二轮由 ${rung.modelId} 作答 ${Date.now() - started}ms`);
      return out;
    },
  };
}

if (!looksTruncatedReply(DEGENERATE)) fail("探针前提不成立：这段样例没被判成退化，走不到修复阶梯");

// ── ② 降级真的发生：第二轮由另一个模型作答 ──────────────────────────
const swapCalls: string[] = [];
const startedSwap = Date.now();
const swapped = await repairDegenerateCompanionAnswer(repairInput(fallbackProvider, swapCalls));
const swapMs = Date.now() - startedSwap;
console.log(`[fallback] 降级：retried=${swapped.retried} 调用=[${swapCalls}] ${swapMs}ms 正文=「${swapped.result.content}」`);
if (!swapped.retried) fail("退化正文没有走修复阶梯");
if (swapCalls.length !== 1) fail(`修复阶梯应该只多花一次调用，实际 ${swapCalls.length} 次`);
if (!fallbackProvider) fail("兜底 provider 没建出来却走到了调用分支");
else if (swapCalls[0] !== fallbackProvider.modelId) fail(`第二轮不是兜底档：${swapCalls[0]}`);
else if (swapped.result.content === DEGENERATE) fail("交付用的还是那句退化正文，第二轮的结果没被采纳");

// ── ③ 反面对照：撤掉兜底槽，一次调用都不该花 ───────────────────────
const controlCalls: string[] = [];
const startedControl = Date.now();
const control = await repairDegenerateCompanionAnswer(repairInput(undefined, controlCalls));
console.log(`[fallback] 对照（无兜底槽）：retried=${control.retried} 调用=[${controlCalls}] ${Date.now() - startedControl}ms 正文=「${control.result.content}」`);
if (control.retried || controlCalls.length !== 0) fail("撤掉兜底槽后仍然重跑了，对照失效");
if (control.result.content !== DEGENERATE) fail("对照里那句退化正文被换掉了");

console.log(`[fallback] 代价：多一次模型调用 ${swapMs}ms（主档 ${primaryProvider.modelId} → 兜底 ${fallbackProvider?.modelId ?? "-"}）`);
console.log(failed ? "[fallback] FAIL：降级链仍未真跑通" : "[fallback] PASS：兜底槽解析、第二轮换模型真出声、无槽时零调用都对上了");
if (failed) process.exit(1);
