import { sql } from "drizzle-orm";
import { queryRows } from "@ailearn/agent-host";
import { agentInputRefV1Schema } from "@ailearn/shared/agent-contracts";
import { agentGoalToolManifest } from "@ailearn/shared/agent-capabilities";
import type { AgentEventContext } from "../handlers/companion-read-tools.ts";
import { parsePageContext } from "../handlers/companion-dialogue-content.ts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { agentStore } from "./store.ts";

export async function executeAgentGoalTool(event: AgentEventContext, name: string, args: Record<string, unknown>) {
  const manifest = agentGoalToolManifest.find(m => m.definition.name === name);
  if (!manifest) throw new Error("unknown goal tool");
  const input = manifest.argumentSchema.parse(args);
  const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
  switch (name) {
  case "agent_list_goals": {
    const result = await agentStore.list(scope);
    return { value: { items: result.items.map(run => ({ runId: run.runId, revision: run.revision, goal: run.goal.slice(0,300),
      status: run.status, artifacts: run.artifacts, summary: run.summary?.slice(0,1000) ?? null })) }, safeSummary: "已核对手边目标的真实状态" };
  }
  }
  let run;
  switch (name) {
  case "agent_start_goal": {
    let inputs = agentInputRefV1Schema.array().parse(input.inputs ?? []);
    const page = parsePageContext(event.read.pageContext);
    if (inputs.length === 0 && page?.pageKind === "note" && page.noteId) {
      const [note] = await withWorkerWorkspaceTransaction(scope, tx => queryRows<{ id: string; current_version_id: string }>(tx,
        sql`SELECT id,current_version_id FROM notes WHERE id=${page.noteId} AND workspace_id=${scope.workspaceId}
          AND deleted_at IS NULL AND (share_scope='shared' OR created_by=${scope.userId})`));
      if (note?.current_version_id) inputs = [{ kind: "note_version", noteId: note.id, noteVersionId: note.current_version_id }];
    }
    if (inputs.length === 0) return { value: { status: "not_executed", reason: "请先定位要处理的笔记并读取它的真实版本，再交给持续目标。" }, safeSummary: "还需要确定这件事使用的材料" };
    // Stable to the originating turn, including model repair/retry.
    run = await agentStore.create(scope, { requestId: event.read.runId, goal: String(input.goal), inputs,
      conversationId: event.read.conversationId });
    break;
  }
  case "agent_revise_goal": {
    run = await agentStore.revise(scope, String(input.runId), Number(input.expectedRevision), String(input.goal));
    break;
  }
  case "agent_control_goal": {
    run = await agentStore.control(scope, String(input.runId), Number(input.expectedRevision), input.action as "cancel" | "pause" | "resume");
    break;
  }
  default: throw new Error("unknown goal tool");
  }
  return { value: { accepted: true, runId: run.runId, revision: run.revision, goal: run.goal,
    status: run.status, artifacts: run.artifacts }, safeSummary: name === "agent_start_goal" ? "已接下目标，会在后台继续处理"
      : name === "agent_revise_goal" ? "已更新要求，旧版本未完成的生成已停止" : "已更新这件事的状态" };
}
