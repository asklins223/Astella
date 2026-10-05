-- A manual page request is explicitly authorized for its frozen capability.
-- Companion off/read-only controls autonomous actions, not existing page buttons.
-- Epoch revocation, tenant/member/input checks and cancellation still apply.
CREATE FUNCTION public.ailearn_agent_run_authorized(p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agent_runs r JOIN public.user_companion_account_state a ON a.id=r.identity_id
    WHERE r.id=p_run AND r.workspace_id=NULLIF(current_setting('app.workspace_id',true),'')::uuid
      AND (NULLIF(current_setting('app.user_id',true),'') IS NULL
        OR r.user_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
      AND a.user_id=r.user_id AND a.epoch=r.account_epoch
      AND (r.direct_request IS NOT NULL OR (a.global_enabled AND a.agent_settings->>'permissionLevel'<>'read_only'))
  );
$$;
REVOKE ALL ON FUNCTION public.ailearn_agent_run_authorized(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ailearn_agent_run_authorized(uuid) TO ailearn_worker;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.ailearn_agent_job_current(p_job uuid,p_workspace uuid,p_user uuid,p_lock boolean DEFAULT false) RETURNS boolean
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
    AND r.status IN ('queued','running','waiting','paused') AND public.ailearn_agent_run_authorized(r.id)
    AND o.status IN ('accepted','running','outcome_unknown')
    AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=p_workspace AND m.user_id=p_user AND m.left_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.inputs) i WHERE NOT EXISTS(
      SELECT 1 FROM public.notes n JOIN public.note_versions v ON v.note_id=n.id AND v.workspace_id=n.workspace_id
      WHERE n.id=(i->>'noteId')::uuid AND v.id=(i->>'noteVersionId')::uuid AND n.workspace_id=p_workspace
        AND n.deleted_at IS NULL AND (n.share_scope='shared' OR n.created_by=p_user)));
  RETURN coalesce(allowed,false);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.ailearn_agent_card_job_current(p_outbox uuid,p_workspace uuid,p_lock boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE allowed boolean; parent_run uuid; card_run uuid;
BEGIN
  SELECT o.run_id,o.card_generation_run_id INTO parent_run,card_run
  FROM public.agent_operations o WHERE o.card_generation_outbox_id=p_outbox LIMIT 1;
  IF parent_run IS NULL THEN RETURN true; END IF;
  -- 先父后子，与取消同一条路（见文件头）。
  IF p_lock THEN
    PERFORM r.id FROM public.agent_runs r WHERE r.id=parent_run FOR SHARE;
    PERFORM cr.id FROM public.card_generation_runs_v2 cr WHERE cr.id=card_run FOR SHARE;
    PERFORM b.id FROM public.card_generation_run_outbox_v2 b WHERE b.id=p_outbox FOR SHARE;
  END IF;
  SELECT true INTO allowed FROM public.agent_operations o
    JOIN public.agent_runs r ON r.id=o.run_id
    JOIN public.card_generation_runs_v2 cr ON cr.id=o.card_generation_run_id
    JOIN public.card_generation_run_outbox_v2 b ON b.id=o.card_generation_outbox_id AND b.run_id=cr.id
    JOIN public.user_companion_account_state a ON a.id=r.identity_id AND a.user_id=r.user_id
    WHERE o.card_generation_outbox_id=p_outbox AND o.workspace_id=p_workspace AND cr.workspace_id=p_workspace
      AND o.user_id=cr.user_id AND b.workspace_id=p_workspace AND o.revision=r.revision
      -- paused 保留：已接受的这发让它做完，但父目标不因此推进新步骤。
      AND r.status IN ('queued','running','waiting','paused') AND public.ailearn_agent_run_authorized(r.id)
      AND o.status IN ('accepted','running','outcome_unknown')
      AND EXISTS(SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id=p_workspace AND m.user_id=cr.user_id AND m.left_at IS NULL)
      AND EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(r.inputs) i
        WHERE (i->>'noteId')::uuid=cr.note_id AND (i->>'noteVersionId')::uuid=cr.note_version_id)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(r.inputs) i WHERE NOT EXISTS(
        SELECT 1 FROM public.notes n JOIN public.note_versions v ON v.note_id=n.id AND v.workspace_id=n.workspace_id
        WHERE n.id=(i->>'noteId')::uuid AND v.id=(i->>'noteVersionId')::uuid AND n.workspace_id=p_workspace
          AND n.deleted_at IS NULL AND (n.share_scope='shared' OR n.created_by=cr.user_id)));
  RETURN coalesce(allowed,false);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.ailearn_enqueue_agent_recovery() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE inserted integer;
BEGIN
  -- Reconcile uncertain results using facts, with a bounded check budget and
  -- no repeated generation. A later saved artifact can still wake the goal.
  INSERT INTO public.agent_run_events(run_id,workspace_id,user_id,revision,operation_id,execution_status)
  SELECT r.id,r.workspace_id,r.user_id,r.revision,o.id,
    CASE WHEN o.job_id IS NOT NULL THEN j.status::text
      WHEN cr.status IN ('review_ready','needs_attention','no_cards_recommended') THEN 'succeeded'
      WHEN cr.status='cancelled' THEN 'cancelled' ELSE 'failed' END
  FROM public.agent_runs r JOIN public.agent_operations o ON o.run_id=r.id AND o.revision=r.revision
    LEFT JOIN public.jobs j ON j.id=o.job_id
    LEFT JOIN public.card_generation_runs_v2 cr ON cr.id=o.card_generation_run_id
    JOIN public.user_companion_account_state a ON a.id=r.identity_id AND a.user_id=r.user_id
  WHERE r.status='waiting' AND o.status='outcome_unknown' AND a.epoch=r.account_epoch AND (r.direct_request IS NOT NULL OR (a.global_enabled AND a.agent_settings->>'permissionLevel'<>'read_only'))
    AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=r.user_id AND m.left_at IS NULL)
    AND o.updated_at < now()-interval '30 seconds'
    AND (o.receipt_checks < 4
      OR EXISTS(SELECT 1 FROM public.note_overviews n JOIN public.jobs c ON c.id=n.generation_job_id
        WHERE n.generation_job_id=o.job_id AND n.workspace_id=r.workspace_id AND n.user_id=r.user_id
          AND c.type='note_overview_generate' AND c.workspace_id=r.workspace_id AND c.requested_by=r.user_id
          AND c.payload->>'noteId'=n.note_id::text AND c.payload->>'noteVersionId'=n.note_version_id::text
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.inputs) i
            WHERE (i->>'noteId')::uuid=n.note_id AND (i->>'noteVersionId')::uuid=n.note_version_id))
      OR EXISTS(SELECT 1 FROM public.note_learning_artifacts n JOIN public.jobs c ON c.id=n.generation_job_id
        WHERE n.generation_job_id=o.job_id AND n.workspace_id=r.workspace_id AND n.user_id=r.user_id
          AND c.type='note_dynamic_artifact_generate' AND c.workspace_id=r.workspace_id AND c.requested_by=r.user_id
          AND c.payload->>'noteId'=n.note_id::text AND c.payload->>'noteVersionId'=n.note_version_id::text
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.inputs) i
            WHERE (i->>'noteId')::uuid=n.note_id AND (i->>'noteVersionId')::uuid=n.note_version_id))
      OR EXISTS(SELECT 1 FROM public.note_expansion_tasks n JOIN public.jobs c ON c.id=n.id
        WHERE n.id=o.job_id AND n.workspace_id=r.workspace_id AND n.user_id=r.user_id
          AND c.type='note_expansion_generate' AND c.workspace_id=r.workspace_id AND c.requested_by=r.user_id
          AND c.payload->>'noteId'=n.note_id::text AND c.payload->>'noteVersionId'=n.note_version_id::text
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.inputs) i
            WHERE (i->>'noteId')::uuid=n.note_id AND (i->>'noteVersionId')::uuid=n.note_version_id))
      OR EXISTS(SELECT 1 FROM public.card_generation_candidates_v2 c
        WHERE c.workspace_id=cr.workspace_id AND c.run_id=cr.id
          AND c.quality_state='passed' AND c.review_decision='undecided'
          AND c.publish_state='unpublished' AND c.evidence_binding_plan_hash IS NOT NULL
          AND cr.status IN ('review_ready','needs_attention')
          AND NOT EXISTS(SELECT 1 FROM public.card_generation_candidates_v2 newer
            WHERE newer.workspace_id=c.workspace_id AND newer.run_id=c.run_id
              AND newer.candidate_id=c.candidate_id AND newer.revision>c.revision))
      OR cr.status='no_cards_recommended')
    AND NOT EXISTS(SELECT 1 FROM public.agent_run_events e WHERE e.operation_id=o.id AND e.processed_at IS NULL);
  INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
  SELECT 'agent_run_advance',r.workspace_id,r.user_id,jsonb_build_object('runId',r.id,'revision',r.revision),
    'pending',60,'maintenance','agent-recover:'||r.id::text||':'||r.revision::text||':'||floor(extract(epoch FROM now())/30)::text
  FROM public.agent_runs r JOIN public.user_companion_account_state a ON a.id=r.identity_id AND a.user_id=r.user_id
  WHERE a.epoch=r.account_epoch AND (r.direct_request IS NOT NULL OR (a.global_enabled AND a.agent_settings->>'permissionLevel'<>'read_only'))
    AND EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=r.workspace_id AND m.user_id=r.user_id AND m.left_at IS NULL)
    AND (r.status IN ('queued','running') OR (r.status IN ('waiting','paused') AND EXISTS(
      SELECT 1 FROM public.agent_run_events e WHERE e.run_id=r.id AND e.revision=r.revision
        AND e.processed_at IS NULL AND e.execution_status IN ('succeeded','failed','dead'))))
    AND NOT EXISTS(SELECT 1 FROM public.jobs j WHERE j.workspace_id=r.workspace_id AND j.requested_by=r.user_id
      AND j.type='agent_run_advance' AND j.payload->>'runId'=r.id::text
      AND j.payload->>'revision'=r.revision::text AND j.status IN ('pending','running'))
  ON CONFLICT (workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END $$;
