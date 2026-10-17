import assert from "node:assert/strict";
import { AgentRole, getCompanionAgentTool } from "@astella/shared";
import { runStreamingAgentStep } from "../handlers/agent/companion-agent-streaming-step.ts";
import { platform, observedProvider, save, type WireReceipt } from "./acceptance-common.ts";

// Real configured provider, synthetic content, no executor and no note writes.
const route = platform("agent_turn"), wire: WireReceipt[] = [];
const provider = observedProvider(route, "write-progress-20261011", wire);
const definition = getCompanionAgentTool("companion_create_note")!;
const startedAt = Date.now();
const timeline: Array<{ kind: string; atMs: number }> = [];
const deltas: string[] = [];
const result = await runStreamingAgentStep({ provider, ctxSignal: new AbortController().signal,
  stepRequest: { role: AgentRole.COMPANION_AGENT, systemPrompt: "执行当前用户任务，只调用提供的保存工具。生成完整笔记正文；不输出工具名或参数解释。",
    messages: [{ role: "user", content: "用中文写一篇约1200字的光合作用学习笔记，用标题、表格、例子解释光反应与碳固定，保存为独立笔记。这里是合成回归测试，links留空。" }],
    tools: [{ name: definition.name, description: definition.description, parameters: definition.parameters }],
    toolChoice: "required", maxTokens: route.modelProfile?.maxOutputTokens ?? 32768, temperature: 0.4 },
  timeoutMs: 15 * 60_000, deferPublication: true,
  onProviderDelta: async text => { deltas.push(text); return true; },
  onToolCallStarted: () => { timeline.push({ kind: "named_item", atMs: Date.now() - startedAt }); },
  onToolCallSettled: () => { timeline.push({ kind: "arguments_complete", atMs: Date.now() - startedAt }); },
});
timeline.push({ kind: "response_complete", atMs: Date.now() - startedAt });
assert.equal(result.toolCalls?.[0]?.name, definition.name);
assert.equal(deltas.length, 0, "preparation must never claim a completed write");
assert.ok(timeline.some(event => event.kind === "named_item"));
const receipt = { ok: true, model: route.model, timeline, argumentChars: JSON.stringify(result.toolCalls![0]!.arguments).length,
  scope: "real-provider-synthetic-write-no-execution", wire };
save("companion-write-stream-progress-20261011", receipt);
console.log(JSON.stringify(receipt));
