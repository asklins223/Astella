import { mkdirSync, writeFileSync } from "node:fs";
import { platform, observedProvider, root, safeFailure, type WireReceipt } from "./acceptance-common.ts";
import { buildCompanionPersonaMessages } from "../handlers/turn/companion-dialogue-content.ts";
import { runCompanionHybridEntry } from "../handlers/turn/companion-hybrid-entry.ts";

// The same real hybrid protocol, persona and synthetic requests on both declared
// routes. Queue/UI timings remain separate; shared upstream load is retained.
const dir = `${root}outputs/audits/plan57-58-completion-2026-10-21`;
mkdirSync(dir, { recursive: true });
const output = `${dir}/provider-comparison-${Date.now()}.json`;
const samples: Record<string, unknown>[] = [];
const prompts = ["晚上好，今天学得有点累。只回复一句。", "我叫阿树，今天总算把难题做出来了。只回复一句。", "我打算先喝口水再继续。简短回应就好。"];
const routes = { primary: platform("agent_turn"), fallback: platform("companion_fallback") };
const persist = () => writeFileSync(output, JSON.stringify({ synthetic: true, comparison: "identical hybrid requests, alternating route order; no queue or UI", samples }, null, 2));
for (let repeat = 0; repeat < 4; repeat++) for (const text of prompts) {
  for (const name of repeat % 2 ? ["fallback", "primary"] as const : ["primary", "fallback"] as const) {
    const wire: WireReceipt[] = [], started = Date.now();
    const route = routes[name], provider = observedProvider(route, `p58-comparison-${repeat}`, wire);
    const messages = buildCompanionPersonaMessages({ userText: text, recentMessages: [], pageContext: null, petProfile: null });
    const record: Record<string, unknown> = { name, repeat, text, model: route.model, status: "running" }; samples.push(record); persist();
    let firstTextMs: number | null = null;
    try {
      const result = await runCompanionHybridEntry({ provider,
        turnPolicy: String(messages[0]!.content), messages: messages.filter(message => message.role !== "system"),
        signal: AbortSignal.timeout(90_000), deadlineAt: Date.now() + 90_000,
        onProviderDelta: async delta => { if (delta.trim()) firstTextMs ??= Date.now() - started; return true; } });
      // A short response is released at completion under the real hold policy.
      // The hybrid callback alone would incorrectly record these as no text.
      if (result.facts.decision === "reply" && result.prefetched?.result.content && firstTextMs === null) firstTextMs = Date.now() - started;
      Object.assign(record, { status: result.facts.decision, visible: result.prefetched?.result.content ?? null, firstTextMs, elapsedMs: Date.now() - started, wire });
      console.log(JSON.stringify({ name, repeat, decision: result.facts.decision, firstTextMs, elapsedMs: record.elapsedMs }));
    } catch (error) {
      Object.assign(record, { status: "failed", failure: safeFailure(error), firstTextMs, elapsedMs: Date.now() - started, wire });
      console.log(JSON.stringify({ name, repeat, status: "failed", failure: record.failure }));
    }
    persist();
  }
}
console.log(`Evidence: ${output}`);
