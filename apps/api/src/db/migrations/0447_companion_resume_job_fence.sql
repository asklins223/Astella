-- Retiring a failed companion attempt must also revoke its queue lease. API
-- callers cannot update the queue directly; this narrow function checks the
-- owned failed run, exact job, actor, workspace and payload before revocation.
CREATE OR REPLACE FUNCTION public.astella_retire_companion_resume_job_v1(p_run uuid, p_job uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE allowed boolean;
BEGIN
  SELECT true INTO allowed FROM public.companion_turn_runs r JOIN public.jobs j ON j.id=r.job_id
  WHERE r.id=p_run AND r.job_id=p_job AND r.status='failed'
    AND r.workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid
    AND r.user_id=nullif(current_setting('app.user_id',true),'')::uuid
    AND j.workspace_id=r.workspace_id AND j.requested_by=r.user_id
    AND j.type='companion_agent' AND j.payload->>'runId'=r.id::text
  FOR NO KEY UPDATE OF r;
  IF allowed IS DISTINCT FROM true THEN RETURN false; END IF;
  UPDATE public.jobs SET status='dead',lease_token=NULL,finished_at=now(),last_error='replaced_by_user_resume'
    WHERE id=p_job AND status IN ('pending','running','failed');
  RETURN true;
END $$;
--> statement-breakpoint
ALTER FUNCTION public.astella_retire_companion_resume_job_v1(uuid,uuid) OWNER TO astella_migrator;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.astella_retire_companion_resume_job_v1(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.astella_retire_companion_resume_job_v1(uuid,uuid) TO astella_api;
