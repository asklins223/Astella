/** Guide progress is account-scoped or bound to an authenticated workspace; real RLS and CAS. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { COMPANION_GUIDE_VERSION } from "@ailearn/shared/companion-shell-contracts";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { getCompanionOverview, transitionOnboarding } from "../modules/companion-shell/service.ts";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";

const fixture = postgres(testDatabaseUrl("DATABASE_URL"), { max: 2 });
const user = randomUUID(), other = randomUUID(), spaceA = randomUUID(), spaceB = randomUUID();
const common = { userId: user, workspaceId: spaceA, version: COMPANION_GUIDE_VERSION };
before(async () => {
  await fixture`INSERT INTO users (id, email, password_hash, role) VALUES (${user}, ${`guide-${user}@example.test`}, 'test-hash', 'owner'), (${other}, ${`guide-${other}@example.test`}, 'test-hash', 'owner')`;
  await fixture`INSERT INTO workspaces (id, name, owner_id, workspace_type) VALUES (${spaceA}, '同名书房', ${user}, 'collaborative'), (${spaceB}, '同名书房', ${user}, 'collaborative')`;
  await fixture`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${spaceA}, ${user}, 'owner'), (${spaceB}, ${user}, 'owner'), (${spaceA}, ${other}, 'member')`;
});
after(async () => {
  await fixture`DELETE FROM workspaces WHERE id IN (${spaceA}, ${spaceB})`;
  await fixture`DELETE FROM users WHERE id IN (${user}, ${other})`;
  await fixture.end(); await closeDatabase();
});
test("simultaneous devices receive one invitation permit; an equally named space has its own progress", async () => {
  const starts = await Promise.allSettled([transitionOnboarding({ ...common, scope: "space", action: "start", stepId: "space", topicId: "space" }), transitionOnboarding({ ...common, scope: "space", action: "start", stepId: "space", topicId: "space" })]);
  assert.equal(starts.filter(result => result.status === "fulfilled").length, 1);
  const a = (await getCompanionOverview(user, spaceA)).onboardingStates.find(state => state.scope === "space")!;
  assert.equal(a.workspaceId, spaceA);
  assert.equal((await getCompanionOverview(user, spaceB)).onboardingStates.length, 0);
  await transitionOnboarding({ ...common, workspaceId: spaceB, scope: "space", action: "skip" });
  assert.equal((await getCompanionOverview(user, spaceB)).onboardingStates[0].offerDisposition, "skipped");
  assert.equal((await getCompanionOverview(other, spaceA)).onboardingStates.length, 0);
  const visible = await withWorkspaceTransaction({ workspaceId: spaceA, userId: user }, tx => tx.execute(drizzleSql`SELECT scope_key FROM user_companion_onboarding`));
  assert.equal((visible as unknown as { scope_key: string }[]).some(row => row.scope_key === spaceB), false);
});
test("advance, pause and resume preserve position; old writes and cross-space tokens are rejected", async () => {
  let state = (await transitionOnboarding({ ...common, action: "start", stepId: "room", topicId: "welcome" })).state;
  const firstRevision = state.revision;
  state = (await transitionOnboarding({ ...common, action: "advance", revision: state.revision, runId: state.activeRun!.runId, stepId: "reading" })).state;
  assert.deepEqual(state.visitedStepIds, ["room"]);
  await assert.rejects(transitionOnboarding({ ...common, action: "advance", revision: firstRevision, runId: state.activeRun!.runId, stepId: "notes" }));
  state = (await transitionOnboarding({ ...common, action: "pause", revision: state.revision, runId: state.activeRun!.runId, stepId: "reading" })).state;
  const resume = { action: "resume" as const, revision: state.revision, runId: state.activeRun!.runId, resumeTokenRef: state.activeRun!.resumeTokenRef };
  await assert.rejects(transitionOnboarding({ ...common, workspaceId: spaceB, ...resume }));
  state = (await transitionOnboarding({ ...common, ...resume })).state;
  assert.equal(state.activeRun!.stepId, "reading");
  state = (await transitionOnboarding({ ...common, action: "complete", revision: state.revision, runId: state.activeRun!.runId })).state;
  assert.equal(state.offerDisposition, "completed"); assert.equal(state.activeRun, undefined);
});
test("manual replay of a skipped topic can pause and complete without rewriting the original disposition", async () => {
  const scope = { ...common, scope: "space" as const, workspaceId: spaceB };
  let state = (await transitionOnboarding({ ...scope, action: "replay", stepId: "space", topicId: "space" })).state;
  assert.equal(state.offerDisposition, "skipped");
  state = (await transitionOnboarding({ ...scope, action: "pause", revision: state.revision, runId: state.activeRun!.runId })).state;
  assert.equal(state.activeRun!.runStatus, "paused");
  state = (await transitionOnboarding({ ...scope, action: "complete", revision: state.revision, runId: state.activeRun!.runId })).state;
  assert.equal(state.offerDisposition, "skipped"); assert.equal(state.activeRun, undefined);
});
