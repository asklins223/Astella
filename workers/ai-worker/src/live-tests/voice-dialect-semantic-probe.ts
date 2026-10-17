/** Synthetic multi-turn probe for the production structured voice-intent interpreter. */
import { randomUUID } from "node:crypto";
import { agentTurnInterpretationProposalV1Schema } from "@astella/shared/agent-contracts";
import { qwenDialectForInstruction } from "@astella/shared/tts-voice-catalog";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { resolveAgentTurnInterpretation } from "@astella/agent-core";
import { buildCompanionTurnInterpretationMessages } from "../handlers/tools/companion-tool-intent.ts";
import { resolveCompanionVoiceInstruction } from "../handlers/turn/companion-voice-request-style.ts";
import type { AIProvider } from "../lib/ai-provider.ts";
import { platform, observedProvider, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";

const route = platform("agent_turn");
const wire: WireReceipt[] = [];
const provider = observedProvider(route, `voice-dialect-semantic-${randomUUID()}`, wire);
const history: Array<{ role: "user" | "assistant"; text: string; seq: string }> = [];
const results: Array<Record<string, unknown>> = [];
let persistedDialect: string | null = null;
const cases = [
  { id: "context-seed", text: "我老家在河南，最近有点想家。", expected: "none", expectedAction: "keep", expectedEffectiveDialect: null },
  { id: "dialect-mentioned-only", text: "河南话里的‘中’一般是什么意思？", expected: "none", expectedAction: "keep", expectedEffectiveDialect: null },
  { id: "persist-henan", text: "以后你都用河南话跟我说。", expectedDialect: "河南话", expectedAction: "set", expectedEffectiveDialect: "河南话" },
  { id: "temporary-sichuan", text: "这句话临时用四川话说。", expectedDialect: "四川话", expectedAction: "keep", expectedEffectiveDialect: "四川话" },
  { id: "return-to-henan", text: "好，晚安。", expected: "none", expectedAction: "keep", expectedEffectiveDialect: "河南话" },
  { id: "reset-mandarin", text: "以后请都用普通话跟我说。", expected: "apply", expectedAction: "clear", expectedEffectiveDialect: null },
  { id: "stay-mandarin", text: "再说一句晚安。", expected: "none", expectedAction: "keep", expectedEffectiveDialect: null },
] as const;

for (const sample of cases) {
  console.log(JSON.stringify({ starting: sample.id }));
  const messages = [
    ...history.map(message => ({ role: message.role, content: message.text })),
    { role: "user" as const, content: sample.text },
  ];
  const promptMessages = buildCompanionTurnInterpretationMessages(messages, {
    objects: [], capabilities: [], recentMessages: history,
  });
  if (!promptMessages) throw new Error(`No semantic classifier input for ${sample.id}`);
  try {
    const answer = await (provider as AIProvider).chatCompletion(promptMessages, {
      temperature: 0,
      responseFormat: "json_object",
      disableThinking: true,
    }, AbortSignal.timeout(90000));
    const parsed = agentTurnInterpretationProposalV1Schema.safeParse(JSON.parse(answer.content));
    if (!parsed.success) throw new Error("semantic classifier output did not satisfy its structured contract");
    const interpretation = resolveAgentTurnInterpretation(parsed.data, {
      requestHash: sha256Utf8V1(sample.text), objects: [], capabilities: [], offerCandidates: [],
    });
    const resolved = resolveCompanionVoiceInstruction(sample.text, interpretation.voiceStyle);
    const preference = interpretation.voiceStyle.persistentPreference;
    if (preference.action === "set") persistedDialect = preference.dialect;
    if (preference.action === "clear") persistedDialect = null;
    const effectiveTtsDialect = qwenDialectForInstruction(resolved.instruction) ?? persistedDialect;
    const row = {
      id: sample.id,
      decision: interpretation.voiceStyle.decision,
      instruction: interpretation.voiceStyle.instruction,
      preferenceAction: preference.action,
      preferenceDialect: preference.dialect,
      effectiveTtsDialect,
      instructionSource: resolved.source,
      dialect: qwenDialectForInstruction(resolved.instruction),
      expectedEffectiveDialect: sample.expectedEffectiveDialect,
      expectedPreferenceAction: sample.expectedAction,
      ...( "expectedDialect" in sample ? { expectedDialect: sample.expectedDialect } : {}),
      ...( "expected" in sample ? { expectedDecision: sample.expected } : {}),
    };
    results.push(row);
    history.push({ role: "user", text: sample.text, seq: String(history.length + 1) });
    const syntheticReply = sample.id === "context-seed"
      ? "听起来你最近有点想家。你老家在河南，对吧？"
      : sample.id === "dialect-mentioned-only"
        ? "‘中’在河南话里一般是行、可以的意思。"
        : sample.id === "persist-henan"
        ? "好，以后默认用河南话。"
        : sample.id === "temporary-sichuan"
          ? "这句话用四川话说。"
          : sample.id === "return-to-henan"
            ? "晚安，明天见。"
            : sample.id === "reset-mandarin"
              ? "好，后面改用普通话。"
              : "晚安，明天见。";
    history.push({ role: "assistant", text: syntheticReply, seq: String(history.length + 1) });
    console.log(JSON.stringify(row));
  } catch (error) {
    const row = { id: sample.id, error: safeFailure(error) };
    results.push(row);
    history.push({ role: "user", text: sample.text, seq: String(history.length + 1) });
    history.push({ role: "assistant", text: "", seq: String(history.length + 1) });
    console.log(JSON.stringify(row));
  }
  save(process.env.LIVE_PROBE_NAME ?? "voice-dialect-semantic-classifier-20261013", {
    model: route.model,
    note: "Synthetic multi-turn classifier probe using the production prompt builder; no private history.",
    results,
    wire,
  });
}

const passed = cases.every((sample, index) => {
  const result = results[index];
  if (!result || "error" in result) return false;
  const preferenceOk = result.preferenceAction === sample.expectedAction;
  const effectiveOk = result.effectiveTtsDialect === sample.expectedEffectiveDialect;
  const directionOk = "expectedDialect" in sample
    ? result.decision === "apply" && result.dialect === sample.expectedDialect && result.instructionSource === "semantic"
    : result.decision === sample.expected && result.dialect === null;
  return preferenceOk && effectiveOk && directionOk;
});
console.log(JSON.stringify({ ok: passed, model: route.model, cases: results.length,
  decisions: results.map(result => result.decision ?? "error"),
  preferenceActions: results.map(result => result.preferenceAction ?? "error"),
  effectiveDialectSequence: results.map(result => result.effectiveTtsDialect ?? null) }));
if (!passed) process.exitCode = 1;
