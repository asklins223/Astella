-- The companion note-edit dispatcher is the API half of one ledger row: the
-- worker freezes `notes.write.edit` while it waits for the live CRDT document
-- to confirm the write. That query still filtered the legacy one-operation name,
-- so a real edit was never picked up and the run sat until the turn was
-- cancelled. Only the name moves; scope, status and ordering stay as they were.
CREATE OR REPLACE FUNCTION public.astella_pending_companion_note_edits_v1()
RETURNS TABLE(workspace_id uuid,user_id uuid,call_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT c.workspace_id,c.user_id,c.id FROM public.companion_agent_tool_calls c
    JOIN public.companion_turn_runs r ON r.id=c.run_id
    WHERE c.name='notes.write.edit' AND c.status='executing' AND c.result_ref IS NULL
      AND r.status IN ('accepted','running') AND r.cancel_requested_at IS NULL
    ORDER BY c.created_at LIMIT 8
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.astella_pending_companion_note_edits_v1() FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='astella_api') THEN
    GRANT EXECUTE ON FUNCTION public.astella_pending_companion_note_edits_v1() TO astella_api;
  END IF;
END $$;
