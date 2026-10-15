-- Append-only compaction metadata for private worker handoffs. The worker
-- retains SELECT/INSERT only; it cannot rewrite the frozen model context.
CREATE OR REPLACE FUNCTION public.astella_append_handoff_compactions_v1(
  p_run uuid, p_expected_sha text, p_compactions jsonb, p_next_sha text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_workspace uuid := NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid;
  v_user uuid := NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  v_snapshot jsonb;
  v_previous jsonb;
  v_prefix jsonb;
BEGIN
  IF v_workspace IS NULL OR v_user IS NULL OR jsonb_typeof(p_compactions) IS DISTINCT FROM 'array'
     OR p_next_sha IS NULL OR p_next_sha !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  -- Lock the live run before its snapshot, preserving the cancellation fence.
  PERFORM 1 FROM public.companion_turn_runs r
    WHERE r.id=p_run AND r.workspace_id=v_workspace AND r.user_id=v_user
      AND r.status IN ('accepted','running','waiting_for_confirmation') FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT s.snapshot INTO v_snapshot FROM public.companion_context_handoff_snapshots s
    JOIN public.companion_turn_runs r ON r.id=s.run_id AND r.workspace_id=s.workspace_id
      AND r.user_id=s.user_id AND r.conversation_id=s.conversation_id
    WHERE s.run_id=p_run AND s.workspace_id=v_workspace AND s.user_id=v_user
      AND s.snapshot_sha256=p_expected_sha FOR UPDATE OF s;
  IF NOT FOUND THEN RETURN false; END IF;
  v_previous := COALESCE(v_snapshot->'compactions','[]'::jsonb);
  IF jsonb_typeof(v_previous) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_compactions) <= jsonb_array_length(v_previous) THEN RETURN false; END IF;
  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinality),'[]'::jsonb) INTO v_prefix
    FROM jsonb_array_elements(p_compactions) WITH ORDINALITY item(value,ordinality)
    WHERE item.ordinality <= jsonb_array_length(v_previous);
  IF v_prefix IS DISTINCT FROM v_previous THEN RETURN false; END IF;
  UPDATE public.companion_context_handoff_snapshots SET
    snapshot=jsonb_set(v_snapshot,'{compactions}',p_compactions,true),
    snapshot_sha256=p_next_sha, snapshot_version=snapshot_version+1
    WHERE run_id=p_run AND workspace_id=v_workspace AND user_id=v_user
      AND snapshot_sha256=p_expected_sha;
  RETURN FOUND;
END;
$function$;
ALTER FUNCTION public.astella_append_handoff_compactions_v1(uuid,text,jsonb,text) OWNER TO astella_migrator;
REVOKE ALL ON FUNCTION public.astella_append_handoff_compactions_v1(uuid,text,jsonb,text) FROM PUBLIC,astella_api;
GRANT EXECUTE ON FUNCTION public.astella_append_handoff_compactions_v1(uuid,text,jsonb,text) TO astella_worker;
