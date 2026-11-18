/** End-to-end operator check against an explicitly named disposable database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const connection = process.env.DATABASE_URL_FK_TEST;
if (!connection || !new URL(connection).pathname.startsWith("/astella_workspace_fk_test_")) {
  throw new Error("DATABASE_URL_FK_TEST must point to a disposable astella_workspace_fk_test_* database");
}
const db = postgres(connection, { max: 1 });
const script = fileURLToPath(new URL("../../scripts/workspace-fk-validation.mjs", import.meta.url));
const migration = readFileSync(new URL("../db/migrations/0472_workspace_foreign_keys_and_admin_counts.sql", import.meta.url), "utf8");
const tables = [
  "companion_reflections", "companion_reflection_sources", "companion_reflection_checkpoints",
  "companion_release_router_samples", "note_mind_map_stages",
];

test("workspace FK operator check detects historical orphans, preserves data and validates atomically", async () => {
  const restrictedRole = `fkcheck_${randomUUID().replaceAll("-", "")}`;
  const restrictedPassword = randomUUID().replaceAll("-", "");
  let roleCreated = false;
  const partialRole = `fkpartial_${randomUUID().replaceAll("-", "")}`;
  const partialPassword = randomUUID().replaceAll("-", "");
  let partialRoleCreated = false;
  const run = (args: string[] = [], url = connection) => spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL_MIGRATOR: url },
  });
  try {
    await db`CREATE TABLE public.workspaces (id text PRIMARY KEY)`;
    await db`CREATE TABLE public.users (id text PRIMARY KEY)`;
    await db`CREATE TABLE public.notes (deleted_at timestamptz)`;
    await db`CREATE TABLE public.jobs (id text PRIMARY KEY)`;
    await db`CREATE TABLE public.sessions (expires_at timestamptz NOT NULL)`;
    for (const table of tables) {
      await db.unsafe(`CREATE TABLE public."${table}" (workspace_id text NOT NULL)`);
    }
    await db`INSERT INTO public.companion_reflections VALUES ('missing-parent')`;
    await db`INSERT INTO public.companion_reflection_sources VALUES ('missing-parent')`;
    await db.begin(async tx => {
      for (const statement of migration.split("--> statement-breakpoint")) await tx.unsafe(statement);
    });
    await assert.rejects(db`INSERT INTO public.companion_reflections VALUES ('another-missing-parent')`, { code: "23503" });
    const [counts] = await db`SELECT * FROM public.astella_admin_platform_counts()`;
    assert.equal(counts.runs_total, 0, "admin counts works after learning_runs was dropped");

    const check = run();
    assert.equal(check.status, 1, check.stderr);
    const state = JSON.parse(check.stdout) as { constraints: Array<{ table: string; validated: boolean; orphanCount: string }> };
    assert.deepEqual(state.constraints.filter(row => !row.validated).map(row => [row.table, row.orphanCount]), [
      ["companion_reflections", "1"],
      ["companion_reflection_sources", "1"],
    ]);
    const blocked = run(["--validate"]);
    assert.equal(blocked.status, 1);
    const constraints = await db`
      SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE '%_workspace_fk' ORDER BY conname`;
    assert.equal(constraints.length, 5);
    assert.equal(constraints.filter(row => row.convalidated).length, 3);
    const [{ n }] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM public.companion_reflections`;
    assert.equal(n, 1, "diagnosis and validation must not delete orphan rows");

    // Recovery is an explicit data-owner decision, modeled here as restoring the parent.
    await db`INSERT INTO public.workspaces VALUES ('missing-parent')`;
    const [{ owner }] = await db<{ owner: string }[]>`SELECT current_user AS owner`;
    await db.unsafe(`CREATE ROLE "${partialRole}" LOGIN BYPASSRLS PASSWORD '${partialPassword}'`);
    partialRoleCreated = true;
    await db.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO "${partialRole}"`);
    await db.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${partialRole}"`);
    await db.unsafe(`ALTER TABLE public.companion_reflections OWNER TO "${partialRole}"`);
    const partial = new URL(connection);
    partial.username = partialRole;
    partial.password = partialPassword;
    assert.equal(run(["--validate"], partial.toString()).status, 1, "incomplete DDL permissions must fail");
    const afterFailedValidation = await db`
      SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE '%_workspace_fk' ORDER BY conname`;
    assert.deepEqual(afterFailedValidation, constraints, "a late DDL error must roll back all validations");
    await db.unsafe(`ALTER TABLE public.companion_reflections OWNER TO "${owner.replaceAll('"', '""')}"`);
    await db.unsafe(`DROP OWNED BY "${partialRole}"`);
    await db.unsafe(`DROP ROLE "${partialRole}"`);
    partialRoleCreated = false;
    const validate = run(["--validate"]);
    assert.equal(validate.status, 0, validate.stderr);
    const finished = JSON.parse(validate.stdout) as { constraints: Array<{ validated: boolean; orphanCount: string }> };
    assert.ok(finished.constraints.every(row => row.validated && row.orphanCount === "0"));
    assert.equal(run().status, 0, "a subsequent read-only check should pass");

    await db.unsafe(`CREATE ROLE "${restrictedRole}" LOGIN NOBYPASSRLS PASSWORD '${restrictedPassword}'`);
    roleCreated = true;
    const restricted = new URL(connection);
    restricted.username = restrictedRole;
    restricted.password = restrictedPassword;
    const denied = run([], restricted.toString());
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /BYPASSRLS/);
    await db`ALTER TABLE public.note_mind_map_stages DROP CONSTRAINT note_mind_map_stages_workspace_fk`;
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /constraint is missing or incorrect/);
  } finally {
    if (roleCreated) await db.unsafe(`DROP ROLE "${restrictedRole}"`);
    if (partialRoleCreated) {
      // This is a disposable test DB: release test-owned grants and the test role.
      const [{ owner }] = await db<{ owner: string }[]>`SELECT current_user AS owner`;
      await db.unsafe(`ALTER TABLE IF EXISTS public.companion_reflections OWNER TO "${owner.replaceAll('"', '""')}"`);
      await db.unsafe(`DROP OWNED BY "${partialRole}"`);
      await db.unsafe(`DROP ROLE "${partialRole}"`);
    }
    await db.end({ timeout: 5 });
  }
});
