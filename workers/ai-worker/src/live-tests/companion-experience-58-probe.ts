import assert from "node:assert/strict";
import type { ReasoningEffort } from "@astella/shared/platform-config";
import { platform, observedProvider, save, type WireReceipt } from "./acceptance-common.ts";
import { fixture, readContext, closeFixtureDatabase } from "./runtime-fixture.ts";
import { withWorkspaceTransaction, closeDatabase as closeApiDatabase } from "../../../../apps/api/src/db/client.ts";
import { createPrivateNoteRecords } from "@astella/agent-host";
import { buildCompanionPersonaMessages } from "../handlers/turn/companion-dialogue-content.ts";
import { runCompanionAgentLoop } from "../handlers/agent/companion-agent-runtime.ts";
import { createGovernedProvider } from "../lib/governance.ts";
import { createCompanionContextReceipts } from "../handlers/context/companion-context-receipts.ts";
import { reserveCompanionProviderCall } from "../handlers/agent/companion-agent-events.ts";
import { createCompanionStreamDelivery } from "../handlers/turn/companion-dialogue-stream.ts";
import { stripVoiceExpressionTags } from "@astella/shared/voice-expression-tags";
import { companionVisibleCharacterCount } from "../handlers/turn/companion-note-length.ts";

// Full real model/tool loop with synthetic knowledge and a scoped disposable
// account. HTTP queue/UI evidence is recorded separately.
if (!new URL(process.env.DATABASE_URL_MIGRATOR!).pathname.startsWith("/astella_note_authoring_"))
  throw new Error("Use an isolated astella_note_authoring_* database");
const configuredRoute = platform(process.env.PLAN58_ROUTE === "companion_fallback" ? "companion_fallback" : "agent_turn");
const scenario = process.env.PLAN58_SCENARIO ?? "three-notes";
const expectedNotes = scenario.startsWith("three-notes") ? 3 : 0;
const requestedEffort = process.env.LIVE_PROBE_EFFORT;
if (requestedEffort && !configuredRoute.modelProfile?.reasoning?.levels.includes(requestedEffort as ReasoningEffort))
  throw new Error("LIVE_PROBE_EFFORT must be a reasoning level declared for agent_turn");
const route = requestedEffort
  ? { ...configuredRoute, modelProfile: { ...configuredRoute.modelProfile!, reasoning: {
      ...configuredRoute.modelProfile!.reasoning!, default: requestedEffort as ReasoningEffort,
    } } }
  : configuredRoute;
const wire: WireReceipt[] = [];
// This file uses only the disposable synthetic request above. Capture visible
// provider text and tool surfaces for protocol diagnosis, never reasoning.
const rawTurns: unknown[] = [];
const f = await fixture();
// This probe verifies autonomous note creation. Its random disposable account
// explicitly uses the full permission level so no real user's confirmation is
// bypassed and the test can verify the saved note end to end.
await f.mutate(tx => tx`UPDATE user_companion_account_state
  SET agent_settings=jsonb_set(agent_settings,'{permissionLevel}','"full"'::jsonb)
  WHERE user_id=${f.event.read.userId}`);
const text = scenario === "story" ? "写一个约400字的完整童话故事，主题是小狐狸找回星星，要有完整结尾。" : scenario === "casual" ? "晚上好，今天学得有点累。" : "生成三篇中国历史笔记，主题分别是秦朝、汉朝、唐朝。要分别保存成笔记。"
  + (scenario === "three-notes-short" ? "每篇约300字，简短但完整，包含关键事实与结尾。" : "");
const history: {role: "user" | "assistant"; text: string}[] = [];

try {
  const scope = { workspaceId: f.event.ctx.workspaceId, userId: f.event.read.userId };
  const related = await withWorkspaceTransaction(scope, tx => createPrivateNoteRecords(tx, scope, {
    title: "欧姆定律的条件", titleSource: "manual", blocks: [{ type: "paragraph", content: "在温度和几何条件不变的欧姆导体中，U=IR，其中U是电压、I是电流、R是电阻，电流与电压成正比。一般工作点的比值R=U/I只在I不等于零时定义，不能把它称作无条件的欧姆定律。" }],
  }));
  assert.ok(related);
  await f.mutate(tx => tx`UPDATE companion_messages SET blocks=${tx.json([{type:"text",text}])} WHERE id=${f.messageId}`);
  const read = { ...readContext(f), userText: text, recentMessages: history };
  const receipts = createCompanionContextReceipts();
  const observed = observedProvider(route,"plan58-live",wire);
  const stream = observed.chatCompletionStream?.bind(observed);
  if (stream) observed.chatCompletionStream = async (messages, options, signal, onDelta) => {
    let text = "";
    try {
      const result = await stream(messages, options, signal, delta => { text += delta; onDelta(delta); });
      rawTurns.push({ text, content: result.content, tools: options.tools?.map(tool => tool.name), toolCalls: result.toolCalls });
      return result;
    } catch (error) { rawTurns.push({ text }); throw error; }
  };
  const provider = createGovernedProvider(observed, { consentOk:true,
    policy:{sendToExternal:true,sendImageContent:false,piiDetection:false,auditLogging:false} }, scope.workspaceId,
  { userId:scope.userId,operation:"companion_agent",reserveCall:()=>reserveCompanionProviderCall({ctx:f.event.ctx,read}) }, receipts.pressureGate);
  const fallbackProvider = process.env.PLAN58_WITH_FALLBACK === "1"
    ? createGovernedProvider(observedProvider(platform("companion_fallback"), "plan58-fallback", wire), { consentOk: true,
      policy: { sendToExternal: true, sendImageContent: false, piiDetection: false, auditLogging: false } }, scope.workspaceId,
      { userId: scope.userId, operation: "companion_agent", reserveCall: () => reserveCompanionProviderCall({ ctx: f.event.ctx, read }) }, receipts.pressureGate)
    : undefined;
  const delivery = createCompanionStreamDelivery({job:f.event.ctx,ctx:f.event.ctx,read,
    expiresAt:new Date(Date.now()+120000).toISOString(),factSpanValues:{},notifyCompanionEvent:async()=>{}});
  const started = performance.now(), startedWall = Date.now();
  let firstAgentTextDeltaMs: number | null = null;
  let firstPersistedVisibleTextMs: number | null = null;
  const reply = await runCompanionAgentLoop({ctx:f.event.ctx,read,provider,fallbackProvider,contextReceipts:receipts,
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
  // Production flushes the *sanitized* final text (validated.text), not the raw model
  // text: raw text may still carry the leading voice-expression tag, and writeTail
  // rejects a fullText that does not start with what deltas already delivered.
  const visibleReply = stripVoiceExpressionTags(reply.text);
  await delivery.writeTail(visibleReply, reply.text);
  if(firstPersistedVisibleTextMs===null&&delivery.deliveredChars()>0)
    firstPersistedVisibleTextMs=Math.round(performance.now()-started);
  const streamed = await delivery.finish();
  assert.ok(streamed.ok);
  // The visible text carries no voice-expression tags; reply.text still has the raw cue.
  assert.equal(delivery.deliveredText(),visibleReply);
  const createdNotes = await f.mutate(tx=>tx`SELECT n.id,n.title,n.current_version_id,
    string_agg(b.content,E'\n\n' ORDER BY b.ordinal) AS body FROM notes n JOIN note_blocks b ON b.version_id=n.current_version_id
    WHERE n.id IN (SELECT (result_ref::jsonb->>'noteId')::uuid FROM companion_agent_tool_calls WHERE run_id=${read.runId} AND name='companion_create_note' AND status='succeeded') AND n.workspace_id=${scope.workspaceId} GROUP BY n.id`);
  const calls = await f.mutate(tx=>tx`SELECT name,status,result_ref FROM companion_agent_tool_calls WHERE run_id=${read.runId} ORDER BY created_at`);
  const [run] = await f.mutate(tx=>tx`SELECT step_count,tool_call_count,model_call_count,turn_interpretation FROM companion_turn_runs WHERE id=${read.runId}`);
  const elapsedMs=Math.round(performance.now()-started);
  const savedEvents = await f.mutate(tx=>tx`SELECT created_at,payload FROM companion_stream_events WHERE run_id=${read.runId}
    AND type='agent.tool' AND payload->'tool'->>'status'='succeeded' AND payload->'tool'->'noteCreated' IS NOT NULL ORDER BY seq`);
  const firstSaveMs = savedEvents.length ? Math.max(0,new Date(savedEvents[0].created_at).getTime()-startedWall) : null;
  const savedArtifacts = savedEvents.map(event => ({ note: event.payload.tool.noteCreated,
    elapsedMs: Math.max(0, new Date(event.created_at).getTime() - startedWall) }));
  const chars = Array.from(visibleReply.normalize("NFKC").replace(/[\p{P}\p{S}\s]/gu, "")).length;
  // This fixture explicitly asks for about 400 characters only in the story case.
  const noteRequirement = scenario === "story" ? { min: 340, max: 460 } : null;
  const noteCharacterCounts = createdNotes.map(note => ({ noteId: note.id, count: companionVisibleCharacterCount(note.body) }));
  const lengthsPass = !noteRequirement || noteCharacterCounts.every(note => note.count >= noteRequirement.min && note.count <= noteRequirement.max);
  const passed = createdNotes.length === expectedNotes && lengthsPass && (scenario !== "story" || (chars >= 340 && chars <= 460));
  save(process.env.LIVE_PROBE_NAME ?? `plan58-${scenario}`, {ok:passed,scenario,model:route.model,effort:requestedEffort??route.modelProfile?.reasoning?.default??null,
    reply,createdNotes,calls,run,wire,rawTurns,elapsedMs,firstSaveMs,savedArtifacts,noteCharacterCounts,firstAgentTextDeltaMs,firstPersistedVisibleTextMs,chars,
    deliveredText:delivery.deliveredText()});
  console.log(JSON.stringify({ok:passed,scenario,model:route.model,steps:run.step_count,tools:run.tool_call_count,
    savedCount:createdNotes.length,elapsedMs,firstSaveMs,firstAgentTextDeltaMs,firstPersistedVisibleTextMs,chars,
    effort:requestedEffort??route.modelProfile?.reasoning?.default??null}));
  assert.equal(createdNotes.length,expectedNotes,"exact saved note count");
  assert.ok(lengthsPass, "every saved note meets its requested length");
  if(scenario === "story") assert.ok(chars >= 340 && chars <= 460,"visible story meets the requested length");
} catch(error) {
  const calls = await f.mutate(tx=>tx`SELECT name,status,result_ref,result_safe_summary,arguments FROM companion_agent_tool_calls WHERE run_id=${f.event.read.runId} ORDER BY created_at`);
  save(process.env.LIVE_PROBE_NAME ?? `plan58-${scenario}`,{ok:false,scenario,model:route.model,
    error:error instanceof Error?{name:error.name,message:error.message}:String(error),wire,rawTurns,calls});
  throw error;
} finally {
  await f.cleanup(); await closeFixtureDatabase(); await closeApiDatabase();
}
