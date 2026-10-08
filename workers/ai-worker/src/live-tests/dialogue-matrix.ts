import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dialogueCases, dialogueGenerationFixture } from "./dialogue-cases.ts";
import { buildDialogueExperimentRequest, dialogueMatrixSchedule, snapshotDialogueRequest, snapshotDialogueWireBody } from "./dialogue-experiment.ts";
import { observedProvider, platform, loadPlatformConfig, save, safeFailure, outputDir, type WireReceipt } from "./acceptance-common.ts";
import { resolveDialogueCandidate, dialogueCandidateThinking } from "./dialogue-candidate.ts";
import { finalizeCompanionReplyText, validateCompanionOutput, sanitizeCompanionVisibleText } from "../handlers/companion-dialogue-content.ts";
import { runStreamingAgentStep } from "../handlers/companion-agent-streaming-step.ts";

const suffix = process.env.LIVE_DIALOGUE_MATRIX_SUFFIX;
if (!suffix || !/^[a-z0-9-]{1,40}$/.test(suffix)) throw new Error("An explicit unique matrix suffix is required");
const outputName = `dialogue-matrix-${suffix}`;
if (existsSync(`${outputDir}/${outputName}.json`)) throw new Error("Refusing to overwrite an existing matrix");
const split = process.env.LIVE_DIALOGUE_SPLIT ?? "design";
if (split !== "design" && split !== "heldout") throw new Error("Invalid split");
if (split === "heldout" && process.env.LIVE_DIALOGUE_HELDOUT_RELEASE !== "1") throw new Error("Heldout release must be explicit");
const selected = process.env.LIVE_DIALOGUE_CASES?.split(",");
const cases = dialogueCases.filter(c => c.split === split && (!selected || selected.includes(c.id)));
if (!cases.length || (selected && new Set(selected).size !== selected.length)
  || selected?.some(id => !cases.some(c => c.id === id))) throw new Error("Unknown, duplicate case or split mismatch");
const repeats = Number(process.env.LIVE_DIALOGUE_REPEATS ?? 2);
const schedule = dialogueMatrixSchedule(cases.map(c => c.id), repeats);
const maxCalls = Number(process.env.LIVE_DIALOGUE_MAX_CALLS ?? 80);
if (!Number.isInteger(maxCalls) || maxCalls < schedule.length || maxCalls > 80) throw new Error("Matrix budget must cover schedule and be <=80");
const candidateId = process.env.LIVE_DIALOGUE_CANDIDATE_MODEL ?? "muse-spark-1.3-contributor";
const candidatePlatform = process.env.LIVE_DIALOGUE_CANDIDATE_PLATFORM;
const routes = { current: platform("agent_turn"), candidate: candidatePlatform
  ? resolveDialogueCandidate(loadPlatformConfig(), candidatePlatform, candidateId) : platform("agent_turn", candidateId) };
const candidateCasualEffort = process.env.LIVE_DIALOGUE_CANDIDATE_CASUAL_EFFORT;
if (candidateCasualEffort !== undefined && !routes.candidate.modelProfile?.reasoning?.levels.some(level => level === candidateCasualEffort))
  throw new Error("Candidate casual effort must be declared before any provider call");
if (routes.current.model === routes.candidate.model && routes.current.platformId === routes.candidate.platformId)
  throw new Error("Candidate must differ from current");
const batchId = randomUUID(), results: Array<Record<string, unknown>> = [], wire: WireReceipt[] = [];
const persist = () => save(outputName, { version: 1, batchId, split, maxCalls, candidateCasualEffort: candidateCasualEffort ?? null,
  routeProfiles: Object.fromEntries(Object.entries(routes).map(([id, r]) => [id,
    { platformId: r.platformId, model: r.model, profile: r.modelProfile, type: r.type }])),
  note: "Expression diagnostic only: production prompt builders, synthetic background, fixed interpretation, no reference answer or criteria sent to generator. Original and actual wire requests retained without credentials/reasoning. No HTTP, DB, tool execution or human acceptance claimed. Protocol, output limits and reasoning support may differ by configured platform/model; compare usable configurations, not an isolated model effect. Delivery validity is not conversational quality.",
  results });

persist();
for (const item of schedule) {
  const fixture = dialogueGenerationFixture(cases.find(c => c.id === item.caseId)!);
  const [modelCondition, contextCondition] = item.condition.split("/") as [keyof typeof routes, "full" | "relevant"];
  const baseRoute = routes[modelCondition];
  const built = buildDialogueExperimentRequest(fixture, contextCondition, baseRoute.modelProfile?.maxOutputTokens ?? 8000);
  const configured = dialogueCandidateThinking(baseRoute, built.request, fixture.intent,
    modelCondition === "candidate" ? candidateCasualEffort : undefined);
  const route = configured.route;
  built.request = configured.request;
  const requestSnapshot = snapshotDialogueRequest(built.request), wireSnapshots: ReturnType<typeof snapshotDialogueWireBody>[] = [];
  const row: Record<string, unknown> = { ...item, model: route.model, activeProfile: route.modelProfile, requestSnapshot, provenance: built.provenance,
    contextReceipts: built.receipts, wireSnapshots };
  results.push(row);
  const provider = observedProvider(route, `matrix-${batchId}-${item.caseId}-${item.repeat}-${item.condition}`, wire,
    undefined, undefined, undefined, body => {
      if (wire.length >= maxCalls) throw new Error("Matrix provider call budget exhausted");
      wireSnapshots.push(snapshotDialogueWireBody(body));
    });
  const before = wire.length, start = Date.now();
  let firstTextMs: number | null = null, firstVisibleTextMs: number | null = null, streamedText = "";
  console.log(JSON.stringify({ starting: item, model: route.model }));
  try {
    const response = await runStreamingAgentStep({ provider, stepRequest: built.request,
      ctxSignal: AbortSignal.timeout(60000), timeoutMs: 60000,
      onProviderDelta: async delta => {
        if (delta.trim()) firstTextMs ??= Date.now() - start;
        streamedText += delta;
        if (sanitizeCompanionVisibleText(streamedText).trim()) firstVisibleTextMs ??= Date.now() - start;
        return true;
      } });
    const answer = finalizeCompanionReplyText({ text: response.content ?? "", runId: batchId }).text;
    const validation = validateCompanionOutput(answer);
    Object.assign(row, { rawAnswer: response.content, answer: validation.ok ? validation.text : answer, finishReason: response.finishReason,
      toolCallCount: response.toolCalls.length, structuralOk: validation.ok && response.finishReason === "stop"
        && response.toolCalls.length === 0, usage: response.usage ?? null });
  } catch (error) { Object.assign(row, { structuralOk: false, error: safeFailure(error),
    receivedText: streamedText, receivedVisibleText: sanitizeCompanionVisibleText(streamedText),
    partialTextNote: "Executor callback text received before failure; not a published final answer or an HTTP/UI receipt." }); }
  Object.assign(row, { firstTextMs, firstVisibleTextMs,
    firstTextMeasurement: "First nonblank provider text delta; may be a voice tag. Visible projection time is separate. Neither includes HTTP/UI delivery gates.",
    elapsedMs: Date.now() - start, wire: wire.slice(before) });
  persist();
  console.log(JSON.stringify({ ...item, answer: row.answer, structuralOk: row.structuralOk, elapsedMs: row.elapsedMs }));
}
