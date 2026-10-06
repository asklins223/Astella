/**
 * S1 正向探针：用生产 provider factory、模型工具合同和 tool_choice=required
 * 直接测模型是否至少返回一个工具调用。不会执行工具，也不写数据库。
 *
 * 决策样本每模型至少 100 次；小样本只适合验证接线，不能用于 2% 门槛。
 *
 * 跑法（在 workers/ai-worker）：
 *   set -a; . ../../.env; set +a
 *   REAL_MODEL_BATCH=1 AI_PLATFORMS_CONFIG=../../config/ai-platforms.json \
 *     npx tsx --tsconfig tsconfig.json scripts/companion-s1-required-probe.ts \
 *       --required-real-model-probe --samples-per-model 100
 *   REAL_MODEL_BATCH=1 AI_PLATFORMS_CONFIG=../../config/ai-platforms.json \
 *     npx tsx --tsconfig tsconfig.json scripts/companion-s1-required-probe.ts \
 *       --required-fallback-probe --samples-per-model 100
 *   npx tsx --tsconfig tsconfig.json scripts/companion-s1-required-probe.ts --self-test
 *
 * 原始 prompt、模型正文、工具参数和凭据均不落盘；结果只保存逐样本计数、耗时与 token 用量。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";

import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import {
  resolveAllCompanionAgentTools,
  validateCompanionAgentToolArguments,
} from "@astella/shared/companion-agent-registry";
import { resolveSystemPlatform } from "@astella/shared/platform-config-node";
import { createProvider } from "../src/lib/ai-provider.ts";

export interface RequiredProbeSample {
  readonly status: "succeeded" | "failed";
  readonly toolCallCount: number;
  readonly invalidArgumentCount: number;
  readonly elapsedMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface RequiredProbeSummary {
  readonly requested: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly toolCalls: number;
  readonly zeroToolCalls: number;
  readonly invalidArguments: number;
  readonly zeroToolCallRate: number | null;
  readonly invalidArgumentRate: number | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly p95ElapsedMs: number | null;
}

export function summarizeRequiredProbe(samples: readonly RequiredProbeSample[]): RequiredProbeSummary {
  const succeeded = samples.filter((sample) => sample.status === "succeeded");
  const toolCalls = succeeded.reduce((sum, sample) => sum + sample.toolCallCount, 0);
  const zeroToolCalls = succeeded.filter((sample) => sample.toolCallCount === 0).length;
  const invalidArguments = succeeded.reduce((sum, sample) => sum + sample.invalidArgumentCount, 0);
  const elapsed = succeeded.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  const p95Index = elapsed.length > 0 ? Math.ceil(elapsed.length * 0.95) - 1 : -1;
  return {
    requested: samples.length,
    succeeded: succeeded.length,
    failed: samples.length - succeeded.length,
    toolCalls,
    zeroToolCalls,
    invalidArguments,
    zeroToolCallRate: succeeded.length > 0 ? zeroToolCalls / succeeded.length : null,
    invalidArgumentRate: toolCalls > 0 ? invalidArguments / toolCalls : null,
    promptTokens: succeeded.reduce((sum, sample) => sum + sample.promptTokens, 0),
    completionTokens: succeeded.reduce((sum, sample) => sum + sample.completionTokens, 0),
    p95ElapsedMs: p95Index >= 0 ? elapsed[p95Index] : null,
  };
}

function selfTest(): number {
  const summary = summarizeRequiredProbe([
    { status: "succeeded", toolCallCount: 1, invalidArgumentCount: 0, elapsedMs: 10, promptTokens: 20, completionTokens: 5 },
    { status: "succeeded", toolCallCount: 0, invalidArgumentCount: 0, elapsedMs: 30, promptTokens: 20, completionTokens: 4 },
    { status: "succeeded", toolCallCount: 2, invalidArgumentCount: 1, elapsedMs: 20, promptTokens: 20, completionTokens: 8 },
    { status: "failed", toolCallCount: 0, invalidArgumentCount: 0, elapsedMs: 40, promptTokens: 0, completionTokens: 0 },
  ]);
  assert.equal(summary.requested, 4);
  assert.equal(summary.succeeded, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.zeroToolCalls, 1);
  assert.equal(summary.zeroToolCallRate, 1 / 3);
  assert.equal(summary.toolCalls, 3);
  assert.equal(summary.invalidArguments, 1);
  assert.equal(summary.invalidArgumentRate, 1 / 3);
  assert.equal(summary.promptTokens, 60);
  assert.equal(summary.completionTokens, 17);
  assert.equal(summary.p95ElapsedMs, 30);

  const noSuccess = summarizeRequiredProbe([
    { status: "failed", toolCallCount: 0, invalidArgumentCount: 0, elapsedMs: 1, promptTokens: 0, completionTokens: 0 },
  ]);
  assert.equal(noSuccess.zeroToolCallRate, null);
  assert.equal(noSuccess.invalidArgumentRate, null);
  console.log("S1 required probe self-test: 13 assertions passed; failed samples are excluded, zero denominators stay null.");
  return 0;
}

function samplesPerModel(): number {
  const index = process.argv.indexOf("--samples-per-model");
  if (index < 0) return 100;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 100 || value > 200) {
    throw new Error("--samples-per-model must be an integer from 100 to 200 for a decision-grade probe");
  }
  return value;
}

function probeDelayMs(): number {
  const index = process.argv.indexOf("--delay-ms");
  if (index < 0) return 0;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 60_000) {
    throw new Error("--delay-ms must be an integer from 0 to 60000");
  }
  return value;
}

function repositoryRoot(): string {
  return resolve(process.cwd(), "../..");
}

function resolveConfigPath(root: string): void {
  const configured = process.env.AI_PLATFORMS_CONFIG;
  if (!configured) {
    process.env.AI_PLATFORMS_CONFIG = resolve(root, "config/ai-platforms.json");
    return;
  }
  if (!isAbsolute(configured)) {
    const fromWorkingDirectory = resolve(process.cwd(), configured);
    process.env.AI_PLATFORMS_CONFIG = existsSync(fromWorkingDirectory)
      ? fromWorkingDirectory
      : resolve(root, configured);
  }
}

function safeError(error: unknown): {
  readonly name: string;
  readonly httpStatus: number | null;
  readonly code: string | null;
  readonly providerCode: string | null;
} {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", httpStatus: null, code: null, providerCode: null };
  }
  const shaped = error as Error & { status?: unknown; code?: unknown; providerCode?: unknown };
  return {
    name: error.name.slice(0, 80),
    httpStatus: typeof shaped.status === "number" ? shaped.status : null,
    code: typeof shaped.code === "string" ? shaped.code.slice(0, 80) : null,
    providerCode: typeof shaped.providerCode === "string" ? shaped.providerCode.slice(0, 120) : null,
  };
}

async function runModelProbe(
  target: { readonly label: string; readonly capability: "agent_turn" | "companion_fallback" },
  samples: number,
  toolSchemas: AgentTurnRequest["tools"],
  options: { readonly resumeSamples?: readonly Record<string, unknown>[]; readonly delayMs?: number } = {},
): Promise<Record<string, unknown>> {
  const platform = resolveSystemPlatform(target.capability);
  if (!platform) throw new Error("Capability " + target.capability + " has no configured external model");
  const provider = createProvider(platform.type, {
    apiKey: platform.apiKey,
    baseUrl: platform.baseUrl,
    model: platform.model,
    modelProfile: platform.modelProfile,
    options: platform.options,
  });
  if (!provider.executeAgentTurn) throw new Error("Configured provider does not implement executeAgentTurn");
  const sampleRows: Array<Record<string, unknown>> = [...(options.resumeSamples ?? [])];
  const tallyRows: RequiredProbeSample[] = sampleRows.map((sample) => ({
    status: sample.status === "succeeded" ? "succeeded" : "failed",
    toolCallCount: typeof sample.toolCallCount === "number" ? sample.toolCallCount : 0,
    invalidArgumentCount: typeof sample.invalidArgumentCount === "number" ? sample.invalidArgumentCount : 0,
    elapsedMs: typeof sample.elapsedMs === "number" ? sample.elapsedMs : 0,
    promptTokens: typeof sample.promptTokens === "number" ? sample.promptTokens : 0,
    completionTokens: typeof sample.completionTokens === "number" ? sample.completionTokens : 0,
  }));
  const firstIndex = sampleRows.reduce((largest, sample) => (
    typeof sample.index === "number" ? Math.max(largest, sample.index) : largest
  ), 0) + 1;
  let successfulCount = tallyRows.filter((sample) => sample.status === "succeeded").length;
  let consecutiveErrors = 0;

  console.log("S1 start " + target.label + ": capability=" + target.capability
    + ", model=" + platform.model + ", tools=" + toolSchemas.length + ", validSamples=" + samples
    + (firstIndex > 1 ? ", resumeAtAttempt=" + firstIndex : "")
    + (options.delayMs ? ", delayMs=" + options.delayMs : ""));

  for (let index = firstIndex; index <= samples * 2 && successfulCount < samples; index += 1) {
    if (options.delayMs && index > firstIndex) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, options.delayMs));
    }
    const startedAt = performance.now();
    try {
      const request: AgentTurnRequest = {
        role: AgentRole.COMPANION_AGENT,
        systemPrompt: "This is a synthetic provider compliance probe. Use the supplied tool definitions. Never invent user data. The requested note id is a synthetic fixture id.",
        messages: [{
          role: "user",
          content: "Probe " + index + ": call companion_read_note with noteId 11111111-1111-4111-8111-111111111111. Do not answer in prose.",
        }],
        tools: toolSchemas,
        toolChoice: "required",
        maxTokens: 128,
        temperature: 0.3,
        model: platform.model,
      };
      const response = await provider.executeAgentTurn(request, AbortSignal.timeout(60_000));
      const calls = response.toolCalls ?? [];
      const invalidArgumentCount = calls.filter((call) => (
        !validateCompanionAgentToolArguments(call.name, call.arguments).success
      )).length;
      const elapsedMs = Math.round(performance.now() - startedAt);
      const sample = {
        status: "succeeded" as const,
        toolCallCount: calls.length,
        invalidArgumentCount,
        elapsedMs,
        promptTokens: response.usage?.promptTokens ?? 0,
        completionTokens: response.usage?.completionTokens ?? 0,
      };
      consecutiveErrors = 0;
      successfulCount += 1;
      tallyRows.push(sample);
      sampleRows.push({ index, ...sample, finishReason: response.finishReason });
    } catch (error) {
      const elapsedMs = Math.round(performance.now() - startedAt);
      consecutiveErrors += 1;
      const details = safeError(error);
      tallyRows.push({
        status: "failed",
        toolCallCount: 0,
        invalidArgumentCount: 0,
        elapsedMs,
        promptTokens: 0,
        completionTokens: 0,
      });
      sampleRows.push({ index, status: "failed", elapsedMs, ...details });
      if (index === 1 || consecutiveErrors === 3) {
        console.error(target.label + " provider error: name=" + details.name
          + ", httpStatus=" + (details.httpStatus ?? "unknown")
          + ", providerCode=" + (details.providerCode ?? "unknown")
          + ", code=" + (details.code ?? "unknown"));
      }
    }

    if (index % 10 === 0 || successfulCount === samples) {
      const current = summarizeRequiredProbe(tallyRows);
      console.log(target.label + " valid=" + current.succeeded + "/" + samples + " attempts=" + index
        + ": succeeded=" + current.succeeded
        + ", errors=" + current.failed
        + ", zero-tool=" + current.zeroToolCalls + "/" + current.succeeded
        + ", tool-calls=" + current.toolCalls);
    }
    if (consecutiveErrors >= 3) {
      console.error(target.label + " stopped after three consecutive provider errors; this is not a model result.");
      break;
    }
  }

  const summary = summarizeRequiredProbe(tallyRows);
  return {
    label: target.label,
    capability: target.capability,
    providerType: platform.type,
    modelId: platform.model,
    offeredToolCount: toolSchemas.length,
    summary,
    samples: sampleRows,
  };
}

async function runRuntimeFallbackSmoke(
  toolSchemas: AgentTurnRequest["tools"],
): Promise<Record<string, unknown>> {
  const primaryPlatform = resolveSystemPlatform("agent_turn");
  const fallbackPlatform = resolveSystemPlatform("companion_fallback");
  if (!primaryPlatform || !fallbackPlatform) {
    throw new Error("Primary or cross-model fallback provider is not configured");
  }
  const primary = createProvider(primaryPlatform.type, {
    apiKey: primaryPlatform.apiKey,
    baseUrl: primaryPlatform.baseUrl,
    model: primaryPlatform.model,
    modelProfile: primaryPlatform.modelProfile,
    options: primaryPlatform.options,
  });
  const fallback = createProvider(fallbackPlatform.type, {
    apiKey: fallbackPlatform.apiKey,
    baseUrl: fallbackPlatform.baseUrl,
    model: fallbackPlatform.model,
    modelProfile: fallbackPlatform.modelProfile,
    options: fallbackPlatform.options,
  });
  if (!primary.executeAgentTurn || !fallback.executeAgentTurn) {
    throw new Error("Configured providers do not implement executeAgentTurn");
  }

  const { executeCompanionAgentTurnWithToolChoiceFallback } = await import(
    "../src/handlers/companion-tool-call-ledger.ts"
  );
  const request: AgentTurnRequest = {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: "This is a synthetic provider compliance probe. Use the supplied tool definitions. Never invent user data. The requested note id is a synthetic fixture id.",
    messages: [{
      role: "user",
      content: "Call companion_read_note with noteId 11111111-1111-4111-8111-111111111111. Do not answer in prose.",
    }],
    tools: toolSchemas,
    toolChoice: "required",
    maxTokens: 128,
    temperature: 0.3,
  };

  let fallbackReason: string | null = null;
  const startedAt = performance.now();
  try {
    const execution = await executeCompanionAgentTurnWithToolChoiceFallback({
      request,
      provider: primary,
      fallbackProvider: fallback,
      signal: AbortSignal.timeout(90_000),
      executeTurn: (provider, request, signal) => provider.executeAgentTurn!(request, signal),
      onFallback: (error) => { fallbackReason = error.providerCode; },
    });
    const calls = execution.result.toolCalls ?? [];
    return {
      status: "succeeded",
      primaryModelId: primaryPlatform.model,
      configuredFallbackModelId: fallbackPlatform.model,
      actualModelId: execution.provider.modelId,
      fallbackUsed: execution.provider === fallback,
      fallbackReason,
      toolCallCount: calls.length,
      invalidArgumentCount: calls.filter((call) => (
        !validateCompanionAgentToolArguments(call.name, call.arguments).success
      )).length,
      elapsedMs: Math.round(performance.now() - startedAt),
      promptTokens: execution.result.usage?.promptTokens ?? 0,
      completionTokens: execution.result.usage?.completionTokens ?? 0,
    };
  } catch (error) {
    return {
      status: "failed",
      primaryModelId: primaryPlatform.model,
      configuredFallbackModelId: fallbackPlatform.model,
      fallbackUsed: fallbackReason !== null,
      fallbackReason,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: safeError(error),
    };
  }
}

async function main(): Promise<number> {
  if (process.argv.includes("--self-test")) return selfTest();
  const root = repositoryRoot();
  resolveConfigPath(root);
  const targets = [
    { label: "qwen", capability: "agent_turn" as const },
    { label: "glm", capability: "companion_fallback" as const },
  ];
  if (process.argv.includes("--preflight")) {
    const tools = resolveAllCompanionAgentTools("full", { visionEnabled: false });
    for (const target of targets) {
      const platform = resolveSystemPlatform(target.capability);
      console.log(target.label + ": " + (platform
        ? "provider=" + platform.type + ", model=" + platform.model + ", apiKeyConfigured=" + Boolean(platform.apiKey)
        : "external provider unavailable"));
    }
    console.log("Tool schemas=" + tools.length + ", companion_read_note="
      + tools.some((tool) => tool.name === "companion_read_note"));
    return 0;
  }
  const smokeTarget = process.argv.includes("--smoke-qwen")
    ? "qwen"
    : process.argv.includes("--smoke-glm") ? "glm" : null;
  const runtimeFallbackSmoke = process.argv.includes("--smoke-runtime-fallback");
  const decisionProbe = process.argv.includes("--required-real-model-probe");
  const fallbackDecisionProbe = process.argv.includes("--required-fallback-probe");
  const resumeIndex = process.argv.indexOf("--resume-from");
  const resumePath = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined;
  if (resumeIndex >= 0 && !resumePath) throw new Error("--resume-from requires an artifact path");
  if (resumePath && (!fallbackDecisionProbe || decisionProbe || smokeTarget || runtimeFallbackSmoke)) {
    throw new Error("--resume-from is only supported with --required-fallback-probe");
  }
  if (!decisionProbe && !fallbackDecisionProbe && !smokeTarget && !runtimeFallbackSmoke) {
    console.log("Use --self-test, --preflight, --smoke-qwen/--smoke-glm/--smoke-runtime-fallback, --required-fallback-probe --samples-per-model 100 [--resume-from artifact.json] [--delay-ms 6000], or --required-real-model-probe --samples-per-model 100.");
    return 0;
  }
  if (process.env.REAL_MODEL_BATCH !== "1") {
    console.error("Refusing paid requests: set REAL_MODEL_BATCH=1 explicitly for this synthetic probe.");
    return 1;
  }

  const sampleCount = smokeTarget || runtimeFallbackSmoke ? 1 : samplesPerModel();
  const toolSchemas: AgentTurnRequest["tools"] = resolveAllCompanionAgentTools("full", { visionEnabled: false })
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
  if (toolSchemas.length === 0 || !toolSchemas.some((tool) => tool.name === "companion_read_note")) {
    throw new Error("Production companion tool registry is empty or missing companion_read_note");
  }

  if (runtimeFallbackSmoke) {
    const result = await runRuntimeFallbackSmoke(toolSchemas);
    const artifactDir = resolve(root, ".impeccable/companion");
    await mkdir(artifactDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const artifactPath = resolve(artifactDir, "s1-runtime-fallback-smoke-" + stamp + ".json");
    await writeFile(artifactPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: "runtime-fallback-smoke",
      toolChoice: "required",
      offeredToolCount: toolSchemas.length,
      result,
    }, null, 2) + "\n", "utf8");
    console.log("Runtime fallback smoke: " + JSON.stringify(result));
    console.log("Runtime fallback artifact: " + artifactPath);
    const completed = result.status === "succeeded"
      && result.fallbackUsed === true
      && result.fallbackReason === "MODEL_TOOL_CHOICE_NOT_SUPPORTED"
      && typeof result.toolCallCount === "number"
      && result.toolCallCount > 0;
    if (!completed) {
      console.error("Runtime fallback smoke did not prove a required tool call on the configured cross-model fallback.");
      return 1;
    }
    return 0;
  }

  const selectedTargets = fallbackDecisionProbe
    ? targets.filter((target) => target.label === "glm")
    : targets.filter((target) => smokeTarget === null || target.label === smokeTarget);
  const modelResults: Record<string, unknown>[] = [];
  let resumeSamples: readonly Record<string, unknown>[] | undefined;
  if (resumePath) {
    const resumeFile = resolve(process.cwd(), resumePath);
    const priorArtifact = JSON.parse(await readFile(resumeFile, "utf8")) as {
      mode?: unknown;
      models?: Array<{ label?: unknown; modelId?: unknown; samples?: unknown }>;
    };
    const priorModel = priorArtifact.models?.find((model) => model.label === "glm");
    if (!priorModel
      || priorArtifact.mode !== "decision-grade-fallback-only"
      || priorModel.modelId !== resolveSystemPlatform("companion_fallback")?.model
      || !Array.isArray(priorModel.samples)) {
      throw new Error("Resume artifact is not a compatible incomplete GLM fallback probe");
    }
    resumeSamples = priorModel.samples as Array<Record<string, unknown>>;
    const priorSuccesses = resumeSamples.filter((sample) => sample.status === "succeeded").length;
    if (priorSuccesses >= sampleCount) {
      throw new Error("Resume artifact already contains the requested number of successful samples");
    }
  }
  for (const target of selectedTargets) {
    const result = await runModelProbe(target, sampleCount, toolSchemas, {
      ...(resumeSamples ? { resumeSamples } : {}),
      delayMs: probeDelayMs(),
    });
    modelResults.push(result);
    const summary = result.summary as RequiredProbeSummary;
    if (summary.succeeded < sampleCount) break;
  }

  const artifactDir = resolve(root, ".impeccable/companion");
  await mkdir(artifactDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactPath = resolve(artifactDir, "s1-required-live-" + stamp + ".json");
  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: smokeTarget ? "smoke" : fallbackDecisionProbe ? "decision-grade-fallback-only" : "decision-grade",
    sampleCountPerModel: sampleCount,
    toolChoice: "required",
    offeredToolCount: toolSchemas.length,
    toolNames: toolSchemas.map((tool) => tool.name),
    models: modelResults,
  };
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  console.log("S1 required probe artifact: " + artifactPath);

  const summaries = modelResults.map((result) => result.summary as RequiredProbeSummary);
  const complete = modelResults.length === selectedTargets.length
    && summaries.every((summary) => summary.succeeded === sampleCount);
  for (const [index, target] of selectedTargets.entries()) {
    const summary = summaries[index];
    console.log(target.label + " final: zero-tool-call rate="
      + (summary.zeroToolCallRate === null ? "unavailable" : (summary.zeroToolCallRate * 100).toFixed(2) + "%")
      + ", invalid arguments=" + summary.invalidArguments + "/" + summary.toolCalls
      + ", tokens=" + summary.promptTokens + "+" + summary.completionTokens
      + ", provider errors=" + summary.failed
      + ", p95=" + (summary.p95ElapsedMs === null ? "unavailable" : summary.p95ElapsedMs + "ms"));
  }
  if (!complete) {
    console.error("Probe incomplete: fewer than " + sampleCount + " successful samples; provider errors do not count toward the 2% decision.");
    return 1;
  }
  if (smokeTarget) console.log("Smoke test passed; it is not a decision-grade sample.");
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath.endsWith("companion-s1-required-probe.ts")) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error("S1 required probe failed without exposing request content: "
      + (error instanceof Error ? error.name + ": " + error.message : "UnknownError"));
    process.exitCode = 1;
  });
}
