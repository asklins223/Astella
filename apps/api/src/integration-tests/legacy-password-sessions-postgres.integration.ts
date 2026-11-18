/** Never run this against a shared database: the operator tool revokes all legacy sessions. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postgres from "postgres";

const connection = process.env.DATABASE_URL_LEGACY_SESSIONS_TEST;
if (!connection || !new URL(connection).pathname.startsWith("/astella_legacy_sessions_test_")) {
  throw new Error("DATABASE_URL_LEGACY_SESSIONS_TEST must point to an empty, disposable astella_legacy_sessions_test_* database");
}
const restrictedUrl = process.env.DATABASE_URL_LEGACY_SESSIONS_RESTRICTED_TEST;
if (!restrictedUrl || new URL(restrictedUrl).pathname !== new URL(connection).pathname) {
  throw new Error("DATABASE_URL_LEGACY_SESSIONS_RESTRICTED_TEST must point to the same disposable database");
}
const isolated = postgres(connection, { max: 2 });
const script = fileURLToPath(new URL("../../scripts/legacy-password-sessions.mjs", import.meta.url));
const run = (args: string[], url = connection) => spawnSync(process.execPath, [script, ...args], {
  encoding: "utf8", env: { ...process.env, DATABASE_URL_MIGRATOR: url },
});

test("legacy session operator tool defaults to inspection and selectively revokes", async () => {
  const legacyId = randomUUID();
  const modernId = randomUUID();
  try {
    await isolated`CREATE TABLE users (id uuid PRIMARY KEY, password_hash text NOT NULL)`;
    await isolated`CREATE TABLE sessions (user_id uuid REFERENCES users(id), token text)`;
    await isolated`INSERT INTO users VALUES (${legacyId}, '$2b$10$example'), (${modernId}, '$scrypt$v1$example')`;
    await isolated`INSERT INTO sessions VALUES (${legacyId}, 'legacy'), (${modernId}, 'modern')`;
    const denied = run([], restrictedUrl);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /BYPASSRLS/);
    const before = run([]);
    assert.equal(before.status, 0, before.stderr);
    assert.deepEqual(JSON.parse(before.stdout), { mode: "check", legacyAccounts: "1", sessions: "1" });
    const [stillPresent] = await isolated`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${legacyId}`;
    assert.equal(stillPresent.n, 1, "inspection must not revoke sessions");
    const revoke = run(["--revoke"]);
    assert.equal(revoke.status, 0, revoke.stderr);
    const [legacyRemaining] = await isolated`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${legacyId}`;
    const [modernRemaining] = await isolated`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${modernId}`;
    assert.equal(legacyRemaining.n, 0);
    assert.equal(modernRemaining.n, 1, "modern accounts must not be revoked");

    // Simulate a session rotation holding the same user row as the operator.
    // The deletion's snapshot must include the newly committed session.
    let started!: () => void;
    let finishRotation!: () => void;
    const locked = new Promise<void>(resolve => { started = resolve; });
    const resume = new Promise<void>(resolve => { finishRotation = resolve; });
    const rotation = isolated.begin(async tx => {
      await tx`SELECT id FROM users WHERE id = ${legacyId} FOR UPDATE`;
      started();
      await resume;
      await tx`INSERT INTO sessions VALUES (${legacyId}, 'replacement')`;
    });
    await Promise.race([locked, rotation]);
    const pending = promisify(execFile)(process.execPath, [script, "--revoke"], {
      env: { ...process.env, DATABASE_URL_MIGRATOR: connection },
      timeout: 8_000,
    });
    // Observe rejection even if the wait for the database lock itself fails.
    void pending.catch(() => {});
    try {
      const deadline = Date.now() + 3_000;
      for (;;) {
        const [row] = await isolated`SELECT exists (SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = 'astella_legacy_password_sessions'
            AND wait_event_type = 'Lock') AS blocked`;
        if (row.blocked) break;
        assert.ok(Date.now() < deadline, "the revocation must wait for the held user lock");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally {
      finishRotation();
      await rotation;
    }
    const { stdout } = await pending;
    assert.deepEqual(JSON.parse(stdout), { mode: "revoked", legacyAccounts: "1", sessions: "1" });
    const [afterRotation] = await isolated`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${legacyId}`;
    assert.equal(afterRotation.n, 0);
  } finally {
    await isolated.end({ timeout: 5 });
  }
});
