/** Public-provider live smoke: MiMo tool call, full reasoning replay, tool result and final answer.
 * Run in the worker's configured environment: tsx scripts/verify-mimo-agent.ts <workspaceId> <userId>
 * Prints metadata only; never logs prompts, reasoning text or credentials.
 */
import assert from "node:assert/strict";
import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import { createProvider } from "../src/lib/ai-provider.ts";
import { resolveAIGovernanceContext, resolveProviderForTask } from "../src/lib/governance.ts";

const [workspaceId, userId] = process.argv.slice(2);
if (!workspaceId || !userId) throw new Error("用法：verify-mimo-agent.ts <workspaceId> <userId>");
const governance = await resolveAIGovernanceContext(workspaceId, userId);
assert.ok(governance.consentOk && governance.policy.sendToExternal, "workspace has not authorized external model calls");
const selected = resolveProviderForTask(governance, "companion_agent");
assert.equal(selected.providerName, "mimo_responses");
const provider = createProvider(selected.providerName, selected.providerConfig);
assert.ok(provider.executeAgentTurn);
console.log("[mimo] provider=", provider.id, "model=", provider.modelId, "adapter=", provider.promptVersion);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("MiMo live verification timed out")), 120_000);
try {
  const request: AgentTurnRequest = {
    role: AgentRole.COMPANION_AGENT,
    systemPrompt: "验证协议：请调用 probe_lookup 查询后，根据结果用一句话回答。",
    messages: [{ role: "user", content: "调用查询工具，查询 protocol-check。" }],
    tools: [{ name: "probe_lookup", description: "Return a fixed verification value.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }],
    toolChoice: "auto", maxTokens: 1024, temperature: 0.2,
  };
  const first = await provider.executeAgentTurn(request, controller.signal);
  assert.ok(first.toolCalls.length > 0, "MiMo did not call the requested probe tool");
  assert.ok(first.reasoning?.length, "MiMo did not return reasoning to replay");
  console.log("[mimo:1] toolCalls=", first.toolCalls.length, "reasoningItems=", first.reasoning.length,
    "usage=", JSON.stringify(first.usage));
  const second = await provider.executeAgentTurn({ ...request, tools: [], messages: [
    ...request.messages,
    { role: "assistant", content: first.content ?? "", toolCalls: first.toolCalls, reasoning: first.reasoning },
    ...first.toolCalls.map(call => ({ role: "tool" as const, toolCallId: call.id, content: "验证值：协议续轮成功。" })),
  ] }, controller.signal);
  assert.ok(second.content?.trim(), "MiMo returned no final answer");
  assert.equal(second.toolCalls.length, 0);
  console.log("[mimo:2] PASS finalChars=", second.content!.length, "usage=", JSON.stringify(second.usage));
} finally { clearTimeout(timer); }
