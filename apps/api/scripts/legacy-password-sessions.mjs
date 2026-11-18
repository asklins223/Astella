#!/usr/bin/env node
// Diagnostic by default. --revoke is an explicit operational action: after
// all API instances enforce require_reset, revoke the remaining sessions of
// accounts whose current password still uses legacy bcrypt.
import postgres from "postgres";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--revoke")) {
  console.error("Usage: node scripts/legacy-password-sessions.mjs [--revoke]");
  process.exitCode = 2;
} else if (!process.env.DATABASE_URL_MIGRATOR) {
  console.error("DATABASE_URL_MIGRATOR is required; use a BYPASSRLS migrator role.");
  process.exitCode = 2;
} else {
  const sql = postgres(process.env.DATABASE_URL_MIGRATOR, {
    max: 1,
    connect_timeout: 10,
    connection: { application_name: "astella_legacy_password_sessions" },
  });
  try {
    const [role] = await sql`SELECT rolsuper OR rolbypassrls AS can_read_all
      FROM pg_catalog.pg_roles WHERE rolname = current_user`;
    if (!role?.can_read_all) throw new Error("BYPASSRLS is required");
    if (args.includes("--revoke")) {
      const result = await sql.begin(async tx => {
        await tx`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`;
        await tx`SET LOCAL lock_timeout = '5s'`;
        // Acquire the same user locks as session rotation and password reset.
        // Delete in a separate statement so its snapshot includes sessions
        // committed by transactions we waited for. Current versions only
        // create scrypt hashes, so no new legacy accounts enter the scan.
        const [{ accounts }] = await tx`
          SELECT count(*)::text AS accounts
          FROM (
            SELECT id FROM public.users WHERE password_hash ~ '^[$]2[aby][$][0-9]{2}[$]'
            ORDER BY id FOR UPDATE
          ) legacy
        `;
        const [{ sessions }] = await tx`
          WITH revoked AS (
            DELETE FROM public.sessions s USING public.users u
            WHERE s.user_id = u.id AND u.password_hash ~ '^[$]2[aby][$][0-9]{2}[$]'
            RETURNING 1
          ) SELECT count(*)::text AS sessions FROM revoked
        `;
        return { accounts, sessions };
      });
      console.log(JSON.stringify({ mode: "revoked", legacyAccounts: result.accounts, sessions: result.sessions }));
    } else {
      const [result] = await sql`SELECT count(DISTINCT u.id)::text AS accounts,
          count(s.user_id)::text AS sessions
        FROM public.users u LEFT JOIN public.sessions s ON s.user_id = u.id
        WHERE u.password_hash ~ '^[$]2[aby][$][0-9]{2}[$]'`;
      console.log(JSON.stringify({ mode: "check", legacyAccounts: result.accounts, sessions: result.sessions }));
    }
  } catch (error) {
    // Never print connection strings, individual users, hashes or tokens.
    console.error(error instanceof Error && error.message === "BYPASSRLS is required"
      ? "The current role must have BYPASSRLS or be a superuser."
      : "Database operation failed; verify migrator permissions and connectivity.");
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
