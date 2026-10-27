import { AgentRole, COMPANION_AGENT_TOOL_DEFINITIONS, type AgentTurnRequest } from "@astella/shared";
import { companionStepRuntimePolicy } from "../handlers/turn/companion-step-plan.ts";
import { platform, observedProvider, save } from "./acceptance-common.ts";

/**
 * Narrow-surface probe: same model, same prompt, same cases. The only change is
 * whether the step sees the full declared surface or six relevant tools.
 * It does not touch production routing.
 */
const route = platform("agent_turn");
const provider = observedProvider(route, "narrow-surface", []);
const RELEVANT = ["companion_attention_write", "companion_memory_write", "companion_persona_write",
  "companion_say", "companion_goals_write", "companion_open"];

type Probe = { name: string; text: string; accept: string[] };
const cases: Probe[] = [
  { name: "reminder", text: "明天上午九点提醒我复习线性代数。", accept: ["companion_attention_write"] },
  { name: "self_note", text: "你自己记一下：我最近在准备线性代数补考，这阵子先别催我刷题。", accept: ["companion_persona_write"] },
  { name: "say_two", text: "分两条跟我说：先说声早，再问我想先做哪件事。", accept: ["companion_say"] },
  { name: "forget", text: "把我刚才说的九点以后不想被打扰那条忘掉。", accept: ["companion_memory_write"] },
];
const REPS = 3;
type Row = { arm: "full" | "narrow"; case: string; called: string | null; ok: boolean; ms: number };
const rows: Row[] = [];

function toolsFor(arm: "full" | "narrow") {
  return COMPANION_AGENT_TOOL_DEFINITIONS.filter(d => arm === "full" || RELEVANT.includes(d.name))
    .map(d => ({ name: d.name, description: d.description, parameters: d.parameters }));
}
for (const arm of ["full", "narrow"] as const) {
  for (const item of cases) {
    for (let rep = 0; rep < REPS; rep += 1) {
      const tools = toolsFor(arm);
      const request: AgentTurnRequest = { role: AgentRole.COMPANION_AGENT,
        messages: [{ role: "user", content: item.text }],
        systemPrompt: companionStepRuntimePolicy({ permissionLevel: "full", toolCount: tools.length,
          stepBudget: 1, finalAnswerOnly: false, attentionIntent: "task" }),
        tools, toolChoice: "auto",
        maxTokens: route.modelProfile?.maxOutputTokens ?? 8192, temperature: 0.2,
        disableThinking: true };
      const start = Date.now();
      const result = await provider.executeAgentTurn!(request, new AbortController().signal);
      const called = (result.toolCalls ?? [])[0]?.name ?? null;
      const row = { arm, case: item.name, called, ok: !!called && item.accept.includes(called), ms: Date.now() - start };
      rows.push(row);
      save("narrow-surface-20261027", { model: route.model, rows });
      console.log(JSON.stringify(row));
    }
  }
}
const summarise = (arm: "full" | "narrow") => {
  const subset = rows.filter(r => r.arm === arm);
  const called = subset.filter(r => r.called !== null).length;
  const ok = subset.filter(r => r.ok).length;
  return { arm, n: subset.length, called, callRate: called / subset.length, accepted: ok, acceptRate: ok / subset.length,
    wrong: subset.filter(r => r.called && !r.ok).map(r => `${r.case}→${r.called}`) };
};
console.log(JSON.stringify({ summary: [summarise("full"), summarise("narrow")] }, null, 1));
