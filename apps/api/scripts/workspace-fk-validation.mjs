#!/usr/bin/env node
/** Check migration 0472 after restoring or upgrading an existing database.
 * --validate validates all constraints atomically after every orphan is reconciled.
 * No rows are deleted or modified. Run as the BYPASSRLS migrator/table owner.
 */
import postgres from "postgres";

const targets = [
  ["companion_reflections", "companion_reflections_workspace_fk"],
  ["companion_reflection_sources", "companion_reflection_sources_workspace_fk"],
  ["companion_reflection_checkpoints", "companion_reflection_checkpoints_workspace_fk"],
  ["companion_release_router_samples", "companion_release_router_samples_workspace_fk"],
  ["note_mind_map_stages", "note_mind_map_stages_workspace_fk"],
];

async function inspect(sql) {
  const [role] = await sql`
    SELECT rolsuper OR rolbypassrls AS can_read_all
    FROM pg_catalog.pg_roles WHERE rolname = current_user
  `;
  // Counting through a restricted RLS role can silently report zero orphans.
  if (!role?.can_read_all) throw new Error("The current role must have BYPASSRLS or be a superuser.");

  const results = [];
  for (const [table, constraint] of targets) {
    const [fk] = await sql`
      SELECT c.convalidated AS validated
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_catalog.pg_class w ON w.oid = c.confrelid
      JOIN pg_catalog.pg_namespace wn ON wn.oid = w.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
      JOIN pg_catalog.pg_attribute wa ON wa.attrelid = w.oid AND wa.attname = 'id' AND NOT wa.attisdropped
      WHERE n.nspname = 'public' AND t.relname = ${table} AND c.conname = ${constraint}
        AND wn.nspname = 'public' AND w.relname = 'workspaces' AND c.contype = 'f'
        AND c.confdeltype = 'c' AND c.conkey = ARRAY[a.attnum] AND c.confkey = ARRAY[wa.attnum]
    `;
    if (!fk) throw new Error(`Expected workspace cascade constraint is missing or incorrect: ${constraint}.`);
    // Identifiers are selected exclusively from the fixed migration target list.
    const [count] = await sql.unsafe(`SELECT count(*)::text AS orphans FROM public."${table}" t
      LEFT JOIN public.workspaces w ON w.id = t.workspace_id
      WHERE t.workspace_id IS NOT NULL AND w.id IS NULL`);
    results.push({ table, constraint, validated: fk.validated, orphanCount: count.orphans });
  }
  return results;
}

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--validate") || args.length > 1) {
  console.error("Usage: node scripts/workspace-fk-validation.mjs [--validate]");
  process.exitCode = 2;
} else if (!process.env.DATABASE_URL_MIGRATOR) {
  console.error("DATABASE_URL_MIGRATOR is required; use a BYPASSRLS migrator role.");
  process.exitCode = 2;
} else {
  const sql = postgres(process.env.DATABASE_URL_MIGRATOR, { max: 1, connect_timeout: 10 });
  try {
    let results = await inspect(sql);
    if (args.includes("--validate") && results.every(row => row.orphanCount === "0")) {
      // One transaction prevents a partial validation result if any DDL fails.
      await sql.begin(async tx => {
        for (const row of results) {
          if (!row.validated) {
            await tx.unsafe(`ALTER TABLE public."${row.table}" VALIDATE CONSTRAINT "${row.constraint}"`);
          }
        }
      });
      results = await inspect(sql);
    }
    console.log(JSON.stringify({ constraints: results }, null, 2));
    if (results.some(row => !row.validated || row.orphanCount !== "0")) {
      console.error("Workspace constraints need reconciliation or validation; no data was deleted.");
      process.exitCode = 1;
    }
  } catch (error) {
    // Do not print connection strings, row values, or server error details.
    const message = error instanceof Error && /^(The current role|Expected workspace cascade)/.test(error.message)
      ? error.message : "Database check failed; verify migrator permissions, migration state and connectivity.";
    console.error(message);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
