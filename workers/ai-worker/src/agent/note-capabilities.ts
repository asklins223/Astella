import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { queryRows, requireVisibleInput, AgentStoreError, type createAgentAdvanceStore } from "@ailearn/agent-host";
import { noteAgentCapabilityManifest } from "@ailearn/shared/agent-capabilities";
import { agentInputRefV1Schema } from "@ailearn/shared/agent-contracts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { loadNoteReadPage } from "../handlers/companion-read-tools.ts";

type Store = ReturnType<typeof createAgentAdvanceStore>;
export async function invokeNoteCapability(store: Store, call: { id: string; name: string; arguments: Record<string, unknown> }) {
  const manifest = noteAgentCapabilityManifest.find(m => m.definition.name === call.name);
  if (!manifest) throw new AgentStoreError(400, "unknown_capability", "当前没有这项能力。");
  const input = manifest.argumentSchema.parse(call.arguments) as { noteId: string; noteVersionId: string; startOrdinal?: number };
  const ref = agentInputRefV1Schema.parse({ kind: "note_version", noteId: input.noteId, noteVersionId: input.noteVersionId });
  await store.invoke(async (tx, run) => {
    await requireVisibleInput(tx, store.scope, ref);
    if (!run.inputs.some(i => i.noteId === ref.noteId && i.noteVersionId === ref.noteVersionId))
      throw new AgentStoreError(403, "input_outside_goal", "这份材料不在当前目标范围内，请先把它交给伴星。");
  });
  if (call.name === "note_read") {
    const page = await withWorkerWorkspaceTransaction(store.scope, tx => loadNoteReadPage(tx, {
      ...store.scope, noteId: ref.noteId, noteVersionId: ref.noteVersionId, startOrdinal: input.startOrdinal ?? 1, maxChars: 3000,
    }));
    if (!page) throw new AgentStoreError(404, "note_not_found", "这版笔记现在读不到。");
    return { status: "succeeded", title: page.title, noteId: ref.noteId, noteVersionId: page.versionId,
      totalBlocks: page.totalBlocks, truncated: page.truncated, nextStartOrdinal: page.nextStartOrdinal,
      imageCount: page.imageTotal, body: page.page.body };
  }
  return store.invoke(async (tx, run) => {
    const key = `${call.name}:${ref.noteId}:${ref.noteVersionId}`;
    const [existing] = await queryRows<{ id: string; job_id: string; status: string; artifact: unknown }>(tx,
      sql`SELECT * FROM agent_operations WHERE run_id=${run.id} AND revision=${run.revision} AND tool_call_id=${key}`);
    if (existing) return { status: existing.status, operationId: existing.id, jobId: existing.job_id, artifact: existing.artifact };
    if (run.resume_from_revision) {
      const [saved] = await queryRows<{ id: string; job_id: string; artifact: unknown }>(tx, sql`SELECT * FROM agent_operations
        WHERE run_id=${run.id} AND revision<=${run.resume_from_revision} AND tool_call_id=${key}
          AND status='succeeded' AND artifact IS NOT NULL ORDER BY revision DESC LIMIT 1`);
      if (saved) return { status: "succeeded", reused: true, operationId: saved.id, jobId: saved.job_id, artifact: saved.artifact };
    }
    const [count] = await queryRows<{ n: string }>(tx, sql`SELECT count(*) AS n FROM agent_operations WHERE run_id=${run.id}`);
    if (Number(count?.n) >= 8) throw new AgentStoreError(422, "operation_budget", "这件事已到生成上限，先保留当前结果。");
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`job-quota:${store.scope.workspaceId}`},0))`);
    const [quota] = await queryRows<{ n: string }>(tx, sql`SELECT count(*) AS n FROM jobs WHERE workspace_id=${store.scope.workspaceId} AND status='pending'`);
    if (Number(quota?.n) >= 50) throw new AgentStoreError(429, "queue_busy", "队列正在处理较多内容，稍后再继续。");
    const operationId = randomUUID(), jobId = randomUUID();
    const payload = { noteId: ref.noteId, noteVersionId: ref.noteVersionId, requestId: operationId,
      ...(call.name === "note_dynamic_artifact_generate" ? { sourceKind: "overview" } : {}),
      userId: store.scope.userId, agentRunId: run.id, agentRevision: run.revision, agentGoal: run.goal.slice(0,2000) };
    await tx.execute(sql`INSERT INTO agent_operations(id,run_id,workspace_id,user_id,revision,tool_call_id,capability,job_id)
      VALUES(${operationId},${run.id},${store.scope.workspaceId},${store.scope.userId},${run.revision},${key},${call.name},${jobId})`);
    await tx.execute(sql`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
      VALUES(${jobId},${call.name},${store.scope.workspaceId},${store.scope.userId},${JSON.stringify(payload)}::jsonb,
        'pending',70,'card_foreground',${`agent-operation:${operationId}`})`);
    return { status: "accepted", operationId, jobId, noteId: ref.noteId, noteVersionId: ref.noteVersionId };
  });
}
