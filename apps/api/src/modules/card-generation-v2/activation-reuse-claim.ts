import { and, eq } from "drizzle-orm";
import { objectiveReuseClaimHashV2 } from "@astella/shared/objective-reuse-rules-v2";
import { learningObjectivesV2, learningObjectiveRevisionsV2 } from "@astella/shared/db-schema/card-generation-v2";
import type { ApiTransaction } from "../../db/client.ts";
import { visibleObjectivesCondition } from "../note/visibility.ts";

type Claim = { readonly knowledgeForm: string; readonly canonicalAnswer: unknown };

export function sameActivationReuseClaimV2(candidate: Claim, existing: Claim): boolean {
  const hash = objectiveReuseClaimHashV2(candidate.canonicalAnswer);
  return Boolean(hash && candidate.knowledgeForm === existing.knowledgeForm
    && objectiveReuseClaimHashV2(existing.canonicalAnswer) === hash);
}

/** Old plans can nominate a target, but only its current, visible claim permits reuse. */
export async function canAutomaticallyReuseObjectiveV2(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  objectiveId: string,
  candidate: Claim,
): Promise<boolean> {
  const [target] = await tx.select({
    knowledgeForm: learningObjectiveRevisionsV2.knowledgeForm,
    canonicalAnswer: learningObjectiveRevisionsV2.canonicalAnswer,
  }).from(learningObjectivesV2).innerJoin(learningObjectiveRevisionsV2, and(
    eq(learningObjectiveRevisionsV2.objectiveRevisionId, learningObjectivesV2.currentObjectiveRevisionId),
    eq(learningObjectiveRevisionsV2.workspaceId, scope.workspaceId),
  )).where(and(
    eq(learningObjectivesV2.objectiveId, objectiveId),
    eq(learningObjectivesV2.workspaceId, scope.workspaceId),
    eq(learningObjectivesV2.lifecycle, "active"),
    visibleObjectivesCondition(scope.userId, learningObjectivesV2.objectiveId),
  )).limit(1);
  return Boolean(target && sameActivationReuseClaimV2(candidate, target));
}
