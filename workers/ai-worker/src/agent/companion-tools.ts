import { sql } from "drizzle-orm";
import { queryRows } from "@ailearn/agent-host";
import { agentInputRefV1Schema, createAgentRunV1Schema } from "@ailearn/shared/agent-contracts";
import { agentGoalToolManifest } from "@ailearn/shared/agent-capabilities";
import type { AgentEventContext } from "../handlers/companion-read-tools.ts";
import { parsePageContext } from "../handlers/companion-dialogue-content.ts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { agentStore } from "./store.ts";

/** 目标文本的非空与长度判据直接取自 create 的输入合同，不在这里另写一份上限。 */
const goalRequestSchema = createAgentRunV1Schema.shape.goal;

export type GoalRequest =
  | { ok: true; goal: string }
  | { ok: false; reason: "empty" | "too_long" };

/** Validate the authoritative request without truncating or rewriting its constraints. */
export function goalRequestFromUserTurn(userText: unknown): GoalRequest {
  const parsed = goalRequestSchema.safeParse(userText);
  if (parsed.success) return { ok: true, goal: parsed.data };
  return { ok: false, reason: typeof userText === "string" && userText.trim().length > 0 ? "too_long" : "empty" };
}

/** 执行器只用到 store 的这几个动作；默认是本模块的真实 store，测试可换窄端口。 */
export type AgentGoalToolStore = Pick<typeof agentStore, "create" | "list" | "revise" | "control">;

export async function executeAgentGoalTool(
  event: AgentEventContext, name: string, args: Record<string, unknown>, store: AgentGoalToolStore = agentStore,
) {
  const manifest = agentGoalToolManifest.find(m => m.definition.name === name);
  if (!manifest) throw new Error("unknown goal tool");
  const input = manifest.argumentSchema.parse(args);
  const scope = { workspaceId: event.ctx.workspaceId, userId: event.read.userId };
  switch (name) {
  case "agent_list_goals": {
    const result = await store.list(scope);
    return { value: { items: result.items.map(run => ({ runId: run.runId, revision: run.revision, goal: run.goal.slice(0,300),
      status: run.status, artifacts: run.artifacts, summary: run.summary?.slice(0,1000) ?? null })) }, safeSummary: "已核对手边目标的真实状态" };
  }
  }
  let run;
  switch (name) {
  case "agent_start_goal": {
    const request = goalRequestFromUserTurn(event.read.userText);
    if (!request.ok) return {
      value: { status: "not_executed", reason: request.reason === "empty"
        ? "这一轮没有接到你明确交代的事，先说清楚要做什么。"
        : "这次交代太长了，说短一点我再接进持续目标。" },
      safeSummary: "还没有接到这次目标" };
    let inputs = agentInputRefV1Schema.array().parse(input.inputs ?? []);
    const page = parsePageContext(event.read.pageContext);
    if (inputs.length === 0 && page?.pageKind === "note" && page.noteId) {
      const [note] = await withWorkerWorkspaceTransaction(scope, tx => queryRows<{ id: string; current_version_id: string }>(tx,
        sql`SELECT id,current_version_id FROM notes WHERE id=${page.noteId} AND workspace_id=${scope.workspaceId}
          AND deleted_at IS NULL AND (share_scope='shared' OR created_by=${scope.userId})`));
      if (note?.current_version_id) inputs = [{ kind: "note_version", noteId: note.id, noteVersionId: note.current_version_id }];
    }
    if (inputs.length === 0) return { value: { status: "not_executed", reason: "请先定位要处理的笔记并读取它的真实版本，再交给持续目标。" }, safeSummary: "还需要确定这件事使用的材料" };
    // 要求来自本轮原话；材料与版本仍按实际读取冻结；requestId 绑定本轮，模型修复重试不重复接。
    run = await store.create(scope, { requestId: event.read.runId, goal: request.goal, inputs,
      conversationId: event.read.conversationId });
    break;
  }
  case "agent_revise_goal": {
    run = await store.revise(scope, String(input.runId), Number(input.expectedRevision), String(input.goal));
    break;
  }
  case "agent_control_goal": {
    run = await store.control(scope, String(input.runId), Number(input.expectedRevision), input.action as "cancel" | "pause" | "resume");
    break;
  }
  default: throw new Error("unknown goal tool");
  }
  return { value: { accepted: true, runId: run.runId, revision: run.revision, goal: run.goal,
    status: run.status, artifacts: run.artifacts }, safeSummary: name === "agent_start_goal" ? "已接下目标，会在后台继续处理"
      : name === "agent_revise_goal" ? "已更新要求，旧版本未完成的生成已停止" : "已更新这件事的状态" };
}
