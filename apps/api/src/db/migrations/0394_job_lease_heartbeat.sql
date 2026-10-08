-- 0394: Renew active work without changing its true started_at.
-- Lease timeout controls crash recovery independently of model/task deadlines.
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS lease_renewed_at timestamptz;
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
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
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
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.astella_renew_job_lease(
  p_job_id uuid,
  p_workspace_id uuid,
  p_lease_token text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH updated AS (
    UPDATE public.jobs AS j
    SET lease_renewed_at = clock_timestamp()
    WHERE j.id = p_job_id
      AND j.workspace_id = p_workspace_id
      AND j.status = 'running'
      AND j.lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM updated);
$function$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.astella_reap_stale_jobs(
  p_lease_timeout_ms integer,
  p_max_attempts integer
)
RETURNS TABLE (
  id uuid,
  status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  WITH reap_parameters AS (
    SELECT
      greatest(120000, least(coalesce(p_lease_timeout_ms, 120000), 3600000)) AS lease_timeout_ms,
      greatest(1, least(coalesce(p_max_attempts, 3), 10)) AS max_attempts,
      clock_timestamp() AS reaped_at
  ), stale AS MATERIALIZED (
    SELECT
      j.id,
      j.attempts,
      parameters.max_attempts,
      parameters.reaped_at
    FROM public.jobs AS j
    CROSS JOIN reap_parameters AS parameters
    WHERE j.status = 'running'
      AND coalesce(j.lease_renewed_at, j.started_at) < parameters.reaped_at
        - pg_catalog.make_interval(secs => parameters.lease_timeout_ms / 1000.0)
    ORDER BY coalesce(j.lease_renewed_at, j.started_at), j.id
    FOR UPDATE OF j SKIP LOCKED
  ), reaped AS (
    UPDATE public.jobs AS j
    SET
      status = CASE
        WHEN stale.attempts >= stale.max_attempts - 1 THEN 'dead'::public.job_status
        ELSE 'pending'::public.job_status
      END,
      attempts = stale.attempts + 1,
      started_at = NULL,
      lease_renewed_at = NULL,
      lease_token = NULL,
      last_error = CASE
        -- 无真实死因：维持 0105 语义。
        WHEN j.last_error IS NULL OR pg_catalog.btrim(j.last_error) = '' THEN
          CASE
            WHEN stale.attempts >= stale.max_attempts - 1
              THEN 'lease expired — max attempts reached'
            ELSE 'lease expired (worker crash or timeout)'
          END
        -- 有真实死因：保留原文，追加 lease 事实（不覆盖）。
        ELSE
          j.last_error || CASE
            WHEN stale.attempts >= stale.max_attempts - 1
              THEN ' | lease expired — max attempts reached'
            ELSE ' | lease expired (worker crash or timeout)'
          END
      END,
      scheduled_at = CASE
        WHEN stale.attempts >= stale.max_attempts - 1 THEN j.scheduled_at
        ELSE stale.reaped_at
          + pg_catalog.make_interval(secs => least(60, 10 * power(2, stale.attempts)))
      END,
      finished_at = CASE
        WHEN stale.attempts >= stale.max_attempts - 1 THEN stale.reaped_at
        ELSE NULL
      END
    FROM stale
    WHERE j.id = stale.id
      AND j.status = 'running'
    RETURNING j.id, j.status::text
  )
  SELECT reaped.id, reaped.status
  FROM reaped;
$function$;
--> statement-breakpoint

COMMENT ON COLUMN public.jobs.lease_renewed_at IS 'Last lease heartbeat; started_at remains the execution start time.';