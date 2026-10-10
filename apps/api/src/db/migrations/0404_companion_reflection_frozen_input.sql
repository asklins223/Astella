-- Freeze bounded input until the reflection settles. Finalization removes its
-- text; source/version edges retain the evidence needed for withdrawal.
ALTER TABLE public.companion_reflections ADD COLUMN input_snapshot jsonb;

--> statement-breakpoint

-- Worker has SELECT on account/member/consent rows, not blanket UPDATE (which
-- PostgreSQL requires even for FOR SHARE). Lock only the scoped authority rows.
CREATE FUNCTION public.astella_companion_reflection_authority(p_user uuid,p_workspace uuid,p_conversation uuid)
RETURNS TABLE(epoch integer,allowed boolean,external_allowed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a record; settings record; access_ok boolean;
BEGIN
  IF p_user IS DISTINCT FROM NULLIF(current_setting('app.user_id',true),'')::uuid
    OR p_workspace IS DISTINCT FROM NULLIF(current_setting('app.workspace_id',true),'')::uuid THEN
    RETURN QUERY SELECT 0,false,false; RETURN;
  END IF;
  SELECT s.epoch,s.global_enabled INTO a FROM public.user_companion_account_state s
    WHERE s.user_id=p_user FOR SHARE;
  SELECT true INTO access_ok FROM public.companion_conversations c JOIN public.workspace_members m
    ON m.workspace_id=c.workspace_id AND m.user_id=c.user_id
    WHERE c.id=p_conversation AND c.workspace_id=p_workspace AND c.user_id=p_user AND m.left_at IS NULL
    FOR SHARE OF c,m;
  SELECT s.consent_at,s.consent_version,s.data_policy INTO settings FROM public.user_ai_settings s
    WHERE s.user_id=p_user FOR SHARE;
  RETURN QUERY SELECT coalesce(a.epoch,0),coalesce(a.global_enabled AND access_ok,false),
    coalesce(settings.consent_at IS NOT NULL AND settings.consent_version IS NOT NULL
      AND settings.data_policy->>'sendToExternal'='true',false);
END $$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_companion_reflection_authority(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_companion_reflection_authority(uuid,uuid,uuid) TO astella_worker;

--> statement-breakpoint

-- Account persona may be adopted from another space. Return only validity,
-- never source text, and require membership in the original source space.
CREATE FUNCTION public.astella_companion_persona_message_current(p_user uuid,p_message uuid,p_hash text,p_role text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT p_user=NULLIF(current_setting('app.user_id',true),'')::uuid AND EXISTS(
    SELECT 1 FROM public.companion_messages m JOIN public.workspace_members w
      ON w.workspace_id=m.workspace_id AND w.user_id=m.user_id AND w.left_at IS NULL
    WHERE m.id=p_message AND m.user_id=p_user AND m.role=p_role
      AND (p_hash IS NULL OR m.content_sha256=p_hash));
$$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_companion_persona_message_current(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.astella_companion_persona_message_current(uuid,uuid,text,text) TO astella_api,astella_worker;

--> statement-breakpoint

-- Clearing/editing the original message must also clear frozen input, even if
-- its background job never gets another attempt. Retire only untouched automatic
-- judgments that actually cite this message; preserve user revisions.
CREATE FUNCTION public.astella_clear_reflection_message_input() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.content_sha256 IS NOT DISTINCT FROM OLD.content_sha256
    AND NEW.blocks IS NOT DISTINCT FROM OLD.blocks THEN RETURN NEW; END IF;
  DELETE FROM public.companion_reflection_checkpoints c USING public.companion_reflections r
    WHERE c.job_id=r.job_id AND r.user_id=OLD.user_id AND EXISTS(
      SELECT 1 FROM public.companion_reflection_sources s WHERE s.reflection_id=r.id
        AND s.relation='read' AND s.source_kind IN ('user_message','assistant_message') AND s.source_id=OLD.id::text);
  UPDATE public.companion_reflections r SET input_snapshot=NULL
    WHERE r.user_id=OLD.user_id AND EXISTS(
      SELECT 1 FROM public.companion_reflection_sources s WHERE s.reflection_id=r.id
        AND s.relation='read' AND s.source_kind IN ('user_message','assistant_message') AND s.source_id=OLD.id::text);
  UPDATE public.assistant_memory_items a SET deleted_at=now(),updated_at=now(),revision=revision+1
    WHERE a.user_id=OLD.user_id AND a.kind='judgment' AND a.author_type='companion' AND a.deleted_at IS NULL
      AND OLD.id::text=ANY(a.source_event_ids) AND EXISTS(
        SELECT 1 FROM public.companion_reflection_sources s WHERE s.user_id=a.user_id
          AND s.relation='produced' AND s.source_kind='memory' AND s.source_id=a.id::text
          AND s.source_revision=a.revision::text);
  UPDATE public.companion_procedural_playbooks p SET epistemic_status='disputed',updated_at=now(),version=version+1
    WHERE p.user_id=OLD.user_id AND p.author='maintenance' AND NOT p.user_controlled
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.evidence) e WHERE e->>'eventId'='message:'||OLD.id::text)
      AND EXISTS(SELECT 1 FROM public.companion_reflection_sources s WHERE s.user_id=p.user_id
        AND s.relation='produced' AND s.source_kind='method' AND s.source_id=p.id::text AND s.source_revision=p.version::text);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_clear_reflection_message_input() FROM PUBLIC;
CREATE TRIGGER companion_reflection_message_withdrawal
  AFTER DELETE OR UPDATE OF content_sha256,blocks ON public.companion_messages
  FOR EACH ROW EXECUTE FUNCTION public.astella_clear_reflection_message_input();

--> statement-breakpoint

-- Retryable jobs keep their frozen input. Terminal jobs release abandoned
-- business rows so repeated crashes cannot permanently fill the account gate.
CREATE FUNCTION public.astella_close_abandoned_reflection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.type='companion_reflection' AND NEW.status IN ('dead','failed','succeeded') THEN
    DELETE FROM public.companion_reflection_checkpoints c USING public.companion_reflections r
      WHERE c.job_id=NEW.id AND r.job_id=NEW.id AND r.decision IN ('queued','running');
    UPDATE public.companion_reflections SET decision='lease_lost',input_snapshot=NULL,
      decision_summary='后台任务已结束，未提交的回顾已释放',updated_at=now()
      WHERE job_id=NEW.id AND decision IN ('queued','running');
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint

REVOKE ALL ON FUNCTION public.astella_close_abandoned_reflection() FROM PUBLIC;
CREATE TRIGGER companion_reflection_job_terminal
  AFTER UPDATE OF status ON public.jobs FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.astella_close_abandoned_reflection();

--> statement-breakpoint

DELETE FROM public.companion_reflection_checkpoints c USING public.companion_reflections r,public.jobs j
  WHERE c.job_id=r.job_id AND j.id=r.job_id AND j.status IN ('dead','failed','succeeded')
    AND r.decision IN ('queued','running');
UPDATE public.companion_reflections r SET decision='lease_lost',input_snapshot=NULL,
  decision_summary='后台任务已结束，未提交的回顾已释放',updated_at=now()
  FROM public.jobs j WHERE j.id=r.job_id AND j.status IN ('dead','failed','succeeded')
    AND r.decision IN ('queued','running');


--> statement-breakpoint

-- Per-account reflection execution uses the existing renewable jobs lease;
-- no long transaction or separate account state waits across a model call.
CREATE INDEX jobs_reflection_account_queue ON public.jobs(requested_by,status,scheduled_at,id)
  WHERE type='companion_reflection' AND status IN ('pending','running');

--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.astella_claim_jobs(
  p_limit integer,
  p_background_limit integer,
  p_max_attempts integer
)
RETURNS TABLE (
  id uuid,
  type text,
  payload jsonb,
  workspace_id uuid,
  requested_by uuid,
  attempts integer,
  lease_token text,
  resource_class text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  -- Claim transactions are short. Serialize their snapshot, not model execution,
  -- so simultaneous workers cannot both admit a reflection for one account.
  PERFORM pg_advisory_xact_lock(hashtextextended('astella:reflection-job-claim',0));
  RETURN QUERY
  WITH claim_parameters AS (
    SELECT
      -- 0 = 没有空闲槽位（worker 传 0 时不认领任何 job）；NULL 仍按 1 处理。
      greatest(0, least(coalesce(p_limit, 1), 32)) AS claim_limit,
      -- 后台名额：NULL 视为不限（与 claim_limit 同额度），并夹取到 claim_limit。
      least(
        greatest(0, coalesce(p_background_limit, 32)),
        greatest(0, least(coalesce(p_limit, 1), 32))
      ) AS background_limit,
      greatest(1, least(coalesce(p_max_attempts, 3), 10)) AS max_attempts,
      clock_timestamp() AS claimed_at
  ), candidates AS MATERIALIZED (
    SELECT
      j.id,
      j.type,
      j.priority,
      j.scheduled_at,
      (j.resource_class = 'interactive_ai') AS is_interactive
    FROM public.jobs AS j
    CROSS JOIN claim_parameters AS parameters
    WHERE j.status = 'pending'
      AND j.attempts < parameters.max_attempts
      AND j.scheduled_at <= parameters.claimed_at
      AND (j.type <> 'companion_reflection' OR (
        NOT EXISTS (
          SELECT 1 FROM public.jobs busy WHERE busy.type='companion_reflection'
            AND busy.requested_by=j.requested_by AND busy.status='running'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.jobs earlier WHERE earlier.type='companion_reflection'
            AND earlier.requested_by=j.requested_by AND earlier.status='pending'
            AND earlier.attempts < parameters.max_attempts
            AND earlier.scheduled_at <= parameters.claimed_at
            AND (earlier.scheduled_at,earlier.id) < (j.scheduled_at,j.id)
        )
      ))
    ORDER BY
      CASE
        WHEN j.resource_class = 'interactive_ai' THEN 1000
        ELSE 0
      END
      + greatest(
          j.priority,
          CASE j.type
            WHEN 'evaluate_validation' THEN 100
            WHEN 'generate_validation_question' THEN 100
            WHEN 'parse_source' THEN 70
            WHEN 'generate_card' THEN 50
            WHEN 'align_evidence' THEN 10
            ELSE 50
          END
        ) DESC,
      j.scheduled_at,
      j.id
    LIMIT (SELECT claim_limit FROM claim_parameters)
    FOR UPDATE OF j SKIP LOCKED
  ), admitted AS MATERIALIZED (
    -- 类别内排名后放行：交互 job 全数放行，后台只放行前 background_limit 个
    -- （窗口函数不能出现在带 FOR UPDATE 的 CTE 里，所以先锁候选、再在这里排名）。
    SELECT ranked.id
    FROM (
      SELECT
        candidates.id,
        candidates.is_interactive,
        row_number() OVER (
          PARTITION BY candidates.is_interactive
          ORDER BY
            CASE WHEN candidates.is_interactive THEN 1000 ELSE 0 END
            + greatest(
                candidates.priority,
                CASE candidates.type
                  WHEN 'evaluate_validation' THEN 100
                  WHEN 'generate_validation_question' THEN 100
                  WHEN 'parse_source' THEN 70
                  WHEN 'generate_card' THEN 50
                  WHEN 'align_evidence' THEN 10
                  ELSE 50
                END
              ) DESC,
            candidates.scheduled_at,
            candidates.id
        ) AS class_rank
      FROM candidates
    ) AS ranked
    CROSS JOIN claim_parameters AS parameters
    WHERE ranked.is_interactive
      OR ranked.class_rank <= parameters.background_limit
  ), claimed AS (
    UPDATE public.jobs AS j
    SET
      status = 'running',
      started_at = parameters.claimed_at,
      lease_renewed_at = parameters.claimed_at,
      finished_at = NULL,
      lease_token = pg_catalog.gen_random_uuid()::text
    FROM admitted
    CROSS JOIN claim_parameters AS parameters
    WHERE j.id = admitted.id
      AND j.status = 'pending'
    RETURNING
      j.id,
      j.type,
      j.payload,
      j.workspace_id,
      j.requested_by,
      j.attempts,
      j.lease_token,
      j.resource_class
  )
  SELECT
    claimed.id,
    claimed.type,
    claimed.payload,
    claimed.workspace_id,
    claimed.requested_by,
    claimed.attempts,
    claimed.lease_token,
    claimed.resource_class
  FROM claimed;
END;
$function$;


--> statement-breakpoint

-- Bound queued work before any reflection row exists. A pending conversation
-- keeps one watermarked segment, rather than accumulating overlapping jobs.
CREATE OR REPLACE FUNCTION public.astella_enqueue_companion_reflection()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_thresholds record;
  v_inserted integer := 0;
  v_row record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('astella:reflection-enqueue',0));
  SELECT * INTO v_thresholds FROM public.astella_companion_reflection_thresholds();

  FOR v_row IN
    WITH watermark AS (
      SELECT conversation_id, max(input_to_seq) AS last_seq, max(created_at) AS last_at
        FROM public.companion_reflections
       GROUP BY conversation_id
    ),
    open_count AS (
      SELECT requested_by AS user_id, count(*)::int AS open
        FROM public.jobs
       WHERE type='companion_reflection' AND status IN ('pending','running')
       GROUP BY requested_by
    ),
    segment AS (
      SELECT c.id AS conversation_id,
             c.workspace_id,
             c.user_id,
             COALESCE(w.last_seq, 0) AS from_seq,
             max(m.seq) AS to_seq,
             count(*) FILTER (WHERE m.role = 'user') AS user_count,
             count(*) FILTER (WHERE m.role = 'assistant') AS assistant_count
        FROM public.companion_conversations c
        JOIN public.companion_messages m ON m.conversation_id = c.id
        LEFT JOIN watermark w ON w.conversation_id = c.id
       JOIN public.workspace_members member ON member.workspace_id=c.workspace_id
         AND member.user_id=c.user_id AND member.left_at IS NULL
       JOIN public.user_companion_account_state account ON account.user_id=c.user_id AND account.global_enabled
       WHERE c.status = 'active'
         AND m.seq > COALESCE(w.last_seq, 0)
       GROUP BY c.id, c.workspace_id, c.user_id, w.last_seq
      HAVING count(*) FILTER (WHERE m.role = 'user') >= v_thresholds.min_user_messages
         AND count(*) FILTER (WHERE m.role = 'assistant') >= v_thresholds.min_assistant_messages
    )
    SELECT s.conversation_id, s.workspace_id, s.user_id, s.from_seq, s.to_seq
      FROM segment s
      LEFT JOIN watermark w ON w.conversation_id = s.conversation_id
      LEFT JOIN open_count o ON o.user_id = s.user_id
     WHERE (w.last_at IS NULL OR w.last_at <= now() - make_interval(hours => v_thresholds.min_interval_hours))
       AND COALESCE(o.open, 0) < v_thresholds.max_open_per_account
       -- 段落必须真的结束在一条她已交付的回复之后：末尾是用户还在说话时不回顾。
       AND EXISTS (
         SELECT 1 FROM public.companion_messages last
          WHERE last.conversation_id = s.conversation_id
            AND last.seq = s.to_seq AND last.role = 'assistant'
       )
       -- 同一段不落两次（幂等键含水位，这里是提前退出省一次 INSERT）。
       AND NOT EXISTS (
         SELECT 1 FROM public.jobs j
          WHERE j.workspace_id = s.workspace_id
            AND j.type = 'companion_reflection'
            AND (j.payload->>'conversationId'=s.conversation_id::text AND j.status IN ('pending','running')
              OR j.idempotency_key = 'companion-reflection:' || s.conversation_id::text || ':' || s.to_seq::text)
       )
     ORDER BY w.last_at NULLS FIRST,s.conversation_id
  LOOP
    -- The loop may admit several spaces for an account; re-count jobs after
    -- each insert because rows selected above all saw the same initial count.
    IF (SELECT count(*) FROM public.jobs j WHERE j.requested_by=v_row.user_id
      AND j.type='companion_reflection' AND j.status IN ('pending','running')) >= v_thresholds.max_open_per_account THEN
      CONTINUE;
    END IF;
    INSERT INTO public.jobs
      (type, workspace_id, requested_by, payload, status, priority, resource_class, idempotency_key)
    VALUES (
      'companion_reflection',
      v_row.workspace_id,
      v_row.user_id,
      jsonb_build_object(
        'userId', v_row.user_id::text,
        'workspaceId', v_row.workspace_id::text,
        'conversationId', v_row.conversation_id::text,
        'fromSeq', v_row.from_seq,
        'toSeq', v_row.to_seq
      ),
      'pending', 30, 'maintenance',
      'companion-reflection:' || v_row.conversation_id::text || ':' || v_row.to_seq::text
    )
    ON CONFLICT (workspace_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO NOTHING;
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN v_inserted;
END;
$$;

