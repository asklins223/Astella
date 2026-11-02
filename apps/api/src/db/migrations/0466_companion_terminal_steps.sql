-- A finished run cannot leave a model step working forever. Tool execution
-- receipts are deliberately separate: an uncertain side effect still needs
-- its normal reconciliation and must never be relabelled as successful here.
CREATE OR REPLACE FUNCTION public.astella_close_companion_steps_on_terminal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IN ('succeeded', 'failed', 'cancelled', 'superseded') THEN
    NEW.finished_at := COALESCE(NEW.finished_at, now());
    UPDATE public.companion_agent_steps
    SET status = CASE WHEN NEW.status IN ('cancelled', 'superseded') THEN 'cancelled' ELSE 'failed' END,
        error_code = COALESCE(error_code, NEW.error_code,
          CASE WHEN NEW.status = 'superseded' THEN 'RUN_SUPERSEDED'
               WHEN NEW.status = 'cancelled' THEN 'RUN_CANCELLED' ELSE 'RUN_SETTLED' END),
        finished_at = COALESCE(finished_at, NEW.finished_at)
    WHERE run_id = NEW.id AND workspace_id = NEW.workspace_id
      AND user_id = NEW.user_id AND status = 'running';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.astella_close_companion_steps_on_terminal() FROM PUBLIC;
DROP TRIGGER IF EXISTS companion_terminal_steps ON public.companion_turn_runs;
CREATE TRIGGER companion_terminal_steps
BEFORE INSERT OR UPDATE OF status ON public.companion_turn_runs
FOR EACH ROW EXECUTE FUNCTION public.astella_close_companion_steps_on_terminal();

UPDATE public.companion_turn_runs SET finished_at = updated_at
WHERE status IN ('succeeded', 'failed', 'cancelled', 'superseded') AND finished_at IS NULL;
UPDATE public.companion_agent_steps s
SET status = CASE WHEN r.status IN ('cancelled', 'superseded') THEN 'cancelled' ELSE 'failed' END,
    error_code = COALESCE(s.error_code, r.error_code,
      CASE WHEN r.status = 'superseded' THEN 'RUN_SUPERSEDED'
           WHEN r.status = 'cancelled' THEN 'RUN_CANCELLED' ELSE 'RUN_SETTLED' END),
    finished_at = COALESCE(s.finished_at, r.finished_at, r.updated_at)
FROM public.companion_turn_runs r
WHERE s.run_id = r.id AND s.workspace_id = r.workspace_id AND s.user_id = r.user_id
  AND s.status = 'running' AND r.status IN ('succeeded', 'failed', 'cancelled', 'superseded');
