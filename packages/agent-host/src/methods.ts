import { sql } from "drizzle-orm";
import { agentGoalCapabilityManifest } from "@ailearn/shared/agent-capabilities";
import {
  agentMethodV1Schema, agentMethodUseV1Schema,
  type AgentMethodV1, type AgentMethodEvidenceV1, type AgentMethodCapabilityV1,
  type proposeAgentMethodV1Schema, type reviseAgentMethodV1Schema, type controlAgentMethodV1Schema,
} from "@ailearn/shared/agent-growth-contracts";
import type { z } from "zod";
import { agentMethodEvidenceV1Schema } from "@ailearn/shared/agent-growth-contracts";
import type { AgentScopeV1 } from "@ailearn/shared/agent-contracts";
import { AgentStoreError, queryRows, readRun, projectRun, type AgentSqlExecutor, type AgentStorePorts } from "./store.ts";

export interface AgentMethodRow {
  id: string; playbook_key: string; version: number; title: string; trigger_condition: string; steps: string[]; exceptions: string[];
  evidence: AgentMethodEvidenceV1[]; capability_refs: AgentMethodCapabilityV1[];
  method_state: AgentMethodV1["state"]; epistemic_status: AgentMethodV1["epistemicStatus"];
  user_controlled: boolean; author: AgentMethodV1["author"];
  change_reason: string | null; source_run_id: string | null; source_run_revision: number | null;
  created_at: Date | string; updated_at: Date | string; sources_current?: boolean;
  consulted_count?: number | string; helpful_count?: number | string; unhelpful_count?: number | string; last_consulted_at?: Date | string | null;
}
const iso = (value: Date | string) => new Date(value).toISOString();
const capabilityVersions = new Map(agentGoalCapabilityManifest.map(entry => [entry.definition.name, entry.definition.toolVersion]));
export function agentMethodCapabilitiesCurrent(refs: readonly AgentMethodCapabilityV1[]): boolean {
  return refs.every(ref => capabilityVersions.get(ref.name) === ref.version);
}
/**
 * 行 → DTO。`state`（生命周期）与 `epistemicStatus`（认识状态）**分别**投影：
 * 库里就是两列，读出来合成一个字段就是丢信息。
 *
 * `availability` 只在「已确认 **且** 依据站得住」时才可能是 `available`：
 * `method_state='active'` 只说明用户点过确认；0374 的触发器把依据降为 disputed 时
 * 两列一起动，但读侧不能依赖这个巧合——`tentative`/`disputed` 一样不是已确认可用。
 */
export function projectAgentMethod(row: AgentMethodRow, historical = false): AgentMethodV1 {
  const availability = historical ? "previous_version" : row.method_state === "disabled" ? "disabled"
    : !row.sources_current || row.method_state === "disputed" || row.epistemic_status === "disputed" ? "source_changed"
    : !agentMethodCapabilitiesCurrent(row.capability_refs) ? "capability_changed"
    : row.method_state === "active" && row.epistemic_status === "supported" ? "available" : "pending";
  return agentMethodV1Schema.parse({ version: 1, methodId: row.id, revision: Number(row.version), title: row.title,
    appliesWhen: row.trigger_condition, steps: row.steps, exceptions: row.exceptions, evidence: row.evidence,
    capabilities: row.capability_refs, state: row.method_state, epistemicStatus: row.epistemic_status, availability,
    userControlled: row.user_controlled, author: row.author,
    changeReason: row.change_reason, sourceRunId: row.source_run_id, sourceRunRevision: row.source_run_revision,
    consultedCount: Number(row.consulted_count ?? 0), helpfulCount: Number(row.helpful_count ?? 0), unhelpfulCount: Number(row.unhelpful_count ?? 0),
    lastConsultedAt: row.last_consulted_at ? iso(row.last_consulted_at) : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
const stats = sql`LEFT JOIN LATERAL (SELECT count(*) AS consulted_count,
  count(*) FILTER (WHERE feedback='helpful') AS helpful_count, count(*) FILTER (WHERE feedback='unhelpful') AS unhelpful_count,
  max(created_at) AS last_consulted_at FROM companion_method_uses u
  WHERE u.method_id=p.id AND u.workspace_id=p.workspace_id AND u.user_id=p.user_id AND u.method_revision=p.version) s ON true`;
async function readRow(tx: AgentSqlExecutor, scope: AgentScopeV1, id: string): Promise<AgentMethodRow> {
  const [row] = await queryRows<AgentMethodRow>(tx, sql`SELECT p.*,s.*,
    ailearn_agent_method_sources_current(p.id,p.workspace_id,p.user_id) AS sources_current
    FROM companion_procedural_playbooks p ${stats}
    WHERE p.id=${id} AND p.workspace_id=${scope.workspaceId} AND p.user_id=${scope.userId}`);
  if (!row) throw new AgentStoreError(404,"method_not_found","这个方法现在读不到。");
  return row;
}
async function lockVersion(tx: AgentSqlExecutor, scope: AgentScopeV1, id: string, revision: number) {
  const [row] = await queryRows<{ version: number }>(tx, sql`SELECT version FROM companion_procedural_playbooks
    WHERE id=${id} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} FOR UPDATE`);
  if (!row) throw new AgentStoreError(404,"method_not_found","这个方法现在读不到。");
  if (Number(row.version)!==revision) throw new AgentStoreError(409,"method_revision_conflict","方法已经有新版本，请核对后再保存。");
}
/**
 * `activeOnly` 是「可自动采用」这个围栏，SQL 与读侧投影两道都要在。
 * SQL 那一道按**认识状态**收紧到 `supported`：`method_state='active'` 只是用户点过确认，
 * tentative（依据还没核）不该占走目录上限、也不该出现在目录里。
 */
export async function listAgentMethods(tx: AgentSqlExecutor, scope: AgentScopeV1, activeOnly = false) {
  const rows = await queryRows<AgentMethodRow>(tx, sql`SELECT p.*,s.*,
    ailearn_agent_method_sources_current(p.id,p.workspace_id,p.user_id) AS sources_current
    FROM companion_procedural_playbooks p ${stats}
    WHERE p.workspace_id=${scope.workspaceId} AND p.user_id=${scope.userId}
      ${activeOnly ? sql`AND p.method_state='active' AND p.epistemic_status='supported'` : sql``}
    ORDER BY p.updated_at DESC,p.id LIMIT ${activeOnly ? 20 : 100}`);
  return rows.map(row=>projectAgentMethod(row)).filter(method=>!activeOnly || method.availability==="available");
}
/** 读前核对：版本要对得上，并且此刻仍可采用。依据被纠正／被停用／暂定的都读不出正文。 */
export async function readAgentMethod(tx: AgentSqlExecutor, scope: AgentScopeV1, id: string, revision: number,
  consultation?: { kind: "agent_goal" | "conversation"; id: string; revision: number; sourceKey: string }) {
  const row=await readRow(tx,scope,id), method=projectAgentMethod(row);
  if (method.revision!==revision || method.availability!=="available") return null;
  if (consultation) await tx.execute(sql`INSERT INTO companion_method_uses
    (method_id,workspace_id,user_id,method_revision,context_kind,context_id,context_revision,source_key)
    VALUES(${id},${scope.workspaceId},${scope.userId},${revision},${consultation.kind},${consultation.id},${consultation.revision},${consultation.sourceKey})
    ON CONFLICT(workspace_id,user_id,method_id,method_revision,source_key) DO NOTHING`);
  return method;
}

/** Source rows are locked before the derived method, matching memory invalidation's lock order. */
export async function upsertAgentMethodCandidate(tx: AgentSqlExecutor, scope: AgentScopeV1, input: {
  playbookKey: string; title: string; triggerCondition: string; steps: string[]; exceptions: string[];
  evidence: AgentMethodEvidenceV1[]; epistemicStatus: "tentative" | "supported" | "disputed";
  author: "user" | "companion" | "extractor" | "maintenance";
}): Promise<{ playbookId: string; version: number; created: boolean } | null> {
  const evidence = input.evidence.map(ref => agentMethodEvidenceV1Schema.parse(ref));
  if (!evidence.length) return null;
  for (const ref of [...evidence].sort((a,b)=>(a.memoryId ?? "").localeCompare(b.memoryId ?? ""))) {
    if (!ref.memoryId || !ref.memoryRevision) return null;
    const [source] = await queryRows(tx,sql`SELECT id FROM assistant_memory_items
      WHERE id=${ref.memoryId} AND revision=${ref.memoryRevision}
        AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
        AND deleted_at IS NULL AND dismissed_at IS NULL AND archived_at IS NULL
        AND epistemic_status NOT IN ('disputed','superseded')
        AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>now()) FOR SHARE`);
    if (!source) return null;
  }
  const [written] = await queryRows<{id:string;version:number}>(tx,sql`INSERT INTO companion_procedural_playbooks
    (playbook_key,workspace_id,user_id,title,trigger_condition,steps,exceptions,evidence,epistemic_status,author)
    VALUES(${input.playbookKey},${scope.workspaceId},${scope.userId},${input.title},${input.triggerCondition},
      ${JSON.stringify(input.steps)}::jsonb,${JSON.stringify(input.exceptions)}::jsonb,${JSON.stringify(evidence)}::jsonb,
      ${input.epistemicStatus},${input.author})
    ON CONFLICT(workspace_id,user_id,playbook_key) DO UPDATE
      SET title=EXCLUDED.title,trigger_condition=EXCLUDED.trigger_condition,steps=EXCLUDED.steps,exceptions=EXCLUDED.exceptions,
        evidence=EXCLUDED.evidence,epistemic_status=EXCLUDED.epistemic_status,author=EXCLUDED.author,
        method_state='candidate',change_reason='新依据已整理，等待核对。',version=companion_procedural_playbooks.version+1,updated_at=now()
      WHERE NOT companion_procedural_playbooks.user_controlled
        AND companion_procedural_playbooks.method_state NOT IN ('disabled','disputed')
    RETURNING id,version`);
  return written ? {playbookId:written.id,version:Number(written.version),created:Number(written.version)===1} : null;
}
export function createAgentMethodStore<Tx extends AgentSqlExecutor>(ports: AgentStorePorts<Tx>) {
  return {
    list: (scope: AgentScopeV1) => ports.transaction(scope,async tx=>({version:1 as const,items:await listAgentMethods(tx,scope)})),
    get: (scope: AgentScopeV1,id: string) => ports.transaction(scope,async tx=>projectAgentMethod(await readRow(tx,scope,id))),
    propose(scope: AgentScopeV1,input: z.infer<typeof proposeAgentMethodV1Schema>) {
      return ports.transaction(scope,async tx=>{
        const run=await readRun(tx,scope,input.runId,true);
        if (run.revision!==input.expectedRunRevision) throw new AgentStoreError(409,"run_revision_conflict","这件事已经有新要求，请先核对。");
        if (run.status!=="completed") throw new AgentStoreError(422,"method_source_incomplete","等这件事有确定交付后，再把做法留下。");
        const projection=await projectRun(tx,scope,run);
        const operations=projection.operations.filter(operation=>operation.status==="succeeded");
        if (!operations.length) throw new AgentStoreError(422,"method_source_empty","这次没有可核对的执行步骤，暂时不能整理成做事方法。");
        const capabilities=[...new Map(operations.map(operation=>[operation.capability,{name:operation.capability,version:capabilityVersions.get(operation.capability) ?? "unavailable"}])).values()];
        if (!agentMethodCapabilitiesCurrent(capabilities)) throw new AgentStoreError(422,"method_capability_changed","这次用过的能力已有变化，请先核对。");
        const [created]=await queryRows<{id:string}>(tx,sql`INSERT INTO companion_procedural_playbooks
          (playbook_key,workspace_id,user_id,title,trigger_condition,steps,exceptions,evidence,capability_refs,source_run_id,source_run_revision,author,change_reason)
          VALUES(${`agent-run:${run.id}:${run.revision}`},${scope.workspaceId},${scope.userId},${input.title},${input.appliesWhen},
          ${JSON.stringify(capabilities.map(capability=>agentGoalCapabilityManifest.find(entry=>entry.definition.name===capability.name)?.presentation.methodStep ?? "按当前目标和材料核对后续步骤。"))}::jsonb,
          ${JSON.stringify(["当前要求、材料、权限和可用能力优先；旧产物与旧确认不作为新任务的交付或授权。"])}::jsonb,
          ${JSON.stringify([{runId:run.id,runRevision:run.revision,note:run.goal.slice(0,400)}])}::jsonb,${JSON.stringify(capabilities)}::jsonb,
          ${run.id},${run.revision},'user','从这次真实合作整理，等待确认。')
          ON CONFLICT(workspace_id,user_id,playbook_key) DO NOTHING RETURNING id`);
        const [existing]=created ? [created] : await queryRows<{id:string}>(tx,sql`SELECT id FROM companion_procedural_playbooks
          WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND playbook_key=${`agent-run:${run.id}:${run.revision}`}`);
        if (!existing) throw new Error("method proposal did not produce a row");
        return projectAgentMethod(await readRow(tx,scope,existing.id));
      });
    },
    revise(scope: AgentScopeV1,id: string,input: z.infer<typeof reviseAgentMethodV1Schema>) {
      return ports.transaction(scope,async tx=>{
        await lockVersion(tx,scope,id,input.expectedRevision);
        await tx.execute(sql`UPDATE companion_procedural_playbooks SET title=${input.title},trigger_condition=${input.appliesWhen},
          steps=${JSON.stringify(input.steps)}::jsonb,exceptions=${JSON.stringify(input.exceptions)}::jsonb,
          user_controlled=true,author='user',change_reason=${input.reason},version=version+1,updated_at=now()
          WHERE id=${id} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}`);
        return projectAgentMethod(await readRow(tx,scope,id));
      });
    },
    control(scope: AgentScopeV1,id: string,input: z.infer<typeof controlAgentMethodV1Schema>) {
      return ports.transaction(scope,async tx=>{
        await lockVersion(tx,scope,id,input.expectedRevision);
        const current=await readRow(tx,scope,id);
        if (input.action!=="disable" && (!current.sources_current || !agentMethodCapabilitiesCurrent(current.capability_refs)))
          throw new AgentStoreError(422,"method_source_changed","这个方法的依据或能力已变化，需要重新核对，暂时不能采用。");
        const state=input.action==="disable" ? "disabled" : "active";
        if (current.method_state===state && current.user_controlled) return projectAgentMethod(current);
        await tx.execute(sql`UPDATE companion_procedural_playbooks SET method_state=${state},user_controlled=true,
          epistemic_status=${state==="active" ? "supported" : current.method_state==="disputed" ? "disputed" : "tentative"},
          change_reason=${input.reason ?? (state==="active" ? "用户确认采用这个方法。" : "用户暂时停用这个方法。")},
          version=version+1,updated_at=now() WHERE id=${id} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}`);
        return projectAgentMethod(await readRow(tx,scope,id));
      });
    },
    history(scope: AgentScopeV1,id: string) {
      return ports.transaction(scope,async tx=>{
        await readRow(tx,scope,id);
        const rows=await queryRows<{snapshot:AgentMethodRow}>(tx,sql`SELECT snapshot FROM companion_method_revisions
          WHERE method_id=${id} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} ORDER BY revision DESC LIMIT 30`);
        return {version:1 as const,items:rows.map(row=>projectAgentMethod(row.snapshot,true))};
      });
    },
    uses(scope: AgentScopeV1,id: string) {
      return ports.transaction(scope,async tx=>{
        await readRow(tx,scope,id);
        const rows=await queryRows<Record<string,unknown>>(tx,sql`SELECT * FROM companion_method_uses
          WHERE method_id=${id} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} ORDER BY created_at DESC,id DESC LIMIT 30`);
        return {version:1 as const,items:rows.map(projectUse)};
      });
    },
    feedback(scope: AgentScopeV1,useId: string,input: {feedback:"helpful"|"unhelpful";comment?:string}) {
      return ports.transaction(scope,async tx=>{
        const [row]=await queryRows<Record<string,unknown>>(tx,sql`UPDATE companion_method_uses
          SET feedback=${input.feedback},comment=${input.comment ?? null},feedback_at=now()
          WHERE id=${useId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} RETURNING *`);
        if (!row) throw new AgentStoreError(404,"method_use_not_found","这次方法使用记录现在读不到。");
        return projectUse(row);
      });
    },
  };
}
function projectUse(row: Record<string,unknown>) {
  return agentMethodUseV1Schema.parse({useId:row.id,methodId:row.method_id,methodRevision:Number(row.method_revision),
    contextKind:row.context_kind,contextId:row.context_id,contextRevision:Number(row.context_revision),feedback:row.feedback,
    comment:row.comment,createdAt:iso(row.created_at as Date|string),feedbackAt:row.feedback_at ? iso(row.feedback_at as Date|string) : null});
}
