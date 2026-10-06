import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import {
  closeDatabase,
  resolveApiIdleInTransactionTimeoutMs,
  resolveApiLockTimeoutMs,
  resolveApiStatementTimeoutMs,
  withWorkspaceTransaction,
} from "../db/client.ts";

// Fail closed if this PostgreSQL integration test is accidentally launched
// without an explicit test/isolated database URL.
testDatabaseUrl("DATABASE_URL_API");

const context = { workspaceId: randomUUID(), userId: randomUUID() };

after(async () => {
  await closeDatabase();
});

test("API pool applies measured statement, lock, and idle-transaction timeouts", async () => {
  const rows = await withWorkspaceTransaction(context, (tx) => tx.execute<{
    name: string;
    setting: string;
  }>(sql`
    SELECT name, setting FROM pg_settings
    WHERE name IN ('statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout')
  `));
  const settings = Object.fromEntries(rows.map((row) => [row.name, Number(row.setting)]));

  assert.equal(settings.statement_timeout, resolveApiStatementTimeoutMs());
  assert.equal(settings.lock_timeout, resolveApiLockTimeoutMs());
  assert.equal(settings.idle_in_transaction_session_timeout, resolveApiIdleInTransactionTimeoutMs());
  assert.equal(settings.lock_timeout, 5_000);
  assert.equal(settings.idle_in_transaction_session_timeout, 15_000);
  console.log(`API DB backstops: ${JSON.stringify(settings)}`);
});
