import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentTurnRequest } from "@astella/shared";
import { observedProvider, loadPlatformConfig, outputDir, safeFailure, save, type WireReceipt } from "./acceptance-common.ts";
import { resolveDialogueCandidate } from "./dialogue-candidate.ts";
import { hashDialogueValue, snapshotDialogueRequest, snapshotDialogueWireBody } from "./dialogue-experiment.ts";
import { finalizeCompanionReplyText, sanitizeCompanionVisibleText, validateCompanionOutput } from "../handlers/companion-dialogue-content.ts";

const suffix = process.env.LIVE_EXPRESSION_SCREEN_SUFFIX;
if (!suffix || !/^[a-z0-9-]{1,40}$/.test(suffix)) throw new Error("Explicit unique screen suffix required");
const name = `dialogue-expression-screen-${suffix}`, manifestPath = `${outputDir}/${name}-manifest.json`;
if (existsSync(manifestPath) || existsSync(`${outputDir}/${name}.json`)) throw new Error("Refusing to overwrite model screen");
const model = process.env.LIVE_EXPRESSION_SCREEN_MODEL ?? "seed-2.1-pro";
if (!["seed-2.1-pro", "qwen3.8-max"].includes(model)) throw new Error("Only the reviewed bounded screen candidates are allowed");
const catalog = JSON.parse(readFileSync(`${outputDir}/expression-catalog-1008-v3.json`, "utf8"));
const declared = catalog.rows.find((row: { platformId: string; status: number }) => row.platformId === "tokenrhythm" && row.status === 200)
  ?.models.find((item: { id: string }) => item.id === model);
if (!declared?.supportsReasoning || !declared?.supportsTools || !Number.isSafeInteger(declared.contextWindowTokens)
  || !Number.isSafeInteger(declared.maxOutputTokens)) throw new Error("Complete observed gateway declaration required");
const config = structuredClone(loadPlatformConfig());
if (!config?.platforms.tokenrhythm) throw new Error("Existing gateway required");
// Test-only declaration. Do not modify persisted platforms or capability routes.
config.platforms.tokenrhythm.models = { ...config.platforms.tokenrhythm.models,
  [model]: { contextWindowTokens: declared.contextWindowTokens, maxOutputTokens: declared.maxOutputTokens,
    vision: declared.supportsVision === true, reasoning: { levels: ["none", "high"], default: "high" } } };
const route = resolveDialogueCandidate(config, "tokenrhythm", model);
const sourceManifest = JSON.parse(readFileSync(`${outputDir}/dialogue-layer-diagnostic-layers-1008-v1-manifest.json`, "utf8"));
const fixtures = sourceManifest.fixtures.map((fixture: { id: string; requests: { full: { request: AgentTurnRequest } } }) => ({
  id: fixture.id, request: { ...fixture.requests.full.request, maxTokens: route.modelProfile!.maxOutputTokens! },
}));
if (fixtures.length !== 6) throw new Error("Exactly six previously frozen design prefixes required");
const frozen = { batchId: randomUUID(), frozenAt: new Date().toISOString(), maxCalls: 6,
  route: { platformId: route.platformId, model: route.model, profile: route.modelProfile },
  catalogHash: hashDialogueValue(catalog), sourceManifestHash: hashDialogueValue(sourceManifest),
  fixtures: fixtures.map((fixture: { id: string; request: AgentTurnRequest }) => ({ id: fixture.id, snapshot: snapshotDialogueRequest(fixture.request) })),
  scope: "One new model, design-prefix expression screen. Same full system/native history/.9/disableThinking as the full layer baseline; platform, model and declared output ceiling differ. Usable-configuration comparison, not isolated model effect. No production adoption, tools, classifier, DB delivery or independent human rating.",
  sources: [model === "seed-2.1-pro" ? "https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh"
    : "https://help.aliyun.com/zh/model-studio/deep-thinking", "https://tokenrhythm.studio/docs/overview"],
  parameterCaveat: "Gateway receives enable_thinking:false, not a declared high effort or proof of an applied native setting. Returned usage/request receipt verifies observed behavior only; gateway model alias version is unspecified.",
};
writeFileSync(manifestPath, JSON.stringify(frozen, null, 2), { flag: "wx" });
const wire: WireReceipt[] = [], rows: Array<Record<string, unknown>> = [];
const persist = () => save(name, { manifestHash: hashDialogueValue(frozen), rows, wire });
persist();
for (const fixture of fixtures as Array<{ id: string; request: AgentTurnRequest }>) {
  const wireSnapshots: ReturnType<typeof snapshotDialogueWireBody>[] = [];
  const row: Record<string, unknown> = { id: fixture.id, wireSnapshots };
  rows.push(row);
  const provider = observedProvider(route, `screen-${frozen.batchId}-${fixture.id}`, wire,
    undefined, undefined, undefined, body => {
      if (wire.length >= 6) throw new Error("Frozen physical screen budget exhausted");
      wireSnapshots.push(snapshotDialogueWireBody(body));
    });
  const native = fixture.request.messages.map(message => {
    if (message.role === "tool" || typeof message.content !== "string") throw new Error("Only native synthetic text allowed");
    return { role: message.role, content: message.content };
  });
  let rawDelta = "", firstVisibleMs: number | null = null;
  const started = Date.now();
  try {
    const result = await provider.chatCompletionStream!([{ role: "system", content: fixture.request.systemPrompt }, ...native],
      { maxTokens: fixture.request.maxTokens, temperature: fixture.request.temperature,
        disableThinking: fixture.request.disableThinking, responseFormat: "text" }, AbortSignal.timeout(30_000), delta => {
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
  console.log(JSON.stringify({ completed: rows.length, id: fixture.id, firstVisibleMs, elapsedMs: row.elapsedMs, error: row.error ?? null }));
}
