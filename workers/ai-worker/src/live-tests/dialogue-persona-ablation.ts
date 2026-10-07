import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dialogueCases, dialogueGenerationFixture } from "./dialogue-cases.ts";
import { buildDialogueExperimentRequest, buildDialogueIdentityDiagnostic, snapshotDialogueRequest, snapshotDialogueWireBody } from "./dialogue-experiment.ts";
import { observedProvider, platform, save, safeFailure, outputDir, type WireReceipt } from "./acceptance-common.ts";
import { runStreamingAgentStep } from "../handlers/companion-agent-streaming-step.ts";
import { finalizeCompanionReplyText, validateCompanionOutput } from "../handlers/companion-dialogue-content.ts";

const suffix = process.env.LIVE_DIALOGUE_ABLATION_SUFFIX;
if (!suffix || !/^[a-z0-9-]{1,40}$/.test(suffix)) throw new Error("Explicit unique ablation suffix required");
const kind = process.env.LIVE_DIALOGUE_ABLATION_KIND ?? "examples";
if (kind !== "examples" && kind !== "identity") throw new Error("Invalid ablation kind");
const name = `dialogue-${kind === "identity" ? "identity-diagnostic" : "persona-ablation"}-${suffix}`;
if (existsSync(`${outputDir}/${name}.json`)) throw new Error("Refusing to overwrite ablation");
const selected = (process.env.LIVE_DIALOGUE_CASES ?? "resume,piano,song,cover,practice-help").split(",");
const cases = dialogueCases.filter(c => c.split === "design" && selected.includes(c.id));
if (new Set(selected).size !== selected.length || selected.some(id => !cases.some(c => c.id === id)))
  throw new Error("Only unique design cases can be used in selection");
const maxCalls = 20;
if (cases.length * 4 > maxCalls) throw new Error("Ablation exceeds 20 calls");
const route = platform("agent_turn"), batchId = randomUUID(), wire: WireReceipt[] = [], results: Record<string, unknown>[] = [];
const persist = () => save(name, { batchId, maxCalls, model: route.model, profile: route.modelProfile,
  kind, note: kind === "examples"
    ? "Single-variable expression diagnostic: same relevant synthetic context, model, persona fields, reasoning and temperature; only account reply examples included/absent. No independent human ratings, HTTP or database delivery. No production configuration changed."
    : "Capability diagnostic with multiple prompt changes: account persona, character base and nonessential preamble replaced by concise identity. Mandatory contracts, native messages, reasoning and temperature retained. Not a single-variable cause or a production candidate. No human, HTTP or database acceptance.", results });
persist();
for (let repeat = 0; repeat < 2; repeat++) for (let i = 0; i < cases.length; i++) {
  const c = cases[i]!;
  const variants: Array<"current" | "absent" | "concise"> = kind === "identity" ? ["absent", "concise"] : ["current", "absent"];
  const order = (i + repeat) % 2 ? [...variants].reverse() : variants;
  for (const examples of order) {
    const fixture = dialogueGenerationFixture(c), maxTokens = route.modelProfile?.maxOutputTokens ?? 8000;
    const built = examples === "concise" ? buildDialogueIdentityDiagnostic(fixture, maxTokens)
      : buildDialogueExperimentRequest(fixture, "relevant", maxTokens, examples);
    const wireSnapshots: ReturnType<typeof snapshotDialogueWireBody>[] = [];
    const row: Record<string, unknown> = { caseId: c.id, repeat, examples, provenance: built.provenance,
      requestSnapshot: snapshotDialogueRequest(built.request), wireSnapshots };
    results.push(row);
    const before = wire.length, start = Date.now();
    const provider = observedProvider(route, `ablation-${batchId}-${c.id}-${repeat}-${examples}`, wire,
      undefined, undefined, undefined, body => {
        if (wire.length >= maxCalls) throw new Error("Ablation budget exhausted");
        wireSnapshots.push(snapshotDialogueWireBody(body));
      });
    console.log(JSON.stringify({ starting: c.id, repeat, examples }));
    try {
      const result = await runStreamingAgentStep({ provider, stepRequest: built.request,
        ctxSignal: AbortSignal.timeout(60000), timeoutMs: 60000, onProviderDelta: async () => true });
      const finalized = finalizeCompanionReplyText({ text: result.content ?? "", runId: batchId }).text;
      const validated = validateCompanionOutput(finalized);
      Object.assign(row, { rawAnswer: result.content, answer: validated.ok ? validated.text : finalized,
        finishReason: result.finishReason, structuralOk: validated.ok && result.finishReason === "stop" && result.toolCalls.length === 0 });
    } catch (error) { Object.assign(row, { structuralOk: false, error: safeFailure(error) }); }
    Object.assign(row, { elapsedMs: Date.now() - start, wire: wire.slice(before) }); persist();
    console.log(JSON.stringify({ caseId: c.id, repeat, examples, answer: row.answer, structuralOk: row.structuralOk }));
  }
}
