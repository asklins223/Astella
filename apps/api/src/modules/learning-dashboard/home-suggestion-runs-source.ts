/**
 * 首页「只推一件」里**未完轮次那一档**的读侧（39d W7-4 刀十六／刀七；§12.1）。
 *
 * ## 这一层只做一件事
 *
 * 把「她还可以回去做完的那几个轮次」读出来，组装成 `HomeRunCandidateInputV2` 喂给
 * `collectCandidatesV2`。**排序与取舍不在这里**——那是 `decideHomeSuggestionV2` 的事
 * （§12.1「排序是**档位**不是时间」）。
 *
 * ## 三处「别照抄夹具」（这一层是我照着真读数写的，不是照着 `*.test.ts` 写的）
 *
 * ① **`origin.kind` 的真实取值是 `note_round` / `today`**，**两种都带 `objectiveId`**。
 *    ⚠️ `run-planner.test.ts` / `run-action-availability.test.ts` 里的夹具写的是
 *    `{ kind: "card", cardId: … }` ——**照夹具写会写错一整类**。题面走
 *    `origin ->> 'objectiveId'` ⇒ 目标 ⇒ 它的当前修订 ⇒ `objective_statement`。
 * ② **`paused` 不在这一档里。** §9.1 把「她按了暂不安排」和「她还想继续」列成**两件**
 *    不同的���；`resume` 那一档的可见内容在别处（`run-action-availability` 的 `paused`
 *    分支给的是 `resume` ＋ `end`）。**把它混进来＝把「她按了暂停」读成「她还想继续」**。
 * ③ **可见性一律走 `visibleObjectivesCondition`**，**不按 `origin.noteId` 一刀切**。
 *    ⚠️ `today` 那一档**根本没有 `noteId`**（真读数：只有 `kind` 与 `objectiveId`）。
 *    而 `visibleObjectivesCondition` 走的正是「目标 → 卡 → 笔记」那一条链
 *    （`modules/note/visibility.ts` 的头注就是这么写的），**两档统一**。
 */
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { learningRuns } from "@ailearn/shared/db-schema/learning-runs";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { visibleObjectivesCondition } from "../note/visibility.ts";
import type { HomeRunCandidateInputV2 } from "./home-suggestion-service.ts";

/**
 * 「还可以回去做完」的阶段集。
 *
 * **还在跑**：`preparing` / `active` / `assessing` / `committing`；
 * **停着但能继续**：`checkpoint`（`finish_current_evidence` / `activate_followup`）与
 * `recoverable_error`（`retry_prepare` / `retry_assessment`）——**依据是
 * `run-action-availability.ts` 的分支**，**不是**我在这里重写一遍语义。
 *
 * **故意不含 `paused`**：见头注 ②。
 */
const CONTINUABLE_PHASES = [
  "preparing",
  "active",
  "assessing",
  "committing",
  "checkpoint",
  "recoverable_error",
] as const;

/** §12.1「推荐附一句理由」——**必填且非空**（空的那一条在判据里会被拒，宁可空态）。 */
function reasonLineFor(phase: string): string {
  return phase === "recoverable_error"
    ? "上一次没做完，接着试一次就行。"
    : "上次停在这儿，接着做完就好。";
}

export async function readUnfinishedRunCandidatesV2(
  tx: ApiTransaction,
  ctx: { workspaceId: string; userId: string },
): Promise<HomeRunCandidateInputV2[]> {
  const rows = await tx
    .select({
      runId: learningRuns.id,
      phase: learningRuns.phase,
      updatedAt: learningRuns.updatedAt,
      // ⚠️ `->>` 交的是 **text**，而目标那几列是 **uuid** ⇒ 不显式转型，PG 就报
      // `operator does not exist: uuid = text`（真库读数抓到的，不是猜的）。
      objectiveId: sql<string>`((${learningRuns.origin} ->> 'objectiveId')::uuid)`,
      statement: learningObjectiveRevisionsV2.objectiveStatement,
    })
    .from(learningRuns)
    // 题面在**目标的当前修订**上，而目标只记着「当前是哪一版」（`current_…revision_id`）
    .innerJoin(
      learningObjectivesV2,
      eq(
        learningObjectivesV2.objectiveId,
        sql<string>`((${learningRuns.origin} ->> 'objectiveId')::uuid)`,
      ),
    )
    .innerJoin(
      learningObjectiveRevisionsV2,
      eq(
        learningObjectiveRevisionsV2.objectiveRevisionId,
        learningObjectivesV2.currentObjectiveRevisionId,
      ),
    )
    .where(
      and(
        eq(learningRuns.workspaceId, ctx.workspaceId),
        eq(learningRuns.userId, ctx.userId),
        inArray(learningRuns.phase, [...CONTINUABLE_PHASES]),
        // 目标得还活着：已归档／被替代的轮次不该在首页上被点名
        eq(learningObjectivesV2.lifecycle, "active"),
        isNotNull(learningObjectivesV2.currentObjectiveRevisionId),
        // **可见性判据**（见头注 ③）：「目标 → 卡 → 笔记」那一条链
        visibleObjectivesCondition(ctx.userId, learningObjectivesV2.objectiveId),
      ),
    )
    .orderBy(desc(learningRuns.updatedAt))
    .limit(20);

  return rows.map((row) => ({
    kind: "unfinished_run" as const,
    itemKey: `run:${row.runId}`,
    // 题面是**她当时在做的那件事**，与 `authorized_review` 那一档同一套形状
    headline: row.statement,
    reasonLine: reasonLineFor(row.phase),
    updatedAt: row.updatedAt,
  }));
}
