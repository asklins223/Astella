-- 2026-10-20: let the migrator role touch companion_messages again.
--
-- 0433's trigger function runs as the calling role (no SECURITY DEFINER) and
-- only granted EXECUTE to astella_api and astella_worker. The migrator owns
-- every table and is the role used for data migrations and acceptance
-- fixtures, so any UPDATE/DELETE on companion_messages performed as the
-- migrator fails with 42501 inside the trigger. The companion-run-resume
-- integration test hit exactly that on a fresh database.

GRANT EXECUTE ON FUNCTION public.astella_invalidate_covered_conversation_summaries(uuid, bigint) TO astella_migrator;
