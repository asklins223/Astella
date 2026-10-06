import assert from "node:assert/strict";
import { test } from "node:test";
import { executeAgentStep } from "../execute-step.ts";
import type { AgentTurnRequest, AgentTurnResult } from "@astella/shared";

const request: AgentTurnRequest = { role: "companion_agent", systemPrompt: "test", messages: [{ role: "user", content: "task" }], tools: [], toolChoice: "auto", maxTokens: 200, temperature: 0 };
const response: AgentTurnResult = { content: "", toolCalls: [1,2,3].map(id => ({ id: String(id), name: "read", arguments: {} })), finishReason: "tool_calls", usage: null, providerRequestId: null };
test("a saved response precedes all effects and surplus calls still receive tool replies", async () => {
  const trace: string[] = [];
  await executeAgentStep({ context: { prepare: async () => request },
    state: { prepare: async input => ({ request: input, checkpoint: "step", response: null }),
      saveResponse: async () => { trace.push("saved"); }, apply: async (_step, _response, results) => { assert.equal(results.length, 3); trace.push("applied"); } },
    model: { execute: async () => { trace.push("model"); return response; } },
    capabilities: { maxCalls: 2, invoke: async (call, allowed) => { trace.push(`${call.id}:${allowed}`); return { accepted: allowed }; } },
  });
  assert.deepEqual(trace, ["model", "saved", "1:true", "2:true", "3:false", "applied"]);
});
test("resume uses the saved response without a second model call", async () => {
  await executeAgentStep({ context: { prepare: async () => request },
    state: { prepare: async input => ({ request: input, checkpoint: "step", response }), saveResponse: async () => { throw new Error("unexpected save"); },
      apply: async () => "resumed" }, model: { execute: async () => { throw new Error("unexpected model call"); } },
    capabilities: { maxCalls: 4, invoke: async () => ({ status: "succeeded" }) },
  });
});
test("cancellation after checkpoint persistence blocks every effect", async () => {
  const abort = new AbortController();
  await assert.rejects(executeAgentStep({ signal: abort.signal, context: { prepare: async () => request },
    state: { prepare: async input => ({ request: input, checkpoint: "step", response: null }),
      saveResponse: async () => { abort.abort(new Error("cancelled")); }, apply: async () => { throw new Error("unexpected apply"); } },
    model: { execute: async () => response }, capabilities: { maxCalls: 4, invoke: async () => { throw new Error("unexpected effect"); } },
  }), /cancelled/);
});
