import assert from "node:assert/strict";
import { resolveAllCompanionAgentTools } from "@astella/shared";
import { interpretCompanionTurn } from "../handlers/tools/companion-tool-intent.ts";
import { closeDatabase } from "../db.ts";
import { platform, observedProvider, save, type WireReceipt } from "./acceptance-common.ts";

// Synthetic classifier probe only; real HTTP/queue/artifact/window evidence is
// recorded separately. No user notes or conversation history are sent.
const route = platform("agent_turn");
const wire: WireReceipt[] = [];
const provider = observedProvider(route, "note-generation-routing", wire);
const note = { kind: "note_version" as const, id: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222" };
const results: unknown[] = [];
const cases = [
  { text: "给我生成这篇笔记的速看吧", toolUse: "act", handoff: true },
  { text: "生成拓展笔记", toolUse: "act", handoff: true },
  { text: "从这篇往外学，先生成草稿我挑，不要制卡", toolUse: "act", handoff: true },
  // 2026-10-19 线上：这句被交给后台目标，目标只能出速看/脑图/演示/拓展/制卡，
  // 结果交付摘要里写了"笔记"，库里一篇都没有。新建笔记必须在聊天轮里保存。
  { text: "给我生成几个历史的笔记", toolUse: "act", handoff: false, createNote: true },
  { text: "把刚才聊的电功率写成一篇笔记", toolUse: "act", handoff: false, createNote: true },
  { text: "帮我速看一下，在聊天里概括就好，不生成任何东西", toolUse: "read", handoff: false },
  { text: "往外学是什么意思？", toolUse: "none", handoff: false },
  { text: "今天不想学习", toolUse: "none", handoff: false },
] as const;

try {
  for (const item of cases) {
    const start = Date.now();
    const result = await interpretCompanionTurn(provider, [
      { role: "assistant", content: "速看和拓展能力没有接上，这轮只能在聊天里写文字。" },
      { role: "user", content: item.text },
    ], {
      job: { id: "synthetic-routing-job", workspaceId: "33333333-3333-4333-8333-333333333333",
        requestedBy: "44444444-4444-4444-8444-444444444444", leaseToken: "synthetic", signal: new AbortController().signal },
      runId: "55555555-5555-4555-8555-555555555555", userId: "44444444-4444-4444-8444-444444444444",
      permissionLevel: "full", objects: [note], capabilities: resolveAllCompanionAgentTools("full").map(tool => tool.name),
      currentActiveTransaction: () => undefined, verifyAttempt: async () => true,
    });
    const ok = result.toolUse === item.toolUse && result.candidateOperations.includes("agent_start_goal") === item.handoff
      && (!("createNote" in item) || result.candidateOperations.includes("companion_create_note"));
    results.push({ ...item, ok, result, elapsedMs: Date.now() - start });
    save("note-generation-routing-20261008", { model: route.model, results, wire });
    console.log(JSON.stringify({ text: item.text, ok, toolUse: result.toolUse, operations: result.candidateOperations }));
  }
  assert.ok(results.every(result => (result as { ok: boolean }).ok), "routing failures are preserved in the output artifact");
} finally {
  await closeDatabase();
}
