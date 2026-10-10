/**
 * 伴星后台反思的持久化端口（方案 50 §8.3 / §9，迁移 0400）。
 *
 * 与 `identity.ts` 一样住在 agent-host：API（采用前的来源复查、人格页显示来源）与
 * worker（反思任务写结论）读的是同一份事实。两边各自抄一遍 SQL，早晚会出现
 * "API 说这条建议有依据、worker 说没有"这种答不出真话的状态。
 *
 * ## 这里没有第二套 running / lease 状态机
 *
 * 执行状态归现役 `jobs` / attempt / checkpoint。`decision` 那一列记的是**业务结论**
 * （这次回顾值不值得改），不是"跑到哪一步了"。§8.3 说的就是这条边界。
 */

import { sql } from "drizzle-orm";
import type { AgentSqlExecutor } from "./store.ts";
import { queryRows } from "./store.ts";
import type { CompanionPersonaPendingProposalV1, CompanionPersonaSourceRefV1 } from "./identity.ts";
import { personaSourcesCurrent, restorePersonaFieldsFromDeadSource } from "./identity.ts";
import { personaFromDefaultPreset } from "@astella/shared/pet-persona-merge";
import { getDefaultPersonaPreset } from "@astella/shared/pet-persona-presets";
import type { CompanionPersonaProfileContent } from "@astella/shared/db-schema/companion-memory";

/**
 * 反思的策略版本。
 *
 * 它进幂等键与结论记录：同一段交流在不同策略下可以得出不同结论，而拿同一个号
 * 冒充"已经回顾过"会让旧策略的 no_change 永久挡住新策略。（方案 50 §8.3 重复触发键）
 */
export const COMPANION_REFLECTION_STRATEGY_VERSION = "reflection-v1";

/**
 * 触发门槛：结构性判据的数字，与迁移 0400 的 `astella_companion_reflection_thresholds()`
 * 必须一致（由 `0400-companion-persona-reflection-migration.test.ts` 断言）。
 *
 * 「什么算一次值得回顾的相处」只由这几条**已记录的事实**决定：真的来回过、上一段已经
 * 回顾过就不重复、同一账号排队的反思有上限。用关键词去猜"用户这次是在纠正她"是
 * 方案 50 §3 明确不收的那类启发式——猜错一次的代价是她记住一条根本没说过的偏好。
 */
export const COMPANION_REFLECTION_THRESHOLDS = {
  minUserMessages: 3,
  minAssistantMessages: 2,
  minIntervalHours: 24,
  maxOpenPerAccount: 3,
} as const;

/** 输入快照的有界容量：单次回顾能读多少条原话、多少字。成本上限，不是表达篇幅。 */
export const COMPANION_REFLECTION_INPUT_BUDGET = {
  maxMessages: 24,
  maxMessageChars: 600,
  maxAssistantChars: 400,
  maxToolReceipts: 8,
  maxRelatedMemories: 6,
} as const;

/**
 * 反思的结论码只有一个定义处：`@astella/shared/db-schema/companion-memory`
 * （那里同时是 0400/0401 两条 CHECK 的镜像）。在这里再抄一份枚举，
 * 结果就是"库里允许、端口拒收"这种谁都没错的失败。
 */
import type {
  CompanionReflectionDecision,
} from "@astella/shared/db-schema/companion-memory";

export type { CompanionReflectionDecision };

export type CompanionReflectionTriggerKind = "exchange_segment";

export interface CompanionReflectionRowV1 {
  readonly id: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly triggerKind: CompanionReflectionTriggerKind;
  readonly inputFromSeq: number;
  readonly inputToSeq: number;
  readonly strategyVersion: string;
  readonly baselinePersonaRevision: number;
  readonly decision: CompanionReflectionDecision;
  readonly jobId: string | null;
  readonly inputSnapshot: unknown;
  readonly inputFingerprint: string;
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

function projectReflection(row: {
  id: string; user_id: string; workspace_id: string; conversation_id: string;
  trigger_kind: string; input_from_seq: string | number; input_to_seq: string | number;
  strategy_version: string; baseline_persona_revision: string | number; decision: string;
  job_id: string | null; input_snapshot: unknown; input_fingerprint: string;
}): CompanionReflectionRowV1 {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    conversationId: String(row.conversation_id),
    triggerKind: row.trigger_kind as CompanionReflectionTriggerKind,
    inputFromSeq: Number(row.input_from_seq),
    inputToSeq: Number(row.input_to_seq),
    strategyVersion: row.strategy_version,
    baselinePersonaRevision: Number(row.baseline_persona_revision),
    decision: row.decision as CompanionReflectionDecision,
    jobId: row.job_id,
    inputSnapshot: row.input_snapshot,
    inputFingerprint: row.input_fingerprint,
  };
}

/**
 * 幂等地拿到这次反思那一行：job 重投、worker 重启、同一幂等键的第二次执行都落在**同一行**。
 *
 * `ON CONFLICT DO NOTHING` 之后再读回来；`dedupe_key` 的唯一约束在库侧
 * （`(user_id, dedupe_key)`），所以两个空间同时触发也并不到一条上。
 */
export async function createOrLoadReflection(
  tx: AgentSqlExecutor,
  input: {
    userId: string;
    workspaceId: string;
    conversationId: string;
    jobId?: string | null;
    dedupeKey: string;
    inputFingerprint: string;
    inputSnapshot?: unknown;
    baselinePersonaRevision: number;
    fromSeq: number;
    toSeq: number;
    strategyVersion?: string;
  },
): Promise<CompanionReflectionRowV1 | null> {
  const strategyVersion = input.strategyVersion ?? COMPANION_REFLECTION_STRATEGY_VERSION;
  await tx.execute(sql`
    INSERT INTO companion_reflections
      (user_id, workspace_id, conversation_id, job_id, trigger_kind,
       input_from_seq, input_to_seq, input_fingerprint, dedupe_key, strategy_version,
       baseline_persona_revision, decision, input_snapshot)
    VALUES (${input.userId}, ${input.workspaceId}, ${input.conversationId},
            ${input.jobId ?? null}::uuid, 'exchange_segment',
            ${input.fromSeq}, ${input.toSeq}, ${input.inputFingerprint}, ${input.dedupeKey},
            ${strategyVersion}, ${input.baselinePersonaRevision}, 'queued',
            ${JSON.stringify(input.inputSnapshot ?? null)}::jsonb)
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
  `);
  const rows = await queryRows<Parameters<typeof projectReflection>[0]>(tx, sql`
    SELECT id, user_id, workspace_id, conversation_id, trigger_kind,
           input_from_seq, input_to_seq, strategy_version, baseline_persona_revision, decision,
           job_id, input_snapshot, input_fingerprint
    FROM companion_reflections
    WHERE user_id = ${input.userId} AND dedupe_key = ${input.dedupeKey}
    LIMIT 1 FOR UPDATE
  `);
  const row = rows[0];
  return row ? projectReflection(row) : null;
}

/** 认领这次执行：只有还停在 `queued` 的行能被推到 `running`，重放不会再跑一遍模型。 */
export async function claimReflectionRun(
  tx: AgentSqlExecutor,
  userId: string,
  reflectionId: string,
  jobId: string,
): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(tx, sql`
    UPDATE companion_reflections
       SET decision = 'running', job_id = ${jobId}::uuid, updated_at = now()
     WHERE id = ${reflectionId}::uuid AND user_id = ${userId} AND decision = 'queued'
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * 写一个终态结论。
 *
 * `no_change` 是**正常终态**（§9.2「没有改动也是正常终态」），不是失败；所以这一句
 * 不推人格版本、不建记忆，只把结论码与脱敏短句落下来。
 * 已经有终态结论的行不会被后来的迟到执行覆盖——那是 §15.1 要的"重复触发不重复成版"。
 */
export async function finalizeReflection(
  tx: AgentSqlExecutor,
  userId: string,
  reflectionId: string,
  outcome: {
    decision: Exclude<CompanionReflectionDecision, "queued" | "running">;
    summary?: string | null;
    pendingPersonaRevision?: number | null;
    resultRef?: Record<string, unknown> | null;
  },
): Promise<boolean> {
  const summary = (outcome.summary ?? null);
  if (summary !== null && summary.length > 300) {
    throw new Error("reflection decision summary must stay within 300 characters");
  }
  const rows = await queryRows<{ id: string }>(tx, sql`
    UPDATE companion_reflections
       SET decision = ${outcome.decision},
           decision_summary = ${summary},
           pending_persona_revision = ${outcome.pendingPersonaRevision ?? null},
           input_snapshot = NULL,
           result_ref = ${outcome.resultRef === undefined || outcome.resultRef === null
             ? sql`result_ref` : sql`${JSON.stringify(outcome.resultRef)}::jsonb`},
           updated_at = now()
     WHERE id = ${reflectionId}::uuid
       AND user_id = ${userId}
       AND decision IN ('queued', 'running')
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * 记一条派生关系边。
 *
 * `read` 边是**这次结论的依据**（原文、回执、记忆版本）；`produced` 边是这次留下的
 * 版本。撤回按 read 边找受影响的东西，重放按 (reflection, relation, kind, id, revision)
 * 的唯一约束自然幂等。
 */
export async function recordReflectionEdge(
  tx: AgentSqlExecutor,
  userId: string,
  reflectionId: string,
  edge: {
    relation: "read" | "cited" | "produced";
    workspaceId: string;
    source: CompanionPersonaSourceRefV1;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO companion_reflection_sources
      (reflection_id, user_id, workspace_id, relation, source_kind, source_id, source_revision)
    VALUES (${reflectionId}::uuid, ${userId}, ${edge.workspaceId}, ${edge.relation},
            ${edge.source.kind}, ${edge.source.id}, ${edge.source.revision ?? ""})
    ON CONFLICT (reflection_id, relation, source_kind, source_id, source_revision) DO NOTHING
  `);
}

/** 这次回顾读过哪些依据（诊断"她当时看得见什么"）。 */
export async function loadReflectionReadSources(
  tx: AgentSqlExecutor,
  userId: string,
  reflectionId: string,
): Promise<CompanionPersonaSourceRefV1[]> {
  return loadReflectionEdges(tx, userId, reflectionId, "read");
}

/**
 * 这次回顾的结论**点名引用**了哪些依据。
 *
 * 与 `read` 分开是撤回判据的要求：一段相处里六句话都被读过，而那一版自我描述只引用
 * 其中一句——用户删掉任何一句都不该让整版失去依据，只有删掉被引用那一句才算。
 * 粒度是一条反思（这一批结论一起落下），不是一条结论：库里没有按条区分依据的列，
 * 宁可这里粗一点，也不把"读过"当成"依据"。
 */
export async function loadReflectionCitedSources(
  tx: AgentSqlExecutor,
  userId: string,
  reflectionId: string,
): Promise<CompanionPersonaSourceRefV1[]> {
  return loadReflectionEdges(tx, userId, reflectionId, "cited");
}

async function loadReflectionEdges(
  tx: AgentSqlExecutor,
  userId: string,
  reflectionId: string,
  relation: "read" | "cited" | "produced",
): Promise<CompanionPersonaSourceRefV1[]> {
  const rows = await queryRows<{ source_kind: string; source_id: string; source_revision: string }>(tx, sql`
    SELECT source_kind, source_id, source_revision
    FROM companion_reflection_sources
    WHERE user_id = ${userId} AND reflection_id = ${reflectionId}::uuid AND relation = ${relation}
    ORDER BY created_at, id
  `);
  return rows.map((row) => ({
    kind: row.source_kind as CompanionPersonaSourceRefV1["kind"],
    id: String(row.source_id),
    revision: row.source_revision ? String(row.source_revision) : null,
  }));
}

/**
 * 一条待生效提议此刻还站得住的依据。
 *
 * - 后台反思提的：使用专属于人格提案的来源；旧批次缺少细分记录时，保守核对全部
 *   read 边（含原始版本），等待新回顾重评，不能把批次中另一条判断的来源当成支持。
 * - 前台工具提的：那次运行的工具回执还在（会话被删时它们一起消失）——
 *   所以"用户把那条消息删了"会让这一版失去依据，不会在下一次被接受时悄悄生效。
 * - 来源不明的历史版本（这两列为空）：不猜，按原来的语义仍可被采用。
 */
export async function pendingPersonaProposalSources(
  tx: AgentSqlExecutor,
  userId: string,
  pending: CompanionPersonaPendingProposalV1,
): Promise<CompanionPersonaSourceRefV1[]> {
  if (!pending.proposalKind || !pending.proposalId) return [];
  if (pending.proposalKind === "assistant_reflection") {
    // A judgment in the same batch cannot supply the basis for a persona edit.
    const [row] = await queryRows<{ result_ref: { personaSources?: CompanionPersonaSourceRefV1[] } | null }>(tx, sql`
      SELECT result_ref FROM companion_reflections
      WHERE user_id=${userId} AND id=${pending.proposalId}::uuid
    `);
    if (Array.isArray(row?.result_ref?.personaSources)) return row.result_ref.personaSources;
    return loadReflectionReadSources(tx, userId, pending.proposalId);
  }
  const rows = await queryRows<{ id: string; name: string; arguments_sha256: string }>(tx, sql`
    SELECT c.id, c.name, c.arguments_sha256
    FROM companion_agent_tool_calls c
    WHERE c.user_id = ${userId} AND c.run_id = ${pending.proposalId}::uuid
      AND c.name IN ('companion_revise_own_style', 'companion_revise_own_tags')
    ORDER BY c.created_at
  `);
  return rows.map((row) => ({
    kind: "tool_receipt" as const,
    id: String(row.id),
    revision: String(row.arguments_sha256 ?? ""),
  }));
}

/** Revalidate adopted automatic fields before the next accepted conversation. */
export async function reconcileReflectedPersonaSources(tx: AgentSqlExecutor, userId: string): Promise<void> {
  const rows = await queryRows<{
    id: string; pending_persona_revision: number; persona_revision: number;
    result_ref: { personaSources?: CompanionPersonaSourceRefV1[]; personaFields?: string[] } | null;
    proposal_profile: CompanionPersonaProfileContent;
    baseline_profile: CompanionPersonaProfileContent | null;
  }>(tx, sql`
    SELECT r.id,r.pending_persona_revision,p.revision AS persona_revision,r.result_ref,
      v.profile AS proposal_profile,b.profile AS baseline_profile
    FROM companion_reflections r JOIN companion_persona_profiles p ON p.user_id=r.user_id
    JOIN companion_persona_profile_versions v ON v.user_id=r.user_id AND v.revision=r.pending_persona_revision
    LEFT JOIN companion_persona_profile_versions b ON b.user_id=r.user_id AND b.revision=r.baseline_persona_revision
    WHERE r.user_id=${userId} AND r.decision='committed' AND r.pending_persona_revision<=p.revision
    ORDER BY r.pending_persona_revision DESC
  `);
  const handled = new Set<string>();
  let currentRevision = Number(rows[0]?.persona_revision ?? 0);
  for (const row of rows) {
    const baseline = row.baseline_profile ?? personaFromDefaultPreset(getDefaultPersonaPreset());
    // Earlier reflections predate field/source metadata. Immutable versions
    // still identify their automatic edits; their read edges are a conservative
    // basis until a fresh reflection can assess narrower independent support.
    const proposedFields = row.result_ref?.personaFields ?? (["selfDescription","speakingStyle"] as const).filter(
      field=>row.proposal_profile.fieldOrigin?.[field]==="assistant" && row.proposal_profile[field]!==baseline[field]);
    const fields = proposedFields.filter(
      (field): field is "selfDescription" | "speakingStyle" =>
        (field === "selfDescription" || field === "speakingStyle") && !handled.has(field));
    fields.forEach(field => handled.add(field));
    const sources = row.result_ref?.personaSources ?? await loadReflectionReadSources(tx,userId,row.id);
    if (fields.length === 0 || (sources.length > 0 && (await personaSourcesCurrent(tx, userId, sources)).current)) continue;
    const restored = await restorePersonaFieldsFromDeadSource(tx,userId,{
      revision: currentRevision, fields, proposalProfile: row.proposal_profile,
      baselineProfile: baseline,
    }, "自动表达修订的来源已失效，恢复受影响字段并保留后续设置");
    if (restored.kind === "conflict") continue;
    if (restored.kind === "changed") {
      currentRevision = restored.revision;
      // The baseline can itself be an older automatic proposal with dead
      // sources. Follow only fields actually restored, within this same turn.
      for (const field of restored.restoredFields ?? []) handled.delete(field);
    }
    await markReflectionProposalWithdrawn(tx,userId,row.id,"已采用的表达修订来源失效，受影响字段已复查撤回");
  }
}

/**
 * 把一条**已经写下、但采用时失去依据**的结论标成撤回（§12.2 的「来源失效」）。
 *
 * 只允许 `committed` → `source_invalid` 这一条窄路：反思那一行的 `decision`
 * 说的是"她这次回顾得出了什么"，采用是另一件事。但用户把原话删了之后，
 * 那一版建议永远不会生效——留在 `committed` 上，排查的人会以为人格里已经有了它。
 * `result_ref` 与 `produced` 边都原样留着：这次确实写过判断与方法，那部分**不撤销**
 * （它们的依据各自另有核对），只有人格那一版退回排队之外。
 */
export async function markReflectionProposalWithdrawn(
  tx: AgentSqlExecutor,
  userId: string,
  reflectionId: string,
  reason: string,
): Promise<boolean> {
  const rows = await queryRows<{ id: string }>(tx, sql`
    UPDATE companion_reflections
       SET decision = 'source_invalid',
           decision_summary = ${reason.slice(0, 300)},
           updated_at = now()
     WHERE id = ${reflectionId}::uuid
       AND user_id = ${userId}
       AND decision = 'committed'
       AND pending_persona_revision IS NOT NULL
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * 顺着 read 边找出**还依赖这条来源**的反思（方案 50 §9.4 的递进核对）。
 *
 * 撤回不整片扫："这一版只由这条已失效来源支撑"才撤；同一结论若还有别的独立依据，
 * 交给下一次回顾在新基线上重评，而不是在这里替模型下判断。
 */
export async function findReflectionsDependingOnSource(
  tx: AgentSqlExecutor,
  userId: string,
  source: CompanionPersonaSourceRefV1,
): Promise<{ readonly reflectionId: string; readonly pendingPersonaRevision: number | null }[]> {
  const rows = await queryRows<{ reflection_id: string; pending_persona_revision: number | null }>(tx, sql`
    SELECT r.id AS reflection_id, r.pending_persona_revision
    FROM companion_reflection_sources s
    JOIN companion_reflections r ON r.id = s.reflection_id
    WHERE s.user_id = ${userId}
      AND s.source_kind = ${source.kind}
      AND s.source_id = ${source.id}
      AND r.decision IN ('queued', 'running', 'proposed')
  `);
  return rows.map((row) => ({
    reflectionId: String(row.reflection_id),
    pendingPersonaRevision: row.pending_persona_revision === null ? null : Number(row.pending_persona_revision),
  }));
}

/** 某条来源是否还被别的独立依据支撑（用于"尚有依据就重评，不只撤"）。 */
export async function countReflectionReadEdgesForOtherSources(
  tx: AgentSqlExecutor,
  userId: string,
  reflectionId: string,
): Promise<number> {
  const rows = await queryRows<{ found: number }>(tx, sql`
    SELECT count(*)::int AS found
    FROM companion_reflection_sources
    WHERE user_id = ${userId} AND reflection_id = ${reflectionId}::uuid AND relation = 'read'
  `);
  return Number(rows[0]?.found ?? 0);
}

/**
 * 反思的排队与等待（诊断用，§12.2「等待队列」与「最旧等待时间」）。
 *
 * 只限制并发是不够的：低频账号可能永远排不到，这里给诊断留一个能答出"卡了几条、
 * 最旧一条等了多久"的入口。
 */
export async function readReflectionBacklog(
  tx: AgentSqlExecutor,
  userId: string,
): Promise<{ readonly open: number; readonly oldestQueuedAt: string | null }> {
  const rows = await queryRows<{ open: number; oldest_at: unknown }>(tx, sql`
    SELECT count(*)::int AS open, min(created_at) FILTER (WHERE decision = 'queued') AS oldest_at
    FROM companion_reflections
    WHERE user_id = ${userId} AND decision IN ('queued', 'running')
  `);
  const row = rows[0];
  return {
    open: Number(row?.open ?? 0),
    oldestQueuedAt: row?.oldest_at ? toIso(row.oldest_at) : null,
  };
}
