import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import type { AgentTurnRequest } from "@astella/shared";
import { observedProvider, platform, outputDir, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { dialogueCases, dialogueGenerationFixture } from "./dialogue-cases.ts";
import { buildDialogueExperimentRequest, hashDialogueValue, snapshotDialogueRequest, snapshotDialogueWireBody } from "./dialogue-experiment.ts";
import { buildDialogueLayerRequests, dialogueLayerConditions } from "./dialogue-layer-diagnostic.ts";
import { finalizeCompanionReplyText, validateCompanionOutput, sanitizeCompanionVisibleText } from "../handlers/companion-dialogue-content.ts";
import { buildCasualFirstStepRequest } from "../handlers/companion-speculative-first-step.ts";

const suffix = process.env.LIVE_DIALOGUE_LAYER_SUFFIX;
if (!suffix || !/^[a-z0-9-]{1,40}$/.test(suffix)) throw new Error("Unique diagnostic suffix required");
const name = `dialogue-layer-diagnostic-${suffix}`;
const manifestPath = `${outputDir}/${name}-manifest.json`;
if (existsSync(manifestPath) || existsSync(`${outputDir}/${name}.json`)) throw new Error("Refusing to overwrite diagnostic evidence");
const databaseUrl = process.env.DATABASE_URL_WORKER;
if (!databaseUrl || new URL(databaseUrl).pathname !== "/astella_companion_live_20261007")
  throw new Error("Only the named synthetic disposable database is allowed");
const route = platform("agent_turn");
const maxTokens = route.modelProfile?.maxOutputTokens;
if (!maxTokens) throw new Error("Declared output ceiling required");
const db = postgres(databaseUrl, { max: 1 });
type Fixture = { id: string; origin: string; runId?: string; requests: ReturnType<typeof buildDialogueLayerRequests> };
const fixtures: Fixture[] = [];
const natural = JSON.parse(readFileSync(`${outputDir}/finish/fast-natural-1008-v1.json`, "utf8"));
const native = JSON.parse(readFileSync(`${outputDir}/finish/cancel-native-final-v4.json`, "utf8"));
const captured = natural.rows.map((row: { text: string; run: { id: string } }, index: number) => ({
  id: ["zipper-share", "zipper-correction", "zipper-complaint"][index]!, runId: row.run.id, userText: row.text,
}));
const cup = native.rows.find((row: { run: { generation: number } }) => row.run.generation === 21);
if (!cup) throw new Error("Saved native cup turn required");
captured.push({ id: "cup-after-story", runId: cup.run.id, userText: "刚才已经又接了一杯水了。" });
try {
  for (const item of captured) {
    const [row] = await db.begin(async tx => {
      await tx`SELECT set_config('app.workspace_id','fe9fb836-45b4-46ba-aecb-a4ff70b75527',true),
        set_config('app.user_id','db6b2947-cb1a-4531-a7c0-9be3de8365de',true)`;
      return tx`SELECT snapshot FROM companion_context_handoff_snapshots WHERE run_id=${item.runId}`;
    });
    const saved = row?.snapshot?.modelMessages as AgentTurnRequest["messages"] | undefined;
    if (!saved || saved[0]?.role !== "system" || typeof saved[0].content !== "string")
      throw new Error("Captured synthetic system context required");
    const current = saved.reduce((found, message, index) => message.role === "user"
      && message.content === item.userText ? index : found, -1);
    if (current < 1) throw new Error("Exact captured current user message required");
    const messages = saved.slice(1, current + 1);
    if (messages.some(message => !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || message.reasoning?.length))
      throw new Error("Diagnostic captures must be native text without hidden reasoning or tool replay");
    const runtime = { permissionLevel: "guided", stepBudget: 4 };
    const full = buildCasualFirstStepRequest({ ...runtime, turnPolicy: saved[0].content, messages, maxTokens });
    fixtures.push({ id: item.id, origin: "actual synthetic-account committed base context; current assistant output excluded; fixed casual request",
      runId: item.runId, requests: buildDialogueLayerRequests(full, runtime) });
  }
} finally { await db.end(); }
for (const id of ["resume", "piano"]) {
  const fixture = dialogueGenerationFixture(dialogueCases.find(item => item.id === id)!);
  const built = buildDialogueExperimentRequest(fixture, "full", maxTokens);
  const requests = buildDialogueLayerRequests(built.request, { permissionLevel: "read_only", stepBudget: 3 });
  fixtures.push({ id, origin: "known design fixture, current production builders with declared synthetic background", requests });
}
if (fixtures.length !== 6) throw new Error("Exactly six frozen prefixes required");
const schedule = fixtures.flatMap((fixture, index) => {
  const offset = index % 3;
  return [...dialogueLayerConditions.slice(offset), ...dialogueLayerConditions.slice(0, offset)]
    .map(condition => ({ id: fixture.id, condition }));
});
const batchId = randomUUID();
const frozen = { batchId, frozenAt: new Date().toISOString(), maxCalls: 18, scope: "Design-prefix expression diagnostic; not independent topics, live dialogue, full runtime or human acceptance",
  route: { platformId: route.platformId, model: route.model, type: route.type, profile: route.modelProfile }, schedule,
  fixtures: fixtures.map(fixture => ({ ...fixture,
    historyHash: hashDialogueValue(fixture.requests.full.messages),
    requests: Object.fromEntries(dialogueLayerConditions.map(condition => [condition, snapshotDialogueRequest(fixture.requests[condition])])) })),
  interpretation: "All fixed conversation/none; classification not called. Only system prompt changes. Protocol adds a group of host/identity/voice/execution policies, so a difference is not attributable to one sentence. No target answers or review criteria sent to model.",
};
writeFileSync(manifestPath, JSON.stringify(frozen, null, 2), { flag: "wx" });
const wire: WireReceipt[] = [], rows: Array<Record<string, unknown>> = [];
const persist = () => save(name, { batchId, manifestHash: hashDialogueValue(frozen), rows, wire });
persist();
for (const item of schedule) {
  const request = fixtures.find(fixture => fixture.id === item.id)!.requests[item.condition];
  const wireSnapshots: ReturnType<typeof snapshotDialogueWireBody>[] = [];
  const row: Record<string, unknown> = { ...item, requestHash: snapshotDialogueRequest(request).hash, wireSnapshots };
  rows.push(row);
  const provider = observedProvider(route, `layer-${batchId}-${item.id}-${item.condition}`, wire,
    undefined, undefined, undefined, body => {
      if (wire.length >= 18) throw new Error("Frozen physical request budget exhausted");
      wireSnapshots.push(snapshotDialogueWireBody(body));
    });
  let rawDelta = "", firstVisibleMs: number | null = null;
  const started = Date.now();
  try {
    const nativeMessages = request.messages.map(message => {
      if (message.role === "tool" || typeof message.content !== "string") throw new Error("Only native text messages allowed");
      return { role: message.role, content: message.content };
    });
    const result = await provider.chatCompletionStream!([{ role: "system", content: request.systemPrompt }, ...nativeMessages],
      { maxTokens: request.maxTokens, temperature: request.temperature, disableThinking: request.disableThinking, responseFormat: "text" },
      AbortSignal.timeout(30_000), delta => {
        rawDelta += delta;
        const visible = sanitizeCompanionVisibleText(finalizeCompanionReplyText({ text: rawDelta, runId: `${item.id}-${item.condition}` }).text);
        if (firstVisibleMs === null && visible.trim()) firstVisibleMs = Date.now() - started;
      });
    row.rawAnswer = result.content;
    row.answer = finalizeCompanionReplyText({ text: result.content, runId: `${item.id}-${item.condition}` }).text;
    row.finishReason = result.finishReason;
    row.completedMatchesDeltas = result.content === rawDelta;
    const validation = validateCompanionOutput(row.answer as string);
    row.validation = validation;
    if (validation.ok) row.answer = validation.text;
  } catch (error) { row.error = safeFailure(error); }
  row.rawDelta = rawDelta;
  row.firstVisibleMs = firstVisibleMs;
  row.elapsedMs = Date.now() - started;
  persist();
  console.log(JSON.stringify({ completed: rows.length, id: item.id, condition: item.condition,
    firstVisibleMs, elapsedMs: row.elapsedMs, error: row.error ?? null }));
}
