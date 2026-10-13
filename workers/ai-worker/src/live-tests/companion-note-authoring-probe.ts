import assert from "node:assert/strict";
import type { ReasoningEffort } from "@astella/shared/platform-config";
import { platform, observedProvider, save, type WireReceipt } from "./acceptance-common.ts";
import { fixture, readContext, closeFixtureDatabase } from "./runtime-fixture.ts";
import { withWorkspaceTransaction, closeDatabase as closeApiDatabase } from "../../../../apps/api/src/db/client.ts";
import { createNote } from "../../../../apps/api/src/modules/note/service.ts";
import { buildCompanionPersonaMessages } from "../handlers/companion-dialogue-content.ts";
import { runCompanionAgentLoop } from "../handlers/companion-agent-runtime.ts";
import { createGovernedProvider } from "../lib/governance.ts";
import { createCompanionContextReceipts } from "../handlers/companion-context-receipts.ts";
import { reserveCompanionProviderCall } from "../handlers/companion-agent-events.ts";
import { createCompanionStreamDelivery } from "../handlers/companion-dialogue-stream.ts";

// Full real model/tool loop with synthetic knowledge and a scoped disposable
// account. HTTP queue/UI evidence is recorded separately.
if (!new URL(process.env.DATABASE_URL_MIGRATOR!).pathname.startsWith("/astella_note_authoring_"))
  throw new Error("Use an isolated astella_note_authoring_* database");
const configuredRoute = platform("agent_turn");
const requestedEffort = process.env.LIVE_PROBE_EFFORT;
if (requestedEffort && !configuredRoute.modelProfile?.reasoning?.levels.includes(requestedEffort as ReasoningEffort))
  throw new Error("LIVE_PROBE_EFFORT must be a reasoning level declared for agent_turn");
const route = requestedEffort
  ? { ...configuredRoute, modelProfile: { ...configuredRoute.modelProfile!, reasoning: {
      ...configuredRoute.modelProfile!.reasoning!, default: requestedEffort as ReasoningEffort,
    } } }
  : configuredRoute;
const wire: WireReceipt[] = [];
const f = await fixture();
// This probe verifies autonomous note creation. Its random disposable account
// explicitly uses the full permission level so no real user's confirmation is
// bypassed and the test can verify the saved note end to end.
await f.mutate(tx => tx`UPDATE user_companion_account_state
  SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb)
  WHERE user_id=${f.event.read.userId}`);
const text = "把刚才聊的电功率总结成一篇笔记给我，区分固定电压和固定电流，并链接库内相关的笔记。";
const history = [
  { role: "user" as const, text: "电功率与电阻的关系是什么？" },
  { role: "assistant" as const, text: "直流纯电阻负载有P=UI。固定U且R>0时，P=U²/R，P随R增大而减小；固定I时，P=I²R，P随R增大而增大。比较的是不同R的负载，不能说比较R时还要求R不变。" },
];
try {
  const scope = { workspaceId: f.event.ctx.workspaceId, userId: f.event.read.userId };
  const related = await withWorkspaceTransaction(scope, tx => createNote(tx, scope.workspaceId, scope.userId, {
    title: "欧姆定律的条件", blocks: [{ type: "paragraph", content: "在温度和几何条件不变的欧姆导体中，U=IR，其中U是电压、I是电流、R是电阻，电流与电压成正比。一般工作点的比值R=U/I只在I不等于零时定义，不能把它称作无条件的欧姆定律。" }],
  }));
  assert.ok(related);
  await f.mutate(tx => tx`UPDATE companion_messages SET blocks=${tx.json([{type:"text",text}])} WHERE id=${f.messageId}`);
  const read = { ...readContext(f), userText: text, recentMessages: history };
  const receipts = createCompanionContextReceipts();
  const provider = createGovernedProvider(observedProvider(route,"note-authoring-live",wire), { consentOk:true,
    policy:{sendToExternal:true,sendImageContent:false,piiDetection:false,auditLogging:false} }, scope.workspaceId,
  { userId:scope.userId,operation:"companion_agent",reserveCall:()=>reserveCompanionProviderCall({ctx:f.event.ctx,read}) }, receipts.pressureGate);
  const delivery = createCompanionStreamDelivery({job:f.event.ctx,ctx:f.event.ctx,read,
    expiresAt:new Date(Date.now()+120000).toISOString(),factSpanValues:{},notifyCompanionEvent:async()=>{}});
  const started = performance.now();
  let firstAgentTextDeltaMs: number | null = null;
  let firstPersistedVisibleTextMs: number | null = null;
  const reply = await runCompanionAgentLoop({ctx:f.event.ctx,read,provider,contextReceipts:receipts,
    toolConstraints:{visionEnabled:false},baseMessages:buildCompanionPersonaMessages({userText:text,recentMessages:history,
      pageContext:null,petProfile:null,scope}),expiresAt:new Date(Date.now()+120000).toISOString(),
    onProviderDelta:async delta=>{
      firstAgentTextDeltaMs ??= Math.round(performance.now()-started);
      const before=delivery.deliveredChars();
      const keepGoing=await delivery.onRawDelta(delta);
      if(before===0&&delivery.deliveredChars()>0)firstPersistedVisibleTextMs ??= Math.round(performance.now()-started);
      return keepGoing;
    }});
  assert.equal(reply.status,"completed");
  if (reply.status!=="completed") throw new Error("unexpected confirmation");
  await delivery.writeTail(reply.text);
  if(firstPersistedVisibleTextMs===null&&delivery.deliveredChars()>0)
    firstPersistedVisibleTextMs=Math.round(performance.now()-started);
  const streamed = await delivery.finish();
  assert.ok(streamed.ok);
  assert.equal(delivery.deliveredText(),reply.text);
  const [created] = await f.mutate(tx=>tx`SELECT n.id,n.title,n.current_version_id,
    string_agg(b.content,E'\n\n' ORDER BY b.ordinal) AS body FROM notes n JOIN note_blocks b ON b.version_id=n.current_version_id
    WHERE n.id IN (SELECT (result_ref::jsonb->>'noteId')::uuid FROM companion_agent_tool_calls WHERE run_id=${read.runId} AND name='companion_create_note' AND status='succeeded') AND n.workspace_id=${scope.workspaceId} GROUP BY n.id`);
  const calls = await f.mutate(tx=>tx`SELECT name,status,result_ref FROM companion_agent_tool_calls WHERE run_id=${read.runId} ORDER BY created_at`);
  const [run] = await f.mutate(tx=>tx`SELECT step_count,tool_call_count,model_call_count,turn_interpretation FROM companion_turn_runs WHERE id=${read.runId}`);
  const elapsedMs=Math.round(performance.now()-started);
  save(process.env.LIVE_PROBE_NAME ?? "note-authoring-live-20261008", {model:route.model,effort:requestedEffort??route.modelProfile?.reasoning?.default??null,
    reply,created,relatedNoteId:related.note.id,calls,run,wire,elapsedMs,firstAgentTextDeltaMs,firstPersistedVisibleTextMs,
    deliveredText:delivery.deliveredText()});
  assert.ok(created, "real note persistence required");
  assert.ok(created.body.includes(`astella-note:${related.note.id}`), "real library link required");
  console.log(JSON.stringify({ok:true,model:route.model,steps:run.step_count,tools:run.tool_call_count,
    savedNoteId:created.id,linkedNoteId:related.note.id,transports:wire.map(item=>item.transport),elapsedMs,
    firstAgentTextDeltaMs,firstPersistedVisibleTextMs,effort:requestedEffort??route.modelProfile?.reasoning?.default??null}));
} finally {
  await f.cleanup(); await closeFixtureDatabase(); await closeApiDatabase();
}
