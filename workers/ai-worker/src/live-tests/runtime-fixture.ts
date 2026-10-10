import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { closeDatabase } from "../db.ts";
import type { ReadContext } from "../handlers/companion-dialogue-store.ts";
const url=testDatabaseUrl("DATABASE_URL_MIGRATOR");
if(new URL(url).pathname!=="/astella_companion_live_20261007"
  && !new URL(url).pathname.startsWith("/astella_note_authoring_"))
  throw new Error("Use the designated disposable live acceptance database or an isolated note-authoring database");
const admin=postgres(url,{max:2});
export async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), runId = randomUUID();
  const conversationId = randomUUID(), messageId = randomUUID(), jobId = randomUUID();
  const mutate = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => admin.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
    return fn(tx);
  });
  await mutate(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`budget-${userId}@test.invalid`},'h','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'预算回归',${userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_companion_account_state(user_id,epoch,global_enabled) VALUES(${userId},0,true)`;
    await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status)
      VALUES(${conversationId},${workspaceId},${userId},'dialogue','回归','auto','active')`;
    await tx`INSERT INTO companion_messages(id,conversation_id,workspace_id,user_id,role,seq,kind,blocks,content_sha256)
      VALUES(${messageId},${conversationId},${workspaceId},${userId},'user',1,'text','[]',${'0'.repeat(64)})`;
    await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES(${jobId},'companion_agent',${workspaceId},${userId},${tx.json({runId})},'running','budget-lease',now())`;
    await tx`INSERT INTO companion_turn_runs(id,conversation_id,workspace_id,user_id,user_message_id,generation,status,
      idempotency_key_hash,request_body_hash,account_epoch,job_id)
      VALUES(${runId},${conversationId},${workspaceId},${userId},${messageId},1,'running',${'a'.repeat(64)},${'b'.repeat(64)},0,${jobId})`;
  });
  const event = { ctx: { id:jobId,workspaceId,requestedBy:userId,leaseToken:'budget-lease',payload:{runId},signal:new AbortController().signal },
    read: { userId,runId,accountEpoch:0,generation:1 } };
  return { event, mutate, conversationId, messageId, count: async () => Number((await mutate(tx => tx`SELECT model_call_count FROM companion_turn_runs WHERE id=${runId}`))[0].model_call_count),
    cleanup: () => mutate(async tx => {
      await tx`SET LOCAL app.allow_history_mutation = 'on'`;
      await tx`DELETE FROM companion_agent_tool_calls WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_agent_steps WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM agent_runs WHERE workspace_id=${workspaceId} AND user_id=${userId}`;
      await tx`DELETE FROM companion_turn_runs WHERE conversation_id=${conversationId}`;
      // 卡与消息互相指：先解除消息这一侧的 action_ref，才能删卡。
      await tx`UPDATE companion_messages SET action_ref=NULL WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_action_proposals WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_conversations WHERE id=${conversationId}`;
      await tx`DELETE FROM jobs WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM assistant_memory_items WHERE workspace_id=${workspaceId}`;
      await tx`UPDATE notes SET current_version_id=null WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM note_blocks WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM notes WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM user_companion_account_state WHERE user_id=${userId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id=${workspaceId}`;
      await tx`DELETE FROM users WHERE id=${userId}`;
    }) };
}

export function readContext(f: Awaited<ReturnType<typeof fixture>>): ReadContext {
  return { ...f.event.read, conversationId: f.conversationId, userMessageId: f.messageId,
    runStatus: "running", formalAnswerInProgress: false, formalAnswerTarget: null,
    livePageView: null, pageContext: null, groundedTutorContext: null, userText: "你好",
    recentMessages: [], residentMemories: [], memoryDirectory: [], playbookCatalog: [], playbookCandidates: [], deliveryObservation: null,
    organizationSurface: null, memoryRefs: [], hereAndNow: null, thisTurnFacts: null,
    factSpans: null, conversationSummary: null, personaProfileRevision: 0,
    personaExamplesRevision: 0, defaultExpressionVersion: "test", petProfile: null,
    nextMessageSeq: 2, nextEventSeq: 1 };
}

export async function closeFixtureDatabase() { await admin.end(); await closeDatabase(); }
