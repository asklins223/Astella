import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentTurnRequest } from "@astella/shared";
import { observedProvider, platform, outputDir, save, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { snapshotDialogueRequest, snapshotDialogueWireBody, hashDialogueValue } from "./dialogue-experiment.ts";
import { continuationGoalRequest, dialogueContinuationGoal } from "./dialogue-continuation-goal.ts";
import { finalizeCompanionReplyText, sanitizeCompanionVisibleText, validateCompanionOutput } from "../handlers/companion-dialogue-content.ts";

const suffix = process.env.LIVE_CONTINUATION_GOAL_SUFFIX;
if (!suffix || !/^[a-z0-9-]{1,40}$/.test(suffix)) throw new Error("Unique diagnostic suffix required");
const name = `deepseek-continuation-goal-${suffix}`;
if (existsSync(`${outputDir}/${name}-manifest.json`) || existsSync(`${outputDir}/${name}.json`)) throw new Error("No evidence overwrite");
const route = platform("agent_turn");
if (route.model !== "deepseek-v4.1-flash") throw new Error("Human fixed-model instruction");
const source = JSON.parse(readFileSync(`${outputDir}/dialogue-layer-diagnostic-layers-1008-v1-manifest.json`, "utf8"));
const fixtures: { id: string; baseline: AgentTurnRequest; candidate: AgentTurnRequest }[] = source.fixtures.map((f: { id: string; requests: { full: { request: AgentTurnRequest } } }) =>
  ({ id: f.id, baseline: f.requests.full.request, candidate: continuationGoalRequest(f.requests.full.request) }));
if (fixtures.length !== 6) throw new Error("Exactly six known design prefixes required");
const frozen = { frozenAt: new Date().toISOString(), batchId: randomUUID(), maxObservedCalls: 12,
  model: route.model, profile: route.modelProfile, sourceManifestHash: hashDialogueValue(source), candidate: dialogueContinuationGoal,
  fixtures: fixtures.map((f: typeof fixtures[number]) => ({ id: f.id, baseline: snapshotDialogueRequest(f.baseline), candidate: snapshotDialogueRequest(f.candidate) })),
  scope: "Only add an explicit dialogue-continuation task to the existing casual execution policy. Full persona/host/source/permission/native history/none/.9/output retained. Known design prefixes, one sample per condition. No generated planner/reviewer, target reply, word limit, output cut or formal adoption. Observed public requester count, not proof of internal HTTP attempt count.",
};
writeFileSync(`${outputDir}/${name}-manifest.json`, JSON.stringify(frozen, null, 2), { flag: "wx" });
type Row = { id: string; condition: "baseline" | "candidate"; request: ReturnType<typeof snapshotDialogueRequest>;
  wireSnapshots: ReturnType<typeof snapshotDialogueWireBody>[]; answer?: string; rawAnswer?: string; rawDelta?: string;
  finishReason?: string; validation?: ReturnType<typeof validateCompanionOutput>; completedMatchesDeltas?: boolean;
  error?: ReturnType<typeof safeFailure>; firstVisibleMs?: number | null; elapsedMs?: number };
const rows: Row[] = [], wire: WireReceipt[] = [];
const persist = () => save(name, { manifestHash: hashDialogueValue(frozen), rows, wire });
persist();
for (const [index, fixture] of fixtures.entries()) {
  const order: Row["condition"][] = index % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];
  for (const condition of order) {
    const request = fixture[condition];
    const row: Row = { id: fixture.id, condition, request: snapshotDialogueRequest(request), wireSnapshots: [] };
    rows.push(row);
    const provider = observedProvider(route, `${frozen.batchId}/${fixture.id}/${condition}`, wire,
      undefined, undefined, undefined, body => {
        if (wire.length >= frozen.maxObservedCalls) throw new Error("Observed request budget12");
        row.wireSnapshots.push(snapshotDialogueWireBody(body));
      });
    let rawDelta = "", firstVisibleMs: number | null = null;
    const started = Date.now();
    try {
      if (!provider.chatCompletionStream) throw new Error("Streaming route required");
      const native = request.messages.map(m => {
        if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || m.reasoning?.length)
          throw new Error("Only original visible native text is replayed");
        return { role: m.role, content: m.content };
      });
      const result = await provider.chatCompletionStream([{ role: "system", content: request.systemPrompt }, ...native],
        { maxTokens: request.maxTokens, temperature: request.temperature, disableThinking: request.disableThinking,
          responseFormat: "text" }, AbortSignal.timeout(30000), delta => {
          rawDelta += delta;
          if (firstVisibleMs === null && sanitizeCompanionVisibleText(rawDelta).trim()) firstVisibleMs = Date.now() - started;
        });
      const answer = finalizeCompanionReplyText({ text: result.content, runId: fixture.id }).text;
      const validation = validateCompanionOutput(answer);
      Object.assign(row, { rawAnswer: result.content, answer: validation.ok ? validation.text : answer,
        validation, finishReason: result.finishReason, completedMatchesDeltas: result.content === rawDelta });
    } catch (error) { row.error = safeFailure(error); }
    Object.assign(row, { rawDelta, firstVisibleMs, elapsedMs: Date.now() - started });
    persist();
    console.log(JSON.stringify({ completed: rows.length, id: row.id, condition, elapsedMs: row.elapsedMs, error: row.error ?? null }));
  }
}
