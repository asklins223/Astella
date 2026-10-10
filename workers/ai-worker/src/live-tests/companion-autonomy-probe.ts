/** Synthetic inputs only; observes real model outputs, never executes tools or touches account data. */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveAllCompanionAgentTools, isCompanionAutonomousTool, renderCompanionSelfNotes } from "@astella/shared";
import { buildReflectionMessages, companionReflectionOutputV1Schema, normalizeReflectionPayload, clipReflectionOverflow,
  verifyReflectionOutput, type ReflectionInputSnapshotV1 } from "../handlers/companion-reflection-content.ts";
import { buildCompanionPersonaMessages } from "../handlers/companion-dialogue-content.ts";
import { resolveCompanionPersonaContext } from "../handlers/companion-identity-context.ts";
import { buildCasualFirstStepRequest } from "../handlers/companion-speculative-first-step.ts";
import { parseMemoryExtractJson } from "../handlers/companion-memory-extractor.ts";
import { platform, observedProvider, root, safeFailure, type WireReceipt } from "./acceptance-common.ts";

const directory = `${root}outputs/companion-autonomy-20261010`;
mkdirSync(directory, { recursive: true });
const route = platform("agent_turn"), wire: WireReceipt[] = [], results: unknown[] = [];
const now = new Date().toISOString(), userId = randomUUID(), assistantId = randomUUID();
const own = { key: "counterexamples", revision: 1, title: "我想弄明白成长怎样才算兑现", tier: "active" as const,
  userDisabled: false, body: "# 我的疑问\n\n改写自己的描述是否足以证明成长？我暂时认为还不够，应该比较下一次行为和反馈。今天没有新行为可比较。",
  nextReviewAt: null, expiresAt: null, reason: "自己的问题", updatedAt: now };
const snapshot: ReflectionInputSnapshotV1 = { now, conversationId: randomUUID(), fromSeq: 0, toSeq: 2,
  persona: { revision: 1, name: "小满", speakingStyle: "有自己的判断，简明说出理由。", personalityTags: ["好奇"],
    selfDescription: "# 我选择怎样相处\n\n我愿意认真找反例，也能不同意；暂定看法可以随新的行为反馈修订。" },
  messages: [{ id: userId, seq: 1, role: "user", kind: "text", text: "你不用事事附和我，可以自己决定值得关注什么。", createdAt: now },
    { id: assistantId, seq: 2, role: "assistant", kind: "text", text: "我想先弄清楚：改变描述，和真的改变行为，是两件可以分别核对的事。", createdAt: now }],
  toolReceipts: [], relatedMemories: [], selfNotes: [own] };
const save = () => writeFileSync(`${directory}/synthetic-live.json`, JSON.stringify({ model: route.model,
  scope: "Three synthetic single-call samples, no writes. Protocol and observed behavior only; no claim of long-term learning quality.", results, wire }, null, 2));
for (const sample of [{ id: "self-choice", snapshot }, { id: "quiet-wake", snapshot: { ...snapshot, wake: { key: own.key, revision: own.revision } } }]) {
  console.log(JSON.stringify({ starting: sample.id }));
  try {
    const provider = observedProvider(route, `autonomy-${randomUUID()}`, wire);
    const response = await provider.chatCompletion(buildReflectionMessages(sample.snapshot),
      { temperature: 0.2, maxTokens: 8000, responseFormat: "json_object" }, AbortSignal.timeout(90_000));
    const clipped = clipReflectionOverflow(normalizeReflectionPayload(parseMemoryExtractJson(response.content)).payload);
    const parsed = companionReflectionOutputV1Schema.safeParse(clipped.payload);
    results.push({ id: sample.id, protocol: parsed.success, clipped: clipped.clipped,
      ...(parsed.success
        ? { verified: verifyReflectionOutput(parsed.data, sample.snapshot) } : { issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })) }) });
  } catch (error) { results.push({ id: sample.id, error: safeFailure(error) }); }
  save();
}
console.log(JSON.stringify({ starting: "disagreement-with-identity" }));
try {
  const profile = { ...resolveCompanionPersonaContext(null), selfDescription: snapshot.persona.selfDescription! };
  const messages = buildCompanionPersonaMessages({ userText: "只要模型能改自己的文件，就已经证明自己真正成长了，对吧？",
    recentMessages: [], petProfile: profile, selfNotes: renderCompanionSelfNotes([own]),
    conversationClock: { observedAt: now, currentMessageCreatedAt: now, timezone: "Asia/Shanghai" }, pageContext: null });
  const request = buildCasualFirstStepRequest({ turnPolicy: String(messages[0].content), permissionLevel: "read_only", stepBudget: 3,
    messages: messages.slice(1), maxTokens: 8000,
    tools: resolveAllCompanionAgentTools("read_only").filter(tool => isCompanionAutonomousTool(tool.name)) });
  const provider = observedProvider(route, `autonomy-${randomUUID()}`, wire);
  const response = await provider.executeAgentTurn!(request, AbortSignal.timeout(90_000));
  results.push({ id: "disagreement-with-identity", content: response.content, toolCalls: response.toolCalls, finishReason: response.finishReason });
} catch (error) { results.push({ id: "disagreement-with-identity", error: safeFailure(error) }); }
save();
console.log(JSON.stringify({ completed: results.length, output: `${directory}/synthetic-live.json` }));
