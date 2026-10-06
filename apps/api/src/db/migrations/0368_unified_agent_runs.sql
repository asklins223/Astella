-- A goal has its own revision and lifetime; conversation turns remain independent.
CREATE TABLE public.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES public.user_companion_account_state(id),
  account_epoch integer NOT NULL,
  request_id uuid NOT NULL,
  conversation_id uuid REFERENCES public.companion_conversations(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  goal text NOT NULL CHECK (char_length(goal) BETWEEN 1 AND 8000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting','paused','completed','failed','cancelled')),
  resume_from_revision integer CHECK (resume_from_revision > 0),
  inputs jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(inputs) = 'array'),
  messages jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(messages) = 'array'),
  summary text, error text,
  model_calls integer NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
  max_model_calls integer NOT NULL DEFAULT 16 CHECK (max_model_calls BETWEEN 1 AND 32),
  advance_job_id uuid, advance_lease_token text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,user_id,request_id), UNIQUE (id,workspace_id,user_id)
);
CREATE INDEX agent_runs_owner_time_idx ON public.agent_runs(workspace_id,user_id,updated_at DESC);
CREATE UNIQUE INDEX jobs_id_workspace_actor_unique ON public.jobs(id,workspace_id,requested_by);
CREATE TABLE public.agent_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL, workspace_id uuid NOT NULL, user_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  tool_call_id text NOT NULL, capability text NOT NULL,
  job_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','running','succeeded','failed','cancelled','outcome_unknown')),
  last_event_seq bigint NOT NULL DEFAULT 0,
  receipt_checks integer NOT NULL DEFAULT 0 CHECK (receipt_checks >= 0),
  artifact jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id,workspace_id,user_id) REFERENCES public.agent_runs(id,workspace_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (job_id,workspace_id,user_id) REFERENCES public.jobs(id,workspace_id,requested_by) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (run_id,revision,tool_call_id), UNIQUE (job_id), UNIQUE(id,workspace_id,user_id)
);
CREATE TABLE public.agent_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL, workspace_id uuid NOT NULL, user_id uuid NOT NULL,
  revision integer NOT NULL, ordinal integer NOT NULL CHECK (ordinal > 0),
  context_snapshot jsonb NOT NULL, request_hash text NOT NULL,
  response jsonb, applied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id,workspace_id,user_id) REFERENCES public.agent_runs(id,workspace_id,user_id) ON DELETE CASCADE,
  UNIQUE (run_id,revision,ordinal)
);
CREATE TABLE public.agent_run_events (
  seq bigserial PRIMARY KEY, run_id uuid NOT NULL, workspace_id uuid NOT NULL, user_id uuid NOT NULL,
  revision integer NOT NULL, operation_id uuid NOT NULL,
  job_status text NOT NULL, processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id,workspace_id,user_id) REFERENCES public.agent_runs(id,workspace_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id,workspace_id,user_id) REFERENCES public.agent_operations(id,workspace_id,user_id) ON DELETE CASCADE
);
CREATE INDEX agent_run_events_pending_idx ON public.agent_run_events(run_id,seq) WHERE processed_at IS NULL;

--> statement-breakpoint
CREATE FUNCTION public.astella_agent_scope_current(p_workspace uuid,p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT p_workspace=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND p_user=NULLIF(current_setting('app.user_id',true),'')::uuid
    AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=p_workspace AND m.user_id=p_user AND m.left_at IS NULL)
$$;
REVOKE ALL ON FUNCTION public.astella_agent_scope_current(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_agent_scope_current(uuid,uuid) TO astella_api,astella_worker;

--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['agent_runs','agent_operations','agent_run_steps','agent_run_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY owner_scope ON public.%I FOR ALL
      USING (public.astella_agent_scope_current(workspace_id,user_id))
      WITH CHECK (public.astella_agent_scope_current(workspace_id,user_id))', t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.%I TO astella_api,astella_worker',t);
  END LOOP;
END $$;
GRANT USAGE,SELECT ON SEQUENCE public.agent_run_events_seq_seq TO astella_api,astella_worker;

--> statement-breakpoint
-- A worker may enqueue only a child bound to its owned goal, or that goal's
-- continuation. Existing job insertion restrictions remain in force.
CREATE POLICY agent_goal_enqueue ON public.jobs FOR INSERT TO astella_worker WITH CHECK (
  (type='agent_run_advance' AND EXISTS(SELECT 1 FROM public.agent_runs r
    WHERE r.id=(payload->>'runId')::uuid AND r.revision=(payload->>'revision')::integer
      AND r.workspace_id=jobs.workspace_id AND r.user_id=jobs.requested_by))
  OR (type IN ('note_overview_generate','note_dynamic_artifact_generate') AND EXISTS(
    SELECT 1 FROM public.agent_operations o JOIN public.agent_runs r ON r.id=o.run_id AND r.revision=o.revision
    WHERE o.job_id=jobs.id AND o.capability=jobs.type AND o.workspace_id=jobs.workspace_id AND o.user_id=jobs.requested_by))
);

--> statement-breakpoint
-- Mutation and wakeup share the job transaction. LISTEN is only an acceleration;
-- the durable outbox and recovery scan also work after a process restart.
CREATE FUNCTION public.astella_agent_job_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE op record; event_seq bigint;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  SELECT o.*,r.status AS run_status,r.revision AS current_revision INTO op
  FROM public.agent_operations o JOIN public.agent_runs r ON r.id=o.run_id
  WHERE o.job_id=NEW.id AND o.workspace_id=NEW.workspace_id AND o.user_id=NEW.requested_by;
  IF NOT FOUND THEN RETURN NEW; END IF;
  INSERT INTO public.agent_run_events(run_id,workspace_id,user_id,revision,operation_id,job_status)
  VALUES(op.run_id,op.workspace_id,op.user_id,op.revision,op.id,NEW.status::text) RETURNING seq INTO event_seq;
  IF op.revision=op.current_revision AND op.run_status IN ('queued','running','waiting','paused')
     AND NEW.status::text IN ('succeeded','dead','failed') THEN
    INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
    VALUES('agent_run_advance',op.workspace_id,op.user_id,
      jsonb_build_object('runId',op.run_id,'revision',op.revision),'pending',60,'maintenance',
      'agent-wake:'||op.run_id::text||':'||op.revision::text||':'||event_seq::text)
    ON CONFLICT (workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.astella_agent_job_event() FROM PUBLIC;
CREATE TRIGGER agent_job_event AFTER UPDATE OF status ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.astella_agent_job_event();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.astella_enqueue_agent_recovery() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE inserted integer;
BEGIN
  -- Reconcile uncertain results using facts, with a bounded check budget and
  -- no repeated generation. A later saved artifact can still wake the goal.
  INSERT INTO public.agent_run_events(run_id,workspace_id,user_id,revision,operation_id,job_status)
  SELECT r.id,r.workspace_id,r.user_id,r.revision,o.id,j.status
  FROM public.agent_runs r JOIN public.agent_operations o ON o.run_id=r.id AND o.revision=r.revision
    JOIN public.jobs j ON j.id=o.job_id
    JOIN public.user_companion_account_state a ON a.id=r.identity_id AND a.user_id=r.user_id
  WHERE r.status='waiting' AND o.status='outcome_unknown' AND a.global_enabled AND a.epoch=r.account_epoch
    AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=r.user_id AND m.left_at IS NULL)
    AND o.updated_at < now()-interval '30 seconds'
    AND (o.receipt_checks < 4 OR EXISTS(SELECT 1 FROM public.note_overviews n WHERE n.generation_job_id=o.job_id)
      OR EXISTS(SELECT 1 FROM public.note_learning_artifacts n WHERE n.generation_job_id=o.job_id))
    AND NOT EXISTS(SELECT 1 FROM public.agent_run_events e WHERE e.operation_id=o.id AND e.processed_at IS NULL);
  INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
  SELECT 'agent_run_advance',r.workspace_id,r.user_id,jsonb_build_object('runId',r.id,'revision',r.revision),
    'pending',60,'maintenance','agent-recover:'||r.id::text||':'||r.revision::text||':'||floor(extract(epoch FROM now())/30)::text
  FROM public.agent_runs r JOIN public.user_companion_account_state a ON a.id=r.identity_id AND a.user_id=r.user_id
  WHERE a.global_enabled AND a.epoch=r.account_epoch
    AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=r.user_id AND m.left_at IS NULL)
    AND (r.status IN ('queued','running') OR (r.status IN ('waiting','paused') AND EXISTS(
      SELECT 1 FROM public.agent_run_events e WHERE e.run_id=r.id AND e.revision=r.revision
        AND e.processed_at IS NULL AND e.job_status IN ('succeeded','dead','failed'))))
    AND NOT EXISTS(SELECT 1 FROM public.jobs j WHERE j.workspace_id=r.workspace_id AND j.requested_by=r.user_id
      AND j.type='agent_run_advance' AND j.payload->>'runId'=r.id::text
      AND j.payload->>'revision'=r.revision::text AND j.status IN ('pending','running'))
  ON CONFLICT (workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END $$;
REVOKE ALL ON FUNCTION public.astella_enqueue_agent_recovery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_enqueue_agent_recovery() TO astella_worker;

--> statement-breakpoint
CREATE FUNCTION public.astella_cancel_agent_operations(p_run uuid,p_revision integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM public.agent_runs WHERE id=p_run AND revision=p_revision
    AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
    AND user_id=NULLIF(current_setting('app.user_id',true),'')::uuid FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.workspace_members m
    WHERE m.workspace_id=r.workspace_id AND m.user_id=r.user_id AND m.left_at IS NULL) THEN
    RAISE EXCEPTION 'agent scope not authorized' USING ERRCODE='42501';
  END IF;
  UPDATE public.jobs SET status='dead',lease_token=NULL,finished_at=now(),last_error='agent_cancelled'
    WHERE workspace_id=r.workspace_id AND requested_by=r.user_id AND status IN ('pending','running')
    AND id IN (SELECT job_id FROM public.agent_operations WHERE run_id=p_run AND revision=p_revision);
  UPDATE public.agent_operations SET status='cancelled',error=NULL,updated_at=now()
    WHERE run_id=p_run AND revision=p_revision AND status IN ('accepted','running','outcome_unknown');
END $$;
REVOKE ALL ON FUNCTION public.astella_cancel_agent_operations(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_cancel_agent_operations(uuid,integer) TO astella_api,astella_worker;

--> statement-breakpoint
CREATE FUNCTION public.astella_agent_job_current(p_job uuid,p_workspace uuid,p_user uuid,p_lock boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE allowed boolean;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.agent_operations WHERE job_id=p_job) THEN RETURN true; END IF;
  -- Lock the goal before the job, matching revise/cancel. A late commit cannot
  -- cross the revision fence while the model is running outside transactions.
  IF p_lock THEN PERFORM r.id FROM public.agent_runs r JOIN public.agent_operations o ON o.run_id=r.id
    WHERE o.job_id=p_job FOR SHARE OF r; END IF;
  SELECT true INTO allowed FROM public.agent_operations o JOIN public.agent_runs r ON r.id=o.run_id
    JOIN public.user_companion_account_state a ON a.id=r.identity_id AND a.user_id=r.user_id
    WHERE o.job_id=p_job AND o.workspace_id=p_workspace AND o.user_id=p_user AND o.revision=r.revision
    AND r.status IN ('queued','running','waiting','paused') AND a.global_enabled AND a.epoch=r.account_epoch
    AND a.agent_settings->>'permissionLevel'<>'read_only'
    AND o.status IN ('accepted','running','outcome_unknown')
    AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=p_workspace AND m.user_id=p_user AND m.left_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.inputs) i WHERE NOT EXISTS(
      SELECT 1 FROM public.notes n JOIN public.note_versions v ON v.note_id=n.id AND v.workspace_id=n.workspace_id
      WHERE n.id=(i->>'noteId')::uuid AND v.id=(i->>'noteVersionId')::uuid AND n.workspace_id=p_workspace
        AND n.deleted_at IS NULL AND (n.share_scope='shared' OR n.created_by=p_user)));
  RETURN coalesce(allowed,false);
END $$;
REVOKE ALL ON FUNCTION public.astella_agent_job_current(uuid,uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_agent_job_current(uuid,uuid,uuid,boolean) TO astella_worker;
