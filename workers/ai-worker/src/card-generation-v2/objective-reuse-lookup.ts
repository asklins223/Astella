/**
 * 同目标复用的**读侧**：这一篇里已有哪些目标、各自锚在哪些块上（39d W7-5 刀二）。
 *
 * 判据在 `@ailearn/shared/objective-reuse-rules-v2`（纯函数），这一份只负责把
 * 判据要的输入**按 (工作区, 笔记) 收窄后**取出来。收窄这一半不能省，也不能交给
 * 调用方自己记得写——§4.2「默认去重范围是同工作区、同笔记」，而跨笔记的相似
 * 关系**明确不抵扣**：「跨笔记仅有相似关系时仍分别记录，暂不自动抵扣复习」。
 *
 * ## 块锚从哪里来
 *
 * **当前修订的 `evidence_bindings` → `evidence_snapshots_v2.block_id`**。
 *
 * ⚠️ **不是** `learning_objective_origins_v2.evidence_snapshot_ids`。那一列在制卡
 * 激活建出来时**是空的**：`writeActivationNoteOrigin`（`origin-service.ts:229`）调
 * `createObjectiveOrigin` 时根本没传 `evidenceSnapshotIds`，落库走默认值 `[]`。
 * 于是每一颗经激活建出来的目标都没有块锚，判据每次都走 `no_block_anchor`
 * （§4.2「保留差异」那一档），**复用一次都不命中**。这是 C49（§16.38 的真库读数）
 * 量出来的——第一版读侧对着一个**生产里不存在的形状**绿了两轮。
 *
 * 依据在**修订的 `evidence_bindings`** 里，那才是"这颗目标的依据"本身。join 仍
 * 必要：候选锚的是**块**，那里存的是**证据快照**；不 join 就只能拿快照 id 去比，
 * 那等于把"同一处出处"判成"同一张快照"，而同一块切两段会封出两个快照 id。
 *
 * ## 形态从哪来
 *
 * 目标的**当前修订**的 `knowledge_form`（`learning_objective_revisions_v2`）。
 * 取当前修订而不是历史修订：§4.2 的能力维度是**今天这条目标是什么**，
 * 拿旧修订的形态去判会让"它后来改成另一种形态"的那颗被误认。
 *
 * ## 归档与被替代的不进候选
 *
 * §8.5「停用卡从复习中移除但保留历史」、§4.2「不自动合并跨笔记的同名概念」。
 * `lifecycle='active'` 是筛选条件，**不是**顺手加的——把 superseded 的那颗放进候选，
 * 等于让一次复用把新卡挂到一条已退役的目标上。
 */
import { sql } from "drizzle-orm";
import { objectiveReuseClaimHashV2, type ObjectiveReuseCandidateV2 } from "@ailearn/shared/objective-reuse-rules-v2";
import type { WorkerTransaction } from "../db.ts";

/**
 * 一篇笔记里**活着的**既有目标，连同它们在这一篇里的块锚与形态。
 *
 * `blockIds` 可能为空（老数据、或来源不是块而是图片/区域）——那不是错误，
 * 判据会把这种目标**排除在复用之外**（"把不知道当成是同一条"是最容易犯的错）。
 * 所以这里不替它编一个块 id。
 */
export async function loadReusableObjectivesForNoteV2(
  tx: WorkerTransaction,
  input: { workspaceId: string; noteId: string },
): Promise<ObjectiveReuseCandidateV2[]> {
  const rows = (await tx.execute(sql`
    SELECT lo.objective_id,
           lor.knowledge_form,
           lor.canonical_answer,
           -- 同一块切两段会封出两个快照 id，所以按**块**去重而不是按快照。
           COALESCE(
             ARRAY(
               SELECT DISTINCT es.block_id
               FROM (
                 -- evidence_bindings 这一列**两种形状都存在**：对象（键＝bindingId，
                 -- 值＝那一条 binding）与数组（激活 create_new 写的是 canonicalBindings
                 -- 数组）。两种 jsonb_* 函数都对不上的形状会**直接抛错**，所以按
                 -- jsonb_typeof 分流、只走对的那一支，别无脑都跑一遍。
                 -- 第一版只走 jsonb_array_elements、第二版只走 jsonb_each，各自被生产
                 -- 的另一种形状当场教回来一次。
                 SELECT elem ->> 'evidenceSnapshotId' AS snapshot_id
                 FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(lor.evidence_bindings) = 'array'
                             THEN lor.evidence_bindings ELSE '[]'::jsonb END) AS elem
                 UNION ALL
                 SELECT val ->> 'evidenceSnapshotId'
                 FROM jsonb_each(
                        CASE WHEN jsonb_typeof(lor.evidence_bindings) = 'object'
                             THEN lor.evidence_bindings ELSE '{}'::jsonb END) AS kv(key, val)
               ) AS binding
               JOIN public.evidence_snapshots_v2 es
                 ON es.evidence_snapshot_id = binding.snapshot_id::uuid
                AND es.workspace_id = ${input.workspaceId}
               WHERE es.block_id IS NOT NULL
                 AND es.note_id = ${input.noteId}
               ORDER BY es.block_id
             ),
             ARRAY[]::uuid[]
           ) AS block_ids
    FROM public.learning_objectives_v2 lo
    JOIN public.learning_objective_revisions_v2 lor
      ON lor.objective_id = lo.objective_id
     AND lor.workspace_id = lo.workspace_id
     -- current_objective_revision_id 是「修订的 id」（uuid），不是修订号；
     -- 拿 lor.revision（int）去比它会报 operator does not exist: integer = uuid
     -- ——第一版就是这么写的，当场被那条报错教回来。
     -- （这段注里**不许出现反引号**：它在 sql 反引号模板里，一个反引号就把模板
     --   提前关掉，症状是 esbuild 报「Expected ")" but found ...」这种与本文件
     --   毫不相干的解析错。）
     AND lor.objective_revision_id = lo.current_objective_revision_id
    WHERE lo.workspace_id = ${input.workspaceId}
      AND lo.lifecycle = 'active'
      AND EXISTS (
        SELECT 1 FROM public.learning_objective_origins_v2 loo
        WHERE loo.objective_id = lo.objective_id
          AND loo.workspace_id = ${input.workspaceId}
          AND loo.origin_kind = 'note'
          AND loo.note_id = ${input.noteId}
      )
    ORDER BY lo.objective_id
  `)) as Array<{ objective_id: string; knowledge_form: string; canonical_answer: unknown; block_ids: string[] | null }>;

  return rows.map((row) => ({
    objectiveId: String(row.objective_id),
    blockIds: (row.block_ids ?? []).map(String),
    knowledgeForm: String(row.knowledge_form),
    claimHash: objectiveReuseClaimHashV2(row.canonical_answer),
  }));
}
