-- API owns live note documents. Worker keeps its existing scoped tool ledger.
-- Only pending edit identities cross the scheduler scope; content is read under RLS.
CREATE OR REPLACE FUNCTION public.astella_pending_companion_note_edits_v1()
RETURNS TABLE(workspace_id uuid,user_id uuid,call_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT c.workspace_id,c.user_id,c.id FROM public.companion_agent_tool_calls c
    JOIN public.companion_turn_runs r ON r.id=c.run_id
    WHERE c.name='companion_edit_note' AND c.status='executing' AND c.result_ref IS NULL
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
