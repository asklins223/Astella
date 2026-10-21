/**
 * Worker-side journey milestone writes against real PostgreSQL.
 *
 * The worker may only append pending events (SELECT + INSERT); the API reduces
 * them. These cases cover the three properties the handler relies on: no active
 * journey is a no-op, a repeated milestone stays one row, and an app-owned
 * attempt completion produces exactly one `note_learning_card.completed` event.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
const { withWorkerWorkspaceTransaction, closeDatabase } = await import("../db.ts");
const { recordJourneyMilestone } = await import("../lib/journey-milestones.ts");

after(async () => { await admin.end({ timeout: 2 }); await closeDatabase(); });

async function fixture(withJourney: boolean) {
  const scope = { userId: randomUUID(), workspaceId: randomUUID() };
  await admin.begin(async tx => {
    await tx`INSERT INTO users(id,email,password_hash) VALUES(${scope.userId},${`journey-milestone-${scope.userId}@test.invalid`},'fixture')`;
    await tx`INSERT INTO workspaces(id,owner_id,name) VALUES(${scope.workspaceId},${scope.userId},'Journey milestone fixture')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${scope.workspaceId},${scope.userId},'owner')`;
    if (withJourney) {
      await tx`INSERT INTO companion_journeys(workspace_id,user_id,status,branch,current_step,refs)
        VALUES(${scope.workspaceId},${scope.userId},'active','own_material','first_note',${tx.json({})})`;
    }
  });
  const events = () => admin`SELECT event_type, domain_event_id, payload, status FROM companion_journey_pending_events
    WHERE workspace_id=${scope.workspaceId} ORDER BY created_at`;
  const cleanup = () => admin.begin(async tx => {
    await tx`DELETE FROM companion_journey_pending_events WHERE workspace_id=${scope.workspaceId}`;
    await tx`DELETE FROM companion_journeys WHERE workspace_id=${scope.workspaceId}`;
    await tx`DELETE FROM workspaces WHERE id=${scope.workspaceId}`;
    await tx`DELETE FROM users WHERE id=${scope.userId}`;
  });
  return { ...scope, events, cleanup };
}

test("no active journey: the milestone write is a no-op and touches no rows", async () => {
  const seeded = await fixture(false);
  try {
    const recorded = await withWorkerWorkspaceTransaction(seeded, (tx) =>
      recordJourneyMilestone(tx, { ...seeded, eventType: "card.created", entityId: "card-1" }));
    assert.equal(recorded, false);
    assert.equal((await seeded.events()).length, 0);
  } finally { await seeded.cleanup(); }
});

test("an active journey records the milestone once, even when the job retries", async () => {
  const seeded = await fixture(true);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await withWorkerWorkspaceTransaction(seeded, (tx) =>
        recordJourneyMilestone(tx, { ...seeded, eventType: "card.created", entityId: "card-1" }));
    }
    const rows = await seeded.events();
    assert.equal(rows.length, 1, "unique (journey, domainEventId) collapses retries");
    assert.equal(rows[0].event_type, "card.created");
    assert.equal(rows[0].domain_event_id, "card.created:card-1");
    assert.equal(rows[0].payload.entityId, "card-1");
    assert.equal(rows[0].status, "pending", "the API drains it, not the worker");
  } finally { await seeded.cleanup(); }
});

test("a finished card attempt carries the card id so the journey can reference it", async () => {
  const seeded = await fixture(true);
  try {
    await withWorkerWorkspaceTransaction(seeded, (tx) =>
      recordJourneyMilestone(tx, { ...seeded, eventType: "note_learning_card.completed", entityId: "attempt-1", payload: { cardId: "card-9" } }));
    const [row] = await seeded.events();
    assert.equal(row.event_type, "note_learning_card.completed");
    assert.equal(row.payload.cardId, "card-9");
    assert.equal(row.payload.entityId, "attempt-1");
  } finally { await seeded.cleanup(); }
});
