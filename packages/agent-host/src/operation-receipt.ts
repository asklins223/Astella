/**
 * 操作回执的权威来源：「执行体结束」不等于「成果做出来了」，只有落在领域表里的那一行
 * 才算证据。按 execution + capability 分派；旧三类笔记产物那套四层绑定逐字保留。
 *
 * card_generation 一支的可审核交付 = 审核开放（review_ready|needs_attention）
 * ∧ 至少一张**最新 revision** 的候选 passed/undecided/unpublished/证据绑定非空。
 * 两层缺一不可：cancelled 上的 passed 行只是历史记录，checking 一张都还没放行。
 *
 * 三种回答：result → succeeded；failed → failed（领域已给终局结论却没有可交付成果）；
 * pending → 调用方按事件状态落 accepted/running，终局而仍 pending 即 outcome_unknown。
 * 「核对不到」永远不当作确定失败：review_ready 而查不到带证据的可审候选属于 pending，
 * needs_attention 且确实一张都不可审才属于 failed。
 */

import { sql, type SQL } from "drizzle-orm";
import {
  AGENT_CARD_GENERATION_CAPABILITY, agentArtifactRefV1Schema,
  type AgentArtifactRefV1, type AgentExecutionRefV1, type AgentInputRefV1,
  type AgentOperationResultV1, type AgentScopeV1,
} from "@astella/shared/agent-contracts";
import { queryRows, type AgentSqlExecutor } from "./store.ts";

export interface OperationReceiptRequest {
  /** 操作记录的 capability；产物类型必须与它一一对应。 */
  capability: string;
  execution: AgentExecutionRefV1;
  scope: AgentScopeV1;
  /** 目标冻结的材料；产物落在材料之外时不算这次目标的交付。 */
  inputs: readonly AgentInputRefV1[];
}

/**
 * `pending` 不是失败：领域事实还不足以定性（仍在生成），交给调用方按事件状态走。
 * `failed` 是领域自己给出的结论：终局且没有可交付成果。
 */
export type OperationReceiptV1 =
  | { kind: "result"; result: AgentOperationResultV1 }
  | { kind: "failed" }
  | { kind: "pending" };

/** 每个能力一张表、一条引用形状；绑定值全部走参数。 */
function noteArtifactCandidate(request: OperationReceiptRequest): SQL | null {
  const capability = request.capability;
  if (request.execution.kind !== "job") return null;
  const jobId = request.execution.id;
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

/** 领域已给终局结论却没有任何可交付成果的档位。 */
const CARD_UNDELIVERABLE_STATUSES = ["failed", "stale", "cancelled", "closed_without_activation", "activating", "activated"];

function cardReceiptCandidate(request: OperationReceiptRequest): SQL {
  const runId = request.execution.kind === "card_generation" ? request.execution.id : null;
  // 审核开放这一格必须在查询里，不能只在返回分支上：cancelled/activated 上留着的
  // passed 行满足其余全部条件，只查候选会把历史记录当成待交付成果。
  return sql`SELECT
      r.id, r.note_id AS "noteId", r.note_version_id AS "noteVersionId", r.status,
      (r.status IN ('review_ready','needs_attention') AND EXISTS (
        SELECT 1 FROM public.card_generation_candidates_v2 c
        WHERE c.workspace_id=r.workspace_id AND c.run_id=r.id
          AND c.quality_state='passed' AND c.review_decision='undecided'
          AND c.publish_state='unpublished' AND c.evidence_binding_plan_hash IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.card_generation_candidates_v2 newer
            WHERE newer.workspace_id=c.workspace_id AND newer.run_id=c.run_id
              AND newer.candidate_id=c.candidate_id AND newer.revision>c.revision)
      )) AS "reviewableCandidate"
    FROM public.card_generation_runs_v2 r
    WHERE r.id=${runId} AND r.workspace_id=${request.scope.workspaceId} AND r.user_id=${request.scope.userId}
    LIMIT 1`;
}

/** 已保存的领域事件才是无卡推荐的理由来源；正文不猜、不生成。 */
function cardReasonCodes(runId: string, workspaceId: string): SQL {
  return sql`SELECT (SELECT e.payload->'reasonCodes'
            FROM public.card_generation_events_v2 e
           WHERE e.workspace_id=${workspaceId} AND e.run_id=${runId}
             AND e.event_type='card_generation.no_cards_recommended'
           ORDER BY e.event_seq DESC LIMIT 1) AS "reasonCodes"`;
}

function clipReasonCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const codes: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const code = value.trim().slice(0, 100);
    if (code) codes.push(code);
    if (codes.length >= 20) break;
  }
  return codes;
}

interface CardReceiptRow {
  id: string; noteId: string; noteVersionId: string; status: string; reviewableCandidate: boolean;
}

/** 制卡候选没有 jobId，这一档单独收窄出类型。 */
type NoteArtifactRefV1 = Extract<AgentArtifactRefV1, { jobId: string }>;

async function readCardReceipt(
  tx: AgentSqlExecutor, request: OperationReceiptRequest,
): Promise<OperationReceiptV1> {
  // 多列结果不能包成标量子查询：直接查、直接读行。
  const [card] = await queryRows<CardReceiptRow>(tx, cardReceiptCandidate(request));
  // 身份对不上（跨空间/跨用户，或这张 run 不存在）＝ 没有可核对的领域事实，不算失败。
  if (!card) return { kind: "pending" };
  // 冻结材料：目标可以冻结多份材料，落在 inputs 之外的那批不是这次目标的交付。
  if (!request.inputs.some(input => input.noteId === card.noteId && input.noteVersionId === card.noteVersionId)) {
    return { kind: "failed" };
  }

  const artifact: AgentArtifactRefV1 = {
    kind: "card_candidates", id: card.id, noteId: card.noteId, noteVersionId: card.noteVersionId,
  };
  if (card.reviewableCandidate) return { kind: "result", result: { kind: "artifact", artifact } };

  // 零推荐：领域如实给出的正常收口。理由取已保存的领域事件。
  if (card.status === "no_cards_recommended") {
    const [reasons] = await queryRows<{ reasonCodes: unknown }>(tx,
      sql`SELECT (${cardReasonCodes(card.id, request.scope.workspaceId)}) AS "reasonCodes"`);
    return { kind: "result", result: { kind: "no_cards_recommended", reasonCodes: clipReasonCodes(reasons?.reasonCodes) } };
  }

  // needs_attention 且没有可审候选：领域已经给出终局结论，不再等。
  if (card.status === "needs_attention") return { kind: "failed" };
  if (CARD_UNDELIVERABLE_STATUSES.includes(card.status)) return { kind: "failed" };
  // review_ready 但查不到一张带证据的可审候选：领域说候选可审，而交付证据仍然缺。
  // 这不是确定失败——终态事件把它落成 outcome_unknown，由四次有限恢复核对等证据补齐；
  // 把「核对不到」宣称为失败，或自动重建一批，都会拿一个不确定的结论当事实。
  return { kind: "pending" };
}

/**
 * 一次事件消费所需的权威结果：result → succeeded，failed → failed，pending →
 * 按事件状态 accepted/running（终局而仍 pending 即 outcome_unknown）。
 */
export async function readOperationResultReceipt(
  tx: AgentSqlExecutor,
  request: OperationReceiptRequest,
): Promise<OperationReceiptV1> {
  // capability 与 execution 必须同时对上：错配一律不产结果，退化成 outcome_unknown
  // 而不是给一个不该有的能力算出成果。
  const isCard = request.execution.kind === "card_generation"
    && request.capability === AGENT_CARD_GENERATION_CAPABILITY;
  if (isCard) return readCardReceipt(tx, request);
  if (request.execution.kind !== "job") return { kind: "pending" };

  const candidate = noteArtifactCandidate(request);
  if (!candidate) return { kind: "pending" };
  const [row] = await queryRows<{ artifact: unknown }>(tx, sql`SELECT (${candidate}) AS artifact`);
  if (!row || row.artifact === null || row.artifact === undefined) return { kind: "pending" };
  const artifact = parseNoteArtifact(row.artifact);
  // 查询已绑死 job 与材料；这里再钉一遍不变量，并要求材料确实被这个目标冻结过。
  if (!artifact || artifact.jobId !== request.execution.id) return { kind: "pending" };
  if (!request.inputs.some((input) => input.noteId === artifact.noteId && input.noteVersionId === artifact.noteVersionId)) {
    return { kind: "pending" };
  }
  return { kind: "result", result: { kind: "artifact", artifact } };
}

function parseNoteArtifact(raw: unknown): NoteArtifactRefV1 | null {
  if (typeof raw !== "object" || raw === null) return null;
  // 制卡候选没有 jobId，不属于这一档：宁可当没有产物，也不要给一个 job 执行体配上它。
  if ((raw as { kind?: unknown }).kind === "card_candidates") return null;
  const parsed = agentArtifactRefV1Schema.safeParse(raw);
  return parsed.success && "jobId" in parsed.data ? parsed.data : null;
}