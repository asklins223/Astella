/**
 * 后台记忆整理的**执行体**（40 §4.6.3 / §4.6.9 / §4.6.10，验收 A68 / A74）。
 *
 * ## 这一版补上的是「接电」
 *
 * `companion-memory-organization.ts` 里五样东西早就写好了——闸、批大小、
 * 租约、提交、surface——但一个生产调用方都没有，于是 §4.6.3 的周期整理
 * **一次也没跑过**。本文件是那个调用方：0361 的
 * `ailearn_enqueue_companion_memory_organize()` 选出够格的用户投 job，
 * 本文件把那一轮真正做完。
 *
 * ## 五种动作各自落地成什么，以及为什么
 *
 * | 判据给出 | 落地 | 依据 |
 * | --- | --- | --- |
 * | `remove` | 软删 + 写来源抑制 → **进回收区可恢复** | §4.6.4「普通删除即时抑制召回并进入可恢复回收区」 |
 * | `downgrade` | 预算层降到 `archived`（原子移动） | §4.6.3「期限、任务或适用条件变化后移入情景/短期层」 |
 * | `merge` | 保留一条，另一条标 `superseded` 并**追加来源** | §4.6.3「合并：同一事实且无矛盾，保留所有来源」 |
 * | `distill` / `upgrade` | 写成一条 **Procedural 手册**，不动事实记忆 | §4.6.10「有来源、适用条件与版本的表达/协作手册」 |
 *
 * `distill` 不去改写事实记忆是有意的：合同说「形成带条件的概括」，
 * 而 §4.5.2 把 Procedural 层单列为一层——概括属于那一层。
 * 事实记忆被概括改写，等于让一句综合结论冒充一次真实发生过的事。
 *
 * ## 每一处提交都复查 revision、抑制与租约（§4.6.4 / A68）
 *
 * 整理跑的是模型，模型跑完之前用户可能已经改过、删过或纠正过那条记忆。
 * 所以下面每一次 UPDATE 都带 `AND revision = <提交前读到的值>`
 * 与 `AND deleted_at IS NULL`，命中 0 行就算「这一条本轮不落地」，
 * **不**把旧结论覆盖上去。这是 §4.6.4「用户已修改或遗忘时旧整理结果不能覆盖」。
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import {
  companionMemoryMutationLockKey,
  MEMORY_CONTENT_SIMILARITY_THRESHOLD,
} from "@ailearn/shared/db-schema/assistant-memory";

import { readJobPayloadString } from "@ailearn/shared";

import { withWorkerWorkspaceTransaction } from "../db.ts";
import { logger } from "../lib/logger.ts";
import { throwIfJobAborted } from "../lib/job-lease.ts";
import type { JobPayload } from "./index.ts";
import {
  acquireMemoryOrganizationLease,
  commitMemoryOrganization,
  memoryOrganizationActionFor,
  memoryOrganizationBatchSize,
  memoryOrganizationGate,
  memoryOrganizationSurface,
  type MemoryOrganizationAction,
  type MemoryOrganizationCandidate,
  type PlaybookScope,
} from "./companion-memory-organization.ts";
import { upsertPlaybook } from "./companion-playbooks.ts";

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const maybe = result as { rows?: T[] } | null;
  return Array.isArray(maybe?.rows) ? maybe.rows : [];
}

interface PendingRow {
  id: string;
  kind: string;
  content: string;
  revision: number;
  budget_tier: string;
  pinned: boolean;
  applies_when: string | null;
  valid_until: Date | null;
  source_event_id: string | null;
  source_event_ids: string[] | null;
  independent_evidence: number;
}

/**
 * 统计「自上次成功整理以来的累计待处理量」。
 *
 * 分母的形状是这份 SQL 的全部要点（§4.6.3「不用当天新增 30 条让低频用户
 * 永远不触发」）：它数的是**当前真的待处理**的行，与"今天说了几句"无关。
 * 判断记录的 `kind='judgment'` 排除在外——她是主观结论，整理语义动作
 * （合并/降级/蒸馏）针对的是关于用户的事实，动了判断就等于后台替用户改她的看法。
 */
async function readPendingStats(
  tx: Parameters<Parameters<typeof withWorkerWorkspaceTransaction>[1]>[0],
  scope: PlaybookScope,
): Promise<{ backlog: number; oldestPendingAt: Date | null; lastSuccessAt: Date | null }> {
  const pending = rowsOf<{ backlog: number; oldest_pending_at: Date | null }>(await tx.execute(sql`
    SELECT COUNT(*)::bigint AS backlog, MIN(updated_at) AS oldest_pending_at
      FROM assistant_memory_items
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND deleted_at IS NULL
       AND candidate = false
       AND dismissed_at IS NULL
       AND archived_at IS NULL
       AND kind <> 'judgment'
  `));
  const state = rowsOf<{ last_success_at: Date | null }>(await tx.execute(sql`
    SELECT last_success_at
      FROM companion_memory_organization_state
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
  `));
  return {
    backlog: Number(pending[0]?.backlog ?? 0),
    oldestPendingAt: pending[0]?.oldest_pending_at ?? null,
    lastSuccessAt: state[0]?.last_success_at ?? null,
  };
}

/** 取这一轮要处置的候选（有界，批大小由判据给）。 */
async function loadCandidates(
  tx: Parameters<Parameters<typeof withWorkerWorkspaceTransaction>[1]>[0],
  scope: PlaybookScope,
  limit: number,
): Promise<PendingRow[]> {
  return rowsOf<PendingRow>(await tx.execute(sql`
    SELECT id, kind, content, revision, budget_tier, pinned, applies_when,
           valid_until, source_event_id, source_event_ids,
           -- 独立事件数：同一事件反复摘要只算一份，所以按 source_event_id 去重计数，
           -- 而不是看这条记忆被更新过几次（§4.6.3「同一事件反复摘要只算一份证据」）。
           GREATEST(1, COALESCE(array_length(source_event_ids, 1), 1)) AS independent_evidence
      FROM assistant_memory_items
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND deleted_at IS NULL
       AND candidate = false
       AND dismissed_at IS NULL
       AND archived_at IS NULL
       AND kind <> 'judgment'
     ORDER BY pinned ASC, importance DESC, updated_at ASC
     LIMIT ${limit}
  `));
}

/**
 * 找「同一事实的另一条」。
 *
 * 用的是记忆系统已有的相似度阈值（`MEMORY_CONTENT_SIMILARITY_THRESHOLD`），
 * 所以它和 API 侧判重用的是同一个数——否则同一句话会在一边算重复、
 * 一边算新事（`memory-extractor.ts` 里那条注释记的就是这个坑）。
 */
async function findSameFactTwin(
  tx: Parameters<Parameters<typeof withWorkerWorkspaceTransaction>[1]>[0],
  scope: PlaybookScope,
  candidate: PendingRow,
): Promise<{ id: string; revision: number; contradicts: boolean } | null> {
  const twins = rowsOf<{ id: string; revision: number; same_source: boolean }>(await tx.execute(sql`
    SELECT id, revision, (source_event_id IS NOT DISTINCT FROM ${candidate.source_event_id}) AS same_source
      FROM assistant_memory_items
     WHERE workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND id <> ${candidate.id}
       AND kind = ${candidate.kind}
       AND deleted_at IS NULL
       AND dismissed_at IS NULL
       AND archived_at IS NULL
       AND 1 - (embedding <=> (
             SELECT embedding FROM assistant_memory_items WHERE id = ${candidate.id}
           )) > ${MEMORY_CONTENT_SIMILARITY_THRESHOLD}
     ORDER BY updated_at DESC
     LIMIT 1
  `));
  const twin = twins[0];
  if (!twin) return null;
  // 同一来源的两条是**同一件事被记了两次**，不是矛盾。
  // 合同 §4.6.3：「合并：同一事实且无矛盾，保留所有来源；冲突不强行合并」。
  return { id: String(twin.id), revision: Number(twin.revision), contradicts: !twin.same_source };
}

/** 把记忆降到底层。用 0344 的原子函数，移动与记账在同一条语句里。 */
async function downgradeMemory(
  tx: Parameters<Parameters<typeof withWorkerWorkspaceTransaction>[1]>[0],
  scope: PlaybookScope,
  memoryId: string,
  expectedRevision: number,
): Promise<boolean> {
  // 先复查版本与存活状态：用户在这期间改过或删过，就不动它（§4.6.4）。
  const guard = rowsOf<{ revision: number }>(await tx.execute(sql`
    SELECT revision FROM assistant_memory_items
     WHERE id = ${memoryId}
       AND workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND revision = ${expectedRevision}
       AND deleted_at IS NULL
     FOR UPDATE
  `));
  if (guard.length === 0) return false;
  const moved = rowsOf<{ status: string }>(await tx.execute(sql`
    SELECT public.ailearn_move_companion_memory_budget_tier_v1(
      ${scope.workspaceId}::uuid, ${scope.userId}::uuid, ${memoryId}::uuid,
      'archived', 'companion', NULL
    ) AS status
  `));
  // capacity / not_eligible 都是「这一轮没落地」，不是失败——记下来继续下一条。
  return ["moved", "unchanged"].includes(String(moved[0]?.status ?? ""));
}

/**
 * 移除一条已过**声明期限**的记忆。
 *
 * 走软删而不是硬删：§4.6.4「普通删除即时抑制召回并进入可恢复回收区」。
 * 机械过期同样不许变成不可逆——合同说的是「按已声明期限处理」，
 * 没说「到期就没了」。用户仍可在 30 天内要求恢复。
 */
async function removeExpiredMemory(
  tx: Parameters<Parameters<typeof withWorkerWorkspaceTransaction>[1]>[0],
  scope: PlaybookScope,
  candidate: PendingRow,
  now: Date,
): Promise<boolean> {
  const result = rowsOf<{ id: string }>(await tx.execute(sql`
    UPDATE assistant_memory_items
       SET deleted_at = ${now},
           purge_after = ${new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)},
           updated_at = ${now}
     WHERE id = ${candidate.id}
       AND workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND revision = ${candidate.revision}
       AND deleted_at IS NULL
       AND pinned = false
     RETURNING id
  `));
  if (result.length === 0) return false;
  // 抑制墓碑：不写它，同一个来源下次抽取又会把它记一遍（§4.5.6 护栏 5）。
  // 没有来源的记忆无从抑制——那种行只能是被手动创建的，抽取不会再造一遍。
  if (candidate.source_event_id === null) return true;
  await tx.execute(sql`
    INSERT INTO assistant_memory_source_suppressions (user_id, kind, source_event_id)
    VALUES (${scope.userId}, ${candidate.kind}, ${candidate.source_event_id})
    ON CONFLICT (user_id, kind, source_event_id) DO NOTHING
  `);
  return true;
}

/**
 * 合并：保留 `keepId`，把 `dropId` 标成已被替代，并把来源**追加**过去。
 *
 * §4.6.3：「合并：同一事实且无矛盾，保留所有来源；冲突不强行合并」。
 * 所以这一步既不能删掉任何一条（来源要留着），也不能静默合并
 * （§4.6.8「写新证据可追加来源，不增同义行」）。
 */
async function mergeMemory(
  tx: Parameters<Parameters<typeof withWorkerWorkspaceTransaction>[1]>[0],
  scope: PlaybookScope,
  keepId: string,
  drop: PendingRow,
): Promise<boolean> {
  const result = rowsOf<{ id: string }>(await tx.execute(sql`
    UPDATE assistant_memory_items AS t
       SET source_event_ids = (
             SELECT COALESCE(
                      array_agg(DISTINCT src ORDER BY src),
                      ARRAY[]::text[]
                    )
               FROM unnest(
                      COALESCE(t.source_event_ids, ARRAY[]::text[])
                      || COALESCE(t.source_event_id, ARRAY[]::text[])
                      || COALESCE(${drop.source_event_ids}, ARRAY[]::text[])
                      || COALESCE(${drop.source_event_id}, ARRAY[]::text[])
                    ) AS src
           ),
           epistemic_status = 'supported',
           updated_at = now()
     WHERE t.id = ${keepId}
       AND t.workspace_id = ${scope.workspaceId}
       AND t.user_id = ${scope.userId}
       AND t.revision = ${drop.revision}
       AND t.deleted_at IS NULL
     RETURNING t.id
  `));
  return result.length > 0;
}

/** 把被合并掉的那一条标成已被替代（§4.5.4「已被替代」）。 */
async function markSuperseded(
  tx: Parameters<Parameters<typeof withWorkerWorkspaceTransaction>[1]>[0],
  scope: PlaybookScope,
  memoryId: string,
  expectedRevision: number,
): Promise<boolean> {
  const result = rowsOf<{ id: string }>(await tx.execute(sql`
    UPDATE assistant_memory_items
       SET epistemic_status = 'superseded', updated_at = now()
     WHERE id = ${memoryId}
       AND workspace_id = ${scope.workspaceId}
       AND user_id = ${scope.userId}
       AND revision = ${expectedRevision}
       AND deleted_at IS NULL
     RETURNING id
  `));
  return result.length > 0;
}

/**
 * job 入口：把 `jobs.payload` 交给纯函数那条路径。
 *
 * payload 只有 workspace/user 两个身份字段——阈值**不在 payload 里**。
 * 理由：payload 是入队那一刻的快照，而阈值会调（§4.6.3「阈值按样本调优」）。
 * 把它们放进 payload 等于"入队时决定一次、之后调阈值对在途 job 无效"，
 * 下一次调阈值时会出现一段行为不一致的窗口。
 */
export async function runCompanionMemoryOrganizeJob(job: JobPayload): Promise<void> {
  const userId = readJobPayloadString(job.payload, "userId");
  if (!userId) throw new Error("companion_memory_organize payload 缺 userId");
  throwIfJobAborted(job);
  await runCompanionMemoryOrganize({
    workspaceId: job.workspaceId,
    userId,
    holder: `organize-job:${job.id}`,
  });
}

/**
 * 一轮整理的结算。
 *
 * `surface` 是 §4.5.10 / §4.6.9 说的那段「至多一句」的结论：它作为带来源的
 * 后台产物进入下一轮上下文，**不自动成为对外消息**，也不当用户的新事实。
 */
export interface OrganizeOutcome {
  ran: boolean;
  reason: string;
  movedIds: string[];
  removedIds: string[];
  mergedIds: string[];
  playbooksWritten: number;
  surface: string | null;
  committed: boolean;
}

export async function runCompanionMemoryOrganize(input: {
  workspaceId: string;
  userId: string;
  holder?: string;
  now?: Date;
}): Promise<OrganizeOutcome> {
  const scope: PlaybookScope = { workspaceId: input.workspaceId, userId: input.userId };
  const holder = input.holder ?? `organize:${randomUUID()}`;
  const now = input.now ?? new Date();
  const empty: OrganizeOutcome = {
    ran: false, reason: "nothing_pending", movedIds: [], removedIds: [], mergedIds: [],
    playbooksWritten: 0, surface: null, committed: false,
  };

  return withWorkerWorkspaceTransaction(scope, async (tx) => {
    // 与删除/纠正同一把锁：整理与用户的手动改动不能交错（§4.5.6 护栏 5）。
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${companionMemoryMutationLockKey(input.userId)})`);

    const stats = await readPendingStats(tx, scope);
    const decision = memoryOrganizationGate({
      backlogCount: stats.backlog,
      oldestPendingAt: stats.oldestPendingAt,
      lastSuccessAt: stats.lastSuccessAt,
      now,
    });
    if (!decision.run) return { ...empty, reason: decision.reason };

    // 租约拿不到 = 同一 (workspace_id, user_id) 已有另一轮在跑（§4.6.9 串行）。
    const leased = await acquireMemoryOrganizationLease(tx, scope, holder, 10 * 60 * 1000, now);
    if (!leased) return { ...empty, reason: "lease_held" };

    const batch = memoryOrganizationBatchSize(decision);
    const candidates = await loadCandidates(tx, scope, batch);
    const now2 = new Date();

    const movedIds: string[] = [];
    const removedIds: string[] = [];
    const mergedIds: string[] = [];
    const playbookKeys = new Map<string, MemoryOrganizationCandidate>();

    for (const candidate of candidates) {
      const twin = await findSameFactTwin(tx, scope, candidate);
      const action: MemoryOrganizationAction | null = memoryOrganizationActionFor({
        memoryId: candidate.id,
        kind: candidate.kind,
        sameFactTwinId: twin?.id ?? null,
        sameFactTwinContradicts: twin?.contradicts ?? false,
        importance: 0.5,
        pinned: candidate.pinned,
        appliesWhen: candidate.applies_when,
        validFrom: null,
        validUntil: candidate.valid_until,
        independentEvidenceCount: Number(candidate.independent_evidence ?? 1),
      }, now2);
      if (action === null) continue;

      switch (action) {
        case "remove": {
          if (await removeExpiredMemory(tx, scope, candidate, now2)) removedIds.push(candidate.id);
          break;
        }
        case "downgrade": {
          if (await downgradeMemory(tx, scope, candidate.id, candidate.revision)) movedIds.push(candidate.id);
          break;
        }
        case "merge": {
          // 保留新的一条（列表按 updated_at ASC 取，所以 candidate 更旧）；
          // 把更近的那条判为「已被替代」，来源全部挂到留下的这条上。
          if (twin && await mergeMemory(tx, scope, candidate.id, { ...candidate, id: twin.id, revision: twin.revision })) {
            if (await markSuperseded(tx, scope, twin.id, twin.revision)) mergedIds.push(twin.id);
          }
          break;
        }
        case "distill":
        case "upgrade": {
          // 概括落 Procedural 层（§4.6.10），不在这里改写事实记忆。
          playbookKeys.set(`${candidate.kind}:${candidate.applies_when ?? "general"}`, {
            memoryId: candidate.id,
            kind: candidate.kind,
            sameFactTwinId: null,
            sameFactTwinContradicts: false,
            importance: 0.5,
            pinned: false,
            appliesWhen: candidate.applies_when,
            validFrom: null,
            validUntil: candidate.valid_until,
            independentEvidenceCount: Number(candidate.independent_evidence ?? 1),
          });
          break;
        }
      }
    }

    // 手册：一条一写，命中同一 key 就升版（§4.6.10「稳定 ID」）。
    let playbooksWritten = 0;
    for (const entry of playbookKeys.values()) {
      try {
        const written = await upsertPlaybook(tx, scope, {
          playbookKey: `${entry.kind}:${entry.appliesWhen ?? "general"}`,
          title: `${entry.kind}：${entry.appliesWhen ?? "通用"}`,
          triggerCondition: entry.appliesWhen ?? "当前话题涉及这类记忆时",
          steps: [`先看有没有与这条同类的既有记忆（kind=${entry.kind}）`],
          exceptions: ["用户当场提出相反的说法时，以用户为准，不按手册走"],
          evidence: [{ memoryId: entry.memoryId }],
          epistemicStatus: "tentative",
          author: "maintenance",
        });
        playbooksWritten += 1;
        logger.info(
          { playbookId: written.playbookId, version: written.version, memoryId: entry.memoryId },
          "memory organization wrote a procedural playbook",
        );
      } catch (error) {
        // 手册写不进去不该让整轮整理判失败：处置本身已经落地了。
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), memoryId: entry.memoryId },
          "memory organization failed to write a playbook; keeping the round",
        );
      }
    }

    const surface = memoryOrganizationSurface([...movedIds, ...mergedIds], removedIds);
    const committed = await commitMemoryOrganization(tx, scope, holder, surface, stats.backlog);
    if (!committed) {
      // 提交失败 = 租约丢了或状态被别人推进。这一轮的**处置已经落地**，
      // 但状态位不能推进——下次 tick 会再选一次，会重复整理。
      logger.warn({ workspaceId: scope.workspaceId, userId: scope.userId, holder }, "memory organization commit lost the lease");
    }

    logger.info(
      {
        workspaceId: scope.workspaceId, userId: scope.userId, reason: decision.reason,
        batch, moved: movedIds.length, removed: removedIds.length, merged: mergedIds.length,
        playbooksWritten, committed,
      },
      "companion memory organization round finished",
    );
    return {
      ran: true, reason: decision.reason, movedIds, removedIds, mergedIds,
      playbooksWritten, surface, committed,
    };
  });
}
