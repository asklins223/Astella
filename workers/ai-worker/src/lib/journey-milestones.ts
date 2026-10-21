/**
 * Journey milestone writes from the worker.
 *
 * The API owns journey reduction (`journey-service`). The worker only appends a
 * pending event, the same way it appends learning metric rows; the API drains
 * it on the next bootstrap. `(journeyId, domainEventId)` is unique, so a retried
 * job cannot advance the same milestone twice.
 *
 * Worker grants: SELECT + INSERT on `companion_journey_pending_events`
 * (`infra/postgres/roles.sql`). Nothing here writes `companion_journeys`.
 */

import { and, eq } from "drizzle-orm";
import { companionJourneyPendingEvents, companionJourneys } from "@astella/shared/db-schema/companion-journey";
import type { WorkerTransaction } from "../db.ts";

export interface JourneyMilestoneInput {
  workspaceId: string;
  userId: string;
  eventType: string;
  entityId: string;
  payload?: Record<string, unknown>;
}

/**
 * Append a milestone event for the user's active journey. Returns false when
 * there is no active journey, which is the common case: this must stay a single
 * cheap query outside onboarding.
 */
export async function recordJourneyMilestone(
  tx: WorkerTransaction,
  input: JourneyMilestoneInput,
  now: Date = new Date(),
): Promise<boolean> {
  const [journey] = await tx.select({ id: companionJourneys.id })
    .from(companionJourneys)
    .where(and(
      eq(companionJourneys.workspaceId, input.workspaceId),
      eq(companionJourneys.userId, input.userId),
      eq(companionJourneys.status, "active"),
    ))
    .limit(1);
  if (!journey) return false;
  await tx.insert(companionJourneyPendingEvents).values({
    journeyId: journey.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    domainEventId: `${input.eventType}:${input.entityId}`,
    eventType: input.eventType,
    payload: { ...(input.payload ?? {}), entityId: input.entityId } as never,
    status: "pending",
    createdAt: now,
  }).onConflictDoNothing();
  return true;
}
