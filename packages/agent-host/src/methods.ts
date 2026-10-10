import { sql } from "drizzle-orm";
import { groupAgentMethodEvidenceOrigins, planAgentMethodProposal, planMethodStepsFromRun, reconcileEvidenceEpistemicStatus } from "@astella/agent-core";
import { agentGoalCapabilityManifest } from "@astella/shared/agent-capabilities";
import {
  agentMethodV1Schema, agentMethodUseV1Schema,
  type AgentMethodV1, type AgentMethodEvidenceV1, type AgentMethodCapabilityV1,
  type proposeAgentMethodV1Schema, type reviseAgentMethodV1Schema, type controlAgentMethodV1Schema,
} from "@astella/shared/agent-growth-contracts";
import type { z } from "zod";
import { agentMethodEvidenceV1Schema } from "@astella/shared/agent-growth-contracts";
import type { AgentScopeV1 } from "@astella/shared/agent-contracts";
import { AgentStoreError, queryRows, readRun, projectRun, type AgentSqlExecutor, type AgentStorePorts } from "./store.ts";

export interface AgentMethodRow {
  id: string; playbook_key: string; version: number; title: string; trigger_condition: string; steps: string[]; exceptions: string[];
  evidence: AgentMethodEvidenceV1[]; capability_refs: AgentMethodCapabilityV1[];
  method_state: AgentMethodV1["state"]; epistemic_status: AgentMethodV1["epistemicStatus"];
  user_controlled: boolean; author: AgentMethodV1["author"];
  change_reason: string | null; source_run_id: string | null; source_run_revision: number | null;
  created_at: Date | string; updated_at: Date | string; sources_current?: boolean; evidence_origins?: unknown;
  offered_count?: number | string; adopted_count?: number | string;
  consulted_count?: number | string; helpful_count?: number | string; unhelpful_count?: number | string; last_consulted_at?: Date | string | null;
}
const iso = (value: Date | string) => new Date(value).toISOString();
/**
 * 依据的独立来源数（§6.4）。
 *
 * 0387 之前写的行没有归并回执，此时退回 `evidence.length`：那是**上界**，不会低估
 * 支持，只是没能识别同源。宁可保守，也不要把一个数凭空算小。
 */
function readEvidenceIndependentCount(row: AgentMethodRow): number {
  const origins = row.evidence_origins;
  if (origins && typeof origins === "object" && !Array.isArray(origins)) {
    const value = (origins as { independentCount?: unknown }).independentCount;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return row.evidence?.length ?? 0;
}
/** 每条方法都带的那句边界，不随来源变化。 */
const AGENT_METHOD_BASELINE_EXCEPTION =
  "当前要求、材料、权限和可用能力优先；旧产物与旧确认不作为新任务的交付或授权。";
/** 能力目录里的呈现文案就是方法步骤的骨架（真正的做法提炼仍待领域标注）。 */
const agentMethodStepFor = (capability: string): string =>
  agentGoalCapabilityManifest.find(entry=>entry.definition.name===capability)?.presentation.methodStep
  ?? "按当前目标和材料核对后续步骤。";
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
    // §6.4：`evidence` 是完整派生关系，「有几条依据」按原始来源算。缺回执的旧行
    // （0387 之前写的）退回自身长度——那不会低估，只是没能识别同源。
    evidenceIndependentCount: readEvidenceIndependentCount(row),
    capabilities: row.capability_refs, state: row.method_state, epistemicStatus: row.epistemic_status, availability,
    userControlled: row.user_controlled, author: row.author,
    changeReason: row.change_reason, sourceRunId: row.source_run_id, sourceRunRevision: row.source_run_revision,
    offeredCount: Number(row.offered_count ?? 0), adoptedCount: Number(row.adopted_count ?? 0),
    consultedCount: Number(row.consulted_count ?? 0), helpfulCount: Number(row.helpful_count ?? 0), unhelpfulCount: Number(row.unhelpful_count ?? 0),
    lastConsultedAt: row.last_consulted_at ? iso(row.last_consulted_at) : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
/**
 * 使用统计（方案 44 §6.3）。
 *
 * 口径按 `stage` 分开——`count(*)` 会把「目录被提供」也算成阅读，而这正是 §6.3 点名
 * 禁止的：阅读次数不能直接记成采用或有帮助。
 */
const stats = sql`LEFT JOIN LATERAL (SELECT
  count(*) FILTER (WHERE stage='offered') AS offered_count,
  count(*) FILTER (WHERE stage IN ('read','adopted')) AS consulted_count,
  count(*) FILTER (WHERE stage='adopted') AS adopted_count,
  count(*) FILTER (WHERE feedback='helpful') AS helpful_count, count(*) FILTER (WHERE feedback='unhelpful') AS unhelpful_count,
  max(created_at) FILTER (WHERE stage IN ('read','adopted')) AS last_consulted_at FROM companion_method_uses u
  WHERE u.method_id=p.id AND u.workspace_id=p.workspace_id AND u.user_id=p.user_id AND u.method_revision=p.version) s ON true`;
async function readRow(tx: AgentSqlExecutor, scope: AgentScopeV1, id: string): Promise<AgentMethodRow> {
  const [row] = await queryRows<AgentMethodRow>(tx, sql`SELECT p.*,s.*,
    astella_agent_method_sources_current(p.id,p.workspace_id,p.user_id) AS sources_current
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
    astella_agent_method_sources_current(p.id,p.workspace_id,p.user_id) AS sources_current
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
  if (consultation) await recordAgentMethodEngagement(tx, scope, {
    methodId: id, methodRevision: revision, stage: "read",
    kind: consultation.kind, contextId: consultation.id, contextRevision: consultation.revision,
    sourceKey: consultation.sourceKey,
  });
  return method;
}

/**
 * 记一次「目录被提供」（方案 44 §6.1／§6.3）。
 *
 * 与「读过正文」分开记：目录出现只说明她**看见过**这条做法，不说明她采用或认同它。
 * 把两者算进同一个计数，就是对 §6.3 那条纪律的违反。
 */
export async function recordAgentMethodOffered(tx: AgentSqlExecutor, scope: AgentScopeV1, input: {
  methods: ReadonlyArray<{ methodId: string; revision: number }>;
  kind: "agent_goal" | "conversation";
  contextId: string; contextRevision: number; sourceKey: string;
}): Promise<void> {
  for (const method of input.methods) {
    await recordAgentMethodEngagement(tx, scope, {
      methodId: method.methodId, methodRevision: method.revision, stage: "offered",
      kind: input.kind, contextId: input.contextId, contextRevision: input.contextRevision,
      // 同一次提供只留一行：sourceKey 已经带上上下文版本，重复装配不会重复计数。
      sourceKey: `${input.sourceKey}:offered`,
    });
  }
}

/** 使用记录的唯一写入口。`ON CONFLICT DO NOTHING` 让同一次使用可重放而不重复计数。 */
async function recordAgentMethodEngagement(tx: AgentSqlExecutor, scope: AgentScopeV1, input: {
  methodId: string; methodRevision: number; stage: "offered" | "read" | "adopted";
  kind: "agent_goal" | "conversation"; contextId: string; contextRevision: number; sourceKey: string;
}): Promise<void> {
  await tx.execute(sql`INSERT INTO companion_method_uses
    (method_id,workspace_id,user_id,method_revision,stage,context_kind,context_id,context_revision,source_key)
    VALUES(${input.methodId},${scope.workspaceId},${scope.userId},${input.methodRevision},${input.stage},
      ${input.kind},${input.contextId},${input.contextRevision},${input.sourceKey})
    ON CONFLICT(workspace_id,user_id,method_id,method_revision,source_key) DO NOTHING`);
}

/** Source rows are locked before the derived method, matching memory invalidation's lock order. */
export type AgentMethodCandidateOutcomeV1 = "created" | "updated" | "coexisting";

export interface AgentMethodCandidateResultV1 {
  outcome: AgentMethodCandidateOutcomeV1;
  playbookId: string;
  version: number;
}

/** 用户控制或已停用的条目上再提候选时用的稳定后缀（§6.4 的「并存」）。 */
const ALTERNATE_KEY_SUFFIX = ":alternate";

/**
 * 一条记忆的**来源键**：用来判断两条依据是不是同源（§6.4「只算同源依据」）。
 *
 * 取 `source_event_id`（若为空则取 `source_event_ids` 的全部元素，排序后拼成一个键）：
 * 摘要器那一趟写出来的记忆共享同一个 `summary:<会话>:<运行>`，于是它们自动归为同源。
 * 没有任何来源信息的记忆返回 null——它**不参与**归并判断，也不该被当成独立佐证。
 */
function memoryOriginKey(
  sourceType: string | null, sourceEventId: string | null, sourceEventIds: string[] | null,
): string | null {
  const event = sourceEventId?.trim();
  if (event) return `${sourceType ?? "unknown"}:${event}`;
  const many = (sourceEventIds ?? []).map(value => value.trim()).filter(Boolean).sort();
  return many.length > 0 ? `${sourceType ?? "unknown"}:${many.join("|")}` : null;
}

export async function upsertAgentMethodCandidate(tx: AgentSqlExecutor, scope: AgentScopeV1, input: {
  playbookKey: string; title: string; triggerCondition: string; steps: string[]; exceptions: string[];
  evidence: AgentMethodEvidenceV1[]; epistemicStatus: "tentative" | "supported" | "disputed";
  author: "user" | "companion" | "extractor" | "maintenance";
}): Promise<AgentMethodCandidateResultV1 | null> {
  const parsed = input.evidence.map(ref => agentMethodEvidenceV1Schema.parse(ref));
  if (!parsed.length) return null;
  /**
   * 方案 44 §6.4：**保存完整派生关系，识别共同原始来源，「只算同源依据」**。
   *
   * 三件事必须分开做，合成一件就会出错：
   *   - `evidence` **保完整**：一次运行派生出的记忆、摘要、候选都要留在里面。
   *     `astella_propagate_playbook_evidence_change` 正是按 `memoryId` 找派生方法，
   *     用户遗忘或纠正一条记忆时要让它失效——把记忆引用折掉，这条传播路径就断了。
   *   - `evidenceOrigins` 存来源归并回执，供**计数**用。
   *   - 认识状态按归并结果校正：同源重述不得包装成多方印证。
   *
   * **这一段的第一版查的是不存在的列。** 原以为「这条记忆派生自哪次运行」记在
   * `assistant_memory_items.source_run_id / source_run_revision` 里——真库上根本没有这两列
   * （它们在 `companion_method_uses` 上），于是整个 `upsertAgentMethodCandidate` **一次都没
   * 成功执行过**，而当时所有单测都是绿的。教训和 0389、0385 一样：判据停在了「代码长什么样」。
   *
   * 真实的来源信息在 `source_event_id / source_event_ids`：摘要器写记忆时用的是
   * `summary:<conversationId>:<runId>`（或没有 runId 时的 `…:conversation`）。
   * **同一趟摘要派生出的多条记忆共享同一个这个 id**——这正是「同源」要识别的东西，
   * 所以不需要一个额外的运行列：来源键本身就是它。
   */
  const memoryIds = [...new Set(parsed.flatMap(ref => (ref.memoryId ? [ref.memoryId] : [])))];
  const memoryOrigins = new Map<string, { originKey: string }>();
  if (memoryIds.length > 0) {
    const rows = await queryRows<{ id: string; source_type: string | null; source_event_id: string | null; source_event_ids: string[] | null }>(tx, sql`
      SELECT id, source_type, source_event_id, source_event_ids FROM assistant_memory_items
      WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
        AND id IN (${sql.join(memoryIds.map(id => sql`${id}::uuid`), sql`, `)})`);
    for (const row of rows) {
      const originKey = memoryOriginKey(row.source_type, row.source_event_id, row.source_event_ids);
      if (originKey) memoryOrigins.set(row.id, { originKey });
    }
  }
  const grouping = groupAgentMethodEvidenceOrigins(parsed.map(ref => ({
    ref,
    memoryOrigin: ref.memoryId ? memoryOrigins.get(ref.memoryId) ?? null : null,
  })));
  const evidence = parsed;
  // 多条依据归并后只剩一个出处时，`supported` 降为 `tentative`：那正是
  // 「把同源重述包装成多方印证」的形状（§6.4）。单条依据声称 supported 不受影响——
  // 一条可核对的具体事实本来就能支撑一条有边界的做法（§6.2）。
  const epistemicStatus = reconcileEvidenceEpistemicStatus({
    claimed: input.epistemicStatus, originalCount: parsed.length, grouping,
  });
  const evidenceOrigins = {
    independentCount: grouping.independentCount,
    mergedCount: grouping.mergedCount,
    origins: grouping.origins.map(entry => ({ originKey: entry.originKey, refCount: entry.refCount })),
  };
  for (const ref of [...evidence].sort((a,b)=>(a.memoryId ?? "").localeCompare(b.memoryId ?? ""))) {
    // 这一段锁的是**记忆行**（防止依据在写候选的当口被纠正或遗忘）。
    // 事件/运行来源没有那一行可锁：以前这里对任何不带 memoryId 的依据直接 `return null`，
    // 于是"一条只引用了原话的方法候选"永远写不进去，而调用方只看到一个 null——
    // 与"这次没有可用依据"长得一模一样（后台反思那条通路就是这么撞上的）。
    if (!ref.memoryId) continue;
    if (!ref.memoryRevision) return null;
    const [source] = await queryRows(tx,sql`SELECT id FROM assistant_memory_items
      WHERE id=${ref.memoryId} AND revision=${ref.memoryRevision}
        AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId}
        AND deleted_at IS NULL AND dismissed_at IS NULL AND archived_at IS NULL
        AND epistemic_status NOT IN ('disputed','superseded')
        AND (valid_from IS NULL OR valid_from<=now()) AND (valid_until IS NULL OR valid_until>now()) FOR SHARE`);
    if (!source) return null;
  }
  /**
   * 写候选。**冲突不静默丢弃**（方案 44 §6.4）。
   *
   * 原来的形状是：`ON CONFLICT … DO UPDATE … WHERE NOT user_controlled`，条件不成立时
   * `RETURNING` 什么都不给，函数返回 `null`——与「这次没有可用依据」**长得一模一样**。
   * 于是后台提炼撞上用户已经确认的方法时，候选悄无声息地消失，调用方也无从知道。
   *
   * 方案给的三条路是「并存、标争议或另提修订」。这里选**并存**，理由是另两条都会
   * 动到用户已经确认的那一份：标争议会让它变成 `source_changed` 而不可采用，
   * 等于后台一次提炼就能让用户的确认失效——那是「擅自覆盖」的另一种形状。
   *
   * 所以：先按原键写；被**用户控制或已标争议**挡住时，落到一个**稳定**的并存键上。
   * 稳定是关键——重复提炼会更新同一行，而不是每跑一次堆一行。
   *
   * **停用是例外**：用户说的是「别再给我这条」，不是「这条归我管」。照样并存的话，
   * 每次提炼都造一份孪生候选，停用就变成了需要反复清理的事——而停用本该是彻底的。
   */
  const write = async (playbookKey: string) => {
    const [row] = await queryRows<{id:string;version:number}>(tx,sql`INSERT INTO companion_procedural_playbooks
      (playbook_key,workspace_id,user_id,title,trigger_condition,steps,exceptions,evidence,evidence_origins,epistemic_status,author)
      VALUES(${playbookKey},${scope.workspaceId},${scope.userId},${input.title},${input.triggerCondition},
        ${JSON.stringify(input.steps)}::jsonb,${JSON.stringify(input.exceptions)}::jsonb,${JSON.stringify(evidence)}::jsonb,
        ${JSON.stringify(evidenceOrigins)}::jsonb,
        ${epistemicStatus},${input.author})
      ON CONFLICT(workspace_id,user_id,playbook_key) DO UPDATE
        SET title=EXCLUDED.title,trigger_condition=EXCLUDED.trigger_condition,steps=EXCLUDED.steps,exceptions=EXCLUDED.exceptions,
          evidence=EXCLUDED.evidence,evidence_origins=EXCLUDED.evidence_origins,epistemic_status=EXCLUDED.epistemic_status,author=EXCLUDED.author,
          method_state='candidate',change_reason='新依据已整理，等待核对。',version=companion_procedural_playbooks.version+1,updated_at=now()
        WHERE NOT companion_procedural_playbooks.user_controlled
          AND companion_procedural_playbooks.method_state NOT IN ('disabled','disputed')
      RETURNING id,version`);
    return row ?? null;
  };

  // `version` 从 1 起、每次 UPDATE 由归档触发器 +1，所以 version===1 ⟺ 这次是新建。
  // 用它而不是 `xmax=0` 那类系统列技巧：判据留在业务字段上，读代码的人不必知道 PG 细节。
  const outcomeOf = (row: { version: number }): AgentMethodCandidateOutcomeV1 =>
    Number(row.version) === 1 ? "created" : "updated";

  const primary = await write(input.playbookKey);
  if (primary) {
    return { outcome: outcomeOf(primary), playbookId: primary.id, version: Number(primary.version) };
  }
  // **已停用**（`method_state = 'disabled'`）不再并存：用户说的是「别再给我这条」，
  // 不是「这条归我管」。每次提炼都造一份孪生候选，只会让停用变成一件需要反复清理的事，
  // 而停用本该是**彻底**的——手册 id 与它（§6.4）。
  // 用户控制或已标争议则不同：那说的是「这条归我管／先别当真」，内容本身没有被否定，
  // 所以并存一份，不覆盖、也不把它标成争议。
  const [blocked] = await queryRows<{ method_state: string }>(tx, sql`
    SELECT method_state FROM companion_procedural_playbooks
    WHERE workspace_id=${scope.workspaceId} AND user_id=${scope.userId} AND playbook_key=${input.playbookKey}`);
  if (blocked?.method_state === "disabled") return null;

  const alternate = await write(`${input.playbookKey}${ALTERNATE_KEY_SUFFIX}`);
  if (!alternate) return null;
  return {
    outcome: "coexisting",
    playbookId: alternate.id, version: Number(alternate.version),
  };
}
export function createAgentMethodStore<Tx extends AgentSqlExecutor>(ports: AgentStorePorts<Tx>) {
  return {
    list: (scope: AgentScopeV1) => ports.transaction(scope,async tx=>({version:1 as const,items:await listAgentMethods(tx,scope)})),
    get: (scope: AgentScopeV1,id: string) => ports.transaction(scope,async tx=>projectAgentMethod(await readRow(tx,scope,id))),
    propose(scope: AgentScopeV1,input: z.infer<typeof proposeAgentMethodV1Schema>) {
      return ports.transaction(scope,async tx=>{
        const run=await readRun(tx,scope,input.runId,true);
        if (run.revision!==input.expectedRunRevision) throw new AgentStoreError(409,"run_revision_conflict","这件事已经有新要求，请先核对。");
        const projection=await projectRun(tx,scope,run);
        const operations=projection.operations.filter(operation=>operation.status==="succeeded");
        // 方案 44 §6.2：能不能整理、用哪种形态写，判据在 agent-core 的纯函数里
        // （planAgentMethodProposal）——那里能脱离数据库把两种坏形态钉住：
        // 把失败运行一律拒掉，以及把临时故障/用户取消也收成规则。
        const plan=planAgentMethodProposal({
          runStatus:run.status,
          operations:projection.operations.map(operation=>({
            status:operation.status, capability:operation.capability, error:operation.error,
          })),
          succeededCapabilities:operations.map(operation=>operation.capability),
        });
        if (!plan.allowed) throw new AgentStoreError(422,"method_source_incomplete",plan.reason);
        if (plan.mode==="failure_candidate") {
          // 一次失败没有留下任何成功步骤时，只能写成**待核对的候选**：步骤仍来自
          // 真发生过的能力调用，不凭空编；失败条件进 exceptions。
          const noted=[...new Map(projection.operations.map(operation=>[operation.capability,{
            name:operation.capability,version:capabilityVersions.get(operation.capability) ?? "unavailable"}])).values()];
          const candidate = await upsertAgentMethodCandidate(tx,scope,{
            playbookKey:`agent-run:${run.id}:${run.revision}`,
            title:input.title, triggerCondition:input.appliesWhen,
            steps:noted.map(capability=>agentMethodStepFor(capability.name)),
            exceptions:[AGENT_METHOD_BASELINE_EXCEPTION, plan.failureNote ?? ""].filter(Boolean),
            evidence:[{runId:run.id,runRevision:run.revision,note:run.goal.slice(0,400)}],
            epistemicStatus:plan.epistemicStatus,
            author:"maintenance",
          });
          // 写不进去只有一种解释：这次运行的依据本身不可用（记忆已撤权/被纠正）。
          // 用户控制导致的冲突**不会**走到这里——那种情况已经并存成一份候选（§6.4）。
          if (!candidate) throw new AgentStoreError(422,"method_source_stale","这次的依据已变化，暂时不能整理成方法。");
          return projectAgentMethod(await readRow(tx,scope,candidate.playbookId));
        }
        const capabilities=[...new Map(operations.map(operation=>[operation.capability,{name:operation.capability,version:capabilityVersions.get(operation.capability) ?? "unavailable"}])).values()];
        if (!agentMethodCapabilitiesCurrent(capabilities)) throw new AgentStoreError(422,"method_capability_changed","这次用过的能力已有变化，请先核对。");
        // 步骤与例外都来自**这次真实运行**（方案 44 §2）：步骤只取真正走通的那条路径，
        // 没走通的与替代写进 exceptions。按能力目录生成的那份对每次运行都一样，
        // 等于没有从这次运行里提炼到任何东西。
        const stepPlan = planMethodStepsFromRun({
          operations: projection.operations.map(operation => ({
            capability: operation.capability, status: operation.status, error: operation.error,
          })),
          renderStep: agentMethodStepFor,
          baselineException: AGENT_METHOD_BASELINE_EXCEPTION,
        });
        if (!stepPlan.contributes) throw new AgentStoreError(422,"method_source_empty","这次没有走通任何一步，暂时不能整理成做法。");
        const [created]=await queryRows<{id:string}>(tx,sql`INSERT INTO companion_procedural_playbooks
          (playbook_key,workspace_id,user_id,title,trigger_condition,steps,exceptions,evidence,capability_refs,source_run_id,source_run_revision,author,change_reason)
          VALUES(${`agent-run:${run.id}:${run.revision}`},${scope.workspaceId},${scope.userId},${input.title},${input.appliesWhen},
          ${JSON.stringify(stepPlan.steps)}::jsonb,
          ${JSON.stringify([...stepPlan.exceptions, ...(plan.failureNote ? [plan.failureNote] : [])])}::jsonb,
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
    /**
     * 记录一次**效果评价**（方案 44 §6.3）。
     *
     * 三条口径必须一起成立，少一条就会说谎：
     *   - 评价挂的是**具体一次使用**（`useId`），不是方法的总体印象；§6.3 说效果要能
     *     追溯到当时用了哪一版、在什么上下文里用的。
     *   - 只有**读过正文**的使用才收得到评价。目录里出现过不等于读过——0386 的
     *     `CHECK (feedback IS NULL OR stage IN ('read','adopted'))` 就是这个意思，
     *     但它报出来是一条约束错误，读的人不知道自己做错了什么，所以在这里先判一次。
     *   - 评价是**效果**，不是**采用**。§6.3 把它们并列（「实际用于步骤/参数/表达，
     *    以及后续效果」），所以这里**不**顺手把 stage 提升成 `adopted`：
     *     那会把「他评价过」记成「他采用了」，正是这一节要挡的混淆。
     */
    feedback(scope: AgentScopeV1,useId: string,input: {feedback:"helpful"|"unhelpful";comment?:string}) {
      return ports.transaction(scope,async tx=>{
        const [existing]=await queryRows<{stage:string}>(tx,sql`SELECT stage FROM companion_method_uses
          WHERE id=${useId} AND workspace_id=${scope.workspaceId} AND user_id=${scope.userId} FOR UPDATE`);
        if (!existing) throw new AgentStoreError(404,"method_use_not_found","这次方法使用记录现在读不到。");
        if (existing.stage === "offered") {
          throw new AgentStoreError(422,"method_use_not_read",
            "这条做法只是出现在了做法目录里，还没有被读过正文，暂时判不了它好不好用。");
        }
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
    stage:row.stage === "offered" || row.stage === "adopted" ? row.stage : "read",
    contextKind:row.context_kind,contextId:row.context_id,contextRevision:Number(row.context_revision),feedback:row.feedback,
    comment:row.comment,createdAt:iso(row.created_at as Date|string),feedbackAt:row.feedback_at ? iso(row.feedback_at as Date|string) : null});
}
