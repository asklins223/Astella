import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dialogueCases, dialogueGenerationFixture } from "./dialogue-cases.ts";
import { buildDialogueExperimentRequest, buildDialogueIdentityDiagnostic, buildDialogueThinkingDiagnostic, snapshotDialogueRequest, snapshotDialogueWireBody } from "./dialogue-experiment.ts";
import { observedProvider, platform, loadPlatformConfig, save, safeFailure, outputDir, type WireReceipt } from "./acceptance-common.ts";
import { resolveDialogueCandidate } from "./dialogue-candidate.ts";
import { runStreamingAgentStep } from "../handlers/companion-agent-streaming-step.ts";
import { finalizeCompanionReplyText, validateCompanionOutput, sanitizeCompanionVisibleText } from "../handlers/companion-dialogue-content.ts";

const suffix = process.env.LIVE_DIALOGUE_ABLATION_SUFFIX;
if (!suffix || !/^[a-z0-9-]{1,40}$/.test(suffix)) throw new Error("Explicit unique ablation suffix required");
const kind = process.env.LIVE_DIALOGUE_ABLATION_KIND ?? "examples";
if (!["examples", "identity", "thinking", "temperature", "activeness", "contextual", "light-thinking"].includes(kind)) throw new Error("Invalid ablation kind");
const name = `dialogue-${kind === "identity" ? "identity-diagnostic" : kind === "examples" ? "persona-ablation" : `${kind}-ablation`}-${suffix}`;
if (existsSync(`${outputDir}/${name}.json`)) throw new Error("Refusing to overwrite ablation");
const selected = (process.env.LIVE_DIALOGUE_CASES ?? "resume,piano,song,cover,practice-help").split(",");
const cases = dialogueCases.filter(c => c.split === "design" && selected.includes(c.id));
if (new Set(selected).size !== selected.length || selected.some(id => !cases.some(c => c.id === id)))
  throw new Error("Only unique design cases can be used in selection");
const maxCalls = 20;
if (cases.length * 4 > maxCalls) throw new Error("Ablation exceeds 20 calls");
const targetPlatform = process.env.LIVE_DIALOGUE_CANDIDATE_PLATFORM, targetModel = process.env.LIVE_DIALOGUE_CANDIDATE_MODEL;
if (targetPlatform && !targetModel) throw new Error("Explicit candidate model required");
const route = targetPlatform ? resolveDialogueCandidate(loadPlatformConfig(), targetPlatform, targetModel!)
  : platform("agent_turn", targetModel);
if (kind === "thinking" && (!route.modelProfile?.reasoning || route.modelProfile.reasoning.default === "none"))
  throw new Error("Thinking diagnostic requires an enabled default profile");
const batchId = randomUUID(), wire: WireReceipt[] = [], results: Record<string, unknown>[] = [];
const persist = () => save(name, { batchId, maxCalls, platformId: route.platformId, model: route.model, profile: route.modelProfile,
  kind, note: kind === "contextual"
    ? "Only account reply examples replaced by contextual examples; same other persona fields, history, model, permissions and parameters. Synthetic style material is not real history or a reference answer."
    : kind === "light-thinking"
    ? "Casual usable-configuration comparison: requested off vs declared low effort; explicit help keeps original effort. Sampling may be omitted by the model's reasoning compatibility policy, so this is not an isolated reasoning effect. No production defaults changed."
    : kind === "temperature" || kind === "activeness"
    ? "Single-variable diagnostic with same model/persona/native messages/context. Temperature compares casual .9/.3 while explicit help keeps .3. Activeness compares only the old/new active behavior sentence. No production adoption or human/HTTP/database acceptance claimed."
    : kind === "examples"
    ? "Single-variable expression diagnostic: same relevant synthetic context, model, persona fields, reasoning and temperature; only account reply examples included/absent. No independent human ratings, HTTP or database delivery. No production configuration changed."
    : kind === "thinking" ? "Single-variable per-turn thinking diagnostic with same relevant context/persona/temperature/native messages/output contract. Explicit help keeps its normal enabled setting in both conditions. Gateway effort is not inferred from the profile. No production, human, HTTP or database acceptance."
    : "Capability diagnostic with multiple prompt changes: account persona, character base and nonessential preamble replaced by concise identity. Mandatory contracts, native messages, reasoning and temperature retained. Not a single-variable cause or a production candidate. No human, HTTP or database acceptance.", results });
persist();
for (let repeat = 0; repeat < 2; repeat++) for (let i = 0; i < cases.length; i++) {
  const c = cases[i]!;
  const variants: Array<"current" | "absent" | "concise" | "automatic" | "enabled" | "low" | "previous" | "contextual" | "light"> = kind === "light-thinking"
    ? ["current", "light"] : kind === "contextual"
    ? ["current", "contextual"] : kind === "temperature"
    ? ["current", "low"] : kind === "activeness" ? ["previous", "current"] : kind === "thinking"
    ? ["automatic", "enabled"] : kind === "identity" ? ["absent", "concise"] : ["current", "absent"];
  const order = (i + repeat) % 2 ? [...variants].reverse() : variants;
  for (const examples of order) {
    const fixture = dialogueGenerationFixture(c), maxTokens = route.modelProfile?.maxOutputTokens ?? 8000;
    const built = examples === "automatic" || examples === "enabled" ? buildDialogueThinkingDiagnostic(fixture, maxTokens, examples)
      : examples === "concise" ? buildDialogueIdentityDiagnostic(fixture, maxTokens)
      : buildDialogueExperimentRequest(fixture, "relevant", maxTokens, examples === "absent" ? "absent" : examples === "contextual" ? "contextual" : "current");
    if (kind === "temperature" && examples === "low" && fixture.intent === "conversation") built.request.temperature = 0.3;
    const activeRoute = kind === "light-thinking" && examples === "light" && fixture.intent === "conversation"
      ? { ...route, modelProfile: { ...route.modelProfile, reasoning: { ...route.modelProfile!.reasoning!, default: "low" as const } } } : route;
    if (kind === "light-thinking") {
      if (!route.modelProfile?.reasoning?.levels.includes("low")) throw new Error("Light thinking requires a declared low effort");
      if (examples === "light" && fixture.intent === "conversation") built.request.disableThinking = false;
    }
    if (kind === "activeness" && examples === "previous") {
      const active = "用户把你设为「活跃」：愿意参与、有自己的反应，贴着当前话题多聊两句；好奇、看法和小玩笑都可以，接住一句话也可以自然结束。活跃度只决定参与感，不把分享变成帮用户安排事情；用户求办法时再给具体帮助。用户限定篇幅或只要答案时，按这轮要求收住，不补充解释或追问。";
      if (!built.request.systemPrompt.includes(active)) throw new Error("Active behavior control no longer matches");
      built.request.systemPrompt = built.request.systemPrompt.replace(active,
        "用户把你设为「活跃」：愿意参与、有自己的反应，贴着当前话题多聊两句；有具体理由时才提问题或建议，接住一句话也可以自然结束，不必每轮留下邀请。用户限定篇幅或只要答案时，按这轮要求收住，不补充解释或追问。");
    }
    const wireSnapshots: ReturnType<typeof snapshotDialogueWireBody>[] = [];
    const row: Record<string, unknown> = { caseId: c.id, repeat, examples, provenance: built.provenance, activeProfile: activeRoute.modelProfile,
      requestSnapshot: snapshotDialogueRequest(built.request), wireSnapshots };
    results.push(row);
    const before = wire.length, start = Date.now();
    const provider = observedProvider(activeRoute, `ablation-${batchId}-${c.id}-${repeat}-${examples}`, wire,
      undefined, undefined, undefined, body => {
        if (wire.length >= maxCalls) throw new Error("Ablation budget exhausted");
        wireSnapshots.push(snapshotDialogueWireBody(body));
      });
    console.log(JSON.stringify({ starting: c.id, repeat, examples }));
    let receivedText = "";
    try {
      const result = await runStreamingAgentStep({ provider, stepRequest: built.request,
        ctxSignal: AbortSignal.timeout(60000), timeoutMs: 60000,
        onProviderDelta: async delta => { receivedText += delta; return true; } });
      const finalized = finalizeCompanionReplyText({ text: result.content ?? "", runId: batchId }).text;
      const validated = validateCompanionOutput(finalized);
      Object.assign(row, { rawAnswer: result.content, answer: validated.ok ? validated.text : finalized,
        finishReason: result.finishReason, structuralOk: validated.ok && result.finishReason === "stop" && result.toolCalls.length === 0 });
    } catch (error) { Object.assign(row, { structuralOk: false, error: safeFailure(error),
      receivedText, receivedVisibleText: sanitizeCompanionVisibleText(receivedText),
      partialTextNote: "Executor callback text received before failure; not a published final answer or an HTTP/UI receipt." }); }
    Object.assign(row, { elapsedMs: Date.now() - start, wire: wire.slice(before) }); persist();
    console.log(JSON.stringify({ caseId: c.id, repeat, examples, answer: row.answer, structuralOk: row.structuralOk }));
  }
}
