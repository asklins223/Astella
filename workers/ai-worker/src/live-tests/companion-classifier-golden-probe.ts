/**
 * 黄金集真实模型跑分（显式付费调用）。REAL_MODEL_BATCH=1 才跑；结果写
 * outputs/audits/2026-10-07-live/classifier-golden-<suffix>.json。
 */
import { platform, observedProvider, save, type WireReceipt } from "./acceptance-common.ts";
import { resolveAllCompanionAgentTools } from "@astella/shared";
import { interpretCompanionTurn } from "../handlers/tools/companion-tool-intent.ts";
import { closeDatabase } from "../db.ts";
import { CLASSIFIER_GOLDEN_CASES } from "./companion-classifier-golden.ts";

const route = platform("agent_turn");
const wire: WireReceipt[] = [];
const provider = observedProvider(route, "classifier-golden", wire);
const suffix = process.env.LIVE_GOLDEN_SUFFIX ?? "v1";
const capabilities = resolveAllCompanionAgentTools("full").map(tool => tool.name);
const results: unknown[] = [];
let passed = 0;
try {
  for (const item of CLASSIFIER_GOLDEN_CASES) {
    const started = Date.now();
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (item.recentReply) messages.push({ role: "assistant", content: item.recentReply });
    messages.push({ role: "user", content: item.text });
    const result = await interpretCompanionTurn(provider, messages, {
      job: { id: "synthetic-golden-job", workspaceId: "33333333-3333-4333-8333-333333333333",
        requestedBy: "44444444-4444-4444-8444-444444444444", leaseToken: "synthetic", signal: new AbortController().signal },
      runId: "55555555-5555-4555-8555-555555555555", userId: "44444444-4444-4444-8444-444444444444",
      permissionLevel: "full", capabilities,
      currentActiveTransaction: () => undefined, verifyAttempt: async () => true,
    });
    const problems: string[] = [];
    if (result.toolUse !== item.expect.toolUse) problems.push(`toolUse=${result.toolUse} 期望 ${item.expect.toolUse}`);
    if (item.expect.candidatesAny && !item.expect.candidatesAny.some(name => result.candidateOperations.includes(name)))
      problems.push(`候选缺少 ${item.expect.candidatesAny.join("/")}（实际 ${result.candidateOperations.join(",") || "空"}）`);
    for (const name of item.expect.candidatesAll ?? [])
      if (!result.candidateOperations.includes(name)) problems.push(`候选缺少 ${name}`);
    if (item.expect.goalRelation && result.goalRelation !== item.expect.goalRelation)
      problems.push(`goalRelation=${result.goalRelation} 期望 ${item.expect.goalRelation}`);
    if (item.expect.intent && result.intent !== item.expect.intent) problems.push(`intent=${result.intent} 期望 ${item.expect.intent}`);
    const ok = problems.length === 0;
    if (ok) passed += 1;
    results.push({ id: item.id, text: item.text, ok, problems, result, elapsedMs: Date.now() - started });
    save(`classifier-golden-${suffix}`, { model: route.model, passed, total: CLASSIFIER_GOLDEN_CASES.length, results });
    console.log(JSON.stringify({ id: item.id, ok, toolUse: result.toolUse, goalRelation: result.goalRelation,
      candidates: result.candidateOperations, problems }));
  }
  console.log(JSON.stringify({ done: true, passed, total: CLASSIFIER_GOLDEN_CASES.length,
    rate: `${Math.round((passed / CLASSIFIER_GOLDEN_CASES.length) * 100)}%` }));
} finally {
  await closeDatabase();
}
if (passed < CLASSIFIER_GOLDEN_CASES.length) process.exitCode = 1;
