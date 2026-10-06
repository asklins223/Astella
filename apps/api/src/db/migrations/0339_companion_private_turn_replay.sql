-- Private turn replay may expose a run's exact input to its authenticated owner,
-- but the API must not receive direct table access to worker handoff snapshots.
-- This one-purpose function binds the run to the transaction's validated
-- workspace/user context and withholds snapshots larger than 512 KiB.
CREATE OR REPLACE FUNCTION public.astella_read_companion_turn_handoff_snapshot_v1(
  p_run_id uuid
)
RETURNS TABLE (
  snapshot jsonb,
  snapshot_sha256 text,
  snapshot_version integer,
  snapshot_bytes bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    CASE
      WHEN pg_catalog.pg_column_size(s.snapshot) <= 524288
       AND pg_catalog.octet_length(s.snapshot::text) <= 524288 THEN s.snapshot
      ELSE NULL::jsonb
    END,
    s.snapshot_sha256::text,
    s.snapshot_version,
    pg_catalog.octet_length(s.snapshot::text)::bigint
  FROM public.companion_context_handoff_snapshots AS s
  JOIN public.companion_turn_runs AS r
    ON r.id = s.run_id
   AND r.workspace_id = s.workspace_id
   AND r.user_id = s.user_id
   AND r.conversation_id = s.conversation_id
  WHERE s.run_id = p_run_id
    AND s.workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
    AND s.user_id = NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.astella_read_companion_turn_handoff_snapshot_v1(uuid) IS
  'Owner-scoped private turn replay only. Direct API table access remains revoked; the run must match transaction-local workspace/user identity, and snapshots over 512 KiB are withheld.';

REVOKE ALL ON FUNCTION public.astella_read_companion_turn_handoff_snapshot_v1(uuid)
  FROM PUBLIC, astella_worker;
GRANT EXECUTE ON FUNCTION public.astella_read_companion_turn_handoff_snapshot_v1(uuid)
  TO astella_api;
