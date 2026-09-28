/**
 * 首页「只推一件」里**未完轮次那一档**的读数（39d W7-4 刀十六／刀七；39 §12.1）。
 *
 * ## 这一格量的两件事
 *
 *  1. **正例**：一颗**可继续**的未完轮次 ⇒ 首页那一件**就是它**，题面来自
 *     `origin.objectiveId` → 目标 → 当前修订 → `objective_statement`。
 *  2. **反例（这一格的关键）**：**`paused` 的轮次不算「她还想继续」**。
 *
 * ## 为什么反例比正例重要
 *
 * §9.1 把「**她按了暂不安排**」与「**她还想回去做完**」列成**两件不同的事**，而首页那个
 * `resume` 入口在 `run-action-availability` 的 `paused` 分支里给的是 `resume` ＋ `end`——
 * **她按了暂停，是「先别回来」，不是「还没回来」**。把 `paused` 混进这一档，
 * 首页就会**反复催一件她说過先别做的事**——**这是这一档最容易写错的地方**。
 *
 * ## 三处「别照抄夹具」
 *
 * ① **`origin.kind` 的真实取值是 `note_round` / `today`**（两种都带 `objectiveId`）；
 *    `run-planner.test.ts` / `run-action-availability.test.ts` 里的夹具写的是
 *    `{kind:"card", cardId:…}` ⇒ **照夹具写会写错一整类**。
 * ② **`goal` 是枚举码**（`stabilize|clarify|repair|transfer|explore`）**不是名字**。
 * ③ **可见性一律走 `visibleObjectivesCondition`**（「目标 → 卡 → 笔记」那一条链）——
 *    因为 `today` 那一档**根本没有 `noteId`**。
 *
 * ## ⚠️ **夹具一律用 drizzle 写**（`tx.insert(表).values({…})`）——**别手写 INSERT 列**
 *
 * 手写那一版连报三次「`INSERT has more target columns than expressions`」：漏了 `id` 与
 * `created_at`，而且**真实列序与猜的不同**（`public_summary` 在 `knowledge_form` **之前**）。
 * **让 schema 自己决定列。**
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { withWorkspaceTransaction } from "../db/client.ts";
import { users, workspaces, workspaceMembers } from "@ailearn/shared/db-schema/identity";
import { learningRuns } from "@ailearn/shared/db-schema/learning-runs";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { readHomeSuggestionV2 } from "../modules/learning-dashboard/home-suggestion-service.ts";

const TZ = "Asia/Shanghai";
const ZERO = "0".repeat(64);

async function seedRunV2(input: {
  workspaceId: string;
  userId: string;
  statement: string;
  phase: string;
}): Promise<{ objectiveId: string }> {
  const objectiveId = randomUUID();
  const revisionId = randomUUID();
  const origin = { kind: "today", objectiveId };
  await withWorkspaceTransaction(
    { workspaceId: input.workspaceId, userId: input.userId },
    async (tx) => {
      await tx.insert(learningObjectivesV2).values({
        id: randomUUID(),
        objectiveId,
        workspaceId: input.workspaceId,
        currentObjectiveRevisionId: revisionId,
        lifecycle: "active",
        semanticIdentityClassId: `c:${randomUUID()}`,
        semanticIdentityPolicyVersion: "sem-id-v1",
        semanticTargetFingerprint: "f".repeat(64),
      });
      await tx.insert(learningObjectiveRevisionsV2).values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        objectiveRevisionId: revisionId,
        objectiveId,
        revision: 1,
        objectiveStatement: input.statement,
        publicSummary: "摘要",
        knowledgeForm: "fact",
        preferredIntents: [],
        canonicalAnswer: [],
        learningSupport: [],
        scoringRubric: [],
        relations: [],
        evidenceBindings: {},
        semanticTargetFingerprint: "f".repeat(64),
        targetRevisionHash: ZERO,
        privatePayloadHash: ZERO,
        hints: [],
      });
      await tx.insert(learningRuns).values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        userId: input.userId,
        origin,
        returnTarget: origin,
        targetFingerprint: "f".repeat(64),
        goal: "clarify",
        phase: input.phase as never,
      });
    },
  );
  return { objectiveId };
}

function scopeV2(): { workspaceId: string; userId: string } {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  return { workspaceId, userId };
}

async function withSeededScopeV2(): Promise<{
  workspaceId: string;
  userId: string;
  run: (phase: string, statement: string) => Promise<unknown>;
  read: () => Promise<Awaited<ReturnType<typeof readHomeSuggestionV2>>>;
}> {
  const { workspaceId, userId } = scopeV2();
  await withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email: `k16-${userId}@example.invalid`,
      passwordHash: "unused",
    });
    await tx.insert(workspaces).values({ id: workspaceId, ownerId: userId, name: "K16" });
    await tx.insert(workspaceMembers).values({ workspaceId, userId, role: "owner" });
  });
  return {
    workspaceId,
    userId,
    run: (phase, statement) => seedRunV2({ workspaceId, userId, statement, phase }),
    read: () =>
      withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
        readHomeSuggestionV2(tx, { workspaceId, userId, timeZone: TZ }),
      ),
  };
}

void testDatabaseUrl("DATABASE_URL_MIGRATOR");

test("W7-4 刀十六：可继续的未完轮次会出现在首页那「一件」上，题面来自它那颗目标", async () => {
  const scope = await withSeededScopeV2();
  await scope.run("checkpoint", "她当时在做的那件事");
  const wire = await scope.read();
  assert.equal(wire.kind, "suggested", `正例该是 suggested，实际 ${JSON.stringify(wire)}`);
  assert.equal(wire.kindOfItem, "unfinished_run");
  // §12.1「推荐附一句理由」——**必填且非空**（空的那一条在判据里会被拒，宁可空态）
  assert.ok(wire.reasonLine && wire.reasonLine.length > 0, "理由不能为空");
  assert.equal(wire.headline, "她当时在做的那件事",
    "题面必须取自那颗目标的 `objective_statement`，不是轮次 id 也不是空的");
});

test("W7-4 刀十六·反例：`paused` 的轮次**不**进那一档（她按了暂停＝先别回来）", async () => {
  const scope = await withSeededScopeV2();
  await scope.run("paused", "她按了暂停的那件事");
  const wire = await scope.read();
  // §9.1：「她按了暂不安排」与「她还想回去做完」是**两件不同的**事。
  // 把 `paused` 混进来，首页就会反复催一件她说過先别做的事。
  assert.equal(wire.kind, "nothing_due",
    `paused 不该出现在首页那一件上，实际 ${JSON.stringify(wire)}`);
});
