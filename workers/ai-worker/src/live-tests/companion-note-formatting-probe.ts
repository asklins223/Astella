import assert from "node:assert/strict";
import { resolveAllCompanionAgentTools } from "@astella/shared";
import { interpretCompanionTurn } from "../handlers/companion-tool-intent.ts";
import { closeDatabase } from "../db.ts";
import { platform, observedProvider, save, type WireReceipt } from "./acceptance-common.ts";

// Synthetic current-note context. This probes real-model interpretation, not production persistence.
const route = platform("agent_turn"), wire: WireReceipt[] = [], results: unknown[] = [];
const provider = observedProvider(route, "note-formatting", wire);
const note = { kind: "note_version" as const, id: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222" };
const cases = [
  { text: "调整下这篇笔记的格式规范，例如代码的要转成代码块，标题的要转标题", act: true },
  { text: "改一下这篇笔记的格式规范，例如代码的要转成代码块，标题的要转标题", act: true },
  { text: "把全文排版整理一下，内容别删", act: true },
  { text: "这些标题应该是标题，不要只是大号加粗，帮我调整好", act: true },
  { text: "你刚刚只是分析了问题，现在直接调整全文", act: true },
  { text: "这篇笔记的格式有哪些问题？先别改", act: false },
  { text: "只给我一些排版建议，不要改正文", act: false },
  { text: "标题和代码块应该怎么设置？", act: false },
];
try {
  for (const item of cases) {
    const started = Date.now();
    const result = await interpretCompanionTurn(provider, [
      { role: "assistant", content: "我看到了标题只是大号加粗、代码混在普通段落里，还没有修改正文。" },
      { role: "user", content: item.text },
    ], { job: { id: "synthetic-note-formatting", workspaceId: "33333333-3333-4333-8333-333333333333",
      requestedBy: "44444444-4444-4444-8444-444444444444", leaseToken: "synthetic", signal: new AbortController().signal },
      runId: "55555555-5555-4555-8555-555555555555", userId: "44444444-4444-4444-8444-444444444444",
      permissionLevel: "full", objects: [note], capabilities: resolveAllCompanionAgentTools("full").map(tool => tool.name),
      currentActiveTransaction: () => undefined, verifyAttempt: async () => true });
    const ok = item.act ? result.toolUse === "act" && result.candidateOperations.includes("companion_edit_note")
      && result.goalRelation === "unrelated" : result.toolUse !== "act" && !result.candidateOperations.includes("companion_edit_note");
    results.push({ ...item, ok, result, elapsedMs: Date.now() - started });
    save("note-formatting-routing-20261009", { model: route.model, results, wire });
    console.log(JSON.stringify({ text: item.text, ok, toolUse: result.toolUse, operations: result.candidateOperations }));
  }
  assert.ok(results.every(result => (result as { ok: boolean }).ok));
} finally { await closeDatabase(); }
