import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { getCompanionOverview, updateCompanionAccountState } from "../modules/companion-shell/service.ts";
import { closeDatabase } from "../db/client.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
const userId = randomUUID(), otherUser = randomUUID(), spaceA = randomUUID(), spaceB = randomUUID();
await admin`INSERT INTO users (id,email,password_hash) VALUES
  (${userId},${`search-settings-${userId}@example.test`},'fixture'),
  (${otherUser},${`search-settings-${otherUser}@example.test`},'fixture')`;
after(async () => {
  try { await admin`DELETE FROM users WHERE id IN (${userId},${otherUser})`; }
  finally { await admin.end(); await closeDatabase(); }
});

test("search defaults off, saves on first write, follows the account, and preserves independent settings", async () => {
  const fresh = await getCompanionOverview(userId, spaceA);
  assert.notEqual(fresh.account.agentSettings?.webSearchEnabled, true);
  const enabled = await updateCompanionAccountState(userId, spaceA, { revision: 0, webSearchEnabled: true });
  assert.equal(enabled.agentSettings?.webSearchEnabled, true);
  const elsewhere = await getCompanionOverview(userId, spaceB);
  assert.equal(elsewhere.account.agentSettings?.webSearchEnabled, true);
  assert.notEqual((await getCompanionOverview(otherUser, spaceA)).account.agentSettings?.webSearchEnabled, true);
  const permission = await updateCompanionAccountState(userId, spaceB, { revision: enabled.revision, agentPermissionLevel: "read_only" });
  assert.equal(permission.agentSettings?.webSearchEnabled, true);
  const disabled = await updateCompanionAccountState(userId, spaceA, { revision: permission.revision, webSearchEnabled: false });
  assert.equal(disabled.agentSettings?.permissionLevel, "read_only");
  assert.equal(disabled.agentSettings?.webSearchEnabled, false);
  assert.equal(disabled.epoch, 0);
  await assert.rejects(updateCompanionAccountState(userId, spaceB, { revision: enabled.revision, webSearchEnabled: true }), /revision/);
});
