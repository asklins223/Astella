/** Synthetic real-network smoke for the configured MiMo Agent and text providers.
 * node --env-file=../../.env --import tsx scripts/verify-pi-providers.ts
 * Prints metadata only. No database reads or writes, prompts or reasoning logs.
 */
import assert from "node:assert/strict";
import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import { resolveSystemPlatform } from "@astella/shared/platform-config-node";
import { createProvider } from "../src/lib/ai-provider.ts";
import { createCapabilityProvider } from "../src/lib/provider-factory.ts";
import { PiAgentProvider } from "../src/lib/providers/pi-agent.ts";

let failed = false;
for (const slot of ["agent_turn", "text_generation"] as const) {
  const selected = resolveSystemPlatform(slot);
  assert.ok(selected, `${slot} is not configured`);
  const provider = slot === "text_generation"
    ? createCapabilityProvider(selected.type, "text_generation", selected)
    : createProvider(selected.type, selected);
  assert.ok(provider instanceof PiAgentProvider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Pi live verification timed out")), 120_000);
  const start = Date.now();
  try {
    if (slot === "text_generation") {
      const json = await provider.chatCompletion([{ role: "user", content: 'Return the JSON object {"ok":true} only.' }],
        { responseFormat: "json_object", disableThinking: true }, controller.signal);
      assert.equal(JSON.parse(json.content).ok, true);
      console.log(JSON.stringify({ slot, provider: provider.id, model: provider.modelId,
        status: "passed", jsonOutput: true, durationMs: Date.now() - start, usage: json.usage }));
      continue;
    }
    const request: AgentTurnRequest = {
      role: AgentRole.COMPANION_AGENT,
      systemPrompt: "Protocol verification only. Call probe_lookup exactly once, then answer with its value in one short sentence.",
      messages: [{ role: "user", content: "Use probe_lookup to query protocol-check." }],
      tools: [{ name: "probe_lookup", description: "Read the verification value for a query.", parameters: {
        type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false,
      } }],
      toolChoice: "auto", maxTokens: 1024, temperature: 0.2,
    };
    const first = await provider.executeAgentTurn(request, controller.signal);
    assert.ok(first.toolCalls.length > 0, "model did not select the probe tool");
    assert.ok(first.toolCalls.every(call => call.name === "probe_lookup"));
    assert.ok(first.reasoning?.length, "model did not return replayable reasoning");
    const continuation: AgentTurnRequest = { ...request, tools: [], messages: [
      ...request.messages,
      { role: "assistant", content: first.content ?? "", toolCalls: first.toolCalls, reasoning: first.reasoning },
      ...first.toolCalls.map(call => ({ role: "tool" as const, toolCallId: call.id, content: "Pi protocol round trip succeeded." })),
    ] };
    let chars = 0, thinkingChars = 0;
    const second = await provider.chatCompletionStream([], { nativeAgentRequest: continuation, responseFormat: "text",
      onReasoningDelta: delta => { thinkingChars += delta.length; } }, controller.signal, delta => { chars += delta.length; });
    assert.ok(second.content.trim());
    assert.equal(chars, second.content.length);
    assert.equal(second.toolCalls?.length, 0);
    console.log(JSON.stringify({ slot, provider: provider.id, model: provider.modelId, adapter: provider.promptVersion,
      status: "passed", durationMs: Date.now() - start, toolCalls: first.toolCalls.length, reasoningItems: first.reasoning.length,
      streamedChars: chars, thinkingChars, usage: second.usage }));
  } catch (error) {
    failed = true;
    const safe = error as { name?: string; code?: string; status?: number; providerCode?: string; message?: string };
    console.log(JSON.stringify({ slot, status: "failed", durationMs: Date.now() - start,
      error: { name: safe.name, code: safe.code, status: safe.status, providerCode: safe.providerCode,
        ...(safe.name === "AssertionError" ? { assertion: safe.message } : {}) } }));
  } finally { clearTimeout(timer); }
}
if (failed) process.exitCode = 1;
