/** Synthetic speech-expression samples; no account history, private materials, or extra classifier. */
import { randomUUID } from "node:crypto";
import { readVoiceExpressionTags } from "@astella/shared/voice-expression-tags";
import { buildCompanionPersonaMessages, sanitizeCompanionVisibleText } from "../handlers/companion-dialogue-content.ts";
import { resolveCompanionPersonaContext } from "../handlers/companion-identity-context.ts";
import { buildCasualFirstStepRequest } from "../handlers/companion-speculative-first-step.ts";
import { runStreamingAgentStep } from "../handlers/companion-agent-streaming-step.ts";
import { platform, observedProvider, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";

const route = platform("agent_turn"), wire: WireReceipt[] = [], results: Array<Record<string, unknown>> = [];
const cases = [
  { id: "comfort", text: "我终于做到了，可现在只觉得累，不想庆祝。用温柔安慰的语气陪我说一句，不用建议。" },
  { id: "celebrate", text: "刚收到通过通知，终于过了！我好开心，你也替我高兴一下，就一句。" },
  { id: "explain", text: "认真解释一句：变量没有初始化为什么会出错？不用反问。" },
  { id: "giggle", text: "刚把伞撑开雨就停了，收起来它又下。陪我轻轻笑一下，再说一句就好。" },
];
for (const sample of cases) {
  console.log(JSON.stringify({ starting: sample.id }));
  const base = buildCompanionPersonaMessages({ userText: sample.text, recentMessages: [], pageContext: null,
    petProfile: resolveCompanionPersonaContext(null) });
  const request = buildCasualFirstStepRequest({ turnPolicy: String(base[0]!.content), permissionLevel: "read_only",
    stepBudget: 3, messages: base.slice(1), maxTokens: route.modelProfile?.maxOutputTokens ?? 131072 });
  try {
    const provider = observedProvider(route, `voice-expression-${randomUUID()}`, wire);
    const result = await runStreamingAgentStep({ provider, stepRequest: request, ctxSignal: AbortSignal.timeout(90000),
      timeoutMs: 90000, onProviderDelta: async () => true });
    const raw = String(result.content ?? "");
    const row = { id: sample.id, finishReason: result.finishReason, raw,
      visible: sanitizeCompanionVisibleText(raw), marks: readVoiceExpressionTags(raw).map(mark => ({ tag: mark.tag, kind: mark.kind })) };
    results.push(row); console.log(JSON.stringify(row));
  } catch (error) { results.push({ id: sample.id, error: safeFailure(error) }); }
  save("voice-expression", { model: route.model, results, wire });
}
