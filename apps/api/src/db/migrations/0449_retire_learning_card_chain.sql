-- Plan 57 (2026-10-19): hard cutover of the learning-card / review / today chain.
--
-- The product chain these tables served no longer exists: learning objectives,
-- generated cards, spaced review schedules, learning runs, note learning rounds,
-- and the first-use validation ledger. Their routes, workers, contracts and
-- readers were removed first, so dropping the storage is the last step and
-- leaves nothing pointing at them.
--
-- Order matters only for foreign keys; CASCADE covers the rest. Nothing here is
-- migrated into the new card tables — per the user's decision the old data is
-- dropped rather than carried over.

DROP TABLE IF EXISTS note_learning_round_artifact_failures CASCADE;
DROP TABLE IF EXISTS note_learning_round_artifacts CASCADE;
DROP TABLE IF EXISTS note_learning_round_teachings CASCADE;
DROP TABLE IF EXISTS note_learning_round_plan_revisions CASCADE;
DROP TABLE IF EXISTS note_learning_rounds CASCADE;

DROP TABLE IF EXISTS practice_trail_event_outbox CASCADE;
DROP TABLE IF EXISTS canonical_learning_event_outbox CASCADE;
DROP TABLE IF EXISTS learning_run_processing_outbox CASCADE;
DROP TABLE IF EXISTS learning_run_idempotency CASCADE;
DROP TABLE IF EXISTS interaction_qualifications CASCADE;
DROP TABLE IF EXISTS learning_task_presentation_history CASCADE;
DROP TABLE IF EXISTS learning_activity_leases CASCADE;
DROP TABLE IF EXISTS learning_run_action_ledger CASCADE;
DROP TABLE IF EXISTS learning_run_events CASCADE;
DROP TABLE IF EXISTS learning_task_drafts CASCADE;
DROP TABLE IF EXISTS learning_assessments CASCADE;
DROP TABLE IF EXISTS learning_artifacts CASCADE;
DROP TABLE IF EXISTS learning_task_disclosure_profiles CASCADE;
DROP TABLE IF EXISTS learning_task_safety_reports CASCADE;
DROP TABLE IF EXISTS learning_task_private_solutions CASCADE;
DROP TABLE IF EXISTS learning_task_variants CASCADE;
DROP TABLE IF EXISTS learning_tasks CASCADE;
DROP TABLE IF EXISTS learning_run_private_contracts CASCADE;
DROP TABLE IF EXISTS learning_runs CASCADE;

DROP TABLE IF EXISTS daily_review_batches_v2 CASCADE;
DROP TABLE IF EXISTS home_suggestion_dismissals_v2 CASCADE;
DROP TABLE IF EXISTS review_subscriptions_v2 CASCADE;
DROP TABLE IF EXISTS objective_review_holds_v2 CASCADE;
DROP TABLE IF EXISTS review_schedules CASCADE;

DROP TABLE IF EXISTS personal_relation_decisions_v2 CASCADE;

DROP TABLE IF EXISTS validation_assistance_exposures CASCADE;

DROP TABLE IF EXISTS card_generation_post_activation_consumptions CASCADE;
DROP TABLE IF EXISTS card_candidate_feedback_v2 CASCADE;
DROP TABLE IF EXISTS card_candidate_quality_reports_v2 CASCADE;
DROP TABLE IF EXISTS learning_exposures_v2 CASCADE;
DROP TABLE IF EXISTS learning_objective_lineage_v2 CASCADE;
DROP TABLE IF EXISTS learning_objective_revision_equivalence_v2 CASCADE;
DROP TABLE IF EXISTS learning_objective_equivalence_reports_v2 CASCADE;
DROP TABLE IF EXISTS learning_objective_evidence_bindings_v2 CASCADE;
DROP TABLE IF EXISTS semantic_support_reports_v2 CASCADE;
DROP TABLE IF EXISTS evidence_redactions_v2 CASCADE;
DROP TABLE IF EXISTS evidence_quote_copies_v2 CASCADE;
DROP TABLE IF EXISTS evidence_snapshots_v2 CASCADE;
DROP TABLE IF EXISTS card_generation_input_snapshots_v2 CASCADE;
DROP TABLE IF EXISTS card_generation_semantic_specs_v2 CASCADE;
DROP TABLE IF EXISTS card_content_capability_state CASCADE;
DROP TABLE IF EXISTS card_generation_run_outbox_v2 CASCADE;
DROP TABLE IF EXISTS evidence_eligibility_states_v2 CASCADE;
DROP TABLE IF EXISTS candidate_evidence_binding_plans_v2 CASCADE;
DROP TABLE IF EXISTS learning_target_snapshots_v2 CASCADE;
DROP TABLE IF EXISTS card_domain_events_v2 CASCADE;
DROP TABLE IF EXISTS card_generation_events_v2 CASCADE;
DROP TABLE IF EXISTS card_activation_receipts_v2 CASCADE;
DROP TABLE IF EXISTS initial_validation_reminders_v2 CASCADE;
DROP TABLE IF EXISTS card_exposure_ledger_v2 CASCADE;
DROP TABLE IF EXISTS learning_card_revisions_v2 CASCADE;
DROP TABLE IF EXISTS learning_card_publication_revisions_v2 CASCADE;
DROP TABLE IF EXISTS learning_cards_v2 CASCADE;
DROP TABLE IF EXISTS learning_objective_origins_v2 CASCADE;
DROP TABLE IF EXISTS learning_objective_revisions_v2 CASCADE;
DROP TABLE IF EXISTS learning_objectives_v2 CASCADE;
DROP TABLE IF EXISTS card_generation_candidates_v2 CASCADE;
DROP TABLE IF EXISTS card_generation_plans_v2 CASCADE;
DROP TABLE IF EXISTS card_generation_runs_v2 CASCADE;

-- ── Agent 制卡执行体的收尾 ──────────────────────────────────────────────────
-- 0373 把 agent_operations 的第二种执行体绑在 card_generation_runs_v2 与那发
-- outbox 上；两张表随上面一起删了。触发器、父围栏、归属读取与恢复扫描都只服务
-- 那条执行体，留着会在每次 agent 恢复扫描里引用不存在的列。
DROP TRIGGER IF EXISTS agent_card_run_event ON public.card_generation_runs_v2;

CREATE OR REPLACE FUNCTION public.astella_enqueue_agent_recovery() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public AS $$
DECLARE inserted integer;
BEGIN
  -- 制卡那一支已随卡链路退役：只剩 job 执行体的欠账核对与唤醒。
  INSERT INTO public.agent_run_events(run_id,workspace_id,user_id,revision,operation_id,execution_status)
  SELECT r.id,r.workspace_id,r.user_id,r.revision,o.id,j.status::text
  FROM public.agent_runs r JOIN public.agent_operations o ON o.run_id=r.id AND o.revision=r.revision
    JOIN public.jobs j ON j.id=o.job_id
    JOIN public.user_companion_account_state a ON a.id=r.identity_id AND a.user_id=r.user_id
  WHERE r.status='waiting' AND o.status='outcome_unknown' AND a.global_enabled AND a.epoch=r.account_epoch
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
            WHERE (i->>'noteId')::uuid=n.note_id AND (i->>'noteVersionId')::uuid=n.note_version_id)))
    AND NOT EXISTS(SELECT 1 FROM public.agent_run_events e WHERE e.operation_id=o.id AND e.processed_at IS NULL);
  INSERT INTO public.jobs(type,workspace_id,requested_by,payload,status,priority,resource_class,idempotency_key)
  SELECT 'agent_run_advance',r.workspace_id,r.user_id,jsonb_build_object('runId',r.id,'revision',r.revision),
    'pending',60,'maintenance','agent-recover:'||r.id::text||':'||r.revision::text||':'||floor(extract(epoch FROM now())/30)::text
  FROM public.agent_runs r JOIN public.user_companion_account_state a ON a.id=r.identity_id AND a.user_id=r.user_id
  WHERE a.global_enabled AND a.epoch=r.account_epoch
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
REVOKE ALL ON FUNCTION public.astella_enqueue_agent_recovery() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_enqueue_agent_recovery() TO astella_worker;

-- 取消只剩 jobs 那一支。
CREATE OR REPLACE FUNCTION public.astella_cancel_agent_operations(p_run uuid,p_revision integer) RETURNS void
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
    AND id IN (SELECT job_id FROM public.agent_operations WHERE run_id=p_run AND revision=p_revision AND job_id IS NOT NULL);
  UPDATE public.agent_operations SET status='cancelled',error=NULL,updated_at=now()
    WHERE run_id=p_run AND revision=p_revision AND status IN ('accepted','running','outcome_unknown');
END $$;
REVOKE ALL ON FUNCTION public.astella_cancel_agent_operations(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_cancel_agent_operations(uuid,integer) TO astella_api,astella_worker;

DROP FUNCTION IF EXISTS public.astella_agent_card_job_current(uuid,uuid,boolean);
DROP FUNCTION IF EXISTS public.astella_agent_card_execution_binding(uuid,uuid);
DROP FUNCTION IF EXISTS public.astella_agent_card_run_event();

-- 执行体只剩 jobs 一支：删掉制卡两列与它们的外键/唯一判据，XOR 随之收成 job 非空。
ALTER TABLE public.agent_operations DROP CONSTRAINT IF EXISTS agent_operations_card_run_fk;
ALTER TABLE public.agent_operations DROP CONSTRAINT IF EXISTS agent_operations_card_outbox_fk;
ALTER TABLE public.agent_operations DROP CONSTRAINT IF EXISTS agent_operations_execution_xor_chk;
DROP INDEX IF EXISTS public.agent_operations_card_run_unique;
DROP INDEX IF EXISTS public.agent_operations_card_outbox_unique;
-- 那几条旧制卡执行体已经没有可指向的 job 或 run；整条链路退役，连行一起删。
-- agent_run_events 走 ON DELETE CASCADE，欠账扫描不会留下无主事件。
DELETE FROM public.agent_operations WHERE job_id IS NULL;
ALTER TABLE public.agent_operations DROP COLUMN IF EXISTS card_generation_run_id;
ALTER TABLE public.agent_operations DROP COLUMN IF EXISTS card_generation_outbox_id;
ALTER TABLE public.agent_operations ALTER COLUMN job_id SET NOT NULL;

-- 结果形状收成 artifact：零推荐是旧制卡链才有的收口。
UPDATE public.agent_operations SET result = NULL WHERE result->>'kind' = 'no_cards_recommended';
ALTER TABLE public.agent_operations DROP CONSTRAINT IF EXISTS agent_operations_result_shape_chk;
ALTER TABLE public.agent_operations ADD CONSTRAINT agent_operations_result_shape_chk CHECK (
  result IS NULL OR jsonb_typeof(result)='object' AND result->>'kind' = 'artifact'
);
