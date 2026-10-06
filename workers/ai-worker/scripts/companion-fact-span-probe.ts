/**
 * W2-5 real-model observation: did the production Companion prompt ask for
 * `{{f:key}}` markers before the server-side renderer consumed the response?
 *
 * Uses the production persona message builder, provider factory, and tool
 * registry with synthetic fact values. It never executes tools, writes a DB,
 * or persists the model's response text/arguments; only marker counts and
 * timing/token metadata are saved.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { AgentRole, type AgentTurnRequest } from "@ailearn/shared";
import { resolveAllCompanionAgentTools } from "@ailearn/shared/companion-agent-registry";
import { resolveSystemPlatform } from "@ailearn/shared/platform-config-node";
import { buildCompanionPersonaMessages } from "../src/handlers/companion-dialogue-content.ts";
import { FACT_SPAN_KEYS, renderFactSpansBlock, resolveFactSpans } from "../src/handlers/companion-fact-spans.ts";
import { createProvider } from "../src/lib/ai-provider.ts";

export function observeFactSpanMarkers(
  rawText: string | null,
  availableKeys: readonly string[],
): { readonly markerCount: number; readonly knownMarkerCount: number; readonly unknownMarkerCount: number } {
  const keys = [...(rawText ?? "").matchAll(/\{\{f:([a-z0-9_]+)\}\}/g)].map((match) => match[1]);
  const available = new Set(availableKeys);
  const knownMarkerCount = keys.filter((key) => available.has(key)).length;
  return {
    markerCount: keys.length,
    knownMarkerCount,
    unknownMarkerCount: keys.length - knownMarkerCount,
  };
}

function selfTest(): number {
  const counts = observeFactSpanMarkers(
    "今天 {{f:today_minutes}} 分钟，另外 {{f:unknown_key}}。{{f:today_minutes}}",
    ["today_minutes"],
  );
  assert.deepEqual(counts, { markerCount: 3, knownMarkerCount: 2, unknownMarkerCount: 1 });
  assert.deepEqual(observeFactSpanMarkers(null, ["today_minutes"]), {
    markerCount: 0,
    knownMarkerCount: 0,
    unknownMarkerCount: 0,
  });
  const resolved = resolveFactSpans("今天 {{f:today_minutes}} 分钟。", { today_minutes: "42" });
  assert.equal(resolved.text, "今天 42 分钟。");
  assert.equal(resolved.dropped.length, 0);
  console.log("W2-5 fact-span probe self-test: 4 assertions passed; observation stores counts, never text.");
  return 0;
}

function repositoryRoot(): string {
  return resolve(process.cwd(), "../..");
}

function resolveConfigPath(root: string): void {
  if (process.env.AI_PLATFORMS_CONFIG) return;
  process.env.AI_PLATFORMS_CONFIG = resolve(root, "config/ai-platforms.json");
}

function safeError(error: unknown): Record<string, string | number | null> {
  if (!(error instanceof Error)) return { name: "UnknownError", code: null, status: null, providerCode: null };
  const shaped = error as Error & { code?: unknown; status?: unknown; providerCode?: unknown };
  return {
    name: error.name.slice(0, 80),
    code: typeof shaped.code === "string" ? shaped.code.slice(0, 80) : null,
    status: typeof shaped.status === "number" ? shaped.status : null,
    providerCode: typeof shaped.providerCode === "string" ? shaped.providerCode.slice(0, 120) : null,
  };
}

async function runRealModelProbe(): Promise<number> {
  if (process.env.REAL_MODEL_BATCH !== "1") {
    console.error("Refusing paid request: set REAL_MODEL_BATCH=1 explicitly for this synthetic probe.");
    return 1;
  }
  const root = repositoryRoot();
  resolveConfigPath(root);
  const platform = resolveSystemPlatform("agent_turn");
  if (!platform) throw new Error("agent_turn provider is not configured");
  const provider = createProvider(platform.type, {
    apiKey: platform.apiKey,
    baseUrl: platform.baseUrl,
    model: platform.model,
    modelProfile: platform.modelProfile,
    options: platform.options,
  });
  if (!provider.executeAgentTurn) throw new Error("Configured provider does not implement executeAgentTurn");

  const values = { today_minutes: "42", due_count: "3" };
  const factSpans = renderFactSpansBlock(values);
  if (!factSpans) throw new Error("Synthetic fact-span catalog is empty");
  const baseMessages = buildCompanionPersonaMessages({
    userText: "我今天学了多久？请按本轮读数告诉我准确分钟数。",
    recentMessages: [],
    pageContext: null,
    hereAndNow: "<here_and_now> 当前处于合成探针回合。</here_and_now>",
    factSpans,
    residentMemories: [],
    petProfile: null,
  });
  const definitions = resolveAllCompanionAgentTools("full", { visionEnabled: false });
  const tools: AgentTurnRequest["tools"] = definitions.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const systemPrompt = typeof baseMessages[0]?.content === "string" ? baseMessages[0].content : "";
  const request: AgentTurnRequest = {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt,
    messages: baseMessages.filter((message) => message.role !== "system").map((message) => ({
      role: message.role,
      content: message.content,
    })),
    tools,
    toolChoice: "auto",
    maxTokens: 2_000,
    temperature: 0.4,
    model: platform.model,
  };

  const startedAt = performance.now();
  let observation: Record<string, unknown>;
  try {
    const response = await provider.executeAgentTurn(request, AbortSignal.timeout(60_000));
    const rawText = response.content;
    const markers = observeFactSpanMarkers(rawText, Object.keys(FACT_SPAN_KEYS));
    const rendered = resolveFactSpans(rawText ?? "", values);
    observation = {
      status: "succeeded",
      provider: provider.id,
      model: provider.modelId,
      requestedCatalogKeys: Object.keys(values),
      ...markers,
      rendererDroppedSentenceCount: rendered.dropped.length,
      toolCallCount: response.toolCalls?.length ?? 0,
      toolNames: (response.toolCalls ?? []).map((call) => call.name),
      elapsedMs: Math.round(performance.now() - startedAt),
      promptTokens: response.usage?.promptTokens ?? 0,
      completionTokens: response.usage?.completionTokens ?? 0,
      finishReason: response.finishReason,
    };
  } catch (error) {
    observation = {
      status: "failed",
      provider: provider.id,
      model: provider.modelId,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: safeError(error),
    };
  }

  const artifactDir = resolve(root, ".impeccable/companion");
  await mkdir(artifactDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactPath = resolve(artifactDir, "w25-fact-span-real-" + stamp + ".json");
  await writeFile(artifactPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "synthetic-production-prompt-single-real-model-call",
    observation,
  }, null, 2) + "\n", "utf8");
  console.log("W2-5 fact-span observation: " + JSON.stringify(observation));
  console.log("W2-5 fact-span artifact: " + artifactPath);
  return observation.status === "succeeded" ? 0 : 1;
}

async function main(): Promise<number> {
  if (process.argv.includes("--self-test")) return selfTest();
  if (!process.argv.includes("--real-model-probe")) {
    console.log("Use --self-test or --real-model-probe (with REAL_MODEL_BATCH=1).");
    return 0;
  }
  return runRealModelProbe();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath.endsWith("companion-fact-span-probe.ts")) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error("W2-5 fact-span probe failed without exposing response content: "
      + (error instanceof Error ? error.name + ": " + error.message : "UnknownError"));
    process.exitCode = 1;
  });
}
