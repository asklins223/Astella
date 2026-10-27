-- Both API dispatch lists and the pending-edit index still filtered the legacy
-- one-operation tool names. The ledger now stores the internal operation id, so
-- a real share or edit was never picked up: the worker waits for the API half of
-- the same row and the turn eventually dies on cancellation. Only the compared
-- names move; scope, status and ordering are unchanged.
CREATE OR REPLACE FUNCTION public.astella_pending_companion_note_shares_v1()
RETURNS TABLE(workspace_id uuid,user_id uuid,call_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT c.workspace_id,c.user_id,c.id FROM public.companion_agent_tool_calls c
    JOIN public.companion_turn_runs r ON r.id=c.run_id
    WHERE c.name='notes.write.share' AND c.status='executing' AND c.result_ref IS NULL
      AND r.status IN ('accepted','running') AND r.cancel_requested_at IS NULL
    ORDER BY c.created_at LIMIT 8
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.astella_pending_companion_note_shares_v1() FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='astella_api') THEN
    GRANT EXECUTE ON FUNCTION public.astella_pending_companion_note_shares_v1() TO astella_api;
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS public.companion_note_edit_pending_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS companion_note_edit_pending_idx ON public.companion_agent_tool_calls(created_at)
  WHERE name='notes.write.edit' AND status='executing' AND result_ref IS NULL;
