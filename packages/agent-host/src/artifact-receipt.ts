/**
 * 操作回执的权威来源：「job 成功」不等于「产物做出来了」，只有真的落在领域表里的
 * 那一行才算证据。四层绑定必须同时成立，否则视为没有产物（操作停在 outcome_unknown）：
 *   1. 领域行的主键就是这次 job（或显式 generation_job_id 指向它）；
 *   2. jobs.type 等于操作的 capability；
 *   3. jobs 与领域行同属当前目标的 workspace / user；
 *   4. 领域行的 note_id/note_version_id 等于该 job payload 冻结的那一份，且属于 agent_runs.inputs。
 *
 * 第 4 层的前半段不是冗余：目标可以冻结多份材料，只检查「产物落在 inputs 里」
 * 挡不住把输入甲的产物记到输入乙那次操作上。未登记的 capability 永远拿不到产物。
 */
import { sql, type SQL } from "drizzle-orm";
import { agentArtifactRefV1Schema, type AgentArtifactRefV1, type AgentInputRefV1, type AgentScopeV1 } from "@ailearn/shared/agent-contracts";
import { queryRows, type AgentSqlExecutor } from "./store.ts";

export interface OperationArtifactReceiptRequest {
  /** 操作记录的 capability；产物类型必须与它一一对应，否则视为没有产物。 */
  capability: string;
  jobId: string;
  scope: AgentScopeV1;
  /** 目标冻结的材料；产物落在材料之外时不算这次目标的交付。 */
  inputs: readonly AgentInputRefV1[];
}

/** 每个能力一张表、一条引用形状；表名列名是内联字面量，绑定值全部走参数。 */
function artifactCandidate(request: OperationArtifactReceiptRequest): SQL | null {
  const capability = request.capability, jobId = request.jobId;
  const workspaceId = request.scope.workspaceId, userId = request.scope.userId;
  switch (capability) {
    case "note_overview_generate":
      return sql`SELECT jsonb_build_object('kind','note_overview','id',n.id,'jobId',n.generation_job_id,
          'noteId',n.note_id,'noteVersionId',n.note_version_id) AS artifact
        FROM public.note_overviews n
        JOIN public.jobs j ON j.id=n.generation_job_id AND j.type=${capability}
          AND j.workspace_id=n.workspace_id AND j.requested_by=n.user_id
          AND j.payload->>'noteId'=n.note_id::text AND j.payload->>'noteVersionId'=n.note_version_id::text
        WHERE n.generation_job_id=${jobId} AND n.workspace_id=${workspaceId} AND n.user_id=${userId} LIMIT 1`;
    case "note_dynamic_artifact_generate":
      return sql`SELECT jsonb_build_object('kind','note_dynamic_artifact','id',n.id,'jobId',n.generation_job_id,
          'noteId',n.note_id,'noteVersionId',n.note_version_id) AS artifact
        FROM public.note_learning_artifacts n
        JOIN public.jobs j ON j.id=n.generation_job_id AND j.type=${capability}
          AND j.workspace_id=n.workspace_id AND j.requested_by=n.user_id
          AND j.payload->>'noteId'=n.note_id::text AND j.payload->>'noteVersionId'=n.note_version_id::text
        WHERE n.generation_job_id=${jobId} AND n.workspace_id=${workspaceId} AND n.user_id=${userId} LIMIT 1`;
    // 拓展草稿行的主键就是 job id（note_expansion_tasks_job_workspace_fk），故 taskId = jobId。
    case "note_expansion_generate":
      return sql`SELECT jsonb_build_object('kind','note_expansion','id',n.id,'jobId',n.id,
          'noteId',n.note_id,'noteVersionId',n.note_version_id) AS artifact
        FROM public.note_expansion_tasks n
        JOIN public.jobs j ON j.id=n.id AND j.type=${capability}
          AND j.workspace_id=n.workspace_id AND j.requested_by=n.user_id
          AND j.payload->>'noteId'=n.note_id::text AND j.payload->>'noteVersionId'=n.note_version_id::text
        WHERE n.id=${jobId} AND n.workspace_id=${workspaceId} AND n.user_id=${userId} LIMIT 1`;
    default:
      return null;
  }
}

export async function readOperationArtifactReceipt(
  tx: AgentSqlExecutor,
  request: OperationArtifactReceiptRequest,
): Promise<AgentArtifactRefV1 | null> {
  const candidate = artifactCandidate(request);
  if (!candidate) return null;
  const [row] = await queryRows<{ artifact: unknown }>(tx, sql`SELECT (${candidate}) AS artifact`);
  if (!row || row.artifact === null || row.artifact === undefined) return null;
  const parsed = agentArtifactRefV1Schema.safeParse(row.artifact);
  if (!parsed.success) return null;
  const artifact = parsed.data;
  // 查询已绑死 job 与材料；这里再钉一遍不变量，并要求材料确实被这个目标冻结过。
  if (artifact.jobId !== request.jobId) return null;
  if (!request.inputs.some((input) => input.noteId === artifact.noteId && input.noteVersionId === artifact.noteVersionId)) return null;
  return artifact;
}
